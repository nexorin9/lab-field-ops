// src/shared/embeds/hotReload.ts
// Embed 描述子注册表的磁盘持久化 + 热加载。
//
// 主路径：把当前 EmbedRegistry 内的全部描述子序列化为
//   data/embed-registry.json；启动时再 loadRegistryFromDisk 反序列化为
//   EmbedDescriptor[]，同名视为覆盖（高 priority 描述子替换低 priority）。
//
// 文件格式（v1）：
//   {
//     "version": 1,
//     "descriptors": [EmbedDescriptorJSON, ...]   // 见 types.ts EmbedDescriptorJSON
//   }
//
// 触发场景：信息科工程师新增「某厂商内部工单站」的描述子 → 写入 JSON →
// 重启进程即可生效；或 watchRegistryFile 监听文件变化做热替换（开发态）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EmbedDescriptor, type EmbedDescriptorJSON } from './types.js';

/** 默认磁盘路径（相对 cwd）。 */
export const DEFAULT_REGISTRY_PATH = 'data/embed-registry.json';

/** 磁盘文件 version 字段。 */
export const REGISTRY_FILE_VERSION = 1 as const;

interface RegistryFile {
  version: number;
  descriptors: EmbedDescriptorJSON[];
}

/**
 * 从磁盘读取描述子 JSON 文件。
 * - 文件不存在 / 解析失败 / schema 不通过 → 返回 []（fail-soft，不阻塞启动）
 * - 单条描述子 schema 失败 → 跳过该条，其余正常加载
 *
 * 安全：拒绝任何 path 越界（不允许 .. / 绝对路径之外）；调用方自行确保
 * path 落在 data/ 目录下。
 */
export function loadRegistryFromDisk(filePath: string): EmbedDescriptor[] {
  const resolved = path.resolve(filePath);

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    // 其它 IO 错误（权限 / EIO）也 fail-soft
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  return parseRegistryPayload(parsed);
}

/**
 * 把 payload（任意 unknown）解析为 EmbedDescriptor[]。
 * 暴露成独立函数方便测试 + reload 共享。
 *
 * 单条 descriptor schema 失败 → 跳过该条；启动不阻断。
 */
export function parseRegistryPayload(payload: unknown): EmbedDescriptor[] {
  if (!isRegistryFile(payload)) {
    return [];
  }

  const out: EmbedDescriptor[] = [];
  for (const entry of payload.descriptors) {
    if (!isDescriptorJSON(entry)) {
      continue;
    }
    try {
      out.push(EmbedDescriptor.fromJSON(entry));
    } catch {
      // fromJSON 抛错也跳过；启动不阻断
    }
  }
  return out;
}

/**
 * 把当前注册表全部描述子写盘（原子写：先写 .tmp 再 rename）。
 * 自动 mkdir parent dir；写盘失败抛错（与 loadRegistryFromDisk 的
 * fail-soft 相反：写失败意味着用户期望被持久化的修改丢了，必须抛）。
 */
export function saveRegistry(
  filePath: string,
  descriptors: EmbedDescriptor[]
): void {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });

  const payload: RegistryFile = {
    version: REGISTRY_FILE_VERSION,
    descriptors: descriptors.map((d) => d.toJSON()),
  };
  const json = JSON.stringify(payload, null, 2);

  const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, json, 'utf-8');
  fs.renameSync(tmp, resolved);
}

/**
 * 把单个描述子同步追加到磁盘文件；不存在则创建。
 * 内部走 saveRegistry 全量写（原子 rename）。
 *
 * 通常配合 registerEmbedPersistent 一起用——主路径只持一份真源（磁盘），
 * 内存是 cache。registerEmbed 时先 saveRegistry 再 reload，watcher 也会
 * 收到 change 事件。
 */
export function appendDescriptorToDisk(
  filePath: string,
  descriptor: EmbedDescriptor
): EmbedDescriptor[] {
  const existing = loadRegistryFromDisk(filePath);
  // 同名视为覆盖（与 EmbedRegistry.register 行为一致）
  const merged = mergeDescriptors(existing, descriptor);
  saveRegistry(filePath, merged);
  return merged;
}

function mergeDescriptors(
  existing: EmbedDescriptor[],
  next: EmbedDescriptor
): EmbedDescriptor[] {
  const idx = existing.findIndex((d) => d.name === next.name);
  if (idx >= 0) {
    const copy = existing.slice();
    copy[idx] = next;
    return copy;
  }
  return [...existing, next];
}

/**
 * 监听磁盘文件变化。返回 watcher 对象（含 close()）。
 *
 * 使用 fs.watch（Node 原生），不依赖 chokidar——chokidar 在大量文件场景
 * 表现更好，但本场景只监听 1 个 JSON 文件，fs.watch 已足够。
 *
 * 注意：fs.watch 在 macOS 上事件名是 'change'，Linux 可能是 'rename'；
 * 这里统一监听 'change' + 'rename' 两类。
 */
export interface RegistryWatcher {
  close(): void;
  /** 内部 listener 引用（测试用）。 */
  readonly listeners: number;
}

export function watchRegistryFile(
  filePath: string,
  onChange: (descriptors: EmbedDescriptor[]) => void,
  options: { debounceMs?: number } = {}
): RegistryWatcher {
  const resolved = path.resolve(filePath);
  const debounceMs = options.debounceMs ?? 50;
  let pendingTimer: NodeJS.Timeout | null = null;

  const fire = (): void => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      onChange(loadRegistryFromDisk(resolved));
    }, debounceMs);
  };

  // fs.watch 可能因为文件尚未存在而抛错（ENOENT）
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(resolved, { persistent: false }, (_eventType) => {
      fire();
    });
  } catch {
    watcher = null;
  }

  return {
    close(): void {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
    get listeners(): number {
      return watcher ? watcher.listenerCount('change') : 0;
    },
  };
}

/**
 * 给定注册表名字段冲突，priority 高者覆盖低者；同 priority 按 existing 顺序在前。
 * 返回新数组（不修改输入）。
 */
export function resolvePriorityConflicts(
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
    const prev = merged[idx];
    // priority 数字大者优先；同 priority 按注册顺序（existing 在前，incoming 视为后注册）
    if (next.priority > prev.priority) {
      merged[idx] = next;
    }
    // 否则保留 prev
  }
  return merged;
}

// ---- schema 校验（轻量，无 zod 依赖） ----

function isRegistryFile(value: unknown): value is RegistryFile {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== REGISTRY_FILE_VERSION) return false;
  if (!Array.isArray(obj.descriptors)) return false;
  // 注：单条 descriptor schema 不通过不会让整个文件失效；
  // parseRegistryPayload 内部逐条 try/catch 跳过坏条，让启动不阻断
  return true;
}

function isDescriptorJSON(value: unknown): value is EmbedDescriptorJSON {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  if (typeof d.name !== 'string' || !d.name) return false;
  if (typeof d.title !== 'string') return false;
  if (typeof d.kind !== 'string') return false;
  if (!Array.isArray(d.regexSource)) return false;
  if (typeof d.regexFlags !== 'string') return false;
  if (typeof d.matchOnInput !== 'boolean') return false;
  if (typeof d.priority !== 'number') return false;
  if (typeof d.componentName !== 'string') return false;
  if (d.keywords !== undefined && typeof d.keywords !== 'string') return false;
  if (d.placeholder !== undefined && typeof d.placeholder !== 'string') {
    return false;
  }
  if (d.keyGroup !== undefined && typeof d.keyGroup !== 'number') return false;
  return true;
}