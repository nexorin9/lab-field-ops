// src/server/routes/plugins.ts
//
// Plugin REST API（只读 / 卸载）：
//   - GET    /api/plugins                → 已注册 plugin 列表
//   - DELETE /api/plugins/:name          → 卸载一个 plugin（幂等）
//
// 设计取舍：
//   - 注册（POST）走 CLI（src/cli/plugin.ts），不进 REST API（信息科 CLI 更直观）。
//   - 列表与队列观测联动：每条 plugin 带 listening_path，前端看板可展示队列来源。
//   - DELETE 走 PluginManager.remove；已卸载返 200（幂等）。

import { PluginManager } from '../plugin/manager.js';
import {
  presentPlugins,
  type PresentedPlugin,
} from '../presenters/plugin.js';
import type { RouteResponse, ApiErrorBody } from './queue.js';
import { apiErrorResponse } from '../errors.js';

/** GET /api/plugins — 列表 */
export function getPluginsRoute(
  _params: Record<string, string>,
  _query: Record<string, string>,
  _body: unknown,
): RouteResponse<{ plugins: PresentedPlugin[]; total: number }> {
  const entries = PluginManager.list();
  return {
    status: 200,
    body: {
      plugins: presentPlugins(entries),
      total: entries.length,
    },
  };
}

/** DELETE /api/plugins/:name — 卸载（幂等） */
export function deletePluginRoute(
  params: Record<string, string>,
  _query: Record<string, string>,
  _body: unknown,
): RouteResponse<{ name: string; uninstall_triggered: boolean; already_removed: boolean } | ApiErrorBody> {
  const name = params.name;
  if (!name) {
    return apiErrorResponse('VALIDATION_ERROR', 'plugin name is required');
  }
  const result = PluginManager.remove(name);
  return {
    status: 200,
    body: {
      name,
      uninstall_triggered: result.uninstallTriggered ?? false,
      already_removed: result.alreadyRemoved ?? false,
    },
  };
}