// src/app/components/DashboardPage/InstrumentHealthGrid.tsx
//
// 仪器健康卡片（拆分自 DashboardPage/index.tsx）：
//   - 顶部状态汇总（online / offline / alarm 三态计数 + 总数）
//   - 网格区域：每台仪器一张卡
//     · 状态点（绿/灰/红）
//     · vendor / model 标签
//     · 位置 location
//     · 最近校准时间（如未提供，则用 last_seen_at 回退）
//
// 设计原则：
//   - data-testid 保留 dashboard.test.ts 的旧契约（dashboard-instrument-health / instrument-status-summary / instrument-list）
//   - 新增细粒度钩子：instrument-card-<id> / instrument-status-dot-<id> / instrument-last-calibration-<id>
//   - 不引图表库；CSS grid 自绘
//   - 报警态卡片用 2px 红边 + 浅红底，键盘 / 屏幕阅读器友好

import * as React from 'react';

export type InstrumentStatus = 'online' | 'offline' | 'alarm';

export interface InstrumentSummary {
  instrument_id: string;
  vendor: string;
  model: string;
  status: InstrumentStatus;
  location: string;
  last_seen_at: string | null;
}

export interface CalibrationView {
  calibration_id: string;
  instrument_id: string;
  calibrated_at: string;
}

export interface InstrumentHealthGridProps {
  instruments: InstrumentSummary[];
  /** 按 instrument_id 给最近校准列表（如提供则取第一条作为「最近校准」）。 */
  calibrationsByInstrument?: Record<string, CalibrationView[]>;
  /** 测试用：固定时间，确保 snapshot 稳定。 */
  now?: () => Date;
}

const STATUS_COLORS: Record<InstrumentStatus, string> = {
  online: '#2e7d32',
  offline: '#9e9e9e',
  alarm: '#c62828',
};

const STATUS_LABELS: Record<InstrumentStatus, string> = {
  online: '在线',
  offline: '离线',
  alarm: '报警',
};

/** 把 ISO 时间转简短 MM-DD HH:mm。空 → '—'。 */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso.slice(0, 10);
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 取最近一次校准（按 calibrated_at 倒序第一条）。 */
function pickLatest(
  list: CalibrationView[] | undefined,
): CalibrationView | null {
  if (!list || list.length === 0) return null;
  return [...list].sort((a, b) => (a.calibrated_at < b.calibrated_at ? 1 : -1))[0];
}

/** 状态汇总卡（顶部）：三色块计数。 */
function StatusSummary(props: { instruments: InstrumentSummary[] }): React.ReactElement {
  const { instruments } = props;
  const byStatus = instruments.reduce<Record<InstrumentStatus, number>>(
    (acc, ins) => {
      acc[ins.status] = (acc[ins.status] ?? 0) + 1;
      return acc;
    },
    { online: 0, offline: 0, alarm: 0 },
  );
  const hasAlarm = byStatus.alarm > 0;
  const order: InstrumentStatus[] = ['online', 'offline', 'alarm'];
  return (
    <div
      data-testid="instrument-status-summary"
      data-has-alarm={hasAlarm ? 'true' : 'false'}
      style={{ display: 'flex', gap: 16 }}
    >
      {order.map((s) => (
        <div
          key={s}
          data-status={s}
          data-count={byStatus[s]}
          style={{ textAlign: 'center' }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: STATUS_COLORS[s],
              marginRight: 4,
            }}
          />
          <strong>{byStatus[s]}</strong>
          <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABELS[s]}</div>
        </div>
      ))}
    </div>
  );
}

/** 仪器卡片（单台）：状态点 + 文本 + 最近校准。 */
function InstrumentCard(props: {
  ins: InstrumentSummary;
  latestCalibration: CalibrationView | null;
}): React.ReactElement {
  const { ins, latestCalibration } = props;
  const latestLabel = latestCalibration
    ? `校准 ${fmtTime(latestCalibration.calibrated_at)}`
    : ins.last_seen_at
      ? `最近心跳 ${fmtTime(ins.last_seen_at)}`
      : '无心跳';
  const isAlarm = ins.status === 'alarm';

  return (
    <article
      data-testid={`instrument-card-${ins.instrument_id}`}
      data-instrument-id={ins.instrument_id}
      data-status={ins.status}
      style={{
        border: isAlarm ? '2px solid #c62828' : '1px solid #eee',
        background: isAlarm ? '#fff5f5' : 'white',
        borderRadius: 4,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minHeight: 80,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          aria-label={`状态 ${STATUS_LABELS[ins.status]}`}
          data-testid={`instrument-status-dot-${ins.instrument_id}`}
          data-status={ins.status}
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: STATUS_COLORS[ins.status],
          }}
        />
        <span
          data-status={ins.status}
          style={{
            fontSize: 11,
            color: ins.status === 'alarm' ? '#c62828' : '#666',
            fontWeight: ins.status === 'alarm' ? 600 : 400,
          }}
        >
          {STATUS_LABELS[ins.status]}
        </span>
      </header>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {ins.vendor} / {ins.model}
      </div>
      <div style={{ fontSize: 11, color: '#666' }}>{ins.location}</div>
      <footer
        data-testid={`instrument-last-calibration-${ins.instrument_id}`}
        data-has-calibration={latestCalibration ? 'true' : 'false'}
        style={{ fontSize: 11, color: '#888', marginTop: 'auto' }}
      >
        {latestLabel}
      </footer>
    </article>
  );
}

/** 仪器列表（旧 data-testid 兼容）：分 vendor 列。 */
function InstrumentList(props: {
  instruments: InstrumentSummary[];
  calibrationsByInstrument?: Record<string, CalibrationView[]>;
}): React.ReactElement {
  const { instruments, calibrationsByInstrument } = props;
  return (
    <ul
      data-testid="instrument-list"
      data-count={instruments.length}
      style={{
        listStyle: 'none',
        padding: 0,
        margin: '12px 0 0',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: 8,
      }}
    >
      {instruments.map((ins) => (
        <li
          key={ins.instrument_id}
          data-instrument-id={ins.instrument_id}
          data-status={ins.status}
          style={{ margin: 0 }}
        >
          <InstrumentCard ins={ins} latestCalibration={pickLatest(calibrationsByInstrument?.[ins.instrument_id])} />
        </li>
      ))}
    </ul>
  );
}

export function InstrumentHealthGrid(props: InstrumentHealthGridProps): React.ReactElement {
  const { instruments, calibrationsByInstrument } = props;
  const hasAlarm = instruments.some((i) => i.status === 'alarm');

  return (
    <section
      data-testid="dashboard-instrument-health"
      data-has-alarm={hasAlarm ? 'true' : 'false'}
      data-total={instruments.length}
      style={{ border: '1px solid #ddd', borderRadius: 4, padding: 12, flex: 1, minWidth: 240 }}
    >
      <h3 style={{ margin: '0 0 8px' }}>仪器状态</h3>
      <StatusSummary instruments={instruments} />
      <InstrumentList instruments={instruments} calibrationsByInstrument={calibrationsByInstrument} />
    </section>
  );
}

export default InstrumentHealthGrid;
