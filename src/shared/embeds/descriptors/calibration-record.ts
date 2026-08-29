// src/shared/embeds/descriptors/calibration-record.ts
// 校准记录 JSON：引用某次校准的原始 payload，卡片显示校准时间与 raw_hash。

import { EmbedDescriptor } from '../types.js';

export const CALIBRATION_RECORD_REGEX =
  /^cal:\/\/calibrations\/(C\d{8,})\.json$/i;

export const calibrationRecordDescriptor = new EmbedDescriptor({
  name: 'calibration-record',
  title: '校准记录',
  kind: 'calibration-record',
  regexMatch: [CALIBRATION_RECORD_REGEX],
  matchOnInput: true,
  priority: 20,
  componentName: 'CalibrationCard',
  keywords: '校准 定标 质控 记录',
  placeholder: '粘贴 cal://calibrations/C….json 链接',
  keyGroup: 1,
});

export default calibrationRecordDescriptor;
