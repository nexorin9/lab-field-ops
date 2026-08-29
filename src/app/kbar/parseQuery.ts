// src/app/kbar/parseQuery.ts
// ⌘K 查询字符串解析器。
//
// 主路径：
//   1. trim + 折叠空白；
//   2. 空串 → []；
//   3. 单段以 `ASSET-` 开头 → instrumentId（业务侧编码如 ASSET-LAB-0142）；
//   4. 三段 `vendor/model/alarmCode`（按 `/` 切分，每段 trim）→ ParsedQuery；
//   5. 其它输入 → []（由 caller 兜底「未匹配，编辑查询」）。
//
// 设计原则（adopt outline 的「精确结构 + 失败兜底」）：
//   - 不做语义猜测：只有明确匹配上述两条规则才返回字段；
//   - 不依赖词典：避免 LLM；与 spec.md `ai_role: none` 一致；
//   - 段内可含空格（'ADVIA 2400' 原样保留）；
//   - 大小写不敏感：原样输入，命中 DB 即可。

import type { ParsedQuery } from './types.js';

/** 仪器资产编码前缀（业务侧编码，与 seed 占位 ASSET-LAB-0001..0003 对齐）。 */
export const INSTRUMENT_ID_PREFIX = 'ASSET-';

/** 单段切分键。 */
export const QUERY_DELIMITER = '/';

/** 解析结果成功与否。 */
export interface ParseQueryResult {
  ok: boolean;
  parsed: ParsedQuery[];
}

/**
 * 解析 ⌘K 查询字符串。空 / 不合法返回 { ok: false, parsed: [] }。
 * 合法的 parse 形态：
 *   - 单段 `ASSET-LAB-0142` → instrumentId
 *   - 三段 `Siemens/ADVIA 2400/W002` → vendor/model/alarmCode
 */
export function parseQuery(input: string): ParseQueryResult {
  const raw = (input ?? '').trim();
  if (!raw) {
    return { ok: false, parsed: [] };
  }

  const segments = raw
    .split(QUERY_DELIMITER)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // 规则 1：单段 ASSET-* → instrumentId
  if (segments.length === 1) {
    const [single] = segments;
    if (single.toUpperCase().startsWith(INSTRUMENT_ID_PREFIX)) {
      return {
        ok: true,
        parsed: [{ instrumentId: single, raw }],
      };
    }
    return { ok: false, parsed: [] };
  }

  // 规则 2：三段 vendor/model/alarmCode
  if (segments.length === 3) {
    const [vendor, model, alarmCode] = segments;
    if (vendor && model && alarmCode) {
      return {
        ok: true,
        parsed: [{ vendor, model, alarmCode, raw }],
      };
    }
  }

  // 其它形态（两段、四段及以上、不含 `/` 且无 ASSET- 前缀）→ 不合法
  return { ok: false, parsed: [] };
}

/** 便捷函数：返回首个解析结果或 null。 */
export function parseQueryFirst(input: string): ParsedQuery | null {
  const r = parseQuery(input);
  return r.ok ? r.parsed[0] ?? null : null;
}