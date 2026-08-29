// tests/auditQueueApi.test.ts
//
// 对应 task.json task 26：REST 端点 — audit replay + 队列状态 API。
//
// 与 task 12 / task 23 的测试分工：
//   - queueObserver.test.ts：observer 内部状态机（recentFailures / finalFailures / retryJob 语义）
//   - auditReplay.test.ts：replay() 纯函数沿 related_event_id 串联链的正确性
//   - 本文件：**REST 路由层契约**——两组端点的响应形态、过滤参数解析、错误码与 HTTP 状态
//     （NOT_FOUND 404 / CONFLICT 409 / VALIDATION_ERROR 400），以及审计与队列两条链路
//     在同一场景下（写记录 → 队列失败 → 看板 → 重投）互相可对账。
//
// 关键断言：
//   1. GET  /api/audit             → 200，过滤 kind / operatorId / from-to / limit 生效；非法 kind fail-soft
//   2. GET  /api/audit/:id/replay  → 200 返回 {root,current,parents,children,chain}
//   3. GET  /api/audit/:id/replay  → 404（eventId 不存在）/ 400（eventId 缺失）
//   4. GET  /api/queue/status      → 200，字段稳定（DashboardPage 直接消费）
//   5. GET  /api/queue/:name/jobs  → 200 / 404（队列名不存在）
//   6. POST /api/queue/retry/:id   → 200（failed）/ 409（非 failed）/ 404（jobId 不存在）

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { closeDb } from '../src/server/db.js';
import { migrate } from '../src/server/db/migrate.js';
import { appendAudit } from '../src/server/audit/ledger.js';
import { createQueue } from '../src/server/queue/index.js';
import {
  __resetObserverState,
  observeQueue,
  type QueueJobView,
  type QueueStatusRow,
} from '../src/server/queue/observer.js';
import {
  getQueueStatusRoute,
  getQueueJobsRoute,
  postQueueRetryRoute,
  __resetQueueRouteContext,
  type QueueRouteContext,
} from '../src/server/routes/queue.js';
import { getAuditRoute, getAuditReplayRoute } from '../src/server/routes/audit.js';
import type { ApiErrorBody } from '../src/server/errors.js';
import type { ReplayResult } from '../src/server/audit/replay.js';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-aqapi-'));
const TMP_DB = path.join(TMP_DIR, 'audit-queue-api.sqlite');

beforeAll(() => {
  process.chdir(PROJECT_ROOT);
  process.env.DATABASE_PATH = TMP_DB;
  closeDb();
  migrate(TMP_DB);
});

beforeEach(() => {
  closeDb();
  fs.rmSync(TMP_DB, { force: true });
  migrate(TMP_DB);
  __resetObserverState();
  __resetQueueRouteContext();
});

afterAll(() => {
  closeDb();
  if (process.env.DATABASE_PATH === TMP_DB) {
    delete process.env.DATABASE_PATH;
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** 用一个内存队列构造路由上下文，避免依赖 registerAllTasks() 的进程级单例。 */
function ctxFor(...queues: ReturnType<typeof createQueue>[]): QueueRouteContext {
  return {
    allQueues: () => queues,
    maxAttemptsFor: () => 2,
  };
}

const failingHandler = async (): Promise<void> => {
  throw new Error('simulated writeback failure');
};

const okHandler = async (): Promise<void> => {
  /* noop */
};

/**
 * 构造一条「处理记录确认 → 队列入队 → 队列终态失败」的审计链，
 * 返回链上各节点 event_id，供 replay 端点断言。
 */
function seedAuditChain(): {
  rootId: string;
  stateChangeId: string;
  enqueueId: string;
} {
  const root = appendAudit({
    kind: 'processing_record.created',
    operatorId: 'eng-lab-01',
    payload: { record_id: 'REC-0001', instrument_id: 'ASSET-LAB-0001' },
  });
  const stateChange = appendAudit({
    kind: 'processing_record.state_change',
    operatorId: 'eng-lab-01',
    payload: { record_id: 'REC-0001', from: 'parsed', to: 'verified' },
    relatedEventId: root.eventId,
  });
  const enqueue = appendAudit({
    kind: 'queue.enqueue',
    operatorId: null,
    payload: { queue: 'lis-writeback', record_id: 'REC-0001' },
    relatedEventId: stateChange.eventId,
  });
  // enqueue 的两个下游（children）
  appendAudit({
    kind: 'queue.fail',
    operatorId: null,
    payload: { queue: 'lis-writeback', attempts: 1 },
    relatedEventId: enqueue.eventId,
  });
  appendAudit({
    kind: 'queue.final_fail',
    operatorId: null,
    payload: { queue: 'lis-writeback', attempts: 2 },
    relatedEventId: enqueue.eventId,
  });
  return {
    rootId: root.eventId,
    stateChangeId: stateChange.eventId,
    enqueueId: enqueue.eventId,
  };
}

describe('GET /api/audit（列表 + 过滤）', () => {
  it('无过滤时返回全部事件，字段形态稳定', () => {
    seedAuditChain();
    const res = getAuditRoute({}, {}, undefined);
    expect(res.status).toBe(200);
    const body = res.body as { events: unknown[]; total: number; limit: number };
    expect(body.total).toBe(5);
    expect(body.limit).toBe(100);
    const first = body.events[0] as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(
      [
        'event_id',
        'kind',
        'operator_id',
        'payload',
        'related_event_id',
        'req_hash',
        'resp_hash',
        'ts',
      ].sort(),
    );
  });

  it('kind 支持单值与逗号分隔多值；非法 kind fail-soft 忽略', () => {
    seedAuditChain();

    const single = getAuditRoute({}, { kind: 'queue.final_fail' }, undefined);
    expect((single.body as { total: number }).total).toBe(1);

    const multi = getAuditRoute({}, { kind: 'queue.fail,queue.final_fail' }, undefined);
    expect((multi.body as { total: number }).total).toBe(2);

    // 全部非法 kind → 过滤器丢弃 → 退回「不过滤」，而不是返回空集
    const bogus = getAuditRoute({}, { kind: 'not-a-kind' }, undefined);
    expect((bogus.body as { total: number }).total).toBe(5);

    // 合法 + 非法混合 → 只按合法项过滤
    const mixed = getAuditRoute({}, { kind: 'queue.fail,not-a-kind' }, undefined);
    expect((mixed.body as { total: number }).total).toBe(1);
  });

  it('operatorId / limit 过滤生效，limit 上限截断到 1000', () => {
    seedAuditChain();

    const byOperator = getAuditRoute({}, { operatorId: 'eng-lab-01' }, undefined);
    expect((byOperator.body as { total: number }).total).toBe(2);

    const limited = getAuditRoute({}, { limit: '2' }, undefined);
    expect((limited.body as { total: number }).total).toBe(2);
    expect((limited.body as { limit: number }).limit).toBe(2);

    const capped = getAuditRoute({}, { limit: '99999' }, undefined);
    expect((capped.body as { limit: number }).limit).toBe(1000);

    // 非法 limit → 回落默认 100，不抛错
    const bad = getAuditRoute({}, { limit: 'abc' }, undefined);
    expect(bad.status).toBe(200);
    expect((bad.body as { limit: number }).limit).toBe(100);
  });

  it('from / to 时间窗过滤生效', () => {
    seedAuditChain();
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    expect((getAuditRoute({}, { from: future }, undefined).body as { total: number }).total).toBe(0);
    expect((getAuditRoute({}, { to: past }, undefined).body as { total: number }).total).toBe(0);
    expect(
      (getAuditRoute({}, { from: past, to: future }, undefined).body as { total: number }).total,
    ).toBe(5);
  });
});

describe('GET /api/audit/:eventId/replay', () => {
  it('返回 root / parents / children / chain 完整事件链', () => {
    const { rootId, stateChangeId, enqueueId } = seedAuditChain();

    const res = getAuditReplayRoute({ eventId: enqueueId }, {}, undefined);
    expect(res.status).toBe(200);
    const body = res.body as ReplayResult;

    expect(body.root).toBe(rootId);
    expect(body.current.event_id).toBe(enqueueId);
    expect(body.parents.map((e) => e.event_id)).toEqual([rootId, stateChangeId]);
    expect(body.children.map((e) => e.kind).sort()).toEqual(
      ['queue.fail', 'queue.final_fail'].sort(),
    );
    // chain 覆盖整条链（root..current + children），至少 5 个节点
    expect(body.chain.length).toBeGreaterThanOrEqual(5);
    expect(body.chain.map((e) => e.event_id)).toContain(rootId);
    expect(body.chain.map((e) => e.event_id)).toContain(enqueueId);
  });

  it('链首事件 replay：root == 自身，parents 为空', () => {
    const { rootId, stateChangeId } = seedAuditChain();
    const res = getAuditReplayRoute({ eventId: rootId }, {}, undefined);
    const body = res.body as ReplayResult;
    expect(body.root).toBe(rootId);
    expect(body.parents).toEqual([]);
    expect(body.children.map((e) => e.event_id)).toEqual([stateChangeId]);
  });

  it('eventId 不存在 → 404 NOT_FOUND', () => {
    seedAuditChain();
    const res = getAuditReplayRoute({ eventId: 'no-such-event' }, {}, undefined);
    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('eventId 缺失 → 400 VALIDATION_ERROR', () => {
    const res = getAuditReplayRoute({}, {}, undefined);
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/queue/status 与 /api/queue/:name/jobs', () => {
  it('status 返回稳定字段；jobs 返回该队列 job 列表', async () => {
    const q = createQueue('lis-writeback', {
      attempts: 2,
      backoff: { type: 'exponential', base: 5, max: 50 },
    });
    q.process(() => failingHandler());
    q.run();
    observeQueue(q);
    const { id } = q.enqueue({ recordId: 'REC-0001' }, { eventId: 'api-evt-1' });
    await q.__test_runOnce();
    await q.__test_runOnce();

    const statusRes = getQueueStatusRoute({}, {}, undefined, ctxFor(q));
    expect(statusRes.status).toBe(200);
    const rows = (statusRes.body as { queues: QueueStatusRow[] }).queues;
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'failed',
        'finalFailures',
        'lastFailedAt',
        'maxAttempts',
        'name',
        'pending',
        'running',
        'success',
      ].sort(),
    );
    expect(rows[0].name).toBe('lis-writeback');
    expect(rows[0].maxAttempts).toBe(2);
    expect(rows[0].finalFailures).toBe(1);

    const jobsRes = getQueueJobsRoute({ name: 'lis-writeback' }, {}, undefined, ctxFor(q));
    expect(jobsRes.status).toBe(200);
    const jobs = (jobsRes.body as { queue: string; jobs: QueueJobView[] }).jobs;
    expect(jobs.map((j) => j.id)).toEqual([id]);
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].lastError).toContain('simulated writeback failure');
  });

  it('队列名不存在 → 404 NOT_FOUND', () => {
    const q = createQueue('lis-writeback');
    const res = getQueueJobsRoute({ name: 'no-such-queue' }, {}, undefined, ctxFor(q));
    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
    expect((res.body as ApiErrorBody).error.message).toContain('no-such-queue');
  });
});

describe('POST /api/queue/retry/:jobId', () => {
  it('failed job → 200，attempts 归零、状态回到 pending，并落 queue.retry 审计', async () => {
    const q = createQueue('lis-writeback', {
      attempts: 1,
      backoff: { type: 'exponential', base: 5, max: 50 },
    });
    q.process(() => failingHandler());
    q.run();
    observeQueue(q);
    const { id } = q.enqueue({ recordId: 'REC-0002' }, { eventId: 'api-evt-retry' });
    await q.__test_runOnce();
    expect(q.get(id)?.status).toBe('failed');

    const res = postQueueRetryRoute({ jobId: id }, {}, undefined, ctxFor(q));
    expect(res.status).toBe(200);
    const body = res.body as { jobId: string; queue: string; attemptsReset: number };
    expect(body.jobId).toBe(id);
    expect(body.queue).toBe('lis-writeback');
    expect(body.attemptsReset).toBe(0);
    expect(q.get(id)?.status).toBe('pending');

    // 审计端点能看到这次重投（两条链路互相对账）
    const audit = getAuditRoute({}, { kind: 'queue.retry' }, undefined);
    expect((audit.body as { total: number }).total).toBe(1);
  });

  it('非 failed 状态（pending）job → 409 CONFLICT', () => {
    const q = createQueue('iot-heartbeat');
    q.process(() => okHandler());
    q.run();
    observeQueue(q);
    // 不跑 runOnce → 停在 pending；重投只对 failed 开放
    const { id } = q.enqueue({ instrumentId: 'ASSET-LAB-0002' }, { eventId: 'api-evt-pending' });
    expect(q.get(id)?.status).toBe('pending');

    const res = postQueueRetryRoute({ jobId: id }, {}, undefined, ctxFor(q));
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).error.code).toBe('CONFLICT');
  });

  it('已成功的 job 已从队列移除 → 重投返回 404 NOT_FOUND（不重复投递成功事件）', async () => {
    const q = createQueue('iot-heartbeat');
    q.process(() => okHandler());
    q.run();
    observeQueue(q);
    const { id } = q.enqueue({ instrumentId: 'ASSET-LAB-0003' }, { eventId: 'api-evt-ok' });
    await q.__test_runOnce();

    const res = postQueueRetryRoute({ jobId: id }, {}, undefined, ctxFor(q));
    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('jobId 不存在 → 404 NOT_FOUND', () => {
    const q = createQueue('lis-writeback');
    const res = postQueueRetryRoute({ jobId: 'job-does-not-exist' }, {}, undefined, ctxFor(q));
    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });
});
