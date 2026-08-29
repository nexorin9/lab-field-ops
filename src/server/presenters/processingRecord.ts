// src/server/presenters/processingRecord.ts
//
// presentProcessingRecord 把 processing_record 表的 DB row 转成公开形态。
//
// 关键约束：
//   - steps_json / payload_json 是 TEXT 存的 JSON 字符串；present 时 parse。
//   - state 字段是 ProcessingRecordState 枚举（received / parsed / verified /
//     writeback_pending / written_back / failed），保持原值，前端按字段展示。
//   - confirmed_at 与 retry_count 是状态机相关字段，写回端点（POST /confirm）
//     与重投端点（POST /retry）会更新这些字段。

import type { JSONPayload, ProcessingRecord } from '@shared/types.js';

export interface ProcessingRecordRow {
  record_id: string;
  instrument_id: string;
  alarm_code: string;
  operator_id: string;
  root_cause: string;
  steps_json: string;
  confirmed_at: string | null;
  state: ProcessingRecord['state'];
  retry_count: number;
  payload_json: string;
  accession_no: string | null;
}

export interface PresentedProcessingRecord {
  record_id: string;
  instrument_id: string;
  alarm_code: string;
  /** 联合标识：与报警码 join_key 对齐（vendor|model|alarm_code）。
   *  本字段不含 vendor / model，因为 record 表不存；前端用 instrument_id
   *  反查仪器表拿到 vendor / model 后再拼接。 */
  operator_id: string;
  root_cause: string;
  steps: string[];
  confirmed_at: string | null;
  state: ProcessingRecord['state'];
  retry_count: number;
  payload: JSONPayload;
  accession_no: string | null;
}

/** 安全解析 JSON 数组字符串（steps 用）；失败回退空数组。 */
function safeParseStringArray(text: string): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v));
    }
    return [];
  } catch {
    return [];
  }
}

/** 安全解析 JSON 对象（payload 用）；失败回退空对象。 */
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
export function presentProcessingRecord(row: ProcessingRecordRow): PresentedProcessingRecord {
  return {
    record_id: row.record_id,
    instrument_id: row.instrument_id,
    alarm_code: row.alarm_code,
    operator_id: row.operator_id,
    root_cause: row.root_cause,
    steps: safeParseStringArray(row.steps_json),
    confirmed_at: row.confirmed_at,
    state: row.state,
    retry_count: row.retry_count,
    payload: safeParseJsonObject(row.payload_json),
    accession_no: row.accession_no,
  };
}

/** 把一组 rows 全部扁平化。 */
export function presentProcessingRecords(
  rows: ProcessingRecordRow[],
): PresentedProcessingRecord[] {
  return rows.map(presentProcessingRecord);
}