// src/server/audit/replay.ts
//
// Audit event chain replay（Task 23）。
//
// 设计目的：
//   - audit_event 表通过 `related_event_id` 形成单向链表（业务侧写入时串联）：
//       plugin.add ─┐
//                   ├─▶ queue.enqueue ─▶ queue.process ─▶ processing_record.state_change ─▶ writeback.success
//                   └─▶ plugin.remove
//   - 信息科 / 设备科长 看到「queue.final_fail」时，需要追溯这次失败由哪次 plugin 注册
//     触发、由哪条 processing_record 状态变化引起。
//   - replay() 沿 related_event_id 双向串联：
//       * parents：向 root 方向走（按 related_event_id 链）
//       * children：反向查「以本 event_id 为 related_event_id 的所有事件」
//       * root：parents 链最末端（related_event_id 为 null 的事件）
//
// 不引入新表 / 新字段；完全基于现有 related_event_id。
//
// 调用约定：
//   replay(eventId) → { root, current, parents, children, chain }
//     - root: 链最末端祖先的 event_id；current 没有 parent 时等于 current.event_id
//     - parents: 从 root 到 current（不含 root）的祖先 event_id 列表（按时间正序）
//     - children: current 的所有反向引用事件（按时间正序）
//     - chain: root..current + children 合并后的扁平数组，按 ts 升序
//
// 与 routes/audit.ts 的 GET /api/audit/:eventId/replay 端点联动。

import { getDb } from '../db.js';
import { presentAuditEvent, type PresentedAuditEvent } from '../presenters/auditEvent.js';

/** replay() 返回形态。 */
export interface ReplayResult {
  /** 链最末端祖先（related_event_id 为 null 的事件）的 event_id。 */
  root: string;
  /** 当前查询的事件。 */
  current: PresentedAuditEvent;
  /** 祖先事件列表（从 root 到 current 的上一级，不含 current；时间正序）。 */
  parents: PresentedAuditEvent[];
  /** 反向引用事件列表（以 current.event_id 为 related_event_id 的事件；时间正序）。 */
  children: PresentedAuditEvent[];
  /** root + parents + current + children 的扁平合并 + ts 升序；供前端一屏渲染用。 */
  chain: PresentedAuditEvent[];
}

/** 防御性深度上限：防止 related_event_id 循环引用导致死循环。 */
const MAX_REPLAY_DEPTH = 200;

/**
 * 读取 audit_event DB row（不走 presenter，避免在内部循环中重复 JSON.parse）。 */
function readRawRow(eventId: string): {
  event_id: string;
  kind: string;
  req_hash: string | null;
  resp_hash: string | null;
  operator_id: string | null;
  payload_json: string;
  ts: string;
  related_event_id: string | null;
} | undefined {
  const db = getDb();
  return db
    .prepare('SELECT * FROM audit_event WHERE event_id = ?')
    .get(eventId) as
    | {
        event_id: string;
        kind: string;
        req_hash: string | null;
        resp_hash: string | null;
        operator_id: string | null;
        payload_json: string;
        ts: string;
        related_event_id: string | null;
      }
    | undefined;
}

/** 按 related_event_id 反向查 children 列表（ts 升序）。 */
function readChildren(currentId: string): PresentedAuditEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM audit_event WHERE related_event_id = ? ORDER BY ts ASC, event_id ASC`,
    )
    .all(currentId) as Array<{
    event_id: string;
    kind: string;
    req_hash: string | null;
    resp_hash: string | null;
    operator_id: string | null;
    payload_json: string;
    ts: string;
    related_event_id: string | null;
  }>;
  return rows.map(presentAuditEvent);
}

/**
 * 沿 related_event_id 链向上找 root + parents。
 * 防御性：循环引用时（a→b→a）最多走 MAX_REPLAY_DEPTH 步即停。
 */
function readAncestors(
  currentId: string,
  currentRow: { related_event_id: string | null },
): { root: string; parents: PresentedAuditEvent[] } {
  const visited = new Set<string>([currentId]);
  const ancestors: PresentedAuditEvent[] = [];
  let cursor: string | null = currentRow.related_event_id;
  while (cursor && !visited.has(cursor) && ancestors.length < MAX_REPLAY_DEPTH) {
    const row = readRawRow(cursor);
    if (!row) break;
    visited.add(row.event_id);
    ancestors.unshift(presentAuditEvent(row)); // 沿链向上，反向插入以保持「root..current.parent」顺序
    cursor = row.related_event_id;
  }
  const root = ancestors.length > 0 ? ancestors[0].event_id : currentId;
  return { root, parents: ancestors };
}

/**
 * 沿 related_event_id 链构造事件链。
 *   - 找不到 current：返回 undefined（route 转 404）
 *   - current 是 isolated 单点（无 parent、无 child）：返回 root=current.event_id，parents=[]，children=[]
 */
export function replay(eventId: string): ReplayResult | undefined {
  const currentRow = readRawRow(eventId);
  if (!currentRow) return undefined;
  const current = presentAuditEvent(currentRow);
  const { root, parents } = readAncestors(eventId, currentRow);
  const children = readChildren(eventId);
  const chain = [...parents, current, ...children].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    // ts 相同时按 event_id 字典序稳定排序（避免 React key 抖动）
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  return { root, current, parents, children, chain };
}
