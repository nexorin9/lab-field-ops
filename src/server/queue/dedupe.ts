// src/server/queue/dedupe.ts
//
// 事件去重（plugin_event_dedupe 唯一索引）：
//   - 入队前查表：存在 → skipped
//   - 不存在 → 写入新 row 占位（queue_name + ts + event_id 主键）
//   - attempts 用尽（final_fail）→ 释放 event_id，便于将来重新触发
//
// 写入失败：以 best-effort 处理；不抛错（避免主路径因为审计/去重 IO 错误中止）。
// 返回 {ok: true} 或 {ok: false, reason: 'duplicate'}。

import { getDb } from '../db';

export interface DedupeClaim {
  ok: boolean;
  reason?: 'duplicate';
}

const isoNow = () => new Date().toISOString();

const insertDedupe = (eventId: string, queueName: string): boolean => {
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO plugin_event_dedupe (event_id, queue_name, ts) VALUES (?, ?, ?)`,
    ).run(eventId, queueName, isoNow());
    return true;
  } catch {
    return false;
  }
};

const existsDedupe = (eventId: string): boolean => {
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT 1 AS hit FROM plugin_event_dedupe WHERE event_id = ?')
      .get(eventId);
    return Boolean(row);
  } catch {
    return false;
  }
};

export function claimEventId(eventId: string, queueName: string): DedupeClaim {
  if (existsDedupe(eventId)) {
    return { ok: false, reason: 'duplicate' };
  }
  insertDedupe(eventId, queueName);
  return { ok: true };
}

export function releaseEventId(eventId: string): void {
  try {
    const db = getDb();
    db.prepare('DELETE FROM plugin_event_dedupe WHERE event_id = ?').run(eventId);
  } catch {
    /* ignore */
  }
}

export function isDuplicate(eventId: string): boolean {
  return existsDedupe(eventId);
}
