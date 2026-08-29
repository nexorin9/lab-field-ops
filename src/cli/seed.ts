// src/cli/seed.ts
//
// CLI seed：灌入脱敏样例数据，让科员 2 分钟内跑通 demo。
//
// 设计原则：
//  1) 幂等：已存在则跳过（用 count() 判定，避免主键冲突 + append-only 触发器误伤）
//  2) 脱敏：asset_tag 用 ASSET-LAB-{0001..0003} 占位，绝不写真实编码
//  3) 占位 vendor：Siemens / Roche / Abbott（行业常用厂商名占位）
//  4) 一站式：3 台仪器 + 4 类报警码 + 10 条校准 + 2 个示例 plugin manifest
//  5) 不依赖 LLM：确定性 SQL INSERT，便于 CI 跑通
//
// 领养的调用链（参考 outline/server/commands 的 seed 形态）：
//   `pnpm seed` → ts-node → migrate() → seedInstruments() / seedAlarmCodes() /
//   seedCalibrations() / seedPlugins() → stdout 反馈

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, closeDb } from '../server/db.js';
import { migrate } from '../server/db/migrate.js';
import { PluginManager } from '../server/plugin/manager.js';
import type {
  Instrument,
  AlarmCode,
  Calibration,
} from '@shared/types.js';

/** 脱敏仪器占位（vendor 名 = 行业常见厂商名占位；asset_tag 用显式占位符）。 */
export const SAMPLE_INSTRUMENTS: Array<Omit<Instrument, 'last_seen_at'>> = [
  {
    instrument_id: 'ASSET-LAB-0001',
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    asset_tag: 'ASSET-LAB-0001',
    location: '门诊二楼检验科 A 区',
    status: 'online',
    installed_at: '2024-01-15T08:00:00Z',
  },
  {
    instrument_id: 'ASSET-LAB-0002',
    vendor: 'Roche',
    model: 'cobas c702',
    asset_tag: 'ASSET-LAB-0002',
    location: '门诊二楼检验科 B 区',
    status: 'online',
    installed_at: '2024-03-22T08:00:00Z',
  },
  {
    instrument_id: 'ASSET-LAB-0003',
    vendor: 'Abbott',
    model: 'Architect i2000',
    asset_tag: 'ASSET-LAB-0003',
    location: '住院部三楼中心实验室',
    status: 'alarm',
    installed_at: '2023-11-08T08:00:00Z',
  },
];

/** 4 类报警码（每类对应一种 SOP 模板，便于 ⌘K 命中）。 */
export const SAMPLE_ALARM_CODES: AlarmCode[] = [
  {
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    alarm_code: 'W002',
    alarm_label: '样本量不足',
    sop_md:
      '# 样本量不足（W002）\n\n1. 检查样本管是否倾斜放置\n2. 确认离心参数 1500g × 10min\n3. 重新混匀后复测\n4. 仍报警 → 联系厂商',
    created_at: '2024-01-15T08:00:00Z',
  },
  {
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    alarm_code: 'E101',
    alarm_label: '试剂仓温度异常',
    sop_md:
      '# 试剂仓温度异常（E101）\n\n1. 检查试剂仓门密封\n2. 查看温控日志\n3. 清理冷凝器\n4. 复测仍异常 → 申请停机维修',
    created_at: '2024-01-15T08:00:00Z',
  },
  {
    vendor: 'Roche',
    model: 'cobas c702',
    alarm_code: 'A045',
    alarm_label: '比色杯老化',
    sop_md:
      '# 比色杯老化（A045）\n\n1. 查看累计测试数（>5000 建议更换）\n2. 更换比色杯\n3. 执行空白校准\n4. 质控通过后恢复',
    created_at: '2024-03-22T08:00:00Z',
  },
  {
    vendor: 'Abbott',
    model: 'Architect i2000',
    alarm_code: 'C301',
    alarm_label: '机械臂校准漂移',
    sop_md:
      '# 机械臂校准漂移（C301）\n\n1. 检查急诊样本冲击\n2. 重新执行机械臂校准\n3. 质控通过后继续\n4. 持续漂移 → 报修',
    created_at: '2023-11-08T08:00:00Z',
  },
];

/** 生成 10 条校准记录（分散到 3 台仪器 + 7 天时间窗）。 */
function buildSampleCalibrations(): Calibration[] {
  const out: Calibration[] = [];
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  for (let i = 0; i < 10; i++) {
    const instrument = SAMPLE_INSTRUMENTS[i % SAMPLE_INSTRUMENTS.length]!;
    const calibratedAt = new Date(now - i * day).toISOString();
    const payload = {
      kind: i % 2 === 0 ? 'scheduled' : 'triggered',
      calibration_target: ['chemistry', 'immunoassay', 'hematology'][i % 3],
      qc_pass: i % 4 !== 0,
      note: '脱敏样例：seed 灌入的占位校准记录',
    };
    const rawHash = `seed-hash-${i.toString().padStart(2, '0')}-${randomUUID().slice(0, 8)}`;
    out.push({
      calibration_id: `CAL-SEED-${i.toString().padStart(3, '0')}`,
      instrument_id: instrument.instrument_id,
      calibrated_at: calibratedAt,
      payload_json: payload,
      raw_hash: rawHash,
    });
  }
  return out;
}

/** 把脱敏仪器插入 instrument 表（幂等：主键冲突忽略）。 */
export function seedInstruments(db = getDb(), instruments = SAMPLE_INSTRUMENTS): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO instrument
       (instrument_id, vendor, model, asset_tag, location, status, installed_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = db.transaction((rows: typeof instruments) => {
    for (const ins of rows) {
      const info = insert.run(
        ins.instrument_id,
        ins.vendor,
        ins.model,
        ins.asset_tag,
        ins.location,
        ins.status,
        ins.installed_at,
        ins.status === 'offline' ? null : new Date().toISOString(),
      );
      if (info.changes > 0) inserted++;
    }
  });
  tx(instruments);
  return inserted;
}

/** 把脱敏报警码插入 alarm_code 表（联合主键，幂等）。 */
export function seedAlarmCodes(db = getDb(), codes = SAMPLE_ALARM_CODES): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO alarm_code
       (vendor, model, alarm_code, alarm_label, sop_md, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = db.transaction((rows: typeof codes) => {
    for (const c of rows) {
      const info = insert.run(c.vendor, c.model, c.alarm_code, c.alarm_label, c.sop_md, c.created_at);
      if (info.changes > 0) inserted++;
    }
  });
  tx(codes);
  return inserted;
}

/** 把脱敏校准记录插入 calibration 表（幂等）。 */
export function seedCalibrations(db = getDb(), rows = buildSampleCalibrations()): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO calibration
       (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = db.transaction((calRows: Calibration[]) => {
    for (const c of calRows) {
      const info = insert.run(
        c.calibration_id,
        c.instrument_id,
        c.calibrated_at,
        JSON.stringify(c.payload_json),
        c.raw_hash,
      );
      if (info.changes > 0) inserted++;
    }
  });
  tx(rows);
  return inserted;
}

/** 把 examples/manifests/ 下的示例 plugin 灌入 plugin_manifest 表（幂等）。 */
export function seedPlugins(manifestDir?: string): { name: string; ok: boolean; reason?: string }[] {
  const dir = manifestDir ?? path.resolve(process.cwd(), 'examples/manifests');
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const out: { name: string; ok: boolean; reason?: string }[] = [];
  for (const f of files) {
    const fullPath = path.join(dir, f);
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      // seed 只负责落 DB；handler 注册由 registerAllTasks() 在 server 启动时做
      const name = String(manifest.name ?? path.basename(f, '.json'));
      const existing = PluginManager.get(name);
      if (existing) {
        out.push({ name, ok: true, reason: 'already-installed' });
        continue;
      }
      PluginManager.add(manifest as never, undefined);
      out.push({ name, ok: true });
    } catch (err) {
      out.push({ name: f, ok: false, reason: (err as Error).message });
    }
  }
  return out;
}

/** 当前数据库是否已有 seed 数据（避免重复灌入）。 */
export function isAlreadySeeded(db = getDb()): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM instrument`).get() as { c: number };
  return row.c > 0;
}

/** seed 入口：migrate → 灌入 → 反馈。 */
export function seed(opts: { manifestDir?: string; force?: boolean } = {}): {
  instruments: number;
  alarmCodes: number;
  calibrations: number;
  plugins: { name: string; ok: boolean; reason?: string }[];
  alreadySeeded: boolean;
} {
  // 1. 先建库（幂等）
  const dbPath = process.env.DATABASE_PATH;
  migrate(dbPath);

  // 2. 检测是否已 seed
  const db = getDb();
  const alreadySeeded = isAlreadySeeded(db);
  if (alreadySeeded && !opts.force) {
    const plugins = seedPlugins(opts.manifestDir);
    return { instruments: 0, alarmCodes: 0, calibrations: 0, plugins, alreadySeeded: true };
  }

  // 3. 灌入脱敏数据
  const instruments = seedInstruments(db);
  const alarmCodes = seedAlarmCodes(db);
  const calibrations = seedCalibrations(db);
  const plugins = seedPlugins(opts.manifestDir);

  return { instruments, alarmCodes, calibrations, plugins, alreadySeeded: false };
}

/** CLI 直接执行入口（ts-node / dist/cli/seed.js 都走这里）。 */
function main(): void {
  const argv1 = process.argv[1] ?? '';
  const isCliEntry =
    argv1.endsWith('cli/seed.js') || argv1.endsWith('cli/seed.ts') || argv1.endsWith('dist/cli/seed.js');
  if (!isCliEntry) return;

  const force = process.argv.includes('--force');
  const result = seed({ force });
  if (result.alreadySeeded) {
    console.log('[seed] already seeded; use --force to re-seed');
  } else {
    console.log(
      `[seed] inserted: ${result.instruments} instruments, ${result.alarmCodes} alarm_codes, ${result.calibrations} calibrations`,
    );
  }
  for (const p of result.plugins) {
    if (p.ok) {
      const tag = p.reason ? ` (${p.reason})` : '';
      console.log(`[seed] plugin: ${p.name}${tag}`);
    } else {
      console.error(`[seed] plugin failed: ${p.name} (${p.reason})`);
    }
  }
  closeDb();
}

main();
