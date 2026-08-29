// src/server/presenters/auditEvent.ts
//
// presentAuditEvent 把 audit_event 表的 DB row 转成公开形态。
//
// 关键约束：
//   - payload_json 解析为对象；前端按字段展示。
//   - req_hash / resp_hash 是 SHA-256 hex；保留原值，前端做去重或串联用。
//   - related_event_id 用于 Task 23 的 replay 链路串联；为 null 时表示根事件。

import type { AuditEvent, JSONPayload } from '@shared/types.js';

export interface AuditEventRow {
  event_id: string;
  kind: string;
  req_hash: string | null;
  resp_hash: string | null;
  operator_id: string | null;
  payload_json: string;
  ts: string;
  related_event_id: string | null;
}

export interface PresentedAuditEvent {
  event_id: string;
  kind: AuditEvent['kind'];
  req_hash: string | null;
  resp_hash: string | null;
  operator_id: string | null;
  payload: JSONPayload;
  ts: string;
  related_event_id: string | null;
}

/** 安全解析 JSON 对象；失败回退空对象（audit 数据完整性优先，丢 payload 不阻断 UI）。 */
function safeParseJsonObject(text: string): JSONPayload {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JSONPayload;
    }
    return {};
  } catch {
    return {};
  }
}

/** 把 DB row 转为公开形态。 */
export function presentAuditEvent(row: AuditEventRow): PresentedAuditEvent {
  return {
    event_id: row.event_id,
    kind: row.kind as AuditEvent['kind'],
    req_hash: row.req_hash,
    resp_hash: row.resp_hash,
    operator_id: row.operator_id,
    payload: safeParseJsonObject(row.payload_json),
    ts: row.ts,
    related_event_id: row.related_event_id,
  };
}

/** 把一组 rows 全部扁平化。 */
export function presentAuditEvents(rows: AuditEventRow[]): PresentedAuditEvent[] {
  return rows.map(presentAuditEvent);
}