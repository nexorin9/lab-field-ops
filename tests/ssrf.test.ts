// tests/ssrf.test.ts
// 对照 outline requestFilteringAgent 行为守住的 SSRF 兼容性测试。
//
// 关键用例（spec.md 参考地基第 6 行）：
//   - 127.0.0.1 / 10.0.0.1 / 192.168.1.1 / 169.254.169.254 全部拒绝
//   - 1.1.1.1 与公网 IP 走默认拒绝规则（无白名单）→ 在测试中通过 mock DNS 验证 happy path
//   - allowlist 通过；denylist 后置
//   - DNS 多 IP 任一被 deny 整体拒绝
//   - timeout 5s 抛 SafeFetchTimeoutError
//
// 实现说明：通过 `SafeFetchOptions.lookup / fetchImpl` 注入 DNS 与 fetch 实现，
//   避免对 `node:dns/promises` 命名空间的 spy（该命名空间在 ESM 下不可重新定义）。

import { describe, it, expect } from 'vitest';
import {
  validateIPAddress,
  __internals,
} from '../src/server/utils/requestFilteringAgent/index.js';
import {
  safeFetch,
  SSRFError,
  SafeFetchTimeoutError,
  type SafeFetchOptions,
} from '../src/server/utils/ssrfFetch.js';
import {
  fetchVendorTicket,
  extractTicketId,
} from '../src/shared/embeds/adapters/vendor-ticket-adapter.js';
import {
  fetchLisReport,
  extractAccessionNo,
} from '../src/shared/embeds/adapters/lis-report-adapter.js';
import type { LookupAddress } from 'node:dns';

/* ─────── 工具：构造 DNS lookup 替身 ─────── */
function fakeLookup(addrs: LookupAddress[]): SafeFetchOptions['lookup'] {
  return (async (_hostname: string, _opts?: any) => addrs) as any;
}

/* ─────── 工具：构造 fetch 替身 ─────── */
type FetchMock = SafeFetchOptions['fetchImpl'];

function fakeFetchOk(body: string, status = 200): FetchMock {
  return (async (_url: any, init?: any) => {
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
}

function fakeFetchTimeout(): FetchMock {
  return (async (_url: any, init?: any) => {
    return new Promise((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      );
    });
  }) as any;
}

describe('parseCIDR4 / ipToInt4 / ipv4MatchesCIDR', () => {
  it('ipToInt4 把点分十进制转 32-bit 整数', () => {
    expect(__internals.ipToInt4('0.0.0.0')).toBe(0);
    expect(__internals.ipToInt4('255.255.255.255')).toBe(0xffffffff);
    expect(__internals.ipToInt4('192.168.1.1')).toBe(0xc0a80101);
    expect(__internals.ipToInt4('10.0.0.1')).toBe(0x0a000001);
    expect(__internals.ipToInt4('not.an.ip.addr')).toBeNull();
  });

  it('parseCIDR4 合法 CIDR 与非法 CIDR', () => {
    const c1 = __internals.parseCIDR4('10.0.0.0/8')!;
    expect(c1.base).toBe(0x0a000000);
    expect(c1.mask).toBe(8);
    const c2 = __internals.parseCIDR4('192.168.1.0/24')!;
    expect(c2.base).toBe(0xc0a80100);
    expect(c2.mask).toBe(24);
    expect(__internals.parseCIDR4('10.0.0.1')).not.toBeNull();
    expect(__internals.parseCIDR4('abc')).toBeNull();
    expect(__internals.parseCIDR4('10.0.0.0/33')).toBeNull();
  });

  it('ipv4MatchesCIDR 真命中与假命中', () => {
    expect(__internals.ipv4MatchesCIDR('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(__internals.ipv4MatchesCIDR('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(__internals.ipv4MatchesCIDR('192.168.1.42', '192.168.0.0/16')).toBe(true);
    expect(__internals.ipv4MatchesCIDR('192.169.1.42', '192.168.0.0/16')).toBe(false);
  });
});

describe('isPrivateOrMetaIPv4 范围判定', () => {
  it('loopback / private / link-local / multicast / unspecified 全部 true', () => {
    expect(__internals.isPrivateOrMetaIPv4('127.0.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('127.255.255.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('10.0.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('172.16.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('172.31.255.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('192.168.1.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('169.254.169.254')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('100.64.0.1')).toBe(true); // CGN
    expect(__internals.isPrivateOrMetaIPv4('224.0.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('0.0.0.0')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('255.255.255.255')).toBe(true);
  });

  it('公网 IP 全部 false', () => {
    expect(__internals.isPrivateOrMetaIPv4('8.8.8.8')).toBe(false);
    expect(__internals.isPrivateOrMetaIPv4('1.1.1.1')).toBe(false);
    expect(__internals.isPrivateOrMetaIPv4('172.32.0.1')).toBe(false); // 172.16/12 之外
    expect(__internals.isPrivateOrMetaIPv4('11.0.0.1')).toBe(false);
    expect(__internals.isPrivateOrMetaIPv4('169.255.0.1')).toBe(false); // 169.254/16 之外
  });
});

describe('validateIPAddress（与 outline RequestFilteringAgent 主路径对齐）', () => {
  it('非 IP 字面量直接放行', () => {
    expect(validateIPAddress({ address: 'unix:/var/run/socket' })).toBeUndefined();
  });

  it('deny loopback / RFC1918 / link-local / unspecified', () => {
    expect(validateIPAddress({ address: '127.0.0.1', host: 'x' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: '10.0.0.1', host: 'x' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: '192.168.1.1', host: 'x' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: '169.254.169.254', host: 'x' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: '0.0.0.0', host: 'x' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: '255.255.255.255', host: 'x' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: '172.16.0.1', host: 'x' })).toBeInstanceOf(Error);
  });

  it('公网 IP 在默认规则下放行', () => {
    expect(validateIPAddress({ address: '1.1.1.1', host: 'cloudflare-dns.com' })).toBeUndefined();
    expect(validateIPAddress({ address: '8.8.8.8', host: 'dns.google' })).toBeUndefined();
  });

  it('allowPrivateIPAddress=true 时 loopback 放行', () => {
    expect(
      validateIPAddress({ address: '127.0.0.1' }, { allowPrivateIPAddress: true })
    ).toBeUndefined();
  });

  it('allowlist 优先于默认拒绝', () => {
    const result = validateIPAddress(
      { address: '10.0.0.5', host: 'lis-proxy' },
      { allowIPAddressList: ['10.0.0.0/8'] }
    );
    expect(result).toBeUndefined();
  });

  it('denylist 后置：allowlist 之外的 IP 命中 denylist 被拒', () => {
    const result = validateIPAddress(
      { address: '8.8.8.8', host: 'x' },
      { denyIPAddressList: ['8.8.8.0/24'] }
    );
    expect(result).toBeInstanceOf(Error);
  });

  it('denylist CIDR 匹配', () => {
    expect(
      validateIPAddress(
        { address: '203.0.113.42' },
        { denyIPAddressList: ['203.0.113.0/24'] }
      )
    ).toBeInstanceOf(Error);
    expect(
      validateIPAddress(
        { address: '203.0.114.1' },
        { denyIPAddressList: ['203.0.113.0/24'] }
      )
    ).toBeUndefined();
  });

  it('IPv6 loopback / link-local / ULA 拒绝', () => {
    expect(validateIPAddress({ address: '::1' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: '::' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: 'fe80::1' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: 'fc00::1' })).toBeInstanceOf(Error);
    expect(validateIPAddress({ address: 'fd00::1' })).toBeInstanceOf(Error);
  });
});

describe('safeFetch 的协议与拒绝语义', () => {
  it('拒绝非 http/https 协议', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/protocol/i);
    await expect(safeFetch('lis://reports/L20240117001')).rejects.toThrow(/protocol/i);
  });

  it('拒绝 loopback / RFC1918 主机名（注入 DNS 到 127.0.0.1 触发 SSRFError）', async () => {
    const lookup = fakeLookup([{ address: '127.0.0.1', family: 4 }]);
    const promise = safeFetch('http://internal.host/', { lookup });
    await expect(promise).rejects.toBeInstanceOf(SSRFError);
    await expect(promise).rejects.toThrow(/127/);
  });

  it('allowlist 通过：DNS mock 走 1.1.1.1 + allowIPAddressList 放行', async () => {
    const lookup = fakeLookup([{ address: '1.1.1.1', family: 4 }]);
    const fetchImpl = fakeFetchOk('{"hello":1}');
    const res = await safeFetch('http://example.com/', {
      allowIPAddressList: ['1.1.1.1'],
      lookup,
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"hello":1}');
  });

  it('DNS 多 IP 任一被 deny 整体拒绝', async () => {
    const lookup = fakeLookup([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(
      safeFetch('http://multi.example/', {
        allowIPAddressList: ['1.1.1.1'],
        lookup,
      })
    ).rejects.toBeInstanceOf(SSRFError);
  });

  it('DNS 解析返回空数组 → 抛 SSRFError', async () => {
    const lookup = fakeLookup([]);
    await expect(
      safeFetch('http://empty.example/', { lookup })
    ).rejects.toBeInstanceOf(SSRFError);
  });

  it('timeoutMs 到期抛 SafeFetchTimeoutError', async () => {
    const lookup = fakeLookup([{ address: '1.1.1.1', family: 4 }]);
    const fetchImpl = fakeFetchTimeout();
    await expect(
      safeFetch('http://slow.example/', {
        allowIPAddressList: ['1.1.1.1'],
        lookup,
        fetchImpl,
        timeoutMs: 50,
      })
    ).rejects.toBeInstanceOf(SafeFetchTimeoutError);
  });
});

describe('vendor-ticket-adapter', () => {
  it('extractTicketId 真/假命中', () => {
    expect(extractTicketId('https://vendor.example.com/ticket/T-ABC123')).toBe('T-ABC123');
    expect(extractTicketId('https://svc.vendor.com/ticket/T-X1')).toBe('T-X1');
    expect(extractTicketId('https://example.com/foo')).toBeNull();
  });

  it('URL 不匹配描述子时返 ok=false errorCode=PARSE', async () => {
    const r = await fetchVendorTicket('https://example.com/foo');
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('PARSE');
  });

  it('DNS 解析到 loopback 时返 errorCode=SSRF_DENIED', async () => {
    const lookup = fakeLookup([{ address: '127.0.0.1', family: 4 }]);
    const r = await fetchVendorTicket('https://vendor.example.com/ticket/T-LOOP1', {
      lookup,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('SSRF_DENIED');
  });

  it('公网 IP + allowlist → 抓取成功', async () => {
    const lookup = fakeLookup([{ address: '1.1.1.1', family: 4 }]);
    const fetchImpl = fakeFetchOk(
      JSON.stringify({
        title: '试剂仓温度异常 - W002',
        status: 'open',
        owner: '张工',
        updated_at: '2026-08-29T10:00:00Z',
      })
    );
    const r = await fetchVendorTicket('https://vendor.example.com/ticket/T-HAPPY1', {
      allowlistCidr: ['1.1.1.1'],
      lookup,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.ticketId).toBe('T-HAPPY1');
    expect(r.data?.title).toContain('W002');
    expect(r.data?.owner).toBe('张工');
  });

  it('工单服务返回非 JSON → errorCode=PARSE', async () => {
    const lookup = fakeLookup([{ address: '1.1.1.1', family: 4 }]);
    const fetchImpl = fakeFetchOk('<html>not json</html>');
    const r = await fetchVendorTicket('https://vendor.example.com/ticket/T-BADJSON', {
      allowlistCidr: ['1.1.1.1'],
      lookup,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('PARSE');
  });
});

describe('lis-report-adapter', () => {
  it('extractAccessionNo 真/假命中', () => {
    expect(extractAccessionNo('lis://reports/L20240117001')).toBe('L20240117001');
    expect(extractAccessionNo('lis://reports/L20240117001/')).toBe('L20240117001');
    expect(extractAccessionNo('lis://reports/short')).toBeNull();
    expect(extractAccessionNo('https://example.com/')).toBeNull();
  });

  it('未配置 baseUrl → NOT_FOUND', async () => {
    const r = await fetchLisReport('lis://reports/L20240117001');
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('NOT_FOUND');
  });

  it('baseUrl 指向 loopback 默认拒绝 → SSRF_DENIED', async () => {
    const lookup = fakeLookup([{ address: '127.0.0.1', family: 4 }]);
    const r = await fetchLisReport('lis://reports/L20240117001', {
      baseUrl: 'http://127.0.0.1:8080',
      allowlistCidr: [],
      lookup,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('SSRF_DENIED');
  });

  it('公网 baseUrl + allowlist → 抓取成功并解析 testItems', async () => {
    const lookup = fakeLookup([{ address: '1.1.1.1', family: 4 }]);
    const fetchImpl = fakeFetchOk(
      JSON.stringify({
        patient_id: 'PATIENT-PLACEHOLDER-001',
        specimen: '血清',
        reported_at: '2026-08-29T11:30:00Z',
        items: [
          { code: 'GLU', name: '葡萄糖', value: '5.6', unit: 'mmol/L' },
          { code: 'ALT', name: '丙氨酸氨基转移酶', value: '24', unit: 'U/L' },
        ],
      })
    );
    const r = await fetchLisReport('lis://reports/L20240117001', {
      baseUrl: 'http://lis.example.com',
      allowlistCidr: ['1.1.1.1'],
      lookup,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.accessionNo).toBe('L20240117001');
    expect(r.data?.specimenType).toBe('血清');
    expect(r.data?.testItems?.length).toBe(2);
    expect(r.data?.testItems?.[0].code).toBe('GLU');
  });

  it('LIS 返回 404 → errorCode=NOT_FOUND', async () => {
    const lookup = fakeLookup([{ address: '1.1.1.1', family: 4 }]);
    const fetchImpl = fakeFetchOk('not found', 404);
    const r = await fetchLisReport('lis://reports/L2024040110', {
      baseUrl: 'http://lis.example.com',
      allowlistCidr: ['1.1.1.1'],
      lookup,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('NOT_FOUND');
  });
});
