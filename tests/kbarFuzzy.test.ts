// tests/kbarFuzzy.test.ts
// ⌘K 模糊匹配 + 多键索引（task 19）。
//
//   - fuzzy.ts:   Levenshtein / 距离 → 相似度 / 中文 vendor 桥；
//   - multiIndex: 五类对象索引 + 模糊查询；
//   - registry:   fuzzy 命中转 actions。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  levenshtein,
  isFuzzyMatch,
  similarity,
  toCodePoints,
  canonicalVendor,
  VENDOR_ZH_ALIAS,
  MAX_DISTANCE_DEFAULT,
} from '../src/app/kbar/fuzzy.js';
import {
  buildMultiIndex,
  queryMulti,
  SCORE_THRESHOLD,
  alarmKeyOf,
  type MultiIndexInput,
  type PluginCardRow,
  type ManualEntryRow,
} from '../src/app/kbar/multiIndex.js';
import {
  buildIndex,
  hitsToActions,
  type KbarIndexInput,
  type InstrumentRow,
  type AlarmCodeRow,
  type CalibrationRow,
} from '../src/app/kbar/registry.js';
import { __resetActionIdsForTest } from '../src/app/kbar/actions.js';

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
    calibration_id: 'C20240818-002',
    instrument_id: 'ASSET-LAB-0143',
    calibrated_at: recentCalibrationTs(2),
  },
  {
    calibration_id: 'C20240701-OUT',
    instrument_id: 'ASSET-LAB-0142',
    calibrated_at: recentCalibrationTs(120),
  },
];

const PLUGIN_CARDS: PluginCardRow[] = [
  {
    plugin_name: 'lis-writeback',
    vendor: 'Siemens',
    description: 'LIS 通道 writeback 适配器',
  },
  {
    plugin_name: 'iot-heartbeat',
    vendor: 'Roche',
    description: 'IoT 网关心跳接收',
  },
];

const MANUALS: ManualEntryRow[] = [
  {
    manual_id: 'M-001',
    title: 'ADVIA 2400 操作手册',
    vendor: 'Siemens',
    model: 'ADVIA 2400',
  },
];

const INPUT: MultiIndexInput = {
  instruments: INSTRUMENTS,
  alarmCodes: ALARM_CODES,
  calibrations: CALIBRATIONS,
  pluginCards: PLUGIN_CARDS,
  manuals: MANUALS,
};

beforeEach(() => {
  __resetActionIdsForTest();
});

/* -------------------------------------------------------------------------- */
/* fuzzy.ts                                                                  */
/* -------------------------------------------------------------------------- */

describe('fuzzy.ts', () => {
  describe('MAX_DISTANCE_DEFAULT', () => {
    it('默认上限为 1', () => {
      expect(MAX_DISTANCE_DEFAULT).toBe(1);
    });
  });

  describe('toCodePoints', () => {
    it('ASCII 串每字符一码点', () => {
      expect(toCodePoints('abc')).toEqual(['a', 'b', 'c']);
    });
    it('中文按字符切分（不按字节）', () => {
      expect(toCodePoints('西门子')).toEqual(['西', '门', '子']);
    });
    it('混合中英文', () => {
      expect(toCodePoints('西门A')).toEqual(['西', '门', 'A']);
    });
    it('空串 → []', () => {
      expect(toCodePoints('')).toEqual([]);
    });
  });

  describe('levenshtein', () => {
    it('同字符串 → 0', () => {
      expect(levenshtein('abc', 'abc')).toBe(0);
      expect(levenshtein('西门子', '西门子')).toBe(0);
    });
    it('一个字符差 → 1', () => {
      expect(levenshtein('abc', 'abd')).toBe(1);
      expect(levenshtein('abc', 'aXc')).toBe(1);
      expect(levenshtein('ADVIA 2400', 'ADVIA2400')).toBe(1);
    });
    it('两个字符差 → max+1（> max）', () => {
      // 'abc' → 'xyc' = 2 substitutions（a→x, b→y）
      expect(levenshtein('abc', 'xyc', 1)).toBe(2);
      // 'abc' → 'xyz' = 3 substitutions
      expect(levenshtein('abc', 'xyz', 1)).toBe(2);
    });
    it('长度差超过 max → max+1（早退）', () => {
      // 长度差 2 超过 max=1 → 直接不匹配
      expect(levenshtein('abcd', 'xy', 1)).toBe(2);
    });
    it('中文按字符计算：缺 2 字符 → distance > 1', () => {
      // 西门子 (3) vs 门 (1)：删 2 字符 → distance = 2 > 1
      expect(levenshtein('西门子', '门', 1)).toBeGreaterThan(1);
    });
    it('中文按字符计算：缺 1 字符 → distance = 1（边界值）', () => {
      // 西门子 (3) vs 西门 (2)：删 1 字符 → distance = 1（命中阈值）
      expect(levenshtein('西门子', '西门', 1)).toBe(1);
    });
  });

  describe('isFuzzyMatch', () => {
    it('同字符串命中', () => {
      expect(isFuzzyMatch('ADVIA 2400', 'ADVIA 2400')).toBe(true);
    });
    it('一个字符差命中（≤ 1）', () => {
      // 删除一个空格 → distance 1
      expect(isFuzzyMatch('ADVIA 2400', 'ADVIA2400')).toBe(true);
      // 删除一个字符
      expect(isFuzzyMatch('W002', 'W02')).toBe(true);
      // 单次替换（0 → O）
      expect(isFuzzyMatch('W002', 'WO02')).toBe(true);
    });
    it('两个字符差不命中', () => {
      // 'ADVIA 2400' vs 'BDVIA 2500' = 2 次替换（A→B, 4→5）→ distance 2
      expect(isFuzzyMatch('ADVIA 2400', 'BDVIA 2500', 1)).toBe(false);
      // 'W002' vs 'X100' = 3 次替换 → distance 3
      expect(isFuzzyMatch('W002', 'X100', 1)).toBe(false);
    });
    it('空串不命中（除非两串都空）', () => {
      expect(isFuzzyMatch('', 'abc')).toBe(false);
      expect(isFuzzyMatch('abc', '')).toBe(false);
      expect(isFuzzyMatch('', '')).toBe(true);
    });
  });

  describe('similarity', () => {
    it('同字符串 → 1.0', () => {
      expect(similarity('abc', 'abc')).toBe(1);
    });
    it('一个字符差 → 0.5 (max=1)', () => {
      expect(similarity('abc', 'abd')).toBe(0.5);
    });
    it('超过阈值 → 0', () => {
      expect(similarity('abc', 'xyz', 1)).toBe(0);
    });
    it('空参数 → 0', () => {
      expect(similarity('', 'abc')).toBe(0);
      expect(similarity('abc', '')).toBe(0);
    });
  });

  describe('canonicalVendor', () => {
    it('中文别名 → 标准英文', () => {
      expect(canonicalVendor('西门子')).toBe('Siemens');
      expect(canonicalVendor('罗氏')).toBe('Roche');
      expect(canonicalVendor('雅培')).toBe('Abbott');
    });
    it('已是规范英文 → 原样', () => {
      expect(canonicalVendor('Siemens')).toBe('Siemens');
      expect(canonicalVendor('roche')).toBe('Roche');
    });
    it('未知 vendor → 原样', () => {
      expect(canonicalVendor('StubVendor')).toBe('StubVendor');
    });
    it('空 / 纯空白 → 规范化（trim）', () => {
      // 设计决策：纯空白 trim 后视为空；非空 vendor 命中后归一为英文
      expect(canonicalVendor('')).toBe('');
      expect(canonicalVendor('   ')).toBe('');
      expect(canonicalVendor('西门子')).toBe('Siemens');
    });
  });

  describe('VENDOR_ZH_ALIAS 桥', () => {
    it('至少含 Siemens/Roche/Abbott/Beckman', () => {
      expect(VENDOR_ZH_ALIAS['西门子']).toBe('Siemens');
      expect(VENDOR_ZH_ALIAS['罗氏']).toBe('Roche');
      expect(VENDOR_ZH_ALIAS['雅培']).toBe('Abbott');
      expect(VENDOR_ZH_ALIAS['贝克曼']).toBe('Beckman');
    });
  });
});

/* -------------------------------------------------------------------------- */
/* multiIndex                                                                */
/* -------------------------------------------------------------------------- */

describe('multiIndex · build', () => {
  it('五类对象都进 textItems', () => {
    const idx = buildMultiIndex(INPUT);
    const expected =
      INSTRUMENTS.length +
      ALARM_CODES.length +
      CALIBRATIONS.length +
      PLUGIN_CARDS.length +
      MANUALS.length;
    expect(idx.textItems).toHaveLength(expected);
  });

  it('按 instrument_id / vendor / model 分桶', () => {
    const idx = buildMultiIndex(INPUT);
    expect(idx.byInstrumentId.get('ASSET-LAB-0142')?.length).toBeGreaterThan(0);
    expect(idx.byVendor.get('siemens')?.length).toBeGreaterThanOrEqual(2); // 仪器 142 + 143
    expect(idx.byModel.get('advia 2400')?.length).toBeGreaterThanOrEqual(2); // 仪器 + 手册
  });

  it('alarmKey 桶对每个 alarm 编码唯一', () => {
    const idx = buildMultiIndex(INPUT);
    expect(idx.byAlarmKey.size).toBe(ALARM_CODES.length);
    expect(idx.byAlarmKey.get('Siemens|ADVIA 2400|W002')?.kind).toBe('AlarmCode');
  });

  it('alarmKeyOf 编码与 SQL 联合主键一致', () => {
    expect(
      alarmKeyOf({ vendor: 'Siemens', model: 'ADVIA 2400', alarm_code: 'W002' })
    ).toBe('Siemens|ADVIA 2400|W002');
  });
});

describe('multiIndex · queryMulti', () => {
  it('typo "ADVIA2400" vs "ADVIA 2400" 命中 AlarmCode/Instrument', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, 'ADVIA2400');
    expect(hits.length).toBeGreaterThan(0);
    // alarmCode W002/E101 (Siemens ADVIA 2400) 应被命中
    const alarmHit = hits.find((h) => h.item.kind === 'AlarmCode' && h.item.id.includes('W002'));
    expect(alarmHit).toBeDefined();
  });

  it('中文 "西门子" → vendor=Siemens 命中', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, '西门子');
    expect(hits.length).toBeGreaterThan(0);
    // 至少有一个命中含 Siemens 关键字
    const hasSiemens = hits.some((h) => h.item.keywords.includes('Siemens'));
    expect(hasSiemens).toBe(true);
    // 完全匹配 vendor 应得高分
    const topHit = hits[0];
    expect(topHit.score).toBeGreaterThanOrEqual(0.9);
  });

  it('空查询返回最近 5 条', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, '');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  it('纯空白查询返回最近 5 条', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, '   ');
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  it('alarmCode 完全匹配得分 = 1.0', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, 'W002');
    const ac = hits.filter((h) => h.item.kind === 'AlarmCode');
    expect(ac[0].score).toBe(1.0);
    expect(ac[0].matchedKey).toBe('alarmCode:W002');
  });

  it('typo alarmCode "WO02" 命中 "W002"（Levenshtein=1：单次替换）', () => {
    const idx = buildMultiIndex(INPUT);
    // 'W002' → 'WO02' = 1 次替换（position 1：0→O）；命中模糊层
    const hits = queryMulti(idx, 'WO02');
    const ac = hits.filter((h) => h.item.kind === 'AlarmCode');
    expect(ac.length).toBeGreaterThan(0);
    expect(ac[0].item.id).toContain('W002');
  });

  it('threshold 过滤 fuzzy（=1.0 时挡掉 fuzzy）', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, 'WOO2', 1.0);
    const ac = hits.filter((h) => h.item.kind === 'AlarmCode');
    expect(ac.length).toBe(0); // 全滤掉：score=0.7 < 1.0
  });

  it('threshold=0 保留所有（含 fuzzy 与空占位）', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, 'Siemens', 0);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('完全乱码 "xyzqwerty" 不命中（兜底走 recentFallback 由 registry 处理）', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, 'xyzqwerty');
    expect(hits.length).toBe(0);
  });

  it('同 score 时按类内优先级排序', () => {
    const idx = buildMultiIndex(INPUT);
    // "Siemens" 命中 Siemens 仪器 + Siemens AlarmCode 都得 0.95
    const hits = queryMulti(idx, 'Siemens');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const firstKind = hits[0].item.kind;
    // AlarmCode 优先级 100 > Instrument 90 → AlarmCode 应在 Instrument 前面
    // 但同 score 下结果依类内优先级
    const alarmIdx = hits.findIndex((h) => h.item.kind === 'AlarmCode');
    const instIdx = hits.findIndex((h) => h.item.kind === 'Instrument');
    expect(alarmIdx).toBeLessThan(instIdx);
  });

  it('SCORE_THRESHOLD 常量值', () => {
    expect(SCORE_THRESHOLD).toBe(0.5);
  });
});

/* -------------------------------------------------------------------------- */
/* registry 集成                                                              */
/* -------------------------------------------------------------------------- */

describe('registry · fuzzy 集成（buildIndex 非结构化路径）', () => {
  it('typo "ADVIA2400" → 命中 AlarmCode/Instrument 而非纯最近', () => {
    const actions = buildIndex(INDEX_FROM_MULTI(), 'ADVIA2400');
    const sections = new Set(
      actions.map((a) => (typeof a.section === 'string' ? a.section : a.section.name))
    );
    expect(sections.has('报警码')).toBe(true);
    expect(sections.has('仪器')).toBe(true);
  });

  it('纯乱码 → 兜底最近 5 条仪器', () => {
    const actions = buildIndex(INDEX_FROM_MULTI(), 'xyzqwerty');
    expect(actions).toHaveLength(INSTRUMENTS.length);
    expect(
      actions.every(
        (a) => (typeof a.section === 'string' ? a.section : a.section.name) === '仪器'
      )
    ).toBe(true);
  });

  it('结构化 "Siemens/ADVIA 2400/W002" 仍走精确路径（不变）', () => {
    const seen: string[] = [];
    const opened: Array<Record<string, unknown>> = [];
    const actions = buildIndex(INDEX_FROM_MULTI(), 'Siemens/ADVIA 2400/W002', {
      pushRoute: (to) => seen.push(to),
      openSplit: (t) => opened.push(t),
    });
    const sections = new Set(
      actions.map((a) => (typeof a.section === 'string' ? a.section : a.section.name))
    );
    expect(sections.has('仪器')).toBe(true);
    expect(sections.has('报警码')).toBe(true);
    expect(sections.has('校准')).toBe(true);
  });

  it('hitsToActions 为 AlarmCode 生成 to=/alarm-codes/...（perform 触发 pushRoute）', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, 'W002');
    const seen: string[] = [];
    const actions = hitsToActions(hits, { pushRoute: (to) => seen.push(to) });
    const acAction = actions.find((a) => {
      const sect = typeof a.section === 'string' ? a.section : a.section.name;
      return sect === '报警码';
    });
    expect(acAction).toBeDefined();
    // metadata.alarmKey 为联合主键
    expect((acAction!.metadata as Record<string, unknown>).alarmKey).toBe(
      'Siemens|ADVIA 2400|W002'
    );
    // perform 触发 pushRoute → 路由 /alarm-codes/<v>/<m>/<code>
    acAction!.perform();
    expect(seen.some((t) => t.startsWith('/alarm-codes/'))).toBe(true);
    expect(seen.some((t) => t.includes('W002'))).toBe(true);
  });

  it('hitsToActions 为 Instrument 生成 to=/instruments/<id>（perform 触发 pushRoute）', () => {
    const idx = buildMultiIndex(INPUT);
    const hits = queryMulti(idx, 'Siemens');
    const seen: string[] = [];
    const actions = hitsToActions(hits, { pushRoute: (to) => seen.push(to) });
    // 至少一个 Instrument action；调用 perform 验证 pushRoute 路由
    const instAction = actions.find((a) => {
      const md = a.metadata as Record<string, unknown>;
      return md.kind === 'Instrument';
    });
    expect(instAction).toBeDefined();
    instAction!.perform();
    expect(seen.some((t) => t.startsWith('/instruments/'))).toBe(true);
  });
});

/* 兼容 helper：buildIndex 接收 KbarIndexInput，传与 MultiIndex 同样的 fixtures。 */
function INDEX_FROM_MULTI(): KbarIndexInput {
  return {
    instruments: INSTRUMENTS,
    alarmCodes: ALARM_CODES,
    calibrations: CALIBRATIONS,
  };
}
