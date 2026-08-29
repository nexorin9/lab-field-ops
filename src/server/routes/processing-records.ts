// src/server/routes/processing-records.ts
//
// 处理记录 REST API：
//   - POST /api/processing-records                  → 新建一条 received 态记录
//   - GET  /api/processing-records/:id              → 单条详情
//   - POST /api/processing-records/:id/confirm      → 状态机推进 + 队列入队（Task 17）
//   - POST /api/processing-records/:id/retry        → failed → verified 重投 + 队列入队（Task 25）
//
// 设计取舍：
//   - POST 创建时 record_id 由服务端生成（randomUUID），避免客户端重复 ID。
//   - 必填字段校验：instrument_id + alarm_code + operator_id；其余可选。
//   - 不直改 LIS 业务库；写回走 /api/processing-records/:id/confirm → 队列。
//   - 入参 instrument_id 必须存在（外键）；缺失返 404（NOT_FOUND）。
//   - confirm 端点幂等：二次 confirm 不重复 UPDATE、不重复入队，返回当前态。
//     跳步非法（received/parsed 时直接 enqueue）抛 STATE_MACHINE_ERROR → 409。
//
// confirm 流程：
//   1. load row → state-machine.transition(row, verify) → { nextState, idempotent }
//   2. applyTransition(db, row, result) → UPDATE + 写 audit_event
//   3. 如果 state=verified 且非幂等命中 → enqueue 到 lis-writeback 队列
//      event_id = `confirm:<record_id>`（幂等去重：二次 confirm 不重复入队）
//   4. 队列 handler 成功后 → pushToLisWritebackChannel 会调 transition(writeback_success)
//      把 state 推进到 written_back
//
// retry 流程（Task 25）：
//   1. 入参校验：record id 非空 + body.operator_id 必填
//   2. 仅 failed 状态允许 → 其它状态返 409 CONFLICT（details 含 current_state）
//   3. transition(row, retry) → applied=true（retry 不幂等：每次自增 retry_count）
//   4. applyTransition → UPDATE state=verified, retry_count+1 + 写 audit state_change
//   5. 立即 enqueue 到 lis-writeback 队列（eventId=`retry:<id>:<retryCount>` 唯一）
//   6. enqueue 转移 → state=writeback_pending
//   7. 写 audit processing_record.retry（attempts=retryCount + operatorId）
//   8. 返回 { record, retryCount, enqueued: { id, skipped } }

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import {
  presentProcessingRecord,
  type PresentedProcessingRecord,
  type ProcessingRecordRow,
} from '../presenters/processingRecord.js';
import { appendAudit } from '../audit/ledger.js';
import {
  StateMachineError,
  runConfirmFlow,
  transition,
  applyTransition,
  getProcessingRecordStateRow,
} from '../processing/state-machine.js';
import type { Queue } from '../queue/index.js';
import { registerAllTasks } from '../queue/register.js';
import type { RouteResponse, ApiErrorBody } from './queue.js';
import { apiErrorResponse } from '../errors.js';

export interface ProcessingRecordRouteContext {
  db(): Database;
  /** 取得 lis-writeback 队列（用于 confirm 后入队）。 */
  writebackQueue(): Queue | null;
}

export function defaultProcessingRecordRouteContext(): ProcessingRecordRouteContext {
  return {
    db: () => getDb(),
    writebackQueue: () => {
      try {
        const { writebackQueue } = registerAllTasks();
        return writebackQueue;
      } catch {
        return null;
      }
    },
  };
}

/** POST /api/processing-records 请求体形态。 */
export interface CreateProcessingRecordBody {
  instrument_id?: string;
  alarm_code?: string;
  operator_id?: string;
  root_cause?: string;
  steps?: string[];
  accession_no?: string | null;
  payload?: Record<string, unknown>;
}

/** POST /api/processing-records/:id/confirm 请求体形态。 */
export interface ConfirmProcessingRecordBody {
  operator_id?: string;
}

/** POST /api/processing-records/:id/retry 请求体形态。 */
export interface RetryProcessingRecordBody {
  operator_id?: string;
}

/** 校验后的标准化数据形态。 */
interface ValidatedProcessingRecordData {
  instrument_id: string;
  alarm_code: string;
  operator_id: string;
  root_cause: string;
  steps: string[];
  accession_no: string | null;
  payload: Record<string, unknown>;
}

/** 校验创建请求体；返回标准化结果或错误。 */
function validateCreateBody(
  body: unknown,
):
  | { ok: true; data: ValidatedProcessingRecordData }
  | { ok: false; errors: string[] } {
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const b = body as CreateProcessingRecordBody;
  const errors: string[] = [];
  if (!b.instrument_id || typeof b.instrument_id !== 'string') {
    errors.push('instrument_id is required');
  }
  if (!b.alarm_code || typeof b.alarm_code !== 'string') {
    errors.push('alarm_code is required');
  }
  if (!b.operator_id || typeof b.operator_id !== 'string') {
    errors.push('operator_id is required');
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      instrument_id: b.instrument_id!,
      alarm_code: b.alarm_code!,
      operator_id: b.operator_id!,
      root_cause: b.root_cause ?? '',
      steps: Array.isArray(b.steps) ? b.steps.map(String) : [],
      accession_no: b.accession_no ?? null,
      payload: b.payload ?? {},
    },
  };
}

/** POST /api/processing-records — 创建一条 received 态记录 */
export function postProcessingRecordRoute(
  _params: Record<string, string>,
  _query: Record<string, string>,
  body: unknown,
  ctx: ProcessingRecordRouteContext = defaultProcessingRecordRouteContext(),
): RouteResponse<PresentedProcessingRecord | ApiErrorBody> {
  const v = validateCreateBody(body);
  if (!v.ok) {
    return apiErrorResponse('VALIDATION_ERROR', v.errors.join('; '));
  }
  const db = ctx.db();
  // 外键校验：instrument 必须存在
  const instrument = db
    .prepare('SELECT 1 AS n FROM instrument WHERE instrument_id = ?')
    .get(v.data.instrument_id) as { n: number } | undefined;
  if (!instrument) {
    return apiErrorResponse(
      'NOT_FOUND',
      `instrument ${v.data.instrument_id} not found`,
    );
  }
  const recordId = randomUUID();
  const now = new Date().toISOString();
  const stepsJson = JSON.stringify(v.data.steps ?? []);
  const payloadJson = JSON.stringify(v.data.payload ?? {});

  db.prepare(
    `INSERT INTO processing_record
       (record_id, instrument_id, alarm_code, operator_id, root_cause,
        steps_json, confirmed_at, state, retry_count, payload_json, accession_no)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'received', 0, ?, ?)`,
  ).run(
    recordId,
    v.data.instrument_id,
    v.data.alarm_code,
    v.data.operator_id,
    v.data.root_cause,
    stepsJson,
    payloadJson,
    v.data.accession_no,
  );

  // audit
  appendAudit({
    kind: 'processing_record.created',
    operatorId: v.data.operator_id,
    payload: {
      record_id: recordId,
      instrument_id: v.data.instrument_id,
      alarm_code: v.data.alarm_code,
    },
  });

  const row = db
    .prepare('SELECT * FROM processing_record WHERE record_id = ?')
    .get(recordId) as ProcessingRecordRow;
  return { status: 201, body: presentProcessingRecord(row) };
}

/** GET /api/processing-records/:id — 详情 */
export function getProcessingRecordByIdRoute(
  params: Record<string, string>,
  _query: Record<string, string>,
  _body: unknown,
  ctx: ProcessingRecordRouteContext = defaultProcessingRecordRouteContext(),
): RouteResponse<PresentedProcessingRecord | ApiErrorBody> {
  const id = params.id;
  if (!id) {
    return apiErrorResponse('VALIDATION_ERROR', 'record id is required');
  }
  const row = ctx
    .db()
    .prepare('SELECT * FROM processing_record WHERE record_id = ?')
    .get(id) as ProcessingRecordRow | undefined;
  if (!row) {
    return apiErrorResponse('NOT_FOUND', `processing_record ${id} not found`);
  }
  return { status: 200, body: presentProcessingRecord(row) };
}

/**
 * POST /api/processing-records/:id/confirm — 状态机推进 + 入队
 *
 * 入参：{ operator_id: string }
 * 响应 200：{ record: PresentedProcessingRecord, idempotent: boolean, enqueued: { id, skipped } }
 * 响应 400：{ error: { code: 'VALIDATION_ERROR' } }
 * 响应 404：{ error: { code: 'NOT_FOUND' } }
 * 响应 409：{ error: { code: 'STATE_MACHINE_ERROR' } }
 *
 * 幂等语义：同 recordId 二次 confirm 返回当前态 + idempotent=true，不重复入队。
 */
export function postProcessingRecordConfirmRoute(
  params: Record<string, string>,
  _query: Record<string, string>,
  body: unknown,
  ctx: ProcessingRecordRouteContext = defaultProcessingRecordRouteContext(),
): RouteResponse<
  | {
      record: PresentedProcessingRecord;
      idempotent: boolean;
      enqueued: { id: string; skipped: boolean } | null;
    }
  | ApiErrorBody
> {
  const id = params.id;
  if (!id) {
    return apiErrorResponse('VALIDATION_ERROR', 'record id is required');
  }
  const operatorId =
    body && typeof body === 'object'
      ? (body as ConfirmProcessingRecordBody).operator_id
      : undefined;
  if (!operatorId || typeof operatorId !== 'string') {
    return apiErrorResponse('VALIDATION_ERROR', 'operator_id is required');
  }

  const db = ctx.db();
  // 先做状态机推进
  let flowResult: ReturnType<typeof runConfirmFlow>;
  try {
    flowResult = runConfirmFlow(db, id, operatorId)!;
  } catch (err: unknown) {
    if (err instanceof StateMachineError) {
      return apiErrorResponse('STATE_MACHINE_ERROR', err.message, {
        record_id: err.recordId,
        from_state: err.fromState,
        event: err.event,
      });
    }
    throw err;
  }
  if (!flowResult) {
    return apiErrorResponse('NOT_FOUND', `processing_record ${id} not found`);
  }

  // 决定是否入队：
  // - 幂等命中 + 当前态已经在 writeback_pending / written_back → 不重复入队
  // - verify 后状态为 verified（首次 verify 成功）→ 入队；再 enqueue 转移 → writeback_pending
  let enqueued: { id: string; skipped: boolean } | null = null;
  const { transitionResult, applied } = flowResult;
  if (applied && transitionResult.nextState === 'verified') {
    // 首次 verify 成功：现在执行 enqueue 事件
    const queue = ctx.writebackQueue();
    if (queue) {
      // 读取当前 row 完整数据（confirmed_at 已写）
      const rowFull = db
        .prepare('SELECT * FROM processing_record WHERE record_id = ?')
        .get(id) as ProcessingRecordRow;
      // event_id 用 `confirm:<record_id>` 做幂等去重（二次 confirm 不会重复入队）
      const enqueueResult = queue.enqueue(
        {
          record_id: rowFull.record_id,
          instrument_id: rowFull.instrument_id,
          alarm_code: rowFull.alarm_code,
          accession_no: rowFull.accession_no,
          operator_id: operatorId,
          root_cause: rowFull.root_cause,
          steps: presentProcessingRecord(rowFull).steps,
          confirmed_at: rowFull.confirmed_at,
        },
        { eventId: `confirm:${rowFull.record_id}` },
      );
      // enqueue → writeback_pending 转移
      if (!enqueueResult.skipped) {
        const stateRow = getProcessingRecordStateRow(db, id)!;
        const enqResult = transition(stateRow, { type: 'enqueue' });
        applyTransition(db, stateRow, enqResult, null);
      }
      enqueued = enqueueResult.skipped
        ? { id: '', skipped: true }
        : { id: enqueueResult.id, skipped: false };
    }
  }

  // 拿最新 row 返回
  const freshRow = db
    .prepare('SELECT * FROM processing_record WHERE record_id = ?')
    .get(id) as ProcessingRecordRow;
  return {
    status: 200,
    body: {
      record: presentProcessingRecord(freshRow),
      idempotent: !applied,
      enqueued,
    },
  };
}

/**
 * POST /api/processing-records/:id/retry — failed → verified 重投 + 队列入队
 *
 * 入参：{ operator_id: string }
 * 响应 200：{ record: PresentedProcessingRecord, retryCount: number, enqueued: { id, skipped } }
 * 响应 400：{ error: { code: 'VALIDATION_ERROR' } } —— id 缺失 / operator_id 缺失
 * 响应 404：{ error: { code: 'NOT_FOUND' } } —— record 不存在
 * 响应 409：{ error: { code: 'CONFLICT', details: { current_state } } } —— 当前态非 failed
 *                                  （如 received / parsed / verified / writeback_pending / written_back）
 *
 * 语义：
 *   - 仅 state=failed 允许重投；其它状态返 409 CONFLICT（与 spec.md 工作闭环一致）
 *   - 重投不幂等：每次调用 retry_count+1（保留重试历史计数）
 *   - 立即入队到 lis-writeback，eventId=`retry:<record_id>:<retryCount>` 保证唯一
 *     （避免与 confirm 的 `confirm:<record_id>` 互相 dedupe 干扰）
 *   - 队列 handler 成功后 → markWritebackSuccess 把 state 推进到 written_back
 *
 * 与 confirm 的差异：
 *   - confirm 端点 eventId 是稳定的（`confirm:<id>`，二次 confirm 幂等）
 *   - retry 端点 eventId 每次变化（`retry:<id>:<retryCount>`，多次 retry 各自入队）
 */
export function postProcessingRecordRetryRoute(
  params: Record<string, string>,
  _query: Record<string, string>,
  body: unknown,
  ctx: ProcessingRecordRouteContext = defaultProcessingRecordRouteContext(),
): RouteResponse<
  | {
      record: PresentedProcessingRecord;
      retryCount: number;
      enqueued: { id: string; skipped: boolean } | null;
    }
  | ApiErrorBody
> {
  const id = params.id;
  if (!id) {
    return apiErrorResponse('VALIDATION_ERROR', 'record id is required');
  }
  const operatorId =
    body && typeof body === 'object'
      ? (body as RetryProcessingRecordBody).operator_id
      : undefined;
  if (!operatorId || typeof operatorId !== 'string') {
    return apiErrorResponse('VALIDATION_ERROR', 'operator_id is required');
  }

  const db = ctx.db();
  // 拿 row；如果不存在 → 404
  const row = getProcessingRecordStateRow(db, id);
  if (!row) {
    return apiErrorResponse('NOT_FOUND', `processing_record ${id} not found`);
  }

  // 仅 failed 允许重投；其它态返 409（带 current_state 让前端可显示「为什么不能重投」）
  if (row.state !== 'failed') {
    return apiErrorResponse(
      'CONFLICT',
      `processing_record ${id} is in state '${row.state}', cannot retry (only 'failed' records can be retried)`,
      { current_state: row.state, retry_count: row.retry_count },
    );
  }

  // retry 事件：failed → verified + retry_count+1（不幂等）
  const transitionResult = transition(row, { type: 'retry' });
  applyTransition(db, row, transitionResult);

  // 取最新 retry_count
  const newRetryCount = transitionResult.sideEffects.retryCount ?? row.retry_count + 1;

  // 入队 lis-writeback（eventId 用 retry:<id>:<retryCount> 保证每次 retry 独立）
  let enqueued: { id: string; skipped: boolean } | null = null;
  const queue = ctx.writebackQueue();
  if (queue) {
    // 拿完整 row（含 root_cause / steps / payload_json）
    const rowFull = db
      .prepare('SELECT * FROM processing_record WHERE record_id = ?')
      .get(id) as ProcessingRecordRow;
    const enqueueResult = queue.enqueue(
      {
        record_id: rowFull.record_id,
        instrument_id: rowFull.instrument_id,
        alarm_code: rowFull.alarm_code,
        accession_no: rowFull.accession_no,
        operator_id: operatorId,
        root_cause: rowFull.root_cause,
        steps: presentProcessingRecord(rowFull).steps,
        confirmed_at: rowFull.confirmed_at,
        retry_count: newRetryCount,
      },
      { eventId: `retry:${rowFull.record_id}:${newRetryCount}` },
    );
    if (!enqueueResult.skipped) {
      // enqueue 转移 → writeback_pending
      const stateRow = getProcessingRecordStateRow(db, id)!;
      const enqResult = transition(stateRow, { type: 'enqueue' });
      applyTransition(db, stateRow, enqResult, null);
    }
    enqueued = enqueueResult.skipped
      ? { id: '', skipped: true }
      : { id: enqueueResult.id, skipped: false };
  }

  // 写 processing_record.retry 审计（独立于 state_change；attempts=retryCount）
  appendAudit({
    kind: 'processing_record.retry',
    operatorId,
    payload: {
      record_id: id,
      attempts: newRetryCount,
    },
  });

  // 拿最新 row 返回
  const freshRow = db
    .prepare('SELECT * FROM processing_record WHERE record_id = ?')
    .get(id) as ProcessingRecordRow;
  return {
    status: 200,
    body: {
      record: presentProcessingRecord(freshRow),
      retryCount: newRetryCount,
      enqueued,
    },
  };
}