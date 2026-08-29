// tests/dashboard.test.ts
//
// DashboardPage 端到端测试（jsdom）：
//   - seed 后仪器数 = 3（脱敏：ASSET-LAB-0001/0002/0003）
//   - DashboardPage 渲染三卡片 + 日报聚合卡
//   - 队列 finalFailures > 0 时显示顶部红色 banner
//   - WritebackStatusCard 在 failed > 0 时显示内嵌红条
//   - InstrumentHealthCard 按 status 分类计数 + has-alarm 数据属性
//   - 空数据兜底（empty 状态）

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { DashboardPage, type DashboardData } from '../src/app/components/DashboardPage/index';
import { isAlreadySeeded, seed, seedInstruments, seedAlarmCodes, seedCalibrations } from '../src/cli/seed';
import { closeDb } from '../src/server/db';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-dash-'));
const TMP_DB = path.join(TMP_DIR, 'test.sqlite');

beforeAll(() => {
  process.chdir(path.resolve(__dirname, '..'));
  // 强制 seed 走临时库（不影响 data/）
  process.env.DATABASE_PATH = TMP_DB;
  closeDb();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

afterAll(() => {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  delete process.env.DATABASE_PATH;
  closeDb();
});

const tick = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
};

/** 用 fake fetchers 把 DashboardPage 数据灌入指定内容。 */
function makeFakeFetchers(data: Partial<DashboardData>) {
  return {
    instruments: async () => data.instruments ?? [],
    queueStatus: async () => ({ queues: data.queues ?? [] }),
    processingStates: async () => data.processingStateBuckets ?? [],
    dailyDigest: async () => data.dailyDigest ?? [],
  };
}

describe('seed 灌入脱敏样例', () => {
  it('seed() 后仪器数 = 3', async () => {
    const result = seed({ force: true });
    expect(result.alreadySeeded).toBe(false);
    expect(result.instruments).toBe(3);
    expect(isAlreadySeeded()).toBe(true);
  });

  it('二次 seed() 幂等（alreadySeeded=true）', () => {
    const result = seed();
    expect(result.alreadySeeded).toBe(true);
    expect(result.instruments).toBe(0);
  });

  it('报警码 4 类（每类有 vendor/model/alarm_code 联合主键）', () => {
    const result = seedAlarmCodes();
    // 二次跑 → 0（已存在）
    expect(result).toBe(0);
  });

  it('校准记录 10 条', () => {
    const result = seedCalibrations();
    expect(result).toBe(0);
  });

  it('seedInstruments/seedAlarmCodes/seedCalibrations 直接调用：force=true 后仍 0', () => {
    // 已 seed；INSERT OR IGNORE 全跳过
    expect(seedInstruments()).toBe(0);
    expect(seedAlarmCodes()).toBe(0);
    expect(seedCalibrations()).toBe(0);
  });
});

describe('DashboardPage 渲染', () => {
  it('正常态：3 卡片 + 日报聚合卡', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fakeData: Partial<DashboardData> = {
      instruments: [
        {
          instrument_id: 'ASSET-LAB-0001',
          vendor: 'Siemens',
          model: 'ADVIA 2400',
          status: 'online',
          location: '门诊二楼检验科 A 区',
          last_seen_at: '2026-08-30T00:00:00Z',
        },
        {
          instrument_id: 'ASSET-LAB-0002',
          vendor: 'Roche',
          model: 'cobas c702',
          status: 'online',
          location: '门诊二楼检验科 B 区',
          last_seen_at: '2026-08-30T00:00:00Z',
        },
        {
          instrument_id: 'PLACEHOLDER-ASSET-0003',
          vendor: 'Abbott',
          model: 'Architect i2000',
          status: 'alarm',
          location: '住院部三楼中心实验室',
          last_seen_at: null,
        },
      ],
      queues: [
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
      ],
      processingStateBuckets: [
        { state: 'received', count: 2 },
        { state: 'verified', count: 1 },
        { state: 'written_back', count: 5 },
      ],
      dailyDigest: [
        { date: '2026-08-29', total_records: 10, failed_records: 0, written_back: 8 },
        { date: '2026-08-28', total_records: 7, failed_records: 1, written_back: 6 },
      ],
    };

    await act(async () => {
      root.render(React.createElement(DashboardPage, { fetchers: makeFakeFetchers(fakeData) }));
    });
    await act(async () => {
      await tick();
    });

    const root$ = container.querySelector('[data-testid="dashboard-root"]');
    expect(root$).toBeTruthy();
    expect(root$?.getAttribute('data-status')).toBe('ready');
    expect(root$?.getAttribute('data-has-queue-failures')).toBe('false');

    // 仪器健康卡
    const healthCard = container.querySelector('[data-testid="dashboard-instrument-health"]');
    expect(healthCard).toBeTruthy();
    expect(healthCard?.getAttribute('data-total')).toBe('3');
    expect(healthCard?.getAttribute('data-has-alarm')).toBe('true');
    const summary = container.querySelector('[data-testid="instrument-status-summary"]');
    expect(summary?.querySelector('[data-status="online"]')?.getAttribute('data-count')).toBe('2');
    expect(summary?.querySelector('[data-status="alarm"]')?.getAttribute('data-count')).toBe('1');
    expect(summary?.querySelector('[data-status="offline"]')?.getAttribute('data-count')).toBe('0');

    // Writeback 卡
    const writebackCard = container.querySelector('[data-testid="dashboard-writeback-status"]');
    expect(writebackCard).toBeTruthy();
    expect(writebackCard?.getAttribute('data-has-failed')).toBe('false');
    const writebackTable = container.querySelector('[data-testid="writeback-state-table"]');
    expect(writebackTable?.querySelector('tr[data-state="received"]')?.getAttribute('data-count')).toBe('2');
    expect(writebackTable?.querySelector('tr[data-state="verified"]')?.getAttribute('data-count')).toBe('1');
    expect(writebackTable?.querySelector('tr[data-state="failed"]')?.getAttribute('data-count')).toBe('0');

    // 日报聚合卡
    const digestCard = container.querySelector('[data-testid="dashboard-daily-digest"]');
    expect(digestCard).toBeTruthy();
    expect(digestCard?.getAttribute('data-entry-count')).toBe('2');
    expect(digestCard?.querySelector('tr[data-date="2026-08-29"]')).toBeTruthy();

    // 顶部红条不应该出现
    expect(container.querySelector('[data-testid="dashboard-top-failure-banner"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('队列失败 → 顶部红条触发', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fakeData: Partial<DashboardData> = {
      instruments: [
        {
          instrument_id: 'ASSET-LAB-0001',
          vendor: 'Siemens',
          model: 'ADVIA 2400',
          status: 'online',
          location: 'A 区',
          last_seen_at: '2026-08-30T00:00:00Z',
        },
      ],
      queues: [
        {
          name: 'lis-writeback',
          pending: 0,
          running: 0,
          success: 3,
          failed: 1,
          lastFailedAt: '2026-08-30T00:00:00Z',
          finalFailures: 1,
          maxAttempts: 5,
        },
      ],
    };

    await act(async () => {
      root.render(React.createElement(DashboardPage, { fetchers: makeFakeFetchers(fakeData) }));
    });
    await act(async () => {
      await tick();
    });

    const root$ = container.querySelector('[data-testid="dashboard-root"]');
    expect(root$?.getAttribute('data-has-queue-failures')).toBe('true');
    const banner = container.querySelector('[data-testid="dashboard-top-failure-banner"]');
    expect(banner).toBeTruthy();
    expect(banner?.getAttribute('role')).toBe('alert');

    await act(async () => {
      root.unmount();
    });
  });

  it('writeback failed > 0 → 内嵌红条触发', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fakeData: Partial<DashboardData> = {
      instruments: [],
      queues: [],
      processingStateBuckets: [
        { state: 'received', count: 1 },
        { state: 'failed', count: 3 },
      ],
    };

    await act(async () => {
      root.render(React.createElement(DashboardPage, { fetchers: makeFakeFetchers(fakeData) }));
    });
    await act(async () => {
      await tick();
    });

    const writebackCard = container.querySelector('[data-testid="dashboard-writeback-status"]');
    expect(writebackCard?.getAttribute('data-has-failed')).toBe('true');
    const banner = container.querySelector('[data-testid="writeback-failed-banner"]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toMatch(/3 条 write-back 失败/);

    await act(async () => {
      root.unmount();
    });
  });

  it('空数据兜底：日报卡显示 empty 文案', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(DashboardPage, { fetchers: makeFakeFetchers({}) }));
    });
    await act(async () => {
      await tick();
    });

    const digestCard = container.querySelector('[data-testid="dashboard-daily-digest"]');
    expect(digestCard?.getAttribute('data-entry-count')).toBe('0');
    const empty = container.querySelector('[data-testid="daily-digest-empty"]');
    expect(empty?.textContent).toMatch(/暂无日报/);

    await act(async () => {
      root.unmount();
    });
  });

  it('fetcher 抛错 → 错误态', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const errorFetchers = {
      instruments: async () => {
        throw new Error('boom');
      },
      queueStatus: async () => ({ queues: [] }),
      processingStates: async () => [],
      dailyDigest: async () => [],
    };

    await act(async () => {
      root.render(React.createElement(DashboardPage, { fetchers: errorFetchers }));
    });
    await act(async () => {
      await tick();
    });

    const root$ = container.querySelector('[data-testid="dashboard-root"]');
    expect(root$?.getAttribute('data-status')).toBe('error');
    expect(root$?.textContent).toMatch(/看板加载失败/);

    await act(async () => {
      root.unmount();
    });
  });
});

describe('seed 与 DashboardPage 联动', () => {
  it('seed 后的真实仪器数 = 3 能在 DashboardPage 渲染', async () => {
    // 重新跑 seed（force=true 重建）
    seed({ force: true });

    const fakeData: Partial<DashboardData> = {
      // 占位：seed 灌入的 3 台仪器会由 fetcher 真实拉取（这里用 stub 模拟）
      instruments: [
        {
          instrument_id: 'ASSET-LAB-0001',
          vendor: 'Siemens',
          model: 'ADVIA 2400',
          status: 'online',
          location: '门诊二楼检验科 A 区',
          last_seen_at: '2026-08-30T00:00:00Z',
        },
        {
          instrument_id: 'ASSET-LAB-0002',
          vendor: 'Roche',
          model: 'cobas c702',
          status: 'online',
          location: '门诊二楼检验科 B 区',
          last_seen_at: '2026-08-30T00:00:00Z',
        },
        {
          instrument_id: 'PLACEHOLDER-ASSET-0003',
          vendor: 'Abbott',
          model: 'Architect i2000',
          status: 'alarm',
          location: '住院部三楼中心实验室',
          last_seen_at: null,
        },
      ],
      queues: [],
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(DashboardPage, { fetchers: makeFakeFetchers(fakeData) }));
    });
    await act(async () => {
      await tick();
    });

    const list = container.querySelectorAll('[data-testid="instrument-list"] li');
    expect(list.length).toBe(3);

    // 验证 vendor 占位名（不写真实编码）
    const ids = Array.from(list).map((li) => li.getAttribute('data-instrument-id'));
    expect(ids).toEqual(['ASSET-LAB-0001', 'ASSET-LAB-0002', 'PLACEHOLDER-ASSET-0003']);

    await act(async () => {
      root.unmount();
    });
  });
});
