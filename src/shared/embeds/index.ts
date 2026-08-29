// src/shared/embeds/index.ts
// 描述子注册表主入口：registerEmbed / matchEmbeds / getEmbedByName。
// 主路径：输入一段 URL → 遍历注册表 descriptor.matcher(url) → 按 priority 排序返回命中项。
//
// 持久化层（hotReload.ts）：
//   registerEmbedPersistent / reloadFromDisk：把注册表与磁盘 JSON 同步。
//   启动时 loadOnStartupIfExists() 自动从 data/embed-registry.json 加载。

import { EmbedDescriptor, type EmbedMatch } from './types.js';
import {
  DEFAULT_REGISTRY_PATH,
  loadRegistryFromDisk,
  saveRegistry,
} from './hotReload.js';

export { EmbedDescriptor };
export type {
  EmbedMatch,
  EmbedKind,
  EmbedDescriptorJSON,
  EmbedDescriptorOptions,
} from './types.js';

/**
 * 描述子注册表：保序数组 + name 索引。
 *
 * 排序规则（matchEmbeds 公开）：
 *   - priority 数字大者优先（desc）
 *   - 同 priority 保持注册顺序（Array.prototype.sort 在 Node 20 上稳定）
 *   - 冲突时（同名 register）：高 priority 覆盖低 priority；同 priority 视为覆盖更新
 */
export class EmbedRegistry {
  private descriptors: EmbedDescriptor[] = [];

  /**
   * 注册一个描述子。同名视为覆盖（与 hotReload.mergeDescriptors 同形）；
   * 这让「热替换一类描述子」无需先 unregister。
   */
  register(descriptor: EmbedDescriptor): EmbedDescriptor {
    const existingIdx = this.descriptors.findIndex(
      (d) => d.name === descriptor.name
    );
    if (existingIdx >= 0) {
      // 同名覆盖：priority 高者优先；同 priority 时新描述子替换旧
      const prev = this.descriptors[existingIdx];
      if (descriptor.priority > prev.priority) {
        this.descriptors[existingIdx] = descriptor;
      } else if (descriptor.priority === prev.priority) {
        this.descriptors[existingIdx] = descriptor;
      }
      // priority 更低 → 保留 prev（冲突规则见 PRICEDESC 表）
    } else {
      this.descriptors.push(descriptor);
    }
    return descriptor;
  }

  unregister(name: string): boolean {
    const idx = this.descriptors.findIndex((d) => d.name === name);
    if (idx < 0) {
      return false;
    }
    this.descriptors.splice(idx, 1);
    return true;
  }

  get(name: string): EmbedDescriptor | undefined {
    return this.descriptors.find((d) => d.name === name);
  }

  /** 注册顺序快照；排序规则见 matchEmbeds。 */
  list(): EmbedDescriptor[] {
    return [...this.descriptors];
  }

  clear(): void {
    this.descriptors = [];
  }

  size(): number {
    return this.descriptors.length;
  }

  /**
   * 替换注册表内容（不修改输入数组）。hotReload 用：磁盘加载后整体替换。
   */
  replaceAll(descriptors: EmbedDescriptor[]): void {
    this.descriptors = [...descriptors];
  }
}

/** 进程内默认注册表；registry.ts 启动时灌入 4 类内置描述子。 */
export const DefaultEmbedRegistry = new EmbedRegistry();

export function registerEmbed(
  descriptor: EmbedDescriptor,
  registry: EmbedRegistry = DefaultEmbedRegistry
): EmbedDescriptor {
  return registry.register(descriptor);
}

export function unregisterEmbed(
  name: string,
  registry: EmbedRegistry = DefaultEmbedRegistry
): boolean {
  return registry.unregister(name);
}

export function getEmbedByName(
  name: string,
  registry: EmbedRegistry = DefaultEmbedRegistry
): EmbedDescriptor | undefined {
  return registry.get(name);
}

export interface MatchEmbedsOptions {
  /** 只考虑 matchOnInput=true 的描述子（粘贴场景默认如此）。 */
  onInputOnly?: boolean;
}

/**
 * 主匹配函数：对单条 URL 返回全部命中的描述子。
 *
 * 排序规则（priority 表）：
 *   1. priority 数字大者优先（desc）
 *   2. 同 priority 保持注册顺序（Node 20 Array.sort 稳定）
 *   3. 冲突（同名 register）：高 priority 覆盖低 priority；同 priority 视为覆盖更新
 *      （这条规则由 EmbedRegistry.register 内部执行，不在 matchEmbeds 里）
 */
export function matchEmbeds(
  input: string,
  registry: EmbedRegistry = DefaultEmbedRegistry,
  options: MatchEmbedsOptions = {}
): EmbedMatch[] {
  const url = input.trim();
  if (!url) {
    return [];
  }

  const hits: EmbedMatch[] = [];
  for (const descriptor of registry.list()) {
    if (options.onInputOnly && !descriptor.matchOnInput) {
      continue;
    }
    const matches = descriptor.matcher(url);
    if (matches) {
      hits.push({
        descriptor,
        url,
        matches,
        key: descriptor.extractKey(matches),
      });
    }
  }

  // Array.prototype.sort 在 Node 20 上稳定，同 priority 保持注册顺序
  return hits.sort((a, b) => b.descriptor.priority - a.descriptor.priority);
}

/** 便捷函数：只取优先级最高的一条命中。 */
export function matchEmbed(
  input: string,
  registry: EmbedRegistry = DefaultEmbedRegistry,
  options: MatchEmbedsOptions = {}
): EmbedMatch | null {
  return matchEmbeds(input, registry, options)[0] ?? null;
}

// ---- 磁盘持久化层 ----

/**
 * 注册并立即同步到磁盘（写盘 → 内存）。返回 descriptor。
 * 写盘失败抛错——这是用户期望被持久化的修改，丢失必须可见。
 */
export function registerEmbedPersistent(
  descriptor: EmbedDescriptor,
  options: {
    registry?: EmbedRegistry;
    diskPath?: string;
  } = {}
): EmbedDescriptor {
  const registry = options.registry ?? DefaultEmbedRegistry;
  const diskPath = options.diskPath ?? DEFAULT_REGISTRY_PATH;

  const current = registry.list();
  const merged = upsertByName(current, descriptor);
  saveRegistry(diskPath, merged);
  registry.replaceAll(merged);
  return descriptor;
}

/**
 * 从磁盘重新加载并替换注册表内容。返回新加载的描述子列表。
 * 文件不存在 / 解析失败 → 清空注册表（fail-soft，避免脏内存）。
 */
export function reloadFromDisk(
  diskPath: string = DEFAULT_REGISTRY_PATH,
  registry: EmbedRegistry = DefaultEmbedRegistry
): EmbedDescriptor[] {
  const descriptors = loadRegistryFromDisk(diskPath);
  registry.replaceAll(descriptors);
  return descriptors;
}

/**
 * 启动期从磁盘加载（若文件存在）。返回加载的描述子列表。
 * 与 reloadFromDisk 的区别：磁盘文件不存在时不会清空注册表。
 *
 * 用法（在 server 入口 / CLI 入口调用一次）：
 *   loadOnStartupIfExists();   // 内置 4 项已经注册；磁盘项覆盖同名或追加
 */
export function loadOnStartupIfExists(
  diskPath: string = DEFAULT_REGISTRY_PATH,
  registry: EmbedRegistry = DefaultEmbedRegistry
): EmbedDescriptor[] {
  const fromDisk = loadRegistryFromDisk(diskPath);
  if (fromDisk.length === 0) {
    return [];
  }
  const merged = mergeWithPriority(registry.list(), fromDisk);
  registry.replaceAll(merged);
  return fromDisk;
}

function upsertByName(
  existing: EmbedDescriptor[],
  next: EmbedDescriptor
): EmbedDescriptor[] {
  const idx = existing.findIndex((d) => d.name === next.name);
  if (idx < 0) {
    return [...existing, next];
  }
  const copy = existing.slice();
  copy[idx] = next;
  return copy;
}

/**
 * 合并「内存已有 + 磁盘加载」：磁盘项按 priority 覆盖规则接管。
 * - 同名 + 磁盘 priority > 内存 → 替换
 * - 同名 + 磁盘 priority <= 内存 → 保留内存
 * - 不同名 → 追加
 */
function mergeWithPriority(
  existing: EmbedDescriptor[],
  incoming: EmbedDescriptor[]
): EmbedDescriptor[] {
  const merged = [...existing];
  for (const next of incoming) {
    const idx = merged.findIndex((d) => d.name === next.name);
    if (idx < 0) {
      merged.push(next);
      continue;
    }
    if (next.priority > merged[idx].priority) {
      merged[idx] = next;
    }
  }
  return merged;
}

// ---- priority 规则表（PRICEDESC） ----
//
// | 规则名               | 行为                                                       |
// |----------------------|------------------------------------------------------------|
// | priority-desc         | matchEmbeds 返回结果按 priority 数字倒序                    |
// | priority-stable      | 同 priority 保持注册顺序（依赖 Node 20 Array.sort 稳定性）  |
// | priority-conflict    | 同名 register 时，priority 高者替换低者；同 priority 视为更新 |
// | priority-disk-merge  | 启动加载磁盘时，磁盘 priority > 内存时替换                  |
// | priority-no-priority | 未指定 priority（EmbedDescriptor 默认 0）排在末位           |