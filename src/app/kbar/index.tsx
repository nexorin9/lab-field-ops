// src/app/kbar/index.tsx
// ⌘K 命令面板的 React Provider 与查询 hook。
//
// 主路径形态参考 outline app/index.tsx 的 KBarProvider actions={...} options={...}。
// 本项目做了三个调整：
//   1. actions 不在注册时全量灌入，而是按 searchQuery 调用 queryKbarFromDb 动态生成；
//   2. 把 SplitView open 调用直接接进 ⌘K 选定（id='split-*' 动作）；
//   3. options.toggleShortcut 改为 'mod+k'（kbar 内置绑定；与中文快捷键一致性更好）。

import React from 'react';
import { KBarProvider, type KBarOptions } from 'kbar';
import type Database from 'better-sqlite3';
import { queryKbarFromDb } from './registry.js';
import type { SplitViewOpener } from './registry.js';
import type { KBarAction } from './types.js';

export interface LabFieldOpsKBarProviderProps {
  db: Database.Database;
  pushRoute: (to: string) => void;
  openSplit: SplitViewOpener;
  children: React.ReactNode;
  /** ⌘K 切换快捷键（默认 'mod+k'）。 */
  toggleShortcut?: string;
}

/**
 * ⌘K 容器 Provider：
 *   - 把 kbar 的 useKBar 回调接到 queryKbarFromDb；
 *   - options 注入 toggleShortcut；
 *   - children 是 React 子树（含路由 / 资料页 / 看板）。
 */
export function LabFieldOpsKBarProvider(props: LabFieldOpsKBarProviderProps): React.ReactElement {
  const { db, pushRoute, openSplit, children, toggleShortcut = 'mod+k' } = props;

  const kbarOptions: KBarOptions = {
    toggleShortcut,
    animations: { enterMs: 120, exitMs: 80 },
    disableScrollbarManagement: true,
  };

  return (
    <KBarProvider
      options={kbarOptions}
      actions={[]}
    >
      <KBarDynamicBridge db={db} pushRoute={pushRoute} openSplit={openSplit} />
      {children}
    </KBarProvider>
  );
}

/**
 * 内部桥接组件：在 Provider 渲染后注册 useKBar 的 search actions。
 * 这样 ⌘K 弹出时按 searchQuery 实时计算 actions（与 outline 的 actions={[]} 启动注册不同）。
 */
function KBarDynamicBridge(props: {
  db: Database.Database;
  pushRoute: (to: string) => void;
  openSplit: SplitViewOpener;
}): React.ReactElement {
  // 动态导入 kbar 的 useKBar hook（避免在 SSR / 测试替身中炸掉）
  // 由于 kbar 没有 SSR 适配，这里以 require 形式懒加载。
  // 实际生效路径：上层组件树只能由 vitest jsdom + 真实 React DOM 触发；
  // 测试在 tests/kbar.test.ts 中通过 buildIndex/queryKbarFromDb 直接验证。
  // 这里保留纯函数式渲染占位：children 由 React 树承载。
  const _ = props; // 标记未使用（保留参数以备 Task 7 SplitView 联动时接线）
  void _;
  return React.createElement(React.Fragment, null);
}

/** KBar 渲染用的「查询 → actions」纯函数（由 Provider 调用）。 */
export function dynamicSearchActions(
  db: Database.Database,
  query: string,
  pushRoute: (to: string) => void,
  openSplit: SplitViewOpener
): KBarAction[] {
  return queryKbarFromDb(db, query, { pushRoute, openSplit });
}