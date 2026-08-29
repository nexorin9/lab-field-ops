// tests/embedGolden.test.ts
//
// 对照测试：每个 fixture 调用 matchEmbeds → 与 scripts/golden/expected/embed.json
// 字段命名/主键/优先级 一致。
//
// 与 tests/embeds.test.ts 的差异：
//   - embeds.test.ts 验证「描述子主路径」（regex / priority / 注册顺序）
//   - embedGolden.test.ts 验证「字段命名稳定」——适配器返回字段在 README/UI 中要稳定展示，
//     一旦破坏会直接冒出"看板显示 undefined"的故障，故用 golden 锁住
//
// 输入与输出形态：见 scripts/golden/expected/embed.json。

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installBuiltinDescriptors } from '../src/shared/embeds/registry.js';
import { matchEmbeds } from '../src/shared/embeds/index.js';

interface GoldenCase {
  category: string;
  input: string;
  expected: {
    descriptorName: string;
    kind: string;
    priority: number;
    componentName: string;
    key: string | null;
    captured: Record<string, string>;
  };
}

interface GoldenFile {
  version: number;
  cases: GoldenCase[];
}

// 在 describe 外同步读取 golden 文件（vitest describe body 会立即执行 for 循环）
const goldenPath = join(__dirname, '..', 'scripts', 'golden', 'expected', 'embed.json');
const goldenRaw = readFileSync(goldenPath, 'utf8');
const golden = JSON.parse(goldenRaw) as GoldenFile;

beforeAll(() => {
  // 确保 4 类内置描述子已注册（hot reload 场景下也用得到）
  installBuiltinDescriptors();
});

describe('embed golden 对照', () => {
  it('golden 文件存在且 version=1', () => {
    expect(golden).toBeDefined();
    expect(golden.version).toBe(1);
    expect(Array.isArray(golden.cases)).toBe(true);
    expect(golden.cases.length).toBeGreaterThanOrEqual(8);
  });

  it('4 类描述子各 2 个 fixture', () => {
    const categories = new Set(golden.cases.map((c) => c.category));
    expect(categories).toEqual(
      new Set(['vendor-ticket', 'lis-report', 'calibration-record', 'instrument-manual']),
    );
    for (const cat of categories) {
      const count = golden.cases.filter((c) => c.category === cat).length;
      expect(count, `category=${cat} 至少 2 个 fixture`).toBeGreaterThanOrEqual(2);
    }
  });

  for (const fx of golden.cases) {
    it(`[${fx.category}] ${fx.input} → 命中 ${fx.expected.descriptorName}`, () => {
      const hits = matchEmbeds(fx.input);
      expect(hits.length).toBeGreaterThan(0);
      const top = hits[0];
      expect(top.descriptor.name).toBe(fx.expected.descriptorName);
      expect(top.descriptor.kind).toBe(fx.expected.kind);
      expect(top.descriptor.priority).toBe(fx.expected.priority);
      expect(top.descriptor.componentName).toBe(fx.expected.componentName);
      expect(top.key).toBe(fx.expected.key);
      expect(top.url).toBe(fx.input);
      // 捕获组与 fixture 声明一致（业务主键可复用字段命名）
      const captured =
        top.descriptor.name === 'vendor-ticket'
          ? { ticketId: top.matches[1] }
          : top.descriptor.name === 'lis-report'
            ? { accessionNo: top.matches[1] }
            : top.descriptor.name === 'calibration-record'
              ? { calibrationId: top.matches[1] }
              : { path: top.matches[1] };
      expect(captured).toEqual(fx.expected.captured);
    });
  }

  it('priority 排序：lis-report > vendor-ticket > calibration-record > instrument-manual', () => {
    expect(golden.cases.find((c) => c.category === 'lis-report')!.expected.priority).toBe(40);
    expect(golden.cases.find((c) => c.category === 'vendor-ticket')!.expected.priority).toBe(30);
    expect(golden.cases.find((c) => c.category === 'calibration-record')!.expected.priority).toBe(20);
    expect(golden.cases.find((c) => c.category === 'instrument-manual')!.expected.priority).toBe(10);
  });
});