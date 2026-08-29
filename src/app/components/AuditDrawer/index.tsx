// src/app/components/AuditDrawer/index.tsx
//
// 审计抽屉：信息科 / 设备科长 通过此组件按时间倒序浏览 audit_event；
// 点击单行展开 payload_json；可按 kind / operatorId 过滤。
// Task 23 扩展：每行可点「查看相关事件」按钮展开 replay 面板，
// 显示 root → parents → current → children 链。
//
// 数据来源：
//   - 默认 GET /api/audit?kind=&operatorId=&from=&to=&limit=
//   - 默认 replay fetcher = GET /api/audit/:eventId/replay
//   - 可注入 fetcher / replayFetcher 替身（测试场景）
//
// 状态：
//   - closed / open / loading / error / ready
//   - 局部：expandedId（payload 展开）/ replayForId（replay 面板展开）
//
// 设计：
//   - 不引 styled-components，使用 inline style + data-* 属性
//   - 抽屉方向：右侧滑入（fixed + transform: translateX）
//   - 每行：ts / kind / operator_id / payload_preview；
//     点击展开 payload；replay 按钮展开事件链
//   - replay 面板嵌入在原 row 下方（同级 li），保持 DOM 简单

import { useEffect, useMemo, useState } from 'react';

// ---- types ----

export type AuditKind =
  | 'plugin.add'
  | 'plugin.remove'
  | 'plugin.uninstall'
  | 'queue.enqueue'
  | 'queue.process'
  | 'queue.fail'
  | 'queue.final_fail'
  | 'queue.retry'
  | 'writeback.initiated'
  | 'writeback.success'
  | 'processing_record.created'
  | 'processing_record.state_change'
  | 'processing_record.retry'
  | 'heartbeat.dropped'
  | 'heartbeat.received'
  | 'instrument.seen';

export interface AuditEventView {
  event_id: string;
  kind: string;
  req_hash: string | null;
  resp_hash: string | null;
  operator_id: string | null;
  payload_json: string; // 原始字符串
  ts: string;
  related_event_id: string | null;
}

export interface AuditListResponse {
  events: AuditEventView[];
  total: number;
  limit: number;
}

export interface AuditDrawerFilter {
  kind?: AuditKind[];
  operatorId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export type Fetcher = (filter: AuditDrawerFilter) => Promise<AuditListResponse>;

/** replay 返回形态（与 server/audit/replay.ts 对齐）。 */
export interface ReplayChainNode {
  event_id: string;
  kind: string;
  operator_id: string | null;
  ts: string;
  related_event_id: string | null;
  payload: Record<string, unknown>;
}

export interface ReplayResponse {
  root: string;
  current: ReplayChainNode;
  parents: ReplayChainNode[];
  children: ReplayChainNode[];
  chain: ReplayChainNode[];
}

export type ReplayFetcher = (eventId: string) => Promise<ReplayResponse>;

export interface AuditDrawerProps {
  /** 是否打开。 */
  open: boolean;
  /** 关闭回调（点击遮罩或关闭按钮）。 */
  onClose: () => void;
  /** 默认 fetcher；测试可注入。 */
  fetcher?: Fetcher;
  /** 默认 replay fetcher；测试可注入。 */
  replayFetcher?: ReplayFetcher;
  /** 初始过滤；可由调用方控制。 */
  initialFilter?: AuditDrawerFilter;
  /** 标题（默认「审计日志」）。 */
  title?: string;
  /** 触发自动 fetch 的 open 状态变化（默认 true）。 */
  autoFetch?: boolean;
}

const DEFAULT_LIMIT = 200;

/** 默认 fetcher：GET /api/audit，返回 JSON。 */
export async function defaultAuditFetcher(
  filter: AuditDrawerFilter,
): Promise<AuditListResponse> {
  const qs = new URLSearchParams();
  if (filter.kind && filter.kind.length) qs.set('kind', filter.kind.join(','));
  if (filter.operatorId) qs.set('operatorId', filter.operatorId);
  if (filter.from) qs.set('from', filter.from);
  if (filter.to) qs.set('to', filter.to);
  if (filter.limit ?? DEFAULT_LIMIT) qs.set('limit', String(filter.limit ?? DEFAULT_LIMIT));
  const url = '/api/audit' + (qs.toString() ? `?${qs.toString()}` : '');
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`audit fetch failed: ${res.status}`);
  }
  return (await res.json()) as AuditListResponse;
}

/** 默认 replay fetcher：GET /api/audit/:eventId/replay，返回 JSON。 */
export async function defaultReplayFetcher(eventId: string): Promise<ReplayResponse> {
  const res = await fetch(`/api/audit/${encodeURIComponent(eventId)}/replay`, {
    method: 'GET',
  });
  if (!res.ok) {
    throw new Error(`replay fetch failed: ${res.status}`);
  }
  return (await res.json()) as ReplayResponse;
}

/** 截短时间戳到秒级（避免布局抖动）。 */
function fmtTs(iso: string): string {
  if (!iso) return '';
  // ISO 形如 2024-01-17T03:18:42.123Z → 2024-01-17 03:18:42
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z').slice(0, 19);
}

/** 截短 hash 到前 12 字符。 */
function shortHash(h: string | null): string {
  if (!h) return '∅';
  return h.slice(0, 12);
}

/** 抽屉根容器。 */
export function AuditDrawer(props: AuditDrawerProps): JSX.Element {
  const {
    open,
    onClose,
    fetcher,
    replayFetcher,
    initialFilter,
    title,
    autoFetch = true,
  } = props;

  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 当前展开 replay 面板的事件 id；同一时刻仅一个。 */
  const [replayForId, setReplayForId] = useState<string | null>(null);
  const [replayData, setReplayData] = useState<ReplayResponse | null>(null);
  const [replayPhase, setReplayPhase] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [replayError, setReplayError] = useState<string>('');
  const [kindFilter, setKindFilter] = useState<string[]>(initialFilter?.kind ?? []);
  const [operatorFilter, setOperatorFilter] = useState<string>(initialFilter?.operatorId ?? '');

  const f = fetcher ?? defaultAuditFetcher;
  const rf = replayFetcher ?? defaultReplayFetcher;

  // 构造实际 filter（合并 UI 输入）
  const liveFilter: AuditDrawerFilter = useMemo(() => {
    return {
      kind: kindFilter.length ? (kindFilter as AuditKind[]) : undefined,
      operatorId: operatorFilter || undefined,
      limit: DEFAULT_LIMIT,
    };
  }, [kindFilter, operatorFilter]);

  // 加载审计列表
  useEffect(() => {
    if (!open || !autoFetch) return;
    let cancelled = false;
    setPhase('loading');
    setErrorMsg('');
    f(liveFilter)
      .then((resp) => {
        if (cancelled) return;
        setEvents(resp.events);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [open, liveFilter, f, autoFetch]);

  // 打开抽屉时重置 replay 状态（避免跨 open 残留）
  useEffect(() => {
    if (!open) {
      setReplayForId(null);
      setReplayData(null);
      setReplayPhase('idle');
      setReplayError('');
    }
  }, [open]);

  // 触发 replay 加载
  useEffect(() => {
    if (!replayForId) {
      setReplayData(null);
      setReplayPhase('idle');
      setReplayError('');
      return;
    }
    let cancelled = false;
    setReplayPhase('loading');
    setReplayError('');
    rf(replayForId)
      .then((resp) => {
        if (cancelled) return;
        setReplayData(resp);
        setReplayPhase('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReplayError(err instanceof Error ? err.message : String(err));
        setReplayPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [replayForId, rf]);

  const toggleKind = (k: string): void => {
    setKindFilter((prev) =>
      prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
    );
  };

  const toggleReplay = (eventId: string): void => {
    setReplayForId((prev) => (prev === eventId ? null : eventId));
  };

  return (
    <div
      data-testid="audit-drawer-root"
      data-open={open ? 'true' : 'false'}
      data-phase={phase}
      aria-hidden={!open}
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: open ? 'auto' : 'none',
        zIndex: 1000,
      }}
    >
      {/* 遮罩 */}
      <div
        data-testid="audit-drawer-overlay"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          opacity: open ? 1 : 0,
          transition: 'opacity 0.2s ease',
        }}
      />
      {/* 抽屉本体 */}
      <aside
        data-testid="audit-drawer-panel"
        role="dialog"
        aria-label={title ?? '审计日志'}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(720px, 90vw)',
          background: '#fff',
          boxShadow: '-4px 0 12px rgba(0,0,0,0.2)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.2s ease',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <header
          data-testid="audit-drawer-header"
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #e5e5e5',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#fafafa',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>
            {title ?? '审计日志'}
            {phase === 'ready' && (
              <span
                data-testid="audit-drawer-count"
                style={{ marginLeft: 8, fontSize: 12, color: '#666' }}
              >
                共 {events.length} 条
              </span>
            )}
          </h2>
          <button
            type="button"
            data-testid="audit-drawer-close"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 18,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </header>

        {/* 过滤条 */}
        <div
          data-testid="audit-drawer-filters"
          style={{
            padding: '8px 16px',
            borderBottom: '1px solid #eee',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#666' }}>kind:</span>
            {(['plugin.add', 'plugin.remove', 'queue.enqueue', 'queue.final_fail', 'writeback.success', 'heartbeat.dropped'] as string[]).map((k) => (
              <label
                key={k}
                data-kind-checkbox={k}
                style={{
                  fontSize: 12,
                  padding: '2px 6px',
                  border: '1px solid #ccc',
                  borderRadius: 3,
                  cursor: 'pointer',
                  background: kindFilter.includes(k) ? '#e3f2fd' : '#fff',
                }}
              >
                <input
                  type="checkbox"
                  checked={kindFilter.includes(k)}
                  onChange={() => toggleKind(k)}
                  style={{ marginRight: 4 }}
                />
                {k}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#666' }}>operator:</span>
            <input
              data-testid="audit-drawer-operator-input"
              type="text"
              value={operatorFilter}
              onChange={(e) => setOperatorFilter(e.target.value)}
              placeholder="按操作员过滤"
              style={{ fontSize: 12, padding: '2px 6px', flex: 1 }}
            />
          </div>
        </div>

        {/* 内容 */}
        <div
          data-testid="audit-drawer-body"
          style={{ flex: 1, overflowY: 'auto', padding: '0 0 16px' }}
        >
          {phase === 'loading' && (
            <div data-testid="audit-drawer-loading" style={{ padding: 16, color: '#666' }}>
              加载中…
            </div>
          )}
          {phase === 'error' && (
            <div
              data-testid="audit-drawer-error"
              role="alert"
              style={{ padding: 16, color: '#c62828' }}
            >
              加载失败：{errorMsg}
              <button
                type="button"
                data-testid="audit-drawer-retry"
                onClick={() => {
                  setPhase('idle');
                  setEvents([]);
                }}
                style={{ marginLeft: 8, fontSize: 12 }}
              >
                重试
              </button>
            </div>
          )}
          {phase === 'ready' && events.length === 0 && (
            <div
              data-testid="audit-drawer-empty"
              style={{ padding: 16, color: '#999', textAlign: 'center' }}
            >
              暂无审计事件
            </div>
          )}
          {phase === 'ready' && events.length > 0 && (
            <ul
              data-testid="audit-drawer-list"
              style={{ listStyle: 'none', margin: 0, padding: 0 }}
            >
              {events.map((ev) => {
                const isExpanded = expandedId === ev.event_id;
                const isReplayOpen = replayForId === ev.event_id;
                return (
                  <li
                    key={ev.event_id}
                    data-testid="audit-drawer-row"
                    data-event-id={ev.event_id}
                    data-kind={ev.kind}
                    data-expanded={isExpanded ? 'true' : 'false'}
                    data-replay-open={isReplayOpen ? 'true' : 'false'}
                    style={{
                      padding: '8px 16px',
                      borderBottom: '1px solid #f0f0f0',
                      background: isExpanded ? '#f7faff' : '#fff',
                    }}
                  >
                    <div
                      data-testid="audit-drawer-row-head"
                      onClick={() => setExpandedId(isExpanded ? null : ev.event_id)}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        data-testid="audit-drawer-row-kind"
                        style={{
                          fontFamily: 'monospace',
                          fontSize: 12,
                          fontWeight: 600,
                          color: ev.kind.startsWith('plugin.') ? '#1565c0'
                            : ev.kind.startsWith('queue.') ? '#6a1b9a'
                            : ev.kind.startsWith('writeback.') ? '#2e7d32'
                            : ev.kind.startsWith('processing_record.') ? '#ef6c00'
                            : '#424242',
                        }}
                      >
                        {ev.kind}
                      </span>
                      <span
                        data-testid="audit-drawer-row-ts"
                        style={{ fontSize: 11, color: '#999', fontFamily: 'monospace' }}
                      >
                        {fmtTs(ev.ts)}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                      op: <span data-testid="audit-drawer-row-operator">{ev.operator_id ?? '∅'}</span>
                      {' · '}
                      req: <code>{shortHash(ev.req_hash)}</code>
                      {' · '}
                      resp: <code>{shortHash(ev.resp_hash)}</code>
                      {' · '}
                      related: <code data-testid="audit-drawer-row-related">{ev.related_event_id ? shortHash(ev.related_event_id) : '∅'}</code>
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        data-testid="audit-drawer-replay-toggle"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleReplay(ev.event_id);
                        }}
                        style={{
                          fontSize: 11,
                          padding: '2px 8px',
                          border: '1px solid #1565c0',
                          borderRadius: 3,
                          background: isReplayOpen ? '#1565c0' : '#fff',
                          color: isReplayOpen ? '#fff' : '#1565c0',
                          cursor: 'pointer',
                        }}
                      >
                        {isReplayOpen ? '收起相关事件' : '查看相关事件'}
                      </button>
                    </div>
                    {isExpanded && (
                      <pre
                        data-testid="audit-drawer-row-payload"
                        style={{
                          marginTop: 6,
                          padding: 8,
                          background: '#fafafa',
                          border: '1px solid #eee',
                          borderRadius: 4,
                          fontSize: 11,
                          maxHeight: 240,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                        }}
                      >
                        {(() => {
                          try {
                            return JSON.stringify(JSON.parse(ev.payload_json), null, 2);
                          } catch {
                            return ev.payload_json;
                          }
                        })()}
                      </pre>
                    )}
                    {isReplayOpen && (
                      <ReplayPanel
                        currentEventId={ev.event_id}
                        replayData={replayData}
                        phase={replayPhase}
                        errorMsg={replayError}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

/** Replay 面板：在 row 下方嵌入展示 root → parents → current → children 链。 */
function ReplayPanel(props: {
  currentEventId: string;
  replayData: ReplayResponse | null;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  errorMsg: string;
}): JSX.Element {
  const { currentEventId, replayData, phase, errorMsg } = props;
  return (
    <div
      data-testid="audit-drawer-replay-panel"
      data-current-event-id={currentEventId}
      data-replay-phase={phase}
      style={{
        marginTop: 8,
        padding: 8,
        background: '#f4f7fb',
        border: '1px solid #cfd8dc',
        borderRadius: 4,
        fontSize: 11,
      }}
    >
      {phase === 'loading' && (
        <div data-testid="audit-drawer-replay-loading" style={{ color: '#666' }}>
          正在加载事件链…
        </div>
      )}
      {phase === 'error' && (
        <div
          data-testid="audit-drawer-replay-error"
          role="alert"
          style={{ color: '#c62828' }}
        >
          事件链加载失败：{errorMsg}
        </div>
      )}
      {phase === 'ready' && replayData && (
        <>
          <div
            data-testid="audit-drawer-replay-meta"
            style={{
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
              color: '#37474f',
              marginBottom: 6,
            }}
          >
            <span>
              root:{' '}
              <code data-testid="audit-drawer-replay-root" data-replay-role="root">
                {shortHash(replayData.root)}
              </code>
            </span>
            <span>
              parents:{' '}
              <code data-testid="audit-drawer-replay-parent-count">
                {replayData.parents.length}
              </code>
            </span>
            <span>
              children:{' '}
              <code data-testid="audit-drawer-replay-child-count">
                {replayData.children.length}
              </code>
            </span>
            <span>
              chain:{' '}
              <code data-testid="audit-drawer-replay-chain-count">
                {replayData.chain.length}
              </code>
            </span>
          </div>
          <ol
            data-testid="audit-drawer-replay-chain"
            style={{ listStyle: 'none', padding: 0, margin: 0 }}
          >
            {replayData.chain.map((node) => {
              const role =
                node.event_id === replayData.root
                  ? 'root'
                  : node.event_id === replayData.current.event_id
                    ? 'current'
                    : replayData.parents.some((p) => p.event_id === node.event_id)
                      ? 'parent'
                      : 'child';
              return (
                <li
                  key={node.event_id}
                  data-testid="audit-drawer-replay-node"
                  data-replay-role={role}
                  data-event-id={node.event_id}
                  style={{
                    padding: '4px 6px',
                    marginBottom: 2,
                    background:
                      role === 'current'
                        ? '#fff3e0'
                        : role === 'root'
                          ? '#e8f5e9'
                          : '#fff',
                    borderLeft:
                      role === 'current'
                        ? '3px solid #ef6c00'
                        : role === 'root'
                          ? '3px solid #2e7d32'
                          : '3px solid transparent',
                    fontFamily: 'monospace',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>
                      <strong data-replay-role-label>{role}</strong>
                      {' · '}
                      <span style={{ color: '#1565c0' }}>{node.kind}</span>
                      {node.operator_id && (
                        <span style={{ color: '#666' }}> · op:{node.operator_id}</span>
                      )}
                    </span>
                    <span style={{ color: '#999' }}>{fmtTs(node.ts)}</span>
                  </div>
                  {Object.keys(node.payload).length > 0 && (
                    <pre
                      data-testid="audit-drawer-replay-node-payload"
                      style={{
                        marginTop: 4,
                        fontSize: 10,
                        background: '#fafafa',
                        padding: 4,
                        borderRadius: 2,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }}
                    >
                      {JSON.stringify(node.payload, null, 2)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {phase === 'idle' && (
        <div data-testid="audit-drawer-replay-idle" style={{ color: '#666' }}>
          请点击「查看相关事件」加载事件链
        </div>
      )}
    </div>
  );
}

export default AuditDrawer;
