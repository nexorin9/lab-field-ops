// src/server/routes/instruments.ts
//
// 仪器 REST API：
//   - GET  /api/instruments              → 列表（按 vendor/model 过滤 + 分页）
//   - GET  /api/instruments/:id          → 单台详情
//
// 设计取舍：
//   - 与 src/server/routes/queue.ts 同形：handler 是纯函数 (params, query, body, ctx)
//     → response；不依赖 Express。e2e 测试可直接 await 调用，无需启 HTTP server。
//   - DB 调用通过 ctx.db 注入（默认走 getDb()），方便测试替身。
//   - 分页参数 page / per_page：默认 page=1, per_page=50，上限 200。
//   - 不返回 audit 关联信息（list 端点）；详情端点不展开 calibration 列表
//     （calibrations 走独立端点，避免一次返回过大）。
//
// 这与 src/server/presenters/contracts.ts 的 contract v1 字段对齐（Task 24）。

import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import {
  presentInstrument,
  presentInstruments,
  type PresentedInstrument,
  type InstrumentRow,
} from '../presenters/instrument.js';
import type { RouteResponse, ApiErrorBody } from './queue.js';
import { apiErrorResponse } from '../errors.js';

/** 路由注入的依赖（测试时可传 mock）。 */
export interface InstrumentRouteContext {
  db(): Database;
}

/** 默认 ctx：直接拿全局 db 单例。 */
export function defaultInstrumentRouteContext(): InstrumentRouteContext {
  return { db: () => getDb() };
}

/** 分页参数标准化。 */
export interface PageParams {
  page: number;
  per_page: number;
  offset: number;
}

/** 解析 + 校验分页参数；返回标准化结果或错误。 */
export function parsePageParams(query: Record<string, string>): PageParams | ApiErrorBody {
  const rawPage = Number.parseInt(query.page ?? '1', 10);
  const rawPer = Number.parseInt(query.per_page ?? '50', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const perRaw = Number.isFinite(rawPer) && rawPer >= 1 ? rawPer : 50;
  const per_page = Math.min(perRaw, 200);
  const offset = (page - 1) * per_page;
  return { page, per_page, offset };
}

/** GET /api/instruments — 列表 */
export function getInstrumentsRoute(
  _params: Record<string, string>,
  query: Record<string, string>,
  _body: unknown,
  ctx: InstrumentRouteContext = defaultInstrumentRouteContext(),
): RouteResponse<{ instruments: PresentedInstrument[]; page: number; per_page: number; total: number }> {
  const pageInfo = parsePageParams(query);
  if ('error' in pageInfo) {
    return { status: 400, body: pageInfo };
  }
  const db = ctx.db();
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
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const total = (db
    .prepare(`SELECT COUNT(*) AS n FROM instrument${where}`)
    .get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT * FROM instrument${where}
       ORDER BY instrument_id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageInfo.per_page, pageInfo.offset) as InstrumentRow[];
  return {
    status: 200,
    body: {
      instruments: presentInstruments(rows),
      page: pageInfo.page,
      per_page: pageInfo.per_page,
      total,
    },
  };
}

/** GET /api/instruments/:id — 详情 */
export function getInstrumentByIdRoute(
  params: Record<string, string>,
  _query: Record<string, string>,
  _body: unknown,
  ctx: InstrumentRouteContext = defaultInstrumentRouteContext(),
): RouteResponse<PresentedInstrument | ApiErrorBody> {
  const id = params.id;
  if (!id) {
    return apiErrorResponse('VALIDATION_ERROR', 'instrument id is required');
  }
  const row = ctx
    .db()
    .prepare('SELECT * FROM instrument WHERE instrument_id = ?')
    .get(id) as InstrumentRow | undefined;
  if (!row) {
    return apiErrorResponse('NOT_FOUND', `instrument ${id} not found`);
  }
  return { status: 200, body: presentInstrument(row) };
}