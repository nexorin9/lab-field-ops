// tests/__setup__/env.ts
//
// e2e 测试公用 setup helper：
//   - 创建隔离临时目录（每个 describe 独立，避免跨 case 串扰）
//   - 把 DATABASE_PATH / LIS_WRITEBACK_PATH 指到 tmp 下；触发 db.ts 单例重置
//   - 提供 withE2eEnv() 上下文，自动迁移 + seed + 安装内置 embed 描述子
//   - 提供 stopAll(handle) 收尾工具：close db + rm tmpdir + 清环境变量
//
// 设计取舍：
//   - 用 beforeAll/afterAll 显式调 setup/teardown，不绑 describe.concurrent，
//     让 vitest 的 --sequence 选项仍生效
//   - 不在 setup 时启 server；server 启动由 e2e 单独管（避免 server 生命周期
//     跨 describe 泄漏）
//   - 临时 JSONL 路径默认 <tmpdir>/lis-writeback.ndjson，e2e 的 JSONL 断言
//     走这个固定路径
//   - tmpdir 是 vitest 已知目录（os.tmpdir()），CI 在 Linux runner 上也兼容

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../../src/server/db.js';
import { migrate } from '../../src/server/db/migrate.js';
import { seed } from '../../src/cli/seed.js';
import { installBuiltinDescriptors } from '../../src/shared/embeds/registry.js';
import { PluginManager } from '../../src/server/plugin/manager.js';
import { lisWritebackHandler } from '../../src/server/queue/tasks/writeback.js';
import { registerAllTasks } from '../../src/server/queue/register.js';
import { startServer, type ServerHandle } from '../../src/server/main.js';

export interface E2eEnv {
  tmpDir: string;
  tmpDbPath: string;
  tmpWritebackPath: string;
  /** 启 server 后填入；beforeAll 阶段可能为 null。 */
  server: ServerHandle | null;
}

/**
 * 在 beforeAll 中调用：建 tmpdir + 重置 db + migrate + seed + 安装内置 embed。
 * 不启动 server；server 由 e2e 在需要时单独 startServer。
 */
export async function setupE2eEnv(): Promise<E2eEnv> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lab-field-ops-e2e-'));
  const tmpDbPath = join(tmpDir, 'test.db');
  const tmpWritebackPath = join(tmpDir, 'lis-writeback.ndjson');
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.LIS_WRITEBACK_PATH = tmpWritebackPath;
  closeDb();
  getDb(tmpDbPath); // 触发单例重建到新路径
  migrate(tmpDbPath);
  seed();
  installBuiltinDescriptors();

  // 注册示例 plugin：lis-writeback（队列入队会查这个 handler）
  PluginManager.reset();
  PluginManager.add(
    {
      name: 'lis-writeback',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
      queue_name: 'lis-writeback',
      auth: null,
      rate_limit: null,
    },
    {
      task: lisWritebackHandler,
      uninstall: async () => {},
    },
  );
  // 启动 writeback + heartbeat queue
  registerAllTasks();

  return { tmpDir, tmpDbPath, tmpWritebackPath, server: null };
}

/**
 * 在 afterAll 中调用：close server（如有）+ close db + rm tmpdir + 清环境变量。
 */
export async function teardownE2eEnv(env: E2eEnv): Promise<void> {
  if (env.server) {
    await env.server.close().catch(() => {
      /* swallow */
    });
  }
  closeDb();
  try {
    rmSync(env.tmpDir, { recursive: true, force: true });
  } catch {
    /* tmpdir 可能已被外部 rm，忽略 */
  }
  delete process.env.DATABASE_PATH;
  delete process.env.LIS_WRITEBACK_PATH;
}

/**
 * 在 e2e 里启动 server 并塞到 env.server 上。e2e 收尾由 teardownE2eEnv 负责 close。
 */
export async function startE2eServer(env: E2eEnv, port = 0): Promise<ServerHandle> {
  const server = await startServer({ port, host: '127.0.0.1' });
  env.server = server;
  return server;
}

/**
 * 强制重置 queue / observer 状态。在并发 describe 之间清理用。
 */
export function resetRuntimeState(): void {
  PluginManager.reset();
  // queue / observer 状态由各自模块的 __reset helper 处理，调用方按需调
}