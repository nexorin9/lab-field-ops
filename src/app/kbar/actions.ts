// src/app/kbar/actions.ts
// ⌘K 动作工厂：createAction / createInternalLinkAction / createExternalLinkAction。
// 形态改自 outline app/actions/index.ts 的同名工厂；本项目只保留核心三件套，
// 不引入 Analytics/UUID/MobX，让 Node 端测试无需 react/kbar 全栈。

import type { KBarAction, KBarSectionName } from './types.js';

let nextId = 1;

/** 生成稳定 id；测试可注入 prefix 避免跨用例 id 冲突。 */
export function makeActionId(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

/** 重置内部计数器（仅测试使用）。 */
export function __resetActionIdsForTest(): void {
  nextId = 1;
}

export interface CreateActionInput {
  id?: string;
  name: string;
  section: KBarSectionName | { name: KBarSectionName; priority: number };
  perform: KBarAction['perform'];
  parent?: string;
  keywords?: string[];
  subtitle?: string;
  shortcut?: string[];
  priority?: number;
  metadata?: Record<string, unknown>;
}

/** 通用动作（无导航语义，仅触发 perform）。 */
export function createAction(input: CreateActionInput): KBarAction {
  const action: KBarAction = {
    id: input.id ?? makeActionId('act'),
    name: input.name,
    section: input.section,
    perform: input.perform,
  };
  if (input.parent) action.parent = input.parent;
  if (input.keywords) action.keywords = input.keywords;
  if (input.subtitle) action.subtitle = input.subtitle;
  if (input.shortcut) action.shortcut = input.shortcut;
  if (input.priority !== undefined) action.priority = input.priority;
  if (input.metadata) action.metadata = input.metadata;
  return action;
}

export interface CreateInternalLinkInput {
  id?: string;
  name: string;
  /** push 函数（React Router history.push 或适配器）。 */
  push: (to: string) => void;
  to: string;
  section: KBarSectionName;
  keywords?: string[];
  subtitle?: string;
  shortcut?: string[];
  priority?: number;
  metadata?: Record<string, unknown>;
}

/** 内部链接动作（perform = push(to)）。 */
export function createInternalLinkAction(
  input: CreateInternalLinkInput
): KBarAction {
  return createAction({
    id: input.id ?? makeActionId('ilink'),
    name: input.name,
    section: input.section,
    perform: () => input.push(input.to),
    keywords: input.keywords,
    subtitle: input.subtitle,
    shortcut: input.shortcut,
    priority: input.priority,
    metadata: input.metadata,
  });
}

export interface CreateExternalLinkInput {
  id?: string;
  name: string;
  url: string;
  section: KBarSectionName;
  keywords?: string[];
  subtitle?: string;
  shortcut?: string[];
  priority?: number;
  target?: '_blank' | '_self';
  metadata?: Record<string, unknown>;
}

/** 外链动作（perform = window.open）。 */
export function createExternalLinkAction(
  input: CreateExternalLinkInput
): KBarAction {
  const target = input.target ?? '_blank';
  return createAction({
    id: input.id ?? makeActionId('elink'),
    name: input.name,
    section: input.section,
    perform: () => {
      if (typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(input.url, target);
      }
    },
    keywords: input.keywords,
    subtitle: input.subtitle,
    shortcut: input.shortcut,
    priority: input.priority,
    metadata: input.metadata,
  });
}

/**
 * 把一组 ⌘K 动作按 (section, priority desc, 注册顺序) 排序。
 * 同 priority 时保持输入顺序（稳定排序）；section 优先级：仪器 > 报警码 > 校准 > 插件 > 手册 > 导航。
 */
export function sortActions(actions: KBarAction[]): KBarAction[] {
  const sectionRank: Record<string, number> = {
    报警码: 100, // 工程师在 ⌘K 后最想看到的就是「这一码怎么办」
    仪器: 90,
    校准: 80,
    插件: 60,
    手册: 50,
    导航: 40,
  };
  const sectionName = (s: KBarAction['section']): string =>
    typeof s === 'string' ? s : s.name;

  return [...actions].sort((a, b) => {
    const ra = sectionRank[sectionName(a.section)] ?? 0;
    const rb = sectionRank[sectionName(b.section)] ?? 0;
    if (ra !== rb) return rb - ra;
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    return 0; // 同 priority：保持注册顺序（Node 20 Array.prototype.sort 稳定）
  });
}