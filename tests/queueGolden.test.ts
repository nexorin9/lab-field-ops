// tests/queueGolden.test.ts
//
// 队列状态对照测试：用 scripts/golden/expected/queue.json 锁住
// 「看板上一条队列长什么样」——字段命名、终态计数、红条判据（attempts=maxAttempts）、
// 重投后的复位形态、以及同 event_id 去重。
//
// 与 tests/queueObserver.test.ts 的差异：
//   - queueObserver.test.ts 验证观测层**行为**（订阅 / 重投 / REST 错误码）；
//   - 本文件验证观测层**输出契约**：DashboardPage 与 /api/queue/status 直接
//     消费这些字段，命名或语义漂移会表现为看板显示 undefined 或红条不亮。

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { closeDb } from '../src/server/db.js';
import { migrate } from '../src/server/db/migrate.js';
import { createQueue, type Queue } from '../src/server/queue/index.js';
import {
  __resetObserverState,
  observeQueue,
  getQueueStatus,
  getQueueJobs,
  retryJob,
} from '../src/server/queue/observer.js';
import { queryAudit } from '../src/server/audit/ledger.js';
import type { AuditEventKind } from '../src/shared/types.js';
import { DefaultQueueOptions } from '../src/server/queue/types.js';

interface QueueGolden {
  version: number;
  statusFields: string[];
  jobFields: string[];
  jobStatuses: string[];
  backoff: {
    type: string;
    base: number;
    max: number;
    attempts: number;
    delaysMs: number[];
  };
  scenarios: Array<Record<string, any>>;
}

const goldenPath = path.join(__dirname, '..', 'scripts', 'golden', 'expected', 'queue.json');
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as QueueGolden;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-queue-golden-'));
const TMP_DB = path.join(TMP_DIR, 'queue-golden.sqlite');

const scenario = (name: string): Record<string, any> => {
  const s = golden.scenarios.find((x) => x.name === name);
  if (!s) throw new Error(`golden 缺少场景: ${name}`);
  return s;
};

/** 按 golden 声明的 handler 类型构造队列。 */
function makeQueue(s: Record<string, any>): Queue {
  const q = createQueue(s.queue, {
    attempts: s.maxAttempts,
    // 测试内把退避压到毫秒级：退避**序列**由 golden.backoff 单独断言
    backoff: { type: 'exponential', base: 1, max: 5 },
  });
  q.process(async () => {
    if (s.handler === 'always-fail') {
      throw new Error('golden simulated failure');
    }
  });
  q.run();
  observeQueue(q);
  return q;
}

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
});

afterAll(() => {
  closeDb();
  if (process.env.DATABASE_PATH === TMP_DB) delete process.env.DATABASE_PATH;
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('队列状态 golden 对照', () => {
  it('golden 文件存在、version=1', () => {
    expect(golden.version).toBe(1);
    expect(golden.scenarios.length).toBeGreaterThanOrEqual(4);
  });

  it('默认退避参数与 golden 一致（重试节奏是运维承诺，不能悄悄改）', () => {
    expect(DefaultQueueOptions.attempts).toBe(golden.backoff.attempts);
    expect(DefaultQueueOptions.backoff.type).toBe(golden.backoff.type);
    expect(DefaultQueueOptions.backoff.base).toBe(golden.backoff.base);
    expect(DefaultQueueOptions.backoff.max).toBe(golden.backoff.max);
    // base * 2^(attempt-1)，封顶 max
    const delays = Array.from({ length: golden.backoff.attempts }, (_, i) =>
      Math.min(golden.backoff.base * 2 ** i, golden.backoff.max),
    );
    expect(delays).toEqual(golden.backoff.delaysMs);
  });

  it('[场景 1] handler 永久失败 → 5 次用尽 → 看板红条', async () => {
    const s = scenario('handler 永久失败 → 5 次用尽 → 看板红条');
    const q = makeQueue(s);
    const { id } = q.enqueue({ recordId: 'PR-GOLDEN-1' }, { eventId: 'golden-evt-fail' });

    for (let i = 0; i < s.runs; i++) await q.__test_runOnce();

    const [status] = getQueueStatus([{ queue: q, maxAttempts: s.maxAttempts }]);
    // 字段命名锁（看板直接消费）
    expect(Object.keys(status).sort()).toEqual([...golden.statusFields].sort());
    expect(status.name).toBe(s.queue);
    expect(status.pending).toBe(s.expectedStatus.pending);
    expect(status.running).toBe(s.expectedStatus.running);
    expect(status.success).toBe(s.expectedStatus.success);
    expect(status.failed).toBe(s.expectedStatus.failed);
    expect(status.finalFailures).toBe(s.expectedStatus.finalFailures);
    expect(status.maxAttempts).toBe(s.expectedStatus.maxAttempts);
    expect(status.lastFailedAt !== null).toBe(s.expectedStatus.lastFailedAtPresent);

    // 红条判据：终态失败且 attempts 撞上限
    const [job] = getQueueJobs(q);
    expect(Object.keys(job).sort()).toEqual([...golden.jobFields].sort());
    expect(job.id).toBe(id);
    expect(job.attempts).toBe(s.expectedJob.attempts);
    expect(job.status).toBe(s.expectedJob.status);
    expect(golden.jobStatuses).toContain(job.status);
    expect(job.lastError).toContain(s.expectedJob.lastErrorContains);
    expect(job.attempts).toBe(status.maxAttempts);

    // 审计链留痕
    for (const kind of s.expectedAuditKinds as AuditEventKind[]) {
      expect(queryAudit({ kind, limit: 10 }).length, `缺少审计 kind=${kind}`).toBeGreaterThan(0);
    }
  });

  it('[场景 2] 失败工单一键重投 → attempts 归零、回到 pending', async () => {
    const s = scenario('失败工单一键重投 → attempts 归零、回到 pending');
    const q = makeQueue(s);
    const { id } = q.enqueue({ recordId: 'PR-GOLDEN-2' }, { eventId: 'golden-evt-retry' });
    for (let i = 0; i < s.runs; i++) await q.__test_runOnce();
    expect(q.get(id)?.status).toBe('failed');

    const result = retryJob([q], id);
    expect(result.attemptsReset).toBe(s.expectedRetryResult.attemptsReset);
    expect(result.jobId).toBe(id);
    expect(result.queue).toBe(s.queue);

    const job = q.get(id)!;
    expect(job.attempts).toBe(s.expectedJobAfterRetry.attempts);
    expect(job.status).toBe(s.expectedJobAfterRetry.status);
    expect(job.last_error).toBe(s.expectedJobAfterRetry.lastError);

    for (const kind of s.expectedAuditKinds as AuditEventKind[]) {
      expect(queryAudit({ kind, limit: 10 }).length, `缺少审计 kind=${kind}`).toBeGreaterThan(0);
    }
  });

  it('[场景 3] handler 成功 → success=1，无失败记录、无红条', async () => {
    const s = scenario('handler 成功 → success=1，无失败记录、无红条');
    const q = makeQueue(s);
    q.enqueue({ instrumentId: 'ASSET-LAB-0142' }, { eventId: 'golden-evt-ok' });
    for (let i = 0; i < s.runs; i++) await q.__test_runOnce();

    const [status] = getQueueStatus([{ queue: q, maxAttempts: s.maxAttempts }]);
    expect(status.success).toBe(s.expectedStatus.success);
    expect(status.failed).toBe(s.expectedStatus.failed);
    expect(status.finalFailures).toBe(s.expectedStatus.finalFailures);
    expect(status.lastFailedAt !== null).toBe(s.expectedStatus.lastFailedAtPresent);
  });

  it('[场景 4] 同 event_id 二次入队 → 跳过（网关重推不会重复处理）', () => {
    const s = scenario('同 event_id 二次入队 → 跳过（网关重推不会重复处理）');
    const q = makeQueue(s);
    const first = q.enqueue({ n: 1 }, { eventId: s.eventId });
    const second = q.enqueue({ n: 2 }, { eventId: s.eventId });

    expect(first.skipped).toBe(false);
    expect(first.id).not.toBe('');
    expect(second.id).toBe(s.expectedSecondEnqueue.id);
    expect(second.skipped).toBe(s.expectedSecondEnqueue.skipped);
    expect(getQueueJobs(q).length).toBe(1);
  });
});
