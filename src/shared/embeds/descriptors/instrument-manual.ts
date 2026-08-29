// src/shared/embeds/descriptors/instrument-manual.ts
// 仪器手册 PDF：厂商文档站的 PDF 链接，卡片显示文件名 + 打开按钮。

import { EmbedDescriptor } from '../types.js';

export const INSTRUMENT_MANUAL_REGEX =
  /^https?:\/\/docs\.vendor\.com\/(.+)\.pdf$/i;

export const instrumentManualDescriptor = new EmbedDescriptor({
  name: 'instrument-manual',
  title: '仪器手册',
  kind: 'instrument-manual',
  regexMatch: [INSTRUMENT_MANUAL_REGEX],
  matchOnInput: true,
  priority: 10,
  componentName: 'ManualCard',
  keywords: '手册 说明书 维护 文档 PDF',
  placeholder: '粘贴仪器手册 PDF 链接',
  keyGroup: 1,
});

export default instrumentManualDescriptor;
