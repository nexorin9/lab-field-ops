// tests/plugin.test.ts
// PluginManager + JSON manifest 解析端到端校验：
//   1. validateManifest 合法/非法 JSON
//   2. add → list 含项
//   3. remove 触发 uninstall 钩子
//   4. add/remove 全部写入 audit_event
// 与 spec.md 参考地基第 3 行（PluginManager.add）行为对齐：
//   领用 outline plugins/github/server/index.ts 的调用链
//   (manifest 校验 → DB 落盘 → 内存索引 → audit_event)
// 改造为「一份 manifest 一个 plugin」的 lab-field-ops 信息科 CLI 入口。

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('plugin manager', () => {
  let TMP_DIR: string;
  let TMP_DB: string;

  beforeAll(async () => {
    process.chdir(PROJECT_ROOT);
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-plugin-'));
    TMP_DB = path.join(TMP_DIR, 'test.sqlite');
    process.env.DATABASE_PATH = TMP_DB;

    const dbMod = await import('../src/server/db.js');
    dbMod.closeDb();
    const migrateMod = await import('../src/server/db/migrate.js');
    migrateMod.migrate(TMP_DB);
  });

  beforeEach(async () => {
    // 关键：rmSync 之前必须 closeDb，否则 better-sqlite3 持有旧文件句柄，
    // 下次 getDb 会复用旧连接，看到的是已删除的文件内容。
    const dbMod = await import('../src/server/db.js');
    dbMod.closeDb();
    if (fs.existsSync(TMP_DB)) {
      fs.rmSync(TMP_DB, { force: true });
    }
    const migrateMod = await import('../src/server/db/migrate.js');
    migrateMod.migrate(TMP_DB);

    const mgrMod = await import('../src/server/plugin/manager.js');
    mgrMod.PluginManager.reset();
    mgrMod.PluginManager.hydrate();
  });

  afterAll(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
    delete process.env.DATABASE_PATH;
  });

  // ────────────────────────────────────────────────────────────
  // validateManifest
  // ────────────────────────────────────────────────────────────
  describe('validateManifest', () => {
    it('合法 manifest：name/version/type/hooks 齐备', async () => {
      const { validateManifest } = await import('../src/server/plugin/manifest.js');
      const result = validateManifest({
        name: 'sample-plugin',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'sample-queue' }],
        queue_name: 'sample-queue',
        auth: null,
        rate_limit: null,
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.manifest?.name).toBe('sample-plugin');
      expect(result.manifest?.version).toBe('1.0.0');
    });

    it('非法 manifest：缺 name', async () => {
      const { validateManifest } = await import('../src/server/plugin/manifest.js');
      const result = validateManifest({
        version: '1.0.0',
        type: 'task',
      });
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.path === 'name')).toBe(true);
    });

    it('非法 manifest：name 不符合 kebab-case', async () => {
      const { validateManifest } = await import('../src/server/plugin/manifest.js');
      const result = validateManifest({
        name: 'SamplePlugin',
        version: '1.0.0',
        type: 'task',
      });
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e) => /must match/.test(e.message) || /kebab/.test(e.message),
        ),
      ).toBe(true);
    });

    it('非法 manifest：version 不是 semver', async () => {
      const { validateManifest } = await import('../src/server/plugin/manifest.js');
      const result = validateManifest({
        name: 'sample-plugin',
        version: 'v1',
        type: 'task',
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => /semver/.test(e.message))).toBe(true);
    });

    it('非法 manifest：type 不在白名单', async () => {
      const { validateManifest } = await import('../src/server/plugin/manifest.js');
      const result = validateManifest({
        name: 'sample-plugin',
        version: '1.0.0',
        type: 'websocket',
      });
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e) => /Invalid enum value/.test(e.message) || /enum/.test(e.message),
        ),
      ).toBe(true);
    });

    it('非法 manifest：未知字段（strict 模式拒绝）', async () => {
      const { validateManifest } = await import('../src/server/plugin/manifest.js');
      const result = validateManifest({
        name: 'sample-plugin',
        version: '1.0.0',
        type: 'task',
        auth_secret: 'should-not-be-allowed',
      });
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e) => e.path === 'auth_secret' || /Unrecognized/.test(e.message),
        ),
      ).toBe(true);
    });

    it('非法 manifest：输入非对象', async () => {
      const { validateManifest } = await import('../src/server/plugin/manifest.js');
      expect(validateManifest(null).ok).toBe(false);
      expect(validateManifest('string').ok).toBe(false);
      expect(validateManifest(123).ok).toBe(false);
      expect(validateManifest([]).ok).toBe(false);
    });

    it('peekManifestShape：浅校验合法', async () => {
      const { peekManifestShape } = await import('../src/server/plugin/manifest.js');
      expect(peekManifestShape({ name: 'x', version: '1.0.0', type: 'task' }).ok).toBe(true);
      expect(peekManifestShape({ name: '', version: '1.0.0', type: 'task' }).ok).toBe(false);
      expect(peekManifestShape({ name: 'x' }).ok).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────
  // PluginManager.add / list / get
  // ────────────────────────────────────────────────────────────
  describe('PluginManager.add / list / get', () => {
    it('add 合法 manifest → list 含项', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      const result = PluginManager.add({
        name: 'lis-writeback',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
        queue_name: 'lis-writeback',
        auth: null,
        rate_limit: null,
      });
      expect(result.ok).toBe(true);
      expect(result.entry?.manifest.name).toBe('lis-writeback');

      const list = PluginManager.list();
      expect(list.length).toBe(1);
      expect(list[0].manifest.name).toBe('lis-writeback');

      const got = PluginManager.get('lis-writeback');
      expect(got?.manifest.version).toBe('1.0.0');
    });

    it('add 写入 plugin_manifest 表', async () => {
      const dbMod = await import('../src/server/db.js');
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      PluginManager.add({
        name: 'iot-heartbeat',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'iot-heartbeat' }],
        queue_name: 'iot-heartbeat',
        auth: null,
        rate_limit: 10,
      });
      const row = dbMod
        .getDb(TMP_DB)
        .prepare('SELECT * FROM plugin_manifest WHERE name = ?')
        .get('iot-heartbeat');
      expect(row).toBeTruthy();
      expect((row as { version: string }).version).toBe('1.0.0');
      expect((row as { rate_limit: number }).rate_limit).toBe(10);
    });

    it('add 同名 → 拒绝（要求先 remove）', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      const m = {
        name: 'dup-plugin',
        version: '1.0.0',
        type: 'task' as const,
        hooks: [{ type: 'task' as const, queue_name: 'dup-queue' }],
        queue_name: 'dup-queue',
        auth: null,
        rate_limit: null,
      };
      expect(PluginManager.add(m).ok).toBe(true);
      const r2 = PluginManager.add(m);
      expect(r2.ok).toBe(false);
      expect(r2.errors?.[0]).toMatch(/already installed/);
    });

    it('add 相同 queue_name → 拒绝', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      const base = {
        version: '1.0.0',
        type: 'task' as const,
        hooks: [{ type: 'task' as const, queue_name: 'shared-queue' }],
        queue_name: 'shared-queue',
        auth: null,
        rate_limit: null,
      };
      expect(PluginManager.add({ name: 'plugin-a', ...base }).ok).toBe(true);
      const r2 = PluginManager.add({ name: 'plugin-b', ...base });
      expect(r2.ok).toBe(false);
      expect(r2.errors?.[0]).toMatch(/queue_name 'shared-queue' is already used/);
    });

    it('add 非法 manifest → 拒绝且不入库', async () => {
      const dbMod = await import('../src/server/db.js');
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      const result = PluginManager.add({
        name: 'BadName',
        version: '1.0.0',
        type: 'task',
      });
      expect(result.ok).toBe(false);

      const rows = dbMod
        .getDb(TMP_DB)
        .prepare('SELECT COUNT(*) AS c FROM plugin_manifest')
        .get() as { c: number };
      expect(rows.c).toBe(0);
    });

    it('findByQueueName 按队列名命中', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      PluginManager.add({
        name: 'lis-writeback',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
        queue_name: 'lis-writeback',
        auth: null,
        rate_limit: null,
      });
      const found = PluginManager.findByQueueName('lis-writeback');
      expect(found?.manifest.name).toBe('lis-writeback');
      expect(PluginManager.findByQueueName('nonexistent')).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────
  // remove + uninstall hook
  // ────────────────────────────────────────────────────────────
  describe('PluginManager.remove', () => {
    it('remove 触发 uninstall handler（同步）', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      let uninstallCalled = 0;
      const uninstallSpy = () => {
        uninstallCalled++;
      };

      PluginManager.add(
        {
          name: 'test-sync-uninstall',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'sync-q' }],
          queue_name: 'sync-q',
          auth: null,
          rate_limit: null,
        },
        { uninstall: uninstallSpy },
      );

      const result = PluginManager.remove('test-sync-uninstall');
      expect(result.ok).toBe(true);
      expect(result.uninstallTriggered).toBe(true);
      expect(uninstallCalled).toBe(1);
    });

    it('remove 触发 uninstall handler（异步 fire-and-forget）', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      let uninstallCalled = 0;
      const uninstallAsync = async () => {
        uninstallCalled++;
      };

      PluginManager.add(
        {
          name: 'test-async-uninstall',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'async-q' }],
          queue_name: 'async-q',
          auth: null,
          rate_limit: null,
        },
        { uninstall: uninstallAsync },
      );

      const result = PluginManager.remove('test-async-uninstall');
      expect(result.ok).toBe(true);
      expect(result.uninstallTriggered).toBe(true);
      // 等待 microtask
      await new Promise((r) => setImmediate(r));
      expect(uninstallCalled).toBe(1);
    });

    it('remove 二次幂等（已移除返回 ok=true + alreadyRemoved=true）', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      PluginManager.add({
        name: 'once-plugin',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'once-q' }],
        queue_name: 'once-q',
        auth: null,
        rate_limit: null,
      });
      expect(PluginManager.remove('once-plugin').ok).toBe(true);
      const r2 = PluginManager.remove('once-plugin');
      expect(r2.ok).toBe(true);
      expect(r2.alreadyRemoved).toBe(true);
    });

    it('remove 抛错的 uninstall handler 不会中断流程', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      PluginManager.add(
        {
          name: 'broken-uninstall',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'broken-q' }],
          queue_name: 'broken-q',
          auth: null,
          rate_limit: null,
        },
        {
          uninstall: () => {
            throw new Error('cleanup failed');
          },
        },
      );
      const result = PluginManager.remove('broken-uninstall');
      expect(result.ok).toBe(true);
      expect(stderrSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
    });
  });

  // ────────────────────────────────────────────────────────────
  // audit_event 落盘 — 用 operator_id 过滤避免与其它测试的累积事件混
  // ────────────────────────────────────────────────────────────
  describe('audit_event integration', () => {
    it('add 触发 plugin.add audit_event（带本次专属 operator_id）', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      const { queryAudit } = await import('../src/server/audit/ledger.js');

      PluginManager.add({
        name: 'audited-plugin',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'audit-q' }],
        queue_name: 'audit-q',
        auth: null,
        rate_limit: null,
      });

      // PluginManager.add 的 appendAudit 未传 operatorId；
      // 但 payload 含 name/version 字段，用 kind 过滤后断言 payload 内容。
      const events = queryAudit({ kind: 'plugin.add', limit: 1000 });
      const match = events.find((e) => {
        const p = JSON.parse(e.payload_json);
        return p.name === 'audited-plugin';
      });
      expect(match).toBeTruthy();
      const payload = JSON.parse(match!.payload_json);
      expect(payload.version).toBe('1.0.0');
      expect(payload.queue_name).toBe('audit-q');
    });

    it('remove 触发 plugin.remove audit_event 含 uninstall_triggered 字段', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      const { queryAudit } = await import('../src/server/audit/ledger.js');

      PluginManager.add(
        {
          name: 'remove-me',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'rm-q' }],
          queue_name: 'rm-q',
          auth: null,
          rate_limit: null,
        },
        { uninstall: () => {} },
      );

      PluginManager.remove('remove-me');

      const events = queryAudit({ kind: 'plugin.remove', limit: 1000 });
      const match = events.find((e) => {
        const p = JSON.parse(e.payload_json);
        return p.name === 'remove-me';
      });
      expect(match).toBeTruthy();
      const payload = JSON.parse(match!.payload_json);
      expect(payload.uninstall_triggered).toBe(true);
    });

    it('audit_event append-only：UPDATE/DELETE 触发器挡 write-back', async () => {
      const { PluginManager } = await import('../src/server/plugin/manager.js');
      const dbMod = await import('../src/server/db.js');

      PluginManager.add({
        name: 'append-only-test',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'ao-q' }],
        queue_name: 'ao-q',
        auth: null,
        rate_limit: null,
      });

      const db = dbMod.getDb(TMP_DB);
      const row = db
        .prepare('SELECT event_id FROM audit_event WHERE kind = ? LIMIT 1')
        .get('plugin.add') as { event_id: string };

      expect(() =>
        db
          .prepare('UPDATE audit_event SET kind = ? WHERE event_id = ?')
          .run('x', row.event_id),
      ).toThrow(/append-only/);
    });
  });

  // ────────────────────────────────────────────────────────────
  // example plugins：lis-writeback + iot-heartbeat
  // 不用 vi.resetModules()；通过 process.env.LIS_WRITEBACK_PATH 切换路径，
  // handler 是直接导出，可独立调用。
  // ────────────────────────────────────────────────────────────
  describe('example plugins', () => {
    it('lis-writeback handler 写 JSONL 文件', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-writeback-test-'));
      const jsonlPath = path.join(tmpDir, 'lis-writeback.ndjson');
      process.env.LIS_WRITEBACK_PATH = jsonlPath;

      // 不走 registerLisWriteback（避免引入 plugin.add 副作用）；
      // 直接调 handler + 验证 JSONL。
      const writebackMod = await import('../src/server/plugin/examples/lis-writeback.js');

      await writebackMod.lisWritebackHandler({
        record_id: 'rec-1',
        instrument_id: 'ASSET-LAB-0001',
        alarm_code: 'W002',
        accession_no: 'L12345678',
        operator_id: 'op-1',
        root_cause: '试剂余量低',
        steps: ['更换试剂', '复测'],
        confirmed_at: new Date().toISOString(),
      });

      expect(fs.existsSync(jsonlPath)).toBe(true);
      const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      const obj = JSON.parse(lines[0]);
      expect(obj.record_id).toBe('rec-1');
      expect(obj.instrument_id).toBe('ASSET-LAB-0001');
      expect(obj.accession_no).toBe('L12345678');

      fs.rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.LIS_WRITEBACK_PATH;
    });

    it('iot-heartbeat handler 入库 calibration + 去重 by raw_hash', async () => {
      const heartbeatMod = await import('../src/server/plugin/examples/iot-heartbeat.js');
      const dbMod = await import('../src/server/db.js');

      // 准备 instrument（外键约束需要）
      dbMod
        .getDb(TMP_DB)
        .prepare(
          `INSERT INTO instrument
             (instrument_id, vendor, model, asset_tag, location, status, installed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'ASSET-LAB-0001',
          'Siemens',
          'ADVIA 2400',
          'ASSET-LAB-0001',
          '门诊二楼检验科 A 区',
          'online',
          new Date().toISOString(),
        );

      heartbeatMod.__test.resetHeartbeatRateState();

      const payload = {
        instrument_id: 'ASSET-LAB-0001',
        vendor: 'Siemens',
        model: 'ADVIA 2400',
        raw: { temp: 37.0, status: 'ok' },
        raw_hash: 'h-1',
        received_at: new Date().toISOString(),
      };

      await heartbeatMod.iotHeartbeatHandler(payload);

      const db = dbMod.getDb(TMP_DB);
      const rows1 = db.prepare('SELECT * FROM calibration WHERE raw_hash = ?').all('h-1');
      expect(rows1.length).toBe(1);

      // 第二次同 raw_hash → skip
      await heartbeatMod.iotHeartbeatHandler(payload);
      const rows2 = db.prepare('SELECT * FROM calibration WHERE raw_hash = ?').all('h-1');
      expect(rows2.length).toBe(1);

      // 缺字段 → 抛错
      await expect(
        heartbeatMod.iotHeartbeatHandler({
          instrument_id: 'ASSET-LAB-0001',
          raw_hash: '',
        } as unknown as Record<string, unknown>),
      ).rejects.toThrow(/missing required fields/);
    });

    it('iot-heartbeat 超限 → drop 并落 audit heartbeat.dropped', async () => {
      const heartbeatMod = await import('../src/server/plugin/examples/iot-heartbeat.js');
      const dbMod = await import('../src/server/db.js');
      const { queryAudit } = await import('../src/server/audit/ledger.js');

      heartbeatMod.__test.resetHeartbeatRateState();

      dbMod
        .getDb(TMP_DB)
        .prepare(
          `INSERT INTO instrument
             (instrument_id, vendor, model, asset_tag, location, status, installed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'ASSET-LAB-0002',
          'Roche',
          'cobas c701',
          'ASSET-LAB-0002',
          '门诊二楼检验科 B 区',
          'online',
          new Date().toISOString(),
        );

      // rate_limit=10/s；连发 11 条：前 10 通过，第 11 条 drop
      for (let i = 0; i < 11; i++) {
        await heartbeatMod.iotHeartbeatHandler({
          instrument_id: 'ASSET-LAB-0002',
          vendor: 'Roche',
          model: 'cobas c701',
          raw: { i },
          raw_hash: `drop-${i}`,
          received_at: new Date().toISOString(),
        });
      }

      const dropped = queryAudit({ kind: 'heartbeat.dropped', limit: 1000 });
      expect(dropped.length).toBeGreaterThanOrEqual(1);
      const droppedPayload = JSON.parse(dropped[0].payload_json);
      expect(droppedPayload.vendor).toBe('Roche');
      expect(droppedPayload.reason).toBe('rate_limit_exceeded');
    });
  });
});
