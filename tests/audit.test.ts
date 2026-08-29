// tests/audit.test.ts
//
// 审计 ledger 单元测试：
//   - canonicalize / sha256Hex 稳定
//   - appendAudit 写入 + 计算 hash + relatedEventId
//   - queryAudit 多维过滤（kind / operatorId / from / to / limit / 排序）
//   - toAuditEvent 解析 + 损坏 JSON fail-soft
//   - countAudit 计数
//   - append-only 触发器（UPDATE / DELETE 抛错）
//   - auditSource.* facade 字段命名稳定

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  appendAudit,
  queryAudit,
  toAuditEvent,
  countAudit,
  canonicalize,
  sha256Hex,
  rawUpdateAudit,
  rawDeleteAudit,
} from '../src/server/audit/ledger.js';
import { auditSource } from '../src/server/audit/sources.js';
import { getDb, closeDb } from '../src/server/db.js';
import { migrate } from '../src/server/db/migrate.js';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-audit-'));
const TMP_DB = path.join(TMP_DIR, 'test.sqlite');

beforeAll(() => {
  // 用 process.env 锁定默认连接；清空 env 后再用 closeDb + migrate 重建单例
  process.env.DATABASE_PATH = TMP_DB;
  closeDb();
  migrate(TMP_DB);
});

beforeEach(() => {
  // 每个 case 用独立 kind 名字，避免历史行干扰断言；
  // append-only 触发器阻止 DELETE，故不尝试跨 case 清空。
});

afterAll(() => {
  closeDb();
  delete process.env.DATABASE_PATH;
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// === 通用工具：唯一化 kind（避免历史数据干扰断言） ===
let counter = 0;
const uniqueKind = (base: string): string => {
  counter += 1;
  // AuditEventKind 是联合类型，但 appendAudit 接受任意 string 字段入 DB；
  // queryAudit 内部用 `kind = ?` 比较时会按字符串匹配——本测试用动态前缀即可
  return `test.${base}.${Date.now()}.${counter}`;
};

/** 把 unique string 转成 AuditEventKind（仅供 appendAudit/queryAudit/countAudit 入参；运行时存到 DB 仍是字符串） */
const asKind = (s: string) => s as unknown as 'plugin.add';

describe('ledger · canonicalize + sha256Hex', () => {
  it('canonicalize 字符串化基础类型', () => {
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
  });

  it('canonicalize 对象 key 排序保证 hash 稳定', () => {
    const a = canonicalize({ b: 2, a: 1 });
    const b = canonicalize({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  it('canonicalize 嵌套对象 / 数组', () => {
    expect(canonicalize({ x: [3, 1, 2], y: { q: 'q' } })).toBe(
      '{"x":[3,1,2],"y":{"q":"q"}}',
    );
  });

  it('sha256Hex 确定性输出', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex('hello')).not.toBe(sha256Hex('world'));
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('ledger · appendAudit', () => {
  it('写入一条 audit_event 行，附带 eventId + ts', () => {
    const kind = uniqueKind('append-basic');
    const before = countAudit({ kind: asKind(kind) });
    const r = appendAudit({
      kind: asKind(kind),
      operatorId: 'op-1',
      payload: { name: 'lis-writeback', version: '1.0.0' },
    });
    expect(r.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(countAudit({ kind: asKind(kind) })).toBe(before + 1);

    const row = queryAudit({ kind: asKind(kind) })[0];
    expect(row.kind).toBe(kind);
    expect(row.operator_id).toBe('op-1');
    expect(JSON.parse(row.payload_json)).toMatchObject({
      name: 'lis-writeback',
      version: '1.0.0',
    });
  });

  it('计算 req_hash / resp_hash（req 与 resp 一致时 hash 一致）', () => {
    const kind = uniqueKind('append-hash');
    appendAudit({
      kind: asKind(kind),
      req: { a: 1 },
      resp: { b: 2 },
      payload: { record_id: 'rec-1' },
    });
    const row = queryAudit({ kind: asKind(kind) })[0];
    expect(row.req_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.resp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.req_hash).not.toBe(row.resp_hash);
  });

  it('req / resp undefined 时 hash = null', () => {
    const kind = uniqueKind('append-no-hash');
    appendAudit({ kind: asKind(kind), payload: { x: 1 } });
    const row = queryAudit({ kind: asKind(kind) })[0];
    expect(row.req_hash).toBeNull();
    expect(row.resp_hash).toBeNull();
  });

  it('operatorId undefined → operator_id = null', () => {
    const kind = uniqueKind('append-op-null');
    appendAudit({ kind: asKind(kind), payload: { y: 1 } });
    const row = queryAudit({ kind: asKind(kind) })[0];
    expect(row.operator_id).toBeNull();
  });

  it('payload 默认 {} → payload_json = "{}"', () => {
    const kind = uniqueKind('append-empty-payload');
    appendAudit({ kind: asKind(kind) });
    const row = queryAudit({ kind: asKind(kind) })[0];
    expect(row.payload_json).toBe('{}');
  });

  it('relatedEventId 串联事件链', () => {
    const parent = appendAudit({
      kind: 'plugin.add',
      payload: { name: 'lis-writeback' },
    });
    appendAudit({
      kind: 'queue.enqueue',
      relatedEventId: parent.eventId,
      payload: { queue: 'lis-writeback' },
    });
    const enq = queryAudit({ kind: 'queue.enqueue' })[0];
    expect(enq.related_event_id).toBe(parent.eventId);
  });
});

describe('ledger · queryAudit 过滤', () => {
  it('kind 单值过滤', () => {
    const k1 = uniqueKind('filter-single-a');
    const k2 = uniqueKind('filter-single-b');
    appendAudit({ kind: asKind(k1), payload: { x: 1 } });
    appendAudit({ kind: asKind(k2), payload: { y: 2 } });
    const rows = queryAudit({ kind: asKind(k1) });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === k1)).toBe(true);
  });

  it('kind 数组过滤（IN 子句）', () => {
    const k1 = uniqueKind('filter-arr-a');
    const k2 = uniqueKind('filter-arr-b');
    appendAudit({ kind: asKind(k1), payload: { z: 1 } });
    appendAudit({ kind: asKind(k2), payload: { z: 2 } });
    const rows = queryAudit({ kind: [asKind(k1), asKind(k2)] });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.kind === k1 || r.kind === k2)).toBe(true);
  });

  it('operatorId 过滤', () => {
    const opAlice = 'op-alice-' + Date.now();
    const opBob = 'op-bob-' + Date.now();
    appendAudit({ kind: 'plugin.add', operatorId: opAlice, payload: {} });
    appendAudit({ kind: 'plugin.add', operatorId: opBob, payload: {} });
    const alice = queryAudit({ operatorId: opAlice });
    expect(alice.length).toBeGreaterThan(0);
    expect(alice.every((r) => r.operator_id === opAlice)).toBe(true);
  });

  it('limit 边界（≤ 指定值）', () => {
    const kind = uniqueKind('filter-limit');
    for (let i = 0; i < 5; i++) {
      appendAudit({ kind: asKind(kind), payload: { i } });
    }
    const small = queryAudit({ kind: asKind(kind), limit: 3 });
    expect(small.length).toBeLessThanOrEqual(3);
  });

  it('ascending = true 切换排序', () => {
    const kind = uniqueKind('filter-order');
    appendAudit({ kind: asKind(kind), payload: { x: 1 } });
    const desc = queryAudit({ kind: asKind(kind) });
    const asc = queryAudit({
      kind: asKind(kind),
      ascending: true,
    });
    expect(desc[0].ts >= desc[desc.length - 1].ts).toBe(true);
    expect(asc[0].ts <= asc[asc.length - 1].ts).toBe(true);
  });

  it('time window（from 在未来 → 空）', () => {
    const future = '2099-01-01T00:00:00.000Z';
    const rows = queryAudit({ from: future, kind: 'plugin.add' });
    expect(rows.length).toBe(0);
  });
});

describe('ledger · toAuditEvent', () => {
  it('把 AuditRow 转为 AuditEvent，payload_json 解析回对象', () => {
    const kind = uniqueKind('to-event');
    appendAudit({
      kind: asKind(kind),
      operatorId: 'op-1',
      payload: { name: 'lis-writeback', queue_name: 'lis-writeback' },
    });
    const row = queryAudit({ kind: asKind(kind) })[0];
    const ev = toAuditEvent(row);
    expect(ev.kind).toBe(kind);
    expect(ev.operator_id).toBe('op-1');
    expect(ev.payload_json).toMatchObject({ name: 'lis-writeback' });
  });

  it('payload_json 损坏 → 空对象（fail-soft）', () => {
    const ev = toAuditEvent({
      event_id: 'broken-id',
      kind: 'plugin.add',
      req_hash: null,
      resp_hash: null,
      operator_id: null,
      payload_json: 'not-valid-json{',
      ts: new Date().toISOString(),
      related_event_id: null,
    });
    // fail-soft：保留原始字符串到 _raw 字段，主解析给空对象
    expect(ev.payload_json).toHaveProperty('_raw', 'not-valid-json{');
  });
});

describe('ledger · countAudit', () => {
  it('null filter → 全表计数（> 0，因前面 case 已写入）', () => {
    const total = countAudit();
    expect(total).toBeGreaterThan(0);
  });

  it('kind 过滤计数', () => {
    const kind = uniqueKind('count-kind');
    appendAudit({ kind: asKind(kind), payload: {} });
    appendAudit({ kind: asKind(kind), payload: {} });
    const n = countAudit({ kind: asKind(kind) });
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe('ledger · append-only 触发器', () => {
  it('UPDATE 被 trigger 阻止', () => {
    const r = appendAudit({ kind: 'plugin.add', payload: { x: 1 } });
    expect(() => rawUpdateAudit(r.eventId, { operator_id: 'hacker' })).toThrow(
      /append-only|UPDATE/i,
    );
  });

  it('DELETE 被 trigger 阻止', () => {
    const r = appendAudit({ kind: 'plugin.add', payload: { x: 1 } });
    expect(() => rawDeleteAudit(r.eventId)).toThrow(/append-only|DELETE/i);
  });
});

describe('auditSource · plugin 生命周期', () => {
  it('pluginAdd 写入 audit_event 且字段命名稳定', () => {
    const r = auditSource.pluginAdd({
      name: 'lis-writeback',
      version: '1.0.0',
      queueName: 'lis-writeback',
      hooks: ['task'],
    });
    expect(r.eventId).toMatch(/^[0-9a-f-]{36}$/);
    // 用 event_id 精确定位自己刚写入的那一行（与已有 plugin.add 历史行区分）
    const row = queryAudit({ kind: 'plugin.add' }).find(
      (x) => x.event_id === r.eventId,
    );
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      name: 'lis-writeback',
      version: '1.0.0',
      queue_name: 'lis-writeback',
      hooks: ['task'],
    });
  });

  it('pluginRemove 标记 uninstall_triggered', () => {
    auditSource.pluginRemove({
      name: 'iot-heartbeat',
      queueName: 'iot-heartbeat',
      uninstallTriggered: true,
    });
    const row = queryAudit({ kind: 'plugin.remove' })[0];
    expect(JSON.parse(row.payload_json)).toMatchObject({
      name: 'iot-heartbeat',
      uninstall_triggered: true,
    });
  });

  it('pluginUninstall 区分触发源', () => {
    auditSource.pluginUninstall({
      name: 'demo',
      triggeredBy: 'manager',
      success: false,
    });
    const row = queryAudit({ kind: 'plugin.uninstall' })[0];
    expect(JSON.parse(row.payload_json)).toMatchObject({
      triggered_by: 'manager',
      success: false,
    });
  });
});

describe('auditSource · queue 事件', () => {
  it('queueEnqueue / queueProcess / queueFail / queueFinalFail / queueRetry 字段完整', () => {
    // 先写一条 parent event（relatedEventId 受 audit_event FK 约束）
    const parent = appendAudit({
      kind: 'plugin.add',
      payload: { name: 'lis-writeback' },
    });
    const eventId = parent.eventId;
    const jobId = 'job-test-' + Date.now();
    auditSource.queueEnqueue({
      queue: 'lis-writeback',
      eventId,
      jobId,
      payloadPreview: 'preview',
    });
    auditSource.queueProcess({
      queue: 'lis-writeback',
      eventId,
      jobId,
      attempts: 1,
      durationMs: 120,
    });
    auditSource.queueFail({
      queue: 'lis-writeback',
      eventId,
      jobId,
      attempts: 2,
      error: 'ECONNREFUSED',
      nextRunAt: '2024-01-17T00:00:00.000Z',
    });
    auditSource.queueFinalFail({
      queue: 'lis-writeback',
      eventId,
      jobId,
      attempts: 5,
      error: 'ECONNREFUSED',
    });
    auditSource.queueRetry({
      queue: 'lis-writeback',
      jobId,
      eventId,
    });

    const enq = queryAudit({ kind: 'queue.enqueue' })[0];
    const proc = queryAudit({ kind: 'queue.process' })[0];
    const fail = queryAudit({ kind: 'queue.fail' })[0];
    const final = queryAudit({ kind: 'queue.final_fail' })[0];
    const retry = queryAudit({ kind: 'queue.retry' })[0];

    for (const r of [enq, proc, fail, final, retry]) {
      expect(r.related_event_id).toBe(eventId);
    }
    expect(JSON.parse(enq.payload_json)).toMatchObject({
      queue: 'lis-writeback',
      event_id: eventId,
    });
    expect(JSON.parse(proc.payload_json)).toMatchObject({
      attempts: 1,
      duration_ms: 120,
    });
    expect(JSON.parse(fail.payload_json)).toMatchObject({
      error: 'ECONNREFUSED',
    });
    expect(JSON.parse(final.payload_json)).toMatchObject({
      attempts: 5,
    });
    expect(JSON.parse(retry.payload_json)).toMatchObject({
      queue: 'lis-writeback',
    });
  });
});

describe('auditSource · writeback 通道', () => {
  it('writebackInitiated / writebackSuccess 写入 record_id / target', () => {
    auditSource.writebackInitiated({
      recordId: 'rec-1',
      instrumentId: 'ASSET-LAB-0001',
      alarmCode: 'W002',
    });
    auditSource.writebackSuccess({
      recordId: 'rec-1',
      target: '/var/lab/lis-writeback.ndjson',
      instrumentId: 'ASSET-LAB-0001',
    });
    const init = queryAudit({ kind: 'writeback.initiated' })[0];
    const ok = queryAudit({ kind: 'writeback.success' })[0];
    expect(JSON.parse(init.payload_json)).toMatchObject({
      record_id: 'rec-1',
      alarm_code: 'W002',
    });
    expect(JSON.parse(ok.payload_json)).toMatchObject({
      target: '/var/lab/lis-writeback.ndjson',
    });
  });
});

describe('auditSource · processing_record 状态机', () => {
  it('processingRecordCreated / StateChange / Retry 字段稳定', () => {
    auditSource.processingRecordCreated({
      recordId: 'rec-2',
      instrumentId: 'ASSET-LAB-0002',
      alarmCode: 'W010',
      operatorId: 'op-2',
    });
    auditSource.processingRecordStateChange({
      recordId: 'rec-2',
      fromState: 'received',
      toState: 'parsed',
      operatorId: 'op-2',
    });
    auditSource.processingRecordRetry({
      recordId: 'rec-2',
      attempts: 1,
    });
    const c = queryAudit({ kind: 'processing_record.created' })[0];
    const s = queryAudit({ kind: 'processing_record.state_change' })[0];
    const r = queryAudit({ kind: 'processing_record.retry' })[0];
    expect(JSON.parse(c.payload_json)).toMatchObject({
      record_id: 'rec-2',
      instrument_id: 'ASSET-LAB-0002',
      alarm_code: 'W010',
    });
    expect(JSON.parse(s.payload_json)).toMatchObject({
      from_state: 'received',
      to_state: 'parsed',
    });
    expect(JSON.parse(r.payload_json)).toMatchObject({ attempts: 1 });
  });
});

describe('auditSource · heartbeat', () => {
  it('heartbeatDropped / heartbeatReceived / instrumentSeen 字段稳定', () => {
    auditSource.heartbeatDropped({
      vendor: 'Siemens',
      model: 'ADVIA 2400',
      reason: 'rate_limit',
      rawHash: 'abc123',
    });
    auditSource.heartbeatReceived({
      calibrationId: 'cal-1',
      instrumentId: 'ASSET-LAB-0003',
      vendor: 'Siemens',
      model: 'ADVIA 2400',
    });
    auditSource.instrumentSeen({
      instrumentId: 'ASSET-LAB-0003',
      vendor: 'Siemens',
      model: 'ADVIA 2400',
      source: 'heartbeat',
    });
    const drop = queryAudit({ kind: 'heartbeat.dropped' })[0];
    const recv = queryAudit({ kind: 'heartbeat.received' })[0];
    const seen = queryAudit({ kind: 'instrument.seen' })[0];
    expect(JSON.parse(drop.payload_json)).toMatchObject({
      reason: 'rate_limit',
      raw_hash: 'abc123',
    });
    expect(JSON.parse(recv.payload_json)).toMatchObject({
      calibration_id: 'cal-1',
    });
    expect(JSON.parse(seen.payload_json)).toMatchObject({ source: 'heartbeat' });
  });
});