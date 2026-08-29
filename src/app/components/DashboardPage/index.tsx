// src/app/components/DashboardPage/index.tsx
//
// 看板：组合三卡片 + 日报聚合卡。
// 面向设备科长与检验工程师的「一眼能看出问题」首页。
//
// 设计原则：
//   1) 三卡片拆为独立子组件（WritebackStatusCard / QueueStatusCard / InstrumentHealthGrid）
//   2) 所有数据源通过 fetcher 注入；默认 fetch /api/*，测试可传 stub
//   3) data-testid / data-status / data-state 命名稳定，便于 jsdom 断言
//   4) 顶部红条：队列 finalFailures > 0 时触发，提示用户到「队列状态」卡内重投或转人工
//
// 领养的调用链（参考 outline/app/scenes/Dashboard 的卡片网格 + 拉取策略）：
//   mount → Promise.all([instruments, queueStatus, processingStates, recentRecords, calibrations, dailyDigest])
//   → 三卡片并排 + 日报列表
//
// 拆分：
//   - InstrumentHealthGrid   → src/app/components/DashboardPage/InstrumentHealthGrid.tsx
//   - WritebackStatusCard    → src/app/components/DashboardPage/WritebackStatusCard.tsx
//   - QueueStatusCard        → src/app/components/DashboardPage/QueueStatusCard.tsx

import * as React from 'react';
import { QueueStatusCard, type QueueStatusRow, type QueueJobView } from './QueueStatusCard.js';
import { RetryButton } from './RetryButton.js';
import {
  InstrumentHealthGrid,
  type InstrumentSummary,
  type CalibrationView,
} from './InstrumentHealthGrid.js';
import {
  WritebackStatusCard,
  type ProcessingStateBucket,
  type ProcessingRecordView,
} from './WritebackStatusCard.js';

export { InstrumentHealthGrid, type InstrumentSummary, type CalibrationView } from './InstrumentHealthGrid.js';
export {
  WritebackStatusCard,
  WRITEBACK_STATES_ORDER,
  type ProcessingStateBucket,
  type ProcessingRecordView,
  type WritebackState,
} from './WritebackStatusCard.js';
export { QueueStatusCard, type QueueStatusRow, type QueueJobView } from './QueueStatusCard.js';
export { RetryButton } from './RetryButton.js';

export interface DailyDigestEntry {
  date: string; // YYYY-MM-DD
  total_records: number;
  failed_records: number;
  written_back: number;
}

export interface DashboardData {
  instruments: InstrumentSummary[];
  queues: QueueStatusRow[];
  processingStateBuckets: ProcessingStateBucket[];
  /** 新增：用于 WritebackStatusCard 底表（最近 10 条）。 */
  recentProcessingRecords?: ProcessingRecordView[];
  /** 新增：用于 InstrumentHealthGrid 显示「最近校准」时间。 */
  calibrationsByInstrument?: Record<string, CalibrationView[]>;
  dailyDigest: DailyDigestEntry[];
}

/** 默认 fetcher：拉取 /api/instruments + /api/queue/status + /api/processing-records。 */
const defaultFetchers = {
  instruments: async (): Promise<InstrumentSummary[]> => {
    const r = await fetch('/api/instruments?per_page=200');
    if (!r.ok) throw new Error(`GET /api/instruments ${r.status}`);
    const body = (await r.json()) as { instruments: InstrumentSummary[] };
    return body.instruments;
  },
  queueStatus: async (): Promise<{ queues: QueueStatusRow[] }> => {
    const r = await fetch('/api/queue/status');
    if (!r.ok) throw new Error(`GET /api/queue/status ${r.status}`);
    return r.json() as Promise<{ queues: QueueStatusRow[] }>;
  },
  processingStates: async (): Promise<ProcessingStateBucket[]> => {
    try {
      const r = await fetch('/api/processing-records?per_page=1');
      if (!r.ok) return [];
      const body = (await r.json()) as { state_buckets?: ProcessingStateBucket[] };
      return body.state_buckets ?? [];
    } catch {
      return [];
    }
  },
  recentProcessingRecords: async (): Promise<ProcessingRecordView[]> => {
    try {
      const r = await fetch('/api/processing-records?per_page=10&sort=confirmed_at:desc');
      if (!r.ok) return [];
      const body = (await r.json()) as { records?: ProcessingRecordView[] };
      return body.records ?? [];
    } catch {
      return [];
    }
  },
  calibrationsByInstrument: async (): Promise<Record<string, CalibrationView[]>> => {
    try {
      const r = await fetch('/api/calibrations?per_page=500&sort=calibrated_at:desc');
      if (!r.ok) return {};
      const body = (await r.json()) as { calibrations?: CalibrationView[] };
      const grouped: Record<string, CalibrationView[]> = {};
      for (const c of body.calibrations ?? []) {
        (grouped[c.instrument_id] ??= []).push(c);
      }
      return grouped;
    } catch {
      return {};
    }
  },
  dailyDigest: async (): Promise<DailyDigestEntry[]> => {
    try {
      const r = await fetch('/api/processing-records/daily-digest');
      if (!r.ok) return [];
      const body = (await r.json()) as { entries?: DailyDigestEntry[] };
      return body.entries ?? [];
    } catch {
      return [];
    }
  },
};

export interface DashboardPageProps {
  /** 全部 6 个 fetcher 都是可选：旧 caller 只注入部分也能跑（缺字段由内部空兜底）。
   *  各 fetcher 内部抛错：关键 fetcher → 整体错误态；可选 fetcher → 静默 fallback。 */
  fetchers?: Partial<typeof defaultFetchers>;
  /** 测试用：注入 QueueStatusCard 子组件的依赖。 */
  queueStatusCard?: typeof QueueStatusCard;
}

/** 日报聚合卡：最近 7 天 daily digest。 */
function DailyDigestCard(props: { entries: DailyDigestEntry[] }): React.ReactElement {
  const { entries } = props;
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 7);
  return (
    <div
      data-testid="dashboard-daily-digest"
      data-entry-count={sorted.length}
      style={{ border: '1px solid #ddd', borderRadius: 4, padding: 12, flex: 1, minWidth: 240 }}
    >
      <h3 style={{ margin: '0 0 8px' }}>日报聚合（近 7 天）</h3>
      {sorted.length === 0 ? (
        <div data-testid="daily-digest-empty" style={{ color: '#666' }}>
          暂无日报
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', fontSize: 12, color: '#666' }}>Date</th>
              <th style={{ textAlign: 'right', fontSize: 12, color: '#666' }}>Total</th>
              <th style={{ textAlign: 'right', fontSize: 12, color: '#666' }}>Failed</th>
              <th style={{ textAlign: 'right', fontSize: 12, color: '#666' }}>Written</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => (
              <tr key={e.date} data-date={e.date}>
                <td style={{ padding: '2px 4px' }}>{e.date}</td>
                <td style={{ padding: '2px 4px', textAlign: 'right' }}>{e.total_records}</td>
                <td
                  style={{
                    padding: '2px 4px',
                    textAlign: 'right',
                    color: e.failed_records > 0 ? '#c62828' : 'inherit',
                  }}
                >
                  {e.failed_records}
                </td>
                <td style={{ padding: '2px 4px', textAlign: 'right' }}>{e.written_back}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function DashboardPage(props: DashboardPageProps): React.ReactElement {
  // 缺省 fetcher 走 defaultFetchers；caller 注入只覆盖它给出的字段。
  // 用 useRef 稳定 fetchers 引用：每次 render 不重新展开对象，避免 useCallback 反复 invalidate 致 useEffect 反复触发的渲染循环。
  // 当 props.fetchers 引用变更时（极少数情况：父组件 re-mounts 或显式替换），才重算 merged fetchers。
  const fetchersRef = React.useRef<typeof defaultFetchers | null>(null);
  const injectedFetchers = props.fetchers;
  if (
    fetchersRef.current === null ||
    (injectedFetchers !== undefined && (fetchersRef.current as unknown as { __injected?: unknown }).__injected !== injectedFetchers)
  ) {
    const merged: typeof defaultFetchers = {
      ...defaultFetchers,
      ...(injectedFetchers ?? {}),
    };
    (merged as unknown as { __injected?: unknown }).__injected = injectedFetchers ?? defaultFetchers;
    fetchersRef.current = merged;
  }
  const fetchers = fetchersRef.current;
  const QueueCard = props.queueStatusCard ?? QueueStatusCard;

  const [data, setData] = React.useState<DashboardData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        instruments,
        queueRes,
        processingStates,
        recentProcessingRecords,
        calibrationsByInstrument,
        dailyDigest,
      ] = await Promise.all([
        fetchers.instruments(),
        fetchers.queueStatus(),
        fetchers.processingStates(),
        fetchers.recentProcessingRecords(),
        fetchers.calibrationsByInstrument(),
        fetchers.dailyDigest(),
      ]);
      setData({
        instruments,
        queues: queueRes.queues,
        processingStateBuckets: processingStates,
        recentProcessingRecords,
        calibrationsByInstrument,
        dailyDigest,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fetchers]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading && !data) {
    return (
      <div data-testid="dashboard-root" data-status="loading" style={{ padding: 24 }}>
        看板加载中…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div
        data-testid="dashboard-root"
        data-status="error"
        style={{ padding: 24, color: '#c62828' }}
      >
        看板加载失败：{error}
      </div>
    );
  }

  const d = data!;
  const hasAnyFailure = d.queues.some((q) => q.finalFailures > 0);

  return (
    <div
      data-testid="dashboard-root"
      data-status="ready"
      data-has-queue-failures={hasAnyFailure ? 'true' : 'false'}
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>检验业务现场作业看板</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          data-testid="dashboard-refresh"
          style={{ padding: '4px 12px' }}
        >
          刷新
        </button>
      </header>

      {hasAnyFailure ? (
        <div
          role="alert"
          data-testid="dashboard-top-failure-banner"
          style={{ padding: '8px 12px', background: '#ffebee', color: '#c62828', borderRadius: 4 }}
        >
          队列存在终态失败工单，请在「队列状态」卡片中重投或转人工
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <InstrumentHealthGrid
          instruments={d.instruments}
          calibrationsByInstrument={d.calibrationsByInstrument}
        />
        <QueueCard />
        <WritebackStatusCard
          buckets={d.processingStateBuckets}
          recentRecords={d.recentProcessingRecords}
        />
      </div>

      <DailyDigestCard entries={d.dailyDigest} />
    </div>
  );
}

export default DashboardPage;
