// src/server/presenters/instrument.ts
//
// presentInstrument 把 instrument 表的 DB row 转成扁平、JSON 安全的公开形态。
//
// 设计取舍：
//   - 字段命名与 src/shared/types.ts 的 Instrument 类型保持一致（snake_case）。
//     不引入 camelCase 转换层：REST 响应直接给前端用，前端无需再翻译。
//   - status 字段已经是 'online' | 'offline' | 'alarm' 三个枚举值，无需再翻译。
//   - 不返回 last_seen_at 的解析态（Date / null）；保持原 ISO 字符串，前端按需解析。
//
// 这是 contract v1（对应 src/server/presenters/contracts.ts 的 Zod schema 真源）。

import type { Instrument } from '@shared/types.js';

/** instrument 表的 DB row 形态。 */
export interface InstrumentRow {
  instrument_id: string;
  vendor: string;
  model: string;
  asset_tag: string;
  location: string;
  status: 'online' | 'offline' | 'alarm';
  installed_at: string;
  last_seen_at: string | null;
}

/** 公开形态（与 Instrument 类型同形，字段命名锁住）。 */
export interface PresentedInstrument {
  instrument_id: string;
  vendor: string;
  model: string;
  asset_tag: string;
  location: string;
  status: Instrument['status'];
  installed_at: string;
  last_seen_at: string | null;
}

/** 把 DB row 转为公开形态。 */
export function presentInstrument(row: InstrumentRow): PresentedInstrument {
  return {
    instrument_id: row.instrument_id,
    vendor: row.vendor,
    model: row.model,
    asset_tag: row.asset_tag,
    location: row.location,
    status: row.status,
    installed_at: row.installed_at,
    last_seen_at: row.last_seen_at,
  };
}

/** 把一组 rows 全部扁平化。 */
export function presentInstruments(rows: InstrumentRow[]): PresentedInstrument[] {
  return rows.map(presentInstrument);
}