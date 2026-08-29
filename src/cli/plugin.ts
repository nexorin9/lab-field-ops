// src/cli/plugin.ts
// 信息科工程师 CLI 入口：plugin add / plugin remove / plugin list。
//
// 领养的调用链（参考 outline 的 PluginManager.add 主路径 + cli 模式）：
//   读 manifest 文件 → peek 浅校验 → PluginManager.add → 反馈 name/version/queueName/listeningPath
//
// 取舍：
// - plugin add 之前必须 migrate()（CLI 第一次启动时数据库未建）
// - listeningPath 是约定的「API 路由前缀」或「队列名」字符串，不是真实 socket port
//   （server 启动后通过 dispatcher 统一调度；这里只做声明式的占位反馈）
// - list 输出对齐 spec.md「输出样例」中的表格：name/version/type/queue/status
// - Task 22 增补：task 类型 plugin 必须在 manifest 声明 rate_limit（或接受
//   默认 HEARTBEAT_DEFAULT_RATE_LIMIT=10/s）；缺省则在 CLI 侧自动补齐后再
//   交给 PluginManager.add（让心跳队列的限流总是有据可循）

import fs from 'node:fs';
import path from 'node:path';
import { PluginManager } from '../server/plugin/manager.js';
import { migrate } from '../server/db/migrate.js';
import { HEARTBEAT_DEFAULT_RATE_LIMIT } from '../shared/types.js';
import type { PluginManifestInput } from '../server/plugin/types.js';

export interface AddPluginOptions {
  /** 覆盖默认 db 路径（CLI 默认从 .env / DATABASE_PATH / 默认 :memory: 之外选择）。 */
  dbPath?: string;
  /**
   * 覆盖默认 rate_limit（Task 22 增补，主要用于测试）；
   * null 表示仍然走 HEARTBEAT_DEFAULT_RATE_LIMIT。
   */
  defaultRateLimit?: number | null;
}

export interface AddPluginResult {
  ok: boolean;
  /** 信息科 CLI 真正关心的字段：name / version / type / queueName / listeningPath */
  name?: string;
  version?: string;
  type?: string;
  queueName?: string | null;
  listeningPath?: string;
  installedAt?: string;
  /** Task 22：实际生效的 rate_limit（manifest 显式值 / 默认值）。 */
  rateLimit?: number | null;
  /** Task 22：rateLimit 是否由 CLI 侧自动补齐（便于排查"我明明没写却生效了"）。 */
  rateLimitInjected?: boolean;
  errors?: string[];
}

/**
 * 注册一个 plugin。
 * - 读 manifest 文件 → JSON.parse → peek 浅校验 → PluginManager.add
 * - 失败：返回 {ok:false, errors[]}
 * - 成功：返回 {ok:true, name, version, type, queueName, listeningPath, installedAt}
 */
export function addPlugin(
  manifestPath: string,
  options: AddPluginOptions = {},
): AddPluginResult {
  // 1) ensure db schema
  try {
    migrate(options.dbPath);
  } catch (err) {
    return {
      ok: false,
      errors: [`migrate failed: ${(err as Error).message}`],
    };
  }

  // 2) ensure plugin manager hydrated
  PluginManager.hydrate();

  // 3) 读 manifest 文件
  const absPath = path.resolve(manifestPath);
  if (!fs.existsSync(absPath)) {
    return { ok: false, errors: [`manifest file not found: ${absPath}`] };
  }
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [`manifest parse error: ${(err as Error).message}`],
    };
  }

  // 4) Task 22：task 类型 plugin 必须在 manifest 声明 rate_limit；缺省则注入默认值
  let rateLimitInjected = false;
  let injectedRateLimit: number | null = null;
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as { type?: unknown }).type === 'task'
  ) {
    const obj = parsed as Record<string, unknown>;
    if (obj.rate_limit === undefined || obj.rate_limit === null) {
      const defaultRate =
        options.defaultRateLimit === null
          ? null
          : options.defaultRateLimit ?? HEARTBEAT_DEFAULT_RATE_LIMIT;
      if (defaultRate !== null) {
        obj.rate_limit = defaultRate;
        rateLimitInjected = true;
        injectedRateLimit = defaultRate;
        parsed = obj;
      }
    }
  }

  // 5) 委托给 PluginManager.add（内部再做一次完整 schema 校验 + DB 落盘 + audit）
  const result = PluginManager.add(parsed);
  if (!result.ok || !result.entry) {
    return { ok: false, errors: result.errors ?? ['unknown error'] };
  }

  const manifest: PluginManifestInput = result.entry.manifest;
  return {
    ok: true,
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    queueName: manifest.queue_name,
    listeningPath: computeListeningPath(manifest),
    installedAt: result.entry.installedAt,
    rateLimit: manifest.rate_limit,
    rateLimitInjected,
    ...(rateLimitInjected ? { effectiveRateLimit: injectedRateLimit } : {}),
  };
}

export interface RemovePluginOptions {
  dbPath?: string;
}

export interface RemovePluginResult {
  ok: boolean;
  name: string;
  alreadyRemoved?: boolean;
  uninstallTriggered?: boolean;
  errors?: string[];
}

/** 卸载一个 plugin。 */
export function removePlugin(
  name: string,
  options: RemovePluginOptions = {},
): RemovePluginResult {
  try {
    migrate(options.dbPath);
  } catch (err) {
    return {
      ok: false,
      name,
      errors: [`migrate failed: ${(err as Error).message}`],
    };
  }
  PluginManager.hydrate();

  const result = PluginManager.remove(name);
  return {
    ok: result.ok,
    name,
    alreadyRemoved: result.alreadyRemoved,
    uninstallTriggered: result.uninstallTriggered,
    errors: result.errors,
  };
}

export interface ListPluginOptions {
  dbPath?: string;
}

export interface PluginListRow {
  name: string;
  version: string;
  type: string;
  queueName: string | null;
  installedAt: string;
}

/** 列出全部 plugin，返回结构化行（不含 hooks 详情，避免信息科屏幕被淹没）。 */
export function listPlugins(
  options: ListPluginOptions = {},
): PluginListRow[] {
  try {
    migrate(options.dbPath);
  } catch {
    // list 失败时返回空数组（而非抛错），让 CLI 输出空表格即可
    return [];
  }
  PluginManager.hydrate();

  return PluginManager.list().map((e) => ({
    name: e.manifest.name,
    version: e.manifest.version,
    type: e.manifest.type,
    queueName: e.manifest.queue_name,
    installedAt: e.installedAt,
  }));
}

/**
 * 把 plugin 列表渲染为对齐的 ASCII 表格（CLI stdout 输出用）。
 * 列宽根据实际内容自适应，但最小宽度满足表头。
 */
export function renderPluginTable(rows: PluginListRow[]): string {
  if (rows.length === 0) {
    return '(no plugins installed)';
  }

  const headers = ['NAME', 'VERSION', 'TYPE', 'QUEUE', 'INSTALLED_AT'] as const;
  const data = rows.map((r) => [
    r.name,
    r.version,
    r.type,
    r.queueName ?? '-',
    r.installedAt,
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );

  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const formatRow = (cells: readonly string[]) =>
    '|' +
    cells
      .map((c, i) => ' ' + c.padEnd(widths[i], ' ') + ' ')
      .join('|') +
    '|';

  const lines: string[] = [sep, formatRow(headers), sep];
  for (const row of data) {
    lines.push(formatRow(row));
  }
  // 不加末尾 sep：让 N 行 data 总输出 = 3 + N（header sep + data + sep），更符合 grep/awk 的预期
  return lines.join('\n');
}

/**
 * 根据 manifest 计算「监听路径」（声明式占位）。
 * - Hook.API → /api/plugins/<name>（dispatcher 把 router 挂到这里）
 * - Hook.Task → queue:<queue_name>（队列名）
 * - Hook.Unfurl → unfurl-registry:<name>
 * - Hook.Uninstall → (none)
 * 多 hook 时取第一个非 Uninstall。
 */
function computeListeningPath(manifest: PluginManifestInput): string {
  const hookOrder = ['api', 'unfurl', 'task', 'uninstall'] as const;
  for (const hookType of hookOrder) {
    const found = manifest.hooks.find((h) => h.type === hookType);
    if (!found) continue;
    if (hookType === 'api') {
      return `/api/plugins/${manifest.name}`;
    }
    if (hookType === 'unfurl') {
      return `unfurl-registry:${manifest.name}`;
    }
    if (hookType === 'task') {
      return manifest.queue_name
        ? `queue:${manifest.queue_name}`
        : `queue:<unnamed-for-${manifest.name}>`;
    }
  }
  return '(no listening path declared)';
}

/** CLI 命令行输出：add 成功的多行反馈。 */
export function formatAddOutput(result: AddPluginResult): string {
  if (!result.ok) {
    return `✗ plugin add failed:\n${(result.errors ?? [])
      .map((e) => `  - ${e}`)
      .join('\n')}`;
  }
  const lines = [
    `✓ plugin installed`,
    `  name:           ${result.name}`,
    `  version:        ${result.version}`,
    `  type:           ${result.type}`,
    `  queue:          ${result.queueName ?? '(none)'}`,
    `  listening path: ${result.listeningPath}`,
    `  installed at:   ${result.installedAt}`,
  ];
  // Task 22：task 类型 plugin 展示生效的 rate_limit（manifest 显式值 / 默认值）
  if (result.type === 'task') {
    const rate = result.rateLimit ?? '(unset)';
    const note = result.rateLimitInjected ? ' (CLI 注入默认值)' : '';
    lines.push(`  rate limit:     ${rate}/s${note}`);
  }
  return lines.join('\n');
}

/** CLI 命令行输出：remove 成功反馈。 */
export function formatRemoveOutput(result: RemovePluginResult): string {
  if (!result.ok) {
    return `✗ plugin remove failed:\n${(result.errors ?? [])
      .map((e) => `  - ${e}`)
      .join('\n')}`;
  }
  if (result.alreadyRemoved) {
    return `✓ plugin '${result.name}' was already removed (idempotent)`;
  }
  const uninstallLine = result.uninstallTriggered
    ? 'uninstall handler triggered'
    : 'no uninstall handler registered';
  return [
    `✓ plugin removed`,
    `  name:    ${result.name}`,
    `  status:  ${uninstallLine}`,
  ].join('\n');
}
