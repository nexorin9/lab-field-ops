// src/shared/embeds/adapters/vendor-ticket-adapter.ts
// 厂商工单 URL 适配器：通过 SSRF-safe safeFetch 抓取工单 JSON，返回可渲染的卡片数据。
//
// 主路径与 outline 一致（参考：vendor-ticket URL → 抓 JSON → 解析为卡片 props）：
//   `vendorTicketAdapter.fetch(url)` → safeFetch → JSON.parse(title/status/owner/updatedAt)
// fail-soft：不抛错给上层，由渲染兜底为「抓取失败，请人工确认」。

import { safeFetch, SSRFError } from '../../../server/utils/ssrfFetch.js';
import type { SafeFetchOptions } from '../../../server/utils/ssrfFetch.js';

export interface VendorTicketData {
  url: string;
  ticketId: string;
  title?: string;
  status?: string;
  owner?: string;
  updatedAt?: string;
}

export interface VendorTicketAdapterResult {
  ok: boolean;
  data?: VendorTicketData;
  error?: string;
  /** 用于审计 / 看板的 SSRF 拒绝信号；与 `safeFetch` 的 SSRFError code 对齐。 */
  errorCode?: 'SSRF_DENIED' | 'TIMEOUT' | 'PARSE' | 'NETWORK';
}

const TICKET_ID_REGEX = /^(?:https?:\/\/[^/]+\/ticket\/)?(T-[A-Z0-9]+)\/?$/i;

export function extractTicketId(url: string): string | null {
  const m = url.match(TICKET_ID_REGEX);
  return m ? m[1].toUpperCase() : null;
}

/**
 * 默认 allowlist 留空 → 所有 IP 走默认 SSRF 拒绝规则（私有 / loopback / link-local 全拒）。
 * 实际部署时由 `EMBED_ALLOWLIST_CIDR` 环境变量覆盖。
 */
export interface VendorTicketAdapterOptions {
  allowlistCidr?: string[];
  timeoutMs?: number;
  /** 测试替身：传入 dnsLookup / fetchImpl。 */
  lookup?: SafeFetchOptions['lookup'];
  fetchImpl?: SafeFetchOptions['fetchImpl'];
}

export async function fetchVendorTicket(
  url: string,
  options: VendorTicketAdapterOptions = {}
): Promise<VendorTicketAdapterResult> {
  const ticketId = extractTicketId(url);
  if (!ticketId) {
    return { ok: false, error: 'URL 形态不匹配厂商工单描述子', errorCode: 'PARSE' };
  }

  try {
    const res = await safeFetch(url, {
      allowIPAddressList: options.allowlistCidr ?? [],
      timeoutMs: options.timeoutMs ?? 5000,
      lookup: options.lookup,
      fetchImpl: options.fetchImpl,
      fetchOptions: {
        headers: { Accept: 'application/json' },
      },
    });

    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        error: `工单服务返回 HTTP ${res.status}`,
        errorCode: 'NETWORK',
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return { ok: false, error: '工单服务响应非 JSON', errorCode: 'PARSE' };
    }

    return {
      ok: true,
      data: {
        url,
        ticketId,
        title: typeof parsed.title === 'string' ? parsed.title : undefined,
        status: typeof parsed.status === 'string' ? parsed.status : undefined,
        owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
        updatedAt:
          typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
      },
    };
  } catch (err: any) {
    if (err instanceof SSRFError) {
      return { ok: false, error: err.message, errorCode: 'SSRF_DENIED' };
    }
    if (err?.name === 'SafeFetchTimeoutError') {
      return { ok: false, error: err.message, errorCode: 'TIMEOUT' };
    }
    return {
      ok: false,
      error: err?.message ?? String(err),
      errorCode: 'NETWORK',
    };
  }
}
