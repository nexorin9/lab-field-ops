// src/server/routes/alarmCodes.ts
//
// 报警码 REST API：
//   - GET  /api/alarm-codes?vendor=&model=&alarm_code=
//     → 报警码列表（联合主键查询）
//
// 设计取舍：
//   - 联合主键 (vendor, model, alarm_code) 是查询的关键；任一字段可独立过滤。
//   - 默认无过滤时返回所有报警码（量不大；如未来上千条，再加 LIMIT/OFFSET）。
//   - 不分页：报警码总量在真实场景中 < 1000；与 instrument 表规模不同。
//   - join_key 字段在 presenter 层加好，前端可直接用。

import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import {
  presentAlarmCodes,
  type PresentedAlarmCode,
  type AlarmCodeRow,
} from '../presenters/alarmCode.js';
import type { RouteResponse, ApiErrorBody } from './queue.js';

export interface AlarmCodeRouteContext {
  db(): Database;
}

export function defaultAlarmCodeRouteContext(): AlarmCodeRouteContext {
  return { db: () => getDb() };
}

/** GET /api/alarm-codes — 列表（按 vendor/model/alarm_code 过滤） */
export function getAlarmCodesRoute(
  _params: Record<string, string>,
  query: Record<string, string>,
  _body: unknown,
  ctx: AlarmCodeRouteContext = defaultAlarmCodeRouteContext(),
): RouteResponse<{ alarm_codes: PresentedAlarmCode[]; total: number }> {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (query.vendor) {
    filters.push('vendor = ?');
    params.push(query.vendor);
  }
  if (query.model) {
    filters.push('model = ?');
    params.push(query.model);
  }
  if (query.alarm_code) {
    filters.push('alarm_code = ?');
    params.push(query.alarm_code);
  }
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const db = ctx.db();
  const total = (db
    .prepare(`SELECT COUNT(*) AS n FROM alarm_code${where}`)
    .get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM alarm_code${where} ORDER BY vendor, model, alarm_code`)
    .all(...params) as AlarmCodeRow[];
  return {
    status: 200,
    body: { alarm_codes: presentAlarmCodes(rows), total },
  };
}