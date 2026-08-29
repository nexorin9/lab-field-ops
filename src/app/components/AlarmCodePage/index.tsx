// src/app/components/AlarmCodePage/index.tsx
//
// 单条报警码的资料页（SOP markdown 渲染 + 关联仪器清单）。
// ⌘K 命中 vendor|model|alarm_code 联合主键时打开本组件。
//
// 设计：
//   - props = { vendor, model, alarmCode } 联合主键定位。
//   - SOP 走 Markdown 轻渲染：标题 / 有序列表 / 普通段落；
//     不引外部 markdown 库（避免 bundle 膨胀），按 spec.md 「server/editor extensionManager.parser 参考」
//     走纯 React 节点生成。
//   - 关联仪器清单：拉取所有 vendor+model 相同的仪器列表（不分页）。
//   - 数据通过 fetcher 依赖注入；测试可传 stub。
//
// 与 outline `shared/editor/marks/Code.tsx` 的「轻量 inline render」形态同源：
//   - 不绑 ProseMirror schema；纯 Markdown 字符串解析 + React 节点；
//   - 失败时回退 <pre>{raw}</pre>（与原版 fallthrough 一致）。

import * as React from 'react';
import type { AlarmCode, Instrument } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// fetchers
// ---------------------------------------------------------------------------

export interface AlarmCodePageFetchers {
  alarmCode: (vendor: string, model: string, alarmCode: string) => Promise<AlarmCode | null>;
  instruments: (vendor: string, model: string) => Promise<Instrument[]>;
}

export const defaultAlarmCodeFetchers: AlarmCodePageFetchers = {
  alarmCode: async (vendor, model, code) => {
    const qs = new URLSearchParams({
      vendor,
      model,
      alarm_code: code,
    }).toString();
    const res = await fetch(`/api/alarm-codes?${qs}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { alarm_codes: AlarmCode[] };
    return body.alarm_codes?.[0] ?? null;
  },
  instruments: async (vendor, model) => {
    const qs = new URLSearchParams({ vendor, model }).toString();
    const res = await fetch(`/api/instruments?${qs}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { instruments: Instrument[] };
    return body.instruments ?? [];
  },
};

// ---------------------------------------------------------------------------
// useRequest（与 InstrumentPage 同形；不引共享 lib 避免跨模块耦合）
// ---------------------------------------------------------------------------

export type RequestState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: string };

function useRequest<T>(
  fetcher: () => Promise<T>,
  deps: React.DependencyList,
): RequestState<T> {
  const [state, setState] = React.useState<RequestState<T>>({ status: 'idle' });
  React.useEffect(() => {
    let cancelled = false;
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
  return state;
}

// ---------------------------------------------------------------------------
// Markdown 轻渲染（仅支持 # 标题 / 1. 有序列表 / 普通段落 / 空行）
// ---------------------------------------------------------------------------

type MarkdownNode =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list-item'; index: number; text: string }
  | { kind: 'paragraph'; text: string };

function parseMarkdown(md: string): MarkdownNode[] {
  const lines = md.split(/\r?\n/);
  const out: MarkdownNode[] = [];
  let listIndex = 0;
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    out.push({ kind: 'paragraph', text: paragraphBuffer.join('\n') });
    paragraphBuffer = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '') {
      flushParagraph();
      listIndex = 0;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      out.push({
        kind: 'heading',
        level: heading[1]!.length,
        text: heading[2]!.trim(),
      });
      listIndex = 0;
      continue;
    }
    const li = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (li) {
      flushParagraph();
      listIndex += 1;
      out.push({ kind: 'list-item', index: listIndex, text: li[1]!.trim() });
      continue;
    }
    paragraphBuffer.push(line);
  }
  flushParagraph();
  return out;
}

const SOPMarkdown: React.FC<{ md: string }> = ({ md }) => {
  const nodes = React.useMemo(() => parseMarkdown(md), [md]);
  if (nodes.length === 0) {
    return (
      <div
        data-testid="alarm-sop-empty"
        style={{ padding: 8, color: '#888', fontSize: 13 }}
      >
        （无 SOP 文档）
      </div>
    );
  }
  return (
    <div data-testid="alarm-sop-md" data-nodes={nodes.length}>
      {nodes.map((n, idx) => {
        if (n.kind === 'heading') {
          const Tag = (`h${Math.min(6, n.level + 2)}` as 'h3' | 'h4' | 'h5');
          return (
            <Tag
              key={idx}
              data-run-kind="heading"
              data-level={n.level}
              style={{ margin: '8px 0 4px', fontSize: 14, fontWeight: 600 }}
            >
              {n.text}
            </Tag>
          );
        }
        if (n.kind === 'list-item') {
          return (
            <div
              key={idx}
              data-run-kind="list-item"
              data-index={n.index}
              style={{ paddingLeft: 24, fontSize: 13, lineHeight: 1.6 }}
            >
              {n.index}. {n.text}
            </div>
          );
        }
        return (
          <p
            key={idx}
            data-run-kind="paragraph"
            style={{ margin: '4px 0', fontSize: 13, lineHeight: 1.6 }}
          >
            {n.text}
          </p>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 关联仪器清单
// ---------------------------------------------------------------------------

const LinkedInstruments: React.FC<{ rows: Instrument[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return (
      <div
        data-testid="alarm-instruments-empty"
        style={{ padding: 8, color: '#888', fontSize: 13 }}
      >
        暂无关联仪器
      </div>
    );
  }
  return (
    <ul
      data-testid="alarm-instruments-list"
      data-count={rows.length}
      style={{ listStyle: 'none', padding: 0, margin: 0 }}
    >
      {rows.map((i) => (
        <li
          key={i.instrument_id}
          data-instrument-id={i.instrument_id}
          data-status={i.status}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '6px 8px',
            borderBottom: '1px solid #eee',
            fontSize: 13,
          }}
        >
          <span style={{ fontFamily: 'monospace' }}>{i.instrument_id}</span>
          <span style={{ color: '#666' }}>{i.asset_tag}</span>
          <span style={{ color: i.status === 'online' ? '#2e7d32' : '#c62828' }}>
            {i.status}
          </span>
        </li>
      ))}
    </ul>
  );
};

// ---------------------------------------------------------------------------
// 页面主体
// ---------------------------------------------------------------------------

export interface AlarmCodePageProps {
  vendor: string;
  model: string;
  alarmCode: string;
  fetchers?: AlarmCodePageFetchers;
}

export function AlarmCodePage({
  vendor,
  model,
  alarmCode,
  fetchers: fetchersProp,
}: AlarmCodePageProps): React.ReactElement {
  const fetchers = fetchersProp ?? defaultAlarmCodeFetchers;

  const alarmState = useRequest(
    () => fetchers.alarmCode(vendor, model, alarmCode),
    [vendor, model, alarmCode],
  );
  const instState = useRequest(
    () => fetchers.instruments(vendor, model),
    [vendor, model],
  );

  const alarm = alarmState.status === 'ready' ? alarmState.data : null;

  return (
    <div
      data-testid="alarm-code-page-root"
      data-vendor={vendor}
      data-model={model}
      data-alarm-code={alarmCode}
      data-status={alarmState.status}
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
          {alarmState.status === 'loading'
            ? '加载中…'
            : alarmState.status === 'error'
              ? `加载失败：${alarmState.error}`
              : alarm
                ? `${alarm.alarm_label}（${alarm.alarm_code}）`
                : '未找到'}
        </div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
          <span style={{ fontFamily: 'monospace' }}>{vendor} / {model}</span>
          <span style={{ marginLeft: 12, fontFamily: 'monospace' }}>
            报警码：{alarmCode}
          </span>
        </div>
      </header>

      <section style={{ marginBottom: 12 }} data-section="sop">
        <h3 style={{ fontSize: 13, margin: '0 0 6px', color: '#444' }}>SOP 处置流程</h3>
        {alarmState.status === 'loading' && (
          <div data-testid="alarm-sop-loading">加载中…</div>
        )}
        {alarmState.status === 'error' && (
          <div data-testid="alarm-sop-error" style={{ color: '#c62828' }}>
            加载失败：{alarmState.error}
          </div>
        )}
        {alarmState.status === 'ready' && (
          alarm ? <SOPMarkdown md={alarm.sop_md} /> : (
            <div data-testid="alarm-not-found" style={{ color: '#888' }}>
              未匹配到对应 SOP
            </div>
          )
        )}
      </section>

      <section data-section="instruments">
        <h3 style={{ fontSize: 13, margin: '0 0 6px', color: '#444' }}>关联仪器</h3>
        {instState.status === 'loading' && (
          <div data-testid="alarm-inst-loading">加载中…</div>
        )}
        {instState.status === 'error' && (
          <div data-testid="alarm-inst-error" style={{ color: '#c62828' }}>
            加载失败：{instState.error}
          </div>
        )}
        {instState.status === 'ready' && <LinkedInstruments rows={instState.data} />}
      </section>
    </div>
  );
}

export default AlarmCodePage;
