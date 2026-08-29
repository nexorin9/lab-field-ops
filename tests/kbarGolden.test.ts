// tests/kbarGolden.test.ts
//
// ⌘K 命中结果对照测试：用 scripts/golden/expected/kbar.json 锁住
// 「工程师在命令面板里看到什么、选完跳到哪」。
//
// 与 tests/kbarFuzzy.test.ts 的差异：
//   - kbarFuzzy.test.ts 验证匹配**算法**（Levenshtein / 中文桥 / 阈值 / 排序规则）；
//   - 本文件验证匹配**结果的字段与顺序**：kind / id / section / score /
//     matchedKey / 动作 id / 内部路由。这几项漂移不会让算法测试变红，
//     但会直接表现为「⌘K 选完打不开对应页面」或「面板里换了个顺序」。
//
// 输入：scripts/golden/fixtures.ts 的固定脱敏数据集。
// 期望：scripts/golden/expected/kbar.json（手写，由 pnpm golden 校验后写盘）。

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMultiIndex,
  queryMulti,
  SCORE_THRESHOLD,
  type MultiIndex,
} from '../src/app/kbar/multiIndex.js';
import { hitsToActions } from '../src/app/kbar/registry.js';
import { __resetActionIdsForTest } from '../src/app/kbar/actions.js';
import { GOLDEN_INDEX_INPUT } from '../scripts/golden/fixtures.js';

interface GoldenHit {
  kind: string;
  id: string;
  section: string;
  score: number;
  matchedKey: string;
  actionId: string;
  route: string | null;
}

interface GoldenCase {
  query: string;
  description: string;
  expected: GoldenHit[];
}

interface GoldenFile {
  version: number;
  scoreThreshold: number;
  cases: GoldenCase[];
}

const goldenPath = join(__dirname, '..', 'scripts', 'golden', 'expected', 'kbar.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenFile;

let index: MultiIndex;

beforeEach(() => {
  __resetActionIdsForTest();
  index = buildMultiIndex(GOLDEN_INDEX_INPUT);
});

/** 用 push 替身捕获 ⌘K 选定后要跳转的内部路由。 */
function routeOf(action: { perform: () => void | Promise<void> }, pushed: string[]): string | null {
  pushed.length = 0;
  action.perform();
  return pushed.length ? pushed[0] : null;
}

describe('⌘K golden 对照', () => {
  it('golden 文件存在、version=1、阈值与实现同源', () => {
    expect(golden.version).toBe(1);
    expect(golden.scoreThreshold).toBe(SCORE_THRESHOLD);
    expect(golden.cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const c of golden.cases) {
    it(`[${c.query || '(空查询)'}] ${c.description}`, () => {
      const hits = queryMulti(index, c.query);

      // 命中数量与顺序完全一致（顺序 = 面板里的排列顺序）
      expect(hits.length).toBe(c.expected.length);
      hits.forEach((h, i) => {
        const e = c.expected[i];
        expect(h.item.kind).toBe(e.kind);
        expect(h.item.id).toBe(e.id);
        expect(h.item.section).toBe(e.section);
        expect(h.score).toBe(e.score);
        expect(h.matchedKey).toBe(e.matchedKey);
        expect(h.score).toBeGreaterThanOrEqual(golden.scoreThreshold);
      });

      // 动作 id 与内部路由（选定后真能打开对应资料页）
      const pushed: string[] = [];
      const actions = hitsToActions(hits, { pushRoute: (to) => pushed.push(to) });
      expect(actions.length).toBe(c.expected.length);
      actions.forEach((a, i) => {
        const e = c.expected[i];
        expect(a.id).toBe(e.actionId);
        expect(a.section).toBe(e.section);
        expect(routeOf(a, pushed)).toBe(e.route);
      });
    });
  }

  it('空查询兜底：返回最近 5 条，不受 golden 阈值过滤', () => {
    const hits = queryMulti(index, '   ');
    expect(hits.length).toBe(5);
    expect(hits.every((h) => h.score === 0)).toBe(true);
    expect(hits[0].matchedKey).toBe('(recent:0)');
  });

  it('golden 覆盖五类可索引对象（Instrument/AlarmCode/Calibration/PluginCard/ManualEntry）', () => {
    const kinds = new Set(golden.cases.flatMap((c) => c.expected.map((e) => e.kind)));
    expect(kinds).toEqual(
      new Set(['Instrument', 'AlarmCode', 'Calibration', 'PluginCard', 'ManualEntry']),
    );
  });

  it('golden 同时锁住精确命中与容错命中两条路径', () => {
    const exact = golden.cases.find((c) => c.query === 'ADVIA 2400')!;
    const typo = golden.cases.find((c) => c.query === 'ADVIA2400')!;
    // 同样三类对象、同样顺序，只是分数从精确降到模糊
    expect(typo.expected.map((e) => e.id)).toEqual(exact.expected.map((e) => e.id));
    expect(exact.expected[0].score).toBeGreaterThan(typo.expected[0].score);
  });
});
