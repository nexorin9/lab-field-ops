// src/shared/embeds/renderer.tsx
// 文档扫描 + Embed 渲染：把含 `{{embed:name url}}` 标记的 Markdown 解析为
// 「纯文本 run + embed run」流，由 React 端按 run 类型选择渲染（EmbedCard 或 fallback）。
//
// 主路径（沿用 outline `Editor.renderer` 的形态）：
//   scanDocument(md)  → { plainRuns, embedRuns }
//   renderEmbed(embed) → ReactNode（命中：EmbedCard；未匹配：fallback）
//
// 标记语法：`{{embed:<name> <url>}}`，name 必须是已注册的 descriptor 名；
// 若 name 不在注册表里，renderEmbed 返回 fallback。

import * as React from 'react';
import { matchEmbeds, getEmbedByName } from './index.js';
import type { EmbedMatch, EmbedDescriptor } from './types.js';
import { renderEmbedFallback } from './fallback.js';

/** 文档里的纯文本 run：markdown 文本（不含 embed 标记）。 */
export interface PlainRun {
  kind: 'plain';
  text: string;
}

/** 文档里的 embed run：来自 `{{embed:name url}}` 标记。 */
export interface EmbedRun {
  kind: 'embed';
  /** 描述子名；未注册时仍渲染 fallback 但 markAsUnknown=true。 */
  name: string;
  url: string;
  /** 扫描时刻是否已匹配到描述子；true 走 EmbedCard，false 走 fallback。 */
  matched: boolean;
  /** 命中时的描述子（仅 matched=true 时存在）。 */
  descriptor?: EmbedDescriptor;
  /** 命中的 keyGroup 抽取值（可选）。 */
  key?: string | null;
}

/** scanDocument 的输出：纯文本与 embed 交替的 run 流。 */
export type DocumentRun = PlainRun | EmbedRun;

/** Embed 标记正则：`{{embed:<name> <url>}}`。 */
const EMBED_MARKER_REGEX = /\{\{embed:([a-z0-9_-]+)\s+(\S+?)\}\}/gi;

/**
 * 扫描整份 Markdown 文档为 run 数组。匹配描述子的 run 标 matched=true，
 * 未注册或 url 形态已变更（如 LIS 报告被改）则标 matched=false。
 */
export function scanDocument(
  markdown: string,
  options: { onInputOnly?: boolean } = {}
): DocumentRun[] {
  if (!markdown) {
    return [];
  }
  const runs: DocumentRun[] = [];
  let lastIndex = 0;
  // 每次 reset regex lastIndex，避免 g 标志跨调用串状态
  EMBED_MARKER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMBED_MARKER_REGEX.exec(markdown)) !== null) {
    const [whole, name, url] = m;
    if (m.index > lastIndex) {
      runs.push({ kind: 'plain', text: markdown.slice(lastIndex, m.index) });
    }
    const descriptor = getEmbedByName(name);
    let matched = false;
    let key: string | null | undefined = undefined;
    let matchedDescriptor: EmbedDescriptor | undefined;
    if (descriptor) {
      const hits = matchEmbeds(url, undefined, {
        onInputOnly: options.onInputOnly ?? true,
      });
      const hit = hits.find((h) => h.descriptor.name === name);
      if (hit) {
        matched = true;
        key = hit.key;
        matchedDescriptor = descriptor;
      }
    }
    runs.push({
      kind: 'embed',
      name,
      url,
      matched,
      descriptor: matchedDescriptor,
      key,
    });
    lastIndex = m.index + whole.length;
  }
  const trailing = markdown.slice(lastIndex);
  if (trailing.length > 0) {
    runs.push({ kind: 'plain', text: trailing });
  } else if (runs.length > 0 && runs[runs.length - 1].kind === 'embed') {
    // 文档以 embed 收尾 → 加一段空 plain 让 caller 始终能拿到「最后一段」
    runs.push({ kind: 'plain', text: '' });
  }
  return runs;
}

/**
 * 把 paste 文本插入到当前文档。识别文本中的 URL：
 * - 命中描述子的 URL 插入 `{{embed:name url}}` 标记；
 * - 未匹配的 URL 保留原文（不删、不报错）。
 * 重复粘贴同 URL 会插入多份（不主动去重，由 UI 层决定）。
 */
export interface PasteContext {
  currentDoc: string;
  pasteText: string;
  /** 选区起始位置（textarea caret index）。 */
  caret: number;
  /** 选区结束位置；缺省 = caret。 */
  selectionEnd?: number;
}

export interface PasteResult {
  nextDoc: string;
  nextCaret: number;
  /** 实际插入的 embed 标记条目。 */
  insertedEmbeds: Array<{ name: string; url: string; matched: boolean }>;
  /** 实际插入的纯文本 URL（未匹配，不报错）。 */
  insertedPlainUrls: string[];
}

const URL_REGEX =
  /https?:\/\/[^\s<>"'`，。；！？）】》]+|lis:\/\/[^\s<>"'`，。；！？）】》]+|cal:\/\/[^\s<>"'`，。；！？）】》]+/gi;

/** 从 paste 文本里抽出所有 URL（不区分匹配与否）。 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  URL_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_REGEX.exec(text)) !== null) {
    // 去掉 URL 末尾的标点：英文 . , ; ! ? ) ] } > 与中文 。 ， ； ！ ？ ） 】 》
    out.push(
      m[0].replace(/[.,;!?)\]}>。，；！？）】》]+$/u, '')
    );
  }
  return out;
}

/** 把一段 paste 文本在文档选区处「转换后」插入，返回新文档与 caret。 */
export function applyPaste(ctx: PasteContext): PasteResult {
  const { currentDoc, pasteText, caret } = ctx;
  const selectionEnd = ctx.selectionEnd ?? caret;
  const before = currentDoc.slice(0, caret);
  const after = currentDoc.slice(selectionEnd);
  const urls = extractUrls(pasteText);

  const insertedEmbeds: PasteResult['insertedEmbeds'] = [];
  const insertedPlainUrls: string[] = [];

  // 逐 URL 决定：命中描述子 → embed 标记；未命中 → 原文 URL
  const segments: string[] = [];
  let cursor = 0;
  for (const url of urls) {
    const idx = pasteText.indexOf(url, cursor);
    if (idx > cursor) {
      segments.push(pasteText.slice(cursor, idx));
    }
    const hits = matchEmbeds(url);
    if (hits.length > 0) {
      const top = hits[0];
      const marker = `{{embed:${top.descriptor.name} ${url}}}`;
      segments.push(marker);
      insertedEmbeds.push({
        name: top.descriptor.name,
        url,
        matched: true,
      });
    } else {
      segments.push(url);
      insertedPlainUrls.push(url);
    }
    cursor = idx + url.length;
  }
  if (cursor < pasteText.length) {
    segments.push(pasteText.slice(cursor));
  }

  const inserted = segments.join('');
  const nextDoc = before + inserted + after;
  const nextCaret = before.length + inserted.length;

  return {
    nextDoc,
    nextCaret,
    insertedEmbeds,
    insertedPlainUrls,
  };
}

/** renderEmbed 的 React 节点；命中走瘦卡片 div，未匹配走 fallback。 */
export function renderEmbed(embed: EmbedRun): React.ReactElement {
  if (embed.matched && embed.descriptor) {
    return React.createElement(
      'div',
      {
        className: `embed-card embed-card--${embed.descriptor.kind}`,
        'data-embed-name': embed.descriptor.name,
        'data-embed-url': embed.url,
        'data-status': 'ok',
        'data-key': embed.key ?? '',
      },
      [
        React.createElement('span', { key: 'title' }, embed.descriptor.title),
        React.createElement('span', { key: 'url' }, embed.url),
        embed.key ? React.createElement('span', { key: 'kv' }, ` · ${embed.key}`) : null,
      ]
    );
  }
  return renderEmbedFallback(embed.url, embed.name);
}

// Re-export for callers that want the type but not React JSX runtime
export type { EmbedMatch };
