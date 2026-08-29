// src/server/plugin/manifest.ts
// Plugin manifest JSON schema（Zod）+ validateManifest 入口。
//
// 设计原则：
// 1. strict()：除 schema 列出的字段外，多写一个字段即视为非法
//    （避免信息科误把 `auth_secret` 写进 manifest 时被默默接受）
// 2. 字段命名稳定：与 src/shared/types.ts 的 PluginManifest 保持一致
// 3. validateManifest 返回 ok + errors[]，由 CLI/plugin add 路由统一消费

import { z } from 'zod';
import type { PluginManifestInput } from './types.js';

/** Hook 类型白名单。 */
export const PluginHookTypeSchema = z.enum(['api', 'task', 'unfurl', 'uninstall']);

/** 单个 hook 声明：type + 可选 path/queue_name。 */
export const PluginHookSpecSchema = z
  .object({
    type: PluginHookTypeSchema,
    path: z.string().min(1).optional(),
    queue_name: z.string().min(1).optional(),
  })
  .strict();

/** 鉴权声明：仅支持 token / basic，扩展类型必须显式加 schema。 */
export const PluginAuthSchema = z
  .object({
    type: z.enum(['token', 'basic']),
    token: z.string().min(1).optional(),
  })
  .strict();

/** Plugin 名称规则：小写开头 + 小写字母数字连字符（kebab-case 风格）。 */
const PLUGIN_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

/** Semver 简化版：major.minor.patch 三段数字。 */
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

/** 主 manifest schema：strict 模式拒绝未声明字段。 */
export const PluginManifestSchema = z
  .object({
    name: z
      .string()
      .min(1, 'plugin name must not be empty')
      .max(64, 'plugin name must be <= 64 chars')
      .regex(PLUGIN_NAME_REGEX, 'plugin name must match /^[a-z][a-z0-9-]*$/'),
    version: z
      .string()
      .regex(SEMVER_REGEX, 'version must be semver major.minor.patch (e.g. 1.0.0)'),
    type: PluginHookTypeSchema,
    hooks: z.array(PluginHookSpecSchema).default([]),
    queue_name: z.string().min(1).nullable().default(null),
    auth: PluginAuthSchema.nullable().default(null),
    rate_limit: z
      .number()
      .int('rate_limit must be integer')
      .positive('rate_limit must be positive')
      .nullable()
      .default(null),
  })
  .strict();

/** validateManifest 错误形态（CLI / REST 共用）。 */
export interface ManifestValidationError {
  path: string; // 'name' | 'hooks.0.path' | ...
  message: string;
}

export interface ManifestValidationResult {
  ok: boolean;
  errors: ManifestValidationError[];
  manifest?: PluginManifestInput;
}

/**
 * 校验 JSON 输入。
 * - 输入非 object → 整体错误
 * - schema mismatch → errors[]（路径 + 消息）
 * - 成功 → ok=true + 解析后的 manifest
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: '<root>', message: 'manifest must be a JSON object' }],
    };
  }

  const result = PluginManifestSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.errors.map((e) => ({
        path: e.path.length === 0 ? '<root>' : e.path.join('.'),
        message: e.message,
      })),
    };
  }

  return { ok: true, errors: [], manifest: result.data as PluginManifestInput };
}

/** 浅校验：仅检查 name/version/type 是否齐全（CLI 在 Read 之后立即给出早期错误）。 */
export function peekManifestShape(input: unknown): {
  ok: boolean;
  reason?: string;
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'manifest must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return { ok: false, reason: 'manifest.name is required' };
  }
  if (typeof obj.version !== 'string') {
    return { ok: false, reason: 'manifest.version is required' };
  }
  if (typeof obj.type !== 'string') {
    return { ok: false, reason: 'manifest.type is required' };
  }
  return { ok: true };
}
