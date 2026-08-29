// src/app/components/EmbedCard/index.tsx
// 按 EmbedDescriptor.componentName 路由到对应业务卡片的「入口」组件。
//
// 主路径：EmbedCard({descriptor, url, status, data, error})
//   → switch (descriptor.componentName)
//     case 'VendorTicketCard' → <div className="embed-card--vendor-ticket" ...>...</div>
//     case 'LisReportCard'     → <div className="embed-card--lis-report" ...>...</div>
//     case 'CalibrationCard'   → <div className="embed-card--calibration-record" ...>...</div>
//     case 'ManualCard'        → <div className="embed-card--instrument-manual" ...>...</div>
//     default                  → <div className="embed-card--unknown" ...>...</div>
//
// 与 outline `EmbedDescriptor.component` 一致：每个 descriptor 携带组件名，
// 由 renderer 通过名字路由。
//
// 返回叶子 <div>（不包装额外组件），便于测试断言 data-* 属性。

import * as React from 'react';
import type { EmbedDescriptor } from '../../../shared/embeds/types.js';
import { FallbackEmbed } from '../../../shared/embeds/fallback.js';

export interface EmbedCardProps {
  descriptor: EmbedDescriptor;
  url: string;
  /** 加载态：pending → ok | error。 */
  status: 'idle' | 'pending' | 'ok' | 'error';
  /** 各 adapter 的返回 data，结构不固定。 */
  data?: unknown;
  error?: { message: string; code?: string };
  /** 由 renderer 抽出的业务主键（工单号 / accession_no 等）。 */
  key?: string | null;
  children?: React.ReactNode;
}

/** VendorTicketCard —— 厂商工单卡（标题/状态/负责人/最近更新）。 */
function renderVendorTicketCard(
  url: string,
  status: EmbedCardProps['status'],
  data: any,
  error?: EmbedCardProps['error']
): React.ReactElement {
  return React.createElement(
    'div',
    {
      className: 'embed-card embed-card--vendor-ticket',
      'data-embed-name': 'vendor-ticket',
      'data-status': status,
    },
    [
      React.createElement(
        'h4',
        { key: 't' },
        `厂商工单 ${data?.ticketId ?? ''}`
      ),
      React.createElement(
        'div',
        { key: 'body' },
        error
          ? `⚠ 抓取失败：${error.message}`
          : `${data?.title ?? '（无标题）'} · 状态：${data?.status ?? '-'} · 负责人：${data?.owner ?? '-'} · 更新：${data?.updatedAt ?? '-'}`
      ),
      React.createElement(
        'a',
        { key: 'open', href: url, target: '_blank', rel: 'noopener noreferrer' },
        '在工单系统中打开'
      ),
    ]
  );
}

/** LisReportCard —— LIS 报告卡（只读反查）。 */
function renderLisReportCard(
  url: string,
  status: EmbedCardProps['status'],
  data: any,
  error?: EmbedCardProps['error']
): React.ReactElement {
  const items: Array<{ code: string; name: string; value: string; unit?: string }> =
    Array.isArray(data?.testItems) ? data.testItems : [];
  return React.createElement(
    'div',
    {
      className: 'embed-card embed-card--lis-report',
      'data-embed-name': 'lis-report',
      'data-status': status,
    },
    [
      React.createElement('h4', { key: 't' }, `LIS 报告 ${data?.accessionNo ?? ''}`),
      error
        ? React.createElement('div', { key: 'body' }, `⚠ 反查失败：${error.message}`)
        : React.createElement(
            'div',
            { key: 'body' },
            `患者：${data?.patientId ?? '-'} · 标本：${data?.specimenType ?? '-'} · 报告时间：${data?.reportedAt ?? '-'}`
          ),
      items.length > 0
        ? React.createElement(
            'ul',
            { key: 'items' },
            items.map((it, i) =>
              React.createElement(
                'li',
                { key: i },
                `${it.name}（${it.code}）：${it.value}${it.unit ?? ''}`
              )
            )
          )
        : null,
      React.createElement(
        'a',
        { key: 'open', href: url, target: '_blank', rel: 'noopener noreferrer' },
        '在 LIS 中打开'
      ),
    ]
  );
}

/** CalibrationCard —— 校准记录卡（时间 + raw_hash）。 */
function renderCalibrationCard(
  url: string,
  status: EmbedCardProps['status'],
  data: any,
  error?: EmbedCardProps['error']
): React.ReactElement {
  return React.createElement(
    'div',
    {
      className: 'embed-card embed-card--calibration-record',
      'data-embed-name': 'calibration-record',
      'data-status': status,
    },
    [
      React.createElement('h4', { key: 't' }, `校准记录 ${data?.calibrationId ?? ''}`),
      error
        ? React.createElement('div', { key: 'body' }, `⚠ 加载失败：${error.message}`)
        : React.createElement(
            'div',
            { key: 'body' },
            `校准时间：${data?.calibratedAt ?? '-'} · raw_hash：${data?.rawHash ?? '-'} · 来源：${url}`
          ),
    ]
  );
}

/** ManualCard —— 仪器手册 PDF（文件名 + 打开按钮）。 */
function renderManualCard(
  url: string,
  status: EmbedCardProps['status'],
  data: any,
  error?: EmbedCardProps['error']
): React.ReactElement {
  return React.createElement(
    'div',
    {
      className: 'embed-card embed-card--instrument-manual',
      'data-embed-name': 'instrument-manual',
      'data-status': status,
    },
    [
      React.createElement(
        'h4',
        { key: 't' },
        `仪器手册 ${data?.fileName ?? url.split('/').pop() ?? ''}`
      ),
      error
        ? React.createElement('div', { key: 'body' }, `⚠ 加载失败：${error.message}`)
        : React.createElement(
            'div',
            { key: 'body' },
            `PDF 文档（${data?.sizeKb ? `${data.sizeKb} KB` : '大小未填'}）`
          ),
      React.createElement(
        'a',
        { key: 'open', href: url, target: '_blank', rel: 'noopener noreferrer' },
        '在新窗口打开 PDF'
      ),
    ]
  );
}

function renderUnknownEmbedCard(
  descriptor: EmbedDescriptor,
  url: string,
  error?: EmbedCardProps['error']
): React.ReactElement {
  return React.createElement(
    'div',
    {
      className: 'embed-card embed-card--unknown',
      'data-embed-name': descriptor.componentName,
    },
    [
      React.createElement(
        'h4',
        { key: 't' },
        `${descriptor.title}（组件待实现）`
      ),
      React.createElement(
        'div',
        { key: 'body' },
        error?.message ?? `未注册的 componentName：${descriptor.componentName}`
      ),
      React.createElement(
        'a',
        { key: 'open', href: url, target: '_blank', rel: 'noopener noreferrer' },
        '打开链接'
      ),
    ]
  );
}

/** 入口组件：按 descriptor.componentName 路由，返回叶子 <div>。 */
export function EmbedCard(props: EmbedCardProps): React.ReactElement {
  const { descriptor, url, status, data, error } = props;
  switch (descriptor.componentName) {
    case 'VendorTicketCard':
      return renderVendorTicketCard(url, status, data, error);
    case 'LisReportCard':
      return renderLisReportCard(url, status, data, error);
    case 'CalibrationCard':
      return renderCalibrationCard(url, status, data, error);
    case 'ManualCard':
      return renderManualCard(url, status, data, error);
    default:
      return renderUnknownEmbedCard(descriptor, url, error);
  }
}

/** 同步渲染入口：descriptor + url → 对应卡片（status=idle 时显示加载占位）。 */
export function EmbedCardSync({
  descriptor,
  url,
  data,
  error,
}: EmbedCardProps): React.ReactElement {
  return React.createElement(EmbedCard, {
    descriptor,
    url,
    data,
    error,
    status: error ? 'error' : data ? 'ok' : 'idle',
  });
}

/** 当 renderer 决定走 fallback 时也走同一文件出口（语义内聚）。 */
export { FallbackEmbed };

export default EmbedCard;
