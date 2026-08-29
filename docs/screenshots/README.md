# Screenshots

本目录是 README 「输出样例」小节引用的截图源。

## 文件

| 文件 | 内容 | 来源 |
|------|------|------|
| dashboard.png | DashboardPage 看板（仪器状态 / 队列重试 / write-back 红条 / 日报） | 占位 PNG |
| kbar.png | ⌘K KBar 命中三类对象 | 占位 PNG |
| splitview.png | SplitView 三页同屏 | 占位 PNG |

## 如何跑出真实截图

1. `pnpm add -D playwright`
2. `pnpm exec playwright install chromium`
3. 在 dev server 启动状态下（`pnpm dev`），运行：
   ```bash
   node scripts/screenshot-real.ts
   ```

## 当前状态

当前环境未安装 playwright；scripts/screenshot.ts 输出占位 PNG + 元数据 JSON，
便于 README 引用与 CI 校验「截图文件存在」。真实截图脚本（screenshot-real.ts）留作后续扩展。
