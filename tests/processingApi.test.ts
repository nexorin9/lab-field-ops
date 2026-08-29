// tests/processingApi.test.ts
//
// Task 25 · REST 端点：处理记录 confirm/retry 流程的端到端测试。
//
// 覆盖范围：
//   1. POST /api/processing-records/:id/confirm 幂等（parsed → writeback_pending 完整闭环 + 二次幂等）
//   2. POST /api/processing-records/:id/retry happy path（failed → verified + writeback_pending + retry_count+1）
//   3. POST /retry 在非 failed 状态返 409 CONFLICT（含 received/parsed/verified/writeback_pending/written_back 五态）
//   4. POST /retry 入参校验：record 不存在 → 404 / id 缺失 → 400 / operator_id 缺失 → 400
//   5. audit_event 落库：processing_record.retry + state_change（failed→verified + verified→writeback_pending）
//   6. retry_count 自增（多次 retry 各自 +1）
//   7. eventId 模式 `retry:<id>:<retryCount>` 保证多次 retry 互不 dedupe
//   8. 端到端：confirm → 失败 → retry → writeback_pending 全链路
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
  postProcessingRecordConfirmRoute,
  postProcessingRecordRetryRoute,
  postProcessingRecordRoute,
} from '../src/server/routes/processing-records.js';
import { registerAllTasks, __resetTaskRegistration } from '../src/server/queue/register.js';
import {
  LIS_WRITEBACK_QUEUE,
  lisWritebackHandler,
  tempLisWritebackPath,
} from '../src/server/queue/tasks/writeback.js';

interface PresentedProcessingRecordLike {
  record_id: string;
  state: string;
  retry_count: number;
  confirmed_at: string | null;
}

/** 仅查本 recordId 的 processing_record.state_change audit。 */
function queryStateChangeAudit(recordId: string): Array<{
  from_state: string;
  to_state: string;
}> {
  return queryAudit({ kind: 'processing_record.state_change' })
    .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
    .filter((p) => p.record_id === recordId)
    .map((p) => ({
      from_state: String(p.from_state),
      to_state: String(p.to_state),
    }));
}

/** 仅查本 recordId 的 processing_record.retry audit。 */
function queryRetryAudit(recordId: string): Array<{
  attempts: number;
  operator_id: string | null;
}> {
  return queryAudit({ kind: 'processing_record.retry' })
    .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
    .filter((p) => p.record_id === recordId)
    .map((p) => ({
      attempts: Number(p.attempts ?? 0),
      operator_id: null, // operator 不在 payload；直接从 row.operator_id 读
    }));
}

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'lab-processing-api-')),
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
// 注意：audit_event 是 append-only（trigger 阻止 DELETE），用 record_id 过滤 + 唯一 record_id 跨 case 区分。
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
  retryCount: number = 0,
  confirmedAt: string | null = null,
): void {
  getDb().prepare(
    `INSERT INTO processing_record
       (record_id, instrument_id, alarm_code, operator_id, root_cause,
        steps_json, confirmed_at, state, retry_count, payload_json, accession_no)
     VALUES (?, 'ASSET-LAB-0001', 'W002', 'op-seed', 'seeded root cause',
        '[]', ?, ?, ?, '{}', NULL)`,
  ).run(recordId, confirmedAt, state, retryCount);
}

/** 创建一条 received 记录 + 推进到指定 state。 */
function seedRecordInState(state: string, opts: { retryCount?: number; confirmedAt?: string | null } = {}): string {
  const createRes = postProcessingRecordRoute(
    {},
    {},
    {
      instrument_id: 'ASSET-LAB-0001',
      alarm_code: 'W002',
      operator_id: 'op-seed',
    },
  );
  if (createRes.status !== 201) throw new Error('seed create failed');
  const recordId = (createRes.body as PresentedProcessingRecordLike).record_id;
  // 直接 UPDATE 推到目标 state（避免端点耦合其它测试）
  const confirmedAt = opts.confirmedAt ?? null;
  const retryCount = opts.retryCount ?? 0;
  getDb()
    .prepare('UPDATE processing_record SET state = ?, retry_count = ?, confirmed_at = ? WHERE record_id = ?')
    .run(state, retryCount, confirmedAt, recordId);
  return recordId;
}

// ────────────────────────────────────────────────────────────────────────
// 1) POST /confirm 幂等
// ────────────────────────────────────────────────────────────────────────

describe('POST /api/processing-records/:id/confirm · 幂等与闭环', () => {
  it('parsed → verified → enqueue → writeback_pending 完整闭环', () => {
    const recordId = seedRecordInState('parsed');
    registerAllTasks();
    const res = postProcessingRecordConfirmRoute(
      { id: recordId },
      {},
      { operator_id: 'op-confirm-1' },
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
    expect(body.record.state).toBe('writeback_pending');
    expect(body.record.confirmed_at).toBeTruthy();
    // state_change audit 应有 failed→verified（不会）+ parsed→verified + verified→writeback_pending
    const audits = queryStateChangeAudit(recordId);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const transitions = audits.map((a) => `${a.from_state}->${a.to_state}`);
    expect(transitions).toContain('parsed->verified');
    expect(transitions).toContain('verified->writeback_pending');
  });

  it('二次 confirm 幂等：idempotent=true，不重复入队', () => {
    const recordId = seedRecordInState('parsed');
    registerAllTasks();

    const r1 = postProcessingRecordConfirmRoute(
      { id: recordId },
      {},
      { operator_id: 'op-confirm-A' },
    );
    expect(r1.status).toBe(200);
    const b1 = r1.body as { idempotent: boolean; enqueued: { skipped: boolean } | null };
    expect(b1.idempotent).toBe(false);
    expect(b1.enqueued!.skipped).toBe(false);

    // 第二次 confirm：writeback_pending 命中幂等表 → 不重复入队
    const r2 = postProcessingRecordConfirmRoute(
      { id: recordId },
      {},
      { operator_id: 'op-confirm-B' },
    );
    expect(r2.status).toBe(200);
    const b2 = r2.body as { idempotent: boolean; enqueued: unknown };
    expect(b2.idempotent).toBe(true);
    expect(b2.enqueued).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2) POST /retry happy path
// ────────────────────────────────────────────────────────────────────────

describe('POST /api/processing-records/:id/retry · failed → verified + 重投', () => {
  it('failed → verified → writeback_pending + retry_count+1', () => {
    const recordId = seedRecordInState('failed', { retryCount: 0 });
    const { writebackQueue } = registerAllTasks();

    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: 'op-retry-1' },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      record: PresentedProcessingRecordLike;
      retryCount: number;
      enqueued: { id: string; skipped: boolean } | null;
    };
    expect(body.retryCount).toBe(1);
    expect(body.record.state).toBe('writeback_pending');
    expect(body.record.retry_count).toBe(1);
    expect(body.enqueued).not.toBeNull();
    expect(body.enqueued!.skipped).toBe(false);

    // state_change audit 链：failed→verified + verified→writeback_pending
    const audits = queryStateChangeAudit(recordId);
    const transitions = audits.map((a) => `${a.from_state}->${a.to_state}`);
    expect(transitions).toContain('failed->verified');
    expect(transitions).toContain('verified->writeback_pending');

    // processing_record.retry audit 落库（attempts=1）
    const retryAudits = queryRetryAudit(recordId);
    expect(retryAudits.length).toBe(1);
    expect(retryAudits[0].attempts).toBe(1);

    // writeback queue 应有 pending/running job（eventId=retry:<id>:1）
    const jobs = writebackQueue.list();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.some((j) => j.event_id === `retry:${recordId}:1`)).toBe(true);
  });

  it('多次 retry：retry_count 持续自增，每次入队 eventId 不同', () => {
    // 直接灌一条 retry_count=2 的 failed 记录（绕过前两次 retry 路径）
    insertProcessingRecord('r-multi', 'failed', 2);

    const { writebackQueue } = registerAllTasks();

    // 第 3 次 retry
    const r1 = postProcessingRecordRetryRoute(
      { id: 'r-multi' },
      {},
      { operator_id: 'op-retry-A' },
    );
    expect(r1.status).toBe(200);
    const b1 = r1.body as { retryCount: number };
    expect(b1.retryCount).toBe(3);

    // 把 state 改回 failed（queue handler 已 success 之后）
    getDb().prepare("UPDATE processing_record SET state = 'failed' WHERE record_id = ?").run('r-multi');

    // 第 4 次 retry
    const r2 = postProcessingRecordRetryRoute(
      { id: 'r-multi' },
      {},
      { operator_id: 'op-retry-B' },
    );
    expect(r2.status).toBe(200);
    const b2 = r2.body as { retryCount: number };
    expect(b2.retryCount).toBe(4);

    // queue 中 eventId 应有 retry:r-multi:3 和 retry:r-multi:4 两条
    const eventIds = writebackQueue.list().map((j) => j.event_id);
    expect(eventIds).toContain('retry:r-multi:3');
    expect(eventIds).toContain('retry:r-multi:4');

    // retry audit 落库 2 条
    const retryAudits = queryRetryAudit('r-multi');
    expect(retryAudits.length).toBe(2);
  });

  it('audit_event：processing_record.retry 与 state_change 都写', () => {
    const recordId = seedRecordInState('failed');
    registerAllTasks();

    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: 'op-retry-audit' },
    );
    expect(res.status).toBe(200);

    // state_change: failed→verified + verified→writeback_pending 共 2 条
    const stateChangeAudits = queryAudit({ kind: 'processing_record.state_change' })
      .filter((row) => JSON.parse(row.payload_json).record_id === recordId);
    expect(stateChangeAudits.length).toBe(2);

    // processing_record.retry: 1 条
    const retryAudits = queryAudit({ kind: 'processing_record.retry' })
      .filter((row) => JSON.parse(row.payload_json).record_id === recordId);
    expect(retryAudits.length).toBe(1);
    const retryPayload = JSON.parse(retryAudits[0].payload_json) as Record<string, unknown>;
    expect(retryPayload.attempts).toBe(1);
    expect(retryPayload.record_id).toBe(recordId);
    expect(retryAudits[0].operator_id).toBe('op-retry-audit');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3) POST /retry 非 failed 状态 → 409 CONFLICT
// ────────────────────────────────────────────────────────────────────────

describe('POST /retry · 非 failed 状态拒绝', () => {
  it('received → 409 CONFLICT（含 current_state details）', () => {
    const recordId = seedRecordInState('received');
    registerAllTasks();
    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: 'op-rcv' },
    );
    expect(res.status).toBe(409);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details?.current_state).toBe('received');
  });

  it('parsed → 409 CONFLICT', () => {
    const recordId = seedRecordInState('parsed');
    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: 'op-prs' },
    );
    expect(res.status).toBe(409);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details?.current_state).toBe('parsed');
  });

  it('verified → 409 CONFLICT', () => {
    const recordId = seedRecordInState('verified');
    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: 'op-vfy' },
    );
    expect(res.status).toBe(409);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details?.current_state).toBe('verified');
  });

  it('writeback_pending → 409 CONFLICT', () => {
    const recordId = seedRecordInState('writeback_pending');
    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: 'op-pen' },
    );
    expect(res.status).toBe(409);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details?.current_state).toBe('writeback_pending');
  });

  it('written_back → 409 CONFLICT（终态不可重投）', () => {
    const recordId = seedRecordInState('written_back', { confirmedAt: '2026-01-01T00:00:00Z' });
    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: 'op-wb' },
    );
    expect(res.status).toBe(409);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details?.current_state).toBe('written_back');
  });

  it('409 响应里 details.retry_count 字段保留（前端可显示）', () => {
    const recordId = seedRecordInState('received', { retryCount: 5 });
    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: 'op-rd' },
    );
    expect(res.status).toBe(409);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.details?.retry_count).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4) POST /retry 入参校验
// ────────────────────────────────────────────────────────────────────────

describe('POST /retry · 入参校验', () => {
  it('record 不存在 → 404 NOT_FOUND', () => {
    const res = postProcessingRecordRetryRoute(
      { id: 'no-such-record' },
      {},
      { operator_id: 'op-X' },
    );
    expect(res.status).toBe(404);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('id 缺失 → 400 VALIDATION_ERROR', () => {
    const res = postProcessingRecordRetryRoute(
      {},
      {},
      { operator_id: 'op' },
    );
    expect(res.status).toBe(400);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('operator_id 缺失 → 400 VALIDATION_ERROR', () => {
    const recordId = seedRecordInState('failed');
    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      {},
    );
    expect(res.status).toBe(400);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('operator_id 空字符串 → 400 VALIDATION_ERROR', () => {
    const recordId = seedRecordInState('failed');
    const res = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: '' },
    );
    expect(res.status).toBe(400);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 5) 端到端：confirm → 失败 → retry → 重投入队
// ────────────────────────────────────────────────────────────────────────

describe('端到端：confirm → fail → retry 完整链路', () => {
  it('confirm 入队 → handler 失败（chmod 0500）→ retry 重新入队', async () => {
    const recordId = seedRecordInState('parsed');
    const { writebackQueue } = registerAllTasks();

    // 第一次 confirm：parsed → writeback_pending + 入队
    const r1 = postProcessingRecordConfirmRoute(
      { id: recordId },
      {},
      { operator_id: 'op-e2e-1' },
    );
    expect(r1.status).toBe(200);
    expect((r1.body as { record: PresentedProcessingRecordLike }).record.state).toBe('writeback_pending');

    // 模拟 handler 失败：把 JSONL 路径改成只读（chmod 0500），覆盖 handler
    const { pushToLisWritebackChannel } = await import('../src/server/queue/tasks/writeback.js');
    // 把 path 改为不存在的只读位置以触发 handler 失败（不阻塞测试）
    writebackQueue.process(async () => {
      throw new Error('simulated handler failure');
    });

    // 让 queue 跑几次直到失败归位（5 次 attempts）
    for (let i = 0; i < 6; i++) {
      await writebackQueue.__test_runOnce().catch(() => undefined);
    }

    // 把 state 改成 failed（模拟 5 次 attempts 耗尽后的状态机收尾）
    getDb().prepare("UPDATE processing_record SET state = 'failed' WHERE record_id = ?").run(recordId);

    // retry 重投
    const r2 = postProcessingRecordRetryRoute(
      { id: recordId },
      {},
      { operator_id: 'op-e2e-2' },
    );
    expect(r2.status).toBe(200);
    const body2 = r2.body as {
      record: PresentedProcessingRecordLike;
      retryCount: number;
      enqueued: { id: string; skipped: boolean } | null;
    };
    expect(body2.record.state).toBe('writeback_pending');
    expect(body2.retryCount).toBe(1);
    expect(body2.enqueued!.skipped).toBe(false);

    // 队列里应至少有两条 retry:<id>:* jobs（或 confirm:<id> + retry:<id>:* 两种）
    const eventIds = writebackQueue.list().map((j) => j.event_id);
    expect(eventIds.some((eid) => eid.startsWith(`retry:${recordId}:`))).toBe(true);

    // audit 链：confirm 一次 state_change（parsed→verified, verified→writeback_pending）+ retry 一次 state_change（failed→verified, verified→writeback_pending）+ 1 条 retry audit
    const allStateChange = queryStateChangeAudit(recordId);
    expect(allStateChange.length).toBeGreaterThanOrEqual(4);

    const retryAudits = queryRetryAudit(recordId);
    expect(retryAudits.length).toBe(1);
    expect(retryAudits[0].attempts).toBe(1);
  });
});