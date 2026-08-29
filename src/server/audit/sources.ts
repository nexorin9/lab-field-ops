// src/server/audit/sources.ts
//
// Audit event sources：把所有 audit 落盘入口收敛到一处。
//
// 设计目的：
//   1) 强制统一 payload 字段命名（便于 queryAudit / DashboardPage 检索）
//   2) 一处变更不影响所有调用方（避免插件/队列各自写 payload 漂移）
//   3) 让审计路径「可被静态发现」——grep `auditSource.recordXxx` 即可列出所有
//      审计事件来源
//
// 调用约定：
//   - 各模块在生命周期关键点调 `auditSource.recordXxx({...})`
//   - 字段命名与 spec.md 工作闭环 / 参考地基第 3-6 行对齐
//   - 不强制调用方传 operatorId（CLI 调用时为 null）
//
// 不修改原 ledger.ts 的 appendAudit 签名；本文件只是薄包装层。

import { appendAudit } from './ledger.js';
import type {
  AuditEventKind,
  HashString,
  JSONPayload,
} from '@shared/types.js';

/** auditSource.recordXxx 入参公共字段。 */
interface RecordBase {
  /** 操作员 ID（CLI 自动化 = null；REST 受 token 注入时填值）。 */
  operatorId?: string | null;
  /** 关联事件 ID（事件链串联，Task 23 replay 用）。 */
  relatedEventId?: string | null;
  /** 额外字段（合并到 payload_json 后落盘）。 */
  extra?: JSONPayload;
}

/** payload 合并：基础字段 + 额外字段，后者优先级更高。 */
function mergePayload(base: JSONPayload, extra: JSONPayload | undefined): JSONPayload {
  if (!extra) return base;
  return { ...base, ...extra };
}

/** 统一审计来源入口（命名空间对象，便于静态发现）。 */
export const auditSource = {
  // ---- plugin 生命周期 ----
  pluginAdd(args: {
    name: string;
    version: string;
    queueName?: string | null;
    hooks: string[];
  } & RecordBase): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'plugin.add',
      operatorId: args.operatorId ?? null,
      relatedEventId: args.relatedEventId ?? null,
      payload: mergePayload(
        {
          name: args.name,
          version: args.version,
          queue_name: args.queueName ?? null,
          hooks: args.hooks,
        },
        args.extra,
      ),
    });
  },

  pluginRemove(args: {
    name: string;
    queueName?: string | null;
    uninstallTriggered: boolean;
  } & RecordBase): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'plugin.remove',
      operatorId: args.operatorId ?? null,
      relatedEventId: args.relatedEventId ?? null,
      payload: mergePayload(
        {
          name: args.name,
          queue_name: args.queueName ?? null,
          uninstall_triggered: args.uninstallTriggered,
        },
        args.extra,
      ),
    });
  },

  pluginUninstall(args: {
    name: string;
    triggeredBy: 'cli' | 'manager' | 'uninstall_hook';
    success: boolean;
  } & RecordBase): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'plugin.uninstall',
      operatorId: args.operatorId ?? null,
      relatedEventId: args.relatedEventId ?? null,
      payload: mergePayload(
        {
          name: args.name,
          triggered_by: args.triggeredBy,
          success: args.success,
        },
        args.extra,
      ),
    });
  },

  // ---- 队列事件 ----
  queueEnqueue(args: {
    queue: string;
    eventId: string;
    jobId: string;
    payloadPreview?: string;
  } & RecordBase): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'queue.enqueue',
      operatorId: args.operatorId ?? null,
      relatedEventId: args.relatedEventId ?? args.eventId,
      payload: mergePayload(
        {
          queue: args.queue,
          job_id: args.jobId,
          event_id: args.eventId,
          payload_preview: args.payloadPreview ?? null,
        },
        args.extra,
      ),
    });
  },

  queueProcess(args: {
    queue: string;
    eventId: string;
    jobId: string;
    attempts: number;
    durationMs?: number;
  } & RecordBase): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'queue.process',
      operatorId: args.operatorId ?? null,
      relatedEventId: args.relatedEventId ?? args.eventId,
      payload: mergePayload(
        {
          queue: args.queue,
          job_id: args.jobId,
          event_id: args.eventId,
          attempts: args.attempts,
          duration_ms: args.durationMs ?? null,
        },
        args.extra,
      ),
    });
  },

  queueFail(args: {
    queue: string;
    eventId: string;
    jobId: string;
    attempts: number;
    error: string;
    nextRunAt: string;
  } & RecordBase): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'queue.fail',
      operatorId: args.operatorId ?? null,
      relatedEventId: args.relatedEventId ?? args.eventId,
      payload: mergePayload(
        {
          queue: args.queue,
          job_id: args.jobId,
          event_id: args.eventId,
          attempts: args.attempts,
          error: args.error,
          next_run_at: args.nextRunAt,
        },
        args.extra,
      ),
    });
  },

  queueFinalFail(args: {
    queue: string;
    eventId: string;
    jobId: string;
    attempts: number;
    error: string;
  } & RecordBase): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'queue.final_fail',
      operatorId: args.operatorId ?? null,
      relatedEventId: args.relatedEventId ?? args.eventId,
      payload: mergePayload(
        {
          queue: args.queue,
          job_id: args.jobId,
          event_id: args.eventId,
          attempts: args.attempts,
          error: args.error,
        },
        args.extra,
      ),
    });
  },

  queueRetry(args: {
    queue: string;
    jobId: string;
    eventId: string;
    operatorId?: string | null;
    relatedEventId?: string | null;
  }): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'queue.retry',
      operatorId: args.operatorId ?? null,
      relatedEventId: args.relatedEventId ?? args.eventId,
      payload: {
        queue: args.queue,
        job_id: args.jobId,
        event_id: args.eventId,
        retried_at: new Date().toISOString(),
      },
    });
  },

  // ---- writeback 通道 ----
  writebackInitiated(args: {
    recordId: string;
    instrumentId?: string | null;
    alarmCode?: string | null;
    operatorId?: string | null;
  }): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'writeback.initiated',
      operatorId: args.operatorId ?? null,
      payload: {
        record_id: args.recordId,
        instrument_id: args.instrumentId ?? null,
        alarm_code: args.alarmCode ?? null,
      },
    });
  },

  writebackSuccess(args: {
    recordId: string;
    target: string;
    instrumentId?: string | null;
    alarmCode?: string | null;
    operatorId?: string | null;
  }): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'writeback.success',
      operatorId: args.operatorId ?? null,
      payload: {
        record_id: args.recordId,
        target: args.target,
        instrument_id: args.instrumentId ?? null,
        alarm_code: args.alarmCode ?? null,
      },
    });
  },

  // ---- processing_record 状态机 ----
  processingRecordCreated(args: {
    recordId: string;
    instrumentId: string;
    alarmCode: string;
    operatorId: string;
    relatedEventId?: string | null;
  }): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'processing_record.created',
      operatorId: args.operatorId,
      relatedEventId: args.relatedEventId ?? null,
      payload: {
        record_id: args.recordId,
        instrument_id: args.instrumentId,
        alarm_code: args.alarmCode,
      },
    });
  },

  processingRecordStateChange(args: {
    recordId: string;
    fromState: string;
    toState: string;
    operatorId?: string | null;
    relatedEventId?: string | null;
  }): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'processing_record.state_change',
      operatorId: args.operatorId ?? null,
      relatedEventId: args.relatedEventId ?? null,
      payload: {
        record_id: args.recordId,
        from_state: args.fromState,
        to_state: args.toState,
      },
    });
  },

  processingRecordRetry(args: {
    recordId: string;
    attempts: number;
    operatorId?: string | null;
  }): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'processing_record.retry',
      operatorId: args.operatorId ?? null,
      payload: {
        record_id: args.recordId,
        attempts: args.attempts,
      },
    });
  },

  // ---- heartbeat ----
  heartbeatDropped(args: {
    instrumentId?: string | null;
    vendor: string;
    model: string;
    reason: 'rate_limit' | 'parse_error' | 'missing_field' | 'other';
    rawHash?: HashString | null;
  }): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'heartbeat.dropped',
      operatorId: null,
      payload: {
        instrument_id: args.instrumentId ?? null,
        vendor: args.vendor,
        model: args.model,
        reason: args.reason,
        raw_hash: args.rawHash ?? null,
      },
    });
  },

  heartbeatReceived(args: {
    calibrationId: string;
    instrumentId: string;
    vendor: string;
    model: string;
  }): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'heartbeat.received',
      operatorId: null,
      payload: {
        calibration_id: args.calibrationId,
        instrument_id: args.instrumentId,
        vendor: args.vendor,
        model: args.model,
      },
    });
  },

  instrumentSeen(args: {
    instrumentId: string;
    vendor: string;
    model: string;
    source: 'heartbeat' | 'cli' | 'rest';
  }): { eventId: string; ts: string } {
    return appendAudit({
      kind: 'instrument.seen',
      operatorId: null,
      payload: {
        instrument_id: args.instrumentId,
        vendor: args.vendor,
        model: args.model,
        source: args.source,
      },
    });
  },
} as const;

/** AuditEventKind 联合类型值的元组（与 src/shared/types.ts 一致）。 */
export const ALL_AUDIT_KINDS: readonly AuditEventKind[] = [
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
];

/** 类型导出供 plugin/queue/routes 等模块按需引入。 */
export type RecordFn = typeof auditSource;