// scripts/golden/kbar-samples.ts
//
// 生成 ⌘K 命中 golden fixture → scripts/golden/expected/kbar.json，
// 供 tests/kbarGolden.test.ts 对照。
//
// 与 tests/kbarFuzzy.test.ts 的差异：
//   - kbarFuzzy.test.ts 验证「匹配算法主路径」（Levenshtein / 中文桥 / 阈值）；
//   - kbarGolden.test.ts 验证「命中结果字段稳定」——工程师在 ⌘K 面板看到的
//     kind / id / section / score / matchedKey / 动作 id 与路由，一旦漂移
//     会直接表现为「⌘K 选完打不开对应页面」，故用 golden 锁住。
//
// 本文件的 expected 是**手写**的：跑一遍 queryMulti 校验，不一致就抛错，
// 避免「生成什么就锁什么」的同义反复。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMultiIndex, queryMulti } from '../../src/app/kbar/multiIndex.js';
import { GOLDEN_INDEX_INPUT } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'expected');

export interface KbarGoldenHit {
  kind: string;
  id: string;
  section: string;
  score: number;
  matchedKey: string;
  /** ⌘K 选定后由 hitsToActions 生成的动作 id 与内部路由（插件 / 手册无路由 = null）。 */
  actionId: string;
  route: string | null;
}

export interface KbarGoldenCase {
  query: string;
  description: string;
  expected: KbarGoldenHit[];
}

export interface KbarGoldenFile {
  /** golden 版本号；字段命名或匹配语义变更时 bump。 */
  version: 1;
  /** score ≥ 该阈值才返回（与 multiIndex.SCORE_THRESHOLD 同源）。 */
  scoreThreshold: number;
  cases: KbarGoldenCase[];
}

const hit = (
  kind: string,
  id: string,
  section: string,
  score: number,
  matchedKey: string,
  route: string | null,
): KbarGoldenHit => ({
  kind,
  id,
  section,
  score,
  matchedKey,
  actionId: `fuzzy-${kind}-${id}`,
  route,
});

const cases: KbarGoldenCase[] = [
  {
    query: 'ASSET-LAB-0142',
    description: '资产编码精确命中：仪器 + 该仪器最近校准，一次 ⌘K 两类对象同屏',
    expected: [
      hit('Instrument', 'ASSET-LAB-0142', '仪器', 1, 'instrumentId:ASSET-LAB-0142', '/instruments/ASSET-LAB-0142'),
      hit('Calibration', 'C20240117001', '校准', 1, 'instrumentId:ASSET-LAB-0142', '/calibrations/C20240117001'),
    ],
  },
  {
    query: 'W002',
    description: '报警码精确命中：仪器屏幕报什么码就搜什么码',
    expected: [
      hit(
        'AlarmCode',
        'Siemens|ADVIA 2400|W002',
        '报警码',
        1,
        'alarmCode:W002',
        '/alarm-codes/Siemens/ADVIA%202400/W002',
      ),
    ],
  },
  {
    query: '西门子',
    description: '中文厂商口语 → DB 内英文 vendor 桥（业务人员不会打 Siemens）',
    expected: [
      hit('AlarmCode', 'Siemens|ADVIA 2400|W002', '报警码', 0.95, 'vendor:siemens', '/alarm-codes/Siemens/ADVIA%202400/W002'),
      hit('Instrument', 'ASSET-LAB-0142', '仪器', 0.95, 'vendor:siemens', '/instruments/ASSET-LAB-0142'),
      hit('ManualEntry', 'MAN-ADVIA-2400', '手册', 0.95, 'vendor:siemens', null),
    ],
  },
  {
    query: 'ADVIA 2400',
    description: '型号精确命中：三类对象（报警码 / 仪器 / 手册）同分，按类内优先级排序',
    expected: [
      hit('AlarmCode', 'Siemens|ADVIA 2400|W002', '报警码', 0.9, 'model:advia 2400', '/alarm-codes/Siemens/ADVIA%202400/W002'),
      hit('Instrument', 'ASSET-LAB-0142', '仪器', 0.9, 'model:advia 2400', '/instruments/ASSET-LAB-0142'),
      hit('ManualEntry', 'MAN-ADVIA-2400', '手册', 0.9, 'model:advia 2400', null),
    ],
  },
  {
    query: 'ADVIA2400',
    description: '漏打空格（编辑距离 1）仍命中同三类对象，只是降为模糊分',
    expected: [
      hit('AlarmCode', 'Siemens|ADVIA 2400|W002', '报警码', 0.6, 'model~:advia 2400', '/alarm-codes/Siemens/ADVIA%202400/W002'),
      hit('Instrument', 'ASSET-LAB-0142', '仪器', 0.6, 'model~:advia 2400', '/instruments/ASSET-LAB-0142'),
      hit('ManualEntry', 'MAN-ADVIA-2400', '手册', 0.6, 'model~:advia 2400', null),
    ],
  },
  {
    query: 'cobas c701',
    description: '另一台生化仪型号：只命中该机对应的报警码与仪器，不串到别的厂牌',
    expected: [
      hit('AlarmCode', 'Roche|cobas c701|E145', '报警码', 0.9, 'model:cobas c701', '/alarm-codes/Roche/cobas%20c701/E145'),
      hit('Instrument', 'ASSET-LAB-0201', '仪器', 0.9, 'model:cobas c701', '/instruments/ASSET-LAB-0201'),
    ],
  },
  {
    query: 'lis-writeback',
    description: '插件名命中：信息科工程师用 ⌘K 直接跳到插件卡片',
    expected: [
      hit('PluginCard', 'lis-writeback', '插件', 0.6, 'kw:lis-writeback', null),
    ],
  },
  {
    query: '不存在的东西xyz',
    description: '无命中：返回空列表，由 UI 兜底提示「未匹配，编辑查询」',
    expected: [],
  },
];

/**
 * 组装 golden：跑一遍 queryMulti 校验手写期望，不一致直接抛错，
 * 避免「生成什么就锁什么」的同义反复。
 */
export function buildKbarGolden(): KbarGoldenFile {
  const idx = buildMultiIndex(GOLDEN_INDEX_INPUT);
  for (const c of cases) {
    const hits = queryMulti(idx, c.query);
    if (hits.length !== c.expected.length) {
      throw new Error(
        `golden 命中数失配: query=${c.query} → ${hits.length} 条，期望 ${c.expected.length} 条`,
      );
    }
    hits.forEach((h, i) => {
      const e = c.expected[i];
      if (h.item.kind !== e.kind || h.item.id !== e.id) {
        throw new Error(
          `golden 命中对象失配: query=${c.query}[${i}] → ${h.item.kind}/${h.item.id}，期望 ${e.kind}/${e.id}`,
        );
      }
      if (h.score !== e.score || h.matchedKey !== e.matchedKey) {
        throw new Error(
          `golden 分数/匹配键失配: query=${c.query}[${i}] → ${h.score}/${h.matchedKey}，期望 ${e.score}/${e.matchedKey}`,
        );
      }
    });
  }
  return { version: 1, scoreThreshold: 0.5, cases };
}

/** 写回锁文件；仅由 `pnpm golden` 显式触发，普通 `pnpm test` 不写盘。 */
export function writeKbarGolden(targetDir: string = outDir): string {
  const golden = buildKbarGolden();
  mkdirSync(targetDir, { recursive: true });
  const outPath = join(targetDir, 'kbar.json');
  writeFileSync(outPath, JSON.stringify(golden, null, 2) + '\n', 'utf8');
  return outPath;
}

if (process.env.GOLDEN_WRITE === '1') {
  const p = writeKbarGolden();
  console.log(`kbar golden 已生成: ${p}`);
}
