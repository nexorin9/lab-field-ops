// src/server/utils/requestFilteringAgent/index.ts
// Vendored / 适配自 outline/server/utils/requestFilteringAgent/index.ts（MIT, by azu）。
//
// 目的：在检验业务现场作业系统的「厂商工单 / LIS 报告 / 校准记录 / 仪器手册」抓取场景中，
// 提供 SSRF guard（拒绝 RFC1918 / loopback / link-local / unspecified / deny 列表），
// 并允许通过 allow/deny 列表配置白名单（如 LIS 反向代理的固定出口 IP 段）。
//
// 与上游差异（adapt 调整）：
// - 不引入 upstream 的 `ipaddr.js` 依赖；改用 Node 原生 `net`（`net.isIP`）+ 自实现 IPv4 CIDR 解析
//   覆盖检验业务所需的入口用例（IPv6 子集暂不展开；上游 IPv4/v6 完整覆盖留作未来扩展）
// - 上游是 `http.Agent / https.Agent` 的 createConnection 重写；本项目是直接做 DNS 解析后逐 IP
//   校验，再走原生 fetch，避免依赖 http.Agent 与上层 fetch 的耦合
// - 主路径保留：`validateIPAddress(ip, options)→Error | undefined`，是后续 `safeFetch` 的核心
//
// 当上游升级时：diff against `github_ref/outline/server/utils/requestFilteringAgent/index.ts`，
// 把任何新增的 IPv6 / RFC 范围同步进 `privateOrMetaRange()`。

import * as net from 'node:net';

/**
 * 与 outline `RequestFilteringAgentOptions` 同构；allow/deny 优先于默认拒绝。
 *
 * - 默认 `allowPrivateIPAddress=false`、`allowMetaIPAddress=false`，deny-by-default，
 *   与 `spec.md` 安全与合规边界的 SSRF guard 一致。
 * - `allowIPAddressList` 优先（命中即放行）；`denyIPAddressList` 后置。
 */
export interface RequestFilteringAgentOptions {
  /** 放行私有/loopback/link-local；默认 false。 */
  allowPrivateIPAddress?: boolean;
  /** 放行 0.0.0.0 / ::；默认 false。 */
  allowMetaIPAddress?: boolean;
  /** 显式 allowlist（IP 或 CIDR），优先于其他规则。 */
  allowIPAddressList?: string[];
  /** 显式 denylist（IP 或 CIDR）。 */
  denyIPAddressList?: string[];
}

export const DefaultRequestFilteringAgentOptions: Required<RequestFilteringAgentOptions> =
  {
    allowPrivateIPAddress: false,
    allowMetaIPAddress: false,
    allowIPAddressList: [],
    denyIPAddressList: [],
  };

/* ──────────── IPv4 CIDR 解析（不依赖 ipaddr.js） ──────────── */

/**
 * 解析单条 CIDR 或单 IP；返回 { base, mask }；非法返回 null。
 * 仅支持 IPv4（与 `net.isIPv4` 同语义；IPv6 留给上游升级时补全）。
 */
function parseCIDR4(ipOrCIDR: string): { base: number; mask: number } | null {
  const cidrMatch = ipOrCIDR.match(/^([^/]+)\/(\d+)$/);
  let baseStr: string;
  let mask: number;
  if (cidrMatch) {
    baseStr = cidrMatch[1];
    mask = parseInt(cidrMatch[2], 10);
    if (Number.isNaN(mask) || mask < 0 || mask > 32) {
      return null;
    }
  } else {
    baseStr = ipOrCIDR;
    mask = 32;
  }
  if (net.isIPv4(baseStr) === false) {
    return null;
  }
  const parts = baseStr.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  const base =
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return { base, mask };
}

function ipToInt4(ip: string): number | null {
  if (net.isIPv4(ip) === false) {
    return null;
  }
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * IPv4 CIDR 命中判断：检查 target 是否在 cidr 范围内。
 * 与 `ipaddr.parseCIDR(cidr).contains(target)` 等价。
 */
function ipv4MatchesCIDR(targetIp: string, cidr: string): boolean {
  const target = ipToInt4(targetIp);
  const c = parseCIDR4(cidr);
  if (target === null || c === null) {
    return false;
  }
  if (c.mask === 0) {
    return true;
  }
  const mask = c.mask === 32 ? 0xffffffff : (~0 << (32 - c.mask)) >>> 0;
  return (target & mask) === (c.base & mask);
}

/**
 * 遍历 IP/CIDR 列表；对 target 是 IP 字面量直接相等比对（与 `ipOrCIDR === targetAddress.raw` 同语义）；
 * 否则按 CIDR 匹配。
 */
function matchIPAddress(
  targetAddress: string,
  ipAddressList: string[]
): boolean {
  for (const ipOrCIDR of ipAddressList) {
    if (net.isIP(ipOrCIDR) !== 0) {
      if (ipOrCIDR === targetAddress) {
        return true;
      }
    } else if (ipv4MatchesCIDR(targetAddress, ipOrCIDR)) {
      return true;
    }
  }
  return false;
}

/* ──────────── 私有 / loopback / link-local / meta 范围 ──────────── */

/**
 * 判断 IPv4 是否属于「私有 / loopback / link-local / meta」范围。
 * 与 upstream `ipaddr.js.IPv4.range()` 在 IPv4 集合上的判定等价：
 *   - 'unspecified' (0.0.0.0)
 *   - 'broadcast'  (255.255.255.255)
 *   - 'multicast'  (224.0.0.0/4)
 *   - 'linkLocal'  (169.254.0.0/16)
 *   - 'loopback'   (127.0.0.0/8)
 *   - 'private'    (10/8, 172.16/12, 192.168/16, 100.64/10 CGN, 169.254/16 部分已在 linkLocal)
 *
 * 对应关系：upstream 中这些 range 都映射到「不允许」；本函数返回 true = 命中需拒绝的集合。
 */
function isPrivateOrMetaIPv4(ip: string): boolean {
  if (net.isIPv4(ip) === false) {
    return false;
  }
  const int = ipToInt4(ip)!;
  // 0.0.0.0 unspecified
  if (int === 0) return true;
  // 127.0.0.0/8 loopback
  if ((int >>> 24) === 127) return true;
  // 10.0.0.0/8 private
  if ((int >>> 24) === 10) return true;
  // 172.16.0.0/12 private（network = 0xAC100000，mask = 0xFFF00000）
  // 注意：JS 位运算是有符号 32-bit；做 AND/比较时需用 `>>> 0` 归一为无符号
  if (((int & 0xfff00000) >>> 0) === 0xac100000) return true;
  // 192.168.0.0/16 private
  if ((int >>> 16) === 0xc0a8) return true;
  // 169.254.0.0/16 link-local
  if ((int >>> 16) === 0xa9fe) return true;
  // 100.64.0.0/10 CGN / shared address space（network = 0x64400000，mask = 0xFFC00000）
  if (((int & 0xffc00000) >>> 0) === 0x64400000) return true;
  // 224.0.0.0/4 multicast
  if ((int >>> 28) >= 14) return true;
  // 255.255.255.255 broadcast（也归入 meta/不允许集合）
  if (int === 0xffffffff) return true;
  return false;
}

/* ──────────── 公开 API：与上游同构的 validateIPAddress ──────────── */

/**
 * 校验一个已解析的 IP 是否允许连接。
 *
 * @param input `{ address, host?, family? }`，与 upstream 类型一致
 * @param options allow/deny 规则
 * @returns Error 表示拒绝，undefined 表示放行
 *
 * 主路径（与 upstream 等价）：
 *   1. 非 IP 字面量（如 unix socket）→ 放行（保留给 K8s/Pod 内部场景）
 *   2. allowlist 命中 → 放行（优先）
 *   3. allowMetaIPAddress=false 且为 unspecified/0.0.0.0 → 拒绝
 *   4. allowPrivateIPAddress=false 且命中 private/loopback/link-local/multicast → 拒绝
 *   5. denylist 命中 → 拒绝
 *   6. 其余 → 放行（公网 IP）
 */
export function validateIPAddress(
  input: { address: string; host?: string; family?: string | number },
  options: RequestFilteringAgentOptions = {}
): Error | undefined {
  const { address, host, family } = input;
  if (net.isIP(address) === 0) {
    // 非 IP 字面量（如 unix:/socket 等），交由调用方处理
    return undefined;
  }
  const resolved: Required<RequestFilteringAgentOptions> = {
    ...DefaultRequestFilteringAgentOptions,
    ...options,
  };
  try {
    // 1. allowlist 优先
    if (
      resolved.allowIPAddressList.length > 0 &&
      matchIPAddress(address, resolved.allowIPAddressList)
    ) {
      return undefined;
    }
    // 2. unspecified / meta（0.0.0.0、255.255.255.255 等「无意义地址」）
    if (!resolved.allowMetaIPAddress) {
      // IPv4 中 0.0.0.0 与 255.255.255.255 由 isPrivateOrMetaIPv4 覆盖；
      // 单独再验证 unspecified 文本以与上游日志对齐
      if (address === '0.0.0.0' || address === '::') {
        return new Error(
          `DNS lookup ${address} (family:${family}, host:${host}) is not allowed. Because, It is meta IP address.`
        );
      }
    }
    // 3. private / loopback / link-local
    if (!resolved.allowPrivateIPAddress) {
      if (net.isIPv4(address) && isPrivateOrMetaIPv4(address)) {
        return new Error(
          `DNS lookup ${address} (family:${family}, host:${host}) is not allowed. Because, It is private IP address.`
        );
      }
      // IPv6 loopback / unspecified（最常用的 ::1）也覆盖
      if (net.isIPv6(address)) {
        if (
          address === '::1' ||
          address === '::' ||
          address === 'fe80::' ||
          address.startsWith('fe80:') ||
          address.startsWith('fc') ||
          address.startsWith('fd')
        ) {
          return new Error(
            `DNS lookup ${address} (family:${family}, host:${host}) is not allowed. Because, It is private IP address.`
          );
        }
      }
    }
    // 4. denylist 后置
    if (resolved.denyIPAddressList.length > 0) {
      if (matchIPAddress(address, resolved.denyIPAddressList)) {
        return new Error(
          `DNS lookup ${address} (family:${family}, host:${host}) is not allowed. Because It is defined in denyIPAddressList.`
        );
      }
    }
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

/* ──────────── exports for testing ──────────── */

export const __internals = {
  parseCIDR4,
  ipToInt4,
  ipv4MatchesCIDR,
  isPrivateOrMetaIPv4,
  matchIPAddress,
};
