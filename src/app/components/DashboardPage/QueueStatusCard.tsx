// src/app/components/DashboardPage/QueueStatusCard.tsx
//
// 队列状态卡片：
//  - 每行一个队列（name / pending / running / success / failed）
//  - 任意队列 finalFailures > 0 时显示红色告警条
//  - 每行末有「重投」按钮（fetch GET /api/queue/:name/jobs → 拿 failed 列表 → POST retry）
//  - 加载态 / 错误态 / 正常态 三态

import * as React from 'react';

export interface QueueStatusRow {
  name: string;
  pending: number;
  running: number;
  success: number;
  failed: number;
  lastFailedAt: string | null;
  finalFailures: number;
  maxAttempts: number;
}

export interface QueueJobView {
  id: string;
  name: string;
  eventId: string;
  attempts: number;
  status: 'pending' | 'running' | 'success' | 'failed';
  lastError: string | null;
  nextRunAt: string;
  createdAt: string;
  payloadPreview: string;
}

export interface QueueStatusCardProps {
  /** 默认从 /api/queue/status 拉取；可注入测试替身。 */
  fetcher?: () => Promise<{ queues: QueueStatusRow[] }>;
  /** 默认从 /api/queue/:name/jobs 拉取；可注入测试替身。 */
  jobsFetcher?: (name: string) => Promise<{ queue: string; jobs: QueueJobView[] }>;
  /** 默认 POST /api/queue/retry/:jobId；可注入测试替身。 */
  retry?: (jobId: string) => Promise<{ jobId: string; queue: string; attemptsReset: number; retriedAt: string }>;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const defaultFetcher = async (): Promise<{ queues: QueueStatusRow[] }> => {
  const r = await fetch('/api/queue/status');
  if (!r.ok) throw new Error(`GET /api/queue/status ${r.status}`);
  return r.json() as Promise<{ queues: QueueStatusRow[] }>;
};

const defaultJobsFetcher = async (
  name: string,
): Promise<{ queue: string; jobs: QueueJobView[] }> => {
  const r = await fetch(`/api/queue/${encodeURIComponent(name)}/jobs`);
  if (!r.ok) throw new Error(`GET /api/queue/${name}/jobs ${r.status}`);
  return r.json() as Promise<{ queue: string; jobs: QueueJobView[] }>;
};

const defaultRetry = async (
  jobId: string,
): Promise<{ jobId: string; queue: string; attemptsReset: number; retriedAt: string }> => {
  const r = await fetch(`/api/queue/retry/${encodeURIComponent(jobId)}`, {
    method: 'POST',
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`POST /api/queue/retry/${jobId} ${r.status}: ${text}`);
  }
  return r.json() as Promise<{ jobId: string; queue: string; attemptsReset: number; retriedAt: string }>;
};

export function QueueStatusCard(props: QueueStatusCardProps) {
  const fetcher = props.fetcher ?? defaultFetcher;
  const jobsFetcher = props.jobsFetcher ?? defaultJobsFetcher;
  const retry = props.retry ?? defaultRetry;

  const [state, setState] = React.useState<LoadState>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [queues, setQueues] = React.useState<QueueStatusRow[]>([]);
  const [openQueue, setOpenQueue] = React.useState<string | null>(null);
  const [jobs, setJobs] = React.useState<QueueJobView[]>([]);
  const [retryBusy, setRetryBusy] = React.useState<string | null>(null);
  const [lastRetry, setLastRetry] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const data = await fetcher();
      setQueues(data.queues ?? []);
      setState('ready');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }, [fetcher]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const toggleJobs = React.useCallback(
    async (name: string) => {
      if (openQueue === name) {
        setOpenQueue(null);
        setJobs([]);
        return;
      }
      setOpenQueue(name);
      try {
        const data = await jobsFetcher(name);
        setJobs(data.jobs ?? []);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setJobs([]);
      }
    },
    [openQueue, jobsFetcher],
  );

  const onRetry = React.useCallback(
    async (jobId: string) => {
      setRetryBusy(jobId);
      try {
        const r = await retry(jobId);
        setLastRetry(`${r.queue} · ${r.jobId}`);
        await load();
        if (openQueue) {
          const data = await jobsFetcher(openQueue);
          setJobs(data.jobs ?? []);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRetryBusy(null);
      }
    },
    [retry, load, openQueue, jobsFetcher],
  );

  if (state === 'loading' && queues.length === 0) {
    return (
      <section
        data-testid="queue-status-card"
        data-loading="true"
        style={{ padding: 12, border: '1px solid #ddd', borderRadius: 6 }}
      >
        <h3 style={{ margin: 0, fontSize: 14 }}>队列状态</h3>
        <p style={{ color: '#666', fontSize: 12 }}>加载中…</p>
      </section>
    );
  }

  if (state === 'error') {
    return (
      <section
        data-testid="queue-status-card"
        data-status="error"
        style={{ padding: 12, border: '1px solid #d32f2f', borderRadius: 6 }}
      >
        <h3 style={{ margin: 0, fontSize: 14 }}>队列状态</h3>
        <p style={{ color: '#d32f2f', fontSize: 12 }}>加载失败：{error}</p>
        <button type="button" onClick={load} data-testid="queue-status-retry">
          重试
        </button>
      </section>
    );
  }

  const hasFailures = queues.some((q) => q.finalFailures > 0);

  return (
    <section
      data-testid="queue-status-card"
      data-status="ready"
      data-has-failures={hasFailures ? 'true' : 'false'}
      style={{
        padding: 12,
        border: hasFailures ? '2px solid #d32f2f' : '1px solid #ddd',
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>队列状态</h3>
        <button
          type="button"
          onClick={load}
          data-testid="queue-status-refresh"
          style={{ fontSize: 12 }}
        >
          刷新
        </button>
      </div>

      {hasFailures ? (
        <div
          data-testid="queue-alert-bar"
          role="alert"
          style={{
            marginTop: 8,
            padding: '6px 10px',
            background: '#d32f2f',
            color: 'white',
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          {queues.filter((q) => q.finalFailures > 0).length} 个队列有终态失败工单，请尽快重投或转人工
        </div>
      ) : null}

      {lastRetry ? (
        <p
          data-testid="queue-last-retry"
          style={{ marginTop: 8, color: '#2e7d32', fontSize: 12 }}
        >
          已重投：{lastRetry}
        </p>
      ) : null}

      <table
        data-testid="queue-status-table"
        style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, fontSize: 12 }}
      >
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 4, borderBottom: '1px solid #eee' }}>队列</th>
            <th style={{ textAlign: 'right', padding: 4, borderBottom: '1px solid #eee' }}>pending</th>
            <th style={{ textAlign: 'right', padding: 4, borderBottom: '1px solid #eee' }}>running</th>
            <th style={{ textAlign: 'right', padding: 4, borderBottom: '1px solid #eee' }}>success</th>
            <th style={{ textAlign: 'right', padding: 4, borderBottom: '1px solid #eee' }}>failed</th>
            <th style={{ textAlign: 'right', padding: 4, borderBottom: '1px solid #eee' }}>max</th>
            <th style={{ padding: 4 }} />
          </tr>
        </thead>
        <tbody>
          {queues.map((q) => (
            <QueueRow
              key={q.name}
              row={q}
              isOpen={openQueue === q.name}
              jobs={openQueue === q.name ? jobs : []}
              retryBusy={retryBusy}
              onToggle={() => void toggleJobs(q.name)}
              onRetry={(jobId) => void onRetry(jobId)}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function QueueRow({
  row,
  isOpen,
  jobs,
  retryBusy,
  onToggle,
  onRetry,
}: {
  row: QueueStatusRow;
  isOpen: boolean;
  jobs: QueueJobView[];
  retryBusy: string | null;
  onToggle: () => void;
  onRetry: (jobId: string) => void;
}) {
  const reachedMax = row.failed > 0;
  return (
    <>
      <tr data-testid={`queue-row-${row.name}`} data-queue-name={row.name}>
        <td style={{ padding: 4, borderBottom: '1px solid #f5f5f5' }}>
          <button
            type="button"
            onClick={onToggle}
            data-testid={`queue-toggle-${row.name}`}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#1976d2',
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
            }}
          >
            {row.name}
          </button>
        </td>
        <td style={{ padding: 4, textAlign: 'right', borderBottom: '1px solid #f5f5f5' }}>{row.pending}</td>
        <td style={{ padding: 4, textAlign: 'right', borderBottom: '1px solid #f5f5f5' }}>{row.running}</td>
        <td style={{ padding: 4, textAlign: 'right', borderBottom: '1px solid #f5f5f5' }}>{row.success}</td>
        <td
          data-testid={`queue-failed-${row.name}`}
          data-reached-max={reachedMax ? 'true' : 'false'}
          style={{
            padding: 4,
            textAlign: 'right',
            borderBottom: '1px solid #f5f5f5',
            color: reachedMax ? '#d32f2f' : '#333',
            fontWeight: reachedMax ? 600 : 400,
          }}
        >
          {row.failed}
        </td>
        <td style={{ padding: 4, textAlign: 'right', borderBottom: '1px solid #f5f5f5', color: '#888' }}>
          {row.maxAttempts}
        </td>
        <td style={{ padding: 4, textAlign: 'right', borderBottom: '1px solid #f5f5f5' }}>
          {isOpen ? '收起' : '查看 jobs'}
        </td>
      </tr>
      {isOpen ? (
        <tr>
          <td colSpan={7} style={{ padding: 4, background: '#fafafa' }}>
            {jobs.length === 0 ? (
              <p style={{ margin: 4, color: '#888' }}>无 job</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {jobs.map((j) => (
                  <li
                    key={j.id}
                    data-testid={`job-${j.id}`}
                    data-status={j.status}
                    style={{
                      padding: 4,
                      borderBottom: '1px dashed #eee',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <span style={{ flex: 1, fontSize: 11, color: '#444' }}>
                      <code style={{ fontSize: 11 }}>{j.id.slice(0, 8)}</code>
                      {' · '}
                      attempts={j.attempts}
                      {' · '}
                      {j.status}
                      {j.lastError ? ` · ${j.lastError.slice(0, 60)}` : ''}
                    </span>
                    {j.status === 'failed' ? (
                      <button
                        type="button"
                        data-testid={`retry-${j.id}`}
                        disabled={retryBusy === j.id}
                        onClick={() => onRetry(j.id)}
                        style={{
                          background: '#1976d2',
                          color: 'white',
                          border: 'none',
                          borderRadius: 3,
                          padding: '2px 8px',
                          fontSize: 11,
                          cursor: retryBusy === j.id ? 'wait' : 'pointer',
                        }}
                      >
                        {retryBusy === j.id ? '重投中…' : '重投'}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
