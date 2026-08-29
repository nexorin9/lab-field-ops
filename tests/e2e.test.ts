// tests/e2e.test.ts
//
// 端到端测试：seed → 启动 HTTP server → curl /api/instruments → 模拟粘贴
// lis:// URL 触发 embed → 创建 processing-record → confirm → 队列异步
// 落 JSONL → 看板 /api/queue/status 反映 success。
//
// 与单元测试的差异：
//   1. 走真实 HTTP（main.ts → node:http），不是 in-process 调用 route 函数
//   2. 走 supertest + node-fetch 的等效 fetch（Node 20 内置 fetch）
//   3. server.startServer(port=0) → OS 分配端口 → handle.url 作为 base
//   4. 队列异步 handler 在 setImmediate tick 完成后被消费；测试用 setTimeout
//      等待 writeback handler 落 JSONL
//
// 关键不变量（对应 spec.md 工作闭环 4 步）：
//   1. seed 后 DB 含 3 台脱敏仪器
//   2. /api/instruments 返回 3 台仪器
//   3. matchEmbeds 把 lis://reports/L… 匹配到 lis-report 描述子
//   4. POST /api/processing-records 创建记录成功（201 + record_id）
//   5. POST /api/processing-records/:id/confirm 推进 verified → 入队
//   6. 队列 handler 成功 → JSONL 文件落 1 行
//   7. GET /api/queue/status 反映 success ≥ 1
//
// 替代测试场景（plugin 生命周期）：GET /api/plugins → 看见 lis-writeback；
// DELETE /api/plugins/:name → 卸载成功，幂等。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import httpReq from 'supertest';
import { readFileSync, existsSync } from 'node:fs';
import {
  setupE2eEnv,
  teardownE2eEnv,
  startE2eServer,
  type E2eEnv,
} from './__setup__/env.js';
import { matchEmbeds } from '../src/shared/embeds/index.js';
import { createQueue } from '../src/server/queue/index.js';
import {
  LIS_WRITEBACK_QUEUE,
  lisWritebackHandler,
} from '../src/server/queue/tasks/writeback.js';
import { PluginManager } from '../src/server/plugin/manager.js';
import { getDb } from '../src/server/db.js';

let env: E2eEnv;

beforeAll(async () => {
  env = await setupE2eEnv();
  await startE2eServer(env, 0);
});

afterAll(async () => {
  await teardownE2eEnv(env);
});

/** 用 supertest 直接打 main.ts 的 HTTP server（不启新端口）。 */
function http() {
  if (!env.server) throw new Error('e2e server not started');
  return httpReq(env.server.url);
}

describe('端到端：health + 命中仪器 + 写记录 + 队列落 JSONL + 看板反映', () => {
  it('GET /api/health → ok', async () => {
    const res = await http().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('完整链路 6 步：seed → 启动 → 命中 → 写入 → confirm → 看板', async () => {
    // 步骤 1: GET /api/instruments → 确认 seed 灌入了 3 台仪器
    const instrumentsRes = await http().get('/api/instruments');
    expect(instrumentsRes.status).toBe(200);
    expect(instrumentsRes.body.instruments.length).toBe(3);
    const firstInstrument = instrumentsRes.body.instruments[0];
    expect(firstInstrument.vendor).toMatch(/Siemens|Roche|Abbott/);

    // 步骤 2: matchEmbeds 模拟粘贴 lis:// URL → 命中 lis-report 描述子
    const lisUrl = 'lis://reports/L20240117001';
    const hits = matchEmbeds(lisUrl);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].descriptor.name).toBe('lis-report');
    expect(hits[0].key).toBe('L20240117001');

    // 步骤 3: POST /api/processing-records → 创建一条 received 态记录
    const createRes = await http()
      .post('/api/processing-records')
      .send({
        instrument_id: firstInstrument.instrument_id,
        alarm_code: 'W002',
        operator_id: 'e2e-operator',
        root_cause: '样本凝块',
        steps: ['检查样本', '重离心', '重测'],
        accession_no: 'L20240117001',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.record_id).toBeDefined();
    const recordId = createRes.body.record_id;

    // 步骤 3.5: 手动推进到 'parsed' 态（state-machine 要求 received → parse → parsed
    //   → verify → verified；当前没有公开 parse 端点，与 tests/stateMachine.test.ts:459
    //   同一约定：测试用 SQL 直接推进。生产 UI/批处理负责这一步。）
    getDb()
      .prepare("UPDATE processing_record SET state = 'parsed' WHERE record_id = ?")
      .run(recordId);

    // 步骤 4: POST /api/processing-records/:id/confirm → 推进 verified + 入队
    //    （走的是真实 HTTP；server 端路由 → confirm route → state-machine → enqueue）
    const confirmRes = await http()
      .post(`/api/processing-records/${recordId}/confirm`)
      .send({ operator_id: 'e2e-operator' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.idempotent).toBe(false);
    expect(confirmRes.body.enqueued).not.toBeNull();
    expect(confirmRes.body.enqueued.skipped).toBe(false);

    // 二次 confirm → 幂等返回，不重复入队
    const confirmRes2 = await http()
      .post(`/api/processing-records/${recordId}/confirm`)
      .send({ operator_id: 'e2e-operator' });
    expect(confirmRes2.status).toBe(200);
    expect(confirmRes2.body.idempotent).toBe(true);

    // 步骤 5: 等待队列 handler 把 writeback 落 JSONL
    //   queue.run() 在 routes/processing-records.ts 调用 registerAllTasks 后已经
    //   setImmediate 调度；handler 内部 pushToLisWritebackChannel + markWritebackSuccess
    //   同步 await；给一点 buffer 时间（典型 < 100ms）
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(existsSync(env.tmpWritebackPath)).toBe(true);
    const lines = readFileSync(env.tmpWritebackPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const row = JSON.parse(lines[0]);
    expect(row.record_id).toBe(recordId);
    expect(row.instrument_id).toBe(firstInstrument.instrument_id);
    expect(row.accession_no).toBe('L20240117001');

    // 步骤 6: GET /api/queue/status 反映 success
    const statusRes = await http().get('/api/queue/status');
    expect(statusRes.status).toBe(200);
    expect(Array.isArray(statusRes.body.queues)).toBe(true);
    const lisWritebackStatus = statusRes.body.queues.find(
      (q: { name: string }) => q.name === 'lis-writeback',
    );
    expect(lisWritebackStatus).toBeDefined();
    // queue observer 计数：success ≥ 1
    expect(lisWritebackStatus.success).toBeGreaterThanOrEqual(1);
  });
});

describe('端到端：plugin REST 端点（list / delete）', () => {
  it('GET /api/plugins 返回已注册 plugin', async () => {
    const res = await http().get('/api/plugins');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.plugins)).toBe(true);
    const lis = res.body.plugins.find((p: { name: string }) => p.name === 'lis-writeback');
    expect(lis).toBeDefined();
  });

  it('DELETE /api/plugins/:name 卸载 plugin（幂等）', async () => {
    const res1 = await http().delete('/api/plugins/lis-writeback');
    expect(res1.status).toBe(200);
    const res2 = await http().delete('/api/plugins/lis-writeback');
    expect(res2.status).toBe(200);
    if ('already_removed' in res2.body) {
      expect(res2.body.already_removed).toBe(true);
    }
  });
});

describe('端到端：REST 错误语义 + 边界', () => {
  it('GET /api/instruments/:id 不存在 → 404 NOT_FOUND', async () => {
    const res = await http().get('/api/instruments/NO-SUCH-ID');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/processing-records 缺 operator_id → 400 VALIDATION_ERROR', async () => {
    const instrumentsRes = await http().get('/api/instruments');
    const firstInstrument = instrumentsRes.body.instruments[0];
    const res = await http()
      .post('/api/processing-records')
      .send({
        instrument_id: firstInstrument.instrument_id,
        alarm_code: 'W002',
        // 故意漏 operator_id
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/processing-records/:id/confirm 不存在的 record → 404', async () => {
    const res = await http()
      .post('/api/processing-records/00000000-0000-0000-0000-000000000000/confirm')
      .send({ operator_id: 'e2e-operator' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/queue/:name/jobs 不存在的队列 → 404', async () => {
    const res = await http().get('/api/queue/no-such-queue/jobs');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/processing-records/:id/retry 在 written_back 上 → 409 CONFLICT', async () => {
    // 拿一条已确认的 record 来 retry
    const instrumentsRes = await http().get('/api/instruments');
    const firstInstrument = instrumentsRes.body.instruments[0];
    const createRes = await http()
      .post('/api/processing-records')
      .send({
        instrument_id: firstInstrument.instrument_id,
        alarm_code: 'C301',
        operator_id: 'e2e-operator',
        root_cause: '温度漂移',
        steps: ['复温', '重测'],
        accession_no: 'L20240117002',
      });
    const recordId = createRes.body.record_id;
    // confirm → 推到 writeback_pending；等队列处理 → written_back
    await http()
      .post(`/api/processing-records/${recordId}/confirm`)
      .send({ operator_id: 'e2e-operator' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // 现在的 state 应是 written_back；retry 拒绝
    const retryRes = await http()
      .post(`/api/processing-records/${recordId}/retry`)
      .send({ operator_id: 'e2e-operator' });
    expect(retryRes.status).toBe(409);
    expect(retryRes.body.error.code).toBe('CONFLICT');
  });
});

describe('端到端：Embed 与 lis-writeback queue handler 集成（in-process 旁路校验）', () => {
  it('直接入队 lis-writeback + 调 handler → 落 JSONL（不依赖 server 端 confirm 路径）', async () => {
    // 复制 writeback queue + handler（与 server 启动时的同实例；观察 observer 已挂上）
    const queue = createQueue(LIS_WRITEBACK_QUEUE, {
      attempts: 1,
      backoff: { type: 'exponential', base: 100, max: 5000 },
    });
    // 用 plugin 注册的 handler 或默认 handler（与 e2e.test 主体保持兼容）
    const handlers = PluginManager.getTaskHandlers('lis-writeback');
    if (handlers.length > 0) {
      queue.process(handlers[0] as never);
    } else {
      queue.process(lisWritebackHandler as never);
    }
    queue.enqueue(
      {
        record_id: 'in-process-record-1',
        instrument_id: null,
        alarm_code: 'A045',
        accession_no: 'L20240117999',
        operator_id: 'e2e-direct',
        root_cause: 'in-process enqueue',
        steps: ['in-process'],
        confirmed_at: new Date().toISOString(),
      },
      { eventId: 'e2e-direct-in-process-record-1' },
    );
    queue.run();
    await new Promise((resolve) => setTimeout(resolve, 300));
    queue.stop();

    const lines = readFileSync(env.tmpWritebackPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    // 至少 1 行（可能包含前几个 case 落下的）
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const ids = lines.map((l) => JSON.parse(l).record_id);
    expect(ids).toContain('in-process-record-1');
  });
});