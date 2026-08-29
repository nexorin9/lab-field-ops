// tests/tasks.test.ts
//
// Task 11 — WritebackTask + InstrumentHeartbeatTask：
//   - src/server/queue/tasks/writeback.ts
//   - src/server/queue/tasks/heartbeat.ts
//   - src/server/queue/register.ts
//
// 覆盖：
//   1. writeback handler 把 record.confirmed payload 推送到 JSONL 文件
//   2. writeback 缺 record_id 抛错（队列重试）
//   3. writeback 成功后落 audit_event kind=writeback.success
//   4. heartbeat handler 把 raw 事件写入 calibration 表
//   5. heartbeat raw_hash 去重（同 raw_hash 第二次 skip）
//   6. heartbeat 缺字段抛错（队列重试）
//   7. heartbeat 成功落 audit_event kind=heartbeat.received
//   8. 失败注入（JSONL 路径只读）→ writeback 失败 → 队列 5 次后 status=failed
//   9. registerAllTasks() 幂等；handlers 与 PluginManager.add() 联动
//
// 与 spec.md 参考地基第 4 行（createQueue + 退避）行为对齐。

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = path.resolve(__dirname, '..');

let TMP_DIR: string;
let TMP_DB: string;

beforeAll(async () => {
  process.chdir(PROJECT_ROOT);
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-tasks-'));
  TMP_DB = path.join(TMP_DIR, 'tasks.sqlite');
  process.env.DATABASE_PATH = TMP_DB;
  const { closeDb } = await import('../src/server/db.js');
  closeDb();
  const { migrate } = await import('../src/server/db/migrate.js');
  migrate(TMP_DB);
});

beforeEach(async () => {
  const { closeDb } = await import('../src/server/db.js');
  closeDb();
  if (fs.existsSync(TMP_DB)) {
    fs.rmSync(TMP_DB, { force: true });
  }
  const { migrate } = await import('../src/server/db/migrate.js');
  migrate(TMP_DB);
  const { PluginManager } = await import('../src/server/plugin/manager.js');
  PluginManager.reset();
  PluginManager.hydrate();
});

afterAll(async () => {
  const { closeDb } = await import('../src/server/db.js');
  closeDb();
  delete process.env.DATABASE_PATH;
  delete process.env.LIS_WRITEBACK_PATH;
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────
// writeback handler
// ────────────────────────────────────────────────────────────
describe('writeback handler', () => {
  it('写一行 JSONL 到 LIS writeback 通道文件', async () => {
    const {
      LIS_WRITEBACK_QUEUE,
      lisWritebackHandler,
      tempLisWritebackPath,
    } = await import('../src/server/queue/tasks/writeback.js');

    const jsonlPath = tempLisWritebackPath();
    process.env.LIS_WRITEBACK_PATH = jsonlPath;

    await lisWritebackHandler({
      record_id: 'rec-writeback-1',
      instrument_id: 'ASSET-LAB-0001',
      alarm_code: 'W002',
      accession_no: 'L20240117001',
      operator_id: 'op-9',
      root_cause: '试剂余量低',
      steps: ['更换试剂', '复测'],
      confirmed_at: new Date().toISOString(),
    });

    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);

    const obj = JSON.parse(lines[0]);
    expect(obj.record_id).toBe('rec-writeback-1');
    expect(obj.instrument_id).toBe('ASSET-LAB-0001');
    expect(obj.alarm_code).toBe('W002');
    expect(obj.accession_no).toBe('L20240117001');
    expect(obj.operator_id).toBe('op-9');
    expect(obj.root_cause).toBe('试剂余量低');
    expect(obj.steps).toEqual(['更换试剂', '复测']);
    expect(typeof obj.ts).toBe('string');
    expect(typeof obj.confirmed_at).toBe('string');

    // 队列名常量对齐（与 plugin manifest.queue_name 同源）
    expect(LIS_WRITEBACK_QUEUE).toBe('lis-writeback');
  });

  it('缺 record_id → 抛错（让队列重试）', async () => {
    const { lisWritebackHandler } = await import(
      '../src/server/queue/tasks/writeback.js'
    );

    await expect(
      lisWritebackHandler({
        instrument_id: 'ASSET-LAB-0001',
      } as unknown as Record<string, unknown>),
    ).rejects.toThrow(/record_id/);
  });

  it('成功落 audit_event kind=writeback.success', async () => {
    const { lisWritebackHandler, tempLisWritebackPath } = await import(
      '../src/server/queue/tasks/writeback.js'
    );
    const { queryAudit } = await import('../src/server/audit/ledger.js');

    process.env.LIS_WRITEBACK_PATH = tempLisWritebackPath();
    await lisWritebackHandler({
      record_id: 'rec-audit-1',
      instrument_id: 'ASSET-LAB-0001',
      operator_id: 'op-1',
    });

    const events = queryAudit({ kind: 'writeback.success', limit: 100 });
    const match = events.find((e) => {
      const p = JSON.parse(e.payload_json);
      return p.record_id === 'rec-audit-1';
    });
    expect(match).toBeTruthy();
    const payload = JSON.parse(match!.payload_json);
    expect(payload.plugin).toBe('lis-writeback');
    expect(payload.target).toContain('lis-writeback.ndjson');
  });
});

// ────────────────────────────────────────────────────────────
// heartbeat handler
// ────────────────────────────────────────────────────────────
describe('heartbeat handler', () => {
  it('写一行到 calibration 表，更新 instrument.last_seen_at', async () => {
    const { iotHeartbeatHandler } = await import(
      '../src/server/queue/tasks/heartbeat.js'
    );
    const dbMod = await import('../src/server/db.js');

    // 准备 instrument（外键约束需要）
    dbMod
      .getDb(TMP_DB)
      .prepare(
        `INSERT INTO instrument
           (instrument_id, vendor, model, asset_tag, location, status, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'ASSET-LAB-0001',
        'Siemens',
        'ADVIA 2400',
        'ASSET-LAB-0001',
        '门诊二楼检验科 A 区',
        'online',
        new Date().toISOString(),
      );

    const receivedAt = new Date().toISOString();
    await iotHeartbeatHandler({
      instrument_id: 'ASSET-LAB-0001',
      vendor: 'Siemens',
      model: 'ADVIA 2400',
      raw: { temp: 37.0, status: 'ok' },
      raw_hash: 'a'.repeat(64),
      received_at: receivedAt,
    });

    const rows = dbMod
      .getDb(TMP_DB)
      .prepare('SELECT * FROM calibration WHERE raw_hash = ?')
      .all('a'.repeat(64));
    expect(rows.length).toBe(1);
    const row = rows[0] as {
      calibration_id: string;
      instrument_id: string;
      payload_json: string;
      raw_hash: string;
    };
    expect(row.calibration_id.startsWith('cal_')).toBe(true);
    expect(row.instrument_id).toBe('ASSET-LAB-0001');
    expect(row.raw_hash).toBe('a'.repeat(64));
    expect(JSON.parse(row.payload_json)).toEqual({ temp: 37.0, status: 'ok' });

    const instrument = dbMod
      .getDb(TMP_DB)
      .prepare('SELECT last_seen_at FROM instrument WHERE instrument_id = ?')
      .get('ASSET-LAB-0001') as { last_seen_at: string };
    expect(instrument.last_seen_at).toBe(receivedAt);
  });

  it('raw_hash 已有 → skip（幂等）', async () => {
    const { iotHeartbeatHandler } = await import(
      '../src/server/queue/tasks/heartbeat.js'
    );
    const dbMod = await import('../src/server/db.js');

    dbMod
      .getDb(TMP_DB)
      .prepare(
        `INSERT INTO instrument
           (instrument_id, vendor, model, asset_tag, location, status, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'ASSET-LAB-0001',
        'Siemens',
        'ADVIA 2400',
        'ASSET-LAB-0001',
        '门诊二楼检验科 A 区',
        'online',
        new Date().toISOString(),
      );

    const payload = {
      instrument_id: 'ASSET-LAB-0001',
      vendor: 'Siemens',
      model: 'ADVIA 2400',
      raw: { temp: 38.0 },
      raw_hash: 'b'.repeat(64),
      received_at: new Date().toISOString(),
    };
    await iotHeartbeatHandler(payload);
    await iotHeartbeatHandler(payload);

    const rows = dbMod
      .getDb(TMP_DB)
      .prepare('SELECT * FROM calibration WHERE raw_hash = ?')
      .all('b'.repeat(64));
    expect(rows.length).toBe(1);
  });

  it('缺字段 → 抛错（让队列重试）', async () => {
    const { iotHeartbeatHandler } = await import(
      '../src/server/queue/tasks/heartbeat.js'
    );

    await expect(
      iotHeartbeatHandler({
        instrument_id: 'ASSET-LAB-0001',
        raw_hash: '',
      } as unknown as Record<string, unknown>),
    ).rejects.toThrow(/heartbeat invalid/);
  });

  it('成功落 audit_event kind=heartbeat.received（含 calibration_id）', async () => {
    const { iotHeartbeatHandler } = await import(
      '../src/server/queue/tasks/heartbeat.js'
    );
    const { queryAudit } = await import('../src/server/audit/ledger.js');
    const dbMod = await import('../src/server/db.js');

    dbMod
      .getDb(TMP_DB)
      .prepare(
        `INSERT INTO instrument
           (instrument_id, vendor, model, asset_tag, location, status, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'ASSET-LAB-0002',
        'Roche',
        'cobas c701',
        'ASSET-LAB-0002',
        '门诊二楼检验科 B 区',
        'online',
        new Date().toISOString(),
      );

    await iotHeartbeatHandler({
      instrument_id: 'ASSET-LAB-0002',
      vendor: 'Roche',
      model: 'cobas c701',
      raw: { i: 1 },
      raw_hash: 'c'.repeat(64),
    });

    const events = queryAudit({ kind: 'heartbeat.received', limit: 100 });
    const match = events.find((e) => {
      const p = JSON.parse(e.payload_json);
      return p.calibration_id && p.vendor === 'Roche';
    });
    expect(match).toBeTruthy();
    const payload = JSON.parse(match!.payload_json);
    expect(payload.instrument_id).toBe('ASSET-LAB-0002');
    expect(payload.calibration_id.startsWith('cal_')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// 失败注入：writeback JSONL 路径只读 → handler 失败 → 队列 5 次后 failed
// ────────────────────────────────────────────────────────────
describe('writeback 失败注入 → 队列 5 次后 failed', () => {
  it('JSONL 路径所在目录不可写 → 5 次重试后 status=failed + emit final_fail', async () => {
    const { createQueue } = await import('../src/server/queue/index.js');
    const { lisWritebackHandler } = await import(
      '../src/server/queue/tasks/writeback.js'
    );

    // 创建一个只读目录（chmod 0500 = 读+执行，无写权限）
    // macOS / Linux 上非 root 用户无法在此目录内创建文件
    const readOnlyDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lab-writeback-ro-'),
    );
    fs.chmodSync(readOnlyDir, 0o500);
    const blockedPath = path.join(readOnlyDir, 'lis-writeback.ndjson');
    process.env.LIS_WRITEBACK_PATH = blockedPath;

    const q = createQueue('lab-q-writeback-fail', {
      attempts: 5,
      backoff: { type: 'exponential', base: 10, max: 100 },
    });
    let attemptsSeen = 0;
    let finalFailCount = 0;
    q.on('final_fail', () => {
      finalFailCount++;
    });
    q.process(async () => {
      attemptsSeen++;
      // 走真实 handler，让它真的去写只读目录抛错
      await lisWritebackHandler({
        record_id: 'rec-fail-1',
        instrument_id: 'ASSET-LAB-0001',
      });
    });
    q.run();

    const { id } = q.enqueue(
      { record_id: 'rec-fail-1' },
      { eventId: 'writeback-fail-evt' },
    );

    // 跑满 attempts 次使 final_fail（每次 handler 抛错 → 走退避 → 下一轮再跑）
    for (let i = 0; i < 10; i++) {
      const j = q.get(id);
      if (j?.status === 'failed') break;
      await q.__test_runOnce();
    }

    // 恢复可写权限 + 清理
    fs.chmodSync(readOnlyDir, 0o755);
    delete process.env.LIS_WRITEBACK_PATH;
    fs.rmSync(readOnlyDir, { recursive: true, force: true });

    expect(attemptsSeen).toBe(5);
    const job = q.get(id);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(5);
    expect(finalFailCount).toBe(1);
    q.stop();
  });
});

// ────────────────────────────────────────────────────────────
// registerAllTasks：幂等 + 与 PluginManager 联动
// ────────────────────────────────────────────────────────────
describe('registerAllTasks', () => {
  it('重复调用返回同一组 queue 实例（幂等）', async () => {
    const { registerAllTasks, __resetTaskRegistration } = await import(
      '../src/server/queue/register.js'
    );
    __resetTaskRegistration();
    const a = registerAllTasks();
    const b = registerAllTasks();
    expect(a.writebackQueue).toBe(b.writebackQueue);
    expect(a.heartbeatQueue).toBe(b.heartbeatQueue);
    a.writebackQueue.stop();
    a.heartbeatQueue.stop();
    __resetTaskRegistration();
  });

  it('写一条 record.confirmed payload → JSONL 出现', async () => {
    const { registerAllTasks, __resetTaskRegistration } = await import(
      '../src/server/queue/register.js'
    );
    __resetTaskRegistration();
    process.env.LIS_WRITEBACK_PATH = path.join(TMP_DIR, 'lis-writeback.ndjson');

    const { writebackQueue } = registerAllTasks();

    writebackQueue.enqueue(
      {
        record_id: 'rec-reg-1',
        instrument_id: 'ASSET-LAB-0001',
        accession_no: 'L20240117002',
        operator_id: 'op-2',
        steps: ['复测'],
      },
      { eventId: 'reg-evt-1' },
    );

    // 跑一次 handler（默认走 tasks/writeback.ts）
    await writebackQueue.__test_runOnce();

    const jsonlPath = process.env.LIS_WRITEBACK_PATH!;
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.record_id).toBe('rec-reg-1');
    expect(obj.accession_no).toBe('L20240117002');

    writebackQueue.stop();
    __resetTaskRegistration();
    delete process.env.LIS_WRITEBACK_PATH;
  });

  it('PluginManager.add 后 registerAllTasks 优先取 plugin 注册的 handler', async () => {
    const { registerAllTasks, __resetTaskRegistration } = await import(
      '../src/server/queue/register.js'
    );
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    const { LIS_WRITEBACK_QUEUE } = await import(
      '../src/server/queue/tasks/writeback.js'
    );

    __resetTaskRegistration();

    // 自定义 handler：写入 /tmp 而非 JSONL；通过返回的 JSONL 长度判断是否被调用
    let customCalls = 0;
    const customHandler = async () => {
      customCalls += 1;
    };

    PluginManager.add(
      {
        name: LIS_WRITEBACK_QUEUE,
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: LIS_WRITEBACK_QUEUE }],
        queue_name: LIS_WRITEBACK_QUEUE,
        auth: null,
        rate_limit: null,
      },
      { task: customHandler },
    );

    const { writebackQueue } = registerAllTasks();
    writebackQueue.enqueue(
      { record_id: 'rec-custom-1' },
      { eventId: 'reg-custom-evt-1' },
    );
    await writebackQueue.__test_runOnce();

    expect(customCalls).toBe(1);
    writebackQueue.stop();
    __resetTaskRegistration();
  });
});