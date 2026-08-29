// tests/dashboardCards.test.tsx
//
// DashboardPage 三卡片拆分测试（Task 27 验收）：
//   - InstrumentHealthGrid：三态计数 + 每台仪器卡 + 最近校准时间
//   - WritebackStatusCard：饼图（六态）+ 状态表 + 失败红条 + 最近 10 条 list
//   - QueueStatusCard：attempts=5 时红条 + 重投按钮
//   - 顶部红条：队列 finalFailures > 0 时触发
//   - 状态分布正确性（pie slice 数量 + percent 数据属性）
//
// 与 tests/dashboard.test.ts 分工：
//   - dashboard.test.ts：seed 灌入 + 顶层页面契约（旧 data-testid 兼容）
//   - dashboardCards.test.tsx：三卡片拆分后各卡片新增能力 + 联动
//
// 不引 @testing-library/react（项目未装）；用 React.createRoot + container.querySelector 模式。

import { describe, it, expect, beforeEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { InstrumentHealthGrid } from '../src/app/components/DashboardPage/InstrumentHealthGrid';
import { WritebackStatusCard } from '../src/app/components/DashboardPage/WritebackStatusCard';
import { QueueStatusCard } from '../src/app/components/DashboardPage/QueueStatusCard';
import {
  DashboardPage,
  type DashboardData,
} from '../src/app/components/DashboardPage/index.js';
import type { InstrumentSummary, CalibrationView } from '../src/app/components/DashboardPage/InstrumentHealthGrid';
import type { ProcessingStateBucket, ProcessingRecordView } from '../src/app/components/DashboardPage/WritebackStatusCard';
import type { QueueStatusRow, QueueJobView } from '../src/app/components/DashboardPage/QueueStatusCard';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** 提供一个全局 fetch mock：按 URL 字面量返回 200 + JSON body；缺省则抛错。
 *  默认 jsdom 不提供 fetch；让 QueueStatusCard 的默认 fetcher 不抛错。 */
function installFetchMock(handler: (url: string) => { status?: number; body: unknown } | null) {
  const originalFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const r = handler(url);
    if (!r) {
      return new Response('not stubbed: ' + url, { status: 599 });
    }
    const body = JSON.stringify(r.body ?? {});
    return new Response(body, {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return () => {
    if (originalFetch === undefined) {
      delete (globalThis as { fetch?: unknown }).fetch;
    } else {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  };
}

/** 工具：把 React 元素挂到 body 上的临时 div；返回 container + unmount。 */
function renderIntoDoc(element: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => Promise<void>;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const tick = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
};

// ---------------- InstrumentHealthGrid ----------------

describe('InstrumentHealthGrid · 三态计数与卡片', () => {
  const instruments: InstrumentSummary[] = [
    {
      instrument_id: 'ASSET-LAB-0001',
      vendor: 'Siemens',
      model: 'ADVIA 2400',
      status: 'online',
      location: '门诊二楼 A 区',
      last_seen_at: '2026-08-30T08:00:00Z',
    },
    {
      instrument_id: 'ASSET-LAB-0002',
      vendor: 'Roche',
      model: 'cobas c702',
      status: 'online',
      location: '门诊二楼 B 区',
      last_seen_at: '2026-08-30T07:55:00Z',
    },
    {
      instrument_id: 'PLACEHOLDER-ASSET-0003',
      vendor: 'Abbott',
      model: 'Architect i2000',
      status: 'alarm',
      location: '住院部三楼',
      last_seen_at: null,
    },
  ];

  it('renders 3 cards + summary 上报 3 总数 + has-alarm true', async () => {
    const { container, unmount } = renderIntoDoc(<InstrumentHealthGrid instruments={instruments} />);
    const root = container.querySelector('[data-testid="dashboard-instrument-health"]');
    expect(root?.getAttribute('data-total')).toBe('3');
    expect(root?.getAttribute('data-has-alarm')).toBe('true');

    const summary = container.querySelector('[data-testid="instrument-status-summary"]');
    expect(summary?.querySelector('[data-status="online"]')?.getAttribute('data-count')).toBe('2');
    expect(summary?.querySelector('[data-status="alarm"]')?.getAttribute('data-count')).toBe('1');
    expect(summary?.querySelector('[data-status="offline"]')?.getAttribute('data-count')).toBe('0');

    const cards = container.querySelectorAll('[data-testid^="instrument-card-"]');
    expect(cards.length).toBe(3);

    const alarm = container.querySelector('[data-instrument-id="PLACEHOLDER-ASSET-0003"]');
    expect(alarm?.getAttribute('data-status')).toBe('alarm');
    expect(container.querySelector('[data-testid="instrument-status-dot-PLACEHOLDER-ASSET-0003"]')).toBeTruthy();

    await unmount();
  });

  it('calibrationsByInstrument 给定时显示「最近校准」时间', async () => {
    const calibrations: Record<string, CalibrationView[]> = {
      'ASSET-LAB-0001': [
        { calibration_id: 'C-001', instrument_id: 'ASSET-LAB-0001', calibrated_at: '2026-08-29T15:30:00Z' },
        { calibration_id: 'C-002', instrument_id: 'ASSET-LAB-0001', calibrated_at: '2026-08-30T03:00:00Z' },
      ],
    };
    const { container, unmount } = renderIntoDoc(
      <InstrumentHealthGrid instruments={instruments} calibrationsByInstrument={calibrations} />,
    );

    const cal = container.querySelector('[data-testid="instrument-last-calibration-ASSET-LAB-0001"]');
    expect(cal?.getAttribute('data-has-calibration')).toBe('true');
    expect(cal?.textContent).toMatch(/08-30 03:00/);

    const noCal = container.querySelector('[data-testid="instrument-last-calibration-PLACEHOLDER-ASSET-0003"]');
    expect(noCal?.getAttribute('data-has-calibration')).toBe('false');
    expect(noCal?.textContent).toMatch(/无心跳/);

    await unmount();
  });

  it('空仪器列表：渲染空汇总 + data-total=0', async () => {
    const { container, unmount } = renderIntoDoc(<InstrumentHealthGrid instruments={[]} />);
    expect(container.querySelector('[data-testid="dashboard-instrument-health"]')?.getAttribute('data-total')).toBe('0');
    expect(container.querySelectorAll('[data-testid^="instrument-card-"]').length).toBe(0);
    expect(container.querySelectorAll('[data-status="online"]').length).toBeGreaterThan(0);
    await unmount();
  });
});

// ---------------- WritebackStatusCard ----------------

describe('WritebackStatusCard · 饼图 + 状态表 + 红条', () => {
  const buckets: ProcessingStateBucket[] = [
    { state: 'received', count: 2 },
    { state: 'parsed', count: 1 },
    { state: 'verified', count: 3 },
    { state: 'written_back', count: 12 },
    { state: 'writeback_pending', count: 1 },
    { state: 'failed', count: 1 },
  ];

  it('饼图切片数 = 非零态数；各态 percent 数据正确', async () => {
    const { container, unmount } = renderIntoDoc(<WritebackStatusCard buckets={buckets} />);

    const svg = container.querySelector('[data-testid="writeback-pie-svg"]');
    expect(svg).toBeTruthy();
    const total = buckets.reduce((a, b) => a + b.count, 0);
    expect(svg?.getAttribute('data-total')).toBe(String(total));

    const slices = container.querySelectorAll('[data-testid^="writeback-pie-slice-"]');
    expect(slices.length).toBe(6);

    const wbSlice = container.querySelector('[data-testid="writeback-pie-slice-written_back"]');
    expect(wbSlice).toBeTruthy();
    expect(wbSlice?.getAttribute('data-percent')).toBe('60');
    expect(wbSlice?.getAttribute('data-count')).toBe('12');

    const failedSlice = container.querySelector('[data-testid="writeback-pie-slice-failed"]');
    expect(failedSlice?.getAttribute('data-percent')).toBe('5');

    const table = container.querySelector('[data-testid="writeback-state-table"]');
    expect(table?.querySelector('tr[data-state="written_back"]')?.getAttribute('data-count')).toBe('12');
    expect(table?.querySelector('tr[data-state="failed"]')?.getAttribute('data-count')).toBe('1');

    await unmount();
  });

  it('failed > 0 → 红色 banner 出现 + has-failed=true + failed-count 数据属性', async () => {
    const { container, unmount } = renderIntoDoc(<WritebackStatusCard buckets={buckets} />);
    const root = container.querySelector('[data-testid="dashboard-writeback-status"]');
    expect(root?.getAttribute('data-has-failed')).toBe('true');
    expect(root?.getAttribute('data-failed-count')).toBe('1');

    const banner = container.querySelector('[data-testid="writeback-failed-banner"]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toMatch(/1 条 write-back 失败/);

    await unmount();
  });

  it('failed = 0 → 不出 banner；has-failed=false', async () => {
    const safe: ProcessingStateBucket[] = [
      { state: 'written_back', count: 5 },
      { state: 'verified', count: 2 },
    ];
    const { container, unmount } = renderIntoDoc(<WritebackStatusCard buckets={safe} />);
    expect(container.querySelector('[data-testid="dashboard-writeback-status"]')?.getAttribute('data-has-failed')).toBe('false');
    expect(container.querySelector('[data-testid="writeback-failed-banner"]')).toBeNull();
    await unmount();
  });

  it('全零桶 → 渲染「暂无数据」SVG；data-total=0', async () => {
    const { container, unmount } = renderIntoDoc(<WritebackStatusCard buckets={[]} />);
    expect(container.querySelector('[data-testid="writeback-pie-svg"]')?.getAttribute('data-total')).toBe('0');
    expect(container.querySelector('[data-testid="writeback-pie-legend-empty"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid^="writeback-pie-slice-"]').length).toBe(0);
    await unmount();
  });

  it('100% 单态 → 完整饼（特殊路径）；data-percent=100', async () => {
    const { container, unmount } = renderIntoDoc(
      <WritebackStatusCard buckets={[{ state: 'written_back', count: 7 }]} />,
    );
    const wb = container.querySelector('[data-testid="writeback-pie-slice-written_back"]');
    expect(wb?.getAttribute('data-percent')).toBe('100');
    expect(wb?.getAttribute('d')).toMatch(/^M 50 50/);
    await unmount();
  });

  it('recentRecords 注入 → 渲染最近列表（按 confirmed_at desc，最多 10 条）', async () => {
    const records: ProcessingRecordView[] = [
      {
        record_id: 'rec-001',
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        state: 'written_back',
        retry_count: 0,
        confirmed_at: '2026-08-30T05:00:00Z',
        operator_id: 'op-A',
      },
      {
        record_id: 'rec-002',
        instrument_id: 'ASSET-LAB-0002',
        alarm_code: 'E014',
        state: 'failed',
        retry_count: 2,
        confirmed_at: '2026-08-30T04:30:00Z',
        operator_id: 'op-B',
      },
    ];
    const { container, unmount } = renderIntoDoc(
      <WritebackStatusCard buckets={buckets} recentRecords={records} />,
    );
    const list = container.querySelector('[data-testid="writeback-recent-list"]');
    expect(list?.getAttribute('data-count')).toBe('2');

    const row1 = container.querySelector('[data-testid="writeback-recent-row-rec-001"]');
    expect(row1?.getAttribute('data-state')).toBe('written_back');
    expect(row1?.getAttribute('data-retry-count')).toBe('0');
    expect(row1?.textContent).toMatch(/08-30 05:00/);

    const row2 = container.querySelector('[data-testid="writeback-recent-row-rec-002"]');
    expect(row2?.getAttribute('data-state')).toBe('failed');
    expect(row2?.querySelector('[data-state="failed"]')?.textContent).toMatch(/failed/);

    await unmount();
  });

  it('recentRecords 超过 10 条 → 截断为 10 条', async () => {
    const records: ProcessingRecordView[] = Array.from({ length: 15 }, (_, i) => ({
      record_id: `rec-${String(i).padStart(3, '0')}`,
      instrument_id: 'ASSET-LAB-0001',
      alarm_code: 'W002',
      state: 'written_back',
      retry_count: 0,
      confirmed_at: `2026-08-30T0${i % 9 + 1}:00:00Z`,
      operator_id: 'op-A',
    }));
    const { container, unmount } = renderIntoDoc(
      <WritebackStatusCard buckets={buckets} recentRecords={records} maxRecent={10} />,
    );
    expect(container.querySelector('[data-testid="writeback-recent-list"]')?.getAttribute('data-count')).toBe('10');
    await unmount();
  });

  it('recentRecords 为空数组 → 渲染「暂无记录」', async () => {
    const { container, unmount } = renderIntoDoc(<WritebackStatusCard buckets={buckets} recentRecords={[]} />);
    expect(container.querySelector('[data-testid="writeback-recent-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="writeback-recent-list"]')?.getAttribute('data-count')).toBe('0');
    await unmount();
  });

  it('未传 recentRecords → 不渲染 recent 区域', async () => {
    const { container, unmount } = renderIntoDoc(<WritebackStatusCard buckets={buckets} />);
    expect(container.querySelector('[data-testid="writeback-recent-list"]')).toBeNull();
    await unmount();
  });
});

// ---------------- QueueStatusCard ----------------

describe('QueueStatusCard · 终态失败 + 重投按钮', () => {
  const queues: QueueStatusRow[] = [
    {
      name: 'lis-writeback',
      pending: 0,
      running: 0,
      success: 3,
      failed: 1,
      lastFailedAt: '2026-08-30T04:30:00Z',
      finalFailures: 1,
      maxAttempts: 5,
    },
  ];

  it('attempts=5（failed=1）+ finalFailures=1 → 红色 alert bar 出现', async () => {
    const fetcher = async (): Promise<{ queues: QueueStatusRow[] }> => ({ queues });
    const { container, unmount } = renderIntoDoc(<QueueStatusCard fetcher={fetcher} />);
    await tick();
    const card = container.querySelector('[data-testid="queue-status-card"]');
    expect(card?.getAttribute('data-has-failures')).toBe('true');

    const alertBar = container.querySelector('[data-testid="queue-alert-bar"]');
    expect(alertBar).toBeTruthy();
    expect(alertBar?.textContent).toMatch(/1 个队列有终态失败工单/);

    const failedCell = container.querySelector('[data-testid="queue-failed-lis-writeback"]');
    expect(failedCell?.getAttribute('data-reached-max')).toBe('true');

    await unmount();
  });

  it('无终态失败 → 无 alert bar，无 failed 红粗', async () => {
    const ok: QueueStatusRow[] = [
      {
        name: 'lis-writeback',
        pending: 0,
        running: 0,
        success: 5,
        failed: 0,
        lastFailedAt: null,
        finalFailures: 0,
        maxAttempts: 5,
      },
    ];
    const { container, unmount } = renderIntoDoc(
      <QueueStatusCard fetcher={async () => ({ queues: ok })} />,
    );
    await tick();
    expect(container.querySelector('[data-testid="queue-alert-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="queue-failed-lis-writeback"]')?.getAttribute('data-reached-max')).toBe('false');
    await unmount();
  });

  it('展开 job → 显示失败行的「重投」按钮', async () => {
    const failedJob: QueueJobView = {
      id: 'job-failed-1',
      name: 'lis-writeback',
      eventId: 'confirm:rec-002',
      attempts: 5,
      status: 'failed',
      lastError: 'JSONL write EACCES',
      nextRunAt: '2026-08-30T05:00:00Z',
      createdAt: '2026-08-30T04:30:00Z',
      payloadPreview: '{}',
    };
    const fetcher = async (): Promise<{ queues: QueueStatusRow[] }> => ({ queues });
    const jobsFetcher = async (): Promise<{ queue: string; jobs: QueueJobView[] }> => ({
      queue: 'lis-writeback',
      jobs: [failedJob],
    });

    const { container, unmount } = renderIntoDoc(
      <QueueStatusCard fetcher={fetcher} jobsFetcher={jobsFetcher} />,
    );
    await tick();

    const toggleBtn = container.querySelector('[data-testid="queue-toggle-lis-writeback"]') as HTMLButtonElement | null;
    expect(toggleBtn).toBeTruthy();
    await act(async () => {
      toggleBtn?.click();
    });
    await tick();

    const retryBtn = container.querySelector('[data-testid="retry-job-failed-1"]');
    expect(retryBtn).toBeTruthy();
    expect(retryBtn?.textContent).toMatch(/^重投/);

    await unmount();
  });
});

// ---------------- 联动：DashboardPage 三卡同框 + 顶部红条 ----------------

describe('DashboardPage 联动：三卡渲染与顶部红条', () => {
  const fakeData: DashboardData = {
    instruments: [
      {
        instrument_id: 'ASSET-LAB-0001',
        vendor: 'Siemens',
        model: 'ADVIA 2400',
        status: 'online',
        location: '门诊二楼 A 区',
        last_seen_at: '2026-08-30T08:00:00Z',
      },
      {
        instrument_id: 'PLACEHOLDER-ASSET-0003',
        vendor: 'Abbott',
        model: 'Architect i2000',
        status: 'alarm',
        location: '住院部三楼',
        last_seen_at: null,
      },
    ],
    queues: [
      {
        name: 'lis-writeback',
        pending: 0,
        running: 0,
        success: 3,
        failed: 1,
        lastFailedAt: '2026-08-30T04:30:00Z',
        finalFailures: 1,
        maxAttempts: 5,
      },
    ],
    processingStateBuckets: [
      { state: 'written_back', count: 6 },
      { state: 'failed', count: 1 },
    ],
    recentProcessingRecords: [
      {
        record_id: 'rec-002',
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'E014',
        state: 'failed',
        retry_count: 2,
        confirmed_at: '2026-08-30T04:30:00Z',
        operator_id: 'op-B',
      },
    ],
    calibrationsByInstrument: {
      'ASSET-LAB-0001': [
        { calibration_id: 'C-002', instrument_id: 'ASSET-LAB-0001', calibrated_at: '2026-08-30T03:00:00Z' },
      ],
    },
    dailyDigest: [{ date: '2026-08-30', total_records: 7, failed_records: 1, written_back: 6 }],
  };

  const makeFetchers = (data: DashboardData) => ({
    instruments: async () => data.instruments,
    queueStatus: async () => ({ queues: data.queues }),
    processingStates: async () => data.processingStateBuckets,
    recentProcessingRecords: async () => data.recentProcessingRecords ?? [],
    calibrationsByInstrument: async () => data.calibrationsByInstrument ?? {},
    dailyDigest: async () => data.dailyDigest,
  });

  it('队列 finalFailures > 0 → 顶部红条 + 三卡渲染', async () => {
    const restoreFetch = installFetchMock((url) => {
      if (url.endsWith('/api/queue/status')) {
        return { body: { queues: fakeData.queues } };
      }
      return null;
    });
    try {
      const { container, unmount } = renderIntoDoc(
        React.createElement(DashboardPage, { fetchers: makeFetchers(fakeData) }),
      );
      await tick();

      const root$ = container.querySelector('[data-testid="dashboard-root"]');
      expect(root$?.getAttribute('data-status')).toBe('ready');
      expect(root$?.getAttribute('data-has-queue-failures')).toBe('true');
      expect(container.querySelector('[data-testid="dashboard-top-failure-banner"]')).toBeTruthy();

      expect(container.querySelector('[data-testid="dashboard-instrument-health"]')).toBeTruthy();
      expect(
        container.querySelector('[data-testid="instrument-last-calibration-ASSET-LAB-0001"]')?.getAttribute('data-has-calibration'),
      ).toBe('true');

      expect(container.querySelector('[data-testid="writeback-pie-svg"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="writeback-state-table"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="writeback-failed-banner"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="writeback-recent-list"]')?.getAttribute('data-count')).toBe('1');

      expect(container.querySelector('[data-testid="queue-status-card"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="queue-alert-bar"]')).toBeTruthy();

      await unmount();
    } finally {
      restoreFetch();
    }
  });

  it('无失败 → 不出顶部红条，无卡片告警', async () => {
    const safeQueues = [
      {
        name: 'lis-writeback',
        pending: 0,
        running: 0,
        success: 5,
        failed: 0,
        lastFailedAt: null,
        finalFailures: 0,
        maxAttempts: 5,
      } as const,
    ];
    const safe: DashboardData = {
      ...fakeData,
      queues: [...safeQueues],
      processingStateBuckets: [{ state: 'written_back', count: 5 }],
    };
    const restoreFetch = installFetchMock((url) => {
      if (url.endsWith('/api/queue/status')) {
        return { body: { queues: safe.queues } };
      }
      return null;
    });
    try {
      const { container, unmount } = renderIntoDoc(
        React.createElement(DashboardPage, { fetchers: makeFetchers(safe) }),
      );
      await tick();

      expect(container.querySelector('[data-testid="dashboard-root"]')?.getAttribute('data-has-queue-failures')).toBe('false');
      expect(container.querySelector('[data-testid="dashboard-top-failure-banner"]')).toBeNull();
      expect(container.querySelector('[data-testid="writeback-failed-banner"]')).toBeNull();
      expect(container.querySelector('[data-testid="queue-alert-bar"]')).toBeNull();

      await unmount();
    } finally {
      restoreFetch();
    }
  });
});
