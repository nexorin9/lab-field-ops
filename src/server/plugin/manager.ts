// src/server/plugin/manager.ts
// PluginManager 单例：add / remove / list / get / hydrate。
//
// 借鉴 outline/plugins/github/server/index.ts 的形态：
//   PluginManager.add([{type: Hook.X, value: ...}])
// 领养的调用链：manifest 校验 → DB 落盘 → 内存索引 → 触发 audit_event。
// 不同：outline 用 array 批量注册；本项目每个 plugin 单 manifest 注册
//       （信息科 CLI 入口更直观：「一份 manifest 一个 plugin」）。
//
// 关键不变量：
// 1. add 之前先 hydrate，避免同名覆盖（覆盖视为错误，强制先 remove）
// 2. remove 必须触发 Hook.Uninstall（handler 由调用方注入）
// 3. add/remove 必须写 audit_event（append-only 表的 trigger 阻止 UPDATE/DELETE）
// 4. queue_name 在 add 时若已存在 → 拒绝（避免队列被两个 plugin 抢用）

import { getDb } from '../db.js';
import { appendAudit } from '../audit/ledger.js';
import { validateManifest, peekManifestShape } from './manifest.js';
import { validateCapabilities } from './capability.js';
import { Dispatcher } from './dispatcher.js';
import type {
  AddResult,
  ManagerAuditPayload,
  PluginEntry,
  PluginManifestInput,
  PluginManifestRow,
  RemoveResult,
} from './types.js';
import type {
  ApiRouter,
  TaskHandler,
  UnfurlProvider,
  UninstallHandler,
} from './hooks.js';

/** 调用方传入的 handler 集合（manifest 之外的部分）。 */
export interface PluginImplInput {
  api?: ApiRouter | ApiRouter[];
  task?: TaskHandler | TaskHandler[];
  unfurl?: UnfurlProvider | UnfurlProvider[];
  uninstall?: UninstallHandler | UninstallHandler[];
}

/** 内部维护：handlers（按 hook type）。 */
interface PluginEntryInternal extends PluginEntry {
  handlers: {
    api: ApiRouter[];
    task: TaskHandler[];
    unfurl: UnfurlProvider[];
    uninstall: UninstallHandler[];
  };
}

/** 把数组规范化为数组（接受单值或数组）。 */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

class PluginManagerImpl {
  private entries = new Map<string, PluginEntryInternal>();
  private hydrated = false;

  /** 从 plugin_manifest 表重新加载（不覆盖内存中的 handlers）。 */
  hydrate(): void {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM plugin_manifest ORDER BY installed_at ASC')
      .all() as PluginManifestRow[];

    for (const row of rows) {
      // 已存在则保留内存 handlers（避免重置）
      const existing = this.entries.get(row.name);
      const entry: PluginEntryInternal = existing ?? {
        manifest: rowToManifest(row),
        installedAt: row.installed_at,
        handlers: {
          api: [],
          task: [],
          unfurl: [],
          uninstall: [],
        },
      };
      this.entries.set(row.name, entry);
    }
    this.hydrated = true;
  }

  /**
   * 注册一个 plugin。
   * - manifest 校验失败 → {ok:false, errors}
   * - 同名已注册 → 拒绝（要求先 remove）
   * - 成功：DB INSERT + 内存索引 + 写 audit_event('plugin.add')
   */
  add(manifest: unknown, impl: PluginImplInput = {}): AddResult {
    if (!this.hydrated) this.hydrate();

    const v = validateManifest(manifest);
    if (!v.ok || !v.manifest) {
      return { ok: false, errors: v.errors.map((e) => `${e.path}: ${e.message}`) };
    }
    const m = v.manifest;

    if (this.entries.has(m.name)) {
      return {
        ok: false,
        errors: [
          `plugin '${m.name}' is already installed; run 'plugin remove ${m.name}' first`,
        ],
      };
    }

    // queue_name 唯一性检查（避免两个 plugin 抢同一队列）
    if (m.queue_name) {
      for (const e of this.entries.values()) {
        if (e.manifest.queue_name === m.queue_name) {
          return {
            ok: false,
            errors: [
              `queue_name '${m.queue_name}' is already used by plugin '${e.manifest.name}'`,
            ],
          };
        }
      }
    }

    // capability 沙箱二次校验：hook type 白名单 + queue 白名单 + rate_limit 区间
    const cap = validateCapabilities(m);
    if (!cap.ok) {
      return { ok: false, errors: cap.errors.map((e) => `${e.path}: ${e.message}`) };
    }

    const installedAt = new Date().toISOString();

    // DB INSERT
    const db = getDb();
    db.prepare(
      `INSERT INTO plugin_manifest
         (name, version, type, hooks_json, queue_name, auth_json, rate_limit, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      m.name,
      m.version,
      m.type,
      JSON.stringify(m.hooks),
      m.queue_name,
      m.auth ? JSON.stringify(m.auth) : null,
      m.rate_limit,
      installedAt,
    );

    const entry: PluginEntryInternal = {
      manifest: m,
      installedAt,
      handlers: {
        api: toArray(impl.api),
        task: toArray(impl.task),
        unfurl: toArray(impl.unfurl),
        uninstall: toArray(impl.uninstall),
      },
    };
    this.entries.set(m.name, entry);

    // 派发到子系统（API router / task queue / unfurl registry / uninstall registry）
    Dispatcher.dispatch(m, impl);

    // audit
    const auditPayload: ManagerAuditPayload = {
      name: m.name,
      version: m.version,
      type: m.type,
      queue_name: m.queue_name,
    };
    appendAudit({
      kind: 'plugin.add',
      operatorId: null,
      payload: auditPayload as unknown as Record<string, unknown>,
    });

    return { ok: true, entry: { manifest: m, installedAt } };
  }

  /**
   * 卸载一个 plugin。
   * - 触发 Hook.Uninstall handlers（异步 fire-and-forget，错误写 console）
   * - DB DELETE
   * - 内存清理
   * - 写 audit_event('plugin.remove') + ('plugin.uninstall' 若触发了 handler)
   */
  remove(name: string): RemoveResult {
    if (!this.hydrated) this.hydrate();
    const entry = this.entries.get(name);
    if (!entry) {
      // 幂等：已移除则返回 ok=true + alreadyRemoved=true
      appendAudit({
        kind: 'plugin.remove',
        operatorId: null,
        payload: { name, already_removed: true } as unknown as Record<string, unknown>,
      });
      return { ok: true, alreadyRemoved: true };
    }

    // 触发 uninstall handlers（同步执行：uninstall 应该是幂等且快速的）
    let uninstallTriggered = false;
    const handlers = entry.handlers.uninstall;
    if (handlers.length > 0) {
      uninstallTriggered = true;
      for (const handler of handlers) {
        try {
          const result = handler();
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            // 异步 handler 也不阻塞卸载流程
            (result as Promise<unknown>).catch((err) => {
              console.error(`[plugin ${name}] uninstall handler error:`, err);
            });
          }
        } catch (err) {
          console.error(`[plugin ${name}] uninstall handler sync error:`, err);
        }
      }
    }

    // 反向注销：Dispatcher 移除本 plugin 在各注册表的条目。
    // 二次 unregister 幂等（count=0、不抛错）。
    const removedFromDispatcher = Dispatcher.unregister(name);

    // DB DELETE
    const db = getDb();
    db.prepare('DELETE FROM plugin_manifest WHERE name = ?').run(name);

    // 内存清理
    this.entries.delete(name);

    // audit
    appendAudit({
      kind: 'plugin.remove',
      operatorId: null,
      payload: {
        name,
        uninstall_triggered: uninstallTriggered,
        dispatcher_removed: removedFromDispatcher,
      } as unknown as Record<string, unknown>,
    });

    return { ok: true, uninstallTriggered };
  }

  /** 列出全部已注册 plugin（按 installed_at ASC）。 */
  list(): PluginEntry[] {
    if (!this.hydrated) this.hydrate();
    return Array.from(this.entries.values())
      .sort((a, b) => a.installedAt.localeCompare(b.installedAt))
      .map((e) => ({ manifest: e.manifest, installedAt: e.installedAt }));
  }

  /** 按名称获取（含 handlers）。 */
  getInternal(name: string): PluginEntryInternal | undefined {
    if (!this.hydrated) this.hydrate();
    return this.entries.get(name);
  }

  /** 按名称获取（不含 handlers）。 */
  get(name: string): PluginEntry | undefined {
    const e = this.getInternal(name);
    if (!e) return undefined;
    return { manifest: e.manifest, installedAt: e.installedAt };
  }

  /** 按 queue_name 查找 plugin（队列任务派发用）。 */
  findByQueueName(queueName: string): PluginEntry | undefined {
    if (!this.hydrated) this.hydrate();
    for (const e of this.entries.values()) {
      if (e.manifest.queue_name === queueName) {
        return { manifest: e.manifest, installedAt: e.installedAt };
      }
    }
    return undefined;
  }

  /** 获取指定 plugin 的 task handlers（队列消费用）。 */
  getTaskHandlers(name: string): TaskHandler[] {
    const e = this.getInternal(name);
    return e ? e.handlers.task : [];
  }

  /** 测试/CLI 重置：清空内存状态；DB 不动。 */
  reset(): void {
    this.entries.clear();
    this.hydrated = false;
  }

  /** peek 入口（CLI 在 Read manifest 后立即做轻量校验）。 */
  peek(input: unknown): { ok: boolean; reason?: string } {
    return peekManifestShape(input);
  }
}

/** 单例导出。 */
export const PluginManager = new PluginManagerImpl();

/** 工具函数：把 DB row 转回 manifest 形态。 */
function rowToManifest(row: PluginManifestRow): PluginManifestInput {
  return {
    name: row.name,
    version: row.version,
    type: row.type as PluginManifestInput['type'],
    hooks: row.hooks_json ? (JSON.parse(row.hooks_json) as PluginManifestInput['hooks']) : [],
    queue_name: row.queue_name,
    auth: row.auth_json ? JSON.parse(row.auth_json) : null,
    rate_limit: row.rate_limit,
  };
}
