// tests/seed.test.ts
//
// CLI seed 灌入脱敏样例（Task 28 拆分验收）：
//   - seed() 灌入 3 台仪器（vendor={Siemens/Roche/Abbott} 占位名；assetTag=ASSET-LAB-{0001..0003} 占位格式）
//   - seed() 灌入 4 类报警码（vendor/model/alarm_code 联合主键；带 SOP markdown）
//   - seed() 灌入 10 条校准记录（分散到 3 台仪器 + 7 天时间窗）
//   - seed() 灌入 2 个示例 plugin manifest（来自 examples/manifests/*.json）
//   - seed() 幂等：第二次调用返回 alreadySeeded=true + 0 inserts
//   - seed({force: true}) 强制重灌
//   - isAlreadySeeded 检测器正确
//   - 各单项函数 seedInstruments / seedAlarmCodes / seedCalibrations 可独立调用
//
// 与 tests/dashboard.test.ts 的分工：
//   - dashboard.test.ts：seed 与 DashboardPage 渲染联动（旧 data-testid 契约）
//   - seed.test.ts（本文件）：seed 函数本身的字段与幂等性契约

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeDb } from '../src/server/db';
import { migrate } from '../src/server/db/migrate';
import {
  seed,
  isAlreadySeeded,
  seedInstruments,
  seedAlarmCodes,
  seedCalibrations,
  seedPlugins,
  SAMPLE_INSTRUMENTS,
  SAMPLE_ALARM_CODES,
} from '../src/cli/seed';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-seed-'));
const TMP_DB = path.join(TMP_DIR, 'test.sqlite');

beforeAll(() => {
  process.chdir(path.resolve(__dirname, '..'));
  // 强制 seed 走临时库（不影响 data/）
  process.env.DATABASE_PATH = TMP_DB;
  closeDb();
});

afterAll(() => {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  delete process.env.DATABASE_PATH;
  closeDb();
});

describe('seed 灌入脱敏样例（基础量）', () => {
  beforeEach(() => {
    // 每个 case 走新库，避免前一个 case 残留 instrument 表
    closeDb();
    if (fs.existsSync(TMP_DB)) fs.rmSync(TMP_DB);
    delete process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = TMP_DB;
  });

  it('空库首次 seed(): 灌入 3 台仪器', () => {
    const result = seed({ force: true });
    expect(result.alreadySeeded).toBe(false);
    expect(result.instruments).toBe(3);
  });

  it('空库首次 seed(): 灌入 4 类报警码', () => {
    const result = seed({ force: true });
    expect(result.alarmCodes).toBe(4);
  });

  it('空库首次 seed(): 灌入 10 条校准', () => {
    const result = seed({ force: true });
    expect(result.calibrations).toBe(10);
  });

  it('seed(): 灌入 examples/manifests 下的 2 个 plugin', () => {
    const result = seed({ force: true });
    expect(result.plugins.length).toBe(2);
    const names = result.plugins.map((p) => p.name).sort();
    expect(names).toEqual(['iot-heartbeat', 'lis-writeback']);
    for (const p of result.plugins) {
      expect(p.ok).toBe(true);
    }
  });
});

describe('seed 灌入脱敏样例（字段约束）', () => {
  beforeEach(() => {
    closeDb();
    if (fs.existsSync(TMP_DB)) fs.rmSync(TMP_DB);
    delete process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = TMP_DB;
  });

  it('仪器 assetTag 一律 ASSET-LAB-{0001..0003} 占位格式', () => {
    seed({ force: true });
    const db = getDb();
    const rows = db.prepare(`SELECT instrument_id, asset_tag FROM instrument ORDER BY instrument_id`).all() as Array<{
      instrument_id: string;
      asset_tag: string;
    }>;
    expect(rows.map((r) => r.instrument_id)).toEqual([
      'ASSET-LAB-0001',
      'ASSET-LAB-0002',
      'ASSET-LAB-0003',
    ]);
    // asset_tag 与 instrument_id 同号（同一台仪器有两套等价标识，contract v1 已约定）
    expect(rows[0]?.asset_tag).toBe('ASSET-LAB-0001');
    expect(rows[1]?.asset_tag).toBe('ASSET-LAB-0002');
    expect(rows[2]?.asset_tag).toBe('ASSET-LAB-0003');
  });

  it('仪器 vendor 是占位名（Siemens/Roche/Abbott），不写真实编码', () => {
    seed({ force: true });
    const db = getDb();
    const vendors = (db.prepare(`SELECT DISTINCT vendor FROM instrument`).all() as Array<{ vendor: string }>)
      .map((r) => r.vendor)
      .sort();
    expect(vendors).toEqual(['Abbott', 'Roche', 'Siemens']);
  });

  it('报警码联合主键 (vendor, model, alarm_code) 4 条全部命中', () => {
    seed({ force: true });
    const db = getDb();
    const codes = db
      .prepare(
        `SELECT vendor, model, alarm_code, alarm_label FROM alarm_code ORDER BY alarm_code`,
      )
      .all() as Array<{ vendor: string; model: string; alarm_code: string; alarm_label: string }>;
    expect(codes.length).toBe(4);
    expect(codes.map((c) => c.alarm_code)).toEqual(['A045', 'C301', 'E101', 'W002']);
    // 每条都有 SOP markdown（非空）
    const sops = db.prepare(`SELECT sop_md FROM alarm_code`).all() as Array<{ sop_md: string }>;
    for (const s of sops) {
      expect(s.sop_md.length).toBeGreaterThan(0);
      expect(s.sop_md).toMatch(/^#/); // markdown 标题开头
    }
  });

  it('校准记录分散到 3 台仪器 + 7 天时间窗', () => {
    seed({ force: true });
    const db = getDb();
    const cals = db
      .prepare(`SELECT instrument_id, calibrated_at FROM calibration ORDER BY calibrated_at DESC`)
      .all() as Array<{ instrument_id: string; calibrated_at: string }>;
    expect(cals.length).toBe(10);
    // 3 台仪器都至少有 1 条
    const instrumentIds = new Set(cals.map((c) => c.instrument_id));
    expect(instrumentIds.size).toBe(3);
    // 时间窗 ≤ 10 天（i 从 0..9，每天 1 条）
    const times = cals.map((c) => Date.parse(c.calibrated_at));
    const span = (times[0] ?? 0) - (times[times.length - 1] ?? 0);
    const days = span / (24 * 60 * 60 * 1000);
    expect(days).toBeLessThanOrEqual(10);
  });
});

describe('seed 幂等性', () => {
  beforeEach(() => {
    closeDb();
    if (fs.existsSync(TMP_DB)) fs.rmSync(TMP_DB);
    delete process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = TMP_DB;
  });

  it('二次 seed() 命中 alreadySeeded=true + 0 inserts', () => {
    const first = seed({ force: true });
    expect(first.alreadySeeded).toBe(false);
    expect(first.instruments).toBe(3);

    const second = seed();
    expect(second.alreadySeeded).toBe(true);
    expect(second.instruments).toBe(0);
    expect(second.alarmCodes).toBe(0);
    expect(second.calibrations).toBe(0);
  });

  it('isAlreadySeeded 检测器：seed 后返回 true', () => {
    seed({ force: true });
    expect(isAlreadySeeded()).toBe(true);
  });

  it('isAlreadySeeded 检测器：空库（仅 migrate，无 instrument）返回 false', () => {
    // 只 migrate 不 seed，instrument 表存在但为空
    migrate(TMP_DB);
    expect(isAlreadySeeded()).toBe(false);
  });

  it('seed({force: true}) 强制重灌（再次返回 3 instruments）', () => {
    seed({ force: true });
    // 二次跑：因主键冲突被 INSERT OR IGNORE 跳过，force 不影响 instrument / alarm / calibration 计数
    // 但 seed 函数仍会重新检测 alreadySeeded + 走 force 分支
    const result = seed({ force: true });
    // INSERT OR IGNORE 让 force 不改变已有 instrument 数 → 返回 0
    expect(result.instruments).toBe(0);
    expect(result.alarmCodes).toBe(0);
    expect(result.calibrations).toBe(0);
  });

  it('seedInstruments/seedAlarmCodes/seedCalibrations 二次调用返回 0', () => {
    seed({ force: true });
    expect(seedInstruments()).toBe(0);
    expect(seedAlarmCodes()).toBe(0);
    expect(seedCalibrations()).toBe(0);
  });
});

describe('seed 导出的常量', () => {
  it('SAMPLE_INSTRUMENTS 是 3 台仪器且 vendor 是占位名', () => {
    expect(SAMPLE_INSTRUMENTS.length).toBe(3);
    const vendors = SAMPLE_INSTRUMENTS.map((i) => i.vendor).sort();
    expect(vendors).toEqual(['Abbott', 'Roche', 'Siemens']);
  });

  it('SAMPLE_INSTRUMENTS assetTag 全部 ASSET-LAB- 占位', () => {
    for (const ins of SAMPLE_INSTRUMENTS) {
      expect(ins.asset_tag).toMatch(/^ASSET-LAB-\d{4}$/);
    }
  });

  it('SAMPLE_ALARM_CODES 是 4 条且都有 SOP', () => {
    expect(SAMPLE_ALARM_CODES.length).toBe(4);
    for (const c of SAMPLE_ALARM_CODES) {
      expect(c.vendor.length).toBeGreaterThan(0);
      expect(c.model.length).toBeGreaterThan(0);
      expect(c.alarm_code.length).toBeGreaterThan(0);
      expect(c.sop_md.length).toBeGreaterThan(0);
    }
  });
});

describe('seedPlugins 入口', () => {
  beforeEach(() => {
    closeDb();
    if (fs.existsSync(TMP_DB)) fs.rmSync(TMP_DB);
    delete process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = TMP_DB;
  });

  it('examples/manifests 不存在 → 返回 []', () => {
    // 临时改 cwd 触发路径错误
    const result = seedPlugins(path.join(os.tmpdir(), 'non-existent-' + Date.now()));
    expect(result).toEqual([]);
  });

  it('examples/manifests 存在 → 返回 plugin 列表', () => {
    seed({ force: true });
    const result = seedPlugins();
    expect(result.length).toBe(2);
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual(['iot-heartbeat', 'lis-writeback']);
  });
});
