// src/server/plugin/dispatcher.ts
// Plugin 钩子派发器：按 hook type 把 plugin 的实现派发到对应子系统。
//
// 形态借鉴 outline/plugins/github/server/index.ts 的 PluginManager.add：
//   [{type: Hook.API, value: router}, {type: Hook.Task, value: GitHubWebhookTask}, ...]
// 本项目差异：每个 plugin 单 manifest 注册（一份 manifest 一个 plugin）；
// 派发器负责把 impl 中的 handlers 注册到对应子系统注册表，并提供反向注销。
//
// 派发目标：
//   Hook.API           → apiRouterRegistry（按 plugin.name + path）
//   Hook.Task          → taskQueueRegistry（按 queue_name）
//   Hook.UnfurlProvider→ unfurlRegistry（按 plugin.name）
//   Hook.Uninstall     → uninstallRegistry（按 plugin.name）
//
// 反向注销（unregister）：
//   卸载 plugin 时调用，按 plugin.name / queue_name 反查并移除注册项。
//   已注销的 plugin 二次 unregister 幂等（不抛错）。

import type {
  ApiRouter,
  TaskHandler,
  UnfurlProvider,
  UninstallHandler,
} from './hooks.js';
import type { PluginManifestInput } from './types.js';

/** API router 注册项：plugin 名 + 路径前缀 + router 实例。 */
interface ApiRouterEntry {
  pluginName: string;
  path: string;
  router: ApiRouter;
}

/** 队列 handler 注册项：queue 名 + handler 实例。 */
interface TaskHandlerEntry {
  pluginName: string;
  queueName: string;
  handler: TaskHandler;
}

/** Unfurl provider 注册项。 */
interface UnfurlEntry {
  pluginName: string;
  provider: UnfurlProvider;
}

/** Uninstall handler 注册项。 */
interface UninstallEntry {
  pluginName: string;
  handler: UninstallHandler;
}

/** 派发器对外可见的注册表只读视图（snapshot）。 */
export interface DispatcherSnapshot {
  apiRouters: ReadonlyArray<ApiRouterEntry>;
  taskHandlers: ReadonlyArray<TaskHandlerEntry>;
  unfurlProviders: ReadonlyArray<UnfurlEntry>;
  uninstallHandlers: ReadonlyArray<UninstallEntry>;
}

/** 派发器实现。 */
class DispatcherImpl {
  private apiRouters: ApiRouterEntry[] = [];
  private taskHandlers: TaskHandlerEntry[] = [];
  private unfurlProviders: UnfurlEntry[] = [];
  private uninstallHandlers: UninstallEntry[] = [];

  /**
   * 把 plugin 的 impl 按 hooks[] 类型分别派发到对应注册表。
   * 同一 plugin 多次 dispatch 视为累加（PluginManager.add 已经禁止同名 plugin）。
   *
   * @returns 派发条目计数（用于 audit 与测试断言）
   */
  dispatch(
    manifest: PluginManifestInput,
    impl: {
      api?: ApiRouter | ApiRouter[];
      task?: TaskHandler | TaskHandler[];
      unfurl?: UnfurlProvider | UnfurlProvider[];
      uninstall?: UninstallHandler | UninstallHandler[];
    },
  ): {
    apiCount: number;
    taskCount: number;
    unfurlCount: number;
    uninstallCount: number;
  } {
    let apiCount = 0;
    let taskCount = 0;
    let unfurlCount = 0;
    let uninstallCount = 0;

    if (impl.api) {
      const routers = Array.isArray(impl.api) ? impl.api : [impl.api];
      for (const router of routers) {
        const hookSpec = manifest.hooks.find((h) => h.type === 'api');
        const path = hookSpec?.path ?? '/';
        this.apiRouters.push({
          pluginName: manifest.name,
          path,
          router,
        });
        apiCount++;
      }
    }

    if (impl.task) {
      const handlers = Array.isArray(impl.task) ? impl.task : [impl.task];
      const queueName = manifest.queue_name ?? '';
      for (const handler of handlers) {
        this.taskHandlers.push({
          pluginName: manifest.name,
          queueName,
          handler,
        });
        taskCount++;
      }
    }

    if (impl.unfurl) {
      const providers = Array.isArray(impl.unfurl) ? impl.unfurl : [impl.unfurl];
      for (const provider of providers) {
        this.unfurlProviders.push({
          pluginName: manifest.name,
          provider,
        });
        unfurlCount++;
      }
    }

    if (impl.uninstall) {
      const handlers = Array.isArray(impl.uninstall)
        ? impl.uninstall
        : [impl.uninstall];
      for (const handler of handlers) {
        this.uninstallHandlers.push({
          pluginName: manifest.name,
          handler,
        });
        uninstallCount++;
      }
    }

    return { apiCount, taskCount, unfurlCount, uninstallCount };
  }

  /**
   * 反向注销：按 plugin 名移除全部已派发条目。
   * 二次 unregister 幂等（返回的 count 全部为 0，不抛错）。
   *
   * @returns 各注册表被移除的条目计数
   */
  unregister(pluginName: string): {
    apiRemoved: number;
    taskRemoved: number;
    unfurlRemoved: number;
    uninstallRemoved: number;
  } {
    const apiBefore = this.apiRouters.length;
    this.apiRouters = this.apiRouters.filter((e) => e.pluginName !== pluginName);
    const apiRemoved = apiBefore - this.apiRouters.length;

    const taskBefore = this.taskHandlers.length;
    this.taskHandlers = this.taskHandlers.filter(
      (e) => e.pluginName !== pluginName,
    );
    const taskRemoved = taskBefore - this.taskHandlers.length;

    const unfurlBefore = this.unfurlProviders.length;
    this.unfurlProviders = this.unfurlProviders.filter(
      (e) => e.pluginName !== pluginName,
    );
    const unfurlRemoved = unfurlBefore - this.unfurlProviders.length;

    const uninstallBefore = this.uninstallHandlers.length;
    this.uninstallHandlers = this.uninstallHandlers.filter(
      (e) => e.pluginName !== pluginName,
    );
    const uninstallRemoved = uninstallBefore - this.uninstallHandlers.length;

    return { apiRemoved, taskRemoved, unfurlRemoved, uninstallRemoved };
  }

  /** 触发某 plugin 的全部 uninstall handler（同步执行）。 */
  triggerUninstall(pluginName: string): {
    triggered: number;
    errors: string[];
  } {
    const entries = this.uninstallHandlers.filter(
      (e) => e.pluginName === pluginName,
    );
    let triggered = 0;
    const errors: string[] = [];
    for (const entry of entries) {
      try {
        const result = entry.handler();
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          // fire-and-forget；错误由调用方通过 console 抓
          (result as Promise<unknown>).catch((err) => {
            errors.push(err instanceof Error ? err.message : String(err));
          });
        }
        triggered++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    return { triggered, errors };
  }

  /** 只读 snapshot（用于测试与 audit）。 */
  snapshot(): DispatcherSnapshot {
    return {
      apiRouters: [...this.apiRouters],
      taskHandlers: [...this.taskHandlers],
      unfurlProviders: [...this.unfurlProviders],
      uninstallHandlers: [...this.uninstallHandlers],
    };
  }

  /** 测试/CLI 重置：清空全部注册表。 */
  reset(): void {
    this.apiRouters = [];
    this.taskHandlers = [];
    this.unfurlProviders = [];
    this.uninstallHandlers = [];
  }

  /** 查询某 plugin 派发的 api routers（路由查询）。 */
  getApiRoutersForPlugin(pluginName: string): ApiRouterEntry[] {
    return this.apiRouters.filter((e) => e.pluginName === pluginName);
  }

  /** 查询某 plugin 派发的 task handlers（队列消费查询）。 */
  getTaskHandlersForPlugin(pluginName: string): TaskHandlerEntry[] {
    return this.taskHandlers.filter((e) => e.pluginName === pluginName);
  }
}

/** 单例导出。 */
export const Dispatcher = new DispatcherImpl();