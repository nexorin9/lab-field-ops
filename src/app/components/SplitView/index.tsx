// src/app/components/SplitView/index.tsx
// 三页同屏 SplitView 组件：
//  - 1–3 pane 横向布局
//  - focused pane 高亮（蓝色边框）
//  - 拖拽分隔条调比例；持久化到 localStorage
//  - pane 内容由 resolver 根据 path 字符串解析；null 显示占位
//
// 与原 outline SplitView 不同点：
//  - 支持 1–3 pane（不仅主+副）；多 pane 通过 paths 数组长度判断
//  - 不依赖 mobx/styled-components；纯 React + CSS Module 风格的内联 style
//  - 接收 children 由 props.paneRenderer 提供，便于单页内嵌测试

import * as React from 'react';
import { getSplitViewStore } from './store';
import type { PaneIndex, SplitPath } from './types';

export type PaneRenderer = (props: {
  paneIdx: PaneIndex;
  path: string | null;
  isFocused: boolean;
}) => React.ReactNode;

export type SplitViewProps = {
  /** 根据 path 字符串渲染对应内容；path=null 渲染占位 */
  renderPane: PaneRenderer;
  /** 测试/SSR 注入 store */
  store?: ReturnType<typeof getSplitViewStore>;
  /** 启动期是否自动 hydrate */
  autoHydrate?: boolean;
};

const PlaceholderPane = ({ paneIdx }: { paneIdx: PaneIndex }) => (
  <div
    data-testid={`splitview-placeholder-${paneIdx}`}
    style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#888',
      fontSize: 14,
      padding: 16,
      background: '#fafafa',
      border: '1px dashed #ccc',
    }}
  >
    空 pane · ⌘K 打开资料
  </div>
);

const PaneContainer = ({
  paneIdx,
  ratio,
  isFocused,
  children,
  onFocusPane,
  onStartResize,
}: {
  paneIdx: PaneIndex;
  ratio: number;
  isFocused: boolean;
  children: React.ReactNode;
  onFocusPane: (idx: PaneIndex) => void;
  onStartResize?: (idx: PaneIndex, e: React.MouseEvent) => void;
}) => {
  const showHandle = paneIdx < 2; // 仅在两个 pane 之间放分隔
  return (
    <div
      role="group"
      aria-label={`pane-${paneIdx}`}
      data-testid={`splitview-pane-${paneIdx}`}
      data-focused={isFocused ? 'true' : 'false'}
      onMouseDown={() => onFocusPane(paneIdx)}
      style={{
        position: 'relative',
        display: 'flex',
        flex: `0 0 ${ratio * 100}%`,
        minWidth: 0,
        height: '100%',
        outline: isFocused ? '2px solid #1976d2' : '2px solid transparent',
        outlineOffset: '-2px',
        transition: 'outline-color 80ms ease-in-out',
      }}
    >
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>{children}</div>
      {showHandle && (
        <div
          data-testid={`splitview-handle-${paneIdx}`}
          onMouseDown={(e) => onStartResize?.(paneIdx, e)}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 6,
            cursor: 'col-resize',
            background: isFocused ? '#1976d2' : '#e0e0e0',
            zIndex: 10,
          }}
        />
      )}
    </div>
  );
};

export const SplitView: React.FC<SplitViewProps> = ({
  renderPane,
  store: storeProp,
  autoHydrate = true,
}) => {
  const store = storeProp ?? getSplitViewStore();
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

  React.useEffect(() => {
    if (autoHydrate) store.hydrate();
  }, [autoHydrate, store]);

  React.useEffect(() => store.subscribe(() => forceUpdate()), [store]);

  const paths: SplitPath = store.paths;
  const focused = store.focusedPane;
  const ratios = store.ratios;

  // 拖拽调比例：捕获 mousedown，记录起点；在 window 上绑 mousemove/mouseup
  const onStartResize = React.useCallback(
    (paneIdx: PaneIndex, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const container = (e.currentTarget as HTMLElement).parentElement?.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const startX = e.clientX;
      const startRatio = ratios[paneIdx] ?? 0.5;

      const onMove = (ev: MouseEvent) => {
        const offset = ev.clientX - rect.left;
        const percent = offset / rect.width;
        const next = startRatio + (percent - (rect.width * startRatio) / rect.width);
        // 计算拖拽 delta 比例：
        const delta = (ev.clientX - startX) / rect.width;
        store.setRatio(paneIdx, startRatio + delta);
        void next;
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [ratios, store],
  );

  const onFocusPane = React.useCallback(
    (paneIdx: PaneIndex) => {
      store.setFocusedPane(paneIdx);
    },
    [store],
  );

  if (paths.length === 0) {
    return <PlaceholderPane paneIdx={0} />;
  }

  return (
    <div
      data-testid="splitview-root"
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        minHeight: 0,
      }}
    >
      {paths.map((path, idx) => {
        const ratio = ratios[idx] ?? 1 / paths.length;
        const isFocused = focused === idx;
        return (
          <PaneContainer
            key={idx}
            paneIdx={idx as PaneIndex}
            ratio={ratio}
            isFocused={isFocused}
            onFocusPane={onFocusPane}
            onStartResize={onStartResize}
          >
            {path === null ? (
              <PlaceholderPane paneIdx={idx as PaneIndex} />
            ) : (
              renderPane({ paneIdx: idx as PaneIndex, path, isFocused })
            )}
          </PaneContainer>
        );
      })}
    </div>
  );
};

export default SplitView;
