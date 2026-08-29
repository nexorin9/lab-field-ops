// src/server/plugin/examples/lis-writeback.ts
// 示例 plugin：LIS writeback 通道。
// 队列名 lis-writeback；handler 处理 record.confirmed 事件 → 推标准 JSON payload
// （Task 11 writebackTask 的目标实现）。
//
// 当前文件仅定义 manifest + handler 形态，真实派发由 Task 10/11 的 createQueue 串联。
// 这里导出 register() 给 CLI（Task 9）调用，也供 tests/plugin.test.ts 单测验证。

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { PluginManager } from '../manager.js';
import { appendAudit } from '../../audit/ledger.js';
import type { JSONPayload, TaskHandler } from '@shared/types.js';

/** manifest 形态（与 examples/manifests/lis-writeback.json 一致）。 */
export const LIS_WRITEBACK_MANIFEST = {
  name: 'lis-writeback',
  version: '1.0.0',
  type: 'task' as const,
  hooks: [
    {
      type: 'task' as const,
      queue_name: 'lis-writeback',
    },
  ],
  queue_name: 'lis-writeback',
  auth: null,
  rate_limit: null,
};

/** writeback 默认目标文件路径（JSONL 追加）。 */
export function defaultLisWritebackPath(): string {
  return process.env.LIS_WRITEBACK_PATH ??
    path.join(process.cwd(), 'data', 'lis-writeback.ndjson');
}

/**
 * LIS writeback handler：把 record.confirmed payload 推送到 JSONL 文件。
 * 真实环境会替换为 LIS 标准协议（ASTM/HL7）；当前环境用 JSONL 作为替身。
 */
export const lisWritebackHandler: TaskHandler = async (payload) => {
  const filePath = defaultLisWritebackPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    record_id: payload.record_id,
    instrument_id: payload.instrument_id,
    alarm_code: payload.alarm_code,
    accession_no: payload.accession_no ?? null,
    operator_id: payload.operator_id ?? null,
    root_cause: payload.root_cause ?? null,
    steps: payload.steps ?? [],
    confirmed_at: payload.confirmed_at ?? null,
  }) + '\n';

  await fs.promises.appendFile(filePath, line, 'utf8');

  appendAudit({
    kind: 'writeback.initiated',
    operatorId: (payload.operator_id as string) ?? null,
    payload: {
      plugin: 'lis-writeback',
      record_id: payload.record_id,
      target: filePath,
    } as unknown as Record<string, unknown>,
  });
};

/** 注册入口：供 CLI plugin add 调用。 */
export function registerLisWriteback(): { ok: boolean; errors?: string[] } {
  return PluginManager.add(LIS_WRITEBACK_MANIFEST, {
    task: lisWritebackHandler,
    uninstall: async () => {
      // 关闭可能的文件句柄；当前实现仅清空，不删 JSONL 文件
    },
  });
}

/** 默认目标路径（用于测试断言）。 */
export function getWritebackPath(): string {
  return defaultLisWritebackPath();
}

/** 测试 helper：临时 JSONL 路径。 */
export function tempWritebackPath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lab-writeback-')),
    'lis-writeback.ndjson',
  );
}

/** JSON payload 类型（handler 入参）。 */
export type LisWritebackPayload = JSONPayload;
