// src/app/components/DashboardPage/RetryButton.tsx
//
// 重投按钮：封装「确认对话框 + POST retry + 成功/失败反馈」。
// 通常配合 QueueStatusCard 内的失败 job 行使用；也可作为独立组件用于「一键重投某 job」。
//
// 设计取舍：
//   - 不引第三方对话框库；用 window.confirm 做最朴素的二次确认（信息科快捷操作场景）。
//   - 默认走 fetch('/api/queue/retry/:jobId', { method: 'POST' })；可注入 retry 替身便于测试。
//   - 三态：idle / busy / done / error，每态有 data-testid 钩子便于 jsdom 测试断言。

import * as React from 'react';

export interface RetryButtonProps {
  jobId: string;
  queueName?: string;
  /** 默认 fetch POST /api/queue/retry/:jobId；可注入测试替身。 */
  retry?: (jobId: string) => Promise<{ jobId: string; queue: string; attemptsReset: number; retriedAt: string }>;
  /** 成功后回调（让 caller 重新拉列表）。 */
  onRetried?: (result: { jobId: string; queue: string }) => void;
  /** 失败后回调。 */
  onError?: (err: Error) => void;
  /** 二次确认文案；undefined 时不弹窗直接重投。 */
  confirmMessage?: string;
}

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

export function RetryButton(props: RetryButtonProps) {
  const { jobId, queueName, retry = defaultRetry, onRetried, onError, confirmMessage } = props;
  const [phase, setPhase] = React.useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [errorText, setErrorText] = React.useState<string | null>(null);

  const handleClick = React.useCallback(async () => {
    if (phase === 'busy') return;
    if (confirmMessage) {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(confirmMessage)
        : true;
      if (!ok) return;
    }
    setPhase('busy');
    setErrorText(null);
    try {
      const result = await retry(jobId);
      setPhase('done');
      onRetried?.({ jobId: result.jobId, queue: result.queue });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setErrorText(message);
      setPhase('error');
      onError?.(new Error(message));
    }
  }, [phase, retry, jobId, onRetried, onError, confirmMessage]);

  const label =
    phase === 'busy'
      ? '重投中…'
      : phase === 'done'
        ? '已重投'
        : phase === 'error'
          ? '重投失败（点击重试）'
          : '重投';

  return (
    <button
      type="button"
      data-testid={`retry-button-${jobId}`}
      data-phase={phase}
      data-queue={queueName ?? ''}
      disabled={phase === 'busy'}
      onClick={handleClick}
      style={{
        background: phase === 'error' ? '#d32f2f' : '#1976d2',
        color: 'white',
        border: 'none',
        borderRadius: 3,
        padding: '4px 10px',
        fontSize: 12,
        cursor: phase === 'busy' ? 'wait' : 'pointer',
      }}
    >
      {label}
      {errorText ? (
        <span data-testid={`retry-error-${jobId}`} style={{ marginLeft: 6, fontSize: 10 }}>
          {errorText.slice(0, 40)}
        </span>
      ) : null}
    </button>
  );
}
