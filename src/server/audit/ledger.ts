// src/server/audit/ledger.ts
// Append-only audit log：appendAudit + queryAudit。
//
// 这是 Task 8 的最小版本——plugin 注册/卸载需要写 audit_event。
// Task 14 会扩展为：audit/sources.ts（多来源统一接入）+ audit/replay.ts（事件链串联）。
// 当前实现满足 plugin.add / plugin.remove / queue.enqueue 等事件的落盘需要。

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { getDb } from '../db.js';
import type {
  AuditEvent,
  AuditEventKind,
  HashString,
  ISODateString,
  JSONPayload,
} from '@shared/types.js';

/** appendAudit 入参。 */
export interface AppendAuditInput {
  kind: AuditEventKind;
  /** 请求体序列化（用于 req_hash）。 */
  req?: unknown;
  /** 响应体序列化（用于 resp_hash）。 */
  resp?: unknown;
  /** 操作员（CLI 时为 null；REST 时来自 auth header）。 */
  operatorId?: string | null;
  /** 业务侧自由 payload。 */
  payload?: JSONPayload;
  /** 关联事件 id（事件链串联，Task 23 replay 用）。 */
  relatedEventId?: string | null;
}

export interface AppendAuditResult {
  eventId: string;
  ts: ISODateString;
}

/** SHA-256 hex；保持输入确定性序列化。 */
export function sha256Hex(input: string): HashString {
  return createHash('sha256').update(input).digest('hex');
}

/** 标准化 JSON 字符串（key 排序）—— 保证 hash 稳定性。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}

/** 计算请求/响应 hash；缺失则返回 null。 */
function computeHash(value: unknown): HashString | null {
  if (value === undefined) return null;
  return sha256Hex(canonicalize(value));
}

/**
 * 写入一条 audit_event。
 * 表上的 trigger (audit_event_no_update / audit_event_no_delete) 会阻止后续修改。
 */
export function appendAudit(input: AppendAuditInput): AppendAuditResult {
  const db = getDb();
  const eventId = randomUUID();
  const ts = new Date().toISOString();
  const reqHash = computeHash(input.req);
  const respHash = computeHash(input.resp);
  const operatorId = input.operatorId ?? null;
  const payloadJson = JSON.stringify(input.payload ?? {});
  const relatedEventId = input.relatedEventId ?? null;

  db.prepare(
    `INSERT INTO audit_event
       (event_id, kind, req_hash, resp_hash, operator_id, payload_json, ts, related_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId, input.kind, reqHash, respHash, operatorId, payloadJson, ts, relatedEventId);

  return { eventId, ts };
}

/** queryAudit 过滤参数。 */
export interface QueryAuditFilter {
  kind?: AuditEventKind | AuditEventKind[];
  operatorId?: string;
  from?: ISODateString;
  to?: ISODateString;
  limit?: number;
  /** 默认 false；true 时按 ts ASC。 */
  ascending?: boolean;
}

/** queryAudit 返回单行形态。 */
export interface AuditRow {
  event_id: string;
  kind: string;
  req_hash: string | null;
  resp_hash: string | null;
  operator_id: string | null;
  payload_json: string;
  ts: string;
  related_event_id: string | null;
}

/** 按过滤条件查询 audit_event；返回 AuditRow[]。 */
export function queryAudit(filter: QueryAuditFilter = {}): AuditRow[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.kind) {
    if (Array.isArray(filter.kind)) {
      where.push(`kind IN (${filter.kind.map(() => '?').join(',')})`);
      params.push(...filter.kind);
    } else {
      where.push('kind = ?');
      params.push(filter.kind);
    }
  }
  if (filter.operatorId) {
    where.push('operator_id = ?');
    params.push(filter.operatorId);
  }
  if (filter.from) {
    where.push('ts >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('ts <= ?');
    params.push(filter.to);
  }

  const order = filter.ascending ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
  const sql = `SELECT * FROM audit_event${
    where.length ? ' WHERE ' + where.join(' AND ') : ''
  } ORDER BY ts ${order} LIMIT ${limit}`;

  return db.prepare(sql).all(...params) as AuditRow[];
}

/** 把 AuditRow 转为 AuditEvent 公开形态。 */
export function toAuditEvent(row: AuditRow): AuditEvent {
  let parsed: JSONPayload = {};
  if (row.payload_json) {
    try {
      parsed = JSON.parse(row.payload_json) as JSONPayload;
    } catch {
      // 损坏 JSON 时保留原文到 _raw 字段；主字段给空对象（fail-soft）
      parsed = { _raw: row.payload_json } as JSONPayload;
    }
  }
  return {
    event_id: row.event_id,
    kind: row.kind as AuditEventKind,
    req_hash: row.req_hash,
    resp_hash: row.resp_hash,
    operator_id: row.operator_id,
    payload_json: parsed,
    ts: row.ts,
    related_event_id: row.related_event_id,
  };
}

/** 暴露给后续 Task 14 / Task 21 的 helper：单测场景下替换 db。 */
export function withDb<T>(fn: (db: Database) => T): T {
  return fn(getDb());
}

/**
 * 统计满足条件的 audit_event 行数。
 * 与 queryAudit 共用过滤参数；null filter = 全表计数。
 * 用于测试「appendAudit 落盘后行数+1」「append-only 阻止 DELETE」等场景。
 */
export function countAudit(filter: QueryAuditFilter = {}): number {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) {
    if (Array.isArray(filter.kind)) {
      where.push(`kind IN (${filter.kind.map(() => '?').join(',')})`);
      params.push(...filter.kind);
    } else {
      where.push('kind = ?');
      params.push(filter.kind);
    }
  }
  if (filter.operatorId) {
    where.push('operator_id = ?');
    params.push(filter.operatorId);
  }
  if (filter.from) where.push('ts >= ?'), params.push(filter.from);
  if (filter.to) where.push('ts <= ?'), params.push(filter.to);
  const sql = `SELECT COUNT(*) AS n FROM audit_event${
    where.length ? ' WHERE ' + where.join(' AND ') : ''
  }`;
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

/**
 * 直接读 db（绕过 queryAudit）做更新/删除；append-only 触发器会抛错。
 * 测试场景：调用此函数应抛 SqliteError / Error 含 'append-only' 字样。
 */
export function rawUpdateAudit(eventId: string, fields: { operator_id?: string }): void {
  const db = getDb();
  db.prepare('UPDATE audit_event SET operator_id = ? WHERE event_id = ?').run(
    fields.operator_id ?? null,
    eventId,
  );
}

export function rawDeleteAudit(eventId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM audit_event WHERE event_id = ?').run(eventId);
}
