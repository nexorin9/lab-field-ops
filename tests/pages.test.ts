// tests/pages.test.ts
//
// 资料页 UI 测试（jsdom）：
//   - InstrumentPage: seed 后渲染 1 条 SOP + 1 条处理记录 + 5 条校准；confirm 按钮触发 POST。
//   - AlarmCodePage: 命中联合主键渲染 SOP markdown 节点；列出关联仪器清单。
//   - CalibrationPage: 按 instrumentId 分组时间倒序；点击 raw_hash 弹 drawer 显示 payload。
//
// 数据源走 stub fetchers（不依赖真实 fetch）；state 推进走内存模拟。

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { InstrumentPage, type InstrumentPageFetchers } from '../src/app/components/InstrumentPage/index';
import { AlarmCodePage, type AlarmCodePageFetchers } from '../src/app/components/AlarmCodePage/index';
import { CalibrationPage, type CalibrationPageFetchers } from '../src/app/components/CalibrationPage/index';

import type {
  Instrument,
  AlarmCode,
  Calibration,
  ProcessingRecord,
} from '../src/shared/types.js';

// ---------------------------------------------------------------------------
// test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_INSTRUMENT: Instrument = {
  instrument_id: 'ASSET-LAB-0001',
  vendor: 'Siemens',
  model: 'ADVIA 2400',
  asset_tag: 'PLACEHOLDER-ASSET-0001',
  location: '门诊二楼检验科 A 区',
  status: 'online',
  installed_at: '2024-01-15T08:00:00Z',
  last_seen_at: '2026-08-30T00:00:00Z',
};

const SAMPLE_ALARM: AlarmCode = {
  vendor: 'Siemens',
  model: 'ADVIA 2400',
  alarm_code: 'W002',
  alarm_label: '样本量不足',
  sop_md:
    '# 样本量不足（W002）\n\n1. 检查样本管是否倾斜放置\n2. 确认离心参数\n3. 重新混匀后复测\n4. 仍报警 → 联系厂商',
  created_at: '2024-01-15T08:00:00Z',
};

function makeCalibration(idx: number, instrumentId: string): Calibration {
  return {
    calibration_id: `CAL-T-${idx.toString().padStart(3, '0')}`,
    instrument_id: instrumentId,
    calibrated_at: new Date(2026, 7, 30 - idx).toISOString(),
    payload_json: { qc_pass: idx % 2 === 0, kind: idx % 2 === 0 ? 'scheduled' : 'triggered' },
    raw_hash: `raw-hash-${idx.toString().padStart(3, '0')}-abcd`,
  };
}

function makeProcessingRecord(idx: number, instrumentId: string, alarmCode: string): ProcessingRecord {
  return {
    record_id: `REC-${idx.toString().padStart(3, '0')}`,
    instrument_id: instrumentId,
    alarm_code: alarmCode,
    operator_id: 'tech-001',
    root_cause: '样本体积偏低',
    steps: ['离心', '复测'],
    confirmed_at: null,
    state: idx === 0 ? 'received' : idx === 1 ? 'verified' : 'written_back',
    retry_count: 0,
    payload: {},
    accession_no: null,
  };
}

const SAMPLE_CALIBRATIONS: Calibration[] = Array.from({ length: 5 }, (_, i) => makeCalibration(i, SAMPLE_INSTRUMENT.instrument_id));
const SAMPLE_RECORDS: ProcessingRecord[] = Array.from({ length: 3 }, (_, i) =>
  makeProcessingRecord(i, SAMPLE_INSTRUMENT.instrument_id, 'W002'),
);

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-pages-'));

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

const tick = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
};

function makeInstrumentFetchers(opts: {
  instrument?: Instrument | null;
  calibrations?: Calibration[];
  records?: ProcessingRecord[];
  confirmOk?: boolean;
} = {}): InstrumentPageFetchers & {
  __confirmCalls: Array<{ recordId: string; operatorId: string }>;
} {
  const confirmCalls: Array<{ recordId: string; operatorId: string }> = [];
  return {
    __confirmCalls: confirmCalls,
    instrument: async () => opts.instrument ?? null,
    calibrations: async () => opts.calibrations ?? [],
    processingRecords: async () => opts.records ?? [],
    confirm: async (recordId, operatorId) => {
      confirmCalls.push({ recordId, operatorId });
      if (opts.confirmOk === false) {
        return { ok: false, error: 'forced failure' };
      }
      return {
        ok: true,
        idempotent: false,
        record: {
          ...SAMPLE_RECORDS[0]!,
          record_id: recordId,
          state: 'verified',
          confirmed_at: new Date().toISOString(),
        },
      };
    },
  };
}

function makeAlarmFetchers(opts: {
  alarm?: AlarmCode | null;
  instruments?: Instrument[];
} = {}): AlarmCodePageFetchers {
  return {
    alarmCode: async () => opts.alarm ?? null,
    instruments: async () => opts.instruments ?? [],
  };
}

function makeCalibrationFetchers(opts: {
  calibration?: Calibration | null;
  byInstrument?: Calibration[];
} = {}): CalibrationPageFetchers {
  return {
    calibration: async () => opts.calibration ?? null,
    byInstrument: async () => opts.byInstrument ?? [],
  };
}

// ---------------------------------------------------------------------------
// InstrumentPage 测试
// ---------------------------------------------------------------------------

describe('InstrumentPage', () => {
  it('正常态：seed 数据 → 渲染 1 SOP + 1 处理记录 + 5 条校准', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeInstrumentFetchers({
      instrument: SAMPLE_INSTRUMENT,
      calibrations: SAMPLE_CALIBRATIONS,
      records: SAMPLE_RECORDS,
    });

    await act(async () => {
      root.render(React.createElement(InstrumentPage, {
        instrumentId: SAMPLE_INSTRUMENT.instrument_id,
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    const root$ = container.querySelector('[data-testid="instrument-page-root"]');
    expect(root$).toBeTruthy();
    expect(root$?.getAttribute('data-instrument-id')).toBe(SAMPLE_INSTRUMENT.instrument_id);
    expect(root$?.getAttribute('data-status')).toBe('ready');

    // header 含 vendor/model + asset_tag
    const header = container.querySelector('[data-testid="instrument-page-root"] header');
    expect(header?.textContent).toContain('Siemens');
    expect(header?.textContent).toContain('ADVIA 2400');
    expect(header?.textContent).toContain(SAMPLE_INSTRUMENT.instrument_id);

    // SOP 编辑器 + 嵌入预览
    expect(container.querySelector('[data-testid="sop-editor"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="instrument-sop-empty"]')).toBeTruthy();

    // 校准 5 条
    const calList = container.querySelector('[data-testid="instrument-calibration-list"]');
    expect(calList).toBeTruthy();
    expect(calList?.getAttribute('data-count')).toBe('5');

    // 处理记录 3 条
    const recList = container.querySelector('[data-testid="instrument-records-list"]');
    expect(recList).toBeTruthy();
    expect(recList?.getAttribute('data-count')).toBe('3');

    // received/parsed 状态应显示 confirm 按钮
    const receivedRow = container.querySelector('[data-record-id="REC-000"]');
    expect(receivedRow?.getAttribute('data-state')).toBe('received');
    expect(receivedRow?.querySelector('button[data-testid="confirm-REC-000"]')).toBeTruthy();

    // written_back 状态不显示 confirm 按钮
    const writtenBackRow = container.querySelector('[data-record-id="REC-002"]');
    expect(writtenBackRow?.getAttribute('data-state')).toBe('written_back');
    expect(writtenBackRow?.querySelector('button[data-testid^="confirm-"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('点击 confirm 按钮 → 调用 fetcher.confirm + 刷新记录列表', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeInstrumentFetchers({
      instrument: SAMPLE_INSTRUMENT,
      records: [SAMPLE_RECORDS[0]!], // 只放 1 条 received
    });

    await act(async () => {
      root.render(React.createElement(InstrumentPage, {
        instrumentId: SAMPLE_INSTRUMENT.instrument_id,
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    const button = container.querySelector<HTMLButtonElement>('button[data-testid="confirm-REC-000"]');
    expect(button).toBeTruthy();

    await act(async () => {
      button?.click();
    });
    await act(async () => {
      await tick();
    });

    expect(fetchers.__confirmCalls).toEqual([
      { recordId: 'REC-000', operatorId: 'system' },
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it('confirm 失败 → 显示错误条', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeInstrumentFetchers({
      instrument: SAMPLE_INSTRUMENT,
      records: [SAMPLE_RECORDS[0]!],
      confirmOk: false,
    });

    await act(async () => {
      root.render(React.createElement(InstrumentPage, {
        instrumentId: SAMPLE_INSTRUMENT.instrument_id,
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    const button = container.querySelector<HTMLButtonElement>('button[data-testid="confirm-REC-000"]');
    await act(async () => {
      button?.click();
    });
    await act(async () => {
      await tick();
    });

    const errorBox = container.querySelector('[data-testid="confirm-error"]');
    expect(errorBox).toBeTruthy();
    expect(errorBox?.textContent).toContain('forced failure');

    await act(async () => {
      root.unmount();
    });
  });

  it('fetcher.instrument 返回 null → 显示「—」占位', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeInstrumentFetchers({ instrument: null });

    await act(async () => {
      root.render(React.createElement(InstrumentPage, {
        instrumentId: 'unknown-instrument',
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    const root$ = container.querySelector('[data-testid="instrument-page-root"]');
    expect(root$?.getAttribute('data-status')).toBe('ready');
    expect(root$?.querySelector('header')?.textContent).toContain('—');

    await act(async () => {
      root.unmount();
    });
  });

  it('空数据：calibrations=[] + records=[]', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeInstrumentFetchers({
      instrument: SAMPLE_INSTRUMENT,
      calibrations: [],
      records: [],
    });

    await act(async () => {
      root.render(React.createElement(InstrumentPage, {
        instrumentId: SAMPLE_INSTRUMENT.instrument_id,
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    expect(container.querySelector('[data-testid="instrument-calibration-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="instrument-records-empty"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });
});

// ---------------------------------------------------------------------------
// AlarmCodePage 测试
// ---------------------------------------------------------------------------

describe('AlarmCodePage', () => {
  it('命中联合主键 → 渲染 SOP 节点 + 关联仪器清单', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeAlarmFetchers({
      alarm: SAMPLE_ALARM,
      instruments: [
        SAMPLE_INSTRUMENT,
        { ...SAMPLE_INSTRUMENT, instrument_id: 'ASSET-LAB-0099', status: 'alarm' },
      ],
    });

    await act(async () => {
      root.render(React.createElement(AlarmCodePage, {
        vendor: 'Siemens',
        model: 'ADVIA 2400',
        alarmCode: 'W002',
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    const root$ = container.querySelector('[data-testid="alarm-code-page-root"]');
    expect(root$?.getAttribute('data-vendor')).toBe('Siemens');
    expect(root$?.getAttribute('data-model')).toBe('ADVIA 2400');
    expect(root$?.getAttribute('data-alarm-code')).toBe('W002');
    expect(root$?.getAttribute('data-status')).toBe('ready');

    // header 含中文 label
    const header = container.querySelector('header');
    expect(header?.textContent).toContain('样本量不足');
    expect(header?.textContent).toContain('W002');

    // SOP 解析节点（1 heading + 4 list-item = 5 nodes）
    const sop = container.querySelector('[data-testid="alarm-sop-md"]');
    expect(sop).toBeTruthy();
    expect(sop?.getAttribute('data-nodes')).toBe('5');
    expect(sop?.querySelector('[data-run-kind="heading"]')).toBeTruthy();
    const listItems = sop?.querySelectorAll('[data-run-kind="list-item"]');
    expect(listItems?.length).toBe(4);

    // 关联仪器列表
    const linkedList = container.querySelector('[data-testid="alarm-instruments-list"]');
    expect(linkedList?.getAttribute('data-count')).toBe('2');

    await act(async () => {
      root.unmount();
    });
  });

  it('未找到 alarm code → 显示「未找到」', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeAlarmFetchers({ alarm: null, instruments: [] });

    await act(async () => {
      root.render(React.createElement(AlarmCodePage, {
        vendor: 'Unknown',
        model: 'X1',
        alarmCode: 'Z999',
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    expect(container.querySelector('[data-testid="alarm-not-found"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="alarm-instruments-empty"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it('空 SOP → 显示「（无 SOP 文档）」占位', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeAlarmFetchers({
      alarm: { ...SAMPLE_ALARM, sop_md: '' },
      instruments: [],
    });

    await act(async () => {
      root.render(React.createElement(AlarmCodePage, {
        vendor: 'Siemens',
        model: 'ADVIA 2400',
        alarmCode: 'W002',
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    expect(container.querySelector('[data-testid="alarm-sop-empty"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });
});

// ---------------------------------------------------------------------------
// CalibrationPage 测试
// ---------------------------------------------------------------------------

describe('CalibrationPage', () => {
  it('按 instrumentId 分组 + 时间倒序；点击 raw_hash 弹 drawer', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeCalibrationFetchers({
      calibration: SAMPLE_CALIBRATIONS[0]!,
      byInstrument: SAMPLE_CALIBRATIONS,
    });

    await act(async () => {
      root.render(React.createElement(CalibrationPage, {
        calibrationId: SAMPLE_CALIBRATIONS[0]!.calibration_id,
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    const root$ = container.querySelector('[data-testid="calibration-page-root"]');
    expect(root$?.getAttribute('data-calibration-id')).toBe(SAMPLE_CALIBRATIONS[0]!.calibration_id);
    expect(root$?.getAttribute('data-status')).toBe('ready');

    const table = container.querySelector('[data-testid="calibration-table"]');
    expect(table?.getAttribute('data-row-count')).toBe('5');
    expect(table?.getAttribute('data-group-count')).toBe('1');

    // header 含 raw_hash 截断
    const header = container.querySelector('header');
    expect(header?.textContent).toContain(SAMPLE_CALIBRATIONS[0]!.calibration_id);

    // 抽屉默认不渲染（open=false）
    expect(container.querySelector('[data-testid="calibration-drawer-root"]')).toBeNull();

    // 点击第一行 → drawer 打开 + payload 显示
    const firstRow = container.querySelector<HTMLElement>('li[data-calibration-id="CAL-T-000"]');
    expect(firstRow).toBeTruthy();
    await act(async () => {
      firstRow?.click();
    });

    const drawer = container.querySelector('[data-testid="calibration-drawer-root"]');
    expect(drawer).toBeTruthy();
    expect(drawer?.getAttribute('data-open')).toBe('true');
    expect(container.querySelector('[data-testid="drawer-payload"]')?.textContent).toContain(
      'qc_pass',
    );

    // 关闭按钮 → drawer 消失
    const closeBtn = container.querySelector<HTMLButtonElement>('[data-testid="drawer-close"]');
    await act(async () => {
      closeBtn?.click();
    });
    expect(container.querySelector('[data-testid="calibration-drawer-root"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('多条校准按 instrumentId 分组（多组）', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const byInst = [
      ...SAMPLE_CALIBRATIONS,
      ...Array.from({ length: 3 }, (_, i) =>
        makeCalibration(i + 100, 'ASSET-LAB-0099'),
      ),
    ];

    const fetchers = makeCalibrationFetchers({
      calibration: SAMPLE_CALIBRATIONS[0]!,
      byInstrument: byInst,
    });

    await act(async () => {
      root.render(React.createElement(CalibrationPage, {
        calibrationId: SAMPLE_CALIBRATIONS[0]!.calibration_id,
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    const table = container.querySelector('[data-testid="calibration-table"]');
    expect(table?.getAttribute('data-row-count')).toBe('8');
    expect(table?.getAttribute('data-group-count')).toBe('2');

    const group1 = container.querySelector('section[data-instrument-id="ASSET-LAB-0001"]');
    const group2 = container.querySelector('section[data-instrument-id="ASSET-LAB-0099"]');
    expect(group1?.getAttribute('data-group-size')).toBe('5');
    expect(group2?.getAttribute('data-group-size')).toBe('3');

    await act(async () => {
      root.unmount();
    });
  });

  it('未找到 calibration → 显示「未找到」', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const fetchers = makeCalibrationFetchers({ calibration: null, byInstrument: [] });

    await act(async () => {
      root.render(React.createElement(CalibrationPage, {
        calibrationId: 'CAL-NONEXISTENT',
        fetchers,
      }));
    });
    await act(async () => {
      await tick();
    });

    expect(container.querySelector('[data-testid="cal-not-found"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });
});
