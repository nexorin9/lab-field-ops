// src/server/plugin/types.ts
// PluginManager 内部使用的形态类型，与 src/shared/types.ts 的对外契约保持一致。

import type {
  PluginHookType,
  PluginHookSpec,
  PluginAuth,
  ISODateString,
  HashString,
} from '@shared/types.js';

/** manifest 校验通过后的标准化形态（PluginManifest 的运行时输入形态）。 */
export interface PluginManifestInput {
  name: string;
  version: string;
  type: PluginHookType;
  hooks: PluginHookSpec[];
  queue_name: string | null;
  auth: PluginAuth | null;
  rate_limit: number | null;
}

/** PluginManager 内存中的注册项。 */
export interface PluginEntry {
  manifest: PluginManifestInput;
  installedAt: ISODateString;
}

/** DB row 形态（plugin_manifest 表）。 */
export interface PluginManifestRow {
  name: string;
  version: string;
  type: string;
  hooks_json: string;
  queue_name: string | null;
  auth_json: string | null;
  rate_limit: number | null;
  installed_at: string;
}

/** add() 返回值：成功携带 entry，失败带 errors[]。 */
export interface AddResult {
  ok: boolean;
  errors?: string[];
  entry?: PluginEntry;
}

/** remove() 返回值。 */
export interface RemoveResult {
  ok: boolean;
  errors?: string[];
  uninstallTriggered?: boolean;
  alreadyRemoved?: boolean;
}

/** Manager 操作的 audit payload 形态（保留 src/shared/types.ts 中 AuditEvent 的字段子集）。 */
export interface ManagerAuditPayload {
  name: string;
  version?: string;
  type?: string;
  queue_name?: string | null;
  uninstall_triggered?: boolean;
  already_removed?: boolean;
  reason?: string;
}

/** 内部工具：计算 SHA-256 hex；用于 audit_event 的 req_hash/resp_hash。 */
export async function sha256Hex(input: string): Promise<HashString> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}
