// src/server/plugin/examples/iot-heartbeat.ts
// 示例 plugin：IoT 网关心跳入校准表。
// 队列名 iot-heartbeat；handler 处理仪器心跳 raw 事件 → 入 calibration 表（去重 by raw_hash）。
//
// 当前文件仅定义 manifest + handler 形态，真实派发由 Task 10/11 的 createQueue 串联。
// 限流（每 vendor/model 每秒 N 条）由 Task 22 补齐；当前 handler 无 rate limit 逻辑。

import { randomUUID } from 'node:crypto';
import { PluginManager } from '../manager.js';
import { appendAudit } from '../../audit/ledger.js';
import { getDb } from '../../db.js';
import type { JSONPayload, TaskHandler } from '@shared/types.js';

/** manifest 形态（与 examples/manifests/iot-heartbeat.json 一致）。 */
export const IOT_HEARTBEAT_MANIFEST = {
  name: 'iot-heartbeat',
  version: '1.0.0',
  type: 'task' as const,
  hooks: [
    {
      type: 'task' as const,
      queue_name: 'iot-heartbeat',
    },
  ],
  queue_name: 'iot-heartbeat',
  auth: null,
  rate_limit: 10, // 默认 10/s（vendor/model 维度，Task 22 落地）
};

/** 内存内限流状态（vendor/model → {tokens, lastRefill}）。 */
const rateState = new Map<string, { tokens: number; lastRefill: number }>();

/** 简易 token bucket（每秒 refill N 个；超限拒收）。 */
function checkRateLimit(vendor: string, model: string, n: number): boolean {
  const key = `${vendor}|${model}`;
  const now = Date.now();
  const state = rateState.get(key);
  if (!state) {
    rateState.set(key, { tokens: n - 1, lastRefill: now });
    return true;
  }
  const elapsed = now - state.lastRefill;
  if (elapsed >= 1000) {
    state.tokens = n;
    state.lastRefill = now;
  }
  if (state.tokens > 0) {
    state.tokens -= 1;
    return true;
  }
  return false;
}

/** 测试/CLI helper：重置限流状态。 */
export function resetHeartbeatRateState(): void {
  rateState.clear();
}

/**
 * IoT heartbeat handler：写入 calibration 表；raw_hash 去重。
 * 入参 payload：{ instrument_id, vendor, model, raw, raw_hash, received_at }。
 */
export const iotHeartbeatHandler: TaskHandler = async (payload) => {
  const vendor = String(payload.vendor ?? '');
  const model = String(payload.model ?? '');
  const instrumentId = String(payload.instrument_id ?? '');
  const rawHash = String(payload.raw_hash ?? '');
  const receivedAt = String(payload.received_at ?? new Date().toISOString());
  const raw = (payload.raw ?? {}) as JSONPayload;

  if (!vendor || !model || !instrumentId || !rawHash) {
    throw new Error('heartbeat payload missing required fields (vendor/model/instrument_id/raw_hash)');
  }

  // 限流（默认 10/s）
  const rate = (IOT_HEARTBEAT_MANIFEST.rate_limit ?? 10) as number;
  if (!checkRateLimit(vendor, model, rate)) {
    appendAudit({
      kind: 'heartbeat.dropped',
      operatorId: null,
      payload: {
        plugin: 'iot-heartbeat',
        vendor,
        model,
        reason: 'rate_limit_exceeded',
        raw_hash: rawHash,
      } as unknown as Record<string, unknown>,
    });
    return;
  }

  const db = getDb();

  // 去重：calibration 表的 raw_hash 已有则 skip
  const existing = db
    .prepare('SELECT calibration_id FROM calibration WHERE raw_hash = ?')
    .get(rawHash);
  if (existing) {
    return;
  }

  const calibrationId = `cal_${randomUUID()}`;
  db.prepare(
    `INSERT INTO calibration
       (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(calibrationId, instrumentId, receivedAt, JSON.stringify(raw), rawHash);

  // 更新仪器 last_seen_at
  db.prepare('UPDATE instrument SET last_seen_at = ? WHERE instrument_id = ?').run(
    receivedAt,
    instrumentId,
  );

  appendAudit({
    kind: 'heartbeat.received',
    operatorId: null,
    payload: {
      plugin: 'iot-heartbeat',
      vendor,
      model,
      instrument_id: instrumentId,
      calibration_id: calibrationId,
    } as unknown as Record<string, unknown>,
  });
};

/** 注册入口：供 CLI plugin add 调用。 */
export function registerIotHeartbeat(): { ok: boolean; errors?: string[] } {
  return PluginManager.add(IOT_HEARTBEAT_MANIFEST, {
    task: iotHeartbeatHandler,
    uninstall: async () => {
      // 清空限流状态
      rateState.clear();
    },
  });
}

/** 测试 helper：导出 handler 供单测调用。 */
export const __test = {
  checkRateLimit,
  resetHeartbeatRateState,
};
