// tests/kbar.test.ts
// ⌘K 命令面板：parseQuery / actions 工厂 / buildIndex / readKbarIndexFromDb / queryKbarFromDb。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseQuery,
  parseQueryFirst,
  INSTRUMENT_ID_PREFIX,
} from '../src/app/kbar/parseQuery.js';
import {
  createAction,
  createInternalLinkAction,
  createExternalLinkAction,
  sortActions,
  __resetActionIdsForTest,
  makeActionId,
} from '../src/app/kbar/actions.js';
import {
  buildIndex,
  readKbarIndexFromDb,
  queryKbarFromDb,
  alarmKeyOf,
  stableHash,
  FALLBACK_SECTION,
  SPLIT_HINT_NAME,
  type KbarIndexInput,
  type InstrumentRow,
  type AlarmCodeRow,
  type CalibrationRow,
  type SplitViewOpener,
} from '../src/app/kbar/registry.js';
import { getDb, closeDb } from '../src/server/db.js';
import { migrate } from '../src/server/db/migrate.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const INSTRUMENTS: InstrumentRow[] = [
  {
    instrument_id: 'ASSET-LAB-0142',
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    asset_tag: 'ASSET-LAB-0142',
    location: '门诊二楼检验科 A 区',
  },
  {
    instrument_id: 'ASSET-LAB-0143',
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    asset_tag: 'ASSET-LAB-0143',
    location: '门诊二楼检验科 B 区',
  },
  {
    instrument_id: 'ASSET-LAB-0201',
    vendor: 'Roche',
    model: 'cobas c701',
    asset_tag: 'ASSET-LAB-0201',
    location: '急诊检验',
  },
  {
    instrument_id: 'ASSET-LAB-0310',
    vendor: 'Abbott',
    model: 'Architect i2000',
    asset_tag: 'ASSET-LAB-0310',
    location: '生化组',
  },
];

const ALARM_CODES: AlarmCodeRow[] = [
  {
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    alarm_code: 'W002',
    alarm_label: '试剂仓温度异常',
  },
  {
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    alarm_code: 'E101',
    alarm_label: '样品针堵塞',
  },
  {
    vendor: 'Roche',
    model: 'cobas c701',
    alarm_code: 'AL-14',
    alarm_label: '清洗机构故障',
  },
];

const recentCalibrationTs = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

const CALIBRATIONS: CalibrationRow[] = [
  {
    calibration_id: 'C20240820-001',
    instrument_id: 'ASSET-LAB-0142',
    calibrated_at: recentCalibrationTs(1),
  },
  {
    calibration_id: 'C20240818-001',
    instrument_id: 'ASSET-LAB-0142',
    calibrated_at: recentCalibrationTs(3),
  },
  {
    calibration_id: 'C20240701-001',
    instrument_id: 'ASSET-LAB-0143',
    calibrated_at: recentCalibrationTs(2),
  },
  {
    calibration_id: 'C20240101-OUT',
    instrument_id: 'ASSET-LAB-0142',
    calibrated_at: recentCalibrationTs(120), // 超出 7 天窗口
  },
];

const INDEX: KbarIndexInput = {
  instruments: INSTRUMENTS,
  alarmCodes: ALARM_CODES,
  calibrations: CALIBRATIONS,
};

beforeEach(() => {
  __resetActionIdsForTest();
});

/* -------------------------------------------------------------------------- */
/* parseQuery                                                                 */
/* -------------------------------------------------------------------------- */

describe('parseQuery', () => {
  it('空 / 纯空白 → ok=false', () => {
    expect(parseQuery('').ok).toBe(false);
    expect(parseQuery('   ').ok).toBe(false);
    expect(parseQueryFirst('')).toBeNull();
  });

  it('单段 ASSET-* → instrumentId', () => {
    const r = parseQuery('ASSET-LAB-0142');
    expect(r.ok).toBe(true);
    expect(r.parsed).toHaveLength(1);
    expect(r.parsed[0].instrumentId).toBe('ASSET-LAB-0142');
    expect(r.parsed[0].raw).toBe('ASSET-LAB-0142');
  });

  it('单段大小写不敏感 → instrumentId', () => {
    expect(parseQuery('asset-lab-0142').parsed[0].instrumentId).toBe('asset-lab-0142');
  });

  it('单段非 ASSET 前缀 → ok=false（无兜底猜解）', () => {
    expect(parseQuery('Siemens').ok).toBe(false);
    expect(parseQuery('W002').ok).toBe(false);
  });

  it('三段 vendor/model/alarmCode', () => {
    const r = parseQuery('Siemens/ADVIA 2400/W002');
    expect(r.ok).toBe(true);
    expect(r.parsed[0]).toMatchObject({
      vendor: 'Siemens',
      model: 'ADVIA 2400',
      alarmCode: 'W002',
      raw: 'Siemens/ADVIA 2400/W002',
    });
  });

  it('三段段内空格保留', () => {
    const r = parseQuery('  Roche / cobas c701 / AL-14 ');
    expect(r.ok).toBe(true);
    expect(r.parsed[0]).toMatchObject({
      vendor: 'Roche',
      model: 'cobas c701',
      alarmCode: 'AL-14',
    });
  });

  it('两段 → ok=false（不允许两段形态）', () => {
    expect(parseQuery('Siemens/ADVIA 2400').ok).toBe(false);
  });

  it('四段及以上 → ok=false', () => {
    expect(parseQuery('a/b/c/d').ok).toBe(false);
  });

  it('三段但含空段（双 /）→ ok=false', () => {
    expect(parseQuery('Siemens//W002').ok).toBe(false);
  });

  it('INSTRUMENT_ID_PREFIX 常量值', () => {
    expect(INSTRUMENT_ID_PREFIX).toBe('ASSET-');
  });
});

/* -------------------------------------------------------------------------- */
/* actions 工厂                                                              */
/* -------------------------------------------------------------------------- */

describe('action 工厂', () => {
  it('createAction 默认 id 自增且带前缀', () => {
    const a = createAction({ name: 'x', section: '仪器', perform: () => undefined });
    expect(a.id).toMatch(/^act-\d+$/);
  });

  it('createInternalLinkAction perform 调用 push(to)', () => {
    const seen: string[] = [];
    const a = createInternalLinkAction({
      name: 'go',
      to: '/foo',
      push: (t) => seen.push(t),
      section: '仪器',
    });
    a.perform();
    expect(seen).toEqual(['/foo']);
  });

  it('createExternalLinkAction perform 在非 window 环境安全 noop', () => {
    const a = createExternalLinkAction({
      name: 'go',
      url: 'https://vendor.example.com/ticket/T-1',
      section: '手册',
    });
    // 测试环境无 window；应不抛错
    expect(() => a.perform()).not.toThrow();
  });

  it('sortActions 按 section rank + priority desc', () => {
    const a = createInternalLinkAction({ name: 'a', to: '/a', push: () => undefined, section: '仪器', priority: 1 });
    const b = createInternalLinkAction({ name: 'b', to: '/b', push: () => undefined, section: '报警码', priority: 99 });
    const c = createInternalLinkAction({ name: 'c', to: '/c', push: () => undefined, section: '仪器', priority: 5 });
    const sorted = sortActions([a, b, c]);
    // 报警码 (rank=100) > 仪器 (rank=90)；仪器内 priority 5 > priority 1
    expect(sorted.map((x) => x.name)).toEqual(['b', 'c', 'a']);
  });

  it('sortActions 同 section 同 priority 保持注册顺序', () => {
    const a = createInternalLinkAction({ name: 'a', to: '/a', push: () => undefined, section: '仪器' });
    const b = createInternalLinkAction({ name: 'b', to: '/b', push: () => undefined, section: '仪器' });
    const c = createInternalLinkAction({ name: 'c', to: '/c', push: () => undefined, section: '仪器' });
    const sorted = sortActions([c, a, b]);
    expect(sorted.map((x) => x.name)).toEqual(['c', 'a', 'b']);
  });

  it('makeActionId 自增且可注入 prefix', () => {
    expect(makeActionId('p')).toMatch(/^p-\d+$/);
    __resetActionIdsForTest();
    expect(makeActionId('q').startsWith('q-')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* buildIndex                                                                */
/* -------------------------------------------------------------------------- */

describe('buildIndex · ⌘K 命中三类对象', () => {
  it('Siemens/ADVIA 2400/W002 命中 instrument + alarmCode + calibrations', () => {
    const seen: string[] = [];
    const opened: Array<Record<string, unknown>> = [];
    const openSplit: SplitViewOpener = (t) => opened.push(t);
    const actions = buildIndex(INDEX, 'Siemens/ADVIA 2400/W002', {
      pushRoute: (to) => seen.push(to),
      openSplit,
    });

    const sections = new Set(actions.map((a) => (typeof a.section === 'string' ? a.section : a.section.name)));
    expect(sections.has('仪器')).toBe(true);
    expect(sections.has('报警码')).toBe(true);
    expect(sections.has('校准')).toBe(true);

    // SplitView 动作
    const split = actions.find((a) => a.name === SPLIT_HINT_NAME);
    expect(split, '应包含 SplitView 合并动作').toBeDefined();
    split!.perform();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      instrumentId: 'ASSET-LAB-0142',
      alarmKey: 'Siemens|ADVIA 2400|W002',
      calibrationId: 'C20240820-001',
    });
  });

  it('单段 ASSET-LAB-0142 命中 1 台仪器且不出 SplitView', () => {
    const actions = buildIndex(INDEX, 'ASSET-LAB-0142');
    expect(actions).toHaveLength(1);
    expect((typeof actions[0].section === 'string' ? actions[0].section : actions[0].section.name)).toBe('仪器');
    expect(actions[0].name).toContain('Siemens ADVIA 2400');
  });

  it('空 / 不合法 query 返回最近 5 条仪器（兜底）', () => {
    const actions = buildIndex(INDEX, '');
    expect(actions).toHaveLength(4); // 4 台全部；<= 5 条兜底
    expect(actions.every((a) => (typeof a.section === 'string' ? a.section : a.section.name) === '仪器')).toBe(true);

    const bad = buildIndex(INDEX, '随便打的中文'); // 非 ASSET- 也非三段
    expect(bad).toHaveLength(4);
  });

  it('校准窗口超过 7 天的不进入命中', () => {
    const actions = buildIndex(INDEX, 'Siemens/ADVIA 2400/W002');
    const calibActions = actions.filter(
      (a) => (typeof a.section === 'string' ? a.section : a.section.name) === '校准'
    );
    const ids = calibActions.map((a) =>
      String((a.metadata as Record<string, unknown>)?.calibrationId ?? '')
    );
    expect(ids).not.toContain('C20240101-OUT');
    expect(ids).toContain('C20240820-001');
  });

  it('⌘K 选中后 pushRoute 触发路由跳转（仪器 / 报警码 / 校准）', () => {
    const seen: string[] = [];
    const actions = buildIndex(INDEX, 'Siemens/ADVIA 2400/W002', {
      pushRoute: (to) => seen.push(to),
    });
    // 模拟 ⌘K 选中每个动作：调用 perform
    for (const a of actions) {
      a.perform();
    }
    // 至少含仪器、报警码、校准三类路由
    expect(seen.some((t) => t.startsWith('/instruments/'))).toBe(true);
    expect(seen.some((t) => t.startsWith('/alarm-codes/'))).toBe(true);
    expect(seen.some((t) => t.startsWith('/calibrations/'))).toBe(true);
  });

  it('alarmKeyOf 编码与 SQL 联合主键一致', () => {
    expect(alarmKeyOf({ vendor: 'Siemens', model: 'ADVIA 2400', alarm_code: 'W002' })).toBe(
      'Siemens|ADVIA 2400|W002'
    );
  });

  it('FALLBACK_SECTION 兜底导航', () => {
    expect(FALLBACK_SECTION).toBe('导航');
  });

  it('stableHash 稳定且区分不同字符串', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'));
    expect(stableHash('abc')).not.toBe(stableHash('abd'));
  });
});

/* -------------------------------------------------------------------------- */
/* readKbarIndexFromDb / queryKbarFromDb                                      */
/* -------------------------------------------------------------------------- */

describe('readKbarIndexFromDb · SQLite → KbarIndexInput', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    closeDb();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbar-db-'));
    tmpDbPath = path.join(tmpDir, 'lab-field-ops.sqlite');
  });

  it('从 SQLite 拉取仪器 / 报警码 / 最近 7 天校准', () => {
    const db = getDb(tmpDbPath);
    migrate(tmpDbPath);

    const insertInst = db.prepare(
      `INSERT INTO instrument (instrument_id, vendor, model, asset_tag, location, status, installed_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertInst.run('ASSET-LAB-0142', 'Siemens', 'ADVIA 2400', 'ASSET-LAB-0142', '门诊二楼', 'online', new Date().toISOString(), null);
    insertInst.run('ASSET-LAB-0201', 'Roche', 'cobas c701', 'ASSET-LAB-0201', '急诊', 'online', new Date().toISOString(), null);

    const insertAlarm = db.prepare(
      `INSERT INTO alarm_code (vendor, model, alarm_code, alarm_label, sop_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertAlarm.run('Siemens', 'ADVIA 2400', 'W002', '试剂仓温度异常', '# SOP', new Date().toISOString());

    const insertCalib = db.prepare(
      `INSERT INTO calibration (calibration_id, instrument_id, calibrated_at, payload_json, raw_hash)
       VALUES (?, ?, ?, ?, ?)`
    );
    insertCalib.run('C-RECENT-001', 'ASSET-LAB-0142', new Date().toISOString(), '{}', 'h1');
    insertCalib.run('C-OLD-001', 'ASSET-LAB-0142', new Date(Date.now() - 30 * 86400000).toISOString(), '{}', 'h2');

    const idx = readKbarIndexFromDb(db);
    expect(idx.instruments).toHaveLength(2);
    expect(idx.alarmCodes).toHaveLength(1);
    expect(idx.calibrations.map((c) => c.calibration_id)).toEqual(['C-RECENT-001']);

    // 透传：queryKbarFromDb 端到端
    const seen: string[] = [];
    const opened: Array<Record<string, unknown>> = [];
    const actions = queryKbarFromDb(db, 'Siemens/ADVIA 2400/W002', {
      pushRoute: (to) => seen.push(to),
      openSplit: (t) => opened.push(t),
    });
    expect(actions.some((a) => (typeof a.section === 'string' ? a.section : a.section.name) === '仪器')).toBe(true);
    expect(actions.some((a) => (typeof a.section === 'string' ? a.section : a.section.name) === '报警码')).toBe(true);

    // 模拟 ⌘K 选定 SplitView 合并动作
    const splitAction = actions.find((a) => a.name === SPLIT_HINT_NAME);
    expect(splitAction).toBeDefined();
    splitAction!.perform();
    expect(opened).toHaveLength(1);

    closeDb();
    fs.rmSync(path.dirname(tmpDbPath), { recursive: true, force: true });
  });
});