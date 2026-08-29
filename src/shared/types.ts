// src/shared/types.ts
// 共享类型：仪器、报警码、校准记录、处理记录、plugin、审计事件。
// 字段命名与 src/server/migrations/001_init.sql、src/server/presenters/contracts.ts
// 保持一致（contract version 1）。
//
// HeartbeatEvent 类型与 HeartbeatSchema（Zod）由 Task 22 增补：
// - 类型与 schema 字段命名一致
// - schema 用于：IoT 网关 webhook 入参校验 + 队列 payload 校验 + 测试 fixture

import { z } from 'zod';

export type ISODateString = string;
export type HashString = string;
export type JSONPayload = Record<string, unknown>;

/** 一台检验仪器的元数据与定位信息。 */
export interface Instrument {
  instrument_id: string; // 主键，业务侧编码（如 ASSET-LAB-0001）
  vendor: string; // 占位名：Siemens/Roche/Abbott 等
  model: string;
  asset_tag: string;
  location: string; // 院内位置（脱敏：可写"门诊二楼检验科 A 区"等场景描述）
  status: InstrumentStatus;
  installed_at: ISODateString;
  last_seen_at: ISODateString | null;
}

export type InstrumentStatus = 'online' | 'offline' | 'alarm';

/** 报警码 + SOP（联合主键 vendor+model+alarm_code，避免与厂商码冲突）。 */
export interface AlarmCode {
  vendor: string;
  model: string;
  alarm_code: string; // 厂商原始报警码
  alarm_label: string; // 中文释义
  sop_md: string; // SOP markdown 文档
  created_at: ISODateString;
}

/** 一条校准记录，raw_hash 用于幂等去重。 */
export interface Calibration {
  calibration_id: string;
  instrument_id: string;
  calibrated_at: ISODateString;
  payload_json: JSONPayload; // 校准详情（脱敏后存）
  raw_hash: HashString; // SHA-256(原始 payload)；用于 heartbeat handler 去重
}

/** 处理记录（一次报警的处理流程，状态机见 src/server/processing/state-machine.ts）。 */
export interface ProcessingRecord {
  record_id: string;
  instrument_id: string;
  alarm_code: string; // 与 instrument 联合引用 vendor/model
  operator_id: string;
  root_cause: string; // 操作员填写的根因（自由文本）
  steps: string[]; // 操作步骤列表
  confirmed_at: ISODateString | null;
  state: ProcessingRecordState;
  retry_count: number;
  payload: JSONPayload; // 用于 LIS write-back 的 payload
  accession_no: string | null; // 反查 LIS 报告（只读）
}

export type ProcessingRecordState =
  | 'received'
  | 'parsed'
  | 'verified'
  | 'writeback_pending'
  | 'written_back'
  | 'failed';

/** plugin manifest：信息科通过 CLI 注册的扩展点。 */
export interface PluginManifest {
  name: string;
  version: string;
  type: PluginHookType;
  hooks: PluginHookSpec[];
  queue_name: string | null;
  auth: PluginAuth | null;
  rate_limit: number | null; // 每秒最多多少条（heartbeat 类）
  installed_at: ISODateString;
}

export type PluginHookType =
  | 'api'
  | 'task'
  | 'unfurl'
  | 'uninstall';

export interface PluginHookSpec {
  type: PluginHookType;
  path?: string; // Hook.API 路径前缀
  queue_name?: string; // Hook.Task 队列名
}

export interface PluginAuth {
  type: 'token' | 'basic';
  token?: string;
}

/** 审计事件，append-only（trigger 阻止 UPDATE/DELETE）。 */
export interface AuditEvent {
  event_id: string;
  kind: AuditEventKind;
  req_hash: HashString | null;
  resp_hash: HashString | null;
  operator_id: string | null;
  payload_json: JSONPayload;
  ts: ISODateString;
  related_event_id: string | null; // 串联事件链（replay 用）
}

export type AuditEventKind =
  | 'plugin.add'
  | 'plugin.remove'
  | 'plugin.uninstall'
  | 'queue.enqueue'
  | 'queue.process'
  | 'queue.fail'
  | 'queue.final_fail'
  | 'queue.retry'
  | 'writeback.initiated'
  | 'writeback.success'
  | 'processing_record.created'
  | 'processing_record.state_change'
  | 'processing_record.retry'
  | 'heartbeat.dropped'
  | 'heartbeat.received'
  | 'instrument.seen';

/** 队列 Job 内部态（不持久化，仅运行时）。 */
export interface QueueJob {
  id: string;
  name: string; // 队列名
  payload: JSONPayload;
  attempts: number; // 当前已尝试次数
  status: 'pending' | 'running' | 'success' | 'failed';
  last_error: string | null;
  next_run_at: ISODateString;
  created_at: ISODateString;
}

/** Heartbeat 事件（来自 IoT 网关）。 */
export interface HeartbeatEvent {
  instrument_id: string;
  vendor: string;
  model: string;
  received_at: ISODateString;
  raw: JSONPayload;
  raw_hash: HashString;
}

/**
 * Heartbeat 事件 Zod schema（Task 22 增补）。
 *
 * 用途：
 * 1. IoT 网关 webhook 入参校验（拒绝未声明字段）
 * 2. 队列 payload 二次校验（防 schema 漂移）
 * 3. 测试 fixture 复用
 *
 * 字段命名与 HeartbeatEvent 类型保持一致：
 * - instrument_id / vendor / model：必填字符串
 * - received_at：可选 ISO 时间（缺则落库时 now()）
 * - raw：对象，存脱敏后的仪器原始 payload
 * - raw_hash：必填 SHA-256 hex（64 字符），用于幂等去重
 *
 * 注：raw_hash 必须严格 64 位 hex，否则入参拒收（避免大小写、空格等漂移）。
 */
export const HeartbeatSchema = z
  .object({
    instrument_id: z
      .string()
      .min(1, 'instrument_id must not be empty')
      .max(64, 'instrument_id must be <= 64 chars'),
    vendor: z
      .string()
      .min(1, 'vendor must not be empty')
      .max(64, 'vendor must be <= 64 chars'),
    model: z
      .string()
      .min(1, 'model must not be empty')
      .max(64, 'model must be <= 64 chars'),
    received_at: z
      .string()
      .datetime({ offset: true, message: 'received_at must be ISO 8601' })
      .optional(),
    raw: z.record(z.unknown()).default({}),
    raw_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'raw_hash must be 64-char hex'),
  })
  .strict();

/**
 * Heartbeat 入参类型（schema 解析产物），供 handler / adapter 直接复用。
 * z.infer 后的字段命名与 HeartbeatEvent 完全一致。
 */
export type HeartbeatEventInput = z.infer<typeof HeartbeatSchema>;

/** 默认限流（次/秒）：plugin manifest 未声明 rateLimit 时使用。 */
export const HEARTBEAT_DEFAULT_RATE_LIMIT = 10;

/** 限流上限（次/秒）：plugin manifest rateLimit 的上限（与 capability 一致）。 */
export const HEARTBEAT_MAX_RATE_LIMIT = 1000;
