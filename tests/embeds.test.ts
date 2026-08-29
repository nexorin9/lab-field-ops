// tests/embeds.test.ts
// 描述子注册表：4 类 regex 命中/不命中各 3 条；registerEmbed 可插拔；matchEmbeds 按 priority 排序。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  EmbedRegistry,
  EmbedDescriptor,
  registerEmbed,
  unregisterEmbed,
  getEmbedByName,
  matchEmbeds,
  matchEmbed,
  DefaultEmbedRegistry,
} from '../src/shared/embeds/index.js';
import {
  builtinDescriptors,
  installBuiltinDescriptors,
} from '../src/shared/embeds/registry.js';
import { VENDOR_TICKET_REGEX } from '../src/shared/embeds/descriptors/vendor-ticket.js';
import { LIS_REPORT_REGEX } from '../src/shared/embeds/descriptors/lis-report.js';
import { CALIBRATION_RECORD_REGEX } from '../src/shared/embeds/descriptors/calibration-record.js';
import { INSTRUMENT_MANUAL_REGEX } from '../src/shared/embeds/descriptors/instrument-manual.js';

/** 每个描述子：3 条应命中 + 3 条不应命中。 */
const FIXTURES: Array<{
  name: string;
  hit: string[];
  miss: string[];
  expectedKey: string;
}> = [
  {
    name: 'vendor-ticket',
    hit: [
      'https://vendor-example.com/ticket/T-ABC123',
      'https://svc.vendor.com/ticket/T-A1B2C3',
      'http://support.vendor.example.com/ticket/T-XY99',
    ],
    miss: [
      'https://vendor-example.com/tickets/T-ABC123', // 路径复数
      'https://other.com/ticket/T-ABC123', // 域名不在范围
      'https://vendor-example.com/ticket/abc123', // 缺 T- 前缀
    ],
    expectedKey: 'T-ABC123',
  },
  {
    name: 'lis-report',
    hit: [
      'lis://reports/L20240117001',
      'lis://reports/L12345678',
      'LIS://REPORTS/L987654321',
    ],
    miss: [
      'lis://reports/L1234567', // 位数不足 8
      'https://reports/L20240117001', // 协议不符
      'lis://report/L20240117001', // 路径单数
    ],
    expectedKey: 'L20240117001',
  },
  {
    name: 'calibration-record',
    hit: [
      'cal://calibrations/C20240117.json',
      'cal://calibrations/C123456789.json',
      'CAL://CALIBRATIONS/C20240101.JSON',
    ],
    miss: [
      'cal://calibrations/C20240117.yaml', // 扩展名不符
      'cal://calibrations/20240117.json', // 缺 C 前缀
      'cal://calibration/C20240117.json', // 路径单数
    ],
    expectedKey: 'C20240117',
  },
  {
    name: 'instrument-manual',
    hit: [
      'https://docs.vendor.com/advia-2400/service-manual.pdf',
      'http://docs.vendor.com/maintenance.pdf',
      'https://docs.vendor.com/a/b/c/handbook.PDF',
    ],
    miss: [
      'https://docs.vendor.com/manual.docx', // 非 PDF
      'https://docs.other.com/manual.pdf', // 域名不符
      'https://docs.vendor.com/manual.pdf?x=1', // 带查询串（须走兜底）
    ],
    expectedKey: 'advia-2400/service-manual',
  },
];

beforeEach(() => {
  // 每个用例都从干净的内置注册表开始
  DefaultEmbedRegistry.clear();
  installBuiltinDescriptors();
});

describe('内置描述子 regex', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: 3 条命中 / 3 条不命中`, () => {
      const descriptor = getEmbedByName(fixture.name);
      expect(descriptor, `未注册 ${fixture.name}`).toBeDefined();

      for (const url of fixture.hit) {
        expect(descriptor!.matcher(url), `应命中: ${url}`).toBeTruthy();
      }
      for (const url of fixture.miss) {
        expect(descriptor!.matcher(url), `不应命中: ${url}`).toBe(false);
      }
    });

    it(`${fixture.name}: 抽出业务主键`, () => {
      const hit = matchEmbed(fixture.hit[0]);
      expect(hit).not.toBeNull();
      expect(hit!.descriptor.name).toBe(fixture.name);
      expect(hit!.key).toBe(fixture.expectedKey);
    });
  }
});

describe('regex 与 spec.md 参考地基对齐', () => {
  it('4 个描述子的正则来源与导出常量逐字一致', () => {
    const expected: Record<string, RegExp> = {
      'vendor-ticket': VENDOR_TICKET_REGEX,
      'lis-report': LIS_REPORT_REGEX,
      'calibration-record': CALIBRATION_RECORD_REGEX,
      'instrument-manual': INSTRUMENT_MANUAL_REGEX,
    };
    for (const [name, regex] of Object.entries(expected)) {
      const descriptor = getEmbedByName(name)!;
      expect(descriptor.regexMatch[0].source).toBe(regex.source);
      expect(descriptor.regexMatch[0].flags).toContain('i');
    }
  });

  it('默认注册表恰含 4 项且 componentName 唯一', () => {
    expect(DefaultEmbedRegistry.size()).toBe(4);
    const components = builtinDescriptors.map((d) => d.componentName);
    expect(new Set(components).size).toBe(4);
  });
});

describe('registerEmbed 可插拔', () => {
  it('运行时新增一类描述子即生效，无需改内置列表', () => {
    expect(matchEmbeds('qc://qc-rules/QC-0007')).toHaveLength(0);

    registerEmbed(
      new EmbedDescriptor({
        name: 'qc-rule',
        title: '质控规则',
        kind: 'calibration-record',
        regexMatch: [/^qc:\/\/qc-rules\/(QC-\d{4})$/i],
        componentName: 'QcRuleCard',
        priority: 5,
        keyGroup: 1,
      })
    );

    const hits = matchEmbeds('qc://qc-rules/QC-0007');
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('QC-0007');
    expect(DefaultEmbedRegistry.size()).toBe(5);
  });

  it('同名注册为覆盖，不产生重复项', () => {
    const before = DefaultEmbedRegistry.size();
    registerEmbed(
      new EmbedDescriptor({
        name: 'lis-report',
        title: 'LIS 报告（改）',
        kind: 'lis-report',
        regexMatch: [/^lis:\/\/reports\/(L\d{8,})$/i],
        componentName: 'LisReportCard',
        priority: 99,
        keyGroup: 1,
      })
    );
    expect(DefaultEmbedRegistry.size()).toBe(before);
    expect(getEmbedByName('lis-report')!.priority).toBe(99);
  });

  it('unregisterEmbed 移除后不再命中；移除不存在项返回 false', () => {
    expect(unregisterEmbed('lis-report')).toBe(true);
    expect(matchEmbeds('lis://reports/L20240117001')).toHaveLength(0);
    expect(unregisterEmbed('lis-report')).toBe(false);
  });

  it('独立 registry 与默认注册表互不影响', () => {
    const isolated = new EmbedRegistry();
    registerEmbed(
      new EmbedDescriptor({
        name: 'only-here',
        title: '独立项',
        kind: 'vendor-ticket',
        regexMatch: [/^x:\/\/(\d+)$/],
        componentName: 'XCard',
        keyGroup: 1,
      }),
      isolated
    );
    expect(matchEmbeds('x://1', isolated)).toHaveLength(1);
    expect(matchEmbeds('x://1')).toHaveLength(0);
  });
});

describe('matchEmbeds 排序与兜底', () => {
  it('多描述子命中同一 URL 时按 priority 倒序', () => {
    registerEmbed(
      new EmbedDescriptor({
        name: 'lis-report-legacy',
        title: 'LIS 报告（旧口径）',
        kind: 'lis-report',
        regexMatch: [/^lis:\/\/reports\/(L\d+)$/i],
        componentName: 'LisReportLegacyCard',
        priority: 5,
        keyGroup: 1,
      })
    );

    const hits = matchEmbeds('lis://reports/L20240117001');
    expect(hits.map((h) => h.descriptor.name)).toEqual([
      'lis-report',
      'lis-report-legacy',
    ]);
    expect(hits[0].descriptor.priority).toBeGreaterThan(
      hits[1].descriptor.priority
    );
  });

  it('同 priority 时保持注册顺序', () => {
    const registry = new EmbedRegistry();
    for (const name of ['a', 'b', 'c']) {
      registerEmbed(
        new EmbedDescriptor({
          name,
          title: name,
          kind: 'vendor-ticket',
          regexMatch: [/^same:\/\/all$/],
          componentName: `${name}Card`,
          priority: 7,
        }),
        registry
      );
    }
    expect(matchEmbeds('same://all', registry).map((h) => h.descriptor.name)).toEqual(
      ['a', 'b', 'c']
    );
  });

  it('onInputOnly 跳过 matchOnInput=false 的描述子', () => {
    registerEmbed(
      new EmbedDescriptor({
        name: 'manual-only',
        title: '仅显式插入',
        kind: 'instrument-manual',
        regexMatch: [/^https?:\/\/docs\.vendor\.com\/(.+)\.pdf$/i],
        componentName: 'ManualOnlyCard',
        matchOnInput: false,
        priority: 99,
      })
    );
    const pasted = matchEmbeds('https://docs.vendor.com/x.pdf', DefaultEmbedRegistry, {
      onInputOnly: true,
    });
    expect(pasted.map((h) => h.descriptor.name)).toEqual(['instrument-manual']);
  });

  it('未匹配 URL 与空串返回空数组（由渲染层走原文兜底）', () => {
    expect(matchEmbeds('https://www.example.com/whatever')).toEqual([]);
    expect(matchEmbeds('   ')).toEqual([]);
    expect(matchEmbed('not a url')).toBeNull();
  });
});

describe('描述子序列化（供 Task 20 热加载）', () => {
  it('toJSON / fromJSON 往返后匹配行为一致', () => {
    const original = getEmbedByName('vendor-ticket')!;
    const restored = EmbedDescriptor.fromJSON(original.toJSON());
    const url = 'https://svc.vendor.com/ticket/T-A1B2C3';
    expect(restored.matcher(url)).toBeTruthy();
    expect(restored.extractKey(restored.matcher(url) as RegExpMatchArray)).toBe(
      'T-A1B2C3'
    );
    expect(restored.priority).toBe(original.priority);
    expect(restored.componentName).toBe(original.componentName);
  });
});
