// src/server/presenters/contracts.ts
//
// Presenter 公开形态的 Zod schema 锁（Task 24，contract v1）。
//
// 背景：
//   - 各 presenter/*.ts 的 TypeScript 接口只是编译期形态；运行时若 DB schema 漂移
//     或 presenter 计算逻辑失修，REST 响应可能渗入字段改名 / 多余字段 / 缺字段。
//   - 这里把 6 个 presenter 的输出形态用 Zod 锁住字段命名、类型、required/optional；
//     tests/contracts.test.ts 既锁 schema 形态，又对比每个 presenter 输出与 schema 通过。
//   - 业务侧 requests（POST body）走 src/shared/types.ts 的 Zod schema（如 HeartbeatSchema），
//     responses 的形态锁在本文件。
//
// 升级约定（contract 版本演进）：
//   - contract v1 = 当前文件导出 (InstrumentContractV1 / AlarmCodeContractV1 / ...)
//   - 想加字段 → 写 `contracts-v2.ts` 导出 InstrumentContractV2，与 v1 并存；
//     v1 标记 `@deprecated` 但保留，避免一次性 break 前端。
//   - 现存 schema 都用 `.describe('contract: <name> v1')`；tests/contracts.test.ts
//     锁住该 schema 自带的 description，未来增删版本会触发测试失败。

import { z } from 'zod';
import { ERROR_HTTP_STATUS } from '../errors.js';

/** contract 版本常量（v1）。 */
export const CONTRACT_VERSION = '1' as const;
export type ContractVersion = typeof CONTRACT_VERSION;

/** String 类型：非空字符串。 */
const NonEmptyString = z.string().min(1);

/** 联合主键串（vendor|model|alarm_code）。 */
const JoinKeyString = z.string().regex(/^[^|]+\|[^|]+\|[^|]+$/);

// ---- Instrument contract v1 ----

export const InstrumentStatusSchema = z.enum(['online', 'offline', 'alarm']);

export const InstrumentContractV1 = z
  .object({
    instrument_id: NonEmptyString,
    vendor: NonEmptyString,
    model: NonEmptyString,
    asset_tag: NonEmptyString,
    location: NonEmptyString,
    status: InstrumentStatusSchema,
    installed_at: z.string().min(1),
    last_seen_at: z.string().nullable(),
  })
  .strict()
  .describe('contract: instrument v1');

export type PresentedInstrumentContract = z.infer<typeof InstrumentContractV1>;

// ---- AlarmCode contract v1 ----

export const AlarmCodeContractV1 = z
  .object({
    vendor: NonEmptyString,
    model: NonEmptyString,
    alarm_code: NonEmptyString,
    join_key: JoinKeyString,
    alarm_label: NonEmptyString,
    sop_md: z.string(),
    created_at: z.string().min(1),
  })
  .strict()
  .describe('contract: alarm-code v1');

export type PresentedAlarmCodeContract = z.infer<typeof AlarmCodeContractV1>;

// ---- Calibration contract v1 ----

export const CalibrationContractV1 = z
  .object({
    calibration_id: NonEmptyString,
    instrument_id: NonEmptyString,
    calibrated_at: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    raw_hash: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .strict()
  .describe('contract: calibration v1');

export type PresentedCalibrationContract = z.infer<typeof CalibrationContractV1>;

// ---- ProcessingRecord contract v1 ----

export const ProcessingRecordStateSchema = z.enum([
  'received',
  'parsed',
  'verified',
  'writeback_pending',
  'written_back',
  'failed',
]);

export const ProcessingRecordContractV1 = z
  .object({
    record_id: NonEmptyString,
    instrument_id: NonEmptyString,
    alarm_code: NonEmptyString,
    operator_id: NonEmptyString,
    root_cause: z.string(),
    steps: z.array(z.string()),
    confirmed_at: z.string().nullable(),
    state: ProcessingRecordStateSchema,
    retry_count: z.number().int().min(0),
    payload: z.record(z.string(), z.unknown()),
    accession_no: z.string().nullable(),
  })
  .strict()
  .describe('contract: processing-record v1');

export type PresentedProcessingRecordContract = z.infer<typeof ProcessingRecordContractV1>;

// ---- Plugin contract v1 ----

export const PluginHookTypeSchema = z.enum(['api', 'task', 'unfurl', 'uninstall']);

export const PluginHookSpecSchema = z.object({
  type: PluginHookTypeSchema,
  path: z.string().optional(),
  queue_name: z.string().optional(),
});

export const PluginAuthSchema = z
  .object({
    type: z.enum(['token', 'basic']),
    token: z.string().optional(),
  })
  .strict();

export const PluginContractV1 = z
  .object({
    name: NonEmptyString,
    version: NonEmptyString,
    type: PluginHookTypeSchema,
    hooks: z.array(PluginHookSpecSchema),
    queue_name: z.string().nullable(),
    auth: PluginAuthSchema.nullable(),
    rate_limit: z.number().int().positive().nullable(),
    installed_at: z.string().min(1),
    listening_path: z.string(),
  })
  .strict()
  .describe('contract: plugin v1');

export type PresentedPluginContract = z.infer<typeof PluginContractV1>;

// ---- AuditEvent contract v1 ----

export const AuditEventKindSchema = z.enum([
  'plugin.add',
  'plugin.remove',
  'plugin.uninstall',
  'queue.enqueue',
  'queue.process',
  'queue.fail',
  'queue.final_fail',
  'queue.retry',
  'writeback.initiated',
  'writeback.success',
  'processing_record.created',
  'processing_record.state_change',
  'processing_record.retry',
  'heartbeat.dropped',
  'heartbeat.received',
  'instrument.seen',
]);

export const AuditEventContractV1 = z
  .object({
    event_id: NonEmptyString,
    kind: AuditEventKindSchema,
    req_hash: z.string().nullable(),
    resp_hash: z.string().nullable(),
    operator_id: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    ts: z.string().min(1),
    related_event_id: z.string().nullable(),
  })
  .strict()
  .describe('contract: audit-event v1');

export type PresentedAuditEventContract = z.infer<typeof AuditEventContractV1>;

// ---- 全部 contract 锁 ----

/** 6 个 presenter contract v1 schema 的元组（snapshot 锁）。 */
export const ALL_CONTRACTS_V1 = [
  InstrumentContractV1,
  AlarmCodeContractV1,
  CalibrationContractV1,
  ProcessingRecordContractV1,
  PluginContractV1,
  AuditEventContractV1,
] as const;

/** 用 Zod schema 校验 presenter 输出；返回 parsing 结果与错误。 */
export function validatePresenterOutput<T>(
  contract: z.ZodType<T>,
  output: unknown,
): { ok: true; data: T } | { ok: false; errors: string[] } {
  const r = contract.safeParse(output);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
  };
}

/** 错误码 → HTTP 状态的 Zod 锁（与 src/server/errors.ts 的 ERROR_HTTP_STATUS 同步）。 */
export const ErrorCodeContract = z
  .object({
    VALIDATION_ERROR: z.literal(400),
    NOT_FOUND: z.literal(404),
    CONFLICT: z.literal(409),
    STATE_MACHINE_ERROR: z.literal(409),
    SSRF_DENIED: z.literal(403),
    PLUGIN_CAPABILITY_DENIED: z.literal(403),
  })
  .strict()
  .describe('contract: error-code-to-http-status v1');

/** 用 Zod 校验 ERROR_HTTP_STATUS 表与契约一致。 */
export const errorHttpStatusContract = ErrorCodeContract.safeParse(ERROR_HTTP_STATUS);
if (!errorHttpStatusContract.success) {
  // 启动期硬错：ERROR_HTTP_STATUS 表与 errors.ts 字面量集合或 Zod 契约失同步。
  // 防止「编译器不报错、运行期路由错码」漂移。
  throw new Error(
    `[contracts] ERROR_HTTP_STATUS mismatch with ErrorCodeContract: ${errorHttpStatusContract.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')}`,
  );
}
