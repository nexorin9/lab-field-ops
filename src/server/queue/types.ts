// src/server/queue/types.ts
// 队列配置与 Job 状态类型。
//
// 设计要点：
//   - 内部 Job 仅运行时持有；不持久化（试验环境 SQLite 表 plugin_event_dedupe 仅
//     用于事件去重，不存 job 状态）。
//   - backoff 序列：default = base * 2^(attempts-1)，封顶 max。
//     默认 base=200ms / max=30s / attempts=5 → [200, 400, 800, 1600, 3200]ms，
//     可被测试打断在 fake timers 下逐项断言。
//   - 跨进程语义：现在进程内调度；不引入 Redis / 持久队列。重启会丢未处理 job。

import type { JSONPayload } from '../../shared/types';

export type QueueJobStatus = 'pending' | 'running' | 'success' | 'failed';

export interface BackoffOptions {
  type: 'exponential';
  base: number;      // 首次失败后退避时长（毫秒）
  max: number;       // 退避封顶（毫秒）
}

export interface QueueOptions {
  attempts: number;                          // 最大尝试次数（含首次成功前的失败）
  backoff: BackoffOptions;
  concurrency?: number;                      // 单队列内最大并发处理数（默认 1）
}

export const DefaultQueueOptions: QueueOptions = {
  attempts: 5,
  backoff: { type: 'exponential', base: 200, max: 30_000 },
  concurrency: 1,
};

export interface QueueJobRecord {
  id: string;                                // job_id（保留与 QueueJob.id 一致以复用类型）
  name: string;                              // 队列名
  payload: JSONPayload;
  attempts: number;                          // 已尝试次数（含本次运行时）
  status: QueueJobStatus;
  last_error: string | null;
  next_run_at: string;                       // ISO 时间，下一次处理时刻
  created_at: string;
  event_id: string;                          // 用于 plugin_event_dedupe
}

export interface EnqueueOptions {
  /** 必填：与 plugin_event_dedupe.event_id 对应。重复的 event_id 第二次入队返回 skipped。 */
  eventId: string;
}

export interface QueueHandler {
  (job: QueueJobRecord): Promise<void> | void;
}

export type QueueEventName =
  | 'enqueue'
  | 'process'
  | 'fail'
  | 'final_fail'
  | 'success';

export interface QueueEvent {
  jobId: string;
  attempt: number;
  error?: string;
}
