// scripts/golden/embed-samples.ts
//
// 生成 embed 描述子 golden fixture：4 类描述子各 2 个命中样例 →
// scripts/golden/expected/embed.json 锁文件，供 tests/embedGolden.test.ts 对照。
//
// 与 tests/embeds.test.ts 的差异：embeds.test.ts 验证「描述子主路径」（regex / priority / 注册），
// embedGolden.test.ts 验证「字段命名稳定」（适配器返回字段在 README/UI 中要稳定展示）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchEmbeds } from '../../src/shared/embeds/index.js';
import { installBuiltinDescriptors } from '../../src/shared/embeds/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'expected');

export interface EmbedGoldenCase {
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

export interface EmbedGoldenFile {
  /** Golden 版本号；字段命名变更时 bump。 */
  version: 1;
  /** 4 类描述子各 2 个 fixture（共 8 条），与 spec.md 参考地基第 1 行对照。 */
  cases: EmbedGoldenCase[];
}

const fixtures: EmbedGoldenCase[] = [
  // vendor-ticket：两个样例（不同 hostname / 不同工单号）
  {
    category: 'vendor-ticket',
    input: 'https://vendor.example.com/ticket/T-ABC123',
    expected: {
      descriptorName: 'vendor-ticket',
      kind: 'vendor-ticket',
      priority: 30,
      componentName: 'VendorTicketCard',
      key: 'T-ABC123',
      captured: { ticketId: 'T-ABC123' },
    },
  },
  {
    category: 'vendor-ticket',
    input: 'https://svc.vendor.com/ticket/T-XY99/',
    expected: {
      descriptorName: 'vendor-ticket',
      kind: 'vendor-ticket',
      priority: 30,
      componentName: 'VendorTicketCard',
      key: 'T-XY99',
      captured: { ticketId: 'T-XY99' },
    },
  },

  // lis-report：两个样例（标准 accession_no）
  {
    category: 'lis-report',
    input: 'lis://reports/L20240117001',
    expected: {
      descriptorName: 'lis-report',
      kind: 'lis-report',
      priority: 40,
      componentName: 'LisReportCard',
      key: 'L20240117001',
      captured: { accessionNo: 'L20240117001' },
    },
  },
  {
    category: 'lis-report',
    input: 'lis://reports/L99999999/',
    expected: {
      descriptorName: 'lis-report',
      kind: 'lis-report',
      priority: 40,
      componentName: 'LisReportCard',
      key: 'L99999999',
      captured: { accessionNo: 'L99999999' },
    },
  },

  // calibration-record：两个样例
  {
    category: 'calibration-record',
    input: 'cal://calibrations/C20240117001.json',
    expected: {
      descriptorName: 'calibration-record',
      kind: 'calibration-record',
      priority: 20,
      componentName: 'CalibrationCard',
      key: 'C20240117001',
      captured: { calibrationId: 'C20240117001' },
    },
  },
  {
    category: 'calibration-record',
    input: 'cal://calibrations/C20240199.json',
    expected: {
      descriptorName: 'calibration-record',
      kind: 'calibration-record',
      priority: 20,
      componentName: 'CalibrationCard',
      key: 'C20240199',
      captured: { calibrationId: 'C20240199' },
    },
  },

  // instrument-manual：两个样例（不同路径）
  {
    category: 'instrument-manual',
    input: 'https://docs.vendor.com/advia-2400-manual.pdf',
    expected: {
      descriptorName: 'instrument-manual',
      kind: 'instrument-manual',
      priority: 10,
      componentName: 'ManualCard',
      key: 'advia-2400-manual',
      captured: { path: 'advia-2400-manual' },
    },
  },
  {
    category: 'instrument-manual',
    input: 'https://docs.vendor.com/cobas-8000-service.pdf',
    expected: {
      descriptorName: 'instrument-manual',
      kind: 'instrument-manual',
      priority: 10,
      componentName: 'ManualCard',
      key: 'cobas-8000-service',
      captured: { path: 'cobas-8000-service' },
    },
  },
];

/**
 * 组装 golden：实跑一遍 matchEmbeds 验证 fixture 真能命中，
 * 避免 fixture 与描述子漂移。
 */
export function buildEmbedGolden(): EmbedGoldenFile {
  // 确保内置 4 类描述子已注册（hot reload 场景下也用得到）
  installBuiltinDescriptors();

  for (const fx of fixtures) {
    const hits = matchEmbeds(fx.input);
    if (!hits.length) {
      throw new Error(`golden fixture 未命中: ${fx.category} / ${fx.input}`);
    }
    const top = hits[0];
    if (top.descriptor.name !== fx.expected.descriptorName) {
      throw new Error(
        `golden fixture 描述子失配: ${fx.input} → 命中 ${top.descriptor.name}, 期望 ${fx.expected.descriptorName}`,
      );
    }
    if (top.key !== fx.expected.key) {
      throw new Error(
        `golden fixture key 失配: ${fx.input} → ${top.key}, 期望 ${fx.expected.key}`,
      );
    }
  }

  return { version: 1, cases: fixtures };
}

/** 写回锁文件；仅由 `pnpm golden` 显式触发，普通 `pnpm test` 不写盘。 */
export function writeEmbedGolden(targetDir: string = outDir): string {
  const golden = buildEmbedGolden();
  mkdirSync(targetDir, { recursive: true });
  const outPath = join(targetDir, 'embed.json');
  writeFileSync(outPath, JSON.stringify(golden, null, 2) + '\n', 'utf8');
  return outPath;
}

if (process.env.GOLDEN_WRITE === '1') {
  const p = writeEmbedGolden();
  console.log(`embed golden 已生成: ${p}`);
}
