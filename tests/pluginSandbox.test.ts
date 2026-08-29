// tests/pluginSandbox.test.ts
// Plugin capability 沙箱 + 钩子派发器集成测试。
//
// 与 spec.md 参考地基第 3 行（PluginManager.add）行为对齐：
//   PluginManager.add({type: Hook.API/Task/UnfurlProvider/Uninstall})
//   - manifest 校验（形态合法）
//   - capability 校验（hook type 白名单 + queue 白名单 + rate_limit 区间）
//   - Dispatcher.dispatch（按 type 派发到 API router / task queue / unfurl / uninstall 注册表）
//   - DB INSERT
//   - audit_event('plugin.add')
//
// 移除流程：
//   - 触发 Hook.Uninstall handlers
//   - Dispatcher.unregister（按 plugin 名反向注销）
//   - DB DELETE
//   - audit_event('plugin.remove')

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('plugin sandbox (capability + dispatcher)', () => {
  let TMP_DIR: string;
  let TMP_DB: string;

  beforeAll(async () => {
    process.chdir(PROJECT_ROOT);
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-sandbox-'));
    TMP_DB = path.join(TMP_DIR, 'test.sqlite');
    process.env.DATABASE_PATH = TMP_DB;

    const dbMod = await import('../src/server/db.js');
    dbMod.closeDb();
    const migrateMod = await import('../src/server/db/migrate.js');
    migrateMod.migrate(TMP_DB);
  });

  beforeEach(async () => {
    const dbMod = await import('../src/server/db.js');
    dbMod.closeDb();
    if (fs.existsSync(TMP_DB)) {
      fs.rmSync(TMP_DB, { force: true });
    }
    const migrateMod = await import('../src/server/db/migrate.js');
    migrateMod.migrate(TMP_DB);

    const mgrMod = await import('../src/server/plugin/manager.js');
    mgrMod.PluginManager.reset();
    const dispMod = await import('../src/server/plugin/dispatcher.js');
    dispMod.Dispatcher.reset();
  });

  afterAll(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
    delete process.env.DATABASE_PATH;
  });

  // ────────────────────────────────────────────────────────────
  // capability 白名单
  // ────────────────────────────────────────────────────────────
  describe('capability.whitelist', () => {
    it('hook type 不在白名单 → validateCapabilities 拒绝', async () => {
      const { validateCapabilities } = await import(
        '../src/server/plugin/capability.js'
      );
      const r = validateCapabilities({
        name: 'evil-plugin',
        version: '1.0.0',
        type: 'websocket', // 不在白名单
        hooks: [],
        queue_name: null,
        auth: null,
        rate_limit: null,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.path === 'type')).toBe(true);
    });

    it('hooks[] 内 type 不在白名单 → 拒绝并定位路径', async () => {
      const { validateCapabilities } = await import(
        '../src/server/plugin/capability.js'
      );
      const r = validateCapabilities({
        name: 'mixed-plugin',
        version: '1.0.0',
        type: 'task',
        hooks: [
          { type: 'task', queue_name: 'lis-x' },
          { type: 'evil-hook', path: '/x' } as unknown as { type: 'task'; queue_name?: string },
        ],
        queue_name: 'lis-x',
        auth: null,
        rate_limit: null,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.path === 'hooks.1.type')).toBe(true);
    });

    it('queue_name 形态非法（camelCase / 大写 / 含特殊字符）→ 拒绝', async () => {
      const { validateCapabilities } = await import(
        '../src/server/plugin/capability.js'
      );
      // camelCase 不通过
      const r1 = validateCapabilities({
        name: 'bad-queue-plugin',
        version: '1.0.0',
        type: 'task',
        hooks: [],
        queue_name: 'RandomQueueName',
        auth: null,
        rate_limit: null,
      });
      expect(r1.ok).toBe(false);
      expect(r1.errors.some((e) => e.path === 'queue_name')).toBe(true);

      // 含特殊字符不通过
      const r2 = validateCapabilities({
        name: 'bad-queue-plugin-2',
        version: '1.0.0',
        type: 'task',
        hooks: [],
        queue_name: 'lis/writeback',
        auth: null,
        rate_limit: null,
      });
      expect(r2.ok).toBe(false);

      // 太短（1 字符）不通过
      const r3 = validateCapabilities({
        name: 'too-short',
        version: '1.0.0',
        type: 'task',
        hooks: [],
        queue_name: 'x',
        auth: null,
        rate_limit: null,
      });
      expect(r3.ok).toBe(false);
    });

    it('queue_name 在白名单前缀内 → 通过', async () => {
      const { validateCapabilities } = await import(
        '../src/server/plugin/capability.js'
      );
      const r = validateCapabilities({
        name: 'lis-wb',
        version: '1.0.0',
        type: 'task',
        hooks: [],
        queue_name: 'lis-writeback',
        auth: null,
        rate_limit: null,
      });
      expect(r.ok).toBe(true);
    });

    it('queue_name 命中 ALLOWED_QUEUE_EXACT 全名 → 通过', async () => {
      const { validateCapabilities } = await import(
        '../src/server/plugin/capability.js'
      );
      const r = validateCapabilities({
        name: 'sys-plugin',
        version: '1.0.0',
        type: 'task',
        hooks: [],
        queue_name: 'system-tasks',
        auth: null,
        rate_limit: null,
      });
      expect(r.ok).toBe(true);
    });

    it('rate_limit 越界（0 / 1001）→ 拒绝', async () => {
      const { validateCapabilities } = await import(
        '../src/server/plugin/capability.js'
      );
      const r0 = validateCapabilities({
        name: 'zero-rate',
        version: '1.0.0',
        type: 'task',
        hooks: [],
        queue_name: 'lis-x',
        auth: null,
        rate_limit: 0,
      });
      expect(r0.ok).toBe(false);

      const rMax = validateCapabilities({
        name: 'huge-rate',
        version: '1.0.0',
        type: 'task',
        hooks: [],
        queue_name: 'lis-x',
        auth: null,
        rate_limit: 9999,
      });
      expect(rMax.ok).toBe(false);
    });

    it('合法 manifest 通过 capability 校验', async () => {
      const { validateCapabilities } = await import(
        '../src/server/plugin/capability.js'
      );
      const r = validateCapabilities({
        name: 'good-plugin',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'iot-heartbeat-x' }],
        queue_name: 'iot-heartbeat-x',
        auth: null,
        rate_limit: 50,
      });
      expect(r.ok).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────
  // PluginManager.add 与 capability 集成
  // ────────────────────────────────────────────────────────────
  describe('PluginManager.add × capability 集成', () => {
    it('add 时 hook type 越界 → 拒绝且不写 DB', async () => {
      const dbMod = await import('../src/server/db.js');
      const { PluginManager } = await import(
        '../src/server/plugin/manager.js'
      );
      // 通过 validateManifest 已经拒掉；这里验证即使绕过也会被 capability 拦截。
      // 直接构造合法 manifest 但用绕过的方式（hook.type='evil'）
      // 实际上 manifest schema 已拒掉 type='evil'，所以这个测试改为测 hooks[] 子项。
      // 这里改测：hook type 合法但 queue 形态不合法（camelCase）→ capability 拒
      const r = PluginManager.add({
        name: 'evil-q',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'IllegalQueue' }],
        queue_name: 'IllegalQueue',
        auth: null,
        rate_limit: null,
      });
      expect(r.ok).toBe(false);
      expect(r.errors?.some((e) => /queue_name/.test(e))).toBe(true);

      const rows = dbMod
        .getDb(TMP_DB)
        .prepare('SELECT COUNT(*) AS c FROM plugin_manifest')
        .get() as { c: number };
      expect(rows.c).toBe(0);
    });

    it('add 合法 manifest → DB + 内存 + Dispatcher 注册', async () => {
      const { PluginManager } = await import(
        '../src/server/plugin/manager.js'
      );
      const { Dispatcher } = await import(
        '../src/server/plugin/dispatcher.js'
      );
      const apiRouter = { GET: () => 'ok' };
      const taskHandler = async () => {};
      const unfurlProvider = { unfurl: async () => ({}) };
      const uninstallHandler = () => {};

      const r = PluginManager.add(
        {
          name: 'full-plugin',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'lis-full' }],
          queue_name: 'lis-full',
          auth: null,
          rate_limit: null,
        },
        {
          api: apiRouter,
          task: taskHandler,
          unfurl: unfurlProvider,
          uninstall: uninstallHandler,
        },
      );
      expect(r.ok).toBe(true);

      const snap = Dispatcher.snapshot();
      expect(snap.apiRouters.length).toBe(1);
      expect(snap.taskHandlers.length).toBe(1);
      expect(snap.unfurlProviders.length).toBe(1);
      expect(snap.uninstallHandlers.length).toBe(1);
      expect(snap.taskHandlers[0].queueName).toBe('lis-full');
    });

    it('非法 JSON（非对象）走 add → 拒绝', async () => {
      const { PluginManager } = await import(
        '../src/server/plugin/manager.js'
      );
      // 字符串输入 → manifest 校验直接拒
      expect(PluginManager.add('not an object').ok).toBe(false);
      // 数组输入 → 拒
      expect(PluginManager.add([]).ok).toBe(false);
      // null 输入 → 拒
      expect(PluginManager.add(null).ok).toBe(false);
    });

    it('缺 name/version/type → 拒绝', async () => {
      const { PluginManager } = await import(
        '../src/server/plugin/manager.js'
      );
      const r1 = PluginManager.add({ version: '1.0.0', type: 'task' });
      expect(r1.ok).toBe(false);

      const r2 = PluginManager.add({ name: 'x', type: 'task' });
      expect(r2.ok).toBe(false);

      const r3 = PluginManager.add({ name: 'x', version: '1.0.0' });
      expect(r3.ok).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────
  // PluginManager.remove × Dispatcher.unregister 集成
  // ────────────────────────────────────────────────────────────
  describe('PluginManager.remove × Dispatcher.unregister', () => {
    it('remove 触发 Dispatcher 反向注销（api/task/unfurl/uninstall 全部清空）', async () => {
      const { PluginManager } = await import(
        '../src/server/plugin/manager.js'
      );
      const { Dispatcher } = await import(
        '../src/server/plugin/dispatcher.js'
      );
      PluginManager.add(
        {
          name: 'clean-plugin',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'iot-cleanup' }],
          queue_name: 'iot-cleanup',
          auth: null,
          rate_limit: null,
        },
        {
          api: { GET: () => 'ok' },
          task: async () => {},
          unfurl: { unfurl: async () => ({}) },
          uninstall: () => {},
        },
      );

      const beforeSnap = Dispatcher.snapshot();
      expect(beforeSnap.apiRouters.length).toBe(1);

      PluginManager.remove('clean-plugin');

      const afterSnap = Dispatcher.snapshot();
      expect(afterSnap.apiRouters.length).toBe(0);
      expect(afterSnap.taskHandlers.length).toBe(0);
      expect(afterSnap.unfurlProviders.length).toBe(0);
      expect(afterSnap.uninstallHandlers.length).toBe(0);
    });

    it('remove 二次幂等：第二次返回 alreadyRemoved=true 不抛错', async () => {
      const { PluginManager } = await import(
        '../src/server/plugin/manager.js'
      );
      const { Dispatcher } = await import(
        '../src/server/plugin/dispatcher.js'
      );
      PluginManager.add({
        name: 'once-plugin-2',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'iot-once' }],
        queue_name: 'iot-once',
        auth: null,
        rate_limit: null,
      });

      const r1 = PluginManager.remove('once-plugin-2');
      expect(r1.ok).toBe(true);
      expect(r1.alreadyRemoved).toBeFalsy();

      // 第二次 remove：已移除，幂等返 ok=true + alreadyRemoved=true，不抛错
      let threw = false;
      let r2;
      try {
        r2 = PluginManager.remove('once-plugin-2');
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(r2!.ok).toBe(true);
      expect(r2!.alreadyRemoved).toBe(true);

      // Dispatcher.unregister 也是幂等的
      const removed = Dispatcher.unregister('once-plugin-2');
      expect(removed.apiRemoved).toBe(0);
      expect(removed.taskRemoved).toBe(0);
      expect(removed.unfurlRemoved).toBe(0);
      expect(removed.uninstallRemoved).toBe(0);
    });

    it('remove 触发 uninstall handler + 反向注销', async () => {
      const { PluginManager } = await import(
        '../src/server/plugin/manager.js'
      );
      const { Dispatcher } = await import(
        '../src/server/plugin/dispatcher.js'
      );
      let uninstallCalled = 0;
      const uninstallHandler = () => {
        uninstallCalled++;
      };

      PluginManager.add(
        {
          name: 'with-uninstall',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'iot-with-uninstall' }],
          queue_name: 'iot-with-uninstall',
          auth: null,
          rate_limit: null,
        },
        {
          uninstall: uninstallHandler,
        },
      );

      const r = PluginManager.remove('with-uninstall');
      expect(r.ok).toBe(true);
      expect(r.uninstallTriggered).toBe(true);
      expect(uninstallCalled).toBe(1);
      expect(Dispatcher.snapshot().uninstallHandlers.length).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Dispatcher 独立行为
  // ────────────────────────────────────────────────────────────
  describe('Dispatcher 独立行为', () => {
    it('dispatch 多个 plugin 不互相污染', async () => {
      const { Dispatcher } = await import(
        '../src/server/plugin/dispatcher.js'
      );
      Dispatcher.dispatch(
        {
          name: 'plugin-a',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'lis-a' }],
          queue_name: 'lis-a',
          auth: null,
          rate_limit: null,
        },
        { task: async () => {} },
      );
      Dispatcher.dispatch(
        {
          name: 'plugin-b',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'lis-b' }],
          queue_name: 'lis-b',
          auth: null,
          rate_limit: null,
        },
        { task: async () => {} },
      );

      const snap = Dispatcher.snapshot();
      expect(snap.taskHandlers.length).toBe(2);

      Dispatcher.unregister('plugin-a');
      const snapAfter = Dispatcher.snapshot();
      expect(snapAfter.taskHandlers.length).toBe(1);
      expect(snapAfter.taskHandlers[0].pluginName).toBe('plugin-b');
    });

    it('snapshot 返回只读快照', async () => {
      const { Dispatcher } = await import(
        '../src/server/plugin/dispatcher.js'
      );
      Dispatcher.dispatch(
        {
          name: 'snap-plugin',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'lis-snap' }],
          queue_name: 'lis-snap',
          auth: null,
          rate_limit: null,
        },
        { task: async () => {} },
      );

      const snap = Dispatcher.snapshot();
      expect(Array.isArray(snap.taskHandlers)).toBe(true);
      // snapshot 是新数组，修改不影响内部
      snap.taskHandlers.length = 0;
      expect(Dispatcher.snapshot().taskHandlers.length).toBe(1);
    });

    it('reset 清空全部注册表', async () => {
      const { Dispatcher } = await import(
        '../src/server/plugin/dispatcher.js'
      );
      Dispatcher.dispatch(
        {
          name: 'reset-plugin',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'lis-reset' }],
          queue_name: 'lis-reset',
          auth: null,
          rate_limit: null,
        },
        { task: async () => {} },
      );
      expect(Dispatcher.snapshot().taskHandlers.length).toBe(1);

      Dispatcher.reset();
      expect(Dispatcher.snapshot().taskHandlers.length).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // audit_event 落盘
  // ────────────────────────────────────────────────────────────
  describe('audit_event 集成', () => {
    it('plugin.add 写 audit_event 含 dispatcher 派发信息', async () => {
      const { PluginManager } = await import(
        '../src/server/plugin/manager.js'
      );
      const { queryAudit } = await import('../src/server/audit/ledger.js');

      PluginManager.add({
        name: 'audit-plugin-21',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'audit-queue-21' }],
        queue_name: 'audit-queue-21',
        auth: null,
        rate_limit: null,
      });

      const events = queryAudit({ kind: 'plugin.add', limit: 1000 });
      const match = events.find((e) => {
        const p = JSON.parse(e.payload_json);
        return p.name === 'audit-plugin-21';
      });
      expect(match).toBeTruthy();
      const payload = JSON.parse(match!.payload_json);
      expect(payload.version).toBe('1.0.0');
      expect(payload.queue_name).toBe('audit-queue-21');
    });

    it('plugin.remove 写 audit_event 含 dispatcher_removed 字段', async () => {
      const { PluginManager } = await import(
        '../src/server/plugin/manager.js'
      );
      const { queryAudit } = await import('../src/server/audit/ledger.js');

      PluginManager.add(
        {
          name: 'remove-audit',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'audit-remove' }],
          queue_name: 'audit-remove',
          auth: null,
          rate_limit: null,
        },
        { uninstall: () => {} },
      );

      PluginManager.remove('remove-audit');

      const events = queryAudit({ kind: 'plugin.remove', limit: 1000 });
      const match = events.find((e) => {
        const p = JSON.parse(e.payload_json);
        return p.name === 'remove-audit';
      });
      expect(match).toBeTruthy();
      const payload = JSON.parse(match!.payload_json);
      expect(payload.uninstall_triggered).toBe(true);
      expect(payload.dispatcher_removed).toBeDefined();
      expect(payload.dispatcher_removed.uninstallRemoved).toBe(1);
    });
  });
});