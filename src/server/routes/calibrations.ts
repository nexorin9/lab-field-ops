// src/server/routes/calibrations.ts
//
// 校准 REST API：
//   - GET  /api/calibrations?instrumentId=&from=&to=
//     → 校准记录列表（按 calibrated_at DESC）
//
// 设计取舍：
//   - 仅 GET 列表；详情端点不展开（calibration 字段少，详情与列表等价）。
//   - 时间窗口过滤：from / to 是 ISO 字符串，按 calibrated_at 比较。
//   - 分页：page / per_page，默认 page=1 per_page=50 上限 200。
//   - 不返回关联 instrument 信息（前端用 instrument_id 反查 instruments 端点）。

import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import {
  presentCalibrations,
  type PresentedCalibration,
  type CalibrationRow,
} from '../presenters/calibration.js';
import { parsePageParams } from './instruments.js';
import type { RouteResponse, ApiErrorBody } from './queue.js';

export interface CalibrationRouteContext {
  db(): Database;
}

export function defaultCalibrationRouteContext(): CalibrationRouteContext {
  return { db: () => getDb() };
}

/** GET /api/calibrations — 列表 */
export function getCalibrationsRoute(
  _params: Record<string, string>,
  query: Record<string, string>,
  _body: unknown,
  ctx: CalibrationRouteContext = defaultCalibrationRouteContext(),
): RouteResponse<{ calibrations: PresentedCalibration[]; page: number; per_page: number; total: number }> {
  const pageInfo = parsePageParams(query);
  if ('error' in pageInfo) {
    return { status: 400, body: pageInfo };
  }
  const filters: string[] = [];
  const params: unknown[] = [];
  if (query.instrumentId) {
    filters.push('instrument_id = ?');
    params.push(query.instrumentId);
  }
  if (query.from) {
    filters.push('calibrated_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    filters.push('calibrated_at <= ?');
    params.push(query.to);
  }
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const db = ctx.db();
  const total = (db
    .prepare(`SELECT COUNT(*) AS n FROM calibration${where}`)
    .get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT * FROM calibration${where}
       ORDER BY calibrated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageInfo.per_page, pageInfo.offset) as CalibrationRow[];
  return {
    status: 200,
    body: {
      calibrations: presentCalibrations(rows),
      page: pageInfo.page,
      per_page: pageInfo.per_page,
      total,
    },
  };
}