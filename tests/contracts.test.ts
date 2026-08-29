// tests/contracts.test.ts
//
// Task 24 — presenter 字段 schema 锁定 + REST 错误码语义。
//
// 守护：
//   1. 6 个 presenter v1 contract（Zod schema）字段命名 / 类型 / nullable 锁住
//   2. ERROR_HTTP_STATUS 与 ErrorCode 字面量集合、Zod 契约三方一致
//   3. AppError 6 个子类：code + httpStatus + body 映射正确
//   4. toAppError() 把已知 Error 子类正确适配到 AppError 体系
//   5. validatePresenterOutput() 把示例 fixture 锁住（snapshot via expected key set）
//
// 注意：本文件不依赖任何 DB / plugin 单例；纯类型 + Zod + 错误类构造测试。

import { describe, it, expect } from 'vitest';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  StateMachineErrorCode,
  SsrfDeniedError,
  PluginCapabilityDeniedError,
  apiErrorBody,
  apiErrorResponse,
  appErrorToBody,
  appErrorToResponse,
  toAppError,
  type ErrorCode,
  ERROR_HTTP_STATUS,
} from '../src/server/errors.js';
import {
  InstrumentContractV1,
  AlarmCodeContractV1,
  CalibrationContractV1,
  ProcessingRecordContractV1,
  PluginContractV1,
  AuditEventContractV1,
  ALL_CONTRACTS_V1,
  CONTRACT_VERSION,
  validatePresenterOutput,
  ErrorCodeContract,
} from '../src/server/presenters/contracts.js';
import {
  presentInstrument,
  type InstrumentRow,
} from '../src/server/presenters/instrument.js';
import {
  presentAlarmCode,
  type AlarmCodeRow,
} from '../src/server/presenters/alarmCode.js';
import {
  presentCalibration,
  type CalibrationRow,
} from '../src/server/presenters/calibration.js';
import {
  presentProcessingRecord,
  type ProcessingRecordRow,
} from '../src/server/presenters/processingRecord.js';
import {
  presentPlugin,
} from '../src/server/presenters/plugin.js';
import {
  presentAuditEvent,
  type AuditEventRow,
} from '../src/server/presenters/auditEvent.js';
import type { PluginEntry } from '../src/server/plugin/types.js';

// ───────────────────────────── 1. Contract version ─────────────────────────────

describe('contract version pin', () => {
  it('CONTRACT_VERSION === "1"', () => {
    expect(CONTRACT_VERSION).toBe('1');
  });

  it('6 个 v1 contracts 已注册', () => {
    expect(ALL_CONTRACTS_V1).toHaveLength(6);
    expect(ALL_CONTRACTS_V1).toContain(InstrumentContractV1);
    expect(ALL_CONTRACTS_V1).toContain(AlarmCodeContractV1);
    expect(ALL_CONTRACTS_V1).toContain(CalibrationContractV1);
    expect(ALL_CONTRACTS_V1).toContain(ProcessingRecordContractV1);
    expect(ALL_CONTRACTS_V1).toContain(PluginContractV1);
    expect(ALL_CONTRACTS_V1).toContain(AuditEventContractV1);
  });

  it('每个 schema 自带 description 标 v1（防 silent bump）', () => {
    for (const c of ALL_CONTRACTS_V1) {
      expect(c.description).toMatch(/v1$/);
    }
  });
});

// ───────────────────────────── 2. ERROR_HTTP_STATUS 三方一致 ─────────────────────────────

describe('error code → http status', () => {
  it('ERROR_HTTP_STATUS 与 ErrorCodeContract (Zod schema) 一致', () => {
    const r = ErrorCodeContract.safeParse(ERROR_HTTP_STATUS);
    expect(r.success).toBe(true);
  });

  it('6 个 ErrorCode 字面量都有正确 HTTP 状态', () => {
    const expected: Record<ErrorCode, number> = {
      VALIDATION_ERROR: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      STATE_MACHINE_ERROR: 409,
      SSRF_DENIED: 403,
      PLUGIN_CAPABILITY_DENIED: 403,
    };
    for (const code of Object.keys(expected) as ErrorCode[]) {
      expect(ERROR_HTTP_STATUS[code]).toBe(expected[code]);
    }
  });
});

// ───────────────────────────── 3. AppError 6 个子类家族 ─────────────────────────────

describe('AppError subclasses', () => {
  it('ValidationError → 400, code VALIDATION_ERROR', () => {
    const err = new ValidationError('oops', { field: 'x' });
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.httpStatus).toBe(400);
    expect(err.details).toEqual({ field: 'x' });
  });

  it('NotFoundError → 404', () => {
    const err = new NotFoundError('item missing');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('ConflictError → 409', () => {
    const err = new ConflictError('state mismatch');
    expect(err.code).toBe('CONFLICT');
    expect(err.httpStatus).toBe(409);
  });

  it('StateMachineErrorCode → 409 + STATE_MACHINE_ERROR', () => {
    const err = new StateMachineErrorCode('cannot transfer', {
      from_state: 'received',
      event: 'enqueue',
    });
    expect(err.code).toBe('STATE_MACHINE_ERROR');
    expect(err.httpStatus).toBe(409);
    expect(err.details).toEqual({ from_state: 'received', event: 'enqueue' });
  });

  it('SsrfDeniedError → 403', () => {
    const err = new SsrfDeniedError('RFC1918');
    expect(err.code).toBe('SSRF_DENIED');
    expect(err.httpStatus).toBe(403);
  });

  it('PluginCapabilityDeniedError → 403', () => {
    const err = new PluginCapabilityDeniedError('unknown hook type');
    expect(err.code).toBe('PLUGIN_CAPABILITY_DENIED');
    expect(err.httpStatus).toBe(403);
  });

  it('details 为空对象时不写入 body', () => {
    const err = new ValidationError('empty');
    const body = appErrorToBody(err);
    expect(body).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'empty' } });
    expect('details' in body.error).toBe(false);
  });

  it('appErrorToResponse 同时返回 status + body', () => {
    const err = new NotFoundError('nope');
    const r = appErrorToResponse(err);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

// ───────────────────────────── 4. helper 函数 ─────────────────────────────

describe('apiErrorBody / apiErrorResponse helpers', () => {
  it('apiErrorBody 复用 ERROR_HTTP_STATUS', () => {
    const body = apiErrorBody('CONFLICT', 'job not failed');
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe('job not failed');
  });

  it('apiErrorBody 带 details', () => {
    const body = apiErrorBody('STATE_MACHINE_ERROR', 'bad', {
      from_state: 'verified',
      event: 'verify',
    });
    expect(body.error.details).toEqual({ from_state: 'verified', event: 'verify' });
  });

  it('apiErrorResponse 推 status 与 ERROR_HTTP_STATUS 同步', () => {
    expect(apiErrorResponse('VALIDATION_ERROR', 'm')).toEqual({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'm' } },
    });
    expect(apiErrorResponse('NOT_FOUND', 'm').status).toBe(404);
    expect(apiErrorResponse('CONFLICT', 'm').status).toBe(409);
    expect(apiErrorResponse('STATE_MACHINE_ERROR', 'm').status).toBe(409);
    expect(apiErrorResponse('SSRF_DENIED', 'm').status).toBe(403);
    expect(apiErrorResponse('PLUGIN_CAPABILITY_DENIED', 'm').status).toBe(403);
  });
});

// ───────────────────────────── 5. toAppError 适配 ─────────────────────────────

describe('toAppError', () => {
  it('AppError 透传', () => {
    const orig = new NotFoundError('x');
    expect(toAppError(orig)).toBe(orig);
  });

  it('SSRFError (code=SSRF_DENIED) → SsrfDeniedError', () => {
    // 用 duck typing 模拟既有 SSRFError（避免 import 路径耦合）
    class FakeSSRFError extends Error {
      code = 'SSRF_DENIED';
      host = 'localhost';
      resolvedIp = '127.0.0.1';
    }
    const err = new FakeSSRFError('loopback');
    const mapped = toAppError(err);
    expect(mapped.code).toBe('SSRF_DENIED');
    expect(mapped.httpStatus).toBe(403);
    expect(mapped.details?.host).toBe('localhost');
  });

  it('StateMachineError (code=STATE_MACHINE_ERROR) → StateMachineErrorCode', () => {
    class FakeSMError extends Error {
      code = 'STATE_MACHINE_ERROR';
      recordId = 'R-1';
      fromState = 'received';
      event = 'enqueue';
    }
    const mapped = toAppError(new FakeSMError('cannot transfer'));
    expect(mapped.code).toBe('STATE_MACHINE_ERROR');
    expect(mapped.httpStatus).toBe(409);
    expect(mapped.details?.recordId).toBe('R-1');
  });

  it('NOT_FOUND / CONFLICT → AppError', () => {
    class FNF extends Error {
      code = 'NOT_FOUND';
    }
    class FCF extends Error {
      code = 'CONFLICT';
    }
    expect(toAppError(new FNF('missing')).httpStatus).toBe(404);
    expect(toAppError(new FCF('bad')).httpStatus).toBe(409);
  });

  it('未知 Error → ValidationError (500-style 包装)', () => {
    const mapped = toAppError(new Error('oops'));
    expect(mapped.code).toBe('VALIDATION_ERROR');
    expect(mapped.message).toContain('oops');
  });

  it('非 Error 值 → ValidationError', () => {
    const mapped = toAppError('just a string');
    expect(mapped.code).toBe('VALIDATION_ERROR');
  });
});

// ───────────────────────────── 6. Presenter contracts (Zod) ─────────────────────────────

describe('InstrumentContractV1', () => {
  const validSample: InstrumentRow = {
    instrument_id: 'ASSET-LAB-0001',
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    asset_tag: 'TAG-0001',
    location: '门诊二楼检验科 A 区',
    status: 'online',
    installed_at: '2024-01-15T08:00:00.000Z',
    last_seen_at: '2024-08-29T08:00:00.000Z',
  };

  it('presenter 输出通过 contract', () => {
    const result = validatePresenterOutput(InstrumentContractV1, presentInstrument(validSample));
    expect(result.ok).toBe(true);
  });

  it('字段集与 presenter 接口对齐', () => {
    const data = presentInstrument(validSample);
    const keys = Object.keys(data).sort();
    expect(keys).toEqual(
      [
        'asset_tag',
        'instrument_id',
        'installed_at',
        'last_seen_at',
        'location',
        'model',
        'status',
        'vendor',
      ].sort(),
    );
  });

  it('拒收 status 非法值', () => {
    const bad = { ...validSample, status: 'broken' };
    const result = validatePresenterOutput(InstrumentContractV1, bad);
    expect(result.ok).toBe(false);
  });

  it('拒收额外字段（strict）', () => {
    const bad = { ...validSample, secret: 'leak' };
    const result = validatePresenterOutput(InstrumentContractV1, bad);
    expect(result.ok).toBe(false);
  });
});

describe('AlarmCodeContractV1', () => {
  const row: AlarmCodeRow = {
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    alarm_code: 'W002',
    alarm_label: '试剂仓温度高',
    sop_md: '## 检查\n1. ...',
    created_at: '2024-01-15T08:00:00.000Z',
  };

  it('presenter 输出通过 contract', () => {
    const result = validatePresenterOutput(AlarmCodeContractV1, presentAlarmCode(row));
    expect(result.ok).toBe(true);
  });

  it('join_key 必填且形如 vendor|model|alarm_code', () => {
    const data = presentAlarmCode(row);
    expect(data.join_key).toBe('Siemens|ADVIA 2400|W002');
    const result = validatePresenterOutput(AlarmCodeContractV1, data);
    expect(result.ok).toBe(true);
  });

  it('join_key 格式错误拒收', () => {
    // 注入 '|' 到 alarm_code 让 joinKey 成为 "Siemens|ADVIA 2400|W|002"（4 段），regex 拒收
    const bad = presentAlarmCode({ ...row, alarm_code: 'W|002' });
    const result = validatePresenterOutput(AlarmCodeContractV1, bad);
    expect(result.ok).toBe(false);
  });
});

describe('CalibrationContractV1', () => {
  const row: CalibrationRow = {
    calibration_id: 'C-001',
    instrument_id: 'ASSET-LAB-0001',
    calibrated_at: '2024-08-29T08:00:00.000Z',
    payload_json: '{"qc":"pass"}',
    raw_hash: 'a'.repeat(64),
  };

  it('presenter 解析 payload_json 为对象，输出通过 contract', () => {
    const result = validatePresenterOutput(CalibrationContractV1, presentCalibration(row));
    expect(result.ok).toBe(true);
  });

  it('raw_hash 必须是 64-hex', () => {
    const bad = presentCalibration({ ...row, raw_hash: 'short' });
    const result = validatePresenterOutput(CalibrationContractV1, bad);
    expect(result.ok).toBe(false);
  });
});

describe('ProcessingRecordContractV1', () => {
  const row: ProcessingRecordRow = {
    record_id: 'R-001',
    instrument_id: 'ASSET-LAB-0001',
    alarm_code: 'W002',
    operator_id: 'op-007',
    root_cause: '试剂波动',
    steps_json: '["打开仓门","检查"]',
    confirmed_at: null,
    state: 'received',
    retry_count: 0,
    payload_json: '{}',
    accession_no: 'L20240829001',
  };

  it('presenter 输出通过 contract', () => {
    const result = validatePresenterOutput(
      ProcessingRecordContractV1,
      presentProcessingRecord(row),
    );
    expect(result.ok).toBe(true);
  });

  it('state 非法值拒收', () => {
    const bad = presentProcessingRecord({ ...row, state: 'archived' as never });
    const result = validatePresenterOutput(ProcessingRecordContractV1, bad);
    expect(result.ok).toBe(false);
  });

  it('retry_count 负数拒收', () => {
    const bad = presentProcessingRecord({ ...row, retry_count: -1 });
    const result = validatePresenterOutput(ProcessingRecordContractV1, bad);
    expect(result.ok).toBe(false);
  });
});

describe('PluginContractV1', () => {
  const entry: PluginEntry = {
    manifest: {
      name: 'lis-writeback',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
      queue_name: 'lis-writeback',
      auth: null,
      rate_limit: null,
      installed_at: '2024-08-29T08:00:00.000Z',
    },
    installedAt: '2024-08-29T08:00:00.000Z',
    handlers: {} as PluginEntry['handlers'],
  };

  it('presenter 输出通过 contract', () => {
    const result = validatePresenterOutput(PluginContractV1, presentPlugin(entry));
    expect(result.ok).toBe(true);
  });

  it('listening_path 是 queue:lis-writeback', () => {
    const data = presentPlugin(entry);
    expect(data.listening_path).toBe('queue:lis-writeback');
  });
});

describe('AuditEventContractV1', () => {
  const row: AuditEventRow = {
    event_id: 'E-001',
    kind: 'plugin.add',
    req_hash: null,
    resp_hash: null,
    operator_id: 'op-007',
    payload_json: '{"name":"x"}',
    ts: '2024-08-29T08:00:00.000Z',
    related_event_id: null,
  };

  it('presenter 输出通过 contract', () => {
    const result = validatePresenterOutput(AuditEventContractV1, presentAuditEvent(row));
    expect(result.ok).toBe(true);
  });

  it('kind 非法值拒收', () => {
    const bad = presentAuditEvent({ ...row, kind: 'mystery.kind' });
    const result = validatePresenterOutput(AuditEventContractV1, bad);
    expect(result.ok).toBe(false);
  });
});
