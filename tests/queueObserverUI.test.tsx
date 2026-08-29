// tests/queueObserverUI.test.tsx
//
// 看板 QueueStatusCard / RetryButton React 组件测试（jsdom）。
// 覆盖看板三态 + 红色告警条 + 重投按钮触发：
//   - 加载态 (loading=true)
//   - 错误态 (status=error)
//   - 正常态 (status=ready)
//   - attempts=5 时显示红条 + 每队列 failed cell 红字
//   - retry 按钮 click → 调用 retry 替身 + 重投后自动刷新

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueueStatusCard } from '../src/app/components/DashboardPage/QueueStatusCard';
import { RetryButton } from '../src/app/components/DashboardPage/RetryButton';
import type {
  QueueStatusRow,
  QueueJobView,
} from '../src/app/components/DashboardPage/QueueStatusCard';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-obs-ui-'));

beforeAll(() => {
  process.chdir(path.resolve(__dirname, '..'));
});

beforeEach(() => {
  document.body.innerHTML = '';
});

afterAll(() => {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

const fakeRow: QueueStatusRow = {
  name: 'lis-writeback',
  pending: 0,
  running: 0,
  success: 12,
  failed: 0,
  lastFailedAt: null,
  finalFailures: 0,
  maxAttempts: 5,
};

const fakeFailedRow: QueueStatusRow = {
  name: 'lis-writeback',
  pending: 0,
  running: 0,
  success: 12,
  failed: 1,
  lastFailedAt: '2026-08-29T22:00:00.000Z',
  finalFailures: 1,
  maxAttempts: 5,
};

const fakeFailedJob: QueueJobView = {
  id: 'job-1',
  name: 'lis-writeback',
  eventId: 'evt-1',
  attempts: 5,
  status: 'failed',
  lastError: 'simulated failure',
  nextRunAt: '2026-08-29T22:00:00.000Z',
  createdAt: '2026-08-29T21:55:00.000Z',
  payloadPreview: '{"kind":"x"}',
};

const tick = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
};

describe('QueueStatusCard 渲染', () => {
  it('加载态：fetcher 立即 resolve 后进入 ready', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const fetcher = vi.fn(async () => ({ queues: [fakeRow] }));

    await act(async () => {
      root.render(React.createElement(QueueStatusCard, { fetcher }));
    });
    // 初次渲染时 state=loading；fetcher promise 解析后 → ready
    await tick();

    const card = container.querySelector('[data-testid="queue-status-card"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute('data-status')).toBe('ready');
    expect(card?.getAttribute('data-has-failures')).toBe('false');

    const row = container.querySelector(`[data-testid="queue-row-lis-writeback"]`);
    expect(row).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('错误态：fetcher reject → 显示红色边框 + 错误文本 + 重试按钮', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const fetcher = vi.fn(async () => {
      throw new Error('boom-network');
    });

    await act(async () => {
      root.render(React.createElement(QueueStatusCard, { fetcher }));
    });
    await tick();

    const card = container.querySelector('[data-testid="queue-status-card"]');
    expect(card?.getAttribute('data-status')).toBe('error');
    expect(card?.textContent).toContain('boom-network');
    const retryBtn = container.querySelector('[data-testid="queue-status-retry"]');
    expect(retryBtn).toBeTruthy();
  });

  it('红色告警条：finalFailures > 0 → data-has-failures=true + 红条可见', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const fetcher = vi.fn(async () => ({ queues: [fakeFailedRow] }));

    await act(async () => {
      root.render(React.createElement(QueueStatusCard, { fetcher }));
    });
    await tick();

    const card = container.querySelector('[data-testid="queue-status-card"]');
    expect(card?.getAttribute('data-has-failures')).toBe('true');
    const alert = container.querySelector('[data-testid="queue-alert-bar"]');
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain('1 个队列');
    expect(alert?.textContent).toContain('终态失败');

    const failedCell = container.querySelector('[data-testid="queue-failed-lis-writeback"]');
    expect(failedCell?.getAttribute('data-reached-max')).toBe('true');
    expect(failedCell?.textContent).toBe('1');
  });

  it('正常态无失败：data-has-failures=false，无告警条', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const fetcher = vi.fn(async () => ({ queues: [fakeRow] }));

    await act(async () => {
      root.render(React.createElement(QueueStatusCard, { fetcher }));
    });
    await tick();

    const card = container.querySelector('[data-testid="queue-status-card"]');
    expect(card?.getAttribute('data-has-failures')).toBe('false');
    expect(container.querySelector('[data-testid="queue-alert-bar"]')).toBeNull();
  });
});

describe('QueueStatusCard 重投端到端', () => {
  it('点击 retry 按钮 → 调用 retry 替身 + 自动刷新 + 显示 lastRetry', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const retryCalls: string[] = [];
    const fetcher = vi.fn(async () => ({ queues: [fakeFailedRow] }));
    const jobsFetcher = vi.fn(async (_name: string) => ({
      queue: 'lis-writeback',
      jobs: [fakeFailedJob],
    }));
    const retry = vi.fn(async (jobId: string) => {
      retryCalls.push(jobId);
      return {
        jobId,
        queue: 'lis-writeback',
        attemptsReset: 0,
        retriedAt: '2026-08-29T22:01:00.000Z',
      };
    });

    await act(async () => {
      root.render(
        React.createElement(QueueStatusCard, {
          fetcher,
          jobsFetcher,
          retry,
        }),
      );
    });
    await tick();

    // 展开队列
    const toggle = container.querySelector('[data-testid="queue-toggle-lis-writeback"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle.click();
    });
    await tick();

    // 找到 retry 按钮
    const retryBtn = container.querySelector(`[data-testid="retry-${fakeFailedJob.id}"]`) as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn.click();
    });
    await tick();
    await tick();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(fakeFailedJob.id);
    expect(retryCalls).toEqual([fakeFailedJob.id]);

    // fetcher 被调用至少 2 次（初次 + retry 后刷新）
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);

    const lastRetry = container.querySelector('[data-testid="queue-last-retry"]');
    expect(lastRetry?.textContent).toContain(fakeFailedJob.id);
  });
});

describe('RetryButton 独立组件', () => {
  it('idle → click → 调用 retry 替身 → done 状态显示「已重投」', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const retry = vi.fn(async (jobId: string) => ({
      jobId,
      queue: 'lis-writeback',
      attemptsReset: 0,
      retriedAt: '2026-08-29T22:01:00.000Z',
    }));

    await act(async () => {
      root.render(
        React.createElement(RetryButton, {
          jobId: 'job-X',
          queueName: 'lis-writeback',
          retry,
        }),
      );
    });
    await tick();

    const btn = container.querySelector('[data-testid="retry-button-job-X"]') as HTMLButtonElement;
    expect(btn.getAttribute('data-phase')).toBe('idle');

    await act(async () => {
      btn.click();
    });
    await tick();
    await tick();

    expect(retry).toHaveBeenCalledWith('job-X');
    const updated = container.querySelector('[data-testid="retry-button-job-X"]');
    expect(updated?.getAttribute('data-phase')).toBe('done');
    expect(updated?.textContent).toContain('已重投');
  });

  it('retry 失败 → error 状态显示错误文本', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const retry = vi.fn(async () => {
      throw new Error('CONFLICT 409');
    });

    await act(async () => {
      root.render(
        React.createElement(RetryButton, {
          jobId: 'job-Y',
          retry,
        }),
      );
    });
    await tick();

    const btn = container.querySelector('[data-testid="retry-button-job-Y"]') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await tick();
    await tick();

    const updated = container.querySelector('[data-testid="retry-button-job-Y"]');
    expect(updated?.getAttribute('data-phase')).toBe('error');
    const errSpan = container.querySelector('[data-testid="retry-error-job-Y"]');
    expect(errSpan?.textContent).toContain('CONFLICT');
  });
});
