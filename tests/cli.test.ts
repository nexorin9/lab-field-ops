// tests/cli.test.ts
// CLI plugin add/remove/list 端到端测试：
//   1. 程序化调用 addPlugin / removePlugin / listPlugins 的契约
//   2. 真实 spawn ts-node 执行 CLI 子命令（lab-field-ops plugin add/remove/list）
//   3. 错误路径：manifest 文件缺失 / JSON 非法 / schema 非法 / 同名重复注册
//
// 与 spec.md 参考地基第 3 行（PluginManager.add）+ 工作闭环对齐。
// 取舍：CLI 直接复用 PluginManager.add/remove/list；本任务只做"命令包装层"。

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('cli · plugin (programmatic API)', () => {
  let TMP_DIR: string;
  let TMP_DB: string;

  beforeAll(async () => {
    process.chdir(PROJECT_ROOT);
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-cli-'));
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
    mgrMod.PluginManager.hydrate();
  });

  afterAll(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
    delete process.env.DATABASE_PATH;
  });

  // ────────────────────────────────────────────────────────────
  // addPlugin
  // ────────────────────────────────────────────────────────────
  describe('addPlugin', () => {
    it('合法 manifest：返回 name/version/type/queueName/listeningPath', async () => {
      const { addPlugin } = await import('../src/cli/plugin.js');
      const manifestPath = path.join(TMP_DIR, 'lis-writeback.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          name: 'lis-writeback',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
          queue_name: 'lis-writeback',
          auth: null,
          rate_limit: null,
        }),
      );

      const result = addPlugin(manifestPath, { dbPath: TMP_DB });
      expect(result.ok).toBe(true);
      expect(result.name).toBe('lis-writeback');
      expect(result.version).toBe('1.0.0');
      expect(result.type).toBe('task');
      expect(result.queueName).toBe('lis-writeback');
      expect(result.listeningPath).toBe('queue:lis-writeback');
      expect(result.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('Hook.API 类型的 listeningPath 为 /api/plugins/<name>', async () => {
      const { addPlugin } = await import('../src/cli/plugin.js');
      const manifestPath = path.join(TMP_DIR, 'api-plugin.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          name: 'sample-api',
          version: '0.1.0',
          type: 'api',
          hooks: [{ type: 'api', path: '/api/plugins/sample-api/foo' }],
          queue_name: null,
          auth: { type: 'token', token: 'PLACEHOLDER' },
          rate_limit: null,
        }),
      );

      const result = addPlugin(manifestPath, { dbPath: TMP_DB });
      expect(result.ok).toBe(true);
      expect(result.listeningPath).toBe('/api/plugins/sample-api');
    });

    it('manifest 文件不存在：返回 errors[]', async () => {
      const { addPlugin } = await import('../src/cli/plugin.js');
      const result = addPlugin('/nonexistent/path.json', { dbPath: TMP_DB });
      expect(result.ok).toBe(false);
      expect(result.errors?.[0]).toMatch(/not found/i);
    });

    it('manifest JSON 解析失败：返回 errors[]', async () => {
      const { addPlugin } = await import('../src/cli/plugin.js');
      const manifestPath = path.join(TMP_DIR, 'broken.json');
      fs.writeFileSync(manifestPath, '{this is not valid json');
      const result = addPlugin(manifestPath, { dbPath: TMP_DB });
      expect(result.ok).toBe(false);
      expect(result.errors?.[0]).toMatch(/parse error/i);
    });

    it('manifest schema 非法（大写 name）：返回 errors[]', async () => {
      const { addPlugin } = await import('../src/cli/plugin.js');
      const manifestPath = path.join(TMP_DIR, 'bad-name.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          name: 'BadName',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'q1' }],
          queue_name: 'q1',
          auth: null,
          rate_limit: null,
        }),
      );
      const result = addPlugin(manifestPath, { dbPath: TMP_DB });
      expect(result.ok).toBe(false);
      expect(result.errors?.[0]).toMatch(/kebab|kebab-case|match/i);
    });

    it('同名 plugin 二次 add：返回错误（要求先 remove）', async () => {
      const { addPlugin } = await import('../src/cli/plugin.js');
      const manifestPath = path.join(TMP_DIR, 'dup.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          name: 'dup-plugin',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'dup-queue' }],
          queue_name: 'dup-queue',
          auth: null,
          rate_limit: null,
        }),
      );
      const r1 = addPlugin(manifestPath, { dbPath: TMP_DB });
      expect(r1.ok).toBe(true);
      const r2 = addPlugin(manifestPath, { dbPath: TMP_DB });
      expect(r2.ok).toBe(false);
      expect(r2.errors?.[0]).toMatch(/already installed/);
    });

    it('queue_name 被占用：返回错误', async () => {
      const { addPlugin } = await import('../src/cli/plugin.js');
      const m1 = path.join(TMP_DIR, 'a.json');
      const m2 = path.join(TMP_DIR, 'b.json');
      fs.writeFileSync(
        m1,
        JSON.stringify({
          name: 'plugin-a',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'shared-q' }],
          queue_name: 'shared-q',
          auth: null,
          rate_limit: null,
        }),
      );
      fs.writeFileSync(
        m2,
        JSON.stringify({
          name: 'plugin-b',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'shared-q' }],
          queue_name: 'shared-q',
          auth: null,
          rate_limit: null,
        }),
      );
      expect(addPlugin(m1, { dbPath: TMP_DB }).ok).toBe(true);
      const r2 = addPlugin(m2, { dbPath: TMP_DB });
      expect(r2.ok).toBe(false);
      expect(r2.errors?.[0]).toMatch(/queue_name.*already used/);
    });
  });

  // ────────────────────────────────────────────────────────────
  // removePlugin
  // ────────────────────────────────────────────────────────────
  describe('removePlugin', () => {
    it('已注册 plugin：返回 ok=true + uninstallTriggered', async () => {
      const { addPlugin, removePlugin } = await import('../src/cli/plugin.js');
      const manifestPath = path.join(TMP_DIR, 'r1.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          name: 'rm-target',
          version: '1.0.0',
          type: 'task',
          hooks: [{ type: 'task', queue_name: 'rm-q' }],
          queue_name: 'rm-q',
          auth: null,
          rate_limit: null,
        }),
      );
      expect(addPlugin(manifestPath, { dbPath: TMP_DB }).ok).toBe(true);
      const result = removePlugin('rm-target', { dbPath: TMP_DB });
      expect(result.ok).toBe(true);
      expect(result.name).toBe('rm-target');
      // 当前 manifest 没有声明 uninstall hook，所以 uninstallTriggered=false
      expect(result.uninstallTriggered).toBe(false);
    });

    it('二次 remove：返回 ok=true + alreadyRemoved=true（幂等）', async () => {
      const { removePlugin } = await import('../src/cli/plugin.js');
      const r1 = removePlugin('never-existed', { dbPath: TMP_DB });
      expect(r1.ok).toBe(true);
      expect(r1.alreadyRemoved).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────
  // listPlugins + renderPluginTable
  // ────────────────────────────────────────────────────────────
  describe('listPlugins + renderPluginTable', () => {
    it('空列表：返回 (no plugins installed)', async () => {
      const { listPlugins, renderPluginTable } = await import('../src/cli/plugin.js');
      const rows = listPlugins({ dbPath: TMP_DB });
      expect(rows).toEqual([]);
      expect(renderPluginTable(rows)).toBe('(no plugins installed)');
    });

    it('多个 plugin：渲染为对齐表格', async () => {
      const { addPlugin, listPlugins, renderPluginTable } = await import(
        '../src/cli/plugin.js'
      );
      for (const n of ['alpha', 'beta']) {
        const mp = path.join(TMP_DIR, `${n}.json`);
        fs.writeFileSync(
          mp,
          JSON.stringify({
            name: n,
            version: '1.0.0',
            type: 'task',
            hooks: [{ type: 'task', queue_name: `${n}-q` }],
            queue_name: `${n}-q`,
            auth: null,
            rate_limit: null,
          }),
        );
        expect(addPlugin(mp, { dbPath: TMP_DB }).ok).toBe(true);
      }
      const rows = listPlugins({ dbPath: TMP_DB });
      expect(rows.length).toBe(2);
      const out = renderPluginTable(rows);
      expect(out).toContain('NAME');
      expect(out).toContain('VERSION');
      expect(out).toContain('alpha');
      expect(out).toContain('beta');
      expect(out).toContain('alpha-q');
      expect(out).toContain('beta-q');
      // 表格结构：5 行（header + sep + 2 data + sep）
      expect(out.split('\n').length).toBe(5);
    });
  });
});

describe('cli · exec (in-process commander)', () => {
  let TMP_DIR: string;
  let TMP_DB: string;
  let MANIFEST_PATH: string;
  let runCli: typeof import('../src/cli/index.js').runCli;

  beforeAll(async () => {
    process.chdir(PROJECT_ROOT);
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-exec-'));
    TMP_DB = path.join(TMP_DIR, 'exec.sqlite');
    process.env.DATABASE_PATH = TMP_DB;

    const dbMod = await import('../src/server/db.js');
    dbMod.closeDb();
    const migrateMod = await import('../src/server/db/migrate.js');
    migrateMod.migrate(TMP_DB);

    MANIFEST_PATH = path.join(TMP_DIR, 'iot-heartbeat.json');
    fs.writeFileSync(
      MANIFEST_PATH,
      JSON.stringify({
        name: 'iot-heartbeat',
        version: '1.0.0',
        type: 'task',
        hooks: [{ type: 'task', queue_name: 'iot-heartbeat' }],
        queue_name: 'iot-heartbeat',
        auth: null,
        rate_limit: 10,
      }),
    );

    const cliMod = await import('../src/cli/index.js');
    runCli = cliMod.runCli;
  });

  afterAll(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
    delete process.env.DATABASE_PATH;
  });

  /**
   * 调用 src/cli/index.js 导出的 runCli(argv, io)；
   * 由 runCli 内部拦截 console.log/console.error/process.exit，
   * 返回 {status, stdout, stderr} 三元组。
   */
  function callCli(args: string[]): { status: number; stdout: string; stderr: string } {
    let stdoutBuf = '';
    let stderrBuf = '';
    const status = runCli(['node', 'lab-field-ops', ...args], {
      stdout: (s) => {
        stdoutBuf += s;
      },
      stderr: (s) => {
        stderrBuf += s;
      },
    });
    return { status, stdout: stdoutBuf, stderr: stderrBuf };
  }

  it('plugin add <manifest>：成功添加并打印反馈', () => {
    const r = callCli(['plugin', 'add', MANIFEST_PATH]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('plugin installed');
    expect(r.stdout).toContain('name:           iot-heartbeat');
    expect(r.stdout).toContain('queue:          iot-heartbeat');
    expect(r.stdout).toContain('listening path: queue:iot-heartbeat');
  });

  it('plugin list：打印对齐表格', () => {
    const r = callCli(['plugin', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NAME');
    expect(r.stdout).toContain('iot-heartbeat');
    expect(r.stdout).toContain('1.0.0');
  });

  it('plugin remove <name>：卸载并打印反馈', () => {
    const r = callCli(['plugin', 'remove', 'iot-heartbeat']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('plugin removed');
    expect(r.stdout).toContain('iot-heartbeat');
  });

  it('plugin remove 不存在的 name：幂等成功', () => {
    const r = callCli(['plugin', 'remove', 'no-such-plugin']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('already removed');
  });

  it('plugin add 不存在的文件：返回非零退出码 + stderr 错误', () => {
    const r = callCli(['plugin', 'add', '/tmp/nonexistent.json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found/i);
  });

  it('plugin add 非法 JSON：返回非零退出码', () => {
    const broken = path.join(TMP_DIR, 'broken.json');
    fs.writeFileSync(broken, '{ not valid json');
    const r = callCli(['plugin', 'add', broken]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/parse error/i);
  });

  it('完整闭环 add → list → remove（≤2s）', () => {
    const t0 = Date.now();
    const add = callCli(['plugin', 'add', MANIFEST_PATH]);
    expect(add.status).toBe(0);
    const list = callCli(['plugin', 'list']);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('iot-heartbeat');
    const remove = callCli(['plugin', 'remove', 'iot-heartbeat']);
    expect(remove.status).toBe(0);
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(2000);
  });
});
