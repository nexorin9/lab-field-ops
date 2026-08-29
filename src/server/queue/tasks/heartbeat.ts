// src/server/queue/tasks/heartbeat.ts
//
// IoT 网关心跳 task handler：把仪器心跳 raw 事件写入 calibration 表。
// 队列名：iot-heartbeat
// 注册入口：registerAllTasks()（src/server/queue/register.ts）
//
// 关键不变量：
// 1. 必填字段 vendor / model / instrument_id / raw_hash → 缺则抛错（队列重试）
// 2. raw_hash 去重：calibration 表已有同 raw_hash → skip（落 audit dropped）
// 3. 限流：每 (vendor, model) 每秒最多 N 条（N 由 plugin manifest.rate_limit
//    或默认 HEARTBEAT_DEFAULT_RATE_LIMIT 决定）；超限拒收并落 audit_event
//    kind=heartbeat.dropped（见 heartbeat-dropped.ts）
// 4. 成功落 audit_event kind=heartbeat.received（payload 含 vendor/model/instrument_id/calibration_id）
//
// 兼容两种调用形态：
//   - queue 派发：handler(job) → job.payload 是 inner payload
//   - 直接调用：handler(payload) → payload 本身就是 inner payload

import { randomUUID } from 'node:crypto';
import { getDb } from '../../db.js';
import { appendAudit } from '../../audit/ledger.js';
import {
  HeartbeatSchema,
  HEARTBEAT_DEFAULT_RATE_LIMIT,
  HEARTBEAT_MAX_RATE_LIMIT,
  type HeartbeatEventInput,
} from '@shared/types.js';
import type { JSONPayload } from '@shared/types.js';
import type { TaskHandler } from '../../plugin/hooks.js';
import type { QueueJobRecord } from '../types.js';
import {
  recordHeartbeatDropped,
  type HeartbeatDropReason,
} from './heartbeat-dropped.js';

/** 队列名（与 plugin manifest.queue_name 一致）。 */
export const IOT_HEARTBEAT_QUEUE = 'iot-heartbeat';

/** 队列入参约定（与 spec.md 工作闭环第 4 条对齐）。 */
export interface HeartbeatTaskPayload extends JSONPayload {
  /** 必填：仪器 ID（instrument 表外键）。 */
  instrument_id: string;
  /** 必填：厂商占位名（Siemens/Roche/Abbott 等）。 */
  vendor: string;
  /** 必填：型号。 */
  model: string;
  /** 必填：SHA-256(原始字节流)；用于幂等去重。 */
  raw_hash: string;
  /** 必填：原始 payload 详情（脱敏后存）。 */
  raw: JSONPayload;
  /** 可选：网关接收时间（默认 now）。 */
  received_at?: string;
}

/**
 * 内存 token-bucket：每个 (vendor, model) 一桶。
 * - capacity = ratePerSecond（每秒允许的最大条数）
 * - tokens 随时间线性补充
 * - 入队前扣 1 token；不足则拒收
 *
 * 注：内存级（重启会丢失 token 状态；冷启动默认满桶）。
 * 这是 Task 22 增补的限流骨架；后续 task 可扩成跨进程共享（Redis 等）。
 */
interface TokenBucket {
  tokens: number;
  capacity: number;
  /** 上次补充 tokens 的时刻（ms epoch）。 */
  lastRefillAt: number;
}

/** 全局限流桶：(vendor|lowercase, model|lowercase) → TokenBucket。 */
const buckets = new Map<string, TokenBucket>();

/**
 * 把 (vendor, model) 规范化为单一 key（lowercase + | 分隔）。
 * 避免大小写漂移导致桶分裂。
 */
function bucketKey(vendor: string, model: string): string {
  return `${vendor.trim().toLowerCase()}|${model.trim().toLowerCase()}`;
}

/**
 * 在桶里尝试扣 1 个 token；不足则拒收。
 * 返回 true = 通过；false = 被限流。
 */
export function tryAcquireHeartbeatToken(
  vendor: string,
  model: string,
  ratePerSecond: number,
  now: number = Date.now(),
): boolean {
  const safeRate = Math.max(
    1,
    Math.min(HEARTBEAT_MAX_RATE_LIMIT, Math.floor(ratePerSecond)),
  );
  const key = bucketKey(vendor, model);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      tokens: safeRate,
      capacity: safeRate,
      lastRefillAt: now,
    };
    buckets.set(key, bucket);
  }
  // 线性补充（最多补到 capacity）
  const elapsed = Math.max(0, now - bucket.lastRefillAt);
  const refill = (elapsed / 1000) * safeRate;
  if (refill > 0) {
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refill);
    bucket.lastRefillAt = now;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/** 测试 helper：清空所有限流桶。 */
export function __resetHeartbeatRateLimiter(): void {
  buckets.clear();
}

/** 测试 helper：取当前桶快照。 */
export function __getHeartbeatBucket(
  vendor: string,
  model: string,
): TokenBucket | undefined {
  return buckets.get(bucketKey(vendor, model));
}

/**
 * 把心跳 raw 事件写入 calibration 表（独立函数，便于测试）。
 * - 入参先过 HeartbeatSchema 校验，失败抛错（队列重试）
 * - 限流：超限 → recordHeartbeatDropped + return（不入库、不抛错，避免队列无限重试）
 * - 校验 + 限流通过后：raw_hash 去重 → 插入 calibration → 更新 instrument.last_seen_at
 *   → 落 audit_event kind=heartbeat.received
 *
 * 返回值：
 *   - status: 'persisted' | 'rate_limited' | 'duplicate' | 'invalid'
 *   - calibrationId?: 新插入或已存在的校准记录 id
 *   - reason?: schema 错误时的简要原因
 */
export async function pushHeartbeatToCalibration(
  payload: HeartbeatTaskPayload,
  options: { ratePerSecond?: number; now?: number } = {},
): Promise<{
  status: 'persisted' | 'rate_limited' | 'duplicate' | 'invalid';
  calibrationId?: string;
  reason?: string;
}> {
  // 1) Zod schema 校验（统一字段命名 + 严格 64 位 hex）
  const parsed = HeartbeatSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      status: 'invalid',
      reason: parsed.error.errors
        .map((e) => `${e.path.join('.')}:${e.message}`)
        .join('; '),
    };
  }
  const event: HeartbeatEventInput = parsed.data;
  const ratePerSecond =
    options.ratePerSecond ?? HEARTBEAT_DEFAULT_RATE_LIMIT;
  const now = options.now ?? Date.now();

  const instrumentId = event.instrument_id;
  const vendor = event.vendor;
  const model = event.model;
  const rawHash = event.raw_hash;
  const receivedAt = event.received_at ?? new Date(now).toISOString();

  // 2) 限流：超限 → recordHeartbeatDropped（rate_limited）→ return
  if (!tryAcquireHeartbeatToken(vendor, model, ratePerSecond, now)) {
    recordHeartbeatDropped({
      reason: 'rate_limited',
      vendor,
      model,
      instrumentId,
      rawHash,
      rateLimit: ratePerSecond,
      receivedAt,
    });
    return { status: 'rate_limited' };
  }

  const db = getDb();

  // 3) raw_hash 去重：calibration 表已有同 raw_hash → 跳过
  const existing = db
    .prepare('SELECT calibration_id FROM calibration WHERE raw_hash = ?')
    .get(rawHash) as { calibration_id: string } | undefined;
  if (existing) {
    recordHeartbeatDropped({
      reason: 'duplicate',
      vendor,
      model,
      instrumentId,
      rawHash,
      rateLimit: ratePerSecond,
      receivedAt,
      calibrationId: existing.calibration_id,
    });
    return { status: 'duplicate', calibrationId: existing.calibration_id };
  }

  const calibrationId = `cal_${randomUUID()}`;
  db.prepare(
    `INSERT INTO calibration
       (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(calibrationId, instrumentId, receivedAt, JSON.stringify(event.raw), rawHash);

  // 更新仪器 last_seen_at（让 ⌘K 与看板看到仪器状态）
  db.prepare(
    'UPDATE instrument SET last_seen_at = ? WHERE instrument_id = ?',
  ).run(receivedAt, instrumentId);

  appendAudit({
    kind: 'heartbeat.received',
    operatorId: null,
    payload: {
      plugin: IOT_HEARTBEAT_QUEUE,
      vendor,
      model,
      instrument_id: instrumentId,
      calibration_id: calibrationId,
      rate_limit: ratePerSecond,
    } as unknown as Record<string, unknown>,
  });

  return { status: 'persisted', calibrationId };
}

/**
 * IoT heartbeat QueueHandler。
 * 兼容 queue 派发（job）与直接调用（payload）两种形态。
 * rate_limited / duplicate：handler 返回成功（不抛错），避免队列无限重试。
 * invalid（schema 不匹配）：handler 抛错 → 队列按指数退避重试 5 次。
 */
export const iotHeartbeatHandler: TaskHandler = async (
  jobOrPayload: JSONPayload,
) => {
  const payload = extractPayload(jobOrPayload);
  const result = await pushHeartbeatToCalibration(
    payload as HeartbeatTaskPayload,
  );
  if (result.status === 'invalid') {
    throw new Error(`heartbeat invalid: ${result.reason}`);
  }
  return result;
};

function extractPayload(input: QueueJobRecord | JSONPayload): JSONPayload {
  if (
    input &&
    typeof input === 'object' &&
    'payload' in input &&
    typeof (input as QueueJobRecord).payload === 'object' &&
    (input as QueueJobRecord).payload !== null
  ) {
    return (input as QueueJobRecord).payload as JSONPayload;
  }
  return input as JSONPayload;
}

/** 测试 helper：导出 handler 与常量供单测断言。 */
export const __test = {
  IOT_HEARTBEAT_QUEUE,
  tryAcquireHeartbeatToken,
  __resetHeartbeatRateLimiter,
  __getHeartbeatBucket,
};