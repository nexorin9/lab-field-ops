// src/shared/embeds/fallback.tsx
// 未匹配 URL 的兜底渲染：保留原文 URL（点击跳转）+ 截图占位。
//
// 触发场景：SOP 编辑器粘贴的 URL 没有命中任何 EmbedDescriptor（私有工单站 / 厂商登录页 /
// 任意 https 链接）。spec.md「工作闭环验收故事」第 2 条要求：
//   非匹配 URL 不报错，保留原文 + 占位。
//
// 走 outline `EmbedDescriptor.embed`（generic iframe）的等价思路，但不渲染 iframe，
// 因为未受信任的 URL 自动嵌入 iframe 是 SSRF + clickjacking 的双重风险。
//
// 字段命名锁定（tests/contracts.test.ts 见 Task 24）：
//   data-fallback="true"
//   data-embed-name="<name or '*'>"
//   data-screenshot-placeholder="true"

import * as React from 'react';

export interface FallbackProps {
  url: string;
  /** 标记用的描述子名；缺省 '*'（未注册）。 */
  name?: string;
  /** 显示在链接前的简短说明，默认「原文链接」。 */
  label?: string;
}

/**
 * 直接返回叶子 <div> 而非包装组件，便于测试断言 data-* 属性；
 * 同时 React 树里也能正常用作 child。
 */
export function renderEmbedFallback(
  url: string,
  name?: string,
  label?: string
): React.ReactElement {
  return React.createElement(
    'div',
    {
      className: 'embed-fallback',
      'data-fallback': 'true',
      'data-embed-name': name ?? '*',
      'data-screenshot-placeholder': 'true',
    },
    [
      React.createElement(
        'a',
        {
          key: 'link',
          href: url,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'embed-fallback__link',
        },
        `${label ?? '原文链接'}：${url}`
      ),
      React.createElement(
        'div',
        {
          key: 'placeholder',
          className: 'screenshot-placeholder',
          role: 'img',
          'aria-label': `${url} 截图占位`,
        },
        '截图占位（等待卡片加载或人工贴图）'
      ),
    ]
  );
}

/** FallbackEmbed：与 renderEmbedFallback 等价的命名组件形式。 */
export function FallbackEmbed(props: FallbackProps): React.ReactElement {
  return renderEmbedFallback(props.url, props.name, props.label);
}

export default FallbackEmbed;
