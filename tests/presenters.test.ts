// tests/presenters.test.ts
//
// 6 个 presenter 的字段命名稳定 + 解析/序列化形态守卫。
// 这是 contract v1 的真源；后续 Task 24 的 contracts.ts 用 Zod schema 锁字段。

import { describe, it, expect } from 'vitest';
import {
  presentInstrument,
  presentInstruments,
  type InstrumentRow,
} from '../src/server/presenters/instrument.js';
import {
  presentAlarmCode,
  presentAlarmCodes,
  alarmJoinKey,
  type AlarmCodeRow,
} from '../src/server/presenters/alarmCode.js';
import {
  presentCalibration,
  presentCalibrations,
  type CalibrationRow,
} from '../src/server/presenters/calibration.js';
import {
  presentProcessingRecord,
  presentProcessingRecords,
  type ProcessingRecordRow,
} from '../src/server/presenters/processingRecord.js';
import {
  presentPlugin,
  presentPlugins,
  computeListeningPath,
  type PresentedPlugin,
} from '../src/server/presenters/plugin.js';
import type { PluginEntry } from '../src/server/plugin/types.js';
import {
  presentAuditEvent,
  presentAuditEvents,
  type AuditEventRow,
} from '../src/server/presenters/auditEvent.js';

// ───────────────────────────── Instrument ─────────────────────────────

describe('presentInstrument', () => {
  const sampleRow: InstrumentRow = {
    instrument_id: 'ASSET-LAB-0001',
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    asset_tag: 'TAG-XYZ-001',
    location: '门诊二楼检验科 A 区',
    status: 'online',
    installed_at: '2024-01-15T08:00:00.000Z',
    last_seen_at: '2024-08-29T10:30:00.000Z',
  };

  it('字段命名稳定：原样保留 snake_case', () => {
    const out = presentInstrument(sampleRow);
    expect(out.instrument_id).toBe('ASSET-LAB-0001');
    expect(out.vendor).toBe('Siemens');
    expect(out.model).toBe('ADVIA 2400');
    expect(out.asset_tag).toBe('TAG-XYZ-001');
    expect(out.location).toBe('门诊二楼检验科 A 区');
    expect(out.status).toBe('online');
    expect(out.installed_at).toBe('2024-01-15T08:00:00.000Z');
    expect(out.last_seen_at).toBe('2024-08-29T10:30:00.000Z');
  });

  it('status 枚举值原样保留', () => {
    expect(presentInstrument({ ...sampleRow, status: 'offline' }).status).toBe('offline');
    expect(presentInstrument({ ...sampleRow, status: 'alarm' }).status).toBe('alarm');
  });

  it('last_seen_at 为 null 时保留 null', () => {
    expect(presentInstrument({ ...sampleRow, last_seen_at: null }).last_seen_at).toBeNull();
  });

  it('presentInstruments 批量转换', () => {
    const rows = [
      sampleRow,
      { ...sampleRow, instrument_id: 'ASSET-LAB-0002' },
    ];
    const out = presentInstruments(rows);
    expect(out).toHaveLength(2);
    expect(out[1].instrument_id).toBe('ASSET-LAB-0002');
  });
});

// ───────────────────────────── AlarmCode ─────────────────────────────

describe('presentAlarmCode', () => {
  const sampleRow: AlarmCodeRow = {
    vendor: 'Siemens',
    model: 'ADVIA 2400',
    alarm_code: 'W002',
    alarm_label: '试剂仓温度高',
    sop_md: '## 检查步骤\n1. ...',
    created_at: '2024-01-15T08:00:00.000Z',
  };

  it('字段命名稳定 + join_key 拼装', () => {
    const out = presentAlarmCode(sampleRow);
    expect(out.vendor).toBe('Siemens');
    expect(out.model).toBe('ADVIA 2400');
    expect(out.alarm_code).toBe('W002');
    expect(out.join_key).toBe('Siemens|ADVIA 2400|W002');
    expect(out.alarm_label).toBe('试剂仓温度高');
    expect(out.sop_md).toBe('## 检查步骤\n1. ...');
    expect(out.created_at).toBe('2024-01-15T08:00:00.000Z');
  });

  it('alarmJoinKey 与 presenter 内拼装一致', () => {
    expect(alarmJoinKey('A', 'B', 'C')).toBe('A|B|C');
    const out = presentAlarmCode(sampleRow);
    expect(out.join_key).toBe(alarmJoinKey(out.vendor, out.model, out.alarm_code));
  });

  it('presentAlarmCodes 批量 + 空数组', () => {
    expect(presentAlarmCodes([])).toEqual([]);
    expect(presentAlarmCodes([sampleRow])).toHaveLength(1);
  });
});

// ───────────────────────────── Calibration ─────────────────────────────

describe('presentCalibration', () => {
  const sampleRow: CalibrationRow = {
    calibration_id: 'C-2024-001',
    instrument_id: 'ASSET-LAB-0001',
    calibrated_at: '2024-08-29T08:00:00.000Z',
    payload_json: JSON.stringify({ qc: 'pass', k: 1.5 }),
    raw_hash: 'sha256:abc123',
  };

  it('payload_json 解析为对象', () => {
    const out = presentCalibration(sampleRow);
    expect(out.payload).toEqual({ qc: 'pass', k: 1.5 });
    expect(out.calibration_id).toBe('C-2024-001');
    expect(out.instrument_id).toBe('ASSET-LAB-0001');
    expect(out.raw_hash).toBe('sha256:abc123');
  });

  it('payload_json 解析失败回退空对象（fail-soft）', () => {
    const out = presentCalibration({ ...sampleRow, payload_json: 'not-json' });
    expect(out.payload).toEqual({});
  });

  it('payload_json 空字符串回退空对象', () => {
    expect(presentCalibration({ ...sampleRow, payload_json: '' }).payload).toEqual({});
  });

  it('payload_json 是数组时回退空对象（calibration 必须是对象）', () => {
    expect(presentCalibration({ ...sampleRow, payload_json: '[1,2,3]' }).payload).toEqual({});
  });

  it('presentCalibrations 批量', () => {
    expect(presentCalibrations([sampleRow, sampleRow])).toHaveLength(2);
  });
});

// ───────────────────────────── ProcessingRecord ─────────────────────────────

describe('presentProcessingRecord', () => {
  const sampleRow: ProcessingRecordRow = {
    record_id: 'PR-001',
    instrument_id: 'ASSET-LAB-0001',
    alarm_code: 'W002',
    operator_id: 'op-007',
    root_cause: '试剂仓温度波动',
    steps_json: JSON.stringify(['打开仓门', '检查试剂']),
    confirmed_at: null,
    state: 'received',
    retry_count: 0,
    payload_json: JSON.stringify({ accession: 'L20240829001' }),
    accession_no: 'L20240829001',
  };

  it('steps_json / payload_json 解析为数组 / 对象', () => {
    const out = presentProcessingRecord(sampleRow);
    expect(out.steps).toEqual(['打开仓门', '检查试剂']);
    expect(out.payload).toEqual({ accession: 'L20240829001' });
    expect(out.record_id).toBe('PR-001');
    expect(out.state).toBe('received');
    expect(out.accession_no).toBe('L20240829001');
  });

  it('steps_json 解析失败回退空数组', () => {
    expect(presentProcessingRecord({ ...sampleRow, steps_json: 'broken' }).steps).toEqual([]);
  });

  it('payload_json 解析失败回退空对象', () => {
    expect(presentProcessingRecord({ ...sampleRow, payload_json: 'broken' }).payload).toEqual({});
  });

  it('confirmed_at / accession_no 为 null 时保留 null', () => {
    const out = presentProcessingRecord({
      ...sampleRow,
      confirmed_at: null,
      accession_no: null,
    });
    expect(out.confirmed_at).toBeNull();
    expect(out.accession_no).toBeNull();
  });

  it('state 枚举值原样保留（含全 6 态）', () => {
    const states = ['received', 'parsed', 'verified', 'writeback_pending', 'written_back', 'failed'] as const;
    for (const s of states) {
      expect(presentProcessingRecord({ ...sampleRow, state: s }).state).toBe(s);
    }
  });

  it('presentProcessingRecords 批量', () => {
    expect(presentProcessingRecords([])).toEqual([]);
    expect(presentProcessingRecords([sampleRow, sampleRow])).toHaveLength(2);
  });
});

// ───────────────────────────── Plugin ─────────────────────────────

describe('presentPlugin', () => {
  const sampleEntry: PluginEntry = {
    manifest: {
      name: 'lis-writeback',
      version: '1.0.0',
      type: 'task',
      hooks: [{ type: 'task', queue_name: 'lis-writeback' }],
      queue_name: 'lis-writeback',
      auth: null,
      rate_limit: null,
    },
    installedAt: '2024-08-29T10:00:00.000Z',
  };

  it('字段命名稳定 + listening_path 计算', () => {
    const out = presentPlugin(sampleEntry);
    expect(out.name).toBe('lis-writeback');
    expect(out.version).toBe('1.0.0');
    expect(out.type).toBe('task');
    expect(out.queue_name).toBe('lis-writeback');
    expect(out.installed_at).toBe('2024-08-29T10:00:00.000Z');
    expect(out.listening_path).toBe('queue:lis-writeback');
  });

  it('Hook.API → listening_path=/api/plugins/<name>', () => {
    const apiEntry: PluginEntry = {
      manifest: {
        ...sampleEntry.manifest,
        type: 'api',
        queue_name: null,
        hooks: [{ type: 'api', path: '/custom/path' }],
      },
      installedAt: sampleEntry.installedAt,
    };
    expect(presentPlugin(apiEntry).listening_path).toBe('/custom/path');
  });

  it('Hook.API 无 path → /api/plugins/<name>', () => {
    const apiEntry: PluginEntry = {
      manifest: {
        ...sampleEntry.manifest,
        type: 'api',
        queue_name: null,
        hooks: [{ type: 'api' }],
      },
      installedAt: sampleEntry.installedAt,
    };
    expect(presentPlugin(apiEntry).listening_path).toBe('/api/plugins/lis-writeback');
  });

  it('Hook.Unfurl → listening_path=unfurl-registry:<name>', () => {
    const unfurlEntry: PluginEntry = {
      manifest: {
        ...sampleEntry.manifest,
        type: 'unfurl',
        queue_name: null,
        hooks: [{ type: 'unfurl' }],
      },
      installedAt: sampleEntry.installedAt,
    };
    expect(presentPlugin(unfurlEntry).listening_path).toBe('unfurl-registry:lis-writeback');
  });

  it('rate_limit 与 auth 字段原样保留', () => {
    const entry: PluginEntry = {
      manifest: {
        ...sampleEntry.manifest,
        rate_limit: 10,
        auth: { type: 'token', token: 'secret' },
      },
      installedAt: sampleEntry.installedAt,
    };
    const out = presentPlugin(entry);
    expect(out.rate_limit).toBe(10);
    expect(out.auth).toEqual({ type: 'token', token: 'secret' });
  });

  it('presentPlugins 批量', () => {
    expect(presentPlugins([sampleEntry, sampleEntry])).toHaveLength(2);
  });

  it('computeListeningPath 纯函数（与 presenter 同源）', () => {
    expect(computeListeningPath(sampleEntry)).toBe('queue:lis-writeback');
  });
});

// ───────────────────────────── AuditEvent ─────────────────────────────

describe('presentAuditEvent', () => {
  const sampleRow: AuditEventRow = {
    event_id: 'evt-001',
    kind: 'plugin.add',
    req_hash: 'h-req',
    resp_hash: 'h-resp',
    operator_id: 'op-007',
    payload_json: JSON.stringify({ name: 'lis-writeback', version: '1.0.0' }),
    ts: '2024-08-29T10:00:00.000Z',
    related_event_id: null,
  };

  it('字段命名稳定 + payload_json 解析', () => {
    const out = presentAuditEvent(sampleRow);
    expect(out.event_id).toBe('evt-001');
    expect(out.kind).toBe('plugin.add');
    expect(out.req_hash).toBe('h-req');
    expect(out.resp_hash).toBe('h-resp');
    expect(out.operator_id).toBe('op-007');
    expect(out.payload).toEqual({ name: 'lis-writeback', version: '1.0.0' });
    expect(out.ts).toBe('2024-08-29T10:00:00.000Z');
    expect(out.related_event_id).toBeNull();
  });

  it('payload_json 解析失败回退空对象（audit 完整性优先）', () => {
    expect(presentAuditEvent({ ...sampleRow, payload_json: 'broken' }).payload).toEqual({});
  });

  it('req_hash / resp_hash / operator_id 为 null 时保留 null', () => {
    const out = presentAuditEvent({
      ...sampleRow,
      req_hash: null,
      resp_hash: null,
      operator_id: null,
    });
    expect(out.req_hash).toBeNull();
    expect(out.resp_hash).toBeNull();
    expect(out.operator_id).toBeNull();
  });

  it('presentAuditEvents 批量', () => {
    expect(presentAuditEvents([sampleRow])).toHaveLength(1);
    expect(presentAuditEvents([])).toEqual([]);
  });
});