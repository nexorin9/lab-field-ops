// src/server/db/migrate.ts
// 扫描 src/server/migrations/ 下 *.sql 按文件名升序执行；
// 已应用的写入 migration_log，再次启动幂等跳过。
// 注意：migration_log 表本身由 001_init.sql 创建——首次查询前需容错。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 候选 migrations 路径：src/server/migrations/，但 ts-node 运行时 cwd 在项目根
function resolveMigrationsDir(): string {
  // 1) 优先用相对路径（项目根 cwd）
  const candidate = path.resolve(process.cwd(), 'src/server/migrations');
  if (fs.existsSync(candidate)) return candidate;

  // 2) 回退：从本文件位置向上找 src/server/migrations
  const alt = path.resolve(__dirname, '..', 'migrations');
  if (fs.existsSync(alt)) return alt;

  throw new Error(
    `migrations 目录未找到（已尝试 ${candidate} 与 ${alt}）`,
  );
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  total: number;
}

export function migrate(dbPath?: string): MigrateResult {
  const db = getDb(dbPath);
  const dir = resolveMigrationsDir();

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  // 先建迁移记录表（确保后续查询可用；幂等 CREATE IF NOT EXISTS）。
  // 这是 001_init.sql 之外的轻量引导，不计入迁移文件列表。
  db.exec(`CREATE TABLE IF NOT EXISTS migration_log (
    filename    TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
  )`);

  // 已应用列表（容错：首次迁移时 migration_log 还未建，上方已建好）
  const isApplied = db.prepare<[], { filename: string }>(
    'SELECT filename FROM migration_log',
  );
  const done = new Set(isApplied.all().map((r) => r.filename));

  const insertLog = db.prepare(
    'INSERT INTO migration_log (filename, applied_at) VALUES (?, ?)',
  );

  for (const f of files) {
    if (done.has(f)) {
      skipped.push(f);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, f), 'utf-8');
    const tx = db.transaction(() => {
      db.exec(sql);
      insertLog.run(f, new Date().toISOString());
    });
    tx();
    applied.push(f);
  }

  return { applied, skipped, total: files.length };
}

/** CLI 入口：`pnpm ts-node src/server/db/migrate.ts` */
export function main(): void {
  const result = migrate();
  // eslint-disable-next-line no-console
  console.log(
    `[migrate] total=${result.total} applied=[${result.applied.join(', ')}] skipped=[${result.skipped.join(', ')}]`,
  );
}

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('migrate.ts')
) {
  main();
}
