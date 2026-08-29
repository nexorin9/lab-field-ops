// src/server/errors.ts
//
// 统一错误码 + REST 错误响应语义（Task 24）。
//
// 背景：
//   - REST 响应在 routes/*.ts 之间原本各写各的 `{error:{code,message}}`，
//     错误形态分散、code 字面量散落，缺少类型保护。
//   - 本文件定义统一的 ErrorCode 字面量集合 + AppError 基类与 6 个子类 + helpers，
//     让 routes 一律走 `appErrorToStatus(err)` / `appErrorToBody(err)`。
//
// 设计取舍：
//   - AppError 既是 Error 子类，又承载 code/httpStatus/details 三元组；
//     既可在 routes 内部 `throw`，也可被旧版 return-style routes 通过工厂函数直接构造。
//   - routes 不强制改 throw-style：构造工厂 + 直接 return 仍兼容（保留 e2e 既有用法）。
//   - 内部模块（queue observer / ssrfFetch / state-machine）的现有错误类
//     (QueueObserverError / SSRFError / StateMachineError) 通过 `toAppError()` 适配
//     到 AppError 体系，本文件不强行重写以免破坏既有测试。
//   - schema 锁：tests/contracts.test.ts 同时锁 ErrorCode 字面量集合与每个子类的
//     (code, httpStatus) 元组；增删错误码会触发测试失败。

/** REST 错误响应统一形态（迁移自 routes/queue.ts）。 */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** 当前 contract v1 支持的错误码字面量集合。 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'STATE_MACHINE_ERROR'
  | 'SSRF_DENIED'
  | 'PLUGIN_CAPABILITY_DENIED';

/** 错误码 → HTTP 状态映射（真源，本文件外只读）。 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STATE_MACHINE_ERROR: 409,
  SSRF_DENIED: 403,
  PLUGIN_CAPABILITY_DENIED: 403,
};

/** AppError 基类。子类必须声明 `code` 与 `httpStatus`。 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    if (details) this.details = details;
  }

  /** 把 AppError 转为 REST 响应 body。 */
  toBody(): ApiErrorBody {
    return appErrorToBody(this);
  }
}

/** 400 — 请求参数缺失或类型不合法。 */
export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 400;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** 404 — 资源不存在（仪器 / 报警码 / 处理记录 / job 等）。 */
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** 409 — 资源状态冲突（如非 failed 状态 retry、payload 已写过等）。 */
export class ConflictError extends AppError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** 409 — 状态机非法转移（extend `STATE_MACHINE_ERROR`）。 */
export class StateMachineErrorCode extends AppError {
  readonly code = 'STATE_MACHINE_ERROR';
  readonly httpStatus = 409;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** 403 — SSRF 拒绝（解析出来的 IP 在 deny 列表 / RFC1918 / loopback / link-local）。 */
export class SsrfDeniedError extends AppError {
  readonly code = 'SSRF_DENIED';
  readonly httpStatus = 403;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** 403 — plugin 注册时 capability 越界（hook type / queueName / 不在白名单）。 */
export class PluginCapabilityDeniedError extends AppError {
  readonly code = 'PLUGIN_CAPABILITY_DENIED';
  readonly httpStatus = 403;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** AppError → REST 状态码。 */
export function appErrorToStatus(err: AppError): number {
  return err.httpStatus;
}

/** AppError → ApiErrorBody。 */
export function appErrorToBody(err: AppError): ApiErrorBody {
  const out: ApiErrorBody = {
    error: {
      code: err.code,
      message: err.message,
    },
  };
  if (err.details && Object.keys(err.details).length > 0) {
    out.error.details = err.details;
  }
  return out;
}

/** Convenience factory：把 AppError 一次性转为 `{status, body}` 响应。 */
export function appErrorToResponse(err: AppError): {
  status: number;
  body: ApiErrorBody;
} {
  return { status: appErrorToStatus(err), body: appErrorToBody(err) };
}

/**
 * 用 ErrorCode + message 构造 ApiErrorBody 的便捷 helper。
 * 内部走 ERROR_HTTP_STATUS 表，避免字面量漂移。
 * 适用场景：routes 层只想构造响应而不必 new 一个 AppError 实例。
 */
export function apiErrorBody(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  const body: ApiErrorBody = { error: { code, message } };
  if (details && Object.keys(details).length > 0) {
    body.error.details = details;
  }
  return body;
}

/** 同 apiErrorBody，但同时返回 status（与 ERROR_HTTP_STATUS 同步）。 */
export function apiErrorResponse(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): { status: number; body: ApiErrorBody } {
  return { status: ERROR_HTTP_STATUS[code], body: apiErrorBody(code, message, details) };
}

/**
 * 把任意值安全地适配到 AppError（用于 catch 块）：
 *   - 已是 AppError → 原样返回
 *   - 已知 Error 子类 → 按 code 字段映射（SSRFError / StateMachineError / QueueObserverError）
 *   - 其它 Error 或未知值 → 包成 ValidationError('internal error: ...')
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === 'SSRF_DENIED') {
      return new SsrfDeniedError(err.message, extractDetails(err));
    }
    if (code === 'STATE_MACHINE_ERROR') {
      return new StateMachineErrorCode(err.message, extractDetails(err));
    }
    if (code === 'NOT_FOUND') {
      return new NotFoundError(err.message, extractDetails(err));
    }
    if (code === 'CONFLICT') {
      return new ConflictError(err.message, extractDetails(err));
    }
    return new ValidationError(`internal error: ${err.message}`);
  }
  return new ValidationError(`internal error: ${String(err)}`);
}

/** 从已知 Error 子类提取 details（约定：recordId/fromState/event 等）。 */
function extractDetails(err: Error): Record<string, unknown> | undefined {
  const anyErr = err as unknown as Record<string, unknown>;
  const keys = ['recordId', 'record_id', 'fromState', 'from_state', 'event', 'host', 'resolvedIp', 'jobId', 'queueName', 'name'];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (anyErr[k] !== undefined) out[k] = anyErr[k];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
