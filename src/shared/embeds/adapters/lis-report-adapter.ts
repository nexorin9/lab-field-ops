// src/shared/embeds/adapters/lis-report-adapter.ts
// LIS 报告适配器：以 accession_no（如 L20240117001）反查 LIS 报告（只读）。
//
// 主路径：lis://reports/{accession_no} → 查 emit 映射（spec.md 中的 LIS 反查 channel）→
//   safeFetch JSON → 解析为可渲染的卡片 props。
//
// 注：lis:// 非 HTTP 协议，需要走「厂商 LIS 在反查时转为 HTTPS 反向代理」的部署约定；
// 主入口 URL 形态与 `lis-report` 描述子 regex（`^lis:\\/\\/reports\\/(L\\d{8,})`）严格一致。

import { safeFetch, SSRFError } from '../../../server/utils/ssrfFetch.js';
import type { SafeFetchOptions } from '../../../server/utils/ssrfFetch.js';

export interface LisReportData {
  accessionNo: string;
  url: string;
  patientId?: string;
  specimenType?: string;
  reportedAt?: string;
  testItems?: Array<{ code: string; name: string; value: string; unit?: string }>;
}

export interface LisReportAdapterResult {
  ok: boolean;
  data?: LisReportData;
  error?: string;
  errorCode?: 'SSRF_DENIED' | 'TIMEOUT' | 'PARSE' | 'NETWORK' | 'NOT_FOUND';
}

const ACCESSION_REGEX = /^lis:\/\/reports\/(L\d{8,})\/?$/i;

export function extractAccessionNo(url: string): string | null {
  const m = url.match(ACCESSION_REGEX);
  return m ? m[1].toUpperCase() : null;
}

/**
 * LIS 反查通道由部署侧注入；测试时由 `baseUrlForTests` 模拟。
 */
export interface LisReportAdapterOptions {
  /** 把 `lis://reports/{accession}` 改为 HTTP/HTTPS 抓取的入口；部署侧配置。 */
  baseUrl?: string;
  allowlistCidr?: string[];
  timeoutMs?: number;
  /** 测试替身：传入 dnsLookup / fetchImpl。 */
  lookup?: SafeFetchOptions['lookup'];
  fetchImpl?: SafeFetchOptions['fetchImpl'];
}

export async function fetchLisReport(
  url: string,
  options: LisReportAdapterOptions = {}
): Promise<LisReportAdapterResult> {
  const accessionNo = extractAccessionNo(url);
  if (!accessionNo) {
    return { ok: false, error: 'URL 形态不匹配 LIS 报告描述子', errorCode: 'PARSE' };
  }

  const baseUrl = options.baseUrl ?? '';
  if (!baseUrl) {
    return {
      ok: false,
      error:
        'LIS 反查通道未配置 baseUrl（部署 LIS_WEBHOOK_BASE_URL 或在测试中注入）',
      errorCode: 'NOT_FOUND',
    };
  }

  const target = `${baseUrl.replace(/\/$/, '')}/reports/${accessionNo}`;
  try {
    const res = await safeFetch(target, {
      allowIPAddressList: options.allowlistCidr ?? [],
      timeoutMs: options.timeoutMs ?? 5000,
      lookup: options.lookup,
      fetchImpl: options.fetchImpl,
      fetchOptions: { headers: { Accept: 'application/json' } },
    });

    if (res.status === 404) {
      return {
        ok: false,
        error: `LIS 报告 ${accessionNo} 不存在`,
        errorCode: 'NOT_FOUND',
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        error: `LIS 反查返回 HTTP ${res.status}`,
        errorCode: 'NETWORK',
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return { ok: false, error: 'LIS 响应非 JSON', errorCode: 'PARSE' };
    }

    return {
      ok: true,
      data: {
        accessionNo,
        url,
        patientId: typeof parsed.patient_id === 'string' ? parsed.patient_id : undefined,
        specimenType: typeof parsed.specimen === 'string' ? parsed.specimen : undefined,
        reportedAt: typeof parsed.reported_at === 'string' ? parsed.reported_at : undefined,
        testItems: Array.isArray(parsed.items)
          ? parsed.items
              .map((it: any) => ({
                code: String(it.code ?? ''),
                name: String(it.name ?? ''),
                value: String(it.value ?? ''),
                unit: it.unit ? String(it.unit) : undefined,
              }))
              .filter((it: { code: string; name: string; value: string }) =>
                it.code && it.name && it.value
              )
          : undefined,
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
