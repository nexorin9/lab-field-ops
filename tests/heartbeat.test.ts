// tests/heartbeat.test.ts
//
// Task 22 — Heartbeat 事件 schema + 限流（核心模块 B 深度）
//   - src/shared/types.ts 增 HeartbeatSchema（Zod）
//   - src/server/queue/tasks/heartbeat.ts 增 rateLimit（token-bucket）
//   - src/server/queue/tasks/heartbeat-dropped.ts 新建
//   - src/cli/plugin.ts 增 rateLimit 默认值注入
//
// 覆盖：
//   1. HeartbeatSchema：合法入参通过；缺字段 / 错 hex / 未声明字段 拒绝
//   2. token-bucket：tryAcquireHeartbeatToken 正确计数
//   3. pushHeartbeatToCalibration：合法 heartbeat 入 calibration + 落 audit
//   4. pushHeartbeatToCalibration：rate_limited 返回 + 落 audit kind=heartbeat.dropped
//   5. pushHeartbeatToCalibration：raw_hash 重复 skip（status=duplicate）+ 落 audit dropped
//   6. pushHeartbeatToCalibration：schema 非法返回 status=invalid
//   7. CLI addPlugin：task 类型无 rate_limit → 自动注入默认 10/s；显式声明 → 不注入
//   8. CLI addPlugin：非 task 类型 rate_limit 字段不被强制要求
//   9. CLI formatAddOutput：rate_limit 行输出

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = path.resolve(__dirname, '..');

let TMP_DIR: string;
let TMP_DB: string;

beforeAll(async () => {
  process.chdir(PROJECT_ROOT);
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-heartbeat-'));
  TMP_DB = path.join(TMP_DIR, 'heartbeat.sqlite');
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
  PluginManager.hydrate();
  const {
    __resetHeartbeatRateLimiter,
  } = await import('../src/server/queue/tasks/heartbeat.js');
  __resetHeartbeatRateLimiter();
});

afterAll(async () => {
  const { closeDb } = await import('../src/server/db.js');
  closeDb();
  if (TMP_DIR && fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

/** 构造一份合法 heartbeat payload；raw_hash 是确定性 64 位 hex。 */
function makeHeartbeat(opts: {
  instrumentId?: string;
  vendor?: string;
  model?: string;
  rawHash?: string;
  raw?: Record<string, unknown>;
} = {}) {
  return {
    instrument_id: opts.instrumentId ?? 'ASSET-LAB-0001',
    vendor: opts.vendor ?? 'Siemens',
    model: opts.model ?? 'ADVIA 2400',
    raw_hash:
      opts.rawHash ??
      'a'.repeat(64),
    raw: opts.raw ?? { temp: 36.5, status: 'idle' },
  };
}

describe('HeartbeatSchema (Zod)', () => {
  it('合法入参通过', async () => {
    const { HeartbeatSchema } = await import('../src/shared/types.js');
    const result = HeartbeatSchema.safeParse(makeHeartbeat());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instrument_id).toBe('ASSET-LAB-0001');
      expect(result.data.vendor).toBe('Siemens');
      expect(result.data.raw_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('缺 raw_hash 拒绝', async () => {
    const { HeartbeatSchema } = await import('../src/shared/types.js');
    const bad = { ...makeHeartbeat(), raw_hash: undefined };
    const result = HeartbeatSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('raw_hash 非 64 位 hex 拒绝', async () => {
    const { HeartbeatSchema } = await import('../src/shared/types.js');
    const bad = { ...makeHeartbeat(), raw_hash: 'short' };
    const result = HeartbeatSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('未声明字段 strict 拒绝', async () => {
    const { HeartbeatSchema } = await import('../src/shared/types.js');
    const bad = { ...makeHeartbeat(), extra_field: 'oops' };
    const result = HeartbeatSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('received_at 非 ISO 8601 拒绝', async () => {
    const { HeartbeatSchema } = await import('../src/shared/types.js');
    const bad = { ...makeHeartbeat(), received_at: 'not-iso' };
    const result = HeartbeatSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('tryAcquireHeartbeatToken (token-bucket)', () => {
  it('连续 N 次通过后第 N+1 次拒收', async () => {
    const {
      __test,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      expect(
        __test.tryAcquireHeartbeatToken('Siemens', 'ADVIA 2400', 5, now),
      ).toBe(true);
    }
    expect(
      __test.tryAcquireHeartbeatToken('Siemens', 'ADVIA 2400', 5, now),
    ).toBe(false);
  });

  it('时间窗过后 token 补充', async () => {
    const {
      __test,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    const base = 1_700_000_000_000;
    // 5/s 桶立刻扣 5 次满
    for (let i = 0; i < 5; i++) {
      expect(
        __test.tryAcquireHeartbeatToken('Roche', 'cobas c701', 5, base),
      ).toBe(true);
    }
    expect(
      __test.tryAcquireHeartbeatToken('Roche', 'cobas c701', 5, base),
    ).toBe(false);
    // 1 秒后 token 补满
    expect(
      __test.tryAcquireHeartbeatToken('Roche', 'cobas c701', 5, base + 1000),
    ).toBe(true);
  });

  it('不同 (vendor, model) 桶独立', async () => {
    const {
      __test,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    const now = 1_700_000_000_000;
    expect(
      __test.tryAcquireHeartbeatToken('VendorA', 'ModelX', 1, now),
    ).toBe(true);
    expect(
      __test.tryAcquireHeartbeatToken('VendorA', 'ModelX', 1, now),
    ).toBe(false);
    // 不同 model 不影响
    expect(
      __test.tryAcquireHeartbeatToken('VendorA', 'ModelY', 1, now),
    ).toBe(true);
    // 不同 vendor 不影响
    expect(
      __test.tryAcquireHeartbeatToken('VendorB', 'ModelX', 1, now),
    ).toBe(true);
  });

  it('大小写归一', async () => {
    const {
      __test,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    const now = 1_700_000_000_000;
    expect(
      __test.tryAcquireHeartbeatToken('siemens', 'advia 2400', 1, now),
    ).toBe(true);
    expect(
      __test.tryAcquireHeartbeatToken('SIEMENS', 'ADVIA 2400', 1, now),
    ).toBe(false);
  });

  it('非法 ratePerSecond 自动 clamp 到 [1, HEARTBEAT_MAX_RATE_LIMIT]', async () => {
    const {
      __test,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    const now = 1_700_000_000_000;
    // rate=0 应被 clamp 到 1（首次通过，第二次拒收）
    expect(
      __test.tryAcquireHeartbeatToken('A', 'B', 0, now),
    ).toBe(true);
    expect(
      __test.tryAcquireHeartbeatToken('A', 'B', 0, now),
    ).toBe(false);
    // rate=999999 应被 clamp 到 HEARTBEAT_MAX_RATE_LIMIT（1000）
    // 不做完整断言，只确保不抛错即可
    expect(() =>
      __test.tryAcquireHeartbeatToken('C', 'D', 999999, now),
    ).not.toThrow();
  });
});

describe('pushHeartbeatToCalibration (handler)', () => {
  /** seed 一台仪器以满足 calibration.instrument_id 外键。 */
  async function seedInstrument(opts: {
    instrumentId: string;
    vendor: string;
    model: string;
  }): Promise<void> {
    const { getDb } = await import('../src/server/db.js');
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO instrument
         (instrument_id, vendor, model, asset_tag, location, status,
          installed_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 'online', ?, NULL)`,
    ).run(
      opts.instrumentId,
      opts.vendor,
      opts.model,
      `ASSET-${opts.instrumentId}`,
      '门诊二楼检验科 A 区',
      new Date().toISOString(),
    );
  }

  it('合法 heartbeat → status=persisted + 入 calibration + 落 audit', async () => {
    const {
      pushHeartbeatToCalibration,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    await seedInstrument({
      instrumentId: 'ASSET-LAB-0001',
      vendor: 'Siemens',
      model: 'ADVIA 2400',
    });
    const result = await pushHeartbeatToCalibration(makeHeartbeat(), {
      ratePerSecond: 5,
    });
    expect(result.status).toBe('persisted');
    expect(result.calibrationId).toMatch(/^cal_/);

    // calibration 表有 1 条
    const { getDb } = await import('../src/server/db.js');
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM calibration WHERE raw_hash = ?')
      .all('a'.repeat(64)) as Array<{ raw_hash: string }>;
    expect(rows.length).toBe(1);

    // audit_event 有 heartbeat.received
    const audits = db
      .prepare(
        "SELECT kind FROM audit_event WHERE kind = 'heartbeat.received'",
      )
      .all() as Array<{ kind: string }>;
    expect(audits.length).toBe(1);
  });

  it('rate_limited → status=rate_limited + 落 audit kind=heartbeat.dropped', async () => {
    const {
      pushHeartbeatToCalibration,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    await seedInstrument({
      instrumentId: 'ASSET-LAB-0002',
      vendor: 'Roche',
      model: 'cobas c701',
    });
    // rate=2 → 前 2 条 persisted，第 3 条 rate_limited
    const baseTime = 1_700_000_000_000;
    const r1 = await pushHeartbeatToCalibration(
      makeHeartbeat({
        instrumentId: 'ASSET-LAB-0002',
        vendor: 'Roche',
        model: 'cobas c701',
        rawHash: 'b'.repeat(64),
      }),
      { ratePerSecond: 2, now: baseTime },
    );
    const r2 = await pushHeartbeatToCalibration(
      makeHeartbeat({
        instrumentId: 'ASSET-LAB-0002',
        vendor: 'Roche',
        model: 'cobas c701',
        rawHash: 'c'.repeat(64),
      }),
      { ratePerSecond: 2, now: baseTime },
    );
    const r3 = await pushHeartbeatToCalibration(
      makeHeartbeat({
        instrumentId: 'ASSET-LAB-0002',
        vendor: 'Roche',
        model: 'cobas c701',
        rawHash: 'd'.repeat(64),
      }),
      { ratePerSecond: 2, now: baseTime },
    );
    expect(r1.status).toBe('persisted');
    expect(r2.status).toBe('persisted');
    expect(r3.status).toBe('rate_limited');

    const { getDb } = await import('../src/server/db.js');
    const db = getDb();
    const dropped = db
      .prepare(
        `SELECT payload_json FROM audit_event WHERE kind = 'heartbeat.dropped'`,
      )
      .all() as Array<{ payload_json: string }>;
    expect(dropped.length).toBe(1);
    const parsed = JSON.parse(dropped[0].payload_json);
    expect(parsed.reason).toBe('rate_limited');
    expect(parsed.vendor).toBe('Roche');
    expect(parsed.rate_limit).toBe(2);
  });

  it('raw_hash 重复 → status=duplicate + 落 audit dropped reason=duplicate', async () => {
    const {
      pushHeartbeatToCalibration,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    await seedInstrument({
      instrumentId: 'ASSET-LAB-0003',
      vendor: 'Abbott',
      model: 'Architect ci4100',
    });
    const r1 = await pushHeartbeatToCalibration(
      makeHeartbeat({
        instrumentId: 'ASSET-LAB-0003',
        vendor: 'Abbott',
        model: 'Architect ci4100',
        rawHash: 'e'.repeat(64),
      }),
      { ratePerSecond: 10 },
    );
    const r2 = await pushHeartbeatToCalibration(
      makeHeartbeat({
        instrumentId: 'ASSET-LAB-0003',
        vendor: 'Abbott',
        model: 'Architect ci4100',
        rawHash: 'e'.repeat(64),
      }),
      { ratePerSecond: 10 },
    );
    expect(r1.status).toBe('persisted');
    expect(r2.status).toBe('duplicate');
    expect(r2.calibrationId).toBe(r1.calibrationId);

    const { getDb } = await import('../src/server/db.js');
    const db = getDb();
    const dropped = db
      .prepare(
        `SELECT payload_json FROM audit_event
         WHERE kind = 'heartbeat.dropped' AND json_extract(payload_json, '$.reason') = 'duplicate'`,
      )
      .all() as Array<{ payload_json: string }>;
    expect(dropped.length).toBe(1);
    const parsed = JSON.parse(dropped[0].payload_json);
    expect(parsed.existing_calibration_id).toBe(r1.calibrationId);
  });

  it('schema 非法 → status=invalid + handler 抛错', async () => {
    const {
      iotHeartbeatHandler,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    const bad = {
      ...makeHeartbeat(),
      raw_hash: 'short',
    };
    await expect(
      iotHeartbeatHandler(bad as unknown as Record<string, unknown>),
    ).rejects.toThrow(/heartbeat invalid/);
  });

  it('handler 收到 queue job 形态（payload 包裹）也能解析', async () => {
    const {
      iotHeartbeatHandler,
    } = await import('../src/server/queue/tasks/heartbeat.js');
    await seedInstrument({
      instrumentId: 'ASSET-LAB-0004',
      vendor: 'Sysmex',
      model: 'XN-1000',
    });
    const payload = makeHeartbeat({
      instrumentId: 'ASSET-LAB-0004',
      vendor: 'Sysmex',
      model: 'XN-1000',
      rawHash: 'f'.repeat(64),
    });
    const job = {
      id: 'job1',
      name: 'iot-heartbeat',
      payload,
      attempts: 1,
      status: 'pending' as const,
      last_error: null,
      next_run_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      event_id: 'evt1',
    };
    const result = await iotHeartbeatHandler(
      job as unknown as Record<string, unknown>,
    );
    // handler 包了一层：{status: 'persisted', ...}
    expect(result).toBeDefined();
  });
});

describe('CLI addPlugin + rate_limit 自动注入', () => {
  function writeManifest(name: string, body: Record<string, unknown>): string {
    const file = path.join(TMP_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf-8');
    return file;
  }

  it('task 类型无 rate_limit → 自动注入默认 10/s', async () => {
    const { addPlugin } = await import('../src/cli/plugin.js');
    const manifestPath = writeManifest('iot-heartbeat', {
      name: 'iot-heartbeat',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'iot-heartbeat' }],
      queue_name: 'iot-heartbeat',
      auth: null,
      // rate_limit 故意省略
    });
    const result = addPlugin(manifestPath, { dbPath: TMP_DB });
    expect(result.ok).toBe(true);
    expect(result.rateLimit).toBe(10);
    expect(result.rateLimitInjected).toBe(true);
  });

  it('task 类型显式 rate_limit=50 → 不注入，原值生效', async () => {
    const { addPlugin } = await import('../src/cli/plugin.js');
    const manifestPath = writeManifest('iot-heartbeat-fast', {
      name: 'iot-heartbeat-fast',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'iot-heartbeat-fast' }],
      queue_name: 'iot-heartbeat-fast',
      rate_limit: 50,
    });
    const result = addPlugin(manifestPath, { dbPath: TMP_DB });
    expect(result.ok).toBe(true);
    expect(result.rateLimit).toBe(50);
    expect(result.rateLimitInjected).toBe(false);
  });

  it('非 task 类型 rate_limit 不强制要求', async () => {
    const { addPlugin } = await import('../src/cli/plugin.js');
    const manifestPath = writeManifest('vendor-ticket-api', {
      name: 'vendor-ticket-api',
      version: '1.0.0',
      type: 'api',
      hooks: [{ type: 'api', path: '/vendor-tickets' }],
      queue_name: null,
    });
    const result = addPlugin(manifestPath, { dbPath: TMP_DB });
    expect(result.ok).toBe(true);
    expect(result.rateLimit).toBeNull();
    expect(result.rateLimitInjected).toBe(false);
  });

  it('defaultRateLimit=null 时不注入（信息科显式禁用默认值）', async () => {
    const { addPlugin } = await import('../src/cli/plugin.js');
    const manifestPath = writeManifest('iot-heartbeat-norate', {
      name: 'iot-heartbeat-norate',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'iot-heartbeat-norate' }],
      queue_name: 'iot-heartbeat-norate',
    });
    // PluginManager.add 会因 rate_limit 缺省而拒收（task type 必须有 rate_limit）
    // 这里 manifest.ts schema 中 rate_limit 是 nullable().default(null)，
    // 因此 null 也是合法值；PluginManager 不强制非空
    const result = addPlugin(manifestPath, {
      dbPath: TMP_DB,
      defaultRateLimit: null,
    });
    expect(result.ok).toBe(true);
    expect(result.rateLimit).toBeNull();
    expect(result.rateLimitInjected).toBe(false);
  });

  it('formatAddOutput 含 rate_limit 行（task 类型）', async () => {
    const { addPlugin, formatAddOutput } = await import(
      '../src/cli/plugin.js'
    );
    const manifestPath = writeManifest('iot-heartbeat-pretty', {
      name: 'iot-heartbeat-pretty',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'iot-heartbeat-pretty' }],
      queue_name: 'iot-heartbeat-pretty',
    });
    const result = addPlugin(manifestPath, { dbPath: TMP_DB });
    expect(result.ok).toBe(true);
    const text = formatAddOutput(result);
    expect(text).toMatch(/rate limit:\s+10\/s/);
    expect(text).toMatch(/CLI 注入默认值/);
  });

  it('formatAddOutput 不含 rate_limit 行（非 task 类型）', async () => {
    const { addPlugin, formatAddOutput } = await import(
      '../src/cli/plugin.js'
    );
    const manifestPath = writeManifest('lis-unfurl', {
      name: 'lis-unfurl',
      version: '1.0.0',
      type: 'unfurl',
      hooks: [{ type: 'unfurl' }],
      queue_name: null,
    });
    const result = addPlugin(manifestPath, { dbPath: TMP_DB });
    expect(result.ok).toBe(true);
    const text = formatAddOutput(result);
    expect(text).not.toMatch(/rate limit:/);
  });
});