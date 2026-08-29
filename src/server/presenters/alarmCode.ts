// src/server/presenters/alarmCode.ts
//
// presentAlarmCode 把 alarm_code 表的 DB row 转成扁平、JSON 安全的公开形态。
//
// 联合主键 (vendor, model, alarm_code) 是公开形态的关键标识：
//   - 前端用 joinKey 字段（"vendor|model|alarm_code"）作为对象 key，
//     避免在多个 alarm_code 对象之间误用单一字符串 id。
//   - sop_md 是 SOP markdown 全文，前端走 React markdown 渲染器（不在此处转换）。

export interface AlarmCodeRow {
  vendor: string;
  model: string;
  alarm_code: string;
  alarm_label: string;
  sop_md: string;
  created_at: string;
}

export interface PresentedAlarmCode {
  vendor: string;
  model: string;
  alarm_code: string;
  /** 联合主键串（vendor|model|alarm_code）—— 前端用作对象 key。 */
  join_key: string;
  alarm_label: string;
  sop_md: string;
  created_at: string;
}

/** 联合主键拼装：与 src/app/kbar/registry.ts 的 alarmKeyOf 保持一致。 */
export function alarmJoinKey(vendor: string, model: string, alarmCode: string): string {
  return `${vendor}|${model}|${alarmCode}`;
}

/** 把 DB row 转为公开形态。 */
export function presentAlarmCode(row: AlarmCodeRow): PresentedAlarmCode {
  return {
    vendor: row.vendor,
    model: row.model,
    alarm_code: row.alarm_code,
    join_key: alarmJoinKey(row.vendor, row.model, row.alarm_code),
    alarm_label: row.alarm_label,
    sop_md: row.sop_md,
    created_at: row.created_at,
  };
}

/** 把一组 rows 全部扁平化。 */
export function presentAlarmCodes(rows: AlarmCodeRow[]): PresentedAlarmCode[] {
  return rows.map(presentAlarmCode);
}