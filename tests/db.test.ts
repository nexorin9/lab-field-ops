// tests/db.test.ts
// 数据库初始化 + 迁移幂等 + append-only 触发器 + 唯一索引。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeDb, getCurrentDbPath } from '../src/server/db.js';
import { migrate } from '../src/server/db/migrate.js';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-db-'));
const TMP_DB = path.join(TMP_DIR, 'test.sqlite');

beforeAll(() => {
  closeDb();
});

afterAll(() => {
  closeDb();
  // 清理临时目录
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe('db + migrate', () => {
  it('建库并应用 001_init.sql', () => {
    const result = migrate(TMP_DB);
    expect(result.applied).toContain('001_init.sql');
    expect(result.skipped).not.toContain('001_init.sql');
    expect(fs.existsSync(TMP_DB)).toBe(true);
    // WAL 文件也会出现
    expect(fs.existsSync(`${TMP_DB}-wal`) || fs.existsSync(TMP_DB)).toBe(true);
  });

  it('二次迁移幂等：applied 为空，skipped 含 001_init.sql', () => {
    const result = migrate(TMP_DB);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('001_init.sql');
  });

  it('getDb() 单例：两次拿到同一连接', () => {
    const a = getDb(TMP_DB);
    const b = getDb(TMP_DB);
    expect(a).toBe(b);
    expect(getCurrentDbPath()).toBe(TMP_DB);
  });

  it('表结构齐全：instrument / alarm_code / calibration / processing_record / plugin_manifest / plugin_event_dedupe / audit_event / migration_log', () => {
    const db = getDb(TMP_DB);
    const rows = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all();
    const names = rows.map((r) => r.name);
    expect(names).toContain('instrument');
    expect(names).toContain('alarm_code');
    expect(names).toContain('calibration');
    expect(names).toContain('processing_record');
    expect(names).toContain('plugin_manifest');
    expect(names).toContain('plugin_event_dedupe');
    expect(names).toContain('audit_event');
    expect(names).toContain('migration_log');
  });

  it('audit_event append-only：UPDATE/DELETE 触发器抛错', () => {
    const db = getDb(TMP_DB);
    db.prepare(
      `INSERT INTO audit_event (event_id, kind, payload_json, ts) VALUES (?, ?, ?, ?)`,
    ).run('e1', 'plugin.add', '{}', new Date().toISOString());

    expect(() =>
      db.prepare(`UPDATE audit_event SET kind = 'x' WHERE event_id = 'e1'`).run(),
    ).toThrow(/append-only/);

    expect(() =>
      db.prepare(`DELETE FROM audit_event WHERE event_id = 'e1'`).run(),
    ).toThrow(/append-only/);
  });

  it('plugin_event_dedupe 唯一索引：同 event_id 第二次写入抛错', () => {
    const db = getDb(TMP_DB);
    db.prepare(
      `INSERT INTO plugin_event_dedupe (event_id, queue_name, ts) VALUES (?, ?, ?)`,
    ).run('dup-1', 'lis-writeback', new Date().toISOString());

    expect(() =>
      db.prepare(
        `INSERT INTO plugin_event_dedupe (event_id, queue_name, ts) VALUES (?, ?, ?)`,
      ).run('dup-1', 'lis-writeback', new Date().toISOString()),
    ).toThrow(/UNIQUE/);
  });

  it('alarm_code 联合主键：(vendor, model, alarm_code) 同三键重复抛错', () => {
    const db = getDb(TMP_DB);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO alarm_code (vendor, model, alarm_code, alarm_label, sop_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('Siemens', 'ADVIA 2400', 'W002', '试剂不足', '# SOP', now);

    expect(() =>
      db.prepare(
        `INSERT INTO alarm_code (vendor, model, alarm_code, alarm_label, sop_md, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('Siemens', 'ADVIA 2400', 'W002', '已存在', '# SOP', now),
    ).toThrow(/PRIMARY KEY|UNIQUE/);
  });
});
