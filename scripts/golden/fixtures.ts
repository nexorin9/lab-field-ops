// scripts/golden/fixtures.ts
//
// golden 对照测试共用的脱敏样例数据集。
//
// 与 src/cli/seed.ts 的差异：
//   - seed.ts 灌进 SQLite，供 demo / e2e 使用，可能随业务演进增删；
//   - 本文件是「锁字段命名」的固定输入，改动会直接让 golden 对照失败，
//     从而暴露 ⌘K 命中结果 / 队列状态字段的意外漂移。
//
// 数据全部为占位：vendor 用公开厂牌名，assetTag 用 ASSET-LAB-{4 位} 形式，
// 与真实院内资产编码隔离。

import type {
  InstrumentRow,
  AlarmCodeRow,
  CalibrationRow,
} from '../../src/app/kbar/registry.js';
import type {
  PluginCardRow,
  ManualEntryRow,
} from '../../src/app/kbar/multiIndex.js';

export const GOLDEN_INSTRUMENTS: InstrumentRow[] = [
  {
    instrument_id: 'ASSET-LAB-0142',
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    asset_tag: 'ASSET-LAB-0142',
    location: '门诊二楼检验科 A 区',
  },
  {
    instrument_id: 'ASSET-LAB-0201',
    vendor: 'Roche',
    model: 'cobas c701',
    asset_tag: 'ASSET-LAB-0201',
    location: '住院部三楼生化区',
  },
  {
    instrument_id: 'ASSET-LAB-0307',
    vendor: 'Abbott',
    model: 'Alinity ci',
    asset_tag: 'ASSET-LAB-0307',
    location: '急诊检验组',
  },
];

export const GOLDEN_ALARM_CODES: AlarmCodeRow[] = [
  {
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    alarm_code: 'W002',
    alarm_label: '样本针堵塞',
  },
  {
    vendor: 'Roche',
    model: 'cobas c701',
    alarm_code: 'E145',
    alarm_label: '试剂仓温度异常',
  },
];

export const GOLDEN_CALIBRATIONS: CalibrationRow[] = [
  {
    calibration_id: 'C20240117001',
    instrument_id: 'ASSET-LAB-0142',
    calibrated_at: '2024-01-17T08:20:00.000Z',
  },
  {
    calibration_id: 'C20240117002',
    instrument_id: 'ASSET-LAB-0201',
    calibrated_at: '2024-01-17T09:05:00.000Z',
  },
];

export const GOLDEN_PLUGIN_CARDS: PluginCardRow[] = [
  {
    plugin_name: 'lis-writeback',
    description: '处理记录确认后回写 LIS 通道',
  },
];

export const GOLDEN_MANUALS: ManualEntryRow[] = [
  {
    manual_id: 'MAN-ADVIA-2400',
    title: 'ADVIA 2400 维护手册',
    vendor: 'Siemens',
    model: 'ADVIA 2400',
  },
];

/** buildMultiIndex 的完整输入（五类对象齐全）。 */
export const GOLDEN_INDEX_INPUT = {
  instruments: GOLDEN_INSTRUMENTS,
  alarmCodes: GOLDEN_ALARM_CODES,
  calibrations: GOLDEN_CALIBRATIONS,
  pluginCards: GOLDEN_PLUGIN_CARDS,
  manuals: GOLDEN_MANUALS,
};
