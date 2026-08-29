// tests/ssrfCompat.test.ts
//
// SSRF guard 兼容性测试：守住 spec.md 参考地基第 6 行的关键安全行为。
//
// 与 tests/ssrf.test.ts 的差异：
//   - ssrf.test.ts 验证「主路径」（CIDR 解析、validateIPAddress、safeFetch happy/sad）
//   - ssrfCompat.test.ts 验证「边界穷举」——把各类不安全 IP 全部列出，确保未来重构不漏判；
//     同时守 DNS 多 IP 任一 deny 整体拒绝（spec.md 参考地基第 6 行的核心安全语义）
//
// 不重复 ssrf.test.ts 已覆盖的细节断言；只做补充。

import { describe, it, expect } from 'vitest';
import type { LookupAddress } from 'node:dns';
import {
  validateIPAddress,
  __internals,
  type RequestFilteringAgentOptions,
} from '../src/server/utils/requestFilteringAgent/index.js';
import {
  safeFetch,
  SSRFError,
  SafeFetchTimeoutError,
  type SafeFetchOptions,
} from '../src/server/utils/ssrfFetch.js';

const denyOnly: RequestFilteringAgentOptions = { allowPrivateIPAddress: false, allowMetaIPAddress: false };

/* ─────── 工具：构造 DNS lookup 替身 ─────── */
function fakeLookup(addrs: LookupAddress[]): SafeFetchOptions['lookup'] {
  return (async (_hostname: string, _opts?: unknown) => addrs) as SafeFetchOptions['lookup'];
}

function fakeFetchOk(body: string, status = 200): SafeFetchOptions['fetchImpl'] {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    })) as SafeFetchOptions['fetchImpl'];
}

function fakeFetchTimeout(): SafeFetchOptions['fetchImpl'] {
  return (async (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    })) as SafeFetchOptions['fetchImpl'];
}

describe('SSRF guard 兼容性 — deny IP 列表穷举', () => {
  // IPv4: loopback / RFC1918 / link-local / CGN / multicast / broadcast / unspecified
  const ipv4Deny: string[] = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.0.1', // AWS / Azure link-local
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGN
    '224.0.0.1', // multicast
    '239.255.255.255', // multicast upper
    '255.255.255.255', // broadcast
    '0.0.0.0', // unspecified
  ];

  for (const ip of ipv4Deny) {
    it(`deny ${ip}`, () => {
      const r = validateIPAddress({ address: ip, family: 4 }, denyOnly);
      expect(r).toBeInstanceOf(Error);
      expect(__internals.matchIPAddress(ip, [], [])).toBe(false);
    });
  }

  // IPv6: loopback / link-local / ULA / unspecified
  const ipv6Deny: string[] = [
    '::1', // loopback
    'fe80::1', // link-local
    'fc00::1', // ULA
    'fd00::abcd', // ULA
    '::', // unspecified
  ];

  for (const ip of ipv6Deny) {
    it(`deny ${ip}`, () => {
      const r = validateIPAddress({ address: ip, family: 6 }, denyOnly);
      expect(r).toBeInstanceOf(Error);
    });
  }
});

describe('SSRF guard 兼容性 — allow 公网 IP 列表穷举', () => {
  // 公网 IPv4
  const ipv4Allow: string[] = [
    '1.1.1.1', // Cloudflare DNS
    '8.8.8.8', // Google DNS
    '9.9.9.9', // Quad9
    '93.184.216.34', // example.com
    '140.82.112.3', // GitHub
    '151.101.0.81', // Fastly
  ];

  for (const ip of ipv4Allow) {
    it(`allow 公网 ${ip}`, () => {
      expect(validateIPAddress({ address: ip, family: 4 }, denyOnly)).toBeUndefined();
    });
  }

  it('allow 公网 2606:4700:4700::1111 (Cloudflare DNS IPv6)', () => {
    expect(
      validateIPAddress({ address: '2606:4700:4700::1111', family: 6 }, denyOnly),
    ).toBeUndefined();
  });
});

describe('SSRF guard 兼容性 — DNS 多 IP 任一 deny 整体拒绝', () => {
  it('多 IP 任一 deny → 整体拒绝', async () => {
    await expect(
      safeFetch('https://example.com/test', {
        lookup: fakeLookup([
          { address: '1.1.1.1', family: 4 },
          { address: '10.0.0.1', family: 4 }, // 内网 IP，命中 deny
        ]),
        allowIPAddressList: ['1.1.1.1/32'],
      }),
    ).rejects.toThrow(SSRFError);
  });

  it('多 IP 全 allow → 通过', async () => {
    const res = await safeFetch('https://example.com/test', {
      lookup: fakeLookup([
        { address: '1.1.1.1', family: 4 },
        { address: '1.0.0.1', family: 4 },
      ]),
      allowIPAddressList: ['1.1.1.0/24'],
      fetchImpl: fakeFetchOk('{"ok":true}', 200),
    });
    expect(res.status).toBe(200);
  });

  it('allowlist 精确 IP → DNS 返回非 allowlist 的公网 IP → 仍允许（默认公网允许）', async () => {
    // 注：safeFetch 默认允许公网 IP；allowIPAddressList 仅作为「额外放行入口」（deny-by-default 仅对私有 IP）。
    // 严格白名单需同时配置 denyIPAddressList；本测试守住当前语义。
    const res = await safeFetch('https://example.com/test', {
      lookup: fakeLookup([{ address: '8.8.8.8', family: 4 }]),
      allowIPAddressList: ['1.1.1.1/32'],
      fetchImpl: fakeFetchOk('{"ok":true}', 200),
    });
    expect(res.status).toBe(200);
  });

  it('allowlist 之外的公网 IP + denylist 命中 → 拒绝', async () => {
    // DNS 返回 8.8.8.8；allowlist 仅含 1.1.1.1；denylist 含 8.8.8.8 → 拒绝
    await expect(
      safeFetch('https://example.com/test', {
        lookup: fakeLookup([{ address: '8.8.8.8', family: 4 }]),
        allowIPAddressList: ['1.1.1.1/32'],
        denyIPAddressList: ['8.8.8.8/32'],
      }),
    ).rejects.toThrow(SSRFError);
  });

  it('DNS 多 IP 全部 deny → 整体拒绝', async () => {
    await expect(
      safeFetch('https://example.com/test', {
        lookup: fakeLookup([
          { address: '10.0.0.1', family: 4 },
          { address: '192.168.1.1', family: 4 },
        ]),
      }),
    ).rejects.toThrow(SSRFError);
  });
});

describe('SSRF guard 兼容性 — safeFetch 协议白名单', () => {
  const schemes: Array<{ url: string; expected: RegExp }> = [
    { url: 'file:///etc/passwd', expected: /protocol not allowed/i },
    { url: 'gopher://example.com/_test', expected: /protocol not allowed/i },
    { url: 'dict://example.com/test', expected: /protocol not allowed/i },
    { url: 'ftp://example.com/test', expected: /protocol not allowed/i },
    { url: 'ldap://example.com/test', expected: /protocol not allowed/i },
    { url: 'javascript:alert(1)', expected: /protocol not allowed/i },
  ];

  for (const { url, expected } of schemes) {
    it(`拒绝非 http(s) 协议: ${url}`, async () => {
      await expect(safeFetch(url)).rejects.toThrow(expected);
    });
  }
});

describe('SSRF guard 兼容性 — redirect=manual 不重试', () => {
  it('30x 跳转到内网 → safeFetch 不跟随', async () => {
    const fakeFetch: SafeFetchOptions['fetchImpl'] = (async () =>
      new Response('redirect', {
        status: 302,
        headers: { Location: 'http://10.0.0.1/admin' },
      })) as SafeFetchOptions['fetchImpl'];
    const res = await safeFetch('https://example.com/login', {
      lookup: fakeLookup([{ address: '1.1.1.1', family: 4 }]),
      allowIPAddressList: ['1.1.1.1/32'],
      fetchImpl: fakeFetch,
    });
    expect(res.status).toBe(302);
    // 若 safeFetch 跟随 30x 会对 10.0.0.1 二次请求 → 抛 SSRFError；这里 status=302 → 通过
  });
});

describe('SSRF guard 兼容性 — timeout 语义', () => {
  it('默认 5s 超时（测试加速）', async () => {
    await expect(
      safeFetch('https://example.com/test', {
        lookup: fakeLookup([{ address: '1.1.1.1', family: 4 }]),
        allowIPAddressList: ['1.1.1.1/32'],
        fetchImpl: fakeFetchTimeout(),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(SafeFetchTimeoutError);
  });
});

describe('SSRF guard 兼容性 — CIDR 解析工具', () => {
  it('parseCIDR4 4 段正确', () => {
    const cidr = __internals.parseCIDR4('10.0.0.0/8');
    expect(cidr).toEqual({ base: __internals.ipToInt4('10.0.0.0'), mask: 8 });
  });

  it('parseCIDR4 错误 CIDR 返 null', () => {
    expect(__internals.parseCIDR4('not-an-ip/24')).toBe(null);
    expect(__internals.parseCIDR4('999.999.999.999/24')).toBe(null);
  });

  it('ipv4MatchesCIDR 边界包含', () => {
    expect(__internals.ipv4MatchesCIDR('10.0.0.0', '10.0.0.0/8')).toBe(true);
    expect(__internals.ipv4MatchesCIDR('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(__internals.ipv4MatchesCIDR('11.0.0.0', '10.0.0.0/8')).toBe(false);
  });

  it('ipv4MatchesCIDR 单 IP 等价 /32', () => {
    expect(__internals.ipv4MatchesCIDR('1.1.1.1', '1.1.1.1/32')).toBe(true);
    expect(__internals.ipv4MatchesCIDR('1.1.1.2', '1.1.1.1/32')).toBe(false);
  });

  it('isPrivateOrMetaIPv4 全覆盖', () => {
    expect(__internals.isPrivateOrMetaIPv4('127.0.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('10.0.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('172.16.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('192.168.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('169.254.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('100.64.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('224.0.0.1')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('0.0.0.0')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('255.255.255.255')).toBe(true);
    expect(__internals.isPrivateOrMetaIPv4('1.1.1.1')).toBe(false);
    expect(__internals.isPrivateOrMetaIPv4('8.8.8.8')).toBe(false);
  });
});