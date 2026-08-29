// src/shared/embeds/descriptors/lis-report.ts
// LIS 报告：以 accession_no 反查报告，只读引用，不回写 LIS 业务库。

import { EmbedDescriptor } from '../types.js';

export const LIS_REPORT_REGEX = /^lis:\/\/reports\/(L\d{8,})\/?$/i;

export const lisReportDescriptor = new EmbedDescriptor({
  name: 'lis-report',
  title: 'LIS 报告',
  kind: 'lis-report',
  regexMatch: [LIS_REPORT_REGEX],
  matchOnInput: true,
  priority: 40,
  componentName: 'LisReportCard',
  keywords: 'LIS 报告 检验 条码 accession',
  placeholder: '粘贴 lis://reports/L… 链接',
  keyGroup: 1,
});

export default lisReportDescriptor;
