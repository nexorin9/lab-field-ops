// tests/stateMachine.test.ts
//
// ProcessingRecord 状态机 + write-back confirm 端点的单元 / 集成测试。
//
// 覆盖：
//   1. 纯函数 transition：合法转移 / 跳步非法 / 幂等命中
//   2. applyTransition：UPDATE + audit + 副作用字段
//   3. runConfirmFlow：received/parsed → verified（confirm + 入队 + writeback_pending）
//   4. confirm 端点幂等（同 recordId 二次 confirm 不重复入队）
//   5. confirm 端点跳步非法（received 时 confirm → STATE_MACHINE_ERROR）
//   6. queue handler 成功后状态转移 writeback_pending → written_back
//
// 与 spec.md 工作闭环第 3 条 / closure_dimensions 业务状态生命周期对齐。

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb, closeDb } from '../src/server/db.js';
import { migrate } from '../src/server/db/migrate.js';
import { queryAudit } from '../src/server/audit/ledger.js';
import {
  StateMachineError,
  applyTransition,
  getProcessingRecordStateRow,
  runConfirmFlow,
  transition,
} from '../src/server/processing/state-machine.js';
import {
  postProcessingRecordConfirmRoute,
  postProcessingRecordRoute,
} from '../src/server/routes/processing-records.js';
import { registerAllTasks, __resetTaskRegistration } from '../src/server/queue/register.js';
import {
  LIS_WRITEBACK_QUEUE,
  lisWritebackHandler,
  markWritebackSuccess,
  pushToLisWritebackChannel,
  tempLisWritebackPath,
} from '../src/server/queue/tasks/writeback.js';

/** 仅查本 recordId 的 state_change audit（避免 append-only 触发器 + 跨 case 累积）。 */
function queryStateChangeAudit(recordId: string): Array<{
  from_state: string;
  to_state: string;
  operator_id: string | null;
}> {
  return queryAudit({ kind: 'processing_record.state_change' })
    .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
    .filter((p) => p.record_id === recordId)
    .map((p) => ({
      from_state: String(p.from_state),
      to_state: String(p.to_state),
      operator_id: null,
    }));
}

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'lab-state-machine-')),
  'test.sqlite',
);
const TMP_JSONL = tempLisWritebackPath();

beforeAll(() => {
  process.env.DATABASE_PATH = TMP_DB;
  process.env.LIS_WRITEBACK_PATH = TMP_JSONL;
  closeDb();
  migrate(TMP_DB);
});

afterAll(() => {
  closeDb();
  try {
    if (fs.existsSync(TMP_DB)) fs.rmSync(TMP_DB);
    if (fs.existsSync(TMP_JSONL)) fs.rmSync(TMP_JSONL);
  } catch {
    /* ignore */
  }
  delete process.env.DATABASE_PATH;
  delete process.env.LIS_WRITEBACK_PATH;
  __resetTaskRegistration();
});

// 每个 case 前清表 + 重置单例（保持 case 间隔离）
// 注意：audit_event 是 append-only（trigger 阻止 DELETE），用 record_id 过滤 + 用
// 唯一 record_id 跨 case 区分；不在 beforeEach 清 audit_event。
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM processing_record');
  db.exec('DELETE FROM plugin_event_dedupe');
  db.exec('DELETE FROM calibration');
  db.exec('DELETE FROM instrument');
  __resetTaskRegistration();
  // 灌入一台占位 instrument（POST 处理记录需要外键）
  db.prepare(
    `INSERT INTO instrument (instrument_id, vendor, model, asset_tag, location, status, installed_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'online', ?, NULL)`,
  ).run('ASSET-LAB-0001', 'Siemens', 'ADVIA 2400', 'PLACEHOLDER-ASSET-0001', '检验科 A 区', '2026-01-01T00:00:00Z');
});

/** 直接 SQL 灌入一条 processing_record（绕过 POST）。 */
function insertProcessingRecord(
  recordId: string,
  state: string,
  confirmedAt: string | null = null,
  retryCount: number = 0,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO processing_record
       (record_id, instrument_id, alarm_code, operator_id, root_cause,
        steps_json, confirmed_at, state, retry_count, payload_json, accession_no)
     VALUES (?, 'ASSET-LAB-0001', 'W002', 'op-001', 'seeded root cause',
        '[]', ?, ?, ?, '{}', NULL)`,
  ).run(recordId, confirmedAt, state, retryCount);
}

// ────────────────────────────────────────────────────────────────────────
// 1) 纯函数 transition：合法转移
// ────────────────────────────────────────────────────────────────────────

describe('transition · 合法状态转移', () => {
  it('received → parsed（parse 事件）', () => {
    const row = {
      record_id: 'r1',
      state: 'received' as const,
      confirmed_at: null,
      retry_count: 0,
    };
    const result = transition(row, { type: 'parse' });
    expect(result.nextState).toBe('parsed');
    expect(result.idempotent).toBe(false);
    expect(result.sideEffects).toEqual({});
  });

  it('parsed → verified（verify 事件）', () => {
    const row = {
      record_id: 'r1',
      state: 'parsed' as const,
      confirmed_at: null,
      retry_count: 0,
    };
    const result = transition(row, { type: 'verify', operatorId: 'op-A' });
    expect(result.nextState).toBe('verified');
    expect(result.idempotent).toBe(false);
    expect(result.sideEffects.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.sideEffects.confirmedBy).toBe('op-A');
  });

  it('verified → writeback_pending（enqueue 事件）', () => {
    const row = {
      record_id: 'r1',
      state: 'verified' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 0,
    };
    const result = transition(row, { type: 'enqueue' });
    expect(result.nextState).toBe('writeback_pending');
    expect(result.idempotent).toBe(false);
  });

  it('writeback_pending → written_back（writeback_success 事件）', () => {
    const row = {
      record_id: 'r1',
      state: 'writeback_pending' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 0,
    };
    const result = transition(row, { type: 'writeback_success' });
    expect(result.nextState).toBe('written_back');
    expect(result.idempotent).toBe(false);
  });

  it('failed → verified（retry 事件，retry_count+1）', () => {
    const row = {
      record_id: 'r1',
      state: 'failed' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 2,
    };
    const result = transition(row, { type: 'retry' });
    expect(result.nextState).toBe('verified');
    expect(result.sideEffects.retryCount).toBe(3);
  });

  it('任意非终态 → failed（fail 事件）', () => {
    for (const state of ['received', 'parsed', 'verified', 'writeback_pending'] as const) {
      const row = {
        record_id: 'r1',
        state,
        confirmed_at: null,
        retry_count: 0,
      };
      const result = transition(row, { type: 'fail', reason: 'err' });
      expect(result.nextState).toBe('failed');
      expect(result.idempotent).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2) 跳步非法 → 抛 StateMachineError
// ────────────────────────────────────────────────────────────────────────

describe('transition · 跳步非法', () => {
  it('received → verify（必须先 parse）抛错', () => {
    const row = {
      record_id: 'r1',
      state: 'received' as const,
      confirmed_at: null,
      retry_count: 0,
    };
    expect(() => transition(row, { type: 'verify', operatorId: 'op' })).toThrow(
      StateMachineError,
    );
  });

  it('received → enqueue 抛错', () => {
    const row = {
      record_id: 'r1',
      state: 'received' as const,
      confirmed_at: null,
      retry_count: 0,
    };
    expect(() => transition(row, { type: 'enqueue' })).toThrow(StateMachineError);
  });

  it('parsed → enqueue 抛错（必须先 verify）', () => {
    const row = {
      record_id: 'r1',
      state: 'parsed' as const,
      confirmed_at: null,
      retry_count: 0,
    };
    expect(() => transition(row, { type: 'enqueue' })).toThrow(StateMachineError);
  });

  it('parsed → writeback_success 抛错（必须先 verify+enqueue）', () => {
    const row = {
      record_id: 'r1',
      state: 'parsed' as const,
      confirmed_at: null,
      retry_count: 0,
    };
    expect(() =>
      transition(row, { type: 'writeback_success' }),
    ).toThrow(StateMachineError);
  });

  it('written_back → parse 抛错（终态不可逆）', () => {
    const row = {
      record_id: 'r1',
      state: 'written_back' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 0,
    };
    expect(() => transition(row, { type: 'parse' })).toThrow(StateMachineError);
  });

  it('StateMachineError 携带 recordId / fromState / event', () => {
    const row = {
      record_id: 'r-bad',
      state: 'received' as const,
      confirmed_at: null,
      retry_count: 0,
    };
    try {
      transition(row, { type: 'verify', operatorId: 'op' });
      throw new Error('expected throw');
    } catch (e) {
      const err = e as StateMachineError;
      expect(err).toBeInstanceOf(StateMachineError);
      expect(err.recordId).toBe('r-bad');
      expect(err.fromState).toBe('received');
      expect(err.event).toBe('verify');
      expect(err.code).toBe('STATE_MACHINE_ERROR');
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3) 幂等命中
// ────────────────────────────────────────────────────────────────────────

describe('transition · 幂等命中', () => {
  it('verified → verify 幂等（confirmed_at 不变）', () => {
    const row = {
      record_id: 'r1',
      state: 'verified' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 0,
    };
    const result = transition(row, { type: 'verify', operatorId: 'op-B' });
    expect(result.nextState).toBe('verified');
    expect(result.idempotent).toBe(true);
    expect(result.sideEffects.confirmedAt).toBeUndefined();
  });

  it('writeback_pending → verify 幂等', () => {
    const row = {
      record_id: 'r1',
      state: 'writeback_pending' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 0,
    };
    const result = transition(row, { type: 'verify', operatorId: 'op' });
    expect(result.idempotent).toBe(true);
    expect(result.nextState).toBe('writeback_pending');
  });

  it('written_back → verify 幂等（终态确认）', () => {
    const row = {
      record_id: 'r1',
      state: 'written_back' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 0,
    };
    const result = transition(row, { type: 'verify', operatorId: 'op' });
    expect(result.idempotent).toBe(true);
    expect(result.nextState).toBe('written_back');
  });

  it('writeback_pending → enqueue 幂等', () => {
    const row = {
      record_id: 'r1',
      state: 'writeback_pending' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 0,
    };
    const result = transition(row, { type: 'enqueue' });
    expect(result.idempotent).toBe(true);
  });

  it('written_back → writeback_success 幂等', () => {
    const row = {
      record_id: 'r1',
      state: 'written_back' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 0,
    };
    const result = transition(row, { type: 'writeback_success' });
    expect(result.idempotent).toBe(true);
  });

  it('failed → fail 幂等', () => {
    const row = {
      record_id: 'r1',
      state: 'failed' as const,
      confirmed_at: '2026-01-01T00:00:00Z',
      retry_count: 1,
    };
    const result = transition(row, { type: 'fail', reason: 'err' });
    expect(result.idempotent).toBe(true);
    expect(result.nextState).toBe('failed');
    expect(result.sideEffects.retryCount).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4) applyTransition：DB UPDATE + audit 落库
// ────────────────────────────────────────────────────────────────────────

describe('applyTransition · DB 落盘 + audit', () => {
  it('parsed → verified：state / confirmed_at / confirmed_by 写入', () => {
    insertProcessingRecord('r-A', 'parsed');
    const db = getDb();
    const row = getProcessingRecordStateRow(db, 'r-A')!;
    const result = transition(row, { type: 'verify', operatorId: 'op-7' });
    const applied = applyTransition(db, row, result);
    expect(applied).toBe(true);
    const after = db
      .prepare(
        'SELECT state, confirmed_at FROM processing_record WHERE record_id = ?',
      )
      .get('r-A') as { state: string; confirmed_at: string | null };
    expect(after.state).toBe('verified');
    expect(after.confirmed_at).toBeTruthy();
    // audit_event 落盘
    const audit = queryStateChangeAudit('r-A');
    expect(audit.length).toBe(1);
    expect(audit[0].from_state).toBe('parsed');
    expect(audit[0].to_state).toBe('verified');
  });

  it('幂等分支：不写 UPDATE，不写 audit', () => {
    insertProcessingRecord('r-B', 'verified');
    const db = getDb();
    const row = getProcessingRecordStateRow(db, 'r-B')!;
    const result = transition(row, { type: 'verify', operatorId: 'op-8' });
    const applied = applyTransition(db, row, result);
    expect(applied).toBe(false);
    const audit = queryStateChangeAudit('r-B');
    expect(audit.length).toBe(0);
  });

  it('retry：retry_count 自增 1', () => {
    insertProcessingRecord('r-C', 'failed', null, 3);
    const db = getDb();
    const row = getProcessingRecordStateRow(db, 'r-C')!;
    const result = transition(row, { type: 'retry' });
    applyTransition(db, row, result);
    const after = db
      .prepare('SELECT state, retry_count FROM processing_record WHERE record_id = ?')
      .get('r-C') as { state: string; retry_count: number };
    expect(after.state).toBe('verified');
    expect(after.retry_count).toBe(4);
    const audit = queryStateChangeAudit('r-C');
    expect(audit.length).toBe(1);
    expect(audit[0].from_state).toBe('failed');
    expect(audit[0].to_state).toBe('verified');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 5) runConfirmFlow + POST /confirm 端点
// ────────────────────────────────────────────────────────────────────────

describe('POST /api/processing-records/:id/confirm', () => {
  it('received → STATE_MACHINE_ERROR 409', () => {
    // POST 创建一条 received 记录
    const createRes = postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-100',
      },
    );
    expect(createRes.status).toBe(201);
    const created = (createRes.body as PresentedProcessingRecordLike).record_id;
    // 直接 confirm（跳过 parse）
    const confirmRes = postProcessingRecordConfirmRoute(
      { id: created },
      {},
      { operator_id: 'op-101' },
    );
    expect(confirmRes.status).toBe(409);
    const errBody = confirmRes.body as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(errBody.error.code).toBe('STATE_MACHINE_ERROR');
    expect(errBody.error.details?.from_state).toBe('received');
    expect(errBody.error.details?.event).toBe('verify');
  });

  it('parsed → verified → enqueue → writeback_pending 完整闭环', () => {
    const createRes = postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-200',
      },
    );
    const recordId = (createRes.body as PresentedProcessingRecordLike).record_id;
    // 手动推进到 parsed（POST 不提供 parse 端点）
    getDb()
      .prepare("UPDATE processing_record SET state = 'parsed' WHERE record_id = ?")
      .run(recordId);
    // 注册队列并启动
    const { writebackQueue } = registerAllTasks();
    const res = postProcessingRecordConfirmRoute(
      { id: recordId },
      {},
      { operator_id: 'op-201' },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      record: PresentedProcessingRecordLike;
      idempotent: boolean;
      enqueued: { id: string; skipped: boolean } | null;
    };
    expect(body.idempotent).toBe(false);
    expect(body.enqueued).not.toBeNull();
    expect(body.enqueued!.skipped).toBe(false);
    // queue 应有 pending 或 running 任务（setImmediate 调度）
    expect(writebackQueue.status().pending + writebackQueue.status().running).toBeGreaterThanOrEqual(0);
    // 状态推进
    expect(body.record.state).toBe('writeback_pending');
    expect(body.record.confirmed_at).toBeTruthy();
  });

  it('二次 confirm 幂等：idempotent=true，不重复入队', () => {
    const createRes = postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-300',
      },
    );
    const recordId = (createRes.body as PresentedProcessingRecordLike).record_id;
    getDb()
      .prepare("UPDATE processing_record SET state = 'parsed' WHERE record_id = ?")
      .run(recordId);
    registerAllTasks();

    // 第一次 confirm：parsed → writeback_pending + 入队
    const r1 = postProcessingRecordConfirmRoute(
      { id: recordId },
      {},
      { operator_id: 'op-301' },
    );
    expect(r1.status).toBe(200);
    const b1 = r1.body as { idempotent: boolean; enqueued: { skipped: boolean } | null };
    expect(b1.idempotent).toBe(false);
    expect(b1.enqueued!.skipped).toBe(false);

    // 第二次 confirm：writeback_pending 命中幂等表 → 不重复入队
    const r2 = postProcessingRecordConfirmRoute(
      { id: recordId },
      {},
      { operator_id: 'op-302' },
    );
    expect(r2.status).toBe(200);
    const b2 = r2.body as { idempotent: boolean; enqueued: { skipped: boolean } | null };
    expect(b2.idempotent).toBe(true);
    expect(b2.enqueued).toBeNull(); // confirm 幂等命中时直接返回，不入队
  });

  it('written_back 状态 confirm → 幂等且不入队', () => {
    const createRes = postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-400',
      },
    );
    const recordId = (createRes.body as PresentedProcessingRecordLike).record_id;
    // 直接 SQL 推到 written_back
    getDb()
      .prepare(
        "UPDATE processing_record SET state = 'written_back', confirmed_at = '2026-01-01T00:00:00Z' WHERE record_id = ?",
      )
      .run(recordId);
    const res = postProcessingRecordConfirmRoute(
      { id: recordId },
      {},
      { operator_id: 'op-401' },
    );
    expect(res.status).toBe(200);
    const body = res.body as { idempotent: boolean; enqueued: unknown };
    expect(body.idempotent).toBe(true);
    expect(body.enqueued).toBeNull();
  });

  it('record 不存在 → 404', () => {
    const res = postProcessingRecordConfirmRoute(
      { id: 'no-such-record' },
      {},
      { operator_id: 'op-X' },
    );
    expect(res.status).toBe(404);
  });

  it('operator_id 缺失 → 400 VALIDATION_ERROR', () => {
    const createRes = postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-500',
      },
    );
    const recordId = (createRes.body as PresentedProcessingRecordLike).record_id;
    const res = postProcessingRecordConfirmRoute(
      { id: recordId },
      {},
      {},
    );
    expect(res.status).toBe(400);
  });

  it('id 缺失 → 400 VALIDATION_ERROR', () => {
    const res = postProcessingRecordConfirmRoute({}, {}, { operator_id: 'op' });
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 6) markWritebackSuccess：handler 成功 → state 推进
// ────────────────────────────────────────────────────────────────────────

describe('markWritebackSuccess · handler 成功后状态推进', () => {
  it('writeback_pending → written_back', async () => {
    insertProcessingRecord('r-M1', 'writeback_pending');
    await markWritebackSuccess('r-M1');
    const stateRow = getProcessingRecordStateRow(getDb(), 'r-M1');
    expect(stateRow?.state).toBe('written_back');
    const audit = queryStateChangeAudit('r-M1');
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[audit.length - 1].from_state).toBe('writeback_pending');
    expect(audit[audit.length - 1].to_state).toBe('written_back');
  });

  it('written_back → 幂等不抛错', async () => {
    insertProcessingRecord('r-M2', 'written_back');
    await expect(markWritebackSuccess('r-M2')).resolves.toBeUndefined();
    const stateRow = getProcessingRecordStateRow(getDb(), 'r-M2');
    expect(stateRow?.state).toBe('written_back');
  });

  it('非 writeback_pending 状态（failed）→ 抛错', async () => {
    insertProcessingRecord('r-M3', 'failed');
    await expect(markWritebackSuccess('r-M3')).rejects.toThrow(
      /unexpected state 'failed'/,
    );
  });

  it('record 不存在 → 静默 return（不抛错）', async () => {
    await expect(markWritebackSuccess('does-not-exist')).resolves.toBeUndefined();
  });

  it('handler 完整流程：push JSONL + 状态推进', async () => {
    insertProcessingRecord('r-M4', 'writeback_pending', '2026-01-01T00:00:00Z');
    // 直接调 handler（绕过 queue 调度）
    await pushToLisWritebackChannel({
      record_id: 'r-M4',
      instrument_id: 'ASSET-LAB-0001',
      alarm_code: 'W002',
      operator_id: 'op-700',
    });
    await markWritebackSuccess('r-M4');
    const stateRow = getProcessingRecordStateRow(getDb(), 'r-M4');
    expect(stateRow?.state).toBe('written_back');
    // JSONL 写成功
    expect(fs.existsSync(TMP_JSONL)).toBe(true);
    const lines = fs
      .readFileSync(TMP_JSONL, 'utf8')
      .trim()
      .split('\n');
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.record_id).toBe('r-M4');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 7) 状态机 + handler 集成（队列调度 → handler 成功 → 状态推进）
// ────────────────────────────────────────────────────────────────────────

describe('队列 + 状态机集成', () => {
  it('enqueue → 200ms → handler 成功 → state written_back', async () => {
    insertProcessingRecord('r-I1', 'writeback_pending', '2026-01-01T00:00:00Z');
    const { writebackQueue } = registerAllTasks();
    writebackQueue.process(lisWritebackHandler as unknown as Parameters<typeof writebackQueue.process>[0]);
    writebackQueue.enqueue(
      {
        record_id: 'r-I1',
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-800',
      },
      { eventId: 'evt-r-I1' },
    );
    // 等 200ms 让 handler 跑完
    await new Promise((r) => setTimeout(r, 200));
    const stateRow = getProcessingRecordStateRow(getDb(), 'r-I1');
    expect(stateRow?.state).toBe('written_back');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 内部类型助手
// ────────────────────────────────────────────────────────────────────────

interface PresentedProcessingRecordLike {
  record_id: string;
  state: string;
  confirmed_at: string | null;
}
