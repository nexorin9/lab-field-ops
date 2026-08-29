// src/server/presenters/calibration.ts
//
// presentCalibration 把 calibration 表的 DB row 转成公开形态。
//
// 关键约束：
//   - payload_json 是 TEXT 字段存的 JSON 字符串；present 时 parse 为对象，
//     避免前端再处理字符串解析。
//   - raw_hash 保留为 SHA-256 hex；用于 heartbeat handler 去重与前台反查。

import type { JSONPayload } from '@shared/types.js';

export interface CalibrationRow {
  calibration_id: string;
  instrument_id: string;
  calibrated_at: string;
  payload_json: string;
  raw_hash: string;
}

export interface PresentedCalibration {
  calibration_id: string;
  instrument_id: string;
  calibrated_at: string;
  payload: JSONPayload;
  raw_hash: string;
}

/** 安全解析 JSON 字符串；解析失败时返回空对象（fail-soft）。 */
function safeParseJson(text: string): JSONPayload {
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
export function presentCalibration(row: CalibrationRow): PresentedCalibration {
  return {
    calibration_id: row.calibration_id,
    instrument_id: row.instrument_id,
    calibrated_at: row.calibrated_at,
    payload: safeParseJson(row.payload_json),
    raw_hash: row.raw_hash,
  };
}

/** 把一组 rows 全部扁平化。 */
export function presentCalibrations(rows: CalibrationRow[]): PresentedCalibration[] {
  return rows.map(presentCalibration);
}