// src/app/kbar/types.ts
// ⌘K 命令面板的动作类型与分组元数据。
// 主路径形态参考 outline 的 app/actions/index.ts 的 Action variants
// （action / internal_link / external_link / action_with_children）。
// 字段命名锁住，作为 src/server/presenters/contracts.ts（Task 24）contract v1 真源。

/** ⌘K 命令面板 section 名称（中文化，与 index 一致）。 */
export type KBarSectionName =
  | '仪器'
  | '报警码'
  | '校准'
  | '插件'
  | '手册'
  | '导航';

/** 单一动作的 perform 接收的上下文（来自 kbar lib）。 */
export interface KBarPerformContext {
  isButton?: boolean;
  isCommandBar?: boolean;
  isContextMenu?: boolean;
  searchQuery?: string;
  [k: string]: unknown;
}

/** perform 函数签名：可同步或返回 Promise。 */
export type KBarPerformFn = (ctx?: KBarPerformContext) => void | Promise<void>;

/** 命令面板动作统一形态。 */
export interface KBarAction {
  /** 全局唯一 id；同 name 视为同动作。 */
  id: string;
  /** 用户可见名称。 */
  name: string;
  /** 分组 section 名（决定列表分组）。 */
  section: KBarSectionName | { name: KBarSectionName; priority: number };
  /** 触发动作；可同步或异步。 */
  perform: KBarPerformFn;
  /** 父动作 id（用于子菜单嵌套）。 */
  parent?: string;
  /** 关键字（模糊匹配用，例：'Siemens' 或 '西门子'）。 */
  keywords?: string[];
  /** 简述（卡片副标题或备注）。 */
  subtitle?: string;
  /** 触发动作的键位（提示用，不强制生效）。 */
  shortcut?: string[];
  /** 优先级：同 section 内数字大者优先。 */
  priority?: number;
  /** 业务主键：用于 ⌘K 命中后 SplitView 二次聚合。 */
  metadata?: Record<string, unknown>;
}

/** 五类可索引对象的统一抽象（kbar 索引表的行）。 */
export type IndexableKind =
  | 'Instrument'
  | 'AlarmCode'
  | 'Calibration'
  | 'PluginCard'
  | 'ManualEntry';

export interface IndexableItem {
  kind: IndexableKind;
  id: string;
  name: string;
  section: KBarSectionName;
  keywords: string[];
  subtitle?: string;
  metadata: Record<string, unknown>;
}

/** 查询解析结果（见 parseQuery.ts）。 */
export interface ParsedQuery {
  vendor?: string;
  model?: string;
  alarmCode?: string;
  instrumentId?: string;
  raw: string;
}

/** SplitView 同屏打开的三个面板（⌘K 命中三类对象时一次开）。 */
export interface SplitOpenTarget {
  instrumentId?: string;
  alarmKey?: string; // `${vendor}|${model}|${alarmCode}`
  calibrationId?: string;
}