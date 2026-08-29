// src/server/queue/tasks/writeback.ts
//
// LIS writeback task handler：把 record.confirmed payload 推送到 LIS writeback
// channel（JSONL 追加文件，测试替身）。生产对接真实 LIS 时，把
// `pushToLisWritebackChannel` 替换为 ASTM/HL7 适配器即可，handler 接口不变。
//
// 队列名：lis-writeback
// 注册入口：registerAllTasks()（src/server/queue/register.ts）
//
// 公开 API：
//   LIS_WRITEBACK_QUEUE      队列名常量（plugin manifest 也用这个）
//   lisWritebackHandler      QueueHandler（接受 QueueJobRecord，从 job.payload 取 record_id 等）
//   pushToLisWritebackChannel 内部 helper：接受 WritebackTaskPayload，写一行 JSONL
//   defaultLisWritebackPath  默认 JSONL 路径
//   tempLisWritebackPath     测试 helper

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { appendAudit } from '../../audit/ledger.js';
import type { JSONPayload } from '@shared/types.js';
import type { TaskHandler } from '../../plugin/hooks.js';
import type { QueueJobRecord } from '../types.js';
import { getDb } from '../../db.js';
import {
  applyTransition,
  getProcessingRecordStateRow,
  transition,
} from '../../processing/state-machine.js';

/** 队列名（与 plugin manifest.queue_name 一致）。 */
export const LIS_WRITEBACK_QUEUE = 'lis-writeback';

/** 环境变量名（覆盖默认 JSONL 路径）。 */
export const LIS_WRITEBACK_PATH_ENV = 'LIS_WRITEBACK_PATH';

/** writeback 单行 JSONL schema（便于日志回溯 + 测试断言）。 */
export interface LisWritebackRow {
  ts: string;
  record_id: string;
  instrument_id: string | null;
  alarm_code: string | null;
  accession_no: string | null;
  operator_id: string | null;
  root_cause: string | null;
  steps: string[];
  confirmed_at: string | null;
}

/** 队列入参约定（与 spec.md 工作闭环第 3 条对齐）。 */
export interface WritebackTaskPayload extends JSONPayload {
  /** 必填：处理记录 ID（对应 processing_record.record_id）。 */
  record_id: string;
  /** 可选：处理关联的仪器 ID。 */
  instrument_id?: string | null;
  /** 可选：处理关联的报警码（厂商码原文）。 */
  alarm_code?: string | null;
  /** 可选：LIS 报告 accession_no（反查键）。 */
  accession_no?: string | null;
  /** 可选：操作员 ID（人工确认者）。 */
  operator_id?: string | null;
  /** 可选：根因（自由文本）。 */
  root_cause?: string | null;
  /** 可选：处理步骤列表。 */
  steps?: string[];
  /** 可选：人工确认时间（ISO8601）。 */
  confirmed_at?: string | null;
}

/** 默认 LIS writeback 通道文件路径（JSONL 追加）。 */
export function defaultLisWritebackPath(): string {
  return (
    process.env[LIS_WRITEBACK_PATH_ENV] ??
    path.join(process.cwd(), 'data', 'lis-writeback.ndjson')
  );
}

/**
 * 把一行 writeback 记录追加到 JSONL 文件。
 * - 自动 mkdir parent dir
 * - 写入失败 → 抛错（让队列重试 + 落 audit）
 * - 独立函数：测试可直接调用，不依赖 queue/job 包装
 *
 * **不**直接改 processing_record.state；状态机的「writeback_pending → written_back」
 * 转移由调用方（队列 handler wrapper）执行，保证主路径与失败重试路径分离。
 */
export async function pushToLisWritebackChannel(
  payload: WritebackTaskPayload,
  filePath: string = defaultLisWritebackPath(),
): Promise<void> {
  const recordId = String(payload.record_id ?? '').trim();
  if (!recordId) {
    throw new Error('writeback handler requires payload.record_id');
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const row: LisWritebackRow = {
    ts: new Date().toISOString(),
    record_id: recordId,
    instrument_id: (payload.instrument_id as string | null | undefined) ?? null,
    alarm_code: (payload.alarm_code as string | null | undefined) ?? null,
    accession_no: (payload.accession_no as string | null | undefined) ?? null,
    operator_id: (payload.operator_id as string | null | undefined) ?? null,
    root_cause: (payload.root_cause as string | null | undefined) ?? null,
    steps: Array.isArray(payload.steps) ? (payload.steps as string[]) : [],
    confirmed_at: (payload.confirmed_at as string | null | undefined) ?? null,
  };
  const line = JSON.stringify(row) + '\n';
  await fs.promises.appendFile(filePath, line, 'utf8');

  appendAudit({
    kind: 'writeback.success',
    operatorId: (payload.operator_id as string) ?? null,
    payload: {
      plugin: LIS_WRITEBACK_QUEUE,
      record_id: recordId,
      target: filePath,
      instrument_id: row.instrument_id,
      alarm_code: row.alarm_code,
      accession_no: row.accession_no,
    } as unknown as Record<string, unknown>,
  });
}

/**
 * 队列 handler 成功后，把 processing_record.state 从 writeback_pending 推进到 written_back。
 * 失败时抛错（让队列重试）；不抛错时返回 void。
 *
 * - record 不存在 / 已经是 written_back / 已经是 verified 之前的状态 → 不抛错（幂等）
 * - 当前态是 writeback_pending → 成功 transition + UPDATE + audit
 * - 当前态是 failed / received / parsed 等不允许的状态 → 抛错（让队列重试）
 */
export async function markWritebackSuccess(
  recordId: string,
): Promise<void> {
  const db = getDb();
  const stateRow = getProcessingRecordStateRow(db, recordId);
  if (!stateRow) {
    // 记录已被删除；不再尝试推进（audit 写入也跳过，避免阻塞队列）
    return;
  }
  // written_back / failed / 其它非 writeback_pending 态 → 不重复 transition
  if (stateRow.state === 'written_back') return;
  if (stateRow.state !== 'writeback_pending') {
    // 异常路径：handler 成功但 state 不在 pending；让队列重试或人工介入
    throw new Error(
      `markWritebackSuccess: record ${recordId} in unexpected state '${stateRow.state}'`,
    );
  }
  const result = transition(stateRow, { type: 'writeback_success' });
  if (result.idempotent) return;
  applyTransition(db, stateRow, result, null);
}

/**
 * LIS writeback QueueHandler（带状态推进）。
 * 入参 job: QueueJobRecord（含 .payload 字段承载 record_id 等）。
 * 兼容直接传入 payload 的形态（用于测试；通过检测 'payload' 字段判定）。
 *
 * 顺序：先 push 到 JSONL 通道，再 markWritebackSuccess。
 * 若 markWritebackSuccess 抛错（state 不在 writeback_pending），队列会重试，
 * 但 pushToLisWritebackChannel 已经写过一行（idempotent 不保证 channel 不重写；
 * 接受这一妥协，因为 channel 是测试替身；正式对接 LIS 时由 LIS 端去重）。
 */
export const lisWritebackHandler: TaskHandler = async (
  jobOrPayload: JSONPayload,
) => {
  const payload = extractPayload(jobOrPayload) as WritebackTaskPayload;
  await pushToLisWritebackChannel(payload);
  await markWritebackSuccess(payload.record_id);
};

/**
 * 兼容两种调用形态：
 *   1. queue 派发：handler(job) → job.payload 是 inner payload
 *   2. 直接调用：handler(payload) → payload 本身就是 inner payload
 * 判定：若入参有 .payload 且 .payload 是 object → 当作 job；否则当作 payload
 */
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

/** 测试 helper：临时 JSONL 路径（每个 case 独立）。 */
export function tempLisWritebackPath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lab-writeback-')),
    'lis-writeback.ndjson',
  );
}

/** 类型导出供外部使用。 */
export type { LisWritebackRow as LisWritebackLine };