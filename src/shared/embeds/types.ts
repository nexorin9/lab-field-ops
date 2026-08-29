// src/shared/embeds/types.ts
// 嵌入描述子（EmbedDescriptor）类型定义。
// 主路径沿用「一组 regex → matcher(url) → 命中即渲染卡片」的描述子注册表形态，
// 匹配对象从通用 SaaS 链接换成检验业务对象（厂商工单 / LIS 报告 / 校准记录 / 仪器手册）。

/** 描述子可识别的业务对象类别，决定 ⌘K 分组与卡片组件路由。 */
export type EmbedKind =
  | 'vendor-ticket'
  | 'lis-report'
  | 'calibration-record'
  | 'instrument-manual';

/** matcher 命中结果：保留原始 match 数组，便于适配器取捕获组（工单号 / accession_no 等）。 */
export interface EmbedMatch {
  descriptor: EmbedDescriptor;
  url: string;
  matches: RegExpMatchArray;
  /** 由 descriptor.extractKey 抽出的业务主键（如 T-ABC123 / L20240117001）。 */
  key: string | null;
}

/** 描述子的可序列化部分：用于 data/embed-registry.json 热加载（Task 20）。 */
export interface EmbedDescriptorJSON {
  name: string;
  title: string;
  kind: EmbedKind;
  /** 正则以字符串形式落盘，形如 "^https?://.../ticket/T-[A-Z0-9]+" + flags。 */
  regexSource: string[];
  regexFlags: string;
  matchOnInput: boolean;
  priority: number;
  componentName: string;
  keywords?: string;
  placeholder?: string;
  /** 捕获组下标，用于抽取业务主键；缺省不抽取。 */
  keyGroup?: number;
}

export interface EmbedDescriptorOptions {
  /** 唯一标识，同时是注册表键与 {{embed:name url}} 标记里的 name。 */
  name: string;
  /** 卡片标题（中文，展示给检验工程师）。 */
  title: string;
  kind: EmbedKind;
  /** 一个描述子可挂多条正则；按顺序尝试，首条命中即返回。 */
  regexMatch: (RegExp | string)[];
  /** 是否在粘贴/输入时自动匹配；false 表示只在显式插入时使用。 */
  matchOnInput?: boolean;
  /** 数字越大越先匹配；同 priority 按注册顺序（见 registry 的排序规则）。 */
  priority?: number;
  /** 前端卡片组件名，EmbedCard 按此路由（Task 5）。 */
  componentName: string;
  keywords?: string;
  placeholder?: string;
  keyGroup?: number;
}

/**
 * 一个可注册的嵌入描述子。
 * matcher(url) 是主路径：依次尝试 regexMatch，命中返回 RegExpMatchArray，否则 false。
 */
export class EmbedDescriptor {
  name: string;
  title: string;
  kind: EmbedKind;
  regexMatch: RegExp[];
  matchOnInput: boolean;
  priority: number;
  componentName: string;
  keywords?: string;
  placeholder?: string;
  keyGroup?: number;

  constructor(options: EmbedDescriptorOptions) {
    this.name = options.name;
    this.title = options.title;
    this.kind = options.kind;
    this.regexMatch = options.regexMatch.map((r) =>
      typeof r === 'string' ? new RegExp(r, 'i') : r
    );
    this.matchOnInput = options.matchOnInput ?? true;
    this.priority = options.priority ?? 0;
    this.componentName = options.componentName;
    this.keywords = options.keywords;
    this.placeholder = options.placeholder;
    this.keyGroup = options.keyGroup;
  }

  /** 主路径：命中返回 RegExpMatchArray，未命中返回 false。 */
  matcher(url: string): false | RegExpMatchArray {
    for (const regex of this.regexMatch) {
      // 显式重置 lastIndex，避免带 g 标志的正则在多次调用间串状态
      if (regex.global || regex.sticky) {
        regex.lastIndex = 0;
      }
      const result = url.match(regex);
      if (result) {
        return result;
      }
    }
    return false;
  }

  /** 从命中结果抽出业务主键（工单号 / accession_no / 校准号）。 */
  extractKey(matches: RegExpMatchArray): string | null {
    if (this.keyGroup === undefined) {
      return null;
    }
    return matches[this.keyGroup] ?? null;
  }

  toJSON(): EmbedDescriptorJSON {
    return {
      name: this.name,
      title: this.title,
      kind: this.kind,
      regexSource: this.regexMatch.map((r) => r.source),
      regexFlags: this.regexMatch[0]?.flags ?? 'i',
      matchOnInput: this.matchOnInput,
      priority: this.priority,
      componentName: this.componentName,
      keywords: this.keywords,
      placeholder: this.placeholder,
      keyGroup: this.keyGroup,
    };
  }

  static fromJSON(json: EmbedDescriptorJSON): EmbedDescriptor {
    return new EmbedDescriptor({
      name: json.name,
      title: json.title,
      kind: json.kind,
      regexMatch: json.regexSource.map((s) => new RegExp(s, json.regexFlags)),
      matchOnInput: json.matchOnInput,
      priority: json.priority,
      componentName: json.componentName,
      keywords: json.keywords,
      placeholder: json.placeholder,
      keyGroup: json.keyGroup,
    });
  }
}
