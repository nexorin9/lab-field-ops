// tests/pluginLifecycle.test.ts
//
// Plugin 生命周期端到端测试：add → list → 触发事件 → 处理成功 → remove → 触发 uninstall；
// audit_event 全程留痕。
//
// 与 tests/plugin.test.ts 的差异：
//   - plugin.test.ts 验证 PluginManager 单例主路径（add/remove 单元）
//   - pluginLifecycle.test.ts 验证「端到端生命周期」（多次 add/remove、跨实例 hydrate、
//     uninstall handler 触发顺序、audit_event 完整串联）
//
// 复用 tests/plugin.test.ts 的 setup 模式（临时 db + closeDb + migrate）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb } from '../src/server/db.js';

let tmpDir: string;
let tmpDbPath: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lab-field-ops-plugin-lifecycle-'));
  tmpDbPath = join(tmpDir, 'test.db');
  process.env.DATABASE_PATH = tmpDbPath;
  closeDb();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

async function setupMigratedDb() {
  const { migrate } = await import('../src/server/db/migrate.js');
  const { getDb } = await import('../src/server/db.js');
  migrate(tmpDbPath);
  return getDb(tmpDbPath);
}

function makeManifest(overrides: Partial<{
  name: string;
  version: string;
  type: 'api' | 'task' | 'unfurl';
  queue_name: string | null;
}> = {}) {
  return {
    name: overrides.name ?? 'lifecycle-test',
    version: overrides.version ?? '1.0.0',
    type: overrides.type ?? 'task',
    hooks: [{ type: 'task' as const, queue_name: overrides.queue_name ?? null }],
    queue_name: overrides.queue_name ?? null,
    auth: null,
    rate_limit: null,
  };
}

describe('plugin 生命周期 — add → list → 触发事件 → 卸载', () => {
  it('完整生命周期 + audit_event 全程留痕', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    const { appendAudit, queryAudit } = await import('../src/server/audit/ledger.js');
    const { registerAllTasks, __resetTaskRegistration } = await import(
      '../src/server/queue/register.js'
    );
    const { __resetQueueRouteContext } = await import('../src/server/routes/queue.js');
    const { defaultQueueRouteContext, getQueueStatusRoute } = await import(
      '../src/server/routes/queue.js'
    );

    PluginManager.reset();

    // 阶段 1: add plugin with uninstall handler
    let uninstallCalled = 0;
    const uninstallHandler = async () => {
      uninstallCalled += 1;
      appendAudit({
        kind: 'plugin.uninstall',
        operatorId: 'lifecycle-test',
        payload: { name: 'lifecycle-test', source: 'uninstall-handler' },
      });
    };

    const addResult = PluginManager.add(makeManifest({
      name: 'lifecycle-test',
      queue_name: 'lifecycle-queue',
    }), {
      uninstall: uninstallHandler,
      task: async () => {
        appendAudit({
          kind: 'plugin.task',
          operatorId: 'lifecycle-test',
          payload: { name: 'lifecycle-test', source: 'task-handler' },
        });
      },
    });
    expect(addResult.ok).toBe(true);

    // 阶段 2: list 含 plugin
    const list1 = PluginManager.list();
    expect(list1.length).toBe(1);
    expect(list1[0].manifest.name).toBe('lifecycle-test');

    // 阶段 3: audit 写入验证（plugin.add）
    const addAudit = queryAudit({ kind: 'plugin.add' });
    expect(addAudit.length).toBeGreaterThanOrEqual(1);
    const addEvt = addAudit.find(
      (e) => JSON.parse(e.payload_json).name === 'lifecycle-test',
    );
    expect(addEvt).toBeDefined();
    expect(JSON.parse(addEvt!.payload_json).name).toBe('lifecycle-test');

    // 阶段 4: 触发 task handler
    registerAllTasks();
    // getTaskHandlers 接受 plugin 名称，返回该 plugin 注册的 task handler 列表
    const taskHandlers = PluginManager.getTaskHandlers('lifecycle-test');
    // plugin handler 已注册（task 钩子），所以数组非空
    expect(taskHandlers.length).toBeGreaterThanOrEqual(1);
    await taskHandlers[0]({ event: 'lifecycle-event' });

    const taskAudit = queryAudit({ kind: 'plugin.task' });
    expect(taskAudit.length).toBe(1);
    expect(JSON.parse(taskAudit[0].payload_json).source).toBe('task-handler');

    // 阶段 5: remove → uninstall handler 触发
    __resetQueueRouteContext();
    __resetTaskRegistration();
    const removeResult = PluginManager.remove('lifecycle-test');
    expect(removeResult.ok).toBe(true);
    expect(removeResult.alreadyRemoved).toBeFalsy();
    // uninstall 是同步触发（fire-and-forget + direct call）
    // 给异步 fire-and-forget 一个微任务时间
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(uninstallCalled).toBe(1);

    // 阶段 6: audit 写入验证（plugin.remove + plugin.uninstall）
    const removeAudit = queryAudit({ kind: 'plugin.remove' });
    expect(removeAudit.length).toBe(1);
    const removePayload = JSON.parse(removeAudit[0].payload_json);
    expect(removePayload.name).toBe('lifecycle-test');
    expect(removePayload.uninstall_triggered).toBe(true);

    const uninstallAudit = queryAudit({ kind: 'plugin.uninstall' });
    expect(uninstallAudit.length).toBe(1);

    // 阶段 7: 二次 remove 幂等
    const removeAgain = PluginManager.remove('lifecycle-test');
    expect(removeAgain.ok).toBe(true);
    expect(removeAgain.alreadyRemoved).toBe(true);
    // uninstall handler 不应被再次触发
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(uninstallCalled).toBe(1);
  });
});

describe('plugin 生命周期 — 跨实例 hydrate', () => {
  it('PluginManager.reset 后 list() 触发 hydrate 重新加载 DB 内容', async () => {
    const db = await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');

    // add 1 个 plugin
    PluginManager.reset();
    PluginManager.add(makeManifest({ name: 'hydrate-1', queue_name: 'q1' }));
    expect(PluginManager.list().length).toBe(1);

    // 模拟进程重启：reset 内存索引（list() 调用会自动 hydrate）
    PluginManager.reset();
    const listAfterReset = PluginManager.list();
    expect(listAfterReset.length).toBe(1); // 自动 hydrate 加载 DB
    expect(listAfterReset[0].manifest.name).toBe('hydrate-1');

    // 显式 hydrate 验证幂等
    PluginManager.hydrate();
    const list = PluginManager.list();
    expect(list.length).toBe(1);
    expect(list[0].manifest.name).toBe('hydrate-1');
  });

  it('PluginManager.remove 后 list() 不再返回该 plugin', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');

    PluginManager.reset();
    PluginManager.add(makeManifest({ name: 'r1', queue_name: 'qr1' }));
    PluginManager.add(makeManifest({ name: 'r2', queue_name: 'qr2' }));
    expect(PluginManager.list().length).toBe(2);

    PluginManager.remove('r1');
    const list = PluginManager.list();
    expect(list.length).toBe(1);
    expect(list[0].manifest.name).toBe('r2');
  });
});

describe('plugin 生命周期 — 同名 / queue 冲突', () => {
  it('同名 add → 拒绝（要求先 remove）', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    PluginManager.reset();

    PluginManager.add(makeManifest({ name: 'dup-name', queue_name: 'q-dup-1' }));
    const dup = PluginManager.add(makeManifest({ name: 'dup-name', queue_name: 'q-dup-2' }));
    expect(dup.ok).toBe(false);
    expect(dup.errors![0]).toMatch(/already installed/);
  });

  it('queue_name 被占 → 拒绝', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    PluginManager.reset();

    PluginManager.add(makeManifest({ name: 'p1', queue_name: 'shared-q' }));
    const conflict = PluginManager.add(makeManifest({ name: 'p2', queue_name: 'shared-q' }));
    expect(conflict.ok).toBe(false);
    expect(conflict.errors![0]).toMatch(/queue_name.*already used/);
  });
});

describe('plugin 生命周期 — 队列状态观测联动', () => {
  it('plugin add 后 → /api/queue/status 反映 queue 状态', async () => {
    await setupMigratedDb();
    const { PluginManager } = await import('../src/server/plugin/manager.js');
    const { defaultQueueRouteContext, getQueueStatusRoute } = await import(
      '../src/server/routes/queue.js'
    );
    const { __resetQueueRouteContext } = await import('../src/server/routes/queue.js');

    PluginManager.reset();
    __resetQueueRouteContext();
    PluginManager.add(makeManifest({ name: 'queue-status-test', queue_name: 'q-status-1' }));

    // 触发 defaultQueueRouteContext 初始化（observeQueues）
    defaultQueueRouteContext();

    const res = getQueueStatusRoute({}, {}, null);
    expect(res.status).toBe(200);
    if (!('queues' in res.body)) throw new Error('expected queues in body');
    expect(Array.isArray(res.body.queues)).toBe(true);
  });
});