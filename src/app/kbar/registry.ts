// src/app/kbar/registry.ts
// ⌘K 五类对象索引：Instrument / AlarmCode / Calibration / PluginCard / ManualEntry。
//
// 主路径（与 outline 一致）：
//   1. 接收查询字符串；
//   2. parseQuery 解析为 ParsedQuery；
//   3. 按规则查三类对象（Instrument / AlarmCode / Calibration）；
//   4. 返回按 section 排序后的 KBarAction[]。
//
// 与 GitHub SEED 参考（outline app/index.tsx 的 KBarProvider actions=[]）的差异：
//   - outline 把 actions 注册时即组装，本项目按需 query → actions；
//   - 同 query 命中多对象时，给出一个「打开 SplitView」的合并动作（id='split-<queryHash>'）；
//   - 数据库读取走依赖注入（db 句柄），便于测试替身。

import type Database from 'better-sqlite3';
import type { KBarAction, KBarSectionName, ParsedQuery } from './types.js';
import { parseQuery } from './parseQuery.js';
import {
  createAction,
  createInternalLinkAction,
  sortActions,
} from './actions.js';
import {
  buildMultiIndex,
  queryMulti,
  type HitCandidate,
  type PluginCardRow,
  type ManualEntryRow,
} from './multiIndex.js';

/** SQLite 行 → 仪器对象（仅取 ⌘K 所需字段）。 */
export interface InstrumentRow {
  instrument_id: string;
  vendor: string;
  model: string;
  asset_tag: string;
  location: string;
}

/** SQLite 行 → 报警码对象。 */
export interface AlarmCodeRow {
  vendor: string;
  model: string;
  alarm_code: string;
  alarm_label: string;
}

/** SQLite 行 → 校准对象。 */
export interface CalibrationRow {
  calibration_id: string;
  instrument_id: string;
  calibrated_at: string;
}

/** 可被 kbar 索引的对象全集（来自 DB 或 seed）。 */
export interface KbarIndexInput {
  instruments: InstrumentRow[];
  alarmCodes: AlarmCodeRow[];
  calibrations: CalibrationRow[];
}

/** SplitView 触发钩子（由 app/index.tsx 注入；测试可替身）。 */
export type SplitViewOpener = (target: {
  instrumentId?: string;
  alarmKey?: string;
  calibrationId?: string;
}) => void;

export interface BuildIndexOptions {
  /** 仅在「⌘K 选定后」打开路由用。 */
  pushRoute?: (to: string) => void;
  /** SplitView 触发钩子（缺省则不输出 split action）。 */
  openSplit?: SplitViewOpener;
  /** 历史查仪器的最大条数（用于空 query 的「最近 5 条」兜底）。 */
  recentLimit?: number;
  /** 五类索引扩展项（PluginCard / ManualEntry），让 fuzzy 也能命中插件 / 手册。 */
  pluginCards?: PluginCardRow[];
  manuals?: ManualEntryRow[];
  /** fuzzy 命中阈值（默认 0.5，与 task 19 step 3 对齐）。 */
  fuzzyThreshold?: number;
}

const DEFAULT_RECENT_LIMIT = 5;

/** 报警码联合主键编码（与 SQL 联合主键一致）。 */
export function alarmKeyOf(row: Pick<AlarmCodeRow, 'vendor' | 'model' | 'alarm_code'>): string {
  return `${row.vendor}|${row.model}|${row.alarm_code}`;
}

/**
 * 把查询解析后的形态映射为 ⌘K 命中结果。
 * 返回有序的 KBarAction 列表（供 KBarProvider 直接消费）。
 *
 * 路径分支：
 *   - 空 query → 最近 5 条仪器（兜底）；
 *   - 非空 / 非结构化（parseQuery 失败）→ 跑 multiIndex 模糊匹配；
 *     有命中 → 转 actions；无命中 → 兜底回退到最近 5 条仪器；
 *   - 结构化 parseQuery 命中 → 走精确路径，并按需附 SplitView 合并动作。
 */
export function buildIndex(
  input: KbarIndexInput,
  query: string,
  options: BuildIndexOptions = {}
): KBarAction[] {
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const trimmed = (query ?? '').trim();
  const parsed = parseQuery(query);

  if (!parsed.ok) {
    // 空 / 纯空白 query：返回最近 5 条仪器（兜底：工程师 ⌘K 后立即看到台账）。
    if (!trimmed) {
      return sortActions(buildRecentActions(input.instruments, recentLimit, options));
    }

    // 非结构化输入：跑五类对象的 fuzzy 命中（task 19）。
    const idx = buildMultiIndex({
      instruments: input.instruments,
      alarmCodes: input.alarmCodes,
      calibrations: input.calibrations,
      pluginCards: options.pluginCards,
      manuals: options.manuals,
    });
    const hits = queryMulti(idx, trimmed, options.fuzzyThreshold ?? 0.5);
    if (hits.length > 0) {
      return sortActions(hitsToActions(hits, options));
    }
    // fuzzy 仍无命中 → 回退到最近 5 条仪器（保留 ⌘K 始终有可见结果的体感）。
    return sortActions(buildRecentActions(input.instruments, recentLimit, options));
  }

  const actions: KBarAction[] = [];
  for (const p of parsed.parsed) {
    actions.push(...actionsForParsed(p, input, options));
  }

  // ⌘K 命中三类对象 → 合并为「打开 SplitView」动作（id 稳定）。
  if (options.openSplit && actions.length > 0) {
    const target = collectSplitTarget(parsed.parsed[0], input);
    if (target.instrumentId || target.alarmKey || target.calibrationId) {
      actions.push(buildSplitAction(target, parsed.parsed[0].raw, options.openSplit));
    }
  }

  return sortActions(actions);
}

function actionsForParsed(
  p: ParsedQuery,
  input: KbarIndexInput,
  options: BuildIndexOptions
): KBarAction[] {
  const actions: KBarAction[] = [];
  const push = options.pushRoute ?? (() => undefined);

  // 规则 1：单段 instrumentId
  if (p.instrumentId) {
    const inst = input.instruments.find(
      (i) => i.instrument_id.toUpperCase() === p.instrumentId!.toUpperCase()
    );
    if (inst) {
      actions.push(
        createInternalLinkAction({
          name: `${inst.vendor} ${inst.model} · ${inst.location}`,
          to: `/instruments/${encodeURIComponent(inst.instrument_id)}`,
          section: '仪器',
          push,
          keywords: [inst.instrument_id, inst.vendor, inst.model, inst.asset_tag],
          subtitle: `资产 ${inst.asset_tag}`,
          priority: 100,
          metadata: {
            kind: 'Instrument',
            instrumentId: inst.instrument_id,
          },
        })
      );
    }
    return actions;
  }

  // 规则 2：三段 vendor/model/alarmCode
  if (p.vendor && p.model && p.alarmCode) {
    const v = p.vendor.toLowerCase();
    const m = p.model.toLowerCase();
    const ac = p.alarmCode.toUpperCase();

    // 命中 1：报警码（联合主键精确匹配）
    const alarmHit = input.alarmCodes.find(
      (a) =>
        a.vendor.toLowerCase() === v &&
        a.model.toLowerCase() === m &&
        a.alarm_code.toUpperCase() === ac
    );
    if (alarmHit) {
      actions.push(
        createInternalLinkAction({
          name: `${alarmHit.alarm_code} · ${alarmHit.alarm_label}`,
          to: `/alarm-codes/${encodeURIComponent(alarmHit.vendor)}/${encodeURIComponent(alarmHit.model)}/${encodeURIComponent(alarmHit.alarm_code)}`,
          section: '报警码',
          push,
          keywords: [alarmHit.vendor, alarmHit.model, alarmHit.alarm_code, alarmHit.alarm_label],
          subtitle: `${alarmHit.vendor} ${alarmHit.model}`,
          priority: 100,
          metadata: {
            kind: 'AlarmCode',
            alarmKey: alarmKeyOf(alarmHit),
          },
        })
      );
    }

    // 命中 2：仪器（vendor+model 联合匹配）
    const instrumentHits = input.instruments.filter(
      (i) => i.vendor.toLowerCase() === v && i.model.toLowerCase() === m
    );
    for (const inst of instrumentHits) {
      actions.push(
        createInternalLinkAction({
          name: `${inst.vendor} ${inst.model} · ${inst.location}`,
          to: `/instruments/${encodeURIComponent(inst.instrument_id)}`,
          section: '仪器',
          push,
          keywords: [inst.instrument_id, inst.vendor, inst.model, inst.asset_tag],
          subtitle: `资产 ${inst.asset_tag}`,
          priority: 90,
          metadata: {
            kind: 'Instrument',
            instrumentId: inst.instrument_id,
          },
        })
      );
    }

    // 命中 3：最近 7 天校准（按 instrument_id 关联）
    const instIds = new Set(instrumentHits.map((i) => i.instrument_id));
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const calibHits = input.calibrations.filter(
      (c) =>
        instIds.has(c.instrument_id) &&
        Date.parse(c.calibrated_at) >= sevenDaysAgo
    );
    for (const c of calibHits.slice(0, 5)) {
      actions.push(
        createInternalLinkAction({
          name: `校准 ${c.calibration_id.slice(0, 12)}`,
          to: `/calibrations/${encodeURIComponent(c.calibration_id)}`,
          section: '校准',
          push,
          subtitle: `仪器 ${c.instrument_id} · ${c.calibrated_at}`,
          priority: 80,
          metadata: {
            kind: 'Calibration',
            calibrationId: c.calibration_id,
            instrumentId: c.instrument_id,
          },
        })
      );
    }

    return actions;
  }

  return actions;
}

function buildRecentActions(
  instruments: InstrumentRow[],
  limit: number,
  options: BuildIndexOptions
): KBarAction[] {
  const push = options.pushRoute ?? (() => undefined);
  return instruments.slice(0, limit).map((inst) =>
    createInternalLinkAction({
      name: `${inst.vendor} ${inst.model} · ${inst.location}`,
      to: `/instruments/${encodeURIComponent(inst.instrument_id)}`,
      section: '仪器',
      push,
      keywords: [inst.instrument_id, inst.vendor, inst.model, inst.asset_tag],
      subtitle: `资产 ${inst.asset_tag}`,
      priority: 60,
      metadata: { kind: 'Instrument', instrumentId: inst.instrument_id },
    })
  );
}

function buildSplitAction(
  target: { instrumentId?: string; alarmKey?: string; calibrationId?: string },
  raw: string,
  openSplit: SplitViewOpener
): KBarAction {
  const hash = stableHash(raw);
  return createAction({
    id: `split-${hash}`,
    name: '三页同屏打开（仪器 / 报警 / 校准）',
    section: '导航',
    perform: () => openSplit(target),
    subtitle: '⌘K 选中后立刻同屏展开',
    shortcut: ['↵'],
    priority: 200,
    keywords: ['split', '同屏', '三页'],
    metadata: { ...target, kind: 'SplitTarget' },
  });
}

/** 把 query 解析后的形态转换为 SplitView 目标（取首个匹配对象）。 */
function collectSplitTarget(
  p: ParsedQuery,
  input: KbarIndexInput
): { instrumentId?: string; alarmKey?: string; calibrationId?: string } {
  const out: { instrumentId?: string; alarmKey?: string; calibrationId?: string } = {};

  if (p.instrumentId) {
    const inst = input.instruments.find(
      (i) => i.instrument_id.toUpperCase() === p.instrumentId!.toUpperCase()
    );
    if (inst) out.instrumentId = inst.instrument_id;
    return out;
  }

  if (p.vendor && p.model && p.alarmCode) {
    const v = p.vendor.toLowerCase();
    const m = p.model.toLowerCase();
    const ac = p.alarmCode.toUpperCase();
    const alarmHit = input.alarmCodes.find(
      (a) =>
        a.vendor.toLowerCase() === v &&
        a.model.toLowerCase() === m &&
        a.alarm_code.toUpperCase() === ac
    );
    if (alarmHit) out.alarmKey = alarmKeyOf(alarmHit);

    const instHit = input.instruments.find(
      (i) => i.vendor.toLowerCase() === v && i.model.toLowerCase() === m
    );
    if (instHit) out.instrumentId = instHit.instrument_id;

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (instHit) {
      const calib = input.calibrations.find(
        (c) => c.instrument_id === instHit.instrument_id && Date.parse(c.calibrated_at) >= sevenDaysAgo
      );
      if (calib) out.calibrationId = calib.calibration_id;
    }
  }

  return out;
}

/** FNV-1a 32-bit 哈希（避免 Node 端 crypto 依赖）。 */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* -------------------------------------------------------------------------- */
/* SQLite 适配层：把 better-sqlite3 行转换为 KbarIndexInput。                  */
/* -------------------------------------------------------------------------- */

export interface KbarFromDbOptions {
  /** 历史查询窗口（毫秒），默认 7 天。 */
  windowMs?: number;
}

/** 从 better-sqlite3 实例拉取 ⌘K 索引所需的全部数据。 */
export function readKbarIndexFromDb(
  db: Database.Database,
  options: KbarFromDbOptions = {}
): KbarIndexInput {
  const windowMs = options.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  const instruments = db
    .prepare(
      `SELECT instrument_id, vendor, model, asset_tag, location
         FROM instrument
         ORDER BY instrument_id`
    )
    .all() as InstrumentRow[];

  const alarmCodes = db
    .prepare(
      `SELECT vendor, model, alarm_code, alarm_label
         FROM alarm_code
         ORDER BY vendor, model, alarm_code`
    )
    .all() as AlarmCodeRow[];

  const calibrations = db
    .prepare(
      `SELECT calibration_id, instrument_id, calibrated_at
         FROM calibration
         WHERE calibrated_at >= ?
         ORDER BY calibrated_at DESC
         LIMIT 200`
    )
    .all(cutoff) as CalibrationRow[];

  return { instruments, alarmCodes, calibrations };
}

/** 直接跑一次 ⌘K：DB + query → 排序后的 actions（供 KBarProvider 用）。 */
export function queryKbarFromDb(
  db: Database.Database,
  query: string,
  options: BuildIndexOptions & KbarFromDbOptions = {}
): KBarAction[] {
  const index = readKbarIndexFromDb(db, { windowMs: options.windowMs });
  return buildIndex(index, query, options);
}

/** 当前 ⌘K 激活时推荐返回的「兜底 section」（spec.md 工作闭环 1：未匹配 → 编辑查询）。 */
export const FALLBACK_SECTION: KBarSectionName = '导航';

/** SplitView 命中三条提示（用户面对 ⌘K 结果的简短语义）。 */
export const SPLIT_HINT_NAME = '三页同屏打开（仪器 / 报警 / 校准）';

/* -------------------------------------------------------------------------- */
/* fuzzy 命中转 actions（task 19 step 3 集成）                                */
/* -------------------------------------------------------------------------- */

/**
 * 把 queryMulti 返回的 HitCandidate 列表转成 KBarAction（fuzzy 命中专用）。
 * AlarmCode / Instrument / Calibration 走内部链接；PluginCard / ManualEntry 仅
 * 显示（无统一路由，perform noop；后续 task 18 资料页 / task 9 plugin list 落地）。
 *
 * 优先级（与多键索引 KIND_PRIORITY 对齐）：
 *   AlarmCode 100 → Instrument 90 → Calibration 80 → PluginCard 60 → ManualEntry 50
 */
export function hitsToActions(
  hits: HitCandidate[],
  options: BuildIndexOptions = {}
): KBarAction[] {
  const push = options.pushRoute ?? (() => undefined);
  return hits.map((h) => {
    const item = h.item;
    const scoreTag = `score ${h.score.toFixed(2)} · ${h.matchedKey}`;
    switch (item.kind) {
      case 'AlarmCode': {
        const alarmKey = String(item.metadata.alarmKey ?? item.id);
        const parts = alarmKey.split('|');
        const [vendor, model, alarmCode] = parts;
        return createInternalLinkAction({
          id: `fuzzy-${item.kind}-${item.id}`,
          name: item.name,
          to: `/alarm-codes/${encodeURIComponent(vendor)}/${encodeURIComponent(model)}/${encodeURIComponent(alarmCode)}`,
          section: '报警码',
          push,
          keywords: item.keywords,
          subtitle: scoreTag,
          priority: 100,
          metadata: { ...item.metadata, score: h.score, matchedKey: h.matchedKey },
        });
      }
      case 'Instrument': {
        return createInternalLinkAction({
          id: `fuzzy-${item.kind}-${item.id}`,
          name: item.name,
          to: `/instruments/${encodeURIComponent(item.id)}`,
          section: '仪器',
          push,
          keywords: item.keywords,
          subtitle: scoreTag,
          priority: 90,
          metadata: { ...item.metadata, score: h.score, matchedKey: h.matchedKey },
        });
      }
      case 'Calibration': {
        return createInternalLinkAction({
          id: `fuzzy-${item.kind}-${item.id}`,
          name: item.name,
          to: `/calibrations/${encodeURIComponent(item.id)}`,
          section: '校准',
          push,
          keywords: item.keywords,
          subtitle: scoreTag,
          priority: 80,
          metadata: { ...item.metadata, score: h.score, matchedKey: h.matchedKey },
        });
      }
      case 'PluginCard': {
        return createAction({
          id: `fuzzy-${item.kind}-${item.id}`,
          name: item.name,
          section: '插件',
          perform: () => undefined,
          keywords: item.keywords,
          subtitle: scoreTag,
          priority: 60,
          metadata: { ...item.metadata, score: h.score, matchedKey: h.matchedKey },
        });
      }
      case 'ManualEntry': {
        return createAction({
          id: `fuzzy-${item.kind}-${item.id}`,
          name: item.name,
          section: '手册',
          perform: () => undefined,
          keywords: item.keywords,
          subtitle: scoreTag,
          priority: 50,
          metadata: { ...item.metadata, score: h.score, matchedKey: h.matchedKey },
        });
      }
    }
  });
}