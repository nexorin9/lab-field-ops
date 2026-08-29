// tests/api.test.ts
//
// REST API 端到端测试：覆盖 6 个 route 文件的 CRUD + 分页 + 错误码。
// 复用 tests/db.test.ts 的临时数据库隔离模式（beforeEach rmSync + migrate）。
//
// 每个测试独立 setUp / tearDown；plugin route 用 PluginManager.reset + DB 清理。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb } from '../src/server/db.js';

let tmpDir: string;
let tmpDbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lab-field-ops-api-'));
  tmpDbPath = join(tmpDir, 'test.db');
  process.env.DATABASE_PATH = tmpDbPath;
  // 重置 db 单例
  closeDb();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

// ───────────────────────────── setup helpers ─────────────────────────────

async function setupMigratedDb() {
  const { migrate } = await import('../src/server/db/migrate.js');
  const { getDb } = await import('../src/server/db.js');
  migrate(tmpDbPath);
  return getDb(tmpDbPath);
}

function seedInstrument(
  db: ReturnType<typeof import('../src/server/db.js').getDb>,
  id: string,
  overrides: Partial<{
    vendor: string;
    model: string;
    status: 'online' | 'offline' | 'alarm';
  }> = {},
) {
  db.prepare(
    `INSERT INTO instrument
       (instrument_id, vendor, model, asset_tag, location, status, installed_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    overrides.vendor ?? 'Siemens',
    overrides.model ?? 'ADVIA 2400',
    `TAG-${id}`,
    '门诊二楼检验科 A 区',
    overrides.status ?? 'online',
    '2024-01-15T08:00:00.000Z',
  );
}

// ───────────────────────────── Instruments ─────────────────────────────

describe('GET /api/instruments', () => {
  it('列表 + 分页', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');
    seedInstrument(db, 'ASSET-LAB-0002', { vendor: 'Roche' });
    seedInstrument(db, 'ASSET-LAB-0003', { vendor: 'Abbott', status: 'alarm' });

    const { getInstrumentsRoute } = await import('../src/server/routes/instruments.js');
    const res = getInstrumentsRoute({}, { page: '1', per_page: '2' }, null);
    expect(res.status).toBe(200);
    if (!('instruments' in res.body)) throw new Error('expected instruments in body');
    expect(res.body.instruments).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.per_page).toBe(2);
  });

  it('vendor 过滤', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'A-1', { vendor: 'Siemens' });
    seedInstrument(db, 'A-2', { vendor: 'Roche' });
    seedInstrument(db, 'A-3', { vendor: 'Siemens' });

    const { getInstrumentsRoute } = await import('../src/server/routes/instruments.js');
    const res = getInstrumentsRoute({}, { vendor: 'Siemens' }, null);
    expect(res.status).toBe(200);
    if (!('instruments' in res.body)) throw new Error('expected instruments');
    expect(res.body.instruments).toHaveLength(2);
    expect(res.body.instruments.every((i) => i.vendor === 'Siemens')).toBe(true);
  });

  it('per_page 上限 200', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'A-1');

    const { getInstrumentsRoute } = await import('../src/server/routes/instruments.js');
    const res = getInstrumentsRoute({}, { per_page: '9999' }, null);
    expect(res.status).toBe(200);
    if (!('instruments' in res.body)) throw new Error('expected instruments');
    expect(res.body.per_page).toBe(200);
  });

  it('per_page 非法值回退默认 50', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'A-1');

    const { getInstrumentsRoute } = await import('../src/server/routes/instruments.js');
    const res = getInstrumentsRoute({}, { per_page: 'abc' }, null);
    expect(res.status).toBe(200);
    if (!('instruments' in res.body)) throw new Error('expected instruments');
    expect(res.body.per_page).toBe(50);
  });
});

describe('GET /api/instruments/:id', () => {
  it('详情命中', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');

    const { getInstrumentByIdRoute } = await import('../src/server/routes/instruments.js');
    const res = getInstrumentByIdRoute({ id: 'ASSET-LAB-0001' }, {}, null);
    expect(res.status).toBe(200);
    if (!('instrument_id' in res.body)) throw new Error('expected instrument');
    expect(res.body.instrument_id).toBe('ASSET-LAB-0001');
    expect(res.body.vendor).toBe('Siemens');
  });

  it('不存在返 404 NOT_FOUND', async () => {
    await setupMigratedDb();
    const { getInstrumentByIdRoute } = await import('../src/server/routes/instruments.js');
    const res = getInstrumentByIdRoute({ id: 'DOES-NOT-EXIST' }, {}, null);
    expect(res.status).toBe(404);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('空 id 返 400 VALIDATION_ERROR', async () => {
    await setupMigratedDb();
    const { getInstrumentByIdRoute } = await import('../src/server/routes/instruments.js');
    const res = getInstrumentByIdRoute({ id: '' }, {}, null);
    expect(res.status).toBe(400);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ───────────────────────────── AlarmCodes ─────────────────────────────

describe('GET /api/alarm-codes', () => {
  it('联合主键查询 (vendor + model)', async () => {
    const db = await setupMigratedDb();
    db.prepare(
      `INSERT INTO alarm_code (vendor, model, alarm_code, alarm_label, sop_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('Siemens', 'ADVIA 2400', 'W002', '试剂仓温度高', '## 检查\n1. ...', '2024-01-15T08:00:00.000Z');
    db.prepare(
      `INSERT INTO alarm_code (vendor, model, alarm_code, alarm_label, sop_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('Siemens', 'ADVIA 2400', 'E003', '压力异常', '## 检查', '2024-01-15T08:00:00.000Z');
    db.prepare(
      `INSERT INTO alarm_code (vendor, model, alarm_code, alarm_label, sop_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('Roche', 'cobas 8000', 'W001', '通信超时', '## 检查', '2024-01-15T08:00:00.000Z');

    const { getAlarmCodesRoute } = await import('../src/server/routes/alarmCodes.js');
    const res = getAlarmCodesRoute(
      {},
      { vendor: 'Siemens', model: 'ADVIA 2400' },
      null,
    );
    expect(res.status).toBe(200);
    if (!('alarm_codes' in res.body)) throw new Error('expected alarm_codes');
    expect(res.body.alarm_codes).toHaveLength(2);
    expect(res.body.alarm_codes.every((a) => a.join_key.startsWith('Siemens|ADVIA 2400|'))).toBe(true);
  });

  it('alarm_code 单字段过滤', async () => {
    const db = await setupMigratedDb();
    db.prepare(
      `INSERT INTO alarm_code (vendor, model, alarm_code, alarm_label, sop_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('Siemens', 'ADVIA 2400', 'W002', '试剂仓温度高', '## 检查', '2024-01-15T08:00:00.000Z');

    const { getAlarmCodesRoute } = await import('../src/server/routes/alarmCodes.js');
    const res = getAlarmCodesRoute({}, { alarm_code: 'W002' }, null);
    expect(res.status).toBe(200);
    if (!('alarm_codes' in res.body)) throw new Error('expected alarm_codes');
    expect(res.body.alarm_codes).toHaveLength(1);
    expect(res.body.alarm_codes[0].alarm_code).toBe('W002');
  });

  it('无过滤时返回全部', async () => {
    const db = await setupMigratedDb();
    db.prepare(
      `INSERT INTO alarm_code (vendor, model, alarm_code, alarm_label, sop_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('Siemens', 'ADVIA 2400', 'W002', '试剂仓温度高', '## 检查', '2024-01-15T08:00:00.000Z');

    const { getAlarmCodesRoute } = await import('../src/server/routes/alarmCodes.js');
    const res = getAlarmCodesRoute({}, {}, null);
    expect(res.status).toBe(200);
    if (!('alarm_codes' in res.body)) throw new Error('expected alarm_codes');
    expect(res.body.total).toBe(1);
  });
});

// ───────────────────────────── Calibrations ─────────────────────────────

describe('GET /api/calibrations', () => {
  it('按 instrument_id 过滤 + 时间倒序', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');
    seedInstrument(db, 'ASSET-LAB-0002');
    db.prepare(
      `INSERT INTO calibration (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('C-001', 'ASSET-LAB-0001', '2024-08-29T08:00:00.000Z', '{"qc":"pass"}', 'h1');
    db.prepare(
      `INSERT INTO calibration (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('C-002', 'ASSET-LAB-0001', '2024-08-28T08:00:00.000Z', '{"qc":"pass"}', 'h2');
    db.prepare(
      `INSERT INTO calibration (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('C-003', 'ASSET-LAB-0002', '2024-08-29T08:00:00.000Z', '{"qc":"fail"}', 'h3');

    const { getCalibrationsRoute } = await import('../src/server/routes/calibrations.js');
    const res = getCalibrationsRoute({}, { instrumentId: 'ASSET-LAB-0001' }, null);
    expect(res.status).toBe(200);
    if (!('calibrations' in res.body)) throw new Error('expected calibrations');
    expect(res.body.calibrations).toHaveLength(2);
    expect(res.body.calibrations[0].calibration_id).toBe('C-001'); // 最新在前
    expect(res.body.calibrations[1].calibration_id).toBe('C-002');
  });

  it('payload 解析为对象', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');
    db.prepare(
      `INSERT INTO calibration (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('C-001', 'ASSET-LAB-0001', '2024-08-29T08:00:00.000Z', '{"qc":"pass","k":1.5}', 'h1');

    const { getCalibrationsRoute } = await import('../src/server/routes/calibrations.js');
    const res = getCalibrationsRoute({}, {}, null);
    expect(res.status).toBe(200);
    if (!('calibrations' in res.body)) throw new Error('expected calibrations');
    expect(res.body.calibrations[0].payload).toEqual({ qc: 'pass', k: 1.5 });
  });

  it('from / to 时间窗口', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');
    db.prepare(
      `INSERT INTO calibration (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('C-001', 'ASSET-LAB-0001', '2024-08-29T08:00:00.000Z', '{}', 'h1');
    db.prepare(
      `INSERT INTO calibration (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('C-002', 'ASSET-LAB-0001', '2024-08-28T08:00:00.000Z', '{}', 'h2');

    const { getCalibrationsRoute } = await import('../src/server/routes/calibrations.js');
    const res = getCalibrationsRoute(
      {},
      { from: '2024-08-29T00:00:00.000Z' },
      null,
    );
    expect(res.status).toBe(200);
    if (!('calibrations' in res.body)) throw new Error('expected calibrations');
    expect(res.body.calibrations).toHaveLength(1);
    expect(res.body.calibrations[0].calibration_id).toBe('C-001');
  });
});

// ───────────────────────────── ProcessingRecords ─────────────────────────────

describe('POST /api/processing-records', () => {
  it('新建 received 态记录', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');

    const { postProcessingRecordRoute } = await import(
      '../src/server/routes/processing-records.js'
    );
    const res = postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-007',
        root_cause: '试剂仓温度波动',
        steps: ['打开仓门', '检查试剂'],
        accession_no: 'L20240829001',
      },
    );
    expect(res.status).toBe(201);
    if (!('record_id' in res.body)) throw new Error('expected record');
    expect(res.body.record_id).toBeTruthy();
    expect(res.body.instrument_id).toBe('ASSET-LAB-0001');
    expect(res.body.state).toBe('received');
    expect(res.body.steps).toEqual(['打开仓门', '检查试剂']);
    expect(res.body.accession_no).toBe('L20240829001');
  });

  it('audit 写入 processing_record.created', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');

    const { postProcessingRecordRoute } = await import(
      '../src/server/routes/processing-records.js'
    );
    const res = postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-007',
      },
    );
    expect(res.status).toBe(201);

    const { queryAudit } = await import('../src/server/audit/ledger.js');
    const auditRows = queryAudit({ kind: 'processing_record.created' });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  it('缺 instrument_id → 400 VALIDATION_ERROR', async () => {
    await setupMigratedDb();

    const { postProcessingRecordRoute } = await import(
      '../src/server/routes/processing-records.js'
    );
    const res = postProcessingRecordRoute(
      {},
      {},
      { alarm_code: 'W002', operator_id: 'op-007' },
    );
    expect(res.status).toBe(400);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('instrument 不存在 → 404 NOT_FOUND', async () => {
    await setupMigratedDb();

    const { postProcessingRecordRoute } = await import(
      '../src/server/routes/processing-records.js'
    );
    const res = postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'NOT-EXIST',
        alarm_code: 'W002',
        operator_id: 'op-007',
      },
    );
    expect(res.status).toBe(404);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/processing-records/:id', () => {
  it('详情命中', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');
    const { postProcessingRecordRoute } = await import(
      '../src/server/routes/processing-records.js'
    );
    const created = postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-007',
      },
    );
    if (!('record_id' in created.body)) throw new Error('expected record');
    const recordId = created.body.record_id;

    const { getProcessingRecordByIdRoute } = await import(
      '../src/server/routes/processing-records.js'
    );
    const res = getProcessingRecordByIdRoute({ id: recordId }, {}, null);
    expect(res.status).toBe(200);
    if (!('record_id' in res.body)) throw new Error('expected record');
    expect(res.body.record_id).toBe(recordId);
    expect(res.body.state).toBe('received');
  });

  it('不存在 → 404 NOT_FOUND', async () => {
    await setupMigratedDb();
    const { getProcessingRecordByIdRoute } = await import(
      '../src/server/routes/processing-records.js'
    );
    const res = getProcessingRecordByIdRoute({ id: 'NOT-EXIST' }, {}, null);
    expect(res.status).toBe(404);
  });
});

// ───────────────────────────── Plugins ─────────────────────────────

describe('GET /api/plugins', () => {
  it('空列表', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    PluginManager.reset();

    const { getPluginsRoute } = await import('../src/server/routes/plugins.js');
    const res = getPluginsRoute({}, {}, null);
    expect(res.status).toBe(200);
    if (!('plugins' in res.body)) throw new Error('expected plugins');
    expect(res.body.plugins).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('有 plugin 时返回列表 + listening_path', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    PluginManager.reset();
    PluginManager.add({
      name: 'lis-writeback',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
      queue_name: 'lis-writeback',
      auth: null,
      rate_limit: null,
    });

    const { getPluginsRoute } = await import('../src/server/routes/plugins.js');
    const res = getPluginsRoute({}, {}, null);
    expect(res.status).toBe(200);
    if (!('plugins' in res.body)) throw new Error('expected plugins');
    expect(res.body.plugins).toHaveLength(1);
    expect(res.body.plugins[0].listening_path).toBe('queue:lis-writeback');
  });
});

describe('DELETE /api/plugins/:name', () => {
  it('删除已注册 plugin', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    PluginManager.reset();
    PluginManager.add({
      name: 'lis-writeback',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
      queue_name: 'lis-writeback',
      auth: null,
      rate_limit: null,
    });

    const { deletePluginRoute } = await import('../src/server/routes/plugins.js');
    const res = deletePluginRoute({ name: 'lis-writeback' }, {}, null);
    expect(res.status).toBe(200);
    if (!('name' in res.body)) throw new Error('expected name');
    expect(res.body.name).toBe('lis-writeback');
    expect(res.body.already_removed).toBe(false);
    expect(PluginManager.list()).toHaveLength(0);
  });

  it('删除不存在的 plugin 幂等返 200 already_removed=true', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    PluginManager.reset();

    const { deletePluginRoute } = await import('../src/server/routes/plugins.js');
    const res = deletePluginRoute({ name: 'never-existed' }, {}, null);
    expect(res.status).toBe(200);
    if (!('name' in res.body)) throw new Error('expected name');
    expect(res.body.already_removed).toBe(true);
  });

  it('空 name 返 400 VALIDATION_ERROR', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    PluginManager.reset();
    const { deletePluginRoute } = await import('../src/server/routes/plugins.js');
    const res = deletePluginRoute({ name: '' }, {}, null);
    expect(res.status).toBe(400);
    if (!('error' in res.body)) throw new Error('expected error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ───────────────────────────── Audit ─────────────────────────────

describe('GET /api/audit', () => {
  it('按 kind 过滤', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    PluginManager.reset();
    PluginManager.add({
      name: 'lis-writeback',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
      queue_name: 'lis-writeback',
      auth: null,
      rate_limit: null,
    });
    PluginManager.remove('lis-writeback');

    const { getAuditRoute } = await import('../src/server/routes/audit.js');
    const res = getAuditRoute({}, { kind: 'plugin.add' }, null);
    expect(res.status).toBe(200);
    if (!('events' in res.body)) throw new Error('expected events');
    expect(res.body.events.length).toBeGreaterThanOrEqual(1);
    expect(res.body.events.every((e) => e.kind === 'plugin.add')).toBe(true);
  });

  it('kind 多值用逗号分隔', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    PluginManager.reset();
    PluginManager.add({
      name: 'lis-writeback',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
      queue_name: 'lis-writeback',
      auth: null,
      rate_limit: null,
    });
    PluginManager.remove('lis-writeback');

    const { getAuditRoute } = await import('../src/server/routes/audit.js');
    const res = getAuditRoute({}, { kind: 'plugin.add,plugin.remove' }, null);
    expect(res.status).toBe(200);
    if (!('events' in res.body)) throw new Error('expected events');
    const kinds = new Set(res.body.events.map((e) => e.kind));
    expect(kinds.has('plugin.add') || kinds.has('plugin.remove')).toBe(true);
  });

  it('kind 非法值被丢弃（不报 400）', async () => {
    await setupMigratedDb();
    const { getAuditRoute } = await import('../src/server/routes/audit.js');
    const res = getAuditRoute({}, { kind: 'not.a.kind' }, null);
    expect(res.status).toBe(200);
    if (!('events' in res.body)) throw new Error('expected events');
    expect(res.body.events).toEqual([]);
  });

  it('operatorId 过滤', async () => {
    const db = await setupMigratedDb();
    seedInstrument(db, 'ASSET-LAB-0001');
    const { postProcessingRecordRoute } = await import(
      '../src/server/routes/processing-records.js'
    );
    postProcessingRecordRoute(
      {},
      {},
      {
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        operator_id: 'op-007',
      },
    );

    const { getAuditRoute } = await import('../src/server/routes/audit.js');
    const res = getAuditRoute({}, { operatorId: 'op-007' }, null);
    expect(res.status).toBe(200);
    if (!('events' in res.body)) throw new Error('expected events');
    expect(res.body.events.every((e) => e.operator_id === 'op-007')).toBe(true);
  });

  it('limit 上限 1000', async () => {
    await setupMigratedDb();
    const { getAuditRoute } = await import('../src/server/routes/audit.js');
    const res = getAuditRoute({}, { limit: '99999' }, null);
    expect(res.status).toBe(200);
    if (!('events' in res.body)) throw new Error('expected events');
    expect(res.body.limit).toBe(1000);
  });

  it('time range from / to', async () => {
    await setupMigratedDb();
    const { getAuditRoute } = await import('../src/server/routes/audit.js');
    const res = getAuditRoute(
      {},
      { from: '2030-01-01T00:00:00.000Z', to: '2030-12-31T23:59:59.000Z' },
      null,
    );
    expect(res.status).toBe(200);
    if (!('events' in res.body)) throw new Error('expected events');
    expect(res.body.events).toEqual([]);
  });
});