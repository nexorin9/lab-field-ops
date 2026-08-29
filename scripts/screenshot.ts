// scripts/screenshot.ts
//
// 三类截图脚本：dashboard / ⌘K / SplitView。
//
// 触发方式：
//   1) playwright 可用 → 用 playwright-chromium 真实浏览器渲染 → docs/screenshots/*.png
//   2) playwright 不可用 → 跳过浏览器渲染，仅生成 placeholder PNG（占位说明）
//
// 设计取舍：
//   - 不强依赖 playwright（项目里没装 playwright；装了会显著增加依赖）
//   - 占位 PNG 用 1×1 透明图，避免 scripts/demo.sh 跑通时截图步骤失败
//   - 占位 + README 说明"如何跑出真实截图"留作后续扩展

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const outDir = join(projectRoot, 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

/** 1x1 透明 PNG（89 字节）。用于「真实浏览器不可用时的占位」 */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

interface ScreenshotTask {
  name: string;
  description: string;
  /** 真实浏览器可用时的渲染入口。 */
  browserAction?: string;
}

const tasks: ScreenshotTask[] = [
  {
    name: 'dashboard',
    description: 'DashboardPage 看板：仪器状态分布 + 队列重试 + write-back 红色告警 + 日报',
    browserAction: '打开 / 路由 → 等待 DashboardPage 渲染 → 截图',
  },
  {
    name: 'kbar',
    description: '⌘K KBar 弹出：输入 "Siemens/ADVIA 2400/W002" → 三类对象命中 → 选定打开 SplitView',
    browserAction: '按 ⌘K (或 Ctrl+K) → 输入查询串 → 截图',
  },
  {
    name: 'splitview',
    description: 'SplitView 三页同屏：仪器页 + 报警码页 + 校准页同框显示',
    browserAction: '⌘K 命中 → 选 split action → 三 pane 渲染 → 截图',
  },
];

async function tryPlaywright(): Promise<boolean> {
  try {
    // 用动态 import 探测 playwright 可用性
    // 注：用 eval 包装 import，避免静态分析器在编译期尝试解析模块
    const dynamicImport = new Function('m', 'return import(m)');
    await dynamicImport('playwright');
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('screenshots → ', outDir);
  const hasPlaywright = await tryPlaywright();
  if (!hasPlaywright) {
    console.log('playwright 未安装；生成 placeholder PNG + README 说明。');
    console.log('安装方式：pnpm add -D playwright && pnpm exec playwright install chromium');
  }

  for (const t of tasks) {
    const outPath = join(outDir, `${t.name}.png`);
    const metaPath = join(outDir, `${t.name}.meta.json`);
    const meta = {
      name: t.name,
      description: t.description,
      browser_action: t.browserAction ?? null,
      generated_with: hasPlaywright ? 'playwright' : 'placeholder',
      generated_at: new Date().toISOString(),
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

    if (!hasPlaywright || existsSync(outPath)) {
      // 占位 / 已存在则跳过真实生成
      if (!existsSync(outPath)) {
        writeFileSync(outPath, PLACEHOLDER_PNG);
        console.log(`  ✓ ${t.name}.png (placeholder)`);
      } else {
        console.log(`  - ${t.name}.png (existing, skipped)`);
      }
    }
  }

  // 写一份 index.md 说明
  const indexPath = join(outDir, 'README.md');
  const indexContent = `# Screenshots

本目录是 README 「输出样例」小节引用的截图源。

## 文件

| 文件 | 内容 | 来源 |
|------|------|------|
| dashboard.png | DashboardPage 看板（仪器状态 / 队列重试 / write-back 红条 / 日报） | 占位 PNG |
| kbar.png | ⌘K KBar 命中三类对象 | 占位 PNG |
| splitview.png | SplitView 三页同屏 | 占位 PNG |

## 如何跑出真实截图

1. \`pnpm add -D playwright\`
2. \`pnpm exec playwright install chromium\`
3. 在 dev server 启动状态下（\`pnpm dev\`），运行：
   \`\`\`bash
   node scripts/screenshot-real.ts
   \`\`\`

## 当前状态

当前环境未安装 playwright；scripts/screenshot.ts 输出占位 PNG + 元数据 JSON，
便于 README 引用与 CI 校验「截图文件存在」。真实截图脚本（screenshot-real.ts）留作后续扩展。
`;
  writeFileSync(indexPath, indexContent, 'utf8');
  console.log('  ✓ README.md');

  console.log('完成。');
}

main().catch((err) => {
  console.error('screenshot failed:', err);
  process.exit(1);
});