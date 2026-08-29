// src/app/kbar/multiIndex.ts
// ⌘K 五类对象（Instrument / AlarmCode / Calibration / PluginCard / ManualEntry）
// 的多键索引与模糊查询。
//
// 主路径：
//   1. buildMultiIndex(input)  收集 5 类对象，按 instrumentId / alarmCode /
//      vendor / model 多桶；textItems 按注册顺序存所有条目；
//   2. queryMulti(idx, q)      依次查 5 类键（instrumentId 精确→模糊、
//      alarmCode 精确→模糊、vendor 含中文桥→模糊、model 精确→模糊→子串、
//      text fuzzy 兜底）；
//   3. 默认 score ≥ 0.5 才算命中（同 task 19 step 3）；
//   4. 排序：score desc → 类内 KIND_PRIORITY desc → 注册顺序。
//
// 与 outline 的 KBar 默认模糊（flexsearch）差异：纯确定性 + 可测试 +
//   spec.md 工作闭环 1 直接驱动（"⌘K 命中三类对象 → 三页同屏"）。

import type { IndexableItem, IndexableKind } from './types.js';
import type {
  InstrumentRow,
  AlarmCodeRow,
  CalibrationRow,
} from './registry.js';
import {
  levenshtein,
  similarity,
  canonicalVendor,
} from './fuzzy.js';

/** 五类对象的可选扩展行型（spec.md 标的 IndexableKind 全集）。 */
export interface PluginCardRow {
  plugin_name: string;
  vendor?: string;
  description?: string;
}

export interface ManualEntryRow {
  manual_id: string;
  title: string;
  vendor?: string;
  model?: string;
}

export interface MultiIndexInput {
  instruments: InstrumentRow[];
  alarmCodes: AlarmCodeRow[];
  calibrations: CalibrationRow[];
  pluginCards?: PluginCardRow[];
  manuals?: ManualEntryRow[];
}

/** 多键索引结构。 */
export interface MultiIndex {
  byInstrumentId: Map<string, IndexableItem[]>;
  byAlarmKey: Map<string, IndexableItem>;
  byAlarmCode: Map<string, IndexableItem[]>;
  byVendor: Map<string, IndexableItem[]>;
  byModel: Map<string, IndexableItem[]>;
  /** 所有条目按注册顺序保存；用于"空查询 → 最近 5 条"兜底。 */
  textItems: IndexableItem[];
}

export interface HitCandidate {
  item: IndexableItem;
  /** 0–1；≥ 0.5 视为命中（task 19 step 3）。 */
  score: number;
  /** 命中的具体字段或键（调试 / UI 副标题展示用）。 */
  matchedKey: string;
}

/** spec 约定 ≥ 0.5 才返回。 */
export const SCORE_THRESHOLD = 0.5;

/** 类内优先级（kind 内部排序兜底；同 score 时高者优先）。 */
const KIND_PRIORITY: Record<IndexableKind, number> = {
  AlarmCode: 100,
  Instrument: 90,
  Calibration: 80,
  PluginCard: 60,
  ManualEntry: 50,
};

/** 报警码联合主键编码（与 SQL / registry.ts 同源）。 */
export function alarmKeyOf(row: Pick<AlarmCodeRow, 'vendor' | 'model' | 'alarm_code'>): string {
  return `${row.vendor}|${row.model}|${row.alarm_code}`;
}

function bucketAdd<V>(m: Map<string, V[]>, key: string, value: V): void {
  const arr = m.get(key);
  if (arr) arr.push(value);
  else m.set(key, [value]);
}

/**
 * 把所有原始行入索引；textItems 按"仪器 → 报警码 → 校准 → 插件 → 手册"顺序追加。
 */
export function buildMultiIndex(input: MultiIndexInput): MultiIndex {
  const idx: MultiIndex = {
    byInstrumentId: new Map(),
    byAlarmKey: new Map(),
    byAlarmCode: new Map(),
    byVendor: new Map(),
    byModel: new Map(),
    textItems: [],
  };

  for (const inst of input.instruments) {
    const item: IndexableItem = {
      kind: 'Instrument',
      id: inst.instrument_id,
      name: `${inst.vendor} ${inst.model} · ${inst.location}`,
      section: '仪器',
      keywords: [
        inst.instrument_id,
        inst.vendor,
        inst.model,
        inst.asset_tag,
        inst.location,
      ].filter(Boolean) as string[],
      subtitle: `资产 ${inst.asset_tag}`,
      metadata: { kind: 'Instrument', instrumentId: inst.instrument_id },
    };
    idx.textItems.push(item);
    bucketAdd(idx.byInstrumentId, inst.instrument_id.toUpperCase(), item);
    bucketAdd(idx.byVendor, inst.vendor.toLowerCase(), item);
    if (inst.model) bucketAdd(idx.byModel, inst.model.toLowerCase(), item);
  }

  for (const ac of input.alarmCodes) {
    const key = alarmKeyOf(ac);
    const item: IndexableItem = {
      kind: 'AlarmCode',
      id: key,
      name: `${ac.alarm_code} · ${ac.alarm_label}`,
      section: '报警码',
      keywords: [ac.vendor, ac.model, ac.alarm_code, ac.alarm_label].filter(
        Boolean
      ) as string[],
      subtitle: `${ac.vendor} ${ac.model}`,
      metadata: { kind: 'AlarmCode', alarmKey: key },
    };
    idx.textItems.push(item);
    idx.byAlarmKey.set(key, item);
    bucketAdd(idx.byAlarmCode, ac.alarm_code.toUpperCase(), item);
    bucketAdd(idx.byVendor, ac.vendor.toLowerCase(), item);
    if (ac.model) bucketAdd(idx.byModel, ac.model.toLowerCase(), item);
  }

  for (const c of input.calibrations) {
    const item: IndexableItem = {
      kind: 'Calibration',
      id: c.calibration_id,
      name: `校准 ${c.calibration_id.slice(0, 12)}`,
      section: '校准',
      keywords: [c.calibration_id, c.instrument_id].filter(Boolean) as string[],
      subtitle: `仪器 ${c.instrument_id} · ${c.calibrated_at}`,
      metadata: {
        kind: 'Calibration',
        calibrationId: c.calibration_id,
        instrumentId: c.instrument_id,
      },
    };
    idx.textItems.push(item);
    if (c.instrument_id) {
      bucketAdd(idx.byInstrumentId, c.instrument_id.toUpperCase(), item);
    }
  }

  for (const p of input.pluginCards ?? []) {
    const item: IndexableItem = {
      kind: 'PluginCard',
      id: p.plugin_name,
      name: p.plugin_name,
      section: '插件',
      keywords: [p.plugin_name, p.vendor ?? '', p.description ?? ''].filter(
        Boolean
      ) as string[],
      subtitle: p.description,
      metadata: { kind: 'PluginCard', name: p.plugin_name },
    };
    idx.textItems.push(item);
    if (p.vendor) bucketAdd(idx.byVendor, p.vendor.toLowerCase(), item);
  }

  for (const m of input.manuals ?? []) {
    const item: IndexableItem = {
      kind: 'ManualEntry',
      id: m.manual_id,
      name: m.title,
      section: '手册',
      keywords: [m.title, m.vendor ?? '', m.model ?? ''].filter(
        Boolean
      ) as string[],
      subtitle: `${m.vendor ?? ''} ${m.model ?? ''}`.trim(),
      metadata: { kind: 'ManualEntry', manualId: m.manual_id },
    };
    idx.textItems.push(item);
    if (m.vendor) bucketAdd(idx.byVendor, m.vendor.toLowerCase(), item);
    if (m.model) bucketAdd(idx.byModel, m.model.toLowerCase(), item);
  }

  return idx;
}

/** 命中同一 item 时合并取较高分；阈值由 queryMulti 上层过滤。 */
function pushOrUpgrade(
  hits: HitCandidate[],
  seen: Set<string>,
  item: IndexableItem,
  score: number,
  matchedKey: string
): void {
  const k = `${item.kind}|${item.id}`;
  if (seen.has(k)) {
    const existing = hits.find((h) => `${h.item.kind}|${h.item.id}` === k);
    if (existing && score > existing.score) {
      existing.score = score;
      existing.matchedKey = matchedKey;
    }
    return;
  }
  seen.add(k);
  hits.push({ item, score, matchedKey });
}

/**
 * 多键模糊查询。空 / 纯空白查询 → 返回最近 5 条（score 0 占位）。
 */
export function queryMulti(
  idx: MultiIndex,
  query: string,
  threshold: number = SCORE_THRESHOLD
): HitCandidate[] {
  const q = (query ?? '').trim();
  if (!q) {
    return idx.textItems.slice(0, 5).map((item, i) => ({
      item,
      score: 0,
      matchedKey: `(recent:${i})`,
    }));
  }

  const hits: HitCandidate[] = [];
  const seen = new Set<string>();

  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();

  // 1. instrumentId 精确 / fuzzy
  for (const [k, items] of idx.byInstrumentId) {
    if (k === qUpper) {
      for (const item of items) pushOrUpgrade(hits, seen, item, 1.0, `instrumentId:${k}`);
    } else if (
      k.length >= Math.max(4, qUpper.length - 1) &&
      levenshtein(k, qUpper, 1) <= 1
    ) {
      for (const item of items) pushOrUpgrade(hits, seen, item, 0.7, `instrumentId~:${k}`);
    }
  }

  // 2. alarmCode 精确 / fuzzy
  for (const [k, items] of idx.byAlarmCode) {
    if (k === qUpper) {
      for (const item of items) pushOrUpgrade(hits, seen, item, 1.0, `alarmCode:${k}`);
    } else if (k.length >= 3 && levenshtein(k, qUpper, 1) <= 1) {
      for (const item of items) pushOrUpgrade(hits, seen, item, 0.7, `alarmCode~:${k}`);
    }
  }

  // 3. vendor 精确（支持中文别名桥）+ fuzzy
  const vendorProbes = new Set<string>([qLower]);
  const canonical = canonicalVendor(q);
  if (canonical) {
    vendorProbes.add(canonical.toLowerCase());
    // 反向：英文 vendor 在 DB 内不一定是中文，保留原样与 lowercased canonical
  }
  for (const probe of vendorProbes) {
    for (const [k, items] of idx.byVendor) {
      if (k === probe) {
        for (const item of items) pushOrUpgrade(hits, seen, item, 0.95, `vendor:${k}`);
      } else if (k.length >= 3 && levenshtein(k, probe, 1) <= 1) {
        for (const item of items) pushOrUpgrade(hits, seen, item, 0.65, `vendor~:${k}`);
      }
    }
  }

  // 4. model 精确 / fuzzy / 子串
  for (const [k, items] of idx.byModel) {
    if (k === qLower) {
      for (const item of items) pushOrUpgrade(hits, seen, item, 0.9, `model:${k}`);
    } else if (k.length >= 3 && levenshtein(k, qLower, 1) <= 1) {
      for (const item of items) pushOrUpgrade(hits, seen, item, 0.6, `model~:${k}`);
    } else if (qLower.length >= 2 && k.includes(qLower)) {
      for (const item of items) pushOrUpgrade(hits, seen, item, 0.55, `model*:${k}`);
    }
  }

  // 5. text fuzzy 兜底（关键词逐条 vs q）
  for (const item of idx.textItems) {
    let bestScore = 0;
    let bestKw = '';
    for (const kw of item.keywords) {
      const s = similarity(kw, q, 1);
      if (s > bestScore) {
        bestScore = s;
        bestKw = kw;
      }
    }
    if (bestScore >= 0.5) {
      pushOrUpgrade(hits, seen, item, Math.min(bestScore, 0.6), `kw:${bestKw}`);
    }
  }

  // 排序：score desc → 类内优先级 desc → 注册顺序
  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ka = KIND_PRIORITY[a.item.kind];
    const kb = KIND_PRIORITY[b.item.kind];
    if (ka !== kb) return kb - ka;
    return 0;
  });

  return hits.filter((h) => h.score >= threshold);
}
