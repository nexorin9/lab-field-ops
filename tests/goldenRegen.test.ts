// tests/goldenRegen.test.ts
//
// golden 锁文件的**重生成**入口（`pnpm golden`）。
//
// 为什么放在 tests/ 而不是独立脚本：项目按 ESM + `.js` 后缀写 import，
// ts-node 无法把 `./x.js` 解析回 `./x.ts`，vitest（走 vite 解析）可以。
// 因此 `pnpm golden` = `GOLDEN_WRITE=1 vitest run tests/goldenRegen.test.ts`。
//
// 普通 `pnpm test`（无 GOLDEN_WRITE）时本文件**不写盘**，只校验
// 手写期望与当前实现一致——写盘留给显式的重生成命令，避免
// 「跑一次测试把 golden 覆盖成当前行为」而让对照测试形同虚设。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEmbedGolden, writeEmbedGolden } from '../scripts/golden/embed-samples.js';
import { buildKbarGolden, writeKbarGolden } from '../scripts/golden/kbar-samples.js';

const WRITE = process.env.GOLDEN_WRITE === '1';
const EXPECTED_DIR = join(__dirname, '..', 'scripts', 'golden', 'expected');

describe('golden 锁文件', () => {
  it('embed / kbar 手写期望与当前实现一致（build 内含自校验）', () => {
    const embed = buildEmbedGolden();
    const kbar = buildKbarGolden();
    expect(embed.cases.length).toBeGreaterThanOrEqual(8);
    expect(kbar.cases.length).toBeGreaterThanOrEqual(8);
  });

  it('落盘的锁文件与 build 结果一致（漂移即失败）', () => {
    const embedOnDisk = JSON.parse(readFileSync(join(EXPECTED_DIR, 'embed.json'), 'utf8'));
    const kbarOnDisk = JSON.parse(readFileSync(join(EXPECTED_DIR, 'kbar.json'), 'utf8'));
    expect(embedOnDisk).toEqual(JSON.parse(JSON.stringify(buildEmbedGolden())));
    expect(kbarOnDisk).toEqual(JSON.parse(JSON.stringify(buildKbarGolden())));
  });

  it.skipIf(!WRITE)('GOLDEN_WRITE=1 时写回 expected/*.json', () => {
    const a = writeEmbedGolden();
    const b = writeKbarGolden();
    expect(a.endsWith('embed.json')).toBe(true);
    expect(b.endsWith('kbar.json')).toBe(true);
  });
});
