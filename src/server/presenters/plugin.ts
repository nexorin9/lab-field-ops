// src/server/presenters/plugin.ts
//
// presentPlugin 把 PluginEntry（PluginManager 的内存形态）转成公开的 REST 形态。
//
// 关键约束：
//   - 内存形态的 hooks 数组（含 PluginHookSpec）原样输出。
//   - auth 字段是 JSON 字符串（plugin_manifest.auth_json）或 null；present 时 parse。
//   - installedAt 是 PluginEntry 的字段名，公开形态统一为 installed_at（与 SQL 列对齐）。
//   - listeningPath 是声明式占位（Hook.API→路径前缀 / Hook.Task→队列名），
//     来自 src/cli/plugin.ts 的 computeListeningPath；本 presenter 复算一次以免
//     PluginEntry 形态依赖 CLI 内部 helper。

import type { PluginHookType, PluginHookSpec, PluginAuth } from '@shared/types.js';
import type { PluginEntry } from '../plugin/types.js';

export interface PresentedPlugin {
  name: string;
  version: string;
  type: PluginHookType;
  hooks: PluginHookSpec[];
  queue_name: string | null;
  auth: PluginAuth | null;
  rate_limit: number | null;
  installed_at: string;
  /** 监听路径占位（API→路由前缀 / Task→队列名 / Unfurl→registry key）。 */
  listening_path: string;
}

/** 计算 listening_path —— 与 src/cli/plugin.ts 保持一致。 */
export function computeListeningPath(entry: PluginEntry): string {
  const m = entry.manifest;
  // primary hook.type 决定 listening_path 形态
  if (m.type === 'api') {
    const apiHook = m.hooks.find((h: PluginHookSpec) => h.type === 'api');
    return apiHook?.path ?? `/api/plugins/${m.name}`;
  }
  if (m.type === 'task') {
    return m.queue_name ? `queue:${m.queue_name}` : `queue:${m.name}`;
  }
  if (m.type === 'unfurl') {
    return `unfurl-registry:${m.name}`;
  }
  // uninstall / 其它
  return `/api/plugins/${m.name}`;
}

/** 把 PluginEntry 转为公开形态。 */
export function presentPlugin(entry: PluginEntry): PresentedPlugin {
  const m = entry.manifest;
  return {
    name: m.name,
    version: m.version,
    type: m.type,
    hooks: m.hooks,
    queue_name: m.queue_name,
    auth: m.auth,
    rate_limit: m.rate_limit,
    installed_at: entry.installedAt,
    listening_path: computeListeningPath(entry),
  };
}

/** 把一组 entries 全部扁平化。 */
export function presentPlugins(entries: PluginEntry[]): PresentedPlugin[] {
  return entries.map(presentPlugin);
}