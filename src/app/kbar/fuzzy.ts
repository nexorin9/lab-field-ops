// src/app/kbar/fuzzy.ts
// ⌘K 模糊匹配基础：
//   1. Levenshtein 距离（默认上限 1，索引业务"打错一个字符"场景）；
//   2. 按 Unicode 码点切分（中文 / emoji / surrogate pair 友好）；
//   3. 距离 → 相似度分数（0–1）；
//   4. 厂商中文桥（业务口语 → DB 内英文 vendor 名）。
//
// 与 outline 的 KBar 库差异：outline 默认走 flexsearch / Fuse.js，本项目按
//   `spec.md` 的 `ai_role: none` 立场，纯确定性匹配，无第三方模糊索引依赖。

/** 默认 Levenshtein 距离上限。超过即视为不匹配。 */
export const MAX_DISTANCE_DEFAULT = 1;

/** 业务侧口语 → DB 内 vendor 标准名（中文桥）。 */
export const VENDOR_ZH_ALIAS: Record<string, string> = {
  '西门子': 'Siemens',
  '罗氏': 'Roche',
  '雅培': 'Abbott',
  '贝克曼': 'Beckman',
};

/**
 * 把字符串拆成 Unicode 码点数组。
 * `String.prototype.split('')` 在 BMP 内 OK；非 BMP（如 emoji）会切错；
 * `Array.from(str)` 用迭代器协议，正确处理 surrogate pair 与中文。
 */
export function toCodePoints(input: string): string[] {
  if (!input) return [];
  return Array.from(input);
}

/** 小写化（用于大小写不敏感匹配；不归一化中文）。 */
export function lowerNormalize(input: string): string {
  return (input ?? '').toLowerCase();
}

/**
 * Levenshtein 距离（按 Unicode 码点）。
 * - 命中 early termination：当前行最小值已超过 max → 直接返回 max+1。
 * - 长度差超过 max → 同样立即返回 max+1。
 *
 * 返回值：
 *   - 0  = 字符串相同；
 *   - 1..max = 编辑距离；
 *   - max+1 = 不匹配（spec.md "≤ 1 容错"）。
 */
export function levenshtein(a: string, b: string, max: number = MAX_DISTANCE_DEFAULT): number {
  if (a === b) return 0;
  const A = toCodePoints(a);
  const B = toCodePoints(b);
  const la = A.length;
  const lb = B.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb > max ? max + 1 : lb;
  if (lb === 0) return la > max ? max + 1 : la;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb];
}

/** 距离 ≤ max 视为匹配（默认 1；spec.md "≤ 1 容错"）。 */
export function isFuzzyMatch(
  a: string,
  b: string,
  max: number = MAX_DISTANCE_DEFAULT
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return levenshtein(a, b, max) <= max;
}

/**
 * 距离 → 相似度分数（0–1）。
 * 距离 0 → 1.0；距离 1（max=1）→ 0.5；超过 max → 0。
 */
export function similarity(
  a: string,
  b: string,
  max: number = MAX_DISTANCE_DEFAULT
): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const d = levenshtein(a, b, max);
  if (d > max) return 0;
  // 1 - d/(max+1): max=1 → 1-1/2 = 0.5；max=2 → 1-1/3 ≈ 0.67
  return 1 - d / (max + 1);
}

/**
 * 把查询中文 / 英文 vendor 规范成 DB 内的 vendor 名（中文走 VENDOR_ZH_ALIAS 桥）。
 * 已知别名命中 → 返英文；未命中 → 返原 string（trim + 大小写不敏感）。
 */
export function canonicalVendor(q: string): string {
  if (!q) return q;
  const trimmed = q.trim();
  if (!trimmed) return trimmed;
  // 中文命中
  for (const [zh, en] of Object.entries(VENDOR_ZH_ALIAS)) {
    if (zh === trimmed) return en;
  }
  // 已是英文
  const lower = trimmed.toLowerCase();
  for (const en of Object.values(VENDOR_ZH_ALIAS)) {
    if (en.toLowerCase() === lower) return en;
  }
  return trimmed;
}
