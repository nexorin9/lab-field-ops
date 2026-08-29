// src/server/queue/register.ts
//
// registerAllTasks()：把 queue/tasks/ 下的两个 task handler 挂到对应队列，
// 与 PluginManager 联动（plugin add 后 PluginManager.getTaskHandlers 自动覆盖默认）。
//
// 调用顺序：
//   1. process 启动时：migrate() → registerAllTasks()
//   2. 信息科 `plugin add lis-writeback`：PluginManager.add 把 handler 注入 entries
//   3. registerAllTasks() 内部 resolveHandler 优先取 PluginManager 注册的，
//      缺则用 queue/tasks/ 默认实现
//
// 设计取舍：
//   - 默认 handler 必须存在（即便信息科没 add plugin，队列也能跑「兜底」逻辑）
//   - 同一进程内 registerAllTasks() 幂等（重复调用不创建重复队列）

import { PluginManager } from '../plugin/manager.js';
import { createQueue, type Queue } from './index.js';
import { LIS_WRITEBACK_QUEUE, lisWritebackHandler } from './tasks/writeback.js';
import {
  IOT_HEARTBEAT_QUEUE,
  iotHeartbeatHandler,
} from './tasks/heartbeat.js';
import type { QueueHandler } from './types.js';

export interface RegisterAllTasksResult {
  writebackQueue: Queue;
  heartbeatQueue: Queue;
}

/** 进程内单例：避免重复 createQueue 导致并发问题。 */
let registered: RegisterAllTasksResult | null = null;

/** 解析 task handler：plugin 注册过的优先；否则用 queue/tasks/ 默认实现。
 *  返回 QueueHandler 形态（接受 QueueJobRecord；handler 内部兼容 payload/job 两种形态）。 */
function resolveWritebackHandler(): QueueHandler {
  const handlers = PluginManager.getTaskHandlers(LIS_WRITEBACK_QUEUE);
  if (handlers.length > 0) {
    return handlers[0] as unknown as QueueHandler;
  }
  return lisWritebackHandler as unknown as QueueHandler;
}

function resolveHeartbeatHandler(): QueueHandler {
  const handlers = PluginManager.getTaskHandlers(IOT_HEARTBEAT_QUEUE);
  if (handlers.length > 0) {
    return handlers[0] as unknown as QueueHandler;
  }
  return iotHeartbeatHandler as unknown as QueueHandler;
}

/**
 * 创建 writeback + heartbeat 队列并启动调度。
 * - 幂等：重复调用返回首次结果
 * - 必须先 migrate()（PluginManager 与 audit_event 依赖 migration_log + 8 张表）
 * - 调用 .run() 启动 setImmediate 调度循环
 */
export function registerAllTasks(): RegisterAllTasksResult {
  if (registered) return registered;

  const writebackQueue = createQueue(LIS_WRITEBACK_QUEUE);
  writebackQueue.process(resolveWritebackHandler());
  writebackQueue.run();

  const heartbeatQueue = createQueue(IOT_HEARTBEAT_QUEUE);
  heartbeatQueue.process(resolveHeartbeatHandler());
  heartbeatQueue.run();

  registered = { writebackQueue, heartbeatQueue };
  return registered;
}

/** 测试/CLI helper：清空单例，让下次 registerAllTasks() 重建。 */
export function __resetTaskRegistration(): void {
  if (registered) {
    registered.writebackQueue.stop();
    registered.heartbeatQueue.stop();
  }
  registered = null;
}

/** 暴露队列名常量（plugin manifest queue_name 用同一个值）。 */
export const QUEUE_NAMES = {
  LIS_WRITEBACK: LIS_WRITEBACK_QUEUE,
  IOT_HEARTBEAT: IOT_HEARTBEAT_QUEUE,
} as const;