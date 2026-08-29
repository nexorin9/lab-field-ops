// src/app/components/SplitView/store.ts
// 三页同屏 SplitView 的轻量 observable store。
// 不引入 zustand/mobx，纯 TS + pub/sub；持久化到 localStorage。
//
// 关键约定：
//  - paths 长度 1–3，元素为 path 字符串或 null；null 表示该 pane 占位空载
//  - focusedPane 在关闭/单 pane 时置 null
//  - ratios 与 paths 等长，默认等分（单 pane 恒为 [1]）
//  - 所有 setter 必须调用 persist()，hydrate() 仅启动期一次

import {
  DEFAULT_RATIO,
  MAX_PANES,
  MIN_PANES,
  STORAGE_KEY,
  type PaneIndex,
  type SplitPath,
  type SplitRatios,
  type SplitViewState,
  type SplitViewStore,
} from './types';

const isBrowser = (): boolean =>
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { localStorage?: Storage }).localStorage !== 'undefined';

const safeReadStorage = (): Partial<SplitViewState> | null => {
  if (!isBrowser()) return null;
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage!.getItem(
      STORAGE_KEY,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SplitViewState>;
    return parsed;
  } catch {
    return null;
  }
};

const safeWriteStorage = (state: SplitViewState): void => {
  if (!isBrowser()) return;
  try {
    (globalThis as { localStorage?: Storage }).localStorage!.setItem(
      STORAGE_KEY,
      JSON.stringify(state),
    );
  } catch {
    // ignore quota / private mode
  }
};

const equalizeRatios = (n: number, current?: SplitRatios): SplitRatios => {
  if (n <= 0) return [];
  const out: number[] = new Array(n).fill(1 / n);
  // 保留第一项剩余精度以确保和为 1
  const sum = out.reduce((a, b) => a + b, 0);
  out[0] += 1 - sum;
  if (current && current.length === n) {
    // 比例变化只在用户拖拽后保留，否则回到等分
    return out;
  }
  return out;
};

const normalizePaths = (paths: SplitPath): SplitPath => {
  const trimmed = paths.slice(0, MAX_PANES);
  while (trimmed.length < MIN_PANES) trimmed.push(null);
  return trimmed.map((p) => (typeof p === 'string' && p.length === 0 ? null : p));
};

const computeFocusedPane = (
  current: SplitViewState,
  paths: SplitPath,
  hint?: PaneIndex | null,
): PaneIndex | null => {
  if (paths.length <= 1) return null;
  if (hint !== undefined) {
    if (hint >= 0 && hint < paths.length) return hint;
  }
  // 默认聚焦第一个 pane
  return current.focusedPane !== null &&
    current.focusedPane < paths.length
    ? current.focusedPane
    : 0;
};

export const createSplitViewStore = (): SplitViewStore => {
  let state: SplitViewState = {
    paths: [null],
    focusedPane: null,
    ratios: [1],
  };
  const listeners = new Set<() => void>();

  const setState = (next: SplitViewState): void => {
    state = next;
    listeners.forEach((l) => l());
  };

  const persist = (): void => {
    safeWriteStorage(state);
  };

  const store: SplitViewStore = {
    get paths() {
      return state.paths;
    },
    get focusedPane() {
      return state.focusedPane;
    },
    get ratios() {
      return state.ratios;
    },
    openPanes(paths) {
      const norm = normalizePaths(paths);
      const ratios = equalizeRatios(norm.length, state.ratios);
      const focused = computeFocusedPane(state, norm, 0);
      setState({ paths: norm, focusedPane: focused, ratios });
      persist();
    },
    closePane(paneIdx) {
      if (paneIdx < 0 || paneIdx >= state.paths.length) return;
      const nextPaths = state.paths.filter((_, i) => i !== paneIdx);
      if (nextPaths.length === 0) nextPaths.push(null);
      const nextRatios = equalizeRatios(nextPaths.length);
      const nextFocused =
        state.focusedPane === null || state.focusedPane >= nextPaths.length
          ? nextPaths.length > 1
            ? 0
            : null
          : state.focusedPane;
      setState({ paths: nextPaths, focusedPane: nextFocused, ratios: nextRatios });
      persist();
    },
    setFocusedPane(paneIdx) {
      if (paneIdx < 0 || paneIdx >= state.paths.length) return;
      setState({ ...state, focusedPane: paneIdx });
      persist();
    },
    setRatio(paneIdx, percent) {
      if (paneIdx < 0 || paneIdx >= state.ratios.length) return;
      if (!Number.isFinite(percent)) return;
      const clamped = Math.max(0.1, Math.min(0.8, percent));
      const ratios = state.ratios.slice();
      ratios[paneIdx] = clamped;
      // 剩余比例在剩余 panes 间等分
      const others = ratios.length - 1;
      if (others > 0) {
        const rest = (1 - clamped) / others;
        for (let i = 0; i < ratios.length; i++) {
          if (i !== paneIdx) ratios[i] = rest;
        }
      } else {
        ratios[0] = 1;
      }
      setState({ ...state, ratios });
      persist();
    },
    hydrate() {
      const fromDisk = safeReadStorage();
      if (!fromDisk || !Array.isArray(fromDisk.paths)) return;
      const norm = normalizePaths(fromDisk.paths as SplitPath);
      const ratios = Array.isArray(fromDisk.ratios)
        ? equalizeRatios(norm.length, fromDisk.ratios as SplitRatios)
        : equalizeRatios(norm.length);
      const focused =
        typeof fromDisk.focusedPane === 'number' && fromDisk.focusedPane < norm.length
          ? (fromDisk.focusedPane as PaneIndex)
          : norm.length > 1
            ? 0
            : null;
      setState({ paths: norm, focusedPane: focused, ratios });
    },
    reset() {
      setState({ paths: [null], focusedPane: null, ratios: [1] });
      persist();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return store;
};

/* -------------------------------------------------------------------------- */
/* 模块单例（前后端均可用：SSR 场景下保持内存态）                                */
/* -------------------------------------------------------------------------- */

let singleton: SplitViewStore | null = null;

export const getSplitViewStore = (): SplitViewStore => {
  if (!singleton) singleton = createSplitViewStore();
  return singleton;
};

export const __resetSplitViewStoreForTest = (): void => {
  singleton = null;
};
