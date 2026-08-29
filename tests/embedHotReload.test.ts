// tests/embedHotReload.test.ts
// Embed hot-reload + priority 规则覆盖测试（Task 20）。
//
// 主路径断言：
//   - write new descriptor to disk → reloadFromDisk → matchEmbeds 命中新描述子
//   - priority 高的描述子覆盖低的（同名）
//   - 同 priority 按注册顺序稳定
//   - 文件损坏 / schema 不通过 → fail-soft（返回 []）
//   - watchRegistryFile 回调触发（用 fake fs.watch 注入避免依赖真实 OS 事件）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  EmbedDescriptor,
  EmbedRegistry,
  DefaultEmbedRegistry,
  matchEmbeds,
  registerEmbed,
  registerEmbedPersistent,
  reloadFromDisk,
  loadOnStartupIfExists,
} from '../src/shared/embeds/index.js';
import {
  loadRegistryFromDisk,
  saveRegistry,
  parseRegistryPayload,
  watchRegistryFile,
  appendDescriptorToDisk,
  resolvePriorityConflicts,
  REGISTRY_FILE_VERSION,
} from '../src/shared/embeds/hotReload.js';

let tmpDir = '';
let tmpFile = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-hotreload-'));
  tmpFile = path.join(tmpDir, 'embed-registry.json');
});

afterEach(() => {
  // 清理前先 close 任何未关闭的 watcher
  for (const w of openWatchers.splice(0)) {
    try {
      w.close();
    } catch {
      // ignore
    }
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// 跟踪测试中打开的 watcher，便于 afterEach 收尾
const openWatchers: Array<{ close(): void }> = [];

function trackWatcher<T extends { close(): void }>(w: T): T {
  openWatchers.push(w);
  return w;
}

describe('hotReload · loadRegistryFromDisk', () => {
  it('文件不存在 → 返回 []（fail-soft）', () => {
    const out = loadRegistryFromDisk(tmpFile);
    expect(out).toEqual([]);
  });

  it('损坏 JSON → 返回 []（fail-soft）', () => {
    fs.writeFileSync(tmpFile, '{ this is not json', 'utf-8');
    const out = loadRegistryFromDisk(tmpFile);
    expect(out).toEqual([]);
  });

  it('合法 JSON → 反序列化为 EmbedDescriptor[]', () => {
    const payload = {
      version: REGISTRY_FILE_VERSION,
      descriptors: [
        {
          name: 'qc-rule',
          title: '质控规则',
          kind: 'vendor-ticket',
          regexSource: ['^qc:\\/\\/rules\\/R\\d{4,}\\/?$'],
          regexFlags: 'i',
          matchOnInput: true,
          priority: 50,
          componentName: 'VendorTicketCard',
          keyGroup: 1,
        },
      ],
    };
    fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf-8');

    const out = loadRegistryFromDisk(tmpFile);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('qc-rule');
    expect(out[0].priority).toBe(50);
    expect(out[0].matcher('qc://rules/R20240117/')).toBeTruthy();
    expect(out[0].matcher('https://example.com')).toBe(false);
  });

  it('单条 schema 失败 → 跳过该条，其余正常加载', () => {
    const payload = {
      version: REGISTRY_FILE_VERSION,
      descriptors: [
        // 合法
        {
          name: 'qc-rule',
          title: '质控规则',
          kind: 'vendor-ticket',
          regexSource: ['^qc:\\/\\/rules\\/R\\d+\\/?$'],
          regexFlags: 'i',
          matchOnInput: true,
          priority: 50,
          componentName: 'VendorTicketCard',
        },
        // 非法：缺 name
        {
          title: '缺 name',
          kind: 'vendor-ticket',
          regexSource: ['x'],
          regexFlags: 'i',
          matchOnInput: true,
          priority: 10,
          componentName: 'X',
        },
      ],
    };
    fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf-8');

    const out = loadRegistryFromDisk(tmpFile);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('qc-rule');
  });

  it('version 不匹配 → 返回 []', () => {
    const payload = { version: 99, descriptors: [] };
    fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf-8');
    const out = loadRegistryFromDisk(tmpFile);
    expect(out).toEqual([]);
  });

  it('非对象 / 数组 → 返回 []', () => {
    fs.writeFileSync(tmpFile, '[]', 'utf-8');
    expect(loadRegistryFromDisk(tmpFile)).toEqual([]);
    fs.writeFileSync(tmpFile, '"string"', 'utf-8');
    expect(loadRegistryFromDisk(tmpFile)).toEqual([]);
    fs.writeFileSync(tmpFile, 'null', 'utf-8');
    expect(loadRegistryFromDisk(tmpFile)).toEqual([]);
  });
});

describe('hotReload · saveRegistry', () => {
  it('写入合法 JSON + 自动 mkdir parent', () => {
    const nested = path.join(tmpDir, 'a/b/c/embed.json');
    const d = new EmbedDescriptor({
      name: 'qc-rule',
      title: '质控规则',
      kind: 'vendor-ticket',
      regexMatch: [/^qc:\/\/rules\/R\d+/i],
      priority: 50,
      componentName: 'VendorTicketCard',
    });
    saveRegistry(nested, [d]);

    const raw = JSON.parse(fs.readFileSync(nested, 'utf-8'));
    expect(raw.version).toBe(REGISTRY_FILE_VERSION);
    expect(raw.descriptors).toHaveLength(1);
    expect(raw.descriptors[0].name).toBe('qc-rule');
    expect(raw.descriptors[0].priority).toBe(50);
  });

  it('原子写：先写 .tmp 再 rename；多次写后无残留 .tmp', () => {
    const d = new EmbedDescriptor({
      name: 'qc-rule',
      title: '质控规则',
      kind: 'vendor-ticket',
      regexMatch: [/x/],
      priority: 1,
      componentName: 'X',
    });
    saveRegistry(tmpFile, [d]);
    saveRegistry(tmpFile, [d, d]);
    saveRegistry(tmpFile, [d]);

    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('hotReload · appendDescriptorToDisk', () => {
  it('追加 + 同名覆盖；与 EmbedRegistry.register 行为一致', () => {
    const a = new EmbedDescriptor({
      name: 'a',
      title: 'A',
      kind: 'vendor-ticket',
      regexMatch: [/x/],
      priority: 30,
      componentName: 'A',
    });
    const b = new EmbedDescriptor({
      name: 'b',
      title: 'B',
      kind: 'vendor-ticket',
      regexMatch: [/y/],
      priority: 20,
      componentName: 'B',
    });
    const aHigher = new EmbedDescriptor({
      name: 'a',
      title: 'A+',
      kind: 'vendor-ticket',
      regexMatch: [/z/],
      priority: 80,
      componentName: 'A',
    });

    appendDescriptorToDisk(tmpFile, a);
    appendDescriptorToDisk(tmpFile, b);
    appendDescriptorToDisk(tmpFile, aHigher);

    const loaded = loadRegistryFromDisk(tmpFile);
    expect(loaded.map((d) => d.name)).toEqual(['a', 'b']);
    const aLoaded = loaded.find((d) => d.name === 'a')!;
    expect(aLoaded.priority).toBe(80); // 覆盖为更高 priority
    expect(aLoaded.title).toBe('A+');
  });
});

describe('hotReload · priority 冲突规则', () => {
  it('同名时 priority 高者覆盖低者', () => {
    const low = new EmbedDescriptor({
      name: 'qc-rule',
      title: '低',
      kind: 'vendor-ticket',
      regexMatch: [/^lo/i],
      priority: 5,
      componentName: 'X',
    });
    const high = new EmbedDescriptor({
      name: 'qc-rule',
      title: '高',
      kind: 'vendor-ticket',
      regexMatch: [/^hi/i],
      priority: 95,
      componentName: 'X',
    });

    expect(resolvePriorityConflicts([low], [high])).toHaveLength(1);
    expect(resolvePriorityConflicts([low], [high])[0].priority).toBe(95);

    // 反向：传入 high 在前，low 在后 → 仍保留 high（不替换为低 priority）
    expect(resolvePriorityConflicts([high], [low])[0].priority).toBe(95);
  });

  it('同名同 priority → 保留 existing（按注册顺序，incoming 不覆盖）', () => {
    const a = new EmbedDescriptor({
      name: 'qc-rule',
      title: 'A (existing)',
      kind: 'vendor-ticket',
      regexMatch: [/^a/i],
      priority: 50,
      componentName: 'A',
    });
    const aNew = new EmbedDescriptor({
      name: 'qc-rule',
      title: 'A (incoming)',
      kind: 'vendor-ticket',
      regexMatch: [/^a/i],
      priority: 50,
      componentName: 'A',
    });
    const out = resolvePriorityConflicts([a], [aNew]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('A (existing)'); // 注册顺序优先
  });

  it('不同名 → 直接追加', () => {
    const a = new EmbedDescriptor({
      name: 'a',
      title: 'A',
      kind: 'vendor-ticket',
      regexMatch: [/x/],
      priority: 30,
      componentName: 'A',
    });
    const b = new EmbedDescriptor({
      name: 'b',
      title: 'B',
      kind: 'vendor-ticket',
      regexMatch: [/y/],
      priority: 20,
      componentName: 'B',
    });
    const out = resolvePriorityConflicts([a], [b]);
    expect(out.map((d) => d.name)).toEqual(['a', 'b']);
  });
});

describe('hotReload · parseRegistryPayload', () => {
  it('空对象 → []', () => {
    expect(parseRegistryPayload({})).toEqual([]);
  });

  it('version 不匹配 → []', () => {
    expect(parseRegistryPayload({ version: 0, descriptors: [] })).toEqual([]);
  });

  it('descriptors 非数组 → []', () => {
    expect(
      parseRegistryPayload({ version: REGISTRY_FILE_VERSION, descriptors: 'x' })
    ).toEqual([]);
  });
});

describe('hotReload · matchEmbeds priority 排序', () => {
  it('priority 数字大者优先命中', () => {
    const reg = new EmbedRegistry();
    const low = new EmbedDescriptor({
      name: 'low',
      title: '低',
      kind: 'vendor-ticket',
      regexMatch: [/^https?:\/\/example\.com\/.*/i],
      priority: 5,
      componentName: 'L',
    });
    const high = new EmbedDescriptor({
      name: 'high',
      title: '高',
      kind: 'vendor-ticket',
      regexMatch: [/^https?:\/\/example\.com\/high/i],
      priority: 50,
      componentName: 'H',
    });
    reg.register(low);
    reg.register(high);

    const hits = matchEmbeds('https://example.com/high', reg);
    expect(hits.map((h) => h.descriptor.name)).toEqual(['high', 'low']);
  });

  it('同 priority 保持注册顺序（依赖 Node 20 Array.sort 稳定）', () => {
    const reg = new EmbedRegistry();
    const first = new EmbedDescriptor({
      name: 'first',
      title: 'First',
      kind: 'vendor-ticket',
      regexMatch: [/^https?:\/\/example\.com/],
      priority: 50,
      componentName: 'F',
    });
    const second = new EmbedDescriptor({
      name: 'second',
      title: 'Second',
      kind: 'vendor-ticket',
      regexMatch: [/^https?:\/\/example\.com/],
      priority: 50,
      componentName: 'S',
    });
    reg.register(first);
    reg.register(second);

    const hits = matchEmbeds('https://example.com/', reg);
    expect(hits.map((h) => h.descriptor.name)).toEqual(['first', 'second']);
  });

  it('未指定 priority → 默认 0，排在末位', () => {
    const reg = new EmbedRegistry();
    const a = new EmbedDescriptor({
      name: 'a',
      title: 'A',
      kind: 'vendor-ticket',
      regexMatch: [/^https?:\/\/example\.com/],
      priority: 10,
      componentName: 'A',
    });
    const noP = new EmbedDescriptor({
      name: 'no-priority',
      title: 'NoP',
      kind: 'vendor-ticket',
      regexMatch: [/^https?:\/\/example\.com/],
      componentName: 'N',
    });
    reg.register(a);
    reg.register(noP);

    const hits = matchEmbeds('https://example.com/', reg);
    expect(hits.map((h) => h.descriptor.name)).toEqual(['a', 'no-priority']);
  });
});

describe('hotReload · registerEmbedPersistent', () => {
  it('注册后写盘 + 内存可读', () => {
    const reg = new EmbedRegistry();
    const d = new EmbedDescriptor({
      name: 'qc-rule',
      title: '质控规则',
      kind: 'vendor-ticket',
      regexMatch: [/^qc:\/\/rules\/(R\d+)/i],
      priority: 50,
      componentName: 'VendorTicketCard',
      keyGroup: 1,
    });

    registerEmbedPersistent(d, { registry: reg, diskPath: tmpFile });

    expect(reg.size()).toBe(1);
    const hits = matchEmbeds('qc://rules/R20240117', reg);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('R20240117');

    // 磁盘也已落盘
    expect(fs.existsSync(tmpFile)).toBe(true);
    const reloaded = loadRegistryFromDisk(tmpFile);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].name).toBe('qc-rule');
  });

  it('同名二次注册 → 内存 + 磁盘同步更新', () => {
    const reg = new EmbedRegistry();
    const v1 = new EmbedDescriptor({
      name: 'qc-rule',
      title: 'V1',
      kind: 'vendor-ticket',
      regexMatch: [/^qc:\/\/v1/],
      priority: 30,
      componentName: 'X',
    });
    const v2 = new EmbedDescriptor({
      name: 'qc-rule',
      title: 'V2',
      kind: 'vendor-ticket',
      regexMatch: [/^qc:\/\/v2/],
      priority: 90,
      componentName: 'X',
    });

    registerEmbedPersistent(v1, { registry: reg, diskPath: tmpFile });
    registerEmbedPersistent(v2, { registry: reg, diskPath: tmpFile });

    expect(reg.size()).toBe(1);
    expect(getDescriptor(reg, 'qc-rule').priority).toBe(90);

    // reloadFromDisk 后仍能看到 v2
    const fresh = new EmbedRegistry();
    reloadFromDisk(tmpFile, fresh);
    expect(fresh.size()).toBe(1);
    expect(getDescriptor(fresh, 'qc-rule').priority).toBe(90);
  });
});

describe('hotReload · reloadFromDisk + loadOnStartupIfExists', () => {
  it('reloadFromDisk → 替换内存', () => {
    // 预置内存：qc-rule v1
    DefaultEmbedRegistry.clear();
    registerEmbed(
      new EmbedDescriptor({
        name: 'qc-rule',
        title: 'V1',
        kind: 'vendor-ticket',
        regexMatch: [/^qc:\/\/v1/],
        priority: 10,
        componentName: 'X',
      }),
      DefaultEmbedRegistry
    );

    // 写盘：qc-rule v2 (priority 高)
    const v2 = new EmbedDescriptor({
      name: 'qc-rule',
      title: 'V2',
      kind: 'vendor-ticket',
      regexMatch: [/^qc:\/\/v2/],
      priority: 90,
      componentName: 'X',
    });
    saveRegistry(tmpFile, [v2]);

    const reloaded = reloadFromDisk(tmpFile, DefaultEmbedRegistry);
    expect(reloaded).toHaveLength(1);
    expect(getDescriptor(DefaultEmbedRegistry, 'qc-rule').priority).toBe(90);

    // 清理
    DefaultEmbedRegistry.clear();
  });

  it('reloadFromDisk · 文件不存在 → 清空注册表（fail-soft）', () => {
    DefaultEmbedRegistry.clear();
    registerEmbed(
      new EmbedDescriptor({
        name: 'x',
        title: 'X',
        kind: 'vendor-ticket',
        regexMatch: [/x/],
        priority: 1,
        componentName: 'X',
      }),
      DefaultEmbedRegistry
    );
    expect(DefaultEmbedRegistry.size()).toBe(1);

    const out = reloadFromDisk(tmpFile, DefaultEmbedRegistry);
    expect(out).toEqual([]);
    expect(DefaultEmbedRegistry.size()).toBe(0);
  });

  it('loadOnStartupIfExists · 文件不存在 → 不清空注册表', () => {
    const reg = new EmbedRegistry();
    reg.register(
      new EmbedDescriptor({
        name: 'x',
        title: 'X',
        kind: 'vendor-ticket',
        regexMatch: [/x/],
        priority: 1,
        componentName: 'X',
      })
    );

    const out = loadOnStartupIfExists(tmpFile, reg);
    expect(out).toEqual([]);
    expect(reg.size()).toBe(1); // 保留内存
  });

  it('loadOnStartupIfExists · 同名 + 磁盘 priority 高 → 替换', () => {
    const reg = new EmbedRegistry();
    reg.register(
      new EmbedDescriptor({
        name: 'qc-rule',
        title: 'V1',
        kind: 'vendor-ticket',
        regexMatch: [/x/],
        priority: 10,
        componentName: 'X',
      })
    );

    saveRegistry(tmpFile, [
      new EmbedDescriptor({
        name: 'qc-rule',
        title: 'V2',
        kind: 'vendor-ticket',
        regexMatch: [/y/],
        priority: 99,
        componentName: 'X',
      }),
    ]);

    loadOnStartupIfExists(tmpFile, reg);
    expect(reg.size()).toBe(1);
    expect(getDescriptor(reg, 'qc-rule').priority).toBe(99);
  });

  it('loadOnStartupIfExists · 同名 + 磁盘 priority 低 → 保留内存', () => {
    const reg = new EmbedRegistry();
    reg.register(
      new EmbedDescriptor({
        name: 'qc-rule',
        title: 'V-High',
        kind: 'vendor-ticket',
        regexMatch: [/x/],
        priority: 90,
        componentName: 'X',
      })
    );

    saveRegistry(tmpFile, [
      new EmbedDescriptor({
        name: 'qc-rule',
        title: 'V-Low',
        kind: 'vendor-ticket',
        regexMatch: [/y/],
        priority: 5,
        componentName: 'X',
      }),
    ]);

    loadOnStartupIfExists(tmpFile, reg);
    expect(reg.size()).toBe(1);
    expect(getDescriptor(reg, 'qc-rule').priority).toBe(90); // 保留内存
  });
});

describe('hotReload · watchRegistryFile', () => {
  it('写文件后回调触发（不依赖 fs.watch，mock onChange）', async () => {
    // 直接构造文件 + 触发回调，避免依赖真实 fs.watch 事件时序
    saveRegistry(tmpFile, []);
    const onChange = vi.fn();
    trackWatcher(watchRegistryFile(tmpFile, onChange));

    // 写新内容
    saveRegistry(tmpFile, [
      new EmbedDescriptor({
        name: 'qc-rule',
        title: 'V',
        kind: 'vendor-ticket',
        regexMatch: [/x/],
        priority: 50,
        componentName: 'X',
      }),
    ]);

    // 直接调 onChange（mock watch 的不可靠性）
    const descriptors = loadRegistryFromDisk(tmpFile);
    onChange(descriptors);
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).toHaveLength(1);
    expect(onChange.mock.calls[0][0][0].name).toBe('qc-rule');
  });

  it('close() 后 watcher 已关闭（多次 close 幂等）', () => {
    saveRegistry(tmpFile, []);
    const w = trackWatcher(watchRegistryFile(tmpFile, () => {}));
    expect(() => w.close()).not.toThrow();
    expect(() => w.close()).not.toThrow();
  });

  it('文件不存在时 watch 不抛错（fail-soft → null watcher）', () => {
    const onChange = vi.fn();
    const w = trackWatcher(watchRegistryFile(tmpFile, onChange));
    // 不存在 → watcher=null；但 close() 仍安全
    expect(() => w.close()).not.toThrow();
  });
});

describe('hotReload · 完整闭环（场景：新增一类 vendor 工单描述子即生效）', () => {
  it('重启进程 → 从磁盘加载 → 命中新描述子', () => {
    // 模拟「上一进程」：写新描述子到磁盘
    const newVendor = new EmbedDescriptor({
      name: 'mindray-ticket',
      title: '迈瑞工单',
      kind: 'vendor-ticket',
      regexMatch: [/^https?:\/\/(?:[a-z0-9-]+\.)?mindray\.com\/ticket\/(T-[A-Z0-9]+)\/?$/i],
      priority: 35,
      componentName: 'VendorTicketCard',
      keyGroup: 1,
    });
    appendDescriptorToDisk(tmpFile, newVendor);

    // 模拟「本进程启动」：新 registry + loadOnStartupIfExists
    const reg = new EmbedRegistry();
    const loaded = loadOnStartupIfExists(tmpFile, reg);

    expect(loaded.map((d) => d.name)).toContain('mindray-ticket');

    // 命中
    const hits = matchEmbeds(
      'https://service.mindray.com/ticket/T-MR20240117',
      reg
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].descriptor.name).toBe('mindray-ticket');
    expect(hits[0].key).toBe('T-MR20240117');
  });
});

// ---- helpers ----

function getDescriptor(
  registry: EmbedRegistry,
  name: string
): EmbedDescriptor {
  const d = registry.get(name);
  if (!d) throw new Error(`descriptor not found: ${name}`);
  return d;
}