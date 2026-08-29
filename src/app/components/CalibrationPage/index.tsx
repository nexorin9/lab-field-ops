// src/app/components/CalibrationPage/index.tsx
//
// 校准记录资料页：按 instrumentId 分组的时间倒序表 + raw_hash 反查 drawer。
// ⌘K 命中 calibrationId 时打开本组件；SplitView 三页同屏时也会出现。
//
// 设计：
//   - props = { calibrationId } 单条详情；额外拉同 instrument 的其他校准做上下文。
//   - raw_hash drawer：点击表格行的 raw_hash → 弹右侧抽屉显示原始 payload_json。
//   - 抽屉自实现（不引 styled-components），inline style + data-* 属性。
//   - 数据通过 fetcher 依赖注入；测试可传 stub。
//
// 沿用 outline `app/components/SplitView/index.tsx` 的 drawer 形态：
//   - 同 layered overlay + close 按钮；
//   - 与 Task 7 SplitView 同风格 inline style，便于 jsdom 测试。

import * as React from 'react';
import type { Calibration } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// fetchers
// ---------------------------------------------------------------------------

export interface CalibrationPageFetchers {
  /** 拉取一条校准（按 calibration_id）；返回 null 表示不存在。 */
  calibration: (calibrationId: string) => Promise<Calibration | null>;
  /** 拉取同 instrument 的所有校准记录（时间倒序）。 */
  byInstrument: (instrumentId: string) => Promise<Calibration[]>;
}

export const defaultCalibrationFetchers: CalibrationPageFetchers = {
  calibration: async (id) => {
    // 没有单条详情端点；走 list + 过滤
    const res = await fetch(`/api/calibrations?per_page=200`);
    if (!res.ok) return null;
    const body = (await res.json()) as { calibrations: Calibration[] };
    return body.calibrations?.find((c) => c.calibration_id === id) ?? null;
  },
  byInstrument: async (instrumentId) => {
    const qs = new URLSearchParams({ instrumentId, per_page: '200' }).toString();
    const res = await fetch(`/api/calibrations?${qs}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { calibrations: Calibration[] };
    return body.calibrations ?? [];
  },
};

// ---------------------------------------------------------------------------
// useRequest
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

  React.useEffect(() => {
    let cancelled = false;
    reloadRef.current += 1;
    setState({ status: 'loading' });
    fetcher()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

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

  return [state, reload];
}

// ---------------------------------------------------------------------------
// raw_hash 反查 drawer
// ---------------------------------------------------------------------------

const RawPayloadDrawer: React.FC<{
  open: boolean;
  rawHash: string | null;
  payload: unknown;
  onClose: () => void;
}> = ({ open, rawHash, payload, onClose }) => {
  if (!open || !rawHash) return null;
  return (
    <div
      data-testid="calibration-drawer-root"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="raw-payload-drawer"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 360,
        background: '#fff',
        borderLeft: '1px solid #1976d2',
        boxShadow: '-4px 0 12px rgba(0,0,0,0.08)',
        padding: 12,
        overflow: 'auto',
        zIndex: 20,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ fontSize: 13, margin: 0, color: '#444' }}>raw_payload · 反查</h3>
        <button
          type="button"
          data-testid="drawer-close"
          onClick={onClose}
          style={{
            border: '1px solid #ccc',
            borderRadius: 4,
            background: '#fff',
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          关闭
        </button>
      </div>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        raw_hash: <span style={{ fontFamily: 'monospace' }}>{rawHash}</span>
      </div>
      <pre
        data-testid="drawer-payload"
        style={{
          margin: 0,
          padding: 8,
          background: '#fafafa',
          border: '1px solid #eee',
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 时间倒序表（按 instrumentId 分组）
// ---------------------------------------------------------------------------

const CalibrationTable: React.FC<{
  rows: Calibration[];
  selectedHash: string | null;
  onSelect: (c: Calibration) => void;
}> = ({ rows, selectedHash, onSelect }) => {
  if (rows.length === 0) {
    return (
      <div
        data-testid="calibration-empty"
        style={{ padding: 8, color: '#888', fontSize: 13 }}
      >
        暂无校准记录
      </div>
    );
  }

  // 按 instrumentId 分组 + 保持每组时间倒序
  const groups = new Map<string, Calibration[]>();
  for (const c of rows) {
    const arr = groups.get(c.instrument_id) ?? [];
    arr.push(c);
    groups.set(c.instrument_id, arr);
  }
  const groupKeys = Array.from(groups.keys()).sort();

  return (
    <div data-testid="calibration-table" data-row-count={rows.length} data-group-count={groupKeys.length}>
      {groupKeys.map((instId) => {
        const group = groups.get(instId)!;
        return (
          <section
            key={instId}
            data-instrument-id={instId}
            data-group-size={group.length}
            style={{ marginBottom: 12 }}
          >
            <h4
              style={{
                fontSize: 12,
                margin: '0 0 4px',
                color: '#666',
                fontFamily: 'monospace',
              }}
            >
              {instId}（{group.length} 条）
            </h4>
            <ul
              data-testid="calibration-rows"
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
            >
              {group.map((c) => {
                const pass =
                  (c.payload_json as { qc_pass?: boolean } | undefined)?.qc_pass ??
                  null;
                const isSelected = selectedHash === c.raw_hash;
                return (
                  <li
                    key={c.calibration_id}
                    data-calibration-id={c.calibration_id}
                    data-raw-hash={c.raw_hash}
                    data-selected={isSelected ? 'true' : 'false'}
                    onClick={() => onSelect(c)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 80px 80px',
                      gap: 8,
                      padding: '6px 8px',
                      borderBottom: '1px solid #eee',
                      cursor: 'pointer',
                      background: isSelected ? '#e3f2fd' : 'transparent',
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
                      {pass === true ? '通过' : pass === false ? '未过' : '—'}
                    </span>
                    <span
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: '#1976d2',
                      }}
                      title={c.raw_hash}
                    >
                      {c.raw_hash.slice(0, 8)}…
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 页面主体
// ---------------------------------------------------------------------------

export interface CalibrationPageProps {
  calibrationId: string;
  fetchers?: CalibrationPageFetchers;
}

export function CalibrationPage({
  calibrationId,
  fetchers: fetchersProp,
}: CalibrationPageProps): React.ReactElement {
  const fetchers = fetchersProp ?? defaultCalibrationFetchers;

  const [calState] = useRequest(
    () => fetchers.calibration(calibrationId),
    [calibrationId],
  );
  const cal = calState.status === 'ready' ? calState.data : null;
  const instrumentId = cal?.instrument_id ?? null;

  const [byInstState] = useRequest(
    async () => (instrumentId ? fetchers.byInstrument(instrumentId) : []),
    [instrumentId],
  );

  const [selectedHash, setSelectedHash] = React.useState<string | null>(null);
  const [selectedPayload, setSelectedPayload] = React.useState<unknown>(null);

  const onSelect = React.useCallback((c: Calibration) => {
    setSelectedHash(c.raw_hash);
    setSelectedPayload(c.payload_json);
  }, []);

  const onClose = React.useCallback(() => {
    setSelectedHash(null);
    setSelectedPayload(null);
  }, []);

  return (
    <div
      data-testid="calibration-page-root"
      data-calibration-id={calibrationId}
      data-status={calState.status}
      style={{
        position: 'relative',
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
          {calState.status === 'loading'
            ? '加载中…'
            : calState.status === 'error'
              ? `加载失败：${calState.error}`
              : cal
                ? `校准 ${cal.calibration_id}`
                : '未找到'}
        </div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
          {cal ? (
            <>
              <span style={{ fontFamily: 'monospace' }}>{cal.instrument_id}</span>
              <span style={{ marginLeft: 12 }}>
                {new Date(cal.calibrated_at).toLocaleString('zh-CN')}
              </span>
              <span
                style={{
                  marginLeft: 12,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: '#1976d2',
                }}
              >
                {cal.raw_hash.slice(0, 16)}…
              </span>
            </>
          ) : null}
        </div>
      </header>

      <section data-section="by-instrument">
        <h3 style={{ fontSize: 13, margin: '0 0 6px', color: '#444' }}>
          仪器全部校准（点击 raw_hash 反查）
        </h3>
        {calState.status === 'loading' && (
          <div data-testid="cal-page-loading">加载中…</div>
        )}
        {calState.status === 'error' && (
          <div data-testid="cal-page-error" style={{ color: '#c62828' }}>
            加载失败：{calState.error}
          </div>
        )}
        {calState.status === 'ready' && !cal && (
          <div data-testid="cal-not-found" style={{ color: '#888' }}>
            未找到这条校准
          </div>
        )}
        {byInstState.status === 'loading' && (
          <div data-testid="cal-by-inst-loading">同仪器校准加载中…</div>
        )}
        {byInstState.status === 'ready' && (
          <CalibrationTable
            rows={byInstState.data}
            selectedHash={selectedHash}
            onSelect={onSelect}
          />
        )}
      </section>

      <RawPayloadDrawer
        open={selectedHash !== null}
        rawHash={selectedHash}
        payload={selectedPayload}
        onClose={onClose}
      />
    </div>
  );
}

export default CalibrationPage;
