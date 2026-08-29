// src/shared/embeds/registry.ts
// 默认注册表装配：4 类内置描述子按 priority 生效。
// 运行时新增一类描述子只需 registerEmbed(new EmbedDescriptor({...}))，无需改本文件。

import { DefaultEmbedRegistry, registerEmbed } from './index.js';
import type { EmbedDescriptor } from './types.js';
import vendorTicketDescriptor from './descriptors/vendor-ticket.js';
import lisReportDescriptor from './descriptors/lis-report.js';
import calibrationRecordDescriptor from './descriptors/calibration-record.js';
import instrumentManualDescriptor from './descriptors/instrument-manual.js';

/** 内置 4 类描述子，注册顺序即同 priority 时的先后顺序。 */
export const builtinDescriptors: EmbedDescriptor[] = [
  lisReportDescriptor, // priority 40
  vendorTicketDescriptor, // priority 30
  calibrationRecordDescriptor, // priority 20
  instrumentManualDescriptor, // priority 10
];

/** 幂等装配：重复调用不会产生重复项（同名覆盖）。 */
export function installBuiltinDescriptors(): typeof DefaultEmbedRegistry {
  for (const descriptor of builtinDescriptors) {
    registerEmbed(descriptor, DefaultEmbedRegistry);
  }
  return DefaultEmbedRegistry;
}

installBuiltinDescriptors();

export default DefaultEmbedRegistry;
