// src/app/components/SplitView/api.ts
// SplitView 的程序化入口：open / close / focus / setRatio / hydrate / reset。
// 设计目标：⌘K 命中三类对象时调用 open([a,b,c])，前端可一键重置。

import { getSplitViewStore } from './store';
import type { PaneIndex, SplitPath } from './types';

export const openPanes = (paths: SplitPath): void => {
  getSplitViewStore().openPanes(paths);
};

export const closePane = (paneIdx: PaneIndex): void => {
  getSplitViewStore().closePane(paneIdx);
};

export const setFocusedPane = (paneIdx: PaneIndex): void => {
  getSplitViewStore().setFocusedPane(paneIdx);
};

export const setRatio = (paneIdx: PaneIndex, percent: number): void => {
  getSplitViewStore().setRatio(paneIdx, percent);
};

export const hydrateSplitView = (): void => {
  getSplitViewStore().hydrate();
};

export const resetSplitView = (): void => {
  getSplitViewStore().reset();
};
