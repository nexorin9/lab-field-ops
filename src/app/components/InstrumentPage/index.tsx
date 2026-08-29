// src/app/components/InstrumentPage/index.tsx
//
// 单台仪器的资料页（SOP 编辑 + 嵌入卡 + 处理记录 + 最近校准）。
// ⌘K 与 SplitView 命中 instrumentId 时打开本组件。
//
// 设计：
//   - props.instrumentId 决定渲染哪台仪器（主键 ASSET-LAB-NNNN）。
//   - 数据通过 fetcher 依赖注入：默认走 /api/instruments/:id 与 /api/calibrations?instrumentId=
//     与 /api/processing-records?instrumentId=；测试可传 stub。
//   - SOP 编辑器走 src/app/editor/SOPEditor.tsx：受控 textarea + 粘贴 URL 自动转 embed。
//   - 处理记录列表支持一键 POST /confirm 调状态机推进（与 Task 17 confirm 端点对齐）。
//   - 不引图表库；纯 HTML + data-* 属性，便于 jsdom 测试断言。
//
// 沿用 outline `app/scenes/Collection/index.tsx` 的 useCommandBarActions 形态：
//   - 三页都接 useRequest 钩子（loader 风格：data loading / ready / error 三态）；
//   - 不绑 React Router，由父组件（DashboardPage 或 SplitView）注入。

import * as React from 'react';
import { SOPEditor } from '../../editor/SOPEditor.js';
import { scanDocument, renderEmbed } from '../../../shared/embeds/renderer.js';
import type {
  Instrument,
  Calibration,
  ProcessingRecord,
} from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// fetchers（默认 fetch；测试可注入 stub）
// ---------------------------------------------------------------------------

export interface InstrumentPageFetchers {
  /** 拉取仪器详情；返回 null 表示不存在。 */
  instrument: (id: string) => Promise<Instrument | null>;
  /** 拉取这台仪器下的校准记录（按 calibrated_at DESC）。 */
  calibrations: (instrumentId: string) => Promise<Calibration[]>;
  /** 拉取这台仪器下的处理记录（按时间倒序，limit 由 fetcher 自定）。 */
  processingRecords: (instrumentId: string) => Promise<ProcessingRecord[]>;
  /** POST /api/processing-records/:id/confirm —— 把 received/parsed 推进到 verified。 */
  confirm: (
    recordId: string,
    operatorId: string,
  ) => Promise<
    | { ok: true; record: ProcessingRecord; idempotent: boolean }
    | { ok: false; error: string }
  >;
}

export const defaultInstrumentFetchers: InstrumentPageFetchers = {
  instrument: async (id) => {
    const res = await fetch(`/api/instruments/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return (await res.json()) as Instrument;
  },
  calibrations: async (instrumentId) => {
    const res = await fetch(
      `/api/calibrations?instrumentId=${encodeURIComponent(instrumentId)}&per_page=50`,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { calibrations: Calibration[] };
    return body.calibrations ?? [];
  },
  processingRecords: async (instrumentId) => {
    const res = await fetch(
      `/api/processing-records?instrumentId=${encodeURIComponent(instrumentId)}&per_page=50`,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { records?: ProcessingRecord[]; processing_records?: ProcessingRecord[] };
    return body.records ?? body.processing_records ?? [];
  },
  confirm: async (recordId, operatorId) => {
    const res = await fetch(
      `/api/processing-records/${encodeURIComponent(recordId)}/confirm`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operator_id: operatorId }),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, error: body.error?.message ?? `confirm failed: ${res.status}` };
    }
    const body = (await res.json()) as { record: ProcessingRecord; idempotent: boolean };
    return { ok: true, record: body.record, idempotent: body.idempotent };
  },
};

// ---------------------------------------------------------------------------
// useRequest：loader 风格钩子（loading/ready/error 三态）
// ---------------------------------------------------------------------------

export type RequestState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: string };

function useRequest<T>(
  fetcher: () => Promise<T>,
  deps: React.DependencyList,
): [RequestState<T>, () => void] {
  const [state, setState] = React.useState<RequestState<T>>({ status: 'idle' });
  const reloadRef = React.useRef(0);

  const reload = React.useCallback(() => {
    reloadRef.current += 1;
    setState({ status: 'loading' });
    fetcher()
      .then((data) => setState({ status: 'ready', data }))
      .catch((err: unknown) =>
        setState({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  React.useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return [state, reload];
}

// ---------------------------------------------------------------------------
// 子组件：校准历史表
// ---------------------------------------------------------------------------

const CalibrationHistory: React.FC<{ rows: Calibration[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return (
      <div
        data-testid="instrument-calibration-empty"
        style={{ padding: 8, color: '#888', fontSize: 13 }}
      >
        暂无校准记录
      </div>
    );
  }
  return (
    <ul
      data-testid="instrument-calibration-list"
      data-count={rows.length}
      style={{ listStyle: 'none', padding: 0, margin: 0 }}
    >
      {rows.map((c) => {
        const pass =
          (c.payload_json as { qc_pass?: boolean } | undefined)?.qc_pass ?? null;
        return (
          <li
            key={c.calibration_id}
            data-calibration-id={c.calibration_id}
            data-raw-hash={c.raw_hash}
            data-qc-pass={pass === null ? 'unknown' : pass ? 'pass' : 'fail'}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '6px 8px',
              borderBottom: '1px solid #eee',
              fontSize: 13,
            }}
          >
            <span style={{ fontFamily: 'monospace' }}>{c.calibration_id}</span>
            <span style={{ color: '#666' }}>
              {new Date(c.calibrated_at).toLocaleString('zh-CN')}
            </span>
            <span
              style={{
                color: pass === true ? '#2e7d32' : pass === false ? '#c62828' : '#888',
              }}
            >
              {pass === true ? '质控通过' : pass === false ? '质控未过' : '—'}
            </span>
          </li>
        );
      })}
    </ul>
  );
};

// ---------------------------------------------------------------------------
// 子组件：处理记录列表（含 confirm 按钮）
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<ProcessingRecord['state'], string> = {
  received: '已接收',
  parsed: '已解析',
  verified: '已复核',
  writeback_pending: '回写中',
  written_back: '已回写',
  failed: '失败',
};

const ProcessingRecordList: React.FC<{
  rows: ProcessingRecord[];
  onConfirm: (recordId: string) => void;
  confirming: string | null;
}> = ({ rows, onConfirm, confirming }) => {
  if (rows.length === 0) {
    return (
      <div
        data-testid="instrument-records-empty"
        style={{ padding: 8, color: '#888', fontSize: 13 }}
      >
        暂无处理记录
      </div>
    );
  }
  return (
    <ul
      data-testid="instrument-records-list"
      data-count={rows.length}
      style={{ listStyle: 'none', padding: 0, margin: 0 }}
    >
      {rows.map((r) => {
        const canConfirm = r.state === 'received' || r.state === 'parsed';
        return (
          <li
            key={r.record_id}
            data-record-id={r.record_id}
            data-state={r.state}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 10px',
              borderBottom: '1px solid #eee',
              fontSize: 13,
            }}
          >
            <span>
              <span style={{ fontFamily: 'monospace' }}>{r.alarm_code}</span>
              <span style={{ color: '#888', marginLeft: 8 }}>{r.operator_id}</span>
            </span>
            <span
              data-state-label={r.state}
              style={{
                padding: '2px 6px',
                borderRadius: 4,
                background: '#f5f5f5',
                color: r.state === 'failed' ? '#c62828' : '#333',
                fontSize: 12,
              }}
            >
              {STATE_LABEL[r.state]}
            </span>
            {canConfirm && (
              <button
                type="button"
                data-testid={`confirm-${r.record_id}`}
                onClick={() => onConfirm(r.record_id)}
                disabled={confirming === r.record_id}
                style={{
                  padding: '2px 10px',
                  border: '1px solid #1976d2',
                  borderRadius: 4,
                  background: confirming === r.record_id ? '#bbdefb' : '#fff',
                  color: '#1976d2',
                  cursor: confirming === r.record_id ? 'wait' : 'pointer',
                }}
              >
                {confirming === r.record_id ? '复核中…' : '复核'}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
};

// ---------------------------------------------------------------------------
// SOP 文档渲染（受 SOPEditor + EmbedCard 渲染）
// ---------------------------------------------------------------------------

const SOPDocPreview: React.FC<{ doc: string }> = ({ doc }) => {
  const runs = React.useMemo(() => scanDocument(doc), [doc]);
  if (runs.length === 0) {
    return (
      <div
        data-testid="instrument-sop-empty"
        style={{ padding: 8, color: '#888', fontSize: 13 }}
      >
        （无 SOP 文档）
      </div>
    );
  }
  return (
    <div data-testid="instrument-sop-runs" data-runs={runs.length}>
      {runs.map((run, idx) => {
        if (run.kind === 'plain') {
          return (
            <pre
              key={`p-${idx}`}
              data-run-kind="plain"
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                fontSize: 13,
              }}
            >
              {run.text}
            </pre>
          );
        }
        return (
          <div key={`e-${idx}`} data-run-kind="embed" data-embed-name={run.name} data-matched={run.matched ? 'true' : 'false'}>
            {renderEmbed(run)}
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 页面主体
// ---------------------------------------------------------------------------

export interface InstrumentPageProps {
  instrumentId: string;
  /** 初始 SOP 文档；缺省走空字符串。 */
  initialSop?: string;
  /** 注入的 fetcher；缺省走 defaultInstrumentFetchers（fetch）。 */
  fetchers?: InstrumentPageFetchers;
}

export function InstrumentPage({
  instrumentId,
  initialSop = '',
  fetchers: fetchersProp,
}: InstrumentPageProps): React.ReactElement {
  const fetchers = fetchersProp ?? defaultInstrumentFetchers;

  const [instState] = useRequest(() => fetchers.instrument(instrumentId), [instrumentId]);
  const [calState] = useRequest(() => fetchers.calibrations(instrumentId), [instrumentId]);
  const [recState, reloadRecords] = useRequest(
    () => fetchers.processingRecords(instrumentId),
    [instrumentId],
  );

  const [sop, setSop] = React.useState<string>(initialSop);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);

  const onConfirm = React.useCallback(
    async (recordId: string) => {
      setConfirming(recordId);
      setConfirmError(null);
      // operatorId 用「系统操作」占位；生产应从 session 取
      const result = await fetchers.confirm(recordId, 'system');
      setConfirming(null);
      if (!result.ok) {
        setConfirmError(result.error);
        return;
      }
      reloadRecords();
    },
    [fetchers, reloadRecords],
  );

  const inst = instState.status === 'ready' ? instState.data : null;

  return (
    <div
      data-testid="instrument-page-root"
      data-instrument-id={instrumentId}
      data-status={instState.status}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'auto',
        padding: 12,
        fontFamily: 'sans-serif',
      }}
    >
      <header style={{ borderBottom: '1px solid #eee', paddingBottom: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>
          {inst
            ? `${inst.vendor} ${inst.model}`
            : instState.status === 'loading'
              ? '加载中…'
              : instState.status === 'error'
                ? `加载失败：${instState.error}`
                : '—'}
        </div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
          {inst ? (
            <>
              <span style={{ fontFamily: 'monospace' }}>{inst.instrument_id}</span>
              <span style={{ marginLeft: 12 }}>{inst.location}</span>
              <span
                style={{
                  marginLeft: 12,
                  color:
                    inst.status === 'online'
                      ? '#2e7d32'
                      : inst.status === 'alarm'
                        ? '#c62828'
                        : '#888',
                }}
                data-status-color={inst.status}
              >
                {inst.status}
              </span>
            </>
          ) : null}
        </div>
      </header>

      <section style={{ marginBottom: 12 }} data-section="sop-edit">
        <h3 style={{ fontSize: 13, margin: '0 0 6px', color: '#444' }}>SOP 文档</h3>
        <SOPEditor value={sop} onChange={setSop} rows={6} />
      </section>

      <section style={{ marginBottom: 12 }} data-section="sop-preview">
        <h3 style={{ fontSize: 13, margin: '0 0 6px', color: '#444' }}>嵌入预览</h3>
        <SOPDocPreview doc={sop} />
      </section>

      <section style={{ marginBottom: 12 }} data-section="calibrations">
        <h3 style={{ fontSize: 13, margin: '0 0 6px', color: '#444' }}>最近校准</h3>
        {calState.status === 'loading' && (
          <div data-testid="cal-loading">加载中…</div>
        )}
        {calState.status === 'error' && (
          <div data-testid="cal-error" style={{ color: '#c62828' }}>
            加载失败：{calState.error}
          </div>
        )}
        {calState.status === 'ready' && (
          <CalibrationHistory rows={calState.data} />
        )}
      </section>

      <section data-section="records">
        <h3 style={{ fontSize: 13, margin: '0 0 6px', color: '#444' }}>处理记录</h3>
        {confirmError && (
          <div
            data-testid="confirm-error"
            style={{
              padding: 6,
              marginBottom: 6,
              background: '#ffebee',
              border: '1px solid #c62828',
              color: '#c62828',
              fontSize: 12,
            }}
          >
            复核失败：{confirmError}
          </div>
        )}
        {recState.status === 'loading' && (
          <div data-testid="records-loading">加载中…</div>
        )}
        {recState.status === 'error' && (
          <div data-testid="records-error" style={{ color: '#c62828' }}>
            加载失败：{recState.error}
          </div>
        )}
        {recState.status === 'ready' && (
          <ProcessingRecordList
            rows={recState.data}
            onConfirm={onConfirm}
            confirming={confirming}
          />
        )}
      </section>
    </div>
  );
}

export default InstrumentPage;
