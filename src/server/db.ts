// src/server/db.ts
// better-sqlite3 单例 + WAL 模式 + 外键开启。
// 提供 getDb() / closeDb()；所有数据库操作共享同一连接。

import Database, { type Database as DBType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let dbInstance: DBType | null = null;
let currentPath: string | null = null;

const DEFAULT_DB_DIR = path.resolve(process.cwd(), 'data');
const DEFAULT_DB_FILE = path.join(DEFAULT_DB_DIR, 'lab-field-ops.sqlite');

function ensureDir(p: string): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 获取 SQLite 单例。多次调用复用同一连接。
 * @param dbPath 数据库文件路径；默认 process.env.DATABASE_PATH 或 data/lab-field-ops.sqlite
 * @param force 是否强制重建（测试场景：先 closeDb 再 getDb(true)）
 */
export function getDb(dbPath?: string, force = false): DBType {
  const targetPath =
    dbPath ?? process.env.DATABASE_PATH ?? DEFAULT_DB_FILE;

  if (dbInstance && currentPath === targetPath && !force) {
    return dbInstance;
  }

  if (dbInstance && force) {
    try {
      dbInstance.close();
    } catch {
      /* ignore */
    }
    dbInstance = null;
  }

  ensureDir(targetPath);
  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  dbInstance = db;
  currentPath = targetPath;
  return db;
}

/** 关闭并清空单例（测试 cleanup 用）。 */
export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      /* ignore */
    }
    dbInstance = null;
    currentPath = null;
  }
}

/** 当前连接的 db 文件路径（测试断言用）。 */
export function getCurrentDbPath(): string | null {
  return currentPath;
}
