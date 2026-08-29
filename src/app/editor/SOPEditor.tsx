// src/app/editor/SOPEditor.tsx
// 检验 SOP 编辑器：受控 textarea，监听粘贴事件 → 调用 applyPaste
// （renderer.tsx 纯函数）→ 把粘贴文本里的 URL 转成 `{{embed:name url}}` 标记或原文 URL。
//
// 主路径（沿用 outline `Editor` paste handler 的形态）：
//   onPaste → 取 clipboardData.getData('text') → applyPaste({ currentDoc, pasteText, caret, selectionEnd })
//     → onChange(nextDoc) + setCaret(nextCaret)
//
// 处理记录提交走 POST /api/processing-records（见 routes/processing-records.ts）。

import * as React from 'react';
import { applyPaste, type PasteResult } from '../../shared/embeds/renderer.js';

export interface SOPEditorProps {
  /** 文档初值（Markdown 文本，含 `{{embed:name url}}` 标记）。 */
  value: string;
  onChange: (next: string) => void;
  /** 选区起始（缺省=文档末尾）。 */
  caret?: number;
  /** 选区结束（缺省=caret）。 */
  selectionEnd?: number;
  onCaretChange?: (nextCaret: number) => void;
  /** 当粘贴触发时通知外层（用于「已插入 1 张工单卡」toast）。 */
  onPasteProcessed?: (result: PasteResult) => void;
  /** 占位符（按 spec.md：勿写「30 秒 demo 故事线」之类营销腔）。 */
  placeholder?: string;
  /** 行数；缺省 12。 */
  rows?: number;
  /** 字段名（表单提交时使用）。 */
  name?: string;
  /** 测试替身：注入 onPaste 文本。生产由浏览器 onPaste 提供。 */
  onPasteText?: (text: string) => void;
  className?: string;
}

/**
 * 受控 Markdown 编辑器。纯函数 applyPaste 把粘贴文本「预转换」后再写入 doc；
 * React 只负责 textarea 状态同步。
 */
export function SOPEditor(props: SOPEditorProps): React.ReactElement {
  const {
    value,
    onChange,
    caret,
    selectionEnd,
    onCaretChange,
    onPasteProcessed,
    placeholder = '粘贴工单 / LIS / 校准 / 手册链接自动内嵌，或直接输入 Markdown…',
    rows = 12,
    name = 'sop',
    className,
  } = props;

  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [pendingPasteText, setPendingPasteText] = React.useState<string | null>(
    null
  );

  // 同步外层 caret → 本地 textarea（让 setSelectionRange 生效）
  React.useEffect(() => {
    if (caret === undefined || !taRef.current) return;
    const end = selectionEnd ?? caret;
    try {
      taRef.current.setSelectionRange(caret, end);
    } catch {
      // setSelectionRange 在某些 jsdom 场景下抛错；测试可忽略
    }
  }, [caret, selectionEnd]);

  // 注入待处理的 paste 文本（测试与程序化触发）
  React.useEffect(() => {
    if (pendingPasteText === null) return;
    const currentCaret = taRef.current?.selectionStart ?? value.length;
    const currentEnd = taRef.current?.selectionEnd ?? currentCaret;
    const result = applyPaste({
      currentDoc: value,
      pasteText: pendingPasteText,
      caret: currentCaret,
      selectionEnd: currentEnd,
    });
    onChange(result.nextDoc);
    onCaretChange?.(result.nextCaret);
    onPasteProcessed?.(result);
    setPendingPasteText(null);
  }, [pendingPasteText, value, onChange, onCaretChange, onPasteProcessed]);

  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData.getData('text');
      if (!text) return;
      // 阻止默认粘贴行为，由我们用 applyPaste「转换后」插入
      e.preventDefault();
      setPendingPasteText(text);
    },
    []
  );

  return React.createElement('textarea', {
    ref: taRef,
    name,
    className: `sop-editor${className ? ` ${className}` : ''}`,
    value,
    rows,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      onCaretChange?.(e.target.selectionStart);
    },
    onPaste: handlePaste,
    'data-testid': 'sop-editor',
  });
}

export default SOPEditor;
