// src/server/processing/state-machine.ts
//
// ProcessingRecord 状态机（Task 17 核心深度）。
//
// 状态转移图（与 spec.md 工作闭环第 3 条 / closure_dimensions 业务状态生命周期对齐）：
//
//   received ── parse ──▶ parsed ── verify ──▶ verified ── enqueue ──▶ writeback_pending
//                                                                  │
//                                                                  ├── success ─▶ written_back (终态)
//                                                                  │
//                                                                  └── fail×5   ─▶ failed (终态可重投)
//
// 不变量：
//   1) 跳步非法：state='received' 时 verify 会抛 StateMachineError
//   2) write-back 必须经 verified → writeback_pending → written_back 三步
//      即不能从 received/parsed 直接入队
//   3) confirm 端点幂等：再次 verify / enqueue / writeback_success 返回当前态
//      + idempotent=true（不重复写 confirmed_at / 不重复入队）
//   4) terminal 状态（written_back / failed）只能转回 verified（retry）
//   5) 每次成功转移：state-machine.ts 本身不写 DB；调用方拿到结果后 UPDATE + 写 audit
//
// 调用约定：
//   transition(row, event) → { nextState, idempotent, sideEffects, auditPayload }
//   调用方负责：DB UPDATE + auditSource.processingRecordStateChange + 触发队列入队

import type { Database } from 'better-sqlite3';
import type { ProcessingRecordState } from '@shared/types.js';
import { auditSource } from '../audit/sources.js';

/** 状态机事件类型。 */
export type ProcessingRecordEvent =
  | { type: 'parse' } // received → parsed
  | { type: 'verify'; operatorId: string } // parsed → verified（操作员确认）
  | { type: 'enqueue' } // verified → writeback_pending（已入队）
  | { type: 'writeback_success'; jobId?: string | null } // writeback_pending → written_back
  | { type: 'fail'; reason: string } // 任何非终态 → failed
  | { type: 'retry' }; // failed → verified（操作员主动重投）

/** 状态机的当前态最小形态（只读 row）。 */
export interface ProcessingRecordStateRow {
  record_id: string;
  state: ProcessingRecordState;
  confirmed_at: string | null;
  retry_count: number;
}

/** transition 返回结果。 */
export interface TransitionResult {
  /** 转移后的状态（可能与 record.state 相同 = 幂等）。 */
  nextState: ProcessingRecordState;
  /** 幂等命中（事件与状态已经匹配，不实际更新）。 */
  idempotent: boolean;
  /** 副作用字段：调用方据此 UPDATE SQL + 写 audit。 */
  sideEffects: {
    /** confirmed_at 应写入的新值（仅 verify 第一次成功时）。 */
    confirmedAt?: string;
    /** confirmed_at 写入对应的 operatorId。 */
    confirmedBy?: string;
    /** retry_count 应自增的值（仅 retry 成功时）。 */
    retryCount?: number;
  };
  /** audit 用的字段（调用方调 auditSource.processingRecordStateChange）。 */
  auditPayload: {
    fromState: ProcessingRecordState;
    toState: ProcessingRecordState;
    operatorId: string | null;
  };
}

/** 状态转移不合法抛错。 */
export class StateMachineError extends Error {
  readonly code = 'STATE_MACHINE_ERROR';
  readonly recordId: string;
  readonly fromState: ProcessingRecordState;
  readonly event: ProcessingRecordEvent['type'];

  constructor(
    recordId: string,
    fromState: ProcessingRecordState,
    event: ProcessingRecordEvent['type'],
    message: string,
  ) {
    super(message);
    this.name = 'StateMachineError';
    this.recordId = recordId;
    this.fromState = fromState;
    this.event = event;
  }
}

/**
 * 合法状态转移图（key = from state；value = 允许的事件类型列表）。
 * 与 transfer 流程严格对应：
 *   received   → parse → parsed
 *   parsed     → verify → verified
 *   verified   → enqueue → writeback_pending
 *   writeback_pending → writeback_success → written_back | fail → failed
 *   failed     → retry → verified（操作员主动重投）
 *   written_back 是终态，仅可被 verify 幂等命中（不实际更新）。
 */
const ALLOWED: Record<ProcessingRecordState, ProcessingRecordEvent['type'][]> = {
  received: ['parse', 'fail'],
  parsed: ['verify', 'fail'],
  verified: ['enqueue', 'fail'],
  writeback_pending: ['writeback_success', 'fail'],
  written_back: [], // 终态
  failed: ['retry', 'fail'], // retry → verified；fail 在已 failed 时幂等
};

/**
 * 幂等命中表：某些事件在特定状态是「已经做过」的别名，调用方拿到 idempotent=true
 * 不必 UPDATE / 入队，仅返回当前态。
 *
 * 设计原则：每个事件只对「已经做过该事件」的状态幂等命中；其它状态走 ALLOWED 校验，
 * 非法则抛 StateMachineError。
 */
const IDEMPOTENT_HITS: Record<
  ProcessingRecordEvent['type'],
  ProcessingRecordState[]
> = {
  // parse 只对「已经 parsed」幂等；其它态要么正常推进要么抛错
  parse: ['parsed'],
  // verify 是 confirm 端点的核心，幂等覆盖 verified/writeback_pending/written_back
  verify: ['verified', 'writeback_pending', 'written_back'],
  // enqueue 幂等覆盖 writeback_pending/written_back
  enqueue: ['writeback_pending', 'written_back'],
  // writeback_success 幂等仅 written_back
  writeback_success: ['written_back'],
  // fail 幂等 failed
  fail: ['failed'],
  // retry 不幂等：每次 retry 都自增 retry_count；其它态抛错
  retry: [],
};

/** 计算目标态（不含幂等分支）。 */
function targetStateFor(
  event: ProcessingRecordEvent['type'],
): ProcessingRecordState | null {
  switch (event) {
    case 'parse':
      return 'parsed';
    case 'verify':
      return 'verified';
    case 'enqueue':
      return 'writeback_pending';
    case 'writeback_success':
      return 'written_back';
    case 'fail':
      return 'failed';
    case 'retry':
      return 'verified';
    default:
      return null;
  }
}

/**
 * 状态转移核心：纯函数，输入 row + event，返回 TransitionResult；
 * 不写 DB / 不发队列 — 由调用方根据 sideEffects 自行 UPDATE + 入队 + 写 audit。
 *
 * 幂等语义：
 *   - 同 recordId 二次 confirm（verify）：如果当前态已经是 verified / writeback_pending /
 *     written_back 中的任一态，返回 nextState = 当前态 + idempotent=true + confirmedAt 不变
 *   - 同 recordId 二次 enqueue：当前态已经是 writeback_pending / written_back，返回幂等
 *   - 同 recordId 二次 fail：当前态已经是 failed，返回幂等
 *
 * 跳步非法：
 *   - state='received' 时 verify → 抛 StateMachineError
 *   - state='parsed' 时 enqueue → 抛 StateMachineError
 *   - state='verified' 时 writeback_success → 抛 StateMachineError（必须先入队）
 */
export function transition(
  row: ProcessingRecordStateRow,
  event: ProcessingRecordEvent,
  now: string = new Date().toISOString(),
): TransitionResult {
  const { record_id, state: currentState } = row;

  // 幂等命中分支
  const idempotentStates = IDEMPOTENT_HITS[event.type] ?? [];
  if (idempotentStates.includes(currentState)) {
    return {
      nextState: currentState,
      idempotent: true,
      sideEffects: {},
      auditPayload: {
        fromState: currentState,
        toState: currentState,
        operatorId:
          event.type === 'verify'
            ? (event as { operatorId: string }).operatorId
            : null,
      },
    };
  }

  // 正常转移分支
  const allowed = ALLOWED[currentState] ?? [];
  if (!allowed.includes(event.type)) {
    throw new StateMachineError(
      record_id,
      currentState,
      event.type,
      `cannot apply event '${event.type}' to record ${record_id} in state '${currentState}'`,
    );
  }

  const nextState = targetStateFor(event.type);
  if (!nextState) {
    // 理论上不可能（ALLOWED 与 targetStateFor 同源）；保留防御
    throw new StateMachineError(
      record_id,
      currentState,
      event.type,
      `no target state mapped for event '${event.type}'`,
    );
  }

  // 计算副作用
  const sideEffects: TransitionResult['sideEffects'] = {};
  if (event.type === 'verify') {
    // 第一次 verify：写 confirmed_at + 标记操作员
    sideEffects.confirmedAt = now;
    sideEffects.confirmedBy = event.operatorId;
  } else if (event.type === 'retry') {
    // retry：retry_count 自增 1（保留历史重试计数）
    sideEffects.retryCount = (row.retry_count ?? 0) + 1;
  }

  const auditPayload: TransitionResult['auditPayload'] = {
    fromState: currentState,
    toState: nextState,
    operatorId:
      event.type === 'verify'
        ? (event as { operatorId: string }).operatorId
        : null,
  };

  return { nextState, idempotent: false, sideEffects, auditPayload };
}

/**
 * 把 transition 结果应用到 DB（更新 state / confirmed_at / retry_count）+ 写 audit。
 * 这是 high-level helper：调用方拿到 row → transition() → 拿到 TransitionResult →
 * 调 applyTransition(db, row, result) 一条龙搞定。
 *
 * 幂等分支：不执行 UPDATE，不写 audit（因为没有状态变化）。返回 false 表示「幂等未落盘」。
 * 正常分支：执行 UPDATE + audit，返回 true 表示「已落盘」。
 */
export function applyTransition(
  db: Database,
  row: ProcessingRecordStateRow,
  result: TransitionResult,
  relatedEventId?: string | null,
): boolean {
  if (result.idempotent) return false;
  const { record_id } = row;
  const updates: string[] = ['state = ?'];
  const params: unknown[] = [result.nextState];
  if (result.sideEffects.confirmedAt) {
    updates.push('confirmed_at = ?');
    params.push(result.sideEffects.confirmedAt);
  }
  if (typeof result.sideEffects.retryCount === 'number') {
    updates.push('retry_count = ?');
    params.push(result.sideEffects.retryCount);
  }
  params.push(record_id);
  db.prepare(
    `UPDATE processing_record SET ${updates.join(', ')} WHERE record_id = ?`,
  ).run(...params);
  auditSource.processingRecordStateChange({
    recordId: record_id,
    fromState: result.auditPayload.fromState,
    toState: result.auditPayload.toState,
    operatorId: result.auditPayload.operatorId,
    relatedEventId: relatedEventId ?? null,
  });
  return true;
}

/**
 * 拿当前 row 的 DB 行（state + confirmed_at + retry_count）。
 * 调用方提供 db，便于测试注入。
 */
export function getProcessingRecordStateRow(
  db: Database,
  recordId: string,
): ProcessingRecordStateRow | undefined {
  const row = db
    .prepare(
      'SELECT record_id, state, confirmed_at, retry_count FROM processing_record WHERE record_id = ?',
    )
    .get(recordId) as
    | {
        record_id: string;
        state: ProcessingRecordState;
        confirmed_at: string | null;
        retry_count: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    record_id: row.record_id,
    state: row.state,
    confirmed_at: row.confirmed_at,
    retry_count: row.retry_count,
  };
}

/**
 * confirm 流程的一站式封装：拿 row → verify → applyTransition。
 * 用于 routes/processing-records.ts 的 POST /confirm 端点。
 *
 * 语义：
 *   - 状态在 received/parsed：执行 verify（parsed → verified；received → 抛 STATE_MACHINE_ERROR）
 *   - 状态在 verified/writeback_pending/written_back：幂等返回当前态，不写 confirmed_at
 *   - 状态在 failed：可执行 retry（→ verified + retry_count+1），但这由调用方决定 —
 *     confirm 端点只 verify，不主动 retry（retry 是另一个端点 /api/processing-records/:id/retry）
 *
 * 返回：
 *   { record, transitionResult, applied } —— applied 表示是否实际写了 DB
 */
export interface ConfirmFlowResult {
  record: ProcessingRecordStateRow;
  transitionResult: TransitionResult;
  applied: boolean;
}

export function runConfirmFlow(
  db: Database,
  recordId: string,
  operatorId: string,
): ConfirmFlowResult | undefined {
  const row = getProcessingRecordStateRow(db, recordId);
  if (!row) return undefined;
  const result = transition(row, { type: 'verify', operatorId });
  const applied = applyTransition(db, row, result);
  // 拿回最新 row（含新 confirmed_at）
  const fresh = getProcessingRecordStateRow(db, recordId);
  return {
    record: fresh ?? row,
    transitionResult: result,
    applied,
  };
}
