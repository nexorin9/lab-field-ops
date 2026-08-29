// tests/auditReplayUI.test.tsx
//
// AuditDrawer 钻取 UI 测试（Task 23 核心深度）：
//   - 默认渲染：列表 + 每行「查看相关事件」按钮
//   - 点击按钮：触发 replayFetcher → 渲染事件链面板（4 种 role）
//   - 再次点击：收起面板
//   - 错误态：replayFetcher reject → 红框 + 错误文本
//   - 空 chain：节点全部渲染但无 payload pre
//
// 使用 jsdom + react-dom 18 自渲染（与 splitView.test.tsx 一致风格；零额外依赖）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  AuditDrawer,
  type Fetcher,
  type ReplayFetcher,
  type AuditEventView,
  type ReplayResponse,
  type ReplayChainNode,
} from '../src/app/components/AuditDrawer/index.js';

const SAMPLE_EVENTS: AuditEventView[] = [
  {
    event_id: 'evt-1',
    kind: 'processing_record.created',
    req_hash: 'aaaaaaaaaaaa',
    resp_hash: 'bbbbbbbbbbbb',
    operator_id: 'op-1',
    payload_json: JSON.stringify({ record_id: 'rec-1', alarm_code: 'W002' }),
    ts: '2024-01-17T03:00:00.000Z',
    related_event_id: null,
  },
  {
    event_id: 'evt-2',
    kind: 'queue.enqueue',
    req_hash: null,
    resp_hash: null,
    operator_id: null,
    payload_json: JSON.stringify({ queue: 'lis-writeback', job_id: 'job-1' }),
    ts: '2024-01-17T03:00:01.000Z',
    related_event_id: 'evt-1',
  },
];

const SAMPLE_REPLAY: ReplayResponse = {
  root: 'evt-1',
  current: {
    event_id: 'evt-2',
    kind: 'queue.enqueue',
    operator_id: null,
    ts: '2024-01-17T03:00:01.000Z',
    related_event_id: 'evt-1',
    payload: { queue: 'lis-writeback', job_id: 'job-1' },
  },
  parents: [
    {
      event_id: 'evt-1',
      kind: 'processing_record.created',
      operator_id: 'op-1',
      ts: '2024-01-17T03:00:00.000Z',
      related_event_id: null,
      payload: { record_id: 'rec-1', alarm_code: 'W002' },
    } satisfies ReplayChainNode,
  ],
  children: [],
  chain: [
    {
      event_id: 'evt-1',
      kind: 'processing_record.created',
      operator_id: 'op-1',
      ts: '2024-01-17T03:00:00.000Z',
      related_event_id: null,
      payload: { record_id: 'rec-1', alarm_code: 'W002' },
    },
    {
      event_id: 'evt-2',
      kind: 'queue.enqueue',
      operator_id: null,
      ts: '2024-01-17T03:00:01.000Z',
      related_event_id: 'evt-1',
      payload: { queue: 'lis-writeback', job_id: 'job-1' },
    },
  ],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  // 设置 React act 环境（消除 act() 警告）
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (root) {
    root.unmount();
    root = null;
  }
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
});

/** 渲染 AuditDrawer 并返回 root 容器 + React root。 */
function mountAuditDrawer(opts: {
  fetcher?: Fetcher;
  replayFetcher?: ReplayFetcher;
  open?: boolean;
}): { container: HTMLDivElement; root: Root } {
  const c = document.createElement('div');
  document.body.appendChild(c);
  container = c;
  const r = createRoot(c);
  root = r;
  act(() => {
    r.render(
      <AuditDrawer
        open={opts.open ?? true}
        onClose={() => {}}
        fetcher={opts.fetcher}
        replayFetcher={opts.replayFetcher}
      />,
    );
  });
  return { container: c, root: r };
}

/** 等待 microtask 队列消费 + 重渲染完成。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((res) => {
      setTimeout(res, 0);
    });
  });
}

describe('AuditDrawer · replay 钻取 UI', () => {
  it('默认渲染：列表 + 每行「查看相关事件」按钮', async () => {
    const fetcher: Fetcher = vi.fn(async () => ({
      events: SAMPLE_EVENTS,
      total: 2,
      limit: 100,
    }));
    mountAuditDrawer({ fetcher });
    await flush();
    const rootEl = container!.querySelector(
      '[data-testid="audit-drawer-root"]',
    );
    expect(rootEl).toBeTruthy();
    const rows = container!.querySelectorAll(
      '[data-testid="audit-drawer-row"]',
    );
    expect(rows).toHaveLength(2);
    const toggleBtns = container!.querySelectorAll(
      '[data-testid="audit-drawer-replay-toggle"]',
    );
    expect(toggleBtns).toHaveLength(2);
    // 初始 replay 面板未渲染
    expect(
      container!.querySelector('[data-testid="audit-drawer-replay-panel"]'),
    ).toBeNull();
  });

  it('点击「查看相关事件」→ 触发 replayFetcher + 渲染事件链（4 种 role 标签）', async () => {
    const fetcher: Fetcher = vi.fn(async () => ({
      events: SAMPLE_EVENTS,
      total: 2,
      limit: 100,
    }));
    const replayFetcher: ReplayFetcher = vi.fn(async () => SAMPLE_REPLAY);
    mountAuditDrawer({ fetcher, replayFetcher });
    await flush();
    // 点击第二行的 replay 按钮（evt-2）
    const rows = Array.from(
      container!.querySelectorAll('[data-testid="audit-drawer-row"]'),
    ) as HTMLElement[];
    const evt2Row = rows.find((r) => r.dataset.eventId === 'evt-2')!;
    const btn = evt2Row.querySelector(
      '[data-testid="audit-drawer-replay-toggle"]',
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flush();
    expect(replayFetcher).toHaveBeenCalledWith('evt-2');
    // replay 面板已渲染
    const panel = container!.querySelector(
      '[data-testid="audit-drawer-replay-panel"]',
    ) as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.dataset.currentEventId).toBe('evt-2');
    expect(panel.dataset.replayPhase).toBe('ready');
    // chain 节点：2 个（root + current）；roles 是 root / current
    const nodes = Array.from(
      container!.querySelectorAll('[data-testid="audit-drawer-replay-node"]'),
    ) as HTMLElement[];
    expect(nodes).toHaveLength(2);
    const roles = nodes.map((n) => n.dataset.replayRole).sort();
    expect(roles).toEqual(['current', 'root']);
    // chain count 标签
    expect(
      container!.querySelector('[data-testid="audit-drawer-replay-chain-count"]')
        ?.textContent,
    ).toBe('2');
    expect(
      container!.querySelector('[data-testid="audit-drawer-replay-parent-count"]')
        ?.textContent,
    ).toBe('1');
    expect(
      container!.querySelector('[data-testid="audit-drawer-replay-child-count"]')
        ?.textContent,
    ).toBe('0');
    // 切换按钮文案变成「收起相关事件」
    expect((btn as HTMLButtonElement).textContent).toBe('收起相关事件');
  });

  it('再次点击「收起相关事件」→ 面板卸载', async () => {
    const fetcher: Fetcher = vi.fn(async () => ({
      events: SAMPLE_EVENTS,
      total: 2,
      limit: 100,
    }));
    const replayFetcher: ReplayFetcher = vi.fn(async () => SAMPLE_REPLAY);
    mountAuditDrawer({ fetcher, replayFetcher });
    await flush();
    const row = Array.from(
      container!.querySelectorAll('[data-testid="audit-drawer-row"]'),
    ).find((r) => (r as HTMLElement).dataset.eventId === 'evt-2') as HTMLElement;
    const btn = row.querySelector(
      '[data-testid="audit-drawer-replay-toggle"]',
    ) as HTMLButtonElement;
    // 打开
    await act(async () => {
      btn.click();
    });
    await flush();
    expect(
      container!.querySelector('[data-testid="audit-drawer-replay-panel"]'),
    ).toBeTruthy();
    // 关闭
    await act(async () => {
      btn.click();
    });
    await flush();
    expect(
      container!.querySelector('[data-testid="audit-drawer-replay-panel"]'),
    ).toBeNull();
    expect(btn.textContent).toBe('查看相关事件');
  });

  it('replayFetcher reject → 错误态：红框 + 错误文本', async () => {
    const fetcher: Fetcher = vi.fn(async () => ({
      events: SAMPLE_EVENTS,
      total: 2,
      limit: 100,
    }));
    const replayFetcher: ReplayFetcher = vi.fn(async () => {
      throw new Error('replay 502');
    });
    mountAuditDrawer({ fetcher, replayFetcher });
    await flush();
    const row = Array.from(
      container!.querySelectorAll('[data-testid="audit-drawer-row"]'),
    ).find((r) => (r as HTMLElement).dataset.eventId === 'evt-1') as HTMLElement;
    const btn = row.querySelector(
      '[data-testid="audit-drawer-replay-toggle"]',
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flush();
    const panel = container!.querySelector(
      '[data-testid="audit-drawer-replay-panel"]',
    ) as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.dataset.replayPhase).toBe('error');
    const errBox = container!.querySelector(
      '[data-testid="audit-drawer-replay-error"]',
    );
    expect(errBox).toBeTruthy();
    expect((errBox as HTMLElement).textContent).toMatch(/replay 502/);
    expect((errBox as HTMLElement).getAttribute('role')).toBe('alert');
  });

  it('点击行 head 仍可展开 payload（与 replay 互不干扰）', async () => {
    const fetcher: Fetcher = vi.fn(async () => ({
      events: SAMPLE_EVENTS,
      total: 2,
      limit: 100,
    }));
    const replayFetcher: ReplayFetcher = vi.fn(async () => SAMPLE_REPLAY);
    mountAuditDrawer({ fetcher, replayFetcher });
    await flush();
    // 点击第一行 head（展开 payload）
    const row = Array.from(
      container!.querySelectorAll('[data-testid="audit-drawer-row"]'),
    ).find((r) => (r as HTMLElement).dataset.eventId === 'evt-1') as HTMLElement;
    const head = row.querySelector(
      '[data-testid="audit-drawer-row-head"]',
    ) as HTMLElement;
    await act(async () => {
      head.click();
    });
    await flush();
    expect(row.dataset.expanded).toBe('true');
    expect(
      container!.querySelector('[data-testid="audit-drawer-row-payload"]'),
    ).toBeTruthy();
    // 同时打开 replay（不影响 payload）
    const btn = row.querySelector(
      '[data-testid="audit-drawer-replay-toggle"]',
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flush();
    expect(row.dataset.replayOpen).toBe('true');
    expect(
      container!.querySelector('[data-testid="audit-drawer-replay-panel"]'),
    ).toBeTruthy();
    expect(
      container!.querySelector('[data-testid="audit-drawer-row-payload"]'),
    ).toBeTruthy();
  });
});
