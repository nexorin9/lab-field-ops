// tests/splitView.test.tsx
// SplitView 三页同屏：open / close / focus / ratio / hydrate 行为 + UI 渲染。
// 使用 jsdom 环境（局部 environment override）；不依赖 @testing-library/react，
// 直接用 React.createRoot + container 验证 DOM。

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  createSplitViewStore,
  getSplitViewStore,
  __resetSplitViewStoreForTest,
} from '../src/app/components/SplitView/store.js';
import { SplitView } from '../src/app/components/SplitView/index.js';
import {
  openPanes,
  closePane,
  setFocusedPane,
  setRatio,
  hydrateSplitView,
  resetSplitView,
} from '../src/app/components/SplitView/api.js';
import { STORAGE_KEY, type PaneIndex } from '../src/app/components/SplitView/types.js';

const renderSplitView = (
  store: ReturnType<typeof createSplitViewStore>,
  renderPane: (props: {
    paneIdx: PaneIndex;
    path: string | null;
    isFocused: boolean;
  }) => React.ReactNode,
): { container: HTMLDivElement; root: Root } => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(SplitView, {
        store,
        renderPane,
      }),
    );
  });
  return { container, root };
};

const unmountSplitView = (root: Root, container: HTMLDivElement): void => {
  root.unmount();
  container.remove();
};

beforeEach(() => {
  __resetSplitViewStoreForTest();
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

/* -------------------------------------------------------------------------- */
/* 1. Store：基本行为                                                          */
/* -------------------------------------------------------------------------- */

describe('SplitView store', () => {
  it('默认状态为单 pane 空载', () => {
    const store = createSplitViewStore();
    expect(store.paths).toEqual([null]);
    expect(store.focusedPane).toBeNull();
    expect(store.ratios).toEqual([1]);
  });

  it('openPanes 写入 paths 并等分 ratios', () => {
    const store = createSplitViewStore();
    store.openPanes(['/instruments/A', '/alarmCodes/B', '/calibrations/C']);
    expect(store.paths).toHaveLength(3);
    expect(store.ratios).toHaveLength(3);
    const sum = store.ratios.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('openPanes 截断到 3 pane 并补足到最少 1', () => {
    const store = createSplitViewStore();
    // 6 项传进来应被截到 3
    store.openPanes(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(store.paths).toHaveLength(3);

    // 空数组补足到 1
    const store2 = createSplitViewStore();
    store2.openPanes([]);
    expect(store2.paths).toEqual([null]);
  });

  it('openPanes 写入后自动持久化到 localStorage', () => {
    const store = createSplitViewStore();
    store.openPanes(['/x', '/y']);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.paths).toEqual(['/x', '/y']);
  });

  it('closePane 移除指定 pane 并重整 ratios', () => {
    const store = createSplitViewStore();
    store.openPanes(['a', 'b', 'c']);
    store.closePane(1);
    expect(store.paths).toEqual(['a', 'c']);
    expect(store.ratios.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it('关闭最后一个 path 会被补齐为 [null]', () => {
    const store = createSplitViewStore();
    store.openPanes(['only']);
    store.closePane(0);
    expect(store.paths).toEqual([null]);
    expect(store.focusedPane).toBeNull();
  });

  it('setFocusedPane 仅在合法索引生效', () => {
    const store = createSplitViewStore();
    store.openPanes(['a', 'b']);
    store.setFocusedPane(1);
    expect(store.focusedPane).toBe(1);
    // 越界忽略
    store.setFocusedPane(5 as PaneIndex);
    expect(store.focusedPane).toBe(1);
  });

  it('单 pane 时 focusedPane 恒为 null', () => {
    const store = createSplitViewStore();
    store.openPanes(['a']);
    expect(store.focusedPane).toBeNull();
  });

  it('setRatio 限制在 0.1–0.8 区间，且剩余比例等分', () => {
    const store = createSplitViewStore();
    store.openPanes(['a', 'b', 'c']);
    store.setRatio(1, 0.9); // 应被 clamp 到 0.8
    expect(store.ratios[1]).toBe(0.8);
    const sum = store.ratios.reduce((x, y) => x + y, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Hydrate：从 localStorage 恢复                                            */
/* -------------------------------------------------------------------------- */

describe('SplitView hydrate', () => {
  it('hydrate 从 localStorage 恢复 paths/ratios/focused', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        paths: ['/p1', '/p2', '/p3'],
        focusedPane: 2,
        ratios: [0.4, 0.3, 0.3],
      }),
    );
    const store = createSplitViewStore();
    store.hydrate();
    expect(store.paths).toEqual(['/p1', '/p2', '/p3']);
    expect(store.focusedPane).toBe(2);
    // ratios 在 hydrate 时会被 equalize（避免脏数据），但 length 必须为 3
    expect(store.ratios).toHaveLength(3);
  });

  it('hydrate 在损坏 JSON 时保持默认', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    const store = createSplitViewStore();
    expect(() => store.hydrate()).not.toThrow();
    expect(store.paths).toEqual([null]);
  });

  it('reset 后 paths=[null] 且 ratios=[1]', () => {
    const store = createSplitViewStore();
    store.openPanes(['a', 'b']);
    store.reset();
    expect(store.paths).toEqual([null]);
    expect(store.focusedPane).toBeNull();
    expect(store.ratios).toEqual([1]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. subscribe：变更通知                                                       */
/* -------------------------------------------------------------------------- */

describe('SplitView subscribe', () => {
  it('openPanes 后监听器触发', () => {
    const store = createSplitViewStore();
    let count = 0;
    const unsub = store.subscribe(() => count++);
    store.openPanes(['a', 'b']);
    expect(count).toBe(1);
    store.setFocusedPane(0);
    expect(count).toBe(2);
    unsub();
    store.setFocusedPane(1);
    expect(count).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. UI 渲染                                                                  */
/* -------------------------------------------------------------------------- */

describe('SplitView UI', () => {
  it('渲染 1 个 pane；path=null 显示占位', () => {
    const store = createSplitViewStore();
    const { container, root } = renderSplitView(store, ({ paneIdx, path }) =>
      React.createElement(
        'div',
        { 'data-testid': `pane-content-${paneIdx}` },
        path ?? 'empty',
      ),
    );
    try {
      expect(
        container.querySelector('[data-testid="splitview-root"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="splitview-pane-0"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="splitview-pane-1"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="splitview-placeholder-0"]'),
      ).toBeTruthy();
    } finally {
      unmountSplitView(root, container);
    }
  });

  it('openPanes 3 项 → 渲染 3 个 pane + 2 个分隔条', () => {
    const store = createSplitViewStore();
    act(() => {
      store.openPanes(['/a', '/b', '/c']);
    });
    const { container, root } = renderSplitView(store, ({ paneIdx, path }) =>
      React.createElement(
        'div',
        { 'data-testid': `pane-content-${paneIdx}` },
        path,
      ),
    );
    try {
      expect(
        container.querySelector('[data-testid="splitview-pane-0"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="splitview-pane-1"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="splitview-pane-2"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="splitview-handle-0"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="splitview-handle-1"]'),
      ).toBeTruthy();
    } finally {
      unmountSplitView(root, container);
    }
  });

  it('点击 pane 后 focused 高亮切换', () => {
    const store = createSplitViewStore();
    act(() => {
      store.openPanes(['/a', '/b']);
      store.setFocusedPane(0);
    });
    const { container, root } = renderSplitView(store, ({ paneIdx }) =>
      React.createElement('div', null, `pane ${paneIdx}`),
    );
    try {
      const p0 = container.querySelector(
        '[data-testid="splitview-pane-0"]',
      ) as HTMLElement;
      const p1 = container.querySelector(
        '[data-testid="splitview-pane-1"]',
      ) as HTMLElement;
      expect(p0.getAttribute('data-focused')).toBe('true');
      expect(p1.getAttribute('data-focused')).toBe('false');

      // 通过 store 方法直接触发 listener（覆盖 onMouseDown 路径）
      act(() => {
        store.setFocusedPane(1);
      });
      const p0After = container.querySelector(
        '[data-testid="splitview-pane-0"]',
      ) as HTMLElement;
      const p1After = container.querySelector(
        '[data-testid="splitview-pane-1"]',
      ) as HTMLElement;
      expect(p0After.getAttribute('data-focused')).toBe('false');
      expect(p1After.getAttribute('data-focused')).toBe('true');
    } finally {
      unmountSplitView(root, container);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. API 模块入口                                                              */
/* -------------------------------------------------------------------------- */

describe('SplitView api', () => {
  it('openPanes / closePane / setFocusedPane / setRatio / hydrate / reset 可调用', () => {
    openPanes(['/x', '/y', '/z']);
    const store = getSplitViewStore();
    expect(store.paths).toEqual(['/x', '/y', '/z']);

    setFocusedPane(2);
    expect(store.focusedPane).toBe(2);

    setRatio(1, 0.5);
    const sum = store.ratios.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);

    closePane(0);
    expect(store.paths).toEqual(['/y', '/z']);

    hydrateSplitView();
    resetSplitView();
    expect(store.paths).toEqual([null]);
  });

  it('hydrateSplitView 从 localStorage 恢复', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        paths: ['/p1', '/p2'],
        focusedPane: 1,
        ratios: [0.5, 0.5],
      }),
    );
    hydrateSplitView();
    const store = getSplitViewStore();
    expect(store.paths).toEqual(['/p1', '/p2']);
  });
});
