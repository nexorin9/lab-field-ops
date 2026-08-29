// tests/sopEditor.test.ts
// SOP 编辑器粘贴 → 嵌入卡 + 未匹配兜底：
//   1. 粘贴命中描述子的 URL → 文案含 `{{embed:name url}}` 标记；
//   2. 粘贴未匹配 URL → 文案仅含原文 URL + 占位（不报错、不删除）；
//   3. 粘贴混合（命中 + 未匹配）→ 两者并存；
//   4. scanDocument 把标记反解为 run 流；
//   5. 渲染层对未匹配走 fallback（原文链接 + 截图占位）。
//
// 主路径在 src/shared/embeds/renderer.tsx 与 src/shared/embeds/fallback.tsx，
// 与 outline `Editor.renderer` 的 paste handler 形态对齐。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractUrls,
  applyPaste,
  scanDocument,
  renderEmbed,
} from '../src/shared/embeds/renderer.js';
import { renderEmbedFallback } from '../src/shared/embeds/fallback.js';
import { EmbedCard } from '../src/app/components/EmbedCard/index.js';
import {
  DefaultEmbedRegistry,
  getEmbedByName,
  EmbedDescriptor,
  registerEmbed,
} from '../src/shared/embeds/index.js';
import {
  installBuiltinDescriptors,
} from '../src/shared/embeds/registry.js';
import {
  fetchVendorTicket,
} from '../src/shared/embeds/adapters/vendor-ticket-adapter.js';
import {
  fetchLisReport,
} from '../src/shared/embeds/adapters/lis-report-adapter.js';

beforeEach(() => {
  DefaultEmbedRegistry.clear();
  installBuiltinDescriptors();
});

describe('extractUrls', () => {
  it('从纯文本里抽出 http/https/lis/cal URL', () => {
    const text =
      '工单 https://vendor.example.com/ticket/T-ABC123 还有这个 lis://reports/L20240117001 校准 cal://calibrations/C20240117.json 收尾。';
    const urls = extractUrls(text);
    expect(urls).toEqual([
      'https://vendor.example.com/ticket/T-ABC123',
      'lis://reports/L20240117001',
      'cal://calibrations/C20240117.json',
    ]);
  });

  it('去掉 URL 末尾的中英文标点', () => {
    const text = '看这里 https://docs.vendor.com/manual.pdf。还有这一句。';
    const urls = extractUrls(text);
    expect(urls).toEqual(['https://docs.vendor.com/manual.pdf']);
  });

  it('空文本返回空数组', () => {
    expect(extractUrls('')).toEqual([]);
  });
});

describe('applyPaste — 命中描述子', () => {
  it('粘贴单个工单 URL → 文案含 `{{embed:vendor-ticket url}}`', () => {
    const result = applyPaste({
      currentDoc: '故障现场：',
      pasteText: 'https://vendor.example.com/ticket/T-ABC123',
      caret: 5,
    });
    expect(result.insertedEmbeds).toHaveLength(1);
    expect(result.insertedEmbeds[0].name).toBe('vendor-ticket');
    expect(result.insertedEmbeds[0].url).toBe(
      'https://vendor.example.com/ticket/T-ABC123'
    );
    expect(result.insertedPlainUrls).toEqual([]);
    expect(result.nextDoc).toContain(
      '{{embed:vendor-ticket https://vendor.example.com/ticket/T-ABC123}}'
    );
    // 原始 URL 在文档中以「标记」形式存在（不再以裸 URL 形式重复出现）
    expect(result.nextDoc.match(/\{\{embed:vendor-ticket/g)).toHaveLength(1);
  });

  it('粘贴 lis://reports/L... → 文案含 `{{embed:lis-report …}}`', () => {
    const result = applyPaste({
      currentDoc: '',
      pasteText: 'lis://reports/L20240117001',
      caret: 0,
    });
    expect(result.insertedEmbeds[0].name).toBe('lis-report');
    expect(result.nextDoc).toContain('{{embed:lis-report lis://reports/L20240117001}}');
  });

  it('粘贴多个不同 URL 全部走 embed 标记', () => {
    const pasteText =
      'lis://reports/L20240117001\ncal://calibrations/C20240117.json';
    const result = applyPaste({
      currentDoc: '',
      pasteText,
      caret: 0,
    });
    expect(result.insertedEmbeds.map((e) => e.name)).toEqual([
      'lis-report',
      'calibration-record',
    ]);
    expect(result.insertedPlainUrls).toEqual([]);
  });
});

describe('applyPaste — 未匹配 URL 走兜底', () => {
  it('粘贴未匹配的 https URL → 仅保留原文，不报错', () => {
    const result = applyPaste({
      currentDoc: '参考资料：',
      pasteText: 'https://www.example.com/some-private-page',
      caret: 5,
    });
    expect(result.insertedEmbeds).toEqual([]);
    expect(result.insertedPlainUrls).toEqual([
      'https://www.example.com/some-private-page',
    ]);
    // 不应出现 embed 标记
    expect(result.nextDoc).not.toContain('{{embed:');
    // 原文 URL 仍存在
    expect(result.nextDoc).toContain('https://www.example.com/some-private-page');
  });

  it('粘贴匹配 + 未匹配混合 → 各自走对应通道', () => {
    const result = applyPaste({
      currentDoc: '',
      pasteText:
        '先看工单 https://vendor.example.com/ticket/T-ABC123 ，再参考 https://www.example.com/manual.pdf',
      caret: 0,
    });
    expect(result.insertedEmbeds).toHaveLength(1);
    expect(result.insertedEmbeds[0].name).toBe('vendor-ticket');
    expect(result.insertedPlainUrls).toEqual([
      'https://www.example.com/manual.pdf',
    ]);
    expect(result.nextDoc).toContain(
      '{{embed:vendor-ticket https://vendor.example.com/ticket/T-ABC123}}'
    );
    expect(result.nextDoc).toContain('https://www.example.com/manual.pdf');
    // 只有 vendor-ticket 一个 embed 标记
    const matches = result.nextDoc.match(/\{\{embed:/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('粘贴纯文字（无 URL）→ 文本原样插入', () => {
    const result = applyPaste({
      currentDoc: '头部\n',
      pasteText: '报警现象：试剂仓温度异常',
      caret: 3,
    });
    expect(result.insertedEmbeds).toEqual([]);
    expect(result.insertedPlainUrls).toEqual([]);
    expect(result.nextDoc).toBe('头部\n报警现象：试剂仓温度异常');
  });

  it('粘贴空串 → 文档不变', () => {
    const result = applyPaste({ currentDoc: '不动', pasteText: '', caret: 1 });
    expect(result.nextDoc).toBe('不动');
    expect(result.insertedEmbeds).toEqual([]);
  });
});

describe('applyPaste — caret / 选区', () => {
  it('caret 在文档中间时插入到正确位置', () => {
    const result = applyPaste({
      currentDoc: '前缀 后缀',
      pasteText: 'https://vendor.example.com/ticket/T-ABC123',
      caret: 2,
    });
    // before='前缀', after=' 后缀' → 文档 = '前缀{{embed:…}} 后缀'（' ' 在 after 里）
    expect(result.nextDoc).toBe(
      '前缀{{embed:vendor-ticket https://vendor.example.com/ticket/T-ABC123}} 后缀'
    );
  });

  it('nextCaret 落在插入内容末尾', () => {
    const result = applyPaste({
      currentDoc: 'AB',
      pasteText: 'https://vendor.example.com/ticket/T-XY99',
      caret: 2,
    });
    expect(result.nextCaret).toBe(result.nextDoc.length);
  });

  it('选区替换：caret 与 selectionEnd 不同 → 选区被覆盖', () => {
    const result = applyPaste({
      currentDoc: 'ABCDE',
      pasteText: 'https://vendor.example.com/ticket/T-XY99',
      caret: 1,
      selectionEnd: 3, // 选区覆盖「BC」
    });
    expect(result.nextDoc.startsWith('A{{embed:vendor-ticket')).toBe(true);
    expect(result.nextDoc.endsWith('DE')).toBe(true);
    // nextCaret = before.length + inserted.length（after 不计）
    // nextDoc.length = nextCaret + after.length
    const afterLen = 'DE'.length;
    expect(result.nextDoc.length).toBe(result.nextCaret + afterLen);
    // 选区长度是 2（'BC'），覆盖后文档长 = 1（before）+ 嵌入 + 2（after）
    expect(result.nextDoc.length).toBeLessThan('ABCDE'.length + result.nextCaret);
  });
});

describe('scanDocument — 反解为 run 流', () => {
  it('把标记文档解析为 plain run + embed run', () => {
    const doc =
      '故障：试剂仓温度异常\n' +
      '相关工单：{{embed:vendor-ticket https://vendor.example.com/ticket/T-ABC123}}\n' +
      '参考报告：{{embed:lis-report lis://reports/L20240117001}}';
    const runs = scanDocument(doc);
    expect(runs).toHaveLength(5);
    expect(runs[0]).toMatchObject({ kind: 'plain', text: '故障：试剂仓温度异常\n相关工单：' });
    expect(runs[1]).toMatchObject({
      kind: 'embed',
      name: 'vendor-ticket',
      matched: true,
      key: 'T-ABC123',
    });
    expect(runs[2]).toMatchObject({ kind: 'plain', text: '\n参考报告：' });
    expect(runs[3]).toMatchObject({
      kind: 'embed',
      name: 'lis-report',
      matched: true,
      key: 'L20240117001',
    });
    expect(runs[4]).toMatchObject({ kind: 'plain', text: '' });
  });

  it('未注册的 embed 名 → matched=false', () => {
    const doc = '占位 {{embed:unknown-x https://example.com/x}}';
    const runs = scanDocument(doc);
    expect(runs[1]).toMatchObject({
      kind: 'embed',
      name: 'unknown-x',
      matched: false,
    });
  });

  it('空文档 / 无标记文档 → 仅 plain run', () => {
    expect(scanDocument('')).toEqual([]);
    const runs = scanDocument('纯文本无标记');
    expect(runs).toEqual([{ kind: 'plain', text: '纯文本无标记' }]);
  });
});

describe('renderEmbed / fallback', () => {
  it('命中走 EmbedCard（带 data-embed-name 与 data-status）', () => {
    const descriptor = getEmbedByName('vendor-ticket')!;
    const node = renderEmbed({
      kind: 'embed',
      name: 'vendor-ticket',
      url: 'https://vendor.example.com/ticket/T-ABC123',
      matched: true,
      descriptor,
      key: 'T-ABC123',
    }) as any;
    expect(node).toBeTruthy();
    // renderer 的瘦版本 EmbedCardLite 输出 div[data-embed-name]
    expect(node.props['data-embed-name']).toBe('vendor-ticket');
    expect(node.props['data-embed-url']).toBe(
      'https://vendor.example.com/ticket/T-ABC123'
    );
  });

  it('未匹配走 fallback（原文链接 + 截图占位）', () => {
    const node = renderEmbedFallback(
      'https://www.example.com/manual.pdf',
      '*'
    ) as any;
    expect(node).toBeTruthy();
    expect(node.props['data-fallback']).toBe('true');
    expect(node.props['data-screenshot-placeholder']).toBe('true');
    const [link, placeholder] = node.props.children;
    expect(link.type).toBe('a');
    expect(link.props.href).toBe('https://www.example.com/manual.pdf');
    expect(link.props.target).toBe('_blank');
    expect(placeholder.type).toBe('div');
    expect(placeholder.props.className).toBe('screenshot-placeholder');
  });

  it('未匹配 URL 经 scanDocument → renderEmbed 走 fallback', () => {
    const doc = '原文 {{embed:not-real https://nowhere.example.com/x}}';
    const runs = scanDocument(doc);
    const embedRun = runs.find((r) => r.kind === 'embed')!;
    const node = renderEmbed(embedRun) as any;
    expect(node.props['data-fallback']).toBe('true');
  });
});

describe('EmbedCard 组件按 componentName 路由', () => {
  it('VendorTicketCard 渲染包含工单号 + 状态字段', () => {
    const descriptor = getEmbedByName('vendor-ticket')!;
    const node = EmbedCard({
      descriptor,
      url: 'https://vendor.example.com/ticket/T-ABC123',
      status: 'ok',
      data: {
        ticketId: 'T-ABC123',
        title: '试剂仓温度漂移',
        status: 'open',
        owner: 'zhangsan',
        updatedAt: '2026-08-29T10:00:00Z',
      },
    }) as any;
    expect(node.props['data-embed-name']).toBe('vendor-ticket');
    expect(node.props['data-status']).toBe('ok');
  });

  it('LisReportCard 渲染包含 accessionNo', () => {
    const descriptor = getEmbedByName('lis-report')!;
    const node = EmbedCard({
      descriptor,
      url: 'lis://reports/L20240117001',
      status: 'ok',
      data: {
        accessionNo: 'L20240117001',
        patientId: '脱敏示例',
        specimenType: '血清',
        reportedAt: '2026-08-29T09:00:00Z',
        testItems: [
          { code: 'ALT', name: '谷丙转氨酶', value: '42', unit: 'U/L' },
        ],
      },
    }) as any;
    expect(node.props['data-embed-name']).toBe('lis-report');
  });

  it('未知 componentName 走 UnknownEmbedCard', () => {
    // 临时注册一个 componentName=NotImplementedCard 的描述子
    registerEmbed(
      new EmbedDescriptor({
        name: 'not-impl',
        title: '未实现',
        kind: 'vendor-ticket',
        regexMatch: [/^tmp:\/\/x$/i],
        componentName: 'NotImplementedCard',
      })
    );
    const descriptor = getEmbedByName('not-impl')!;
    const node = EmbedCard({
      descriptor,
      url: 'tmp://x',
      status: 'idle',
    }) as any;
    expect(node.props.className).toContain('embed-card--unknown');
  });
});

describe('adapter 与 renderer 集成（不实际抓取）', () => {
  it('vendor-ticket 适配器失败时不抛错，渲染层走 ok+error fallback', async () => {
    // allowlist 留空 → SSRF 拒绝（fetchVendorTicket 返回 ok=false 不抛）
    const result = await fetchVendorTicket(
      'https://vendor.example.com/ticket/T-ABC123'
    );
    expect(result.ok).toBe(false);
    // renderEmbedFallback 不依赖网络，仅渲染
    const fallback = renderEmbedFallback(
      'https://vendor.example.com/ticket/T-ABC123',
      'vendor-ticket'
    );
    expect(fallback).toBeTruthy();
  });

  it('LIS adapter 未配置 baseUrl 返回 NOT_FOUND，不抛错', async () => {
    const result = await fetchLisReport('lis://reports/L20240117001');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });
});
