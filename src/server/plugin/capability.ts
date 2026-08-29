// src/server/plugin/capability.ts
// Plugin capability 沙箱：在 manifest 形态校验（manifest.ts）之上做「可执行能力」
// 的二次校验。信息科通过 CLI 注册 plugin 时必须满足本层约束，否则拒绝加载。
//
// 三个核心约束：
// 1. hooks[] 中每个 hook.type 必须在白名单内（且与顶层 type 不矛盾）
// 2. 任何 hook.queue_name 必须在 queue 白名单或匹配允许的前缀
// 3. rate_limit（心跳类）必须 >= 1 且 <= 上限（避免误写 0 / 极大值导致队列阻塞）
//
// 与 manifest.ts 的关系：
//   manifest.ts 校验「JSON 形态合法」+ strict 拒绝未声明字段
//   capability.ts 校验「业务能力白名单」—— 即使 manifest 形态合法，能力越界也拒收
//
// 失败语义：
//   返回 {ok:false, errors[]}，由 PluginManager.add 透传到 CLI/REST 端点；
//   不抛错（信息科 CLI 入口期望友好的错误列表，而非 stack trace）。

import type { PluginManifestInput } from './types.js';
import type { HookType } from './hooks.js';

/** 所有合法 hook 类型白名单（顺序固定）。 */
export const ALLOWED_HOOK_TYPES: readonly HookType[] = [
  'api',
  'task',
  'unfurl',
  'uninstall',
];

/**
 * queue 名称合法形态（小写 kebab-case 风格）。
 *   - 必须以小写字母开头
 *   - 后续仅允许小写字母、数字、连字符
 *   - 长度 >= 2
 * 不要求强制含连字符（允许 'q1' / 'qr1' 等短名）—— 信息科 CLI 入口允许简短命名。
 * 防御对象：camelCase、特殊字符、纯大写、空串等异常输入。
 */
export const QUEUE_NAME_REGEX = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * 显式允许的 queue 全名（白名单形式）；用于不便用通用规则的固定命名。
 */
export const ALLOWED_QUEUE_EXACT: ReadonlySet<string> = new Set([
  'plugin-events',
  'system-tasks',
]);

/** rate_limit 上下界（次/秒）。 */
export const RATE_LIMIT_MIN = 1;
export const RATE_LIMIT_MAX = 1000;

/** capability 错误形态。 */
export interface CapabilityError {
  path: string; // 'hooks.0.type' / 'queue_name' / 'rate_limit'
  message: string;
}

export interface CapabilityResult {
  ok: boolean;
  errors: CapabilityError[];
}

/**
 * 判定一个 queue_name 是否在白名单内：
 * - 命中 ALLOWED_QUEUE_EXACT → 通过
 * - 匹配 QUEUE_NAME_REGEX（小写 kebab-case 风格，长度 2-64） → 通过
 * - 其余 → 拒绝
 */
export function isAllowedQueueName(queueName: string): boolean {
  if (ALLOWED_QUEUE_EXACT.has(queueName)) return true;
  return QUEUE_NAME_REGEX.test(queueName);
}

/**
 * 判定一个 hook type 是否在白名单内。
 * （manifest.ts 的 Zod schema 已经做过一次 enum 校验；
 *  capability 层提供独立白名单便于运行时热替换）。
 */
export function isAllowedHookType(type: string): type is HookType {
  return (ALLOWED_HOOK_TYPES as readonly string[]).includes(type);
}

/**
 * 主入口：校验 plugin 能力是否在白名单内。
 *
 * 校验项：
 * 1. manifest.hooks[] 中每个 type 必须是 ALLOWED_HOOK_TYPES
 * 2. manifest.hooks[] 中每个 queue_name（如声明）必须在 queue 白名单
 * 3. manifest.queue_name（如声明）必须在 queue 白名单
 * 4. rate_limit（如声明）必须在 [RATE_LIMIT_MIN, RATE_LIMIT_MAX] 区间
 *
 * @returns ok=true 即通过；ok=false + errors[] 列明失败项
 */
export function validateCapabilities(
  manifest: PluginManifestInput,
): CapabilityResult {
  const errors: CapabilityError[] = [];

  // 1. hooks[] type 白名单
  if (!Array.isArray(manifest.hooks)) {
    errors.push({ path: 'hooks', message: 'hooks must be an array' });
  } else {
    manifest.hooks.forEach((hook, idx) => {
      if (!isAllowedHookType(hook.type)) {
        errors.push({
          path: `hooks.${idx}.type`,
          message: `hook type '${hook.type}' is not in capability whitelist`,
        });
      }
      if (hook.queue_name !== undefined && hook.queue_name !== null) {
        if (!isAllowedQueueName(hook.queue_name)) {
          errors.push({
            path: `hooks.${idx}.queue_name`,
            message: `hook queue_name '${hook.queue_name}' is not in queue whitelist`,
          });
        }
      }
    });
  }

  // 顶层 type 也必须合法（防御 manifest.ts strict 失效场景）
  if (!isAllowedHookType(manifest.type)) {
    errors.push({
      path: 'type',
      message: `manifest type '${manifest.type}' is not in capability whitelist`,
    });
  }

  // 2. queue_name 白名单
  if (manifest.queue_name !== null && manifest.queue_name !== undefined) {
    if (!isAllowedQueueName(manifest.queue_name)) {
      errors.push({
        path: 'queue_name',
        message: `queue_name '${manifest.queue_name}' is not in queue whitelist`,
      });
    }
  }

  // 3. rate_limit 区间（心跳类）
  if (manifest.rate_limit !== null && manifest.rate_limit !== undefined) {
    if (
      !Number.isInteger(manifest.rate_limit) ||
      manifest.rate_limit < RATE_LIMIT_MIN ||
      manifest.rate_limit > RATE_LIMIT_MAX
    ) {
      errors.push({
        path: 'rate_limit',
        message: `rate_limit must be an integer in [${RATE_LIMIT_MIN}, ${RATE_LIMIT_MAX}]`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}