// src/server/plugin/hooks.ts
// Hook 枚举 + handler 签名。
// 与 src/shared/types.ts 的 PluginHookType 保持一致（contract v1）。
//
// 形态借鉴 outline/plugins/github/server/index.ts：
//   PluginManager.add([{ type: Hook.API, value: router }, ...])
// 本项目每个 plugin 单 manifest 注册（lab-field-ops CLI 信息科入口更直观），
// 故 add 接收单一 entry；但 hooks[] 数组允许一个 plugin 声明多种 hook 形态。

import type { JSONPayload } from '@shared/types.js';

/** Hook 类型：4 种扩展点。 */
export type HookType = 'api' | 'task' | 'unfurl' | 'uninstall';

export const Hook = {
  API: 'api' as const,
  Task: 'task' as const,
  UnfurlProvider: 'unfurl' as const,
  Uninstall: 'uninstall' as const,
};

/** 所有合法 hook 类型白名单（顺序固定，uninstall 在最末）。 */
export const ALL_HOOKS: readonly HookType[] = ['api', 'task', 'unfurl', 'uninstall'];

/** Hook.API 形态：Express router 风格的对象（{METHOD: handler}）。 */
export interface ApiRouter {
  [method: string]: (req: unknown, res: unknown) => unknown;
}

/** Hook.Task 形态：异步 handler，处理队列 payload。 */
export type TaskHandler = (payload: JSONPayload) => Promise<void>;

/** Hook.UnfurlProvider 形态：URL → 卡片数据；带缓存时间。 */
export interface UnfurlProvider {
  unfurl: (url: string) => Promise<JSONPayload>;
  cacheExpiry?: number; // 秒；0 表示不缓存
}

/** Hook.Uninstall 形态：卸载时清理钩子（关闭连接、释放文件句柄等）。 */
export type UninstallHandler = () => Promise<void> | void;

/** Handler 按 hook 类型归类；PluginManager.add 时由 impl 参数传入。 */
export interface PluginImpl {
  api?: ApiRouter | ApiRouter[];
  task?: TaskHandler | TaskHandler[];
  unfurl?: UnfurlProvider | UnfurlProvider[];
  uninstall?: UninstallHandler | UninstallHandler[];
}

/** 单个 hook 注册项：type + 业务侧补充字段。 */
export interface HookRegistration {
  type: HookType;
  path?: string; // Hook.API 路径前缀
  queue_name?: string; // Hook.Task 队列名
}
