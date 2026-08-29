// src/server/queue/observer.ts
//
// 队列观测层：订阅每个队列的 enqueue/process/fail/final_fail 事件 →
//  1) 写 audit_event（final_fail 走专用 kind，让 queryAudit 可索引）
//  2) 维护最近失败历史（内存）→ 暴露 /api/queue/status 与 /api/queue/:name/jobs
//  3) 提供 retryJob()：调用 Queue.__resetForRetry 把 failed job 原地复位为 pending
//
// 设计取舍：
//   - 不重写 queue/index.ts 的 writeAuditSafely 路径；observer 走 EventEmitter
//     订阅，事件流与 audit 写入解耦，便于测试时注入 mock subscriber。
//   - 最近失败队列容量有限（每队列保留 50 条），保证内存不爆炸；
//     完整历史靠 audit_event 表回查（queryAudit）。
//   - retry 不重建新 job，复用原 jobId 让前端可以幂等跟踪同一事件。

import type { Queue } from './index.js';
import { appendAudit } from '../audit/ledger.js';

export interface QueueFailureRecord {
  jobId: string;
  eventId: string;
  queue: string;
  attempts: number;
  error: string;
  failedAt: string; // ISO 时间
}

export interface QueueJobView {
  id: string;
  name: string;
  eventId: string;
  attempts: number;
  status: 'pending' | 'running' | 'success' | 'failed';
  lastError: string | null;
  nextRunAt: string;
  createdAt: string;
  payloadPreview: string; // 前 80 字
}

export interface QueueStatusRow {
  name: string;
  pending: number;
  running: number;
  success: number;
  failed: number;
  /** 最近一次失败时间（ISO），未失败过 = null */
  lastFailedAt: string | null;
  /** 最近失败次数（attempts 达到 options.attempts 的终态失败计数） */
  finalFailures: number;
  /** options.attempts 上限（用于前端判断「是否红色告警」） */
  maxAttempts: number;
}

const RECENT_FAILURE_LIMIT = 50;

/** 进程级状态：每队列维护最近失败列表 + 终态失败计数。 */
const recentFailures: Map<string, QueueFailureRecord[]> = new Map();
const finalFailureCount: Map<string, number> = new Map();

/** 已订阅的 queue + listener（用于测试 / 重置时清理）。 */
const subscribed: Map<Queue, () => void> = new Map();

/** 暴露给测试 / 重置的辅助。 */
export function __resetObserverState(): void {
  for (const off of subscribed.values()) off();
  subscribed.clear();
  recentFailures.clear();
  finalFailureCount.clear();
}

/** 注册一个 queue 的事件订阅（幂等：同 queue 重复订阅会先解绑旧 listener）。 */
export function observeQueue(queue: Queue): void {
  if (subscribed.has(queue)) {
    subscribed.get(queue)!();
    subscribed.delete(queue);
  }

  // queue.emit('final_fail', payload) 的 payload 是 QueueEvent 单参；
  // event_id 不在 payload 里，需要 queue.get(jobId) 反查 job 记录。
  const onFinalFail = (evt: { jobId: string; attempt: number; error?: string }): void => {
    const job = queue.get(evt.jobId);
    const eventId = job?.event_id ?? '<unknown>';
    const attempts = job?.attempts ?? evt.attempt ?? 0;
    const error = job?.last_error ?? evt.error ?? '';
    const failedAt = new Date().toISOString();
    const rec: QueueFailureRecord = {
      jobId: evt.jobId,
      eventId,
      queue: queue.name,
      attempts,
      error,
      failedAt,
    };
    const arr = recentFailures.get(queue.name) ?? [];
    arr.unshift(rec);
    if (arr.length > RECENT_FAILURE_LIMIT) arr.length = RECENT_FAILURE_LIMIT;
    recentFailures.set(queue.name, arr);
    finalFailureCount.set(
      queue.name,
      (finalFailureCount.get(queue.name) ?? 0) + 1,
    );
    // queue/index.ts 已经写了 queue.final_fail；observer 不重复落 audit_event
  };

  queue.on('final_fail', onFinalFail);
  subscribed.set(queue, () => {
    queue.off('final_fail', onFinalFail);
  });
}

/** 一次性订阅一组 queue。 */
export function observeQueues(queues: Queue[]): void {
  for (const q of queues) observeQueue(q);
}

/**
 * 读取某个 queue 的当前状态视图（含最近失败）。
 * maxAttempts：从 queue.status() 无法拿 options.attempts，需要外部注入。
 */
export function getQueueStatus(
  queues: Array<{ queue: Queue; maxAttempts: number }>,
): QueueStatusRow[] {
  return queues.map(({ queue, maxAttempts }) => {
    const s = queue.status();
    const recent = recentFailures.get(queue.name) ?? [];
    return {
      name: queue.name,
      pending: s.pending,
      running: s.running,
      success: s.success,
      failed: s.failed,
      lastFailedAt: recent[0]?.failedAt ?? null,
      finalFailures: finalFailureCount.get(queue.name) ?? 0,
      maxAttempts,
    };
  });
}

/** 读取某个 queue 的 job 列表（供 /api/queue/:name/jobs）。 */
export function getQueueJobs(queue: Queue): QueueJobView[] {
  return queue.list().map((j) => ({
    id: j.id,
    name: j.name,
    eventId: j.event_id,
    attempts: j.attempts,
    status: j.status,
    lastError: j.last_error,
    nextRunAt: j.next_run_at,
    createdAt: j.created_at,
    payloadPreview: JSON.stringify(j.payload).slice(0, 80),
  }));
}

/** 读取最近失败记录（仅本进程内；跨进程需走 audit_event 表）。 */
export function getRecentFailures(queueName: string): QueueFailureRecord[] {
  return [...(recentFailures.get(queueName) ?? [])];
}

/**
 * 重投某个 job：把 job.status=failed → pending、attempts 重置为 0、
 *  重新加入 jobs map 等待下一轮 pickReady（attempts=0 让 backoff 重算为 base*2^0=base ms）。
 *  只允许 failed 状态重投，其他状态抛 StateError 由 REST 层映射为 409。
 */
export class QueueObserverError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT';
  readonly status: number;
  constructor(code: 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(message);
    this.code = code;
    this.status = code === 'NOT_FOUND' ? 404 : 409;
  }
}

export interface RetryJobResult {
  jobId: string;
  queue: string;
  attemptsReset: number;
  retriedAt: string;
}

/** 重投：失败态 → 原地复位为 pending；attempts=0；写 audit_event kind=queue.retry。 */
export function retryJob(
  queues: Queue[],
  jobId: string,
): RetryJobResult {
  for (const q of queues) {
    const job = q.get(jobId);
    if (!job) continue;
    if (job.status !== 'failed') {
      throw new QueueObserverError(
        'CONFLICT',
        `job ${jobId} is in status=${job.status}, only failed jobs can be retried`,
      );
    }
    const reset = q.__resetForRetry(jobId);
    if (!reset.ok) {
      throw new QueueObserverError(
        'CONFLICT',
        `failed to reset job ${jobId}: ${reset.reason}`,
      );
    }
    const now = new Date().toISOString();
    appendAudit({
      kind: 'queue.retry',
      operatorId: null,
      payload: {
        queue: q.name,
        job_id: jobId,
        event_id: job.event_id,
        retried_at: now,
      },
    });
    return {
      jobId,
      queue: q.name,
      attemptsReset: 0,
      retriedAt: now,
    };
  }
  throw new QueueObserverError('NOT_FOUND', `job ${jobId} not found in any queue`);
}
