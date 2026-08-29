// src/server/queue/tasks/heartbeat-dropped.ts
//
// Heartbeat 拒收事件记录器：把"被限流"或"重复"的 heartbeat 落 audit_event。
// 用途：
//   1. 仪器侧报警过载时，回放 dropped 事件可定位「哪台仪器 + 哪个时间窗」超限
//   2. duplicate（raw_hash 重复）便于追查"重复采集"的网关
//   3. AuditDrawer / replay 视图可按 kind=heartbeat.dropped 过滤查看
//
// 与 heartbeat.ts 的关系：
//   heartbeat.ts 调用 recordHeartbeatDropped(...)；
//   本文件不抛错（即使 audit 写失败也不阻塞主流程，避免队列阻塞）。
//
// 注意：落 audit 不影响限流决策；audit 写入是 best-effort 旁路日志。

import { appendAudit } from '../../audit/ledger.js';
import type { ISODateString, HashString } from '@shared/types.js';

/** Heartbeat 拒收原因枚举（与 audit_event.kind=heartbeat.dropped 的 payload.reason 对齐）。 */
export type HeartbeatDropReason = 'rate_limited' | 'duplicate' | 'invalid';

/** recordHeartbeatDropped 入参。 */
export interface HeartbeatDropInput {
  reason: HeartbeatDropReason;
  vendor: string;
  model: string;
  instrumentId: string;
  rawHash: HashString;
  /** 当前 manifest 配置的限流（次/秒）；仅 rate_limited 时有完整意义。 */
  rateLimit: number;
  /** 网关接收时间（ISO）；用于在 AuditDrawer 串联时间窗。 */
  receivedAt: ISODateString;
  /** 仅 duplicate 时：已有的 calibration_id。 */
  calibrationId?: string;
}

/** recordHeartbeatDropped 返回值（audit event_id）。 */
export interface HeartbeatDropResult {
  ok: boolean;
  eventId?: string;
  reason: HeartbeatDropReason;
  ts?: ISODateString;
  /** audit 写入失败时的错误消息（best-effort，不抛）。 */
  error?: string;
}

/**
 * 把 heartbeat drop 事件落 audit_event(kind=heartbeat.dropped)。
 *
 * 关键不变量：
 * 1. 不抛错：appendAudit 失败时仅返回 ok=false（避免污染主流程）
 * 2. 单一入口：所有 drop 场景都走本函数（便于后续 grep / 单元测试）
 * 3. payload 字段命名稳定：vendor / model / instrument_id / raw_hash / reason /
 *    rate_limit / received_at / calibration_id?（仅 duplicate）
 */
export function recordHeartbeatDropped(
  input: HeartbeatDropInput,
): HeartbeatDropResult {
  const payload: Record<string, unknown> = {
    reason: input.reason,
    vendor: input.vendor,
    model: input.model,
    instrument_id: input.instrumentId,
    raw_hash: input.rawHash,
    rate_limit: input.rateLimit,
    received_at: input.receivedAt,
    queue: 'iot-heartbeat',
  };
  if (input.calibrationId) {
    payload.existing_calibration_id = input.calibrationId;
  }
  try {
    const result = appendAudit({
      kind: 'heartbeat.dropped',
      operatorId: null,
      payload: payload as unknown as Record<string, unknown>,
    });
    return {
      ok: true,
      eventId: result.eventId,
      reason: input.reason,
      ts: result.ts,
    };
  } catch (err) {
    return {
      ok: false,
      reason: input.reason,
      error: (err as Error).message,
    };
  }
}

/** 测试 helper：导出常量便于测试断言。 */
export const __test = {
  IOT_HEARTBEAT_QUEUE: 'iot-heartbeat',
};