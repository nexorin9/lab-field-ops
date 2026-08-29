// src/server/queue/index.ts
//
// createQueue 实现，灵感来自 outline 的 server/queues/index.ts：
//   createQueue(name, {attempts:5, backoff:{type:"exponential", delay:Second.ms}})
// 主要差异：
//   - delay 与 maxMs 分开（避免同一队列下退避封顶失效）
//   - event_id 去重走 plugin_event_dedupe（task 10 强制要求）
//   - 默认 attempts=5, base=200ms, max=30s，对应退避序列
//     [200, 400, 800, 1600, 3200]ms
//
// 公开 API：
//   createQueue(name, opts?) → Queue
//   Queue.enqueue(payload, {eventId})  ← 同步判重，返回 {id, skipped:boolean}
//   Queue.process(handler)             ← 注册消费函数
//   Queue.run()                        ← 启动调度（每 queue 独立 setImmediate 拉取）
//   Queue.stop()                       ← 取消 setImmediate 链
//   Queue.list() / get(id)             ← 观察当前 job 列表（守护观测面板）
//   Queue.on(event, cb)                ← 订阅 enqueue/process/fail/final_fail
//
// 仅在进程内排队；不依赖外部 broker。attempts 用尽后写 audit_event kind=queue.final_fail，
// 看板 / 看板可观测。

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getDb } from '../db';
import { appendAudit } from '../audit/ledger';
import { claimEventId, releaseEventId } from './dedupe';
import {
  DefaultQueueOptions,
  type EnqueueOptions,
  type QueueEvent,
  type QueueHandler,
  type QueueJobRecord,
  type QueueJobStatus,
  type QueueOptions,
} from './types';

const isoNow = () => new Date().toISOString();

const computeBackoff = (
  attempt: number,
  base: number,
  max: number,
): number => {
  // 首次失败 attempt=1 → base*2^0 = base ms；attempt=2 → 2*base, ...
  const exp = Math.min(attempt - 1, 30);
  const ms = base * 2 ** exp;
  return Math.min(ms, max);
};

export interface Queue extends EventEmitter {
  readonly name: string;
  enqueue(
    payload: Record<string, unknown>,
    opts: EnqueueOptions,
  ): { id: string; skipped: boolean };
  process(handler: QueueHandler): void;
  run(): void;
  stop(): void;
  list(): QueueJobRecord[];
  get(jobId: string): QueueJobRecord | undefined;
  status(): {
    name: string;
    pending: number;
    running: number;
    success: number;
    failed: number;
  };
  /** 测试辅助：跑一次 pickReady+runOne 循环（不依赖 setImmediate 时序）。 */
  __test_runOnce(): Promise<void>;
  /** 测试辅助：把调度循环也手动推进一次。 */
  __test_tickLoop(): Promise<void>;
  /**
   * 内部 helper：把一个 failed job 原地重置为 pending（attempts=0），
   * 便于 observer.retryJob 调用。原 jobId 保持不变。
   * 仅允许 status='failed'；其他状态返回 {ok:false, reason}。
   */
  __resetForRetry(jobId: string): { ok: true } | { ok: false; reason: string };
  /**
   * 内部 helper：清空 jobs map + 重置 success/failed 累计计数。
   * 调度状态（running）保持不变。专用于测试间隔离。
   */
  __clearJobs(): void;
}

export function createQueue(name: string, opts?: Partial<QueueOptions>): Queue {
  const options: QueueOptions = {
    ...DefaultQueueOptions,
    ...(opts ?? {}),
    backoff: { ...DefaultQueueOptions.backoff, ...(opts?.backoff ?? {}) },
  };

  const emitter = new EventEmitter();
  emitter.setMaxListeners(32);
  const queue = emitter as unknown as Queue;

  const jobs = new Map<string, QueueJobRecord>();
  let handler: QueueHandler | null = null;
  let ticker: (NodeJS.Immediate | NodeJS.Timeout) | null = null;
  let running = false;
  let stopRequested = false;
  // 成功的任务会从 jobs map 移除，故 success 用累计计数器；
  // 终态失败的任务**保留**在 map 里（status='failed'，便于看板列出与重投），
  // 因此 failed 只按 map 内的当前失败工单数统计——重投成功后自然归零。
  // 「累计终态失败次数」由 observer.finalFailures 提供，不在这里重复计数。
  let successCount = 0;

  const writeAuditSafely = (
    kind:
      | 'queue.enqueue'
      | 'queue.process'
      | 'queue.fail'
      | 'queue.final_fail',
    job: QueueJobRecord,
    error?: string,
  ): void => {
    try {
      appendAudit({
        kind,
        operatorId: null,
        payload: {
          queue: name,
          job_id: job.id,
          event_id: job.event_id,
          attempt: job.attempts,
          status: job.status,
          ...(error ? { error } : {}),
        },
      });
    } catch {
      /* 审计失败不应阻塞队列主路径 */
    }
  };

  const emitEvent = (
    evt: 'enqueue' | 'process' | 'fail' | 'final_fail' | 'success',
    job: QueueJobRecord,
    extra?: { error?: string },
  ): void => {
    const payload: QueueEvent = {
      jobId: job.id,
      attempt: job.attempts,
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
    };
    writeAuditSafely(
      evt === 'enqueue'
        ? 'queue.enqueue'
        : evt === 'fail'
          ? 'queue.fail'
          : evt === 'final_fail'
            ? 'queue.final_fail'
            : 'queue.process',
      job,
      extra?.error,
    );
    emitter.emit(evt, payload);
  };

  // 用 Object.defineProperty 避免 Queue 接口的 `readonly name` 限制。
  Object.defineProperty(queue, 'name', { value: name, writable: false });

  queue.enqueue = (payload, opts2) => {
    if (!opts2?.eventId) {
      throw new Error('enqueue requires opts.eventId (plugin_event_dedupe key)');
    }
    const dedupe = claimEventId(opts2.eventId, name);
    if (!dedupe.ok) {
      return { id: '', skipped: true };
    }
    const id = randomUUID();
    const job: QueueJobRecord = {
      id,
      name,
      payload: { ...payload },
      attempts: 0,
      status: 'pending',
      last_error: null,
      next_run_at: isoNow(),
      created_at: isoNow(),
      event_id: opts2.eventId,
    };
    jobs.set(id, job);
    emitEvent('enqueue', job);
    if (running) {
      schedule();
    }
    return { id, skipped: false };
  };

  queue.process = (h: QueueHandler) => {
    handler = h;
  };

  queue.run = () => {
    if (running) return;
    running = true;
    stopRequested = false;
    schedule();
  };

  queue.stop = () => {
    stopRequested = true;
    running = false;
    if (ticker) {
      clearImmediate(ticker as NodeJS.Immediate);
      clearTimeout(ticker as NodeJS.Timeout);
      ticker = null;
    }
  };

  queue.list = () => Array.from(jobs.values());
  queue.get = (id) => jobs.get(id);

  queue.status = () => {
    let pending = 0;
    let runningCount = 0;
    let activeSuccess = 0;
    let activeFailed = 0;
    for (const j of jobs.values()) {
      if (j.status === 'pending') pending++;
      else if (j.status === 'running') runningCount++;
      else if (j.status === 'success') activeSuccess++;
      else if (j.status === 'failed') activeFailed++;
    }
    return {
      name,
      pending,
      running: runningCount,
      // 成功任务已从 jobs map 移除，用累计计数器补回
      success: activeSuccess + successCount,
      // 终态失败任务仍在 map 中，直接按当前失败工单数统计（不叠加计数器，否则会重复计一次）
      failed: activeFailed,
    };
  };

  queue.__test_runOnce = async () => {
    if (!handler) return;
    // 测试场景：忽略 next_run_at 时间门控，否则失败重试的下一次尝试会被跳过。
    const j = pickPending();
    if (j) await runOne(j);
  };

  queue.__test_tickLoop = async () => {
    await tick();
  };

  queue.__resetForRetry = (jobId: string) => {
    const job = jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.status !== 'failed') {
      return { ok: false, reason: `not_failed:${job.status}` };
    }
    job.status = 'pending';
    job.attempts = 0;
    job.last_error = null;
    job.next_run_at = isoNow();
    return { ok: true };
  };

  queue.__clearJobs = () => {
    jobs.clear();
    successCount = 0;
  };

  function schedule() {
    if (ticker || stopRequested) return;
    ticker = setImmediate(tick);
  }

  async function tick() {
    ticker = null;
    if (!running || stopRequested) return;
    if (!handler) {
      running = false;
      return;
    }
    const readyJob = pickReady();
    if (!readyJob) {
      ticker = setTimeout(tick, 0);
      return;
    }
    await runOne(readyJob);
    if (!stopRequested) {
      ticker = setImmediate(tick);
    }
  }

  function pickReady(): QueueJobRecord | null {
    const now = Date.now();
    for (const j of jobs.values()) {
      if (j.status !== 'pending') continue;
      const nextAt = Date.parse(j.next_run_at);
      if (Number.isFinite(nextAt) && nextAt > now) continue;
      return j;
    }
    return null;
  }

  /**
   * 跳过 next_run_at 时间门控的 pending 任务拾取（仅 __test_runOnce 用）。
   * 让失败重试的下一次尝试能立即再次执行，不被指数退避等待时间阻塞测试。
   */
  function pickPending(): QueueJobRecord | null {
    for (const j of jobs.values()) {
      if (j.status === 'pending') return j;
    }
    return null;
  }

  async function runOne(job: QueueJobRecord): Promise<void> {
    if (!handler) return;
    job.status = 'running';
    job.attempts += 1;
    emitEvent('process', job);
    try {
      await handler(job);
      job.status = 'success';
      job.last_error = null;
      jobs.delete(job.id);
      successCount += 1;
      // 成功后释放 event_id，便于重投或用户主动补单。
      releaseEventId(job.event_id);
      emitEvent('success', job);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      job.last_error = message;
      const remaining = options.attempts - job.attempts;
      if (remaining <= 0) {
        job.status = 'failed';
        // 终态失败保留在 jobs map（status='failed'），便于 get/list 观察与一键重投；
        // status().failed 直接数 map 内的失败工单，不再另设累计计数器。
        emitEvent('fail', job, { error: message });
        emitEvent('final_fail', job, { error: message });
        releaseEventId(job.event_id);
      } else {
        job.status = 'pending';
        const delay = computeBackoff(
          job.attempts,
          options.backoff.base,
          options.backoff.max,
        );
        const next = new Date(Date.now() + delay);
        job.next_run_at = next.toISOString();
        emitEvent('fail', job, { error: message });
      }
    }
  }

  return queue;
}
