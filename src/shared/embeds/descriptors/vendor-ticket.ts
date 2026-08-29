// src/shared/embeds/descriptors/vendor-ticket.ts
// 厂商工单 URL：工程师在 SOP 里粘贴厂商售后工单链接，渲染为「工单卡」。

import { EmbedDescriptor } from '../types.js';

export const VENDOR_TICKET_REGEX =
  /^https?:\/\/(?:[a-z0-9-]+\.)?(?:vendor[.-]example\.com|svc\.vendor\.com)\/ticket\/(T-[A-Z0-9]+)\/?$/i;

export const vendorTicketDescriptor = new EmbedDescriptor({
  name: 'vendor-ticket',
  title: '厂商工单',
  kind: 'vendor-ticket',
  regexMatch: [VENDOR_TICKET_REGEX],
  matchOnInput: true,
  priority: 30,
  componentName: 'VendorTicketCard',
  keywords: '工单 售后 报修 厂商',
  placeholder: '粘贴厂商工单链接',
  keyGroup: 1,
});

export default vendorTicketDescriptor;
