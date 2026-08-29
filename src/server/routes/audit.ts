// src/server/routes/audit.ts
//
// 审计 REST API：
//   - GET  /api/audit?kind=&operatorId=&from=&to=&limit=   → 审计事件列表
//   - GET  /api/audit/:eventId/replay                      → 事件链 replay
//
// 设计取舍：
//   - 用 limit 而不是 page/per_page：审计数据量大，分页 cursor 更复杂；
//     前端用 limit + 游标式向下滚动（"加载更多"）更自然。
//   - limit 上限 1000（与 queryAudit 内部一致）。
//   - kind 支持单值或逗号分隔多值（前端用复选框多选）。
//   - replay 端点（GET /:id/replay）由 Task 23 落地：沿 related_event_id 串联 root +
//     parents + current + children，前端在 AuditDrawer 上钻取用。

import { queryAudit, type QueryAuditFilter } from '../audit/ledger.js';
import { replay } from '../audit/replay.js';
import type { AuditEventKind } from '@shared/types.js';
import {
  presentAuditEvents,
  type PresentedAuditEvent,
} from '../presenters/auditEvent.js';
import type { RouteResponse, ApiErrorBody } from './queue.js';
import type { ReplayResult } from '../audit/replay.js';
import { apiErrorResponse } from '../errors.js';

/** AuditEventKind 联合类型的所有可能值（与 src/shared/types.ts 保持一致）。 */
const VALID_KINDS: ReadonlySet<string> = new Set([
  'plugin.add',
  'plugin.remove',
  'plugin.uninstall',
  'queue.enqueue',
  'queue.process',
  'queue.fail',
  'queue.final_fail',
  'queue.retry',
  'writeback.initiated',
  'writeback.success',
  'processing_record.created',
  'processing_record.state_change',
  'processing_record.retry',
  'heartbeat.dropped',
  'heartbeat.received',
  'instrument.seen',
]);

/** 解析 comma-separated kinds 为合法 AuditEventKind 数组；保留 queryAudit 的宽容度。 */
function parseKinds(raw: string | undefined): AuditEventKind[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // 不在白名单的 kind 直接丢弃（fail-soft），避免 ?kind=foo 全部结果空集的迷惑
  const valid = items.filter((k) => VALID_KINDS.has(k)) as AuditEventKind[];
  return valid.length ? valid : undefined;
}

/** GET /api/audit — 列表 */
export function getAuditRoute(
  _params: Record<string, string>,
  query: Record<string, string>,
  _body: unknown,
): RouteResponse<{ events: PresentedAuditEvent[]; total: number; limit: number }> {
  const filter: QueryAuditFilter = {};
  const kinds = parseKinds(query.kind);
  if (kinds) filter.kind = kinds;
  if (query.operatorId) filter.operatorId = query.operatorId;
  if (query.from) filter.from = query.from;
  if (query.to) filter.to = query.to;
  if (query.limit) {
    const n = Number.parseInt(query.limit, 10);
    if (Number.isFinite(n) && n >= 1) filter.limit = Math.min(n, 1000);
  }
  const rows = queryAudit(filter);
  return {
    status: 200,
    body: {
      events: presentAuditEvents(rows),
      total: rows.length,
      limit: filter.limit ?? 100,
    },
  };
}

/**
 * GET /api/audit/:eventId/replay — 沿 related_event_id 串联事件链
 *
 * 路径参数：eventId = 当前查询的事件 ID（必填）
 * 响应 200：{ root, current, parents, children, chain }
 * 响应 400：{ error: VALIDATION_ERROR }（eventId 缺失）
 * 响应 404：{ error: NOT_FOUND }（eventId 不存在）
 *
 * 设计要点：
 *   - handler 是纯函数（与 queue.ts 同形）；测试可直接 await
 *   - 业务侧写 related_event_id 已涵盖：plugin.add/remove/uninstall、queue.*、writeback.*、
 *     processing_record.state_change、processing_record.retry、queue.retry
 *   - 该端点供 AuditDrawer 钻取使用（Task 23 AuditDrawer 改造）
 */
export function getAuditReplayRoute(
  params: Record<string, string>,
  _query: Record<string, string>,
  _body: unknown,
): RouteResponse<ReplayResult | ApiErrorBody> {
  const eventId = params.eventId;
  if (!eventId) {
    return apiErrorResponse('VALIDATION_ERROR', 'eventId is required');
  }
  const result = replay(eventId);
  if (!result) {
    return apiErrorResponse('NOT_FOUND', `audit_event ${eventId} not found`);
  }
  return { status: 200, body: result };
}
