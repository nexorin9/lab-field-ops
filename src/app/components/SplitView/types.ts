// src/app/components/SplitView/types.ts
// 三页同屏 SplitView 的类型定义：
//  - SplitPath 描述单 pane 的内容标识（path 或 null）
//  - SplitViewState 是 store 中的整体快照（paths + focused + ratios）
//  - PaneIndex 是 0-based pane 索引（最大 2）

export type PaneIndex = 0 | 1 | 2;

export type SplitPath = (string | null)[];

/**
 * 每个 pane 占用的水平比例（0–1 之和为 1）。
 * 数组长度与 paths 长度一致；默认等分。
 */
export type SplitRatios = number[];

export interface SplitViewState {
  paths: SplitPath;
  focusedPane: PaneIndex | null;
  ratios: SplitRatios;
}

export interface SplitViewStore extends SplitViewState {
  openPanes: (paths: SplitPath) => void;
  closePane: (paneIdx: PaneIndex) => void;
  setFocusedPane: (paneIdx: PaneIndex) => void;
  setRatio: (paneIdx: PaneIndex, percent: number) => void;
  hydrate: () => void;
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
}

export const MAX_PANES = 3;
export const MIN_PANES = 1;
export const DEFAULT_RATIO = 0.5;
export const STORAGE_KEY = 'lab-field-ops:splitview:v1';
