// tests/screenshot.test.ts
//
// 验证 screenshot 脚本产出：3 类占位 PNG + meta JSON + README。
// 真实 playwright 渲染留作后续扩展（screenshot-real.ts）。
//
// 触发：scripts/screenshot.ts 已写。脚本本身在 vitest 进程内 import 跑一次，
// 验证 docs/screenshots/ 下产物齐全。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpOutDir: string;
let originalConsole: typeof console;

beforeAll(async () => {
  tmpOutDir = mkdtempSync(join(tmpdir(), 'lab-field-ops-screenshot-'));
  // 跑 screenshot 脚本（vitest in-process 调用，绕过 ts-node ESM）
  const scriptPath = join(__dirname, '..', 'scripts', 'screenshot.ts');
  await import(scriptPath);
  // 抑制脚本输出
  originalConsole = console;
  console.log = () => {};
  console.error = () => {};
}, 30000);

afterAll(() => {
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  rmSync(tmpOutDir, { recursive: true, force: true });
});

describe('screenshot 脚本产出', () => {
  it('输出 3 张占位 PNG + meta JSON + README', () => {
    const projectRoot = join(__dirname, '..');
    const outDir = join(projectRoot, 'docs', 'screenshots');

    expect(existsSync(join(outDir, 'dashboard.png'))).toBe(true);
    expect(existsSync(join(outDir, 'kbar.png'))).toBe(true);
    expect(existsSync(join(outDir, 'splitview.png'))).toBe(true);
    expect(existsSync(join(outDir, 'dashboard.meta.json'))).toBe(true);
    expect(existsSync(join(outDir, 'kbar.meta.json'))).toBe(true);
    expect(existsSync(join(outDir, 'splitview.meta.json'))).toBe(true);
    expect(existsSync(join(outDir, 'README.md'))).toBe(true);

    // meta JSON 字段稳定
    const dashMeta = JSON.parse(readFileSync(join(outDir, 'dashboard.meta.json'), 'utf8'));
    expect(dashMeta.name).toBe('dashboard');
    expect(dashMeta.description).toContain('DashboardPage');
    expect(dashMeta.generated_with).toMatch(/placeholder|playwright/);

    // 占位 PNG 大小 > 0
    const buf = readFileSync(join(outDir, 'kbar.png'));
    expect(buf.length).toBeGreaterThan(0);
  });

  it('screenshot 脚本本身存在', () => {
    const script = join(__dirname, '..', 'scripts', 'screenshot.ts');
    expect(existsSync(script)).toBe(true);
    const content = readFileSync(script, 'utf8');
    expect(content).toContain('PLACEHOLDER_PNG');
    expect(content).toContain('dashboard.png');
    expect(content).toContain('kbar.png');
    expect(content).toContain('splitview.png');
  });
});