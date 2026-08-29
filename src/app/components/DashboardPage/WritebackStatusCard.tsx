// src/app/components/DashboardPage/WritebackStatusCard.tsx
//
// Write-back 状态卡（拆分自 DashboardPage/index.tsx）：
//   1) 顶部饼图（SVG path 手绘，不引图表库）：五/六态分布
//   2) 中部状态表（state | count）：保留旧 data-testid，与 dashboard.test.ts 兼容
//   3) 失败红条（failed > 0 时显示）
//   4) 底部「最近 10 条 write-back 记录」列表（按 confirmed_at 倒序）
//
// 设计原则：
//   - 不引图表库；饼图纯 SVG path + arc math
//   - data-testid 与既有 dashboard 测试锁住（dashboard-writeback-status / writeback-state-table / writeback-failed-banner）
//   - data-testid 新增（writeback-pie-svg / writeback-pie-slice-<state> / writeback-recent-list / writeback-recent-row-<id>）
//   - recentRecords 与 buckets 都允许通过 fetcher 自拉（默认注入：fail-soft）

import * as React from 'react';

export interface ProcessingStateBucket {
  state: string;
  count: number;
}

export interface ProcessingRecordView {
  record_id: string;
  instrument_id: string;
  alarm_code: string;
  state: string;
  retry_count: number;
  confirmed_at: string | null;
  operator_id: string;
}

export type WritebackState =
  | 'received'
  | 'parsed'
  | 'verified'
  | 'writeback_pending'
  | 'written_back'
  | 'failed';

export const WRITEBACK_STATES_ORDER: readonly WritebackState[] = [
  'received',
  'parsed',
  'verified',
  'writeback_pending',
  'written_back',
  'failed',
] as const;

const STATE_COLORS: Record<WritebackState, string> = {
  received: '#90a4ae',
  parsed: '#7e57c2',
  verified: '#1976d2',
  writeback_pending: '#fb8c00',
  written_back: '#2e7d32',
  failed: '#c62828',
};

export interface WritebackStatusCardProps {
  /** 各状态计数（5/6 态）。 */
  buckets: ProcessingStateBucket[];
  /** 最近 N 条 write-back 记录（可选；不传则不显示底表）。 */
  recentRecords?: ProcessingRecordView[];
  /** 最近列表截断长度，默认 10。 */
  maxRecent?: number;
  /** 测试/注入：完整自拉。默认走 static props。 */
  fetcher?: () => Promise<{ buckets: ProcessingStateBucket[]; records?: ProcessingRecordView[] }>;
}

interface PieSlice {
  state: WritebackState;
  color: string;
  pathData: string;
  percent: number;
  count: number;
}

const PIE_CX = 50;
const PIE_CY = 50;
const PIE_R = 36;
const PIE_VB = 100;

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  // 0° = 顶；顺时针
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** 返回一段扇形 path d（从圆心出发画两边再画弧）。 */
function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  // 100% 单态：拆两半弧避免 SVG sweep 歧义
  if (endAngle - startAngle >= 359.999) {
    return [
      `M ${cx} ${cy}`,
      `m -${r} 0`,
      `a ${r} ${r} 0 1 0 ${2 * r} 0`,
      `a ${r} ${r} 0 1 0 -${2 * r} 0`,
    ].join(' ');
  }
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`,
    'Z',
  ].join(' ');
}

/** 五/六态计数字典（缺失态补 0）。 */
function bucketToCounts(buckets: ProcessingStateBucket[]): Record<WritebackState, number> {
  const init = Object.fromEntries(WRITEBACK_STATES_ORDER.map((s) => [s, 0])) as Record<WritebackState, number>;
  for (const b of buckets) {
    if (b.state in init) init[b.state as WritebackState] = b.count;
  }
  return init;
}

/** 把 counts 转成 SVG path 切片列表。 */
function buildPieSlices(counts: Record<WritebackState, number>): PieSlice[] {
  const total = Object.values(counts).reduce<number>((a, b) => a + b, 0);
  if (total <= 0) return [];
  let angle = 0;
  const slices: PieSlice[] = [];
  for (const state of WRITEBACK_STATES_ORDER) {
    const count = counts[state];
    if (count === 0) continue;
    const percent = count / total;
    const sweep = percent * 360;
    const startAngle = angle;
    const endAngle = angle + sweep;
    slices.push({
      state,
      color: STATE_COLORS[state],
      pathData: arcPath(PIE_CX, PIE_CY, PIE_R, startAngle, endAngle),
      percent: Math.round(percent * 100),
      count,
    });
    angle = endAngle;
  }
  return slices;
}

/** 排序 recent records：confirmed_at 倒序，null 排在最后。 */
function sortRecent(records: ProcessingRecordView[]): ProcessingRecordView[] {
  return [...records].sort((a, b) => {
    if (a.confirmed_at && b.confirmed_at) {
      return a.confirmed_at < b.confirmed_at ? 1 : -1;
    }
    if (a.confirmed_at) return -1;
    if (b.confirmed_at) return 1;
    return 0;
  });
}

/** 把 ISO 时间截短成 MM-DD HH:mm。空 → '—'。 */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso.slice(0, 10);
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 饼图本体（SVG）：无依赖，零图表库。 */
function PieChart({ counts, total }: { counts: Record<WritebackState, number>; total: number }): React.ReactElement {
  const slices = buildPieSlices(counts);
  if (total === 0 || slices.length === 0) {
    return (
      <svg
        data-testid="writeback-pie-svg"
        data-total="0"
        viewBox={`0 0 ${PIE_VB} ${PIE_VB}`}
        width="100"
        height="100"
        role="img"
        aria-label="空饼图"
        style={{ display: 'block' }}
      >
        <circle cx={PIE_CX} cy={PIE_CY} r={PIE_R} fill="#f5f5f5" stroke="#bdbdbd" strokeWidth="1" />
        <text x={PIE_CX} y={PIE_CY} textAnchor="middle" dominantBaseline="middle" fill="#9e9e9e" fontSize="10">
          暂无数据
        </text>
      </svg>
    );
  }
  return (
    <svg
      data-testid="writeback-pie-svg"
      data-total={total}
      viewBox={`0 0 ${PIE_VB} ${PIE_VB}`}
      width="100"
      height="100"
      role="img"
      aria-label="Write-back 状态饼图"
      style={{ display: 'block' }}
    >
      <circle cx={PIE_CX} cy={PIE_CY} r={PIE_R} fill="#fff" stroke="#eee" strokeWidth="1" />
      {slices.map((s) => (
        <path
          key={s.state}
          data-testid={`writeback-pie-slice-${s.state}`}
          data-state={s.state}
          data-percent={s.percent}
          data-count={s.count}
          d={s.pathData}
          fill={s.color}
          stroke="#fff"
          strokeWidth="1"
        >
          <title>
            {s.state}: {s.count} ({s.percent}%)
          </title>
        </path>
      ))}
    </svg>
  );
}

/** 状态图例：色块 + state + count + percent。 */
function PieLegend({ slices, total }: { slices: PieSlice[]; total: number }): React.ReactElement {
  if (total === 0) {
    return <div data-testid="writeback-pie-legend-empty" style={{ color: '#666', fontSize: 12 }}>暂无数据</div>;
  }
  return (
    <ul
      data-testid="writeback-pie-legend"
      style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 12 }}
    >
      {slices.map((s) => (
        <li
          key={s.state}
          data-testid={`writeback-legend-${s.state}`}
          data-state={s.state}
          data-count={s.count}
          data-percent={s.percent}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}
        >
          <span
            aria-hidden="true"
            style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: s.color }}
          />
          <span style={{ flex: 1 }}>{s.state}</span>
          <span style={{ color: '#666' }}>{s.count}</span>
          <span style={{ color: '#999' }}>({s.percent}%)</span>
        </li>
      ))}
    </ul>
  );
}

/** 最近 N 条记录列表。 */
function RecentList(props: { records: ProcessingRecordView[]; maxRecent: number }): React.ReactElement {
  const sorted = sortRecent(props.records).slice(0, props.maxRecent);
  return (
    <div data-testid="writeback-recent-list" data-count={sorted.length}>
      <div style={{ fontSize: 12, color: '#666', margin: '4px 0' }}>
        最近 {Math.min(props.maxRecent, sorted.length)} 条 write-back 记录
      </div>
      {sorted.length === 0 ? (
        <div data-testid="writeback-recent-empty" style={{ color: '#999', fontSize: 12 }}>
          暂无记录
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 12 }}>
          {sorted.map((r) => (
            <li
              key={r.record_id}
              data-testid={`writeback-recent-row-${r.record_id}`}
              data-state={r.state}
              data-retry-count={r.retry_count}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '4px 0',
                borderBottom: '1px dashed #eee',
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <code style={{ fontSize: 11 }}>{r.record_id.slice(0, 8)}</code>
                {' · '}
                {r.instrument_id}
                {' · '}
                {r.alarm_code}
              </span>
              <span
                data-state={r.state}
                style={{
                  color: r.state === 'failed' ? '#c62828' : r.state === 'written_back' ? '#2e7d32' : '#444',
                  fontWeight: r.state === 'failed' ? 600 : 400,
                  marginRight: 8,
                }}
              >
                {r.state}
              </span>
              <span style={{ color: '#666' }}>{fmtTime(r.confirmed_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WritebackStatusCard(props: WritebackStatusCardProps): React.ReactElement {
  const [buckets, setBuckets] = React.useState<ProcessingStateBucket[]>(props.buckets);
  const [records, setRecords] = React.useState<ProcessingRecordView[]>(props.recentRecords ?? []);
  const maxRecent = props.maxRecent ?? 10;

  React.useEffect(() => {
    if (!props.fetcher) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await props.fetcher!();
        if (cancelled) return;
        setBuckets(r.buckets ?? []);
        setRecords(r.records ?? []);
      } catch {
        // fail-soft：保留 props 初始值
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.fetcher]);

  const counts = bucketToCounts(buckets);
  const total = Object.values(counts).reduce<number>((a, b) => a + b, 0);
  const failedCount = counts.failed;
  const hasFailed = failedCount > 0;
  const slices = buildPieSlices(counts);

  return (
    <div
      data-testid="dashboard-writeback-status"
      data-has-failed={hasFailed ? 'true' : 'false'}
      data-total={total}
      data-failed-count={failedCount}
      style={{ border: '1px solid #ddd', borderRadius: 4, padding: 12, flex: 1, minWidth: 240 }}
    >
      <h3 style={{ margin: '0 0 8px' }}>Write-back 状态</h3>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 8 }}>
        <PieChart counts={counts} total={total} />
        <PieLegend slices={slices} total={total} />
      </div>

      <table data-testid="writeback-state-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', fontSize: 12, color: '#666' }}>State</th>
            <th style={{ textAlign: 'right', fontSize: 12, color: '#666' }}>Count</th>
          </tr>
        </thead>
        <tbody>
          {WRITEBACK_STATES_ORDER.map((s) => (
            <tr key={s} data-state={s} data-count={counts[s]}>
              <td style={{ padding: '2px 4px' }}>{s}</td>
              <td
                style={{
                  padding: '2px 4px',
                  textAlign: 'right',
                  color: s === 'failed' && counts[s] > 0 ? '#c62828' : 'inherit',
                  fontWeight: s === 'failed' && counts[s] > 0 ? 'bold' : 'normal',
                }}
              >
                {counts[s]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {hasFailed ? (
        <div
          role="alert"
          data-testid="writeback-failed-banner"
          style={{ marginTop: 8, padding: '6px 8px', background: '#ffebee', color: '#c62828', borderRadius: 4 }}
        >
          {failedCount} 条 write-back 失败，请尽快处理
        </div>
      ) : null}

      {props.recentRecords !== undefined || props.fetcher ? (
        <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px solid #eee' }}>
          <RecentList records={records} maxRecent={maxRecent} />
        </div>
      ) : null}
    </div>
  );
}

export default WritebackStatusCard;
