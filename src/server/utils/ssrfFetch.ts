// src/server/utils/ssrfFetch.ts
// SSRF-safe fetch：先用 `validateIPAddress` 逐 IP 校验，再走原生 fetch（Node 18+/20+ 自带）。
// 主路径：URL 解析 → DNS 解析（resolve4/6）→ 对每个 IP 走 allow/deny 校验 → 全允许则发起 fetch。
//
// 这是 outline `requestFilteringAgent` 与本项目 `safeFetch` 之间的中间层，
// 给 `vendor-ticket-adapter`、`lis-report-adapter`、`calibration-record-adapter`、
// `instrument-manual-adapter` 共用。

import { lookup as dnsLookup } from 'node:dns/promises';
import {
  validateIPAddress,
  type RequestFilteringAgentOptions,
} from './requestFilteringAgent/index.js';

type DnsLookupFn = typeof import('node:dns/promises').lookup;

/** SSRF 拒绝原因，含上游的 error message 以便审计日志一眼可见。 */
export class SSRFError extends Error {
  readonly code = 'SSRF_DENIED';
  constructor(message: string, public readonly host: string, public readonly resolvedIp?: string) {
    super(message);
    this.name = 'SSRFError';
  }
}

/** fetch 超时；与浏览器 AbortSignal.timeout 等价。 */
export class SafeFetchTimeoutError extends Error {
  readonly code = 'TIMEOUT';
  constructor(public readonly timeoutMs: number, public readonly url: string) {
    super(`SafeFetch timeout after ${timeoutMs}ms for ${url}`);
    this.name = 'SafeFetchTimeoutError';
  }
}

export interface SafeFetchOptions extends RequestFilteringAgentOptions {
  /** 默认 5000ms；abort 时抛 SafeFetchTimeoutError。 */
  timeoutMs?: number;
  /** fetch 的额外选项（method / headers / body）。 */
  fetchOptions?: RequestInit;
  /** 强制仅走 IPv4；默认 true（与上游默认对齐，IPv6 留扩展）。 */
  ipv4Only?: boolean;
  /** 测试替身：注入 DNS 解析函数。 */
  lookup?: DnsLookupFn;
  /** 测试替身：注入 fetch 实现；默认走原生 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
}

/**
 * SSRF-safe fetch：先 DNS 解析，逐 IP 走 allow/deny 校验，再走原生 fetch。
 *
 * 任一解析出的 IP 被拒绝 → 抛 SSRFError；
 * timeoutMs 到期未完成 → 抛 SafeFetchTimeoutError；
 * 其余错误透传。
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResponse> {
  const {
    timeoutMs = 5000,
    fetchOptions,
    ipv4Only = true,
    fetchImpl,
    ...filterOpts
  } = options;
  const fetchFn: typeof fetch = fetchImpl ?? fetch;

  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFError(
      `URL protocol not allowed: ${parsed.protocol}`,
      parsed.hostname
    );
  }

  // DNS 解析为 IP 字面量，绕过「URL → IP → 重定向到内网」的攻击路径
  const addresses = await (filterOpts.lookup ?? dnsLookup)(parsed.hostname, {
    all: true,
    family: ipv4Only ? 4 : 0,
  });
  if (addresses.length === 0) {
    throw new SSRFError(
      `DNS lookup returned no addresses for ${parsed.hostname}`,
      parsed.hostname
    );
  }

  // 逐 IP 校验；任一 deny 则整体拒绝（与上游 makeLookup 策略对齐）
  for (const a of addresses) {
    const verdict = validateIPAddress(
      { address: a.address, family: a.family, host: parsed.hostname },
      filterOpts
    );
    if (verdict) {
      throw new SSRFError(
        verdict.message,
        parsed.hostname,
        a.address
      );
    }
  }

  // 全部通过 → 走原生 fetch；用 AbortController 处理超时
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(parsed.toString(), {
      ...fetchOptions,
      signal: controller.signal,
      redirect: 'manual', // 不自动追踪重定向，重定向本身也可能转到内网
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = await res.text();
    return {
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      finalUrl: res.url,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new SafeFetchTimeoutError(timeoutMs, url);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
