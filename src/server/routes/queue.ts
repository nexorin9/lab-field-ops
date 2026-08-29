// src/server/routes/queue.ts
//
// 队列观测 REST API：
//   - GET  /api/queue/status          → 所有已注册队列的状态
//   - GET  /api/queue/:name/jobs      → 某队列的运行时 job 列表
//   - POST /api/queue/retry/:jobId    → 重投 failed job（仅失败状态允许）
//
// 设计取舍：
//   - 不依赖 Express；handler 是纯函数，签名为 (params, query, body, ctx) => response，
//     让 e2e 测试可以直接 await 调用，无需启动 HTTP server。
//   - observer 的 QueueObserverError 已经带 status 字段（404 / 409）；这里 catch 后转成
//     标准错误响应 {error:{code,message}}。
//   - 默认注册的 queue 来自 registerAllTasks() 的 writeback + heartbeat；
//     其它队列（如 PluginManager 注册的 Hook.Task）通过 ctx.allQueues() 注入。

import { registerAllTasks } from '../queue/register.js';
import {
  getQueueJobs,
  getQueueStatus,
  observeQueues,
  retryJob,
  type QueueJobView,
  type QueueStatusRow,
} from '../queue/observer.js';
import type { Queue } from '../queue/index.js';
import {
  type ApiErrorBody as ApiErrorBodyBase,
  apiErrorResponse,
  appErrorToResponse,
  toAppError,
} from '../errors.js';

/** REST 错误响应统一形态（re-export 自 errors.ts 单源，避免散落定义）。 */
export type ApiErrorBody = ApiErrorBodyBase;

/** 路由注入的队列上下文（测试时可传 mock 队列）。 */
export interface QueueRouteContext {
  /** 所有当前已知的队列（含 registerAllTasks 创建 + PluginManager 注册的）。 */
  allQueues(): Queue[];
  /** 每个队列对应的 options.attempts（前端红条判定用）。 */
  maxAttemptsFor(name: string): number;
}

let observerRegistered = false;

/** 默认 ctx：从 registerAllTasks() 拿 writeback + heartbeat，maxAttempts 默认 5。 */
export function defaultQueueRouteContext(): QueueRouteContext {
  const { writebackQueue, heartbeatQueue } = registerAllTasks();
  if (!observerRegistered) {
    observeQueues([writebackQueue, heartbeatQueue]);
    observerRegistered = true;
  }
  const all = [writebackQueue, heartbeatQueue];
  const maxAttemptsMap: Record<string, number> = {
    [writebackQueue.name]: 5,
    [heartbeatQueue.name]: 5,
  };
  return {
    allQueues: () => all,
    maxAttemptsFor: (name) => maxAttemptsMap[name] ?? 5,
  };
}

/** 让测试 / 重置可以解绑 observer + 清空 queue jobs，避免单例泄漏。 */
export function __resetQueueRouteContext(): void {
  if (observerRegistered) {
    // 解绑 observer，并清空默认 ctx 涉及的 queue jobs
    try {
      const { writebackQueue, heartbeatQueue } = registerAllTasks();
      writebackQueue.__clearJobs();
      heartbeatQueue.__clearJobs();
    } catch {
      /* register 还没初始化时忽略 */
    }
  }
  observerRegistered = false;
}

/** 路由 handler 返回类型：HTTP 状态码 + body。 */
export interface RouteResponse<T = unknown> {
  status: number;
  body: T | ApiErrorBody;
}

/** GET /api/queue/status */
export function getQueueStatusRoute(
  _params: Record<string, string>,
  _query: Record<string, string>,
  _body: unknown,
  ctx: QueueRouteContext = defaultQueueRouteContext(),
): RouteResponse<{ queues: QueueStatusRow[] }> {
  const queues = ctx.allQueues();
  const rows = getQueueStatus(
    queues.map((q) => ({ queue: q, maxAttempts: ctx.maxAttemptsFor(q.name) })),
  );
  return { status: 200, body: { queues: rows } };
}

/** GET /api/queue/:name/jobs */
export function getQueueJobsRoute(
  params: Record<string, string>,
  _query: Record<string, string>,
  _body: unknown,
  ctx: QueueRouteContext = defaultQueueRouteContext(),
): RouteResponse<{ queue: string; jobs: QueueJobView[] } | ApiErrorBody> {
  const name = params.name;
  const queue = ctx.allQueues().find((q) => q.name === name);
  if (!queue) {
    return apiErrorResponse('NOT_FOUND', `queue ${name} not found`);
  }
  return { status: 200, body: { queue: name, jobs: getQueueJobs(queue) } };
}

/** POST /api/queue/retry/:jobId */
export function postQueueRetryRoute(
  params: Record<string, string>,
  _query: Record<string, string>,
  _body: unknown,
  ctx: QueueRouteContext = defaultQueueRouteContext(),
): RouteResponse<
  | { jobId: string; queue: string; attemptsReset: number; retriedAt: string }
  | ApiErrorBody
> {
  const jobId = params.jobId;
  try {
    const result = retryJob(ctx.allQueues(), jobId);
    return {
      status: 200,
      body: {
        jobId: result.jobId,
        queue: result.queue,
        attemptsReset: result.attemptsReset,
        retriedAt: result.retriedAt,
      },
    };
  } catch (err: unknown) {
    // 把 QueueObserverError (code='NOT_FOUND'|'CONFLICT') / 其它 Error 安全适配到 AppError
    // 并走 appErrorToResponse → status 与 httpStatus 同源，与契约一致。
    return appErrorToResponse(toAppError(err));
  }
}
