// tests/queueObserver.test.ts
//
// 队列观测层 + REST 路由 + React 组件端到端测试。
//
// 对应：
//   - task.json task 12：队列重试与最终态观测（看板可见 + 红色告警）
//   - spec.md 工作闭环第 5 条（看板 /api/queue/status 显示 attempts=5 + red bar）
//
// 测试要点：
//   1. observer.subscribe 后 finalFail event → 写 queue.final_fail audit_event + recentFailures 记录
//   2. getQueueStatus / getQueueJobs 返回稳定字段（DashboardPage 直接消费）
//   3. retryJob：failed → pending → 重新 enqueue；attempts=0；写 queue.retry audit_event
//   4. retryJob：非 failed → 抛 CONFLICT；jobId 不存在 → 抛 NOT_FOUND
//   5. REST 路由：GET /api/queue/status → 200；GET /api/queue/:name/jobs → 200 / 404；
//      POST /api/queue/retry/:jobId → 200 / 404 / 409
//   6. 失败注入：handler 永久失败 → 看板 attempts=5 status=failed → retry 重投后变 pending → 再成功

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { closeDb, getDb } from '../src/server/db.js';
import { migrate } from '../src/server/db/migrate.js';
import { createQueue } from '../src/server/queue/index.js';
import {
  __resetObserverState,
  observeQueue,
  getQueueStatus,
  getQueueJobs,
  getRecentFailures,
  retryJob,
  QueueObserverError,
} from '../src/server/queue/observer.js';
import {
  getQueueStatusRoute,
  getQueueJobsRoute,
  postQueueRetryRoute,
  defaultQueueRouteContext,
  __resetQueueRouteContext,
  type QueueRouteContext,
} from '../src/server/routes/queue.js';
import { queryAudit, appendAudit } from '../src/server/audit/ledger.js';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-obs-'));
const TMP_DB = path.join(TMP_DIR, 'observer.sqlite');

beforeAll(() => {
  process.chdir(PROJECT_ROOT);
  process.env.DATABASE_PATH = TMP_DB;
  closeDb();
  migrate(TMP_DB);
});

beforeEach(() => {
  closeDb();
  if (fs.existsSync(TMP_DB)) {
    fs.rmSync(TMP_DB, { force: true });
  }
  migrate(TMP_DB);
  __resetObserverState();
  __resetQueueRouteContext();
});

afterAll(() => {
  closeDb();
  if (process.env.DATABASE_PATH === TMP_DB) {
    delete process.env.DATABASE_PATH;
  }
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

/** 注入 handler：handler 抛错触发重试。 */
const failingHandler = () => async (): Promise<void> => {
  throw new Error('simulated failure');
};

const successHandler = () => async (): Promise<void> => {
  // noop
};

describe('observer 基础行为', () => {
  it('observeQueue 订阅 final_fail → recentFailures 写入 + finalFailureCount 自增', async () => {
    const q = createQueue('obs-q-1', { attempts: 2, backoff: { type: 'exponential', base: 10, max: 100 } });
    q.process(failingHandler());
    q.run();
    observeQueue(q);

    const { id } = q.enqueue({ kind: 'sample' }, { eventId: 'obs-evt-1' });

    // 跑 2 次（attempts=2）让 job 进 final_fail
    await q.__test_runOnce();
    await q.__test_runOnce();

    const recent = getRecentFailures(q.name);
    expect(recent.length).toBe(1);
    expect(recent[0].jobId).toBe(id);
    expect(recent[0].attempts).toBe(2);
    expect(recent[0].error).toContain('simulated failure');

    const status = getQueueStatus([{ queue: q, maxAttempts: 2 }]);
    expect(status[0].finalFailures).toBe(1);
    expect(status[0].failed).toBeGreaterThanOrEqual(1);
    expect(status[0].lastFailedAt).toBeTruthy();
  });

  it('多次 final_fail 按时间倒序保留最多 50 条', async () => {
    const q = createQueue('obs-q-2', { attempts: 1, backoff: { type: 'exponential', base: 5, max: 50 } });
    q.process(failingHandler());
    q.run();
    observeQueue(q);

    for (let i = 0; i < 3; i++) {
      q.enqueue({ i }, { eventId: `obs-evt-multi-${i}` });
      await q.__test_runOnce();
    }

    const recent = getRecentFailures(q.name);
    expect(recent.length).toBe(3);
    // 最后入队的应该排在最前（unshift）
    expect(recent[0].error).toContain('simulated failure');
    expect(getQueueStatus([{ queue: q, maxAttempts: 1 }])[0].finalFailures).toBe(3);
  });

  it('成功路径不写 observer 计数（queue.final_fail audit 仍由 queue/index 落）', async () => {
    const q = createQueue('obs-q-3');
    q.process(successHandler());
    q.run();
    observeQueue(q);

    q.enqueue({ kind: 'ok' }, { eventId: 'obs-evt-ok' });
    await q.__test_runOnce();

    expect(getRecentFailures(q.name)).toEqual([]);
    const status = getQueueStatus([{ queue: q, maxAttempts: 5 }]);
    expect(status[0].finalFailures).toBe(0);
    expect(status[0].failed).toBe(0);
    expect(status[0].success).toBe(1);
  });

  it('getQueueJobs 返回稳定字段（DashboardPage 直接消费）', async () => {
    const q = createQueue('obs-q-jobs', { attempts: 1, backoff: { type: 'exponential', base: 10, max: 50 } });
    q.process(failingHandler());
    q.run();
    observeQueue(q);

    const { id } = q.enqueue({ kind: 'job-shape' }, { eventId: 'jobs-evt' });
    await q.__test_runOnce();

    const jobs = getQueueJobs(q);
    expect(jobs.length).toBe(1);
    const job = jobs[0];
    expect(job.id).toBe(id);
    expect(job.name).toBe(q.name);
    expect(job.eventId).toBe('jobs-evt');
    expect(job.status).toBe('failed');
    expect(job.lastError).toContain('simulated failure');
    expect(typeof job.nextRunAt).toBe('string');
    expect(typeof job.createdAt).toBe('string');
    expect(job.payloadPreview).toContain('job-shape');
  });
});

describe('retryJob 行为', () => {
  it('failed → 原地重置为 pending，attempts=0，写 queue.retry audit_event', async () => {
    const q = createQueue('retry-q-1', { attempts: 1, backoff: { type: 'exponential', base: 10, max: 50 } });
    q.process(failingHandler());
    q.run();
    observeQueue(q);

    const { id } = q.enqueue({ kind: 'retry' }, { eventId: 'retry-evt-1' });
    await q.__test_runOnce();
    expect(q.get(id)?.status).toBe('failed');

    const result = retryJob([q], id);
    expect(result.jobId).toBe(id);
    expect(result.queue).toBe(q.name);
    expect(result.attemptsReset).toBe(0);

    // 原 jobId 现在是 pending
    const job = q.get(id);
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(0);
    expect(job?.last_error).toBeNull();

    // audit_event 写了 queue.retry
    const retries = queryAudit({ kind: 'queue.retry', limit: 10 });
    expect(retries.length).toBeGreaterThan(0);
    const last = JSON.parse(retries[0].payload_json);
    expect(last.queue).toBe(q.name);
    expect(last.job_id).toBe(id);
    expect(last.event_id).toBe('retry-evt-1');
  });

  it('非 failed 状态 retry → 抛 QueueObserverError(CONFLICT, 409)', () => {
    const q = createQueue('retry-q-2');
    q.process(successHandler());
    q.run();
    observeQueue(q);

    const { id } = q.enqueue({}, { eventId: 'retry-evt-2' });
    // 不跑 runOnce → status='pending'

    expect(() => retryJob([q], id)).toThrow(QueueObserverError);
    try {
      retryJob([q], id);
    } catch (e) {
      const err = e as QueueObserverError;
      expect(err.code).toBe('CONFLICT');
      expect(err.status).toBe(409);
    }
  });

  it('jobId 不存在 → 抛 QueueObserverError(NOT_FOUND, 404)', () => {
    const q = createQueue('retry-q-3');
    observeQueue(q);

    try {
      retryJob([q], 'nonexistent-job');
    } catch (e) {
      const err = e as QueueObserverError;
      expect(err.code).toBe('NOT_FOUND');
      expect(err.status).toBe(404);
    }
  });
});

describe('REST 路由', () => {
  it('GET /api/queue/status 返回所有队列状态', async () => {
    // 直接用 default ctx（registerAllTasks 启动两个 queue）
    const ctx = defaultQueueRouteContext();
    const res = getQueueStatusRoute({}, {}, {}, ctx);
    expect(res.status).toBe(200);
    if (res.status === 200 && 'queues' in res.body) {
      const queues = res.body.queues;
      expect(Array.isArray(queues)).toBe(true);
      const names = queues.map((q) => q.name);
      expect(names).toContain('lis-writeback');
      expect(names).toContain('iot-heartbeat');
      for (const row of queues) {
        expect(typeof row.pending).toBe('number');
        expect(typeof row.failed).toBe('number');
        expect(typeof row.maxAttempts).toBe('number');
      }
    }
  });

  it('GET /api/queue/:name/jobs 找到队列返 200；找不到返 404', () => {
    const ctx = defaultQueueRouteContext();
    const ok = getQueueJobsRoute({ name: 'lis-writeback' }, {}, {}, ctx);
    expect(ok.status).toBe(200);
    if (ok.status === 200 && 'queue' in ok.body) {
      expect(ok.body.queue).toBe('lis-writeback');
      expect(Array.isArray(ok.body.jobs)).toBe(true);
    }

    const notFound = getQueueJobsRoute({ name: 'not-a-queue' }, {}, {}, ctx);
    expect(notFound.status).toBe(404);
    if (notFound.status === 404 && 'error' in notFound.body) {
      expect(notFound.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('POST /api/queue/retry/:jobId：成功 → 200；非 failed → 409；不存在 → 404', async () => {
    const ctx = defaultQueueRouteContext();
    const queues = ctx.allQueues();
    // 注入一个失败 job
    const wq = queues.find((q) => q.name === 'lis-writeback')!;
    // 停掉 registerAllTasks 启动的 tick 循环，让 __test_runOnce 单独推进 attempts
    wq.stop();
    wq.__clearJobs();
    wq.process(failingHandler());
    observeQueue(wq);

    const { id } = wq.enqueue({ kind: 'rest-retry' }, { eventId: 'rest-retry-evt' });
    // default attempts=5 → 跑 5 次让 job 进 final_fail
    for (let i = 0; i < 5; i++) {
      await wq.__test_runOnce();
    }
    expect(wq.get(id)?.status).toBe('failed');

    // 200 path
    const ok = postQueueRetryRoute({ jobId: id }, {}, {}, ctx);
    expect(ok.status).toBe(200);

    // 409 path：再次 retry（现在 status=pending）
    const conflict = postQueueRetryRoute({ jobId: id }, {}, {}, ctx);
    expect(conflict.status).toBe(409);
    if (conflict.status === 409 && 'error' in conflict.body) {
      expect(conflict.body.error.code).toBe('CONFLICT');
    }

    // 404 path
    const notFound = postQueueRetryRoute({ jobId: 'ghost-job' }, {}, {}, ctx);
    expect(notFound.status).toBe(404);
    if (notFound.status === 404 && 'error' in notFound.body) {
      expect(notFound.body.error.code).toBe('NOT_FOUND');
    }
  });
});

describe('看板红色告警 + 重投 端到端', () => {
  it('注入故障 → 看板 attempts=5 status=failed → retry 重投 → 看板 success', async () => {
    // 1. 准备：写入一条 audit_event 作为初始日志（确保迁移后表可见）
    appendAudit({ kind: 'queue.enqueue', operatorId: null, payload: { setup: true } });

    // 2. 创建失败队列并注入失败 handler
    const q = createQueue('e2e-q-red', { attempts: 5, backoff: { type: 'exponential', base: 5, max: 50 } });
    let shouldFail = true;
    q.process(async () => {
      if (shouldFail) throw new Error('flaky');
    });
    q.run();
    observeQueue(q);

    // 3. 注入失败 job → 跑 5 次让 attempts=5 进 final_fail
    const { id } = q.enqueue({ kind: 'e2e' }, { eventId: 'e2e-evt' });
    for (let i = 0; i < 5; i++) {
      await q.__test_runOnce();
    }
    expect(q.get(id)?.status).toBe('failed');
    expect(q.get(id)?.attempts).toBe(5);

    // 4. 看板看到 attempts=5 status=failed → 红条
    const statusRows = getQueueStatus([{ queue: q, maxAttempts: 5 }]);
    expect(statusRows[0].failed).toBeGreaterThanOrEqual(1);
    expect(statusRows[0].finalFailures).toBe(1);
    expect(statusRows[0].maxAttempts).toBe(5);

    // 5. retry 重投 → 修复 handler → 成功
    const retryRes = retryJob([q], id);
    expect(retryRes.attemptsReset).toBe(0);
    expect(q.get(id)?.status).toBe('pending');

    shouldFail = false;
    await q.__test_runOnce();
    expect(q.get(id)).toBeUndefined(); // 成功后 jobs.delete
    expect(q.status().success).toBe(1);

    // 6. audit_event 留痕完整
    const failAudits = queryAudit({ kind: 'queue.final_fail', limit: 100 });
    const retryAudits = queryAudit({ kind: 'queue.retry', limit: 100 });
    expect(failAudits.length).toBeGreaterThan(0);
    expect(retryAudits.length).toBe(1);
    expect(JSON.parse(retryAudits[0].payload_json).job_id).toBe(id);
  });
});
