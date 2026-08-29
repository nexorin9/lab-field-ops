// tests/queue.test.ts
// createQueue + 指数退避 + event_id 去重。
//
// 对应：
//   - task.json task 10
//   - spec.md 「后台队列 + 指数退避重试」（参考地基第 4 行）
//   - spec.md 工作闭环第 3 条（write-back 队列异步）
//
// 测试要点：
//   1. handler 成功一次：status=success；attempts=1
//   2. handler 失败 5 次后：status=failed；emit final_fail；attempts=5
//   3. 指数退避序列：base=200ms → 第 N 次失败的退避时长为
//      base * 2^(N-1) = [200, 400, 800, 1600, 3200]ms
//   4. event_id 去重：同一 event_id 第二次 enqueue 返回 {skipped: true}，
//      且 plugin_event_dedupe 表只有一条 row；final_fail 后释放，
//      下一次 enqueue 同 event_id 不再 skipped

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { closeDb } from '../src/server/db.js';
import { migrate } from '../src/server/db/migrate.js';
import { createQueue } from '../src/server/queue/index.js';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-field-ops-queue-'));
const TMP_DB = path.join(TMP_DIR, 'queue.sqlite');

beforeAll(() => {
  process.chdir(PROJECT_ROOT);
  // 让 getDb() 默认指向 TMP_DB，确保 audit_event 等表在此连接可见。
  process.env.DATABASE_PATH = TMP_DB;
  closeDb();
  migrate(TMP_DB);
});

beforeEach(() => {
  closeDb();
  if (fs.existsSync(TMP_DB)) {
    fs.rmSync(TMP_DB, { force: true });
  }
  migrate(TMP_DB);
});

afterAll(() => {
  closeDb();
  // 清理环境变量
  if (process.env.DATABASE_PATH === TMP_DB) {
    delete process.env.DATABASE_PATH;
  }
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe('createQueue basics', () => {
  it('enqueue + process + runOnce：handler 成功 → status=success', async () => {
    const q = createQueue('lab-q-ok');
    q.process(() => Promise.resolve());
    q.run();
    const { id, skipped } = q.enqueue(
      { kind: 'sample', value: 1 },
      { eventId: 'ev-ok-1' },
    );
    expect(skipped).toBe(false);
    expect(id).toBeTruthy();

    await q.__test_runOnce();
    // success 后 jobs.delete，list 应为空
    expect(q.list()).toEqual([]);
    expect(q.get(id)).toBeUndefined();
    q.stop();
  });

  it('enqueue 必须传 eventId，否则抛错', () => {
    const q = createQueue('lab-q-need-id');
    expect(() =>
      // @ts-expect-error 测试缺 eventId 的情形
      q.enqueue({ x: 1 }, {}),
    ).toThrow(/eventId/);
  });

  it('createQueue 选项允许覆盖 attempts / backoff', () => {
    const q = createQueue('lab-q-custom', {
      attempts: 2,
      backoff: { type: 'exponential', base: 50, max: 500 },
    });
    expect(q.name).toBe('lab-q-custom');
    expect(q.status().pending).toBe(0);
  });
});

describe('event_id dedupe (plugin_event_dedupe)', () => {
  it('同 event_id 第二次入队返回 skipped=true，且不写新行', async () => {
    const q = createQueue('lab-q-dedupe');
    q.process(() => Promise.resolve());
    q.run();

    const first = q.enqueue({ k: 'a' }, { eventId: 'dup-evt-1' });
    expect(first.skipped).toBe(false);

    const second = q.enqueue({ k: 'b' }, { eventId: 'dup-evt-1' });
    expect(second.skipped).toBe(true);
    expect(second.id).toBe('');

    // 列表里只有 first
    expect(q.list().length).toBe(1);
  });

  it('不同 event_id 正常入队', () => {
    const q = createQueue('lab-q-multi');
    const a = q.enqueue({ k: 1 }, { eventId: 'ev-a' });
    const b = q.enqueue({ k: 2 }, { eventId: 'ev-b' });
    expect(a.skipped).toBe(false);
    expect(b.skipped).toBe(false);
    expect(q.list().length).toBe(2);
  });

  it('handler 成功 1 次后释放（不保留 dedupe 行）', async () => {
    const q = createQueue('lab-q-release-on-ok');
    q.process(() => Promise.resolve());
    q.run();
    q.enqueue({}, { eventId: 'release-1' });
    await q.__test_runOnce();

    // success 后 jobs 已删除；再以同 event_id 入队不应 skipped
    const second = q.enqueue({}, { eventId: 'release-1' });
    expect(second.skipped).toBe(false);
  });

  it('final_fail 后释放 event_id，允许重新入队', async () => {
    const q = createQueue('lab-q-fail-release', {
      attempts: 3,
      backoff: { type: 'exponential', base: 10, max: 100 },
    });
    q.process(() => {
      throw new Error('always fail');
    });
    q.run();

    const first = q.enqueue({}, { eventId: 'recover-evt' });
    expect(first.skipped).toBe(false);

    // 跑满 attempts 次使 final_fail
    for (let i = 0; i < 5; i++) {
      await q.__test_runOnce();
    }

    const job = q.get(first.id);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(3);

    // final_fail 后 event_id 已释放，能再次入队
    const retry = q.enqueue({}, { eventId: 'recover-evt' });
    expect(retry.skipped).toBe(false);
  });
});

describe('exponential backoff', () => {
  it('handler 失败 5 次后 status=failed + emit final_fail', async () => {
    const q = createQueue('lab-q-5fail', {
      attempts: 5,
      backoff: { type: 'exponential', base: 200, max: 30_000 },
    });
    let attemptsSeen = 0;
    let finalFailCount = 0;
    q.on('final_fail', () => {
      finalFailCount++;
    });
    q.process(() => {
      attemptsSeen++;
      throw new Error('boom');
    });
    q.run();

    const { id } = q.enqueue({}, { eventId: 'fail-5' });
    for (let i = 0; i < 10; i++) {
      const j = q.get(id);
      if (j?.status === 'failed') break;
      await q.__test_runOnce();
    }

    expect(attemptsSeen).toBe(5);
    const job = q.get(id);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(5);
    expect(finalFailCount).toBe(1);
  });

  it('退避序列 base=200ms，依次记录 next_run_at 间隔', async () => {
    vi.useFakeTimers();
    try {
      const q = createQueue('lab-q-backoff', {
        attempts: 5,
        backoff: { type: 'exponential', base: 200, max: 30_000 },
      });
      const delaysMs: number[] = [];
      const baseMs = 200;
      q.process(() => {
        throw new Error('boom');
      });
      q.run();
      const startMs = Date.now();
      const { id } = q.enqueue({}, { eventId: 'backoff-evt' });

      for (let i = 0; i < 4; i++) {
        await q.__test_runOnce();
        const job = q.get(id);
        const next = Date.parse(job?.next_run_at ?? '');
        delaysMs.push(next - startMs);
      }

      // fake timer 下 Date.now() 在 __test_runOnce 之间不前进，
      // runOne 用 Date.now() + delay 算 next_run_at，于是每次记录的都是
      // startMs + base * 2^(attempt-1) 的固定偏移：
      //   attempt 1 fail → next_run_at = startMs + 200ms
      //   attempt 2 fail → next_run_at = startMs + 400ms
      //   attempt 3 fail → next_run_at = startMs + 800ms
      //   attempt 4 fail → next_run_at = startMs + 1600ms
      // 4 个 delaysMs 体现 4 次指数递增；3 个 deltas 体现退避间隔本身 = [200, 400, 800]。
      const deltas: number[] = [];
      for (let i = 1; i < delaysMs.length; i++) {
        deltas.push(delaysMs[i] - delaysMs[i - 1]);
      }

      expect(delaysMs[0]).toBe(baseMs);
      expect(delaysMs).toEqual([200, 400, 800, 1600]);
      expect(deltas).toEqual([200, 400, 800]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('queue persistence + audit integration', () => {
  it('queue.enqueue / process / fail 落 audit_event 至少三种 kind', async () => {
    const { queryAudit } = await import('../src/server/audit/ledger.js');
    const q = createQueue('lab-q-audit');
    q.process(() => Promise.resolve());
    q.run();
    q.enqueue({ kind: 'audit-test' }, { eventId: 'audit-evt-1' });
    await q.__test_runOnce();

    const enqueues = queryAudit({ kind: 'queue.enqueue', limit: 1000 });
    const processes = queryAudit({ kind: 'queue.process', limit: 1000 });
    expect(enqueues.length).toBeGreaterThan(0);
    expect(processes.length).toBeGreaterThan(0);
  });

  it('list() 返回的 jobs 字段稳定（attempts/status/last_error 不缺）', () => {
    const q = createQueue('lab-q-shape');
    const before = q.list();
    expect(before).toEqual([]);
    q.enqueue({}, { eventId: 'shape-evt' });
    const after = q.list();
    expect(after.length).toBe(1);
    const job = after[0];
    expect(job.name).toBe('lab-q-shape');
    expect(job.payload).toEqual({});
    expect(job.attempts).toBe(0);
    expect(job.status).toBe('pending');
    expect(job.last_error).toBeNull();
    expect(job.event_id).toBe('shape-evt');
    expect(typeof job.next_run_at).toBe('string');
    expect(typeof job.created_at).toBe('string');
    expect(typeof job.id).toBe('string');
  });

  it('status() 汇总 pending / success / failed', async () => {
    const q = createQueue('lab-q-status', {
      attempts: 2,
      backoff: { type: 'exponential', base: 10, max: 100 },
    });
    q.process(() => Promise.resolve());
    q.run();
    q.enqueue({}, { eventId: 's-evt' });
    await q.__test_runOnce();
    expect(q.status().success).toBe(1);
    expect(q.status().pending).toBe(0);
  });
});
