/*!
Reused from wangsen2020/x-article-exporter md2html.js. Adapted only for ESM and safe URL schemes.
MIT License

Copyright (c) 2026 wangsen2020

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
/*!
 * X Article Exporter — Markdown → HTML（共享）
 *
 * X 的长文编辑器（compose.js）要用：它底层是 Draft.js，而 Draft 唯一对外开放
 * 的富文本入口是 paste —— 它的 editOnPaste 读 clipboardData 里的 text/html，
 * 用自己的转换器解析成块。
 * 所以这里只干一件事：把 Markdown 变成一份「Draft 认得的 HTML」。
 *
 * 产出刻意只用最朴素的标签（h1-h3 / p / ul / ol / li / blockquote / pre>code /
 * strong / em / del / code / a），因为两家编辑器的 blockRenderMap 只认这些。
 * 放不进去的（表格、脚注、HTML 块）一律降级成普通段落，宁可朴素也不要丢字。
 */
export function createArticleMarkdown() {
  'use strict';

  // ---------- Markdown → HTML ----------
  //
  // 目标不是「完整的 Markdown」，是「X 长文放得下的那部分」。X 的块级词汇就这些：
  // unstyled / header-one~three / blockquote / ordered-list-item /
  // unordered-list-item / code-block（见正文里的 longform-* class）。
  // 放不进去的（表格、脚注、HTML 块）一律降级成普通段落，宁可朴素也不要丢字。

  // 占位符用私用区码点：正文里不可能出现，不会被用户内容撞上
  const SENT = String.fromCharCode(0xe000);
  const SENT_RE = new RegExp(SENT + '(\\d+)' + SENT, 'g');

  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 注意：两个参数都来自 inline() 里已经转义过的文本，这里不能再 esc 一次，
  // 否则 ?a=1&b=2 会变成 &amp;amp; ——链接点开就是 404。
  const link = (href, text) => /^(?:https?:|mailto:)/i.test(href) ? '<a href="' + href.replace(/["<>]/g, '') + '">' + text + '</a>' : text;

  // 行内标记。顺序有讲究：先把代码片段挖走占位，免得 `**` 这种在代码里被当成粗体。
  function inline(s) {
    const codes = [];
    let out = esc(s).replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return SENT + (codes.length - 1) + SENT;
    });

    // 图片：X 的图必须走它自己的上传，外链 <img> 粘不进去，降级成链接保住地址
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, a, u) => link(u, a || u));
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, a, u) => link(u, a));
    // 裸链接（不碰已经在 href="..." 里的）
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, p, u) => p + link(u, u));

    out = out
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    return out.replace(SENT_RE, (m, i) => '<code>' + esc(codes[+i]) + '</code>');
  }

  // 列表的嵌套写法有讲究。Draft 的 HTML 解析器只认「子列表是父列表的兄弟」这一种：
  //   <ul><li>B</li><ul><li>B1</li></ul></ul>   → B1 落在 depth 1 ✓
  //   <ul><li>B<ul><li>B1</li></ul></li></ul>   → 整个塌成一块 "BB1" ✗
  // 所以 li 一律闭合，子列表开在 li 之间。（实测 Draft 0.11.7）
  function emitList(items) {
    let out = '';
    const stack = [];
    for (const it of items) {
      while (stack.length && it.depth < stack[stack.length - 1].depth) out += '</' + stack.pop().tag + '>';
      const top = stack[stack.length - 1];
      if (!top || it.depth > top.depth) {
        out += '<' + it.tag + '>';
        stack.push({ tag: it.tag, depth: it.depth });
      } else if (top.tag !== it.tag) {
        out += '</' + stack.pop().tag + '>' + '<' + it.tag + '>';
        stack.push({ tag: it.tag, depth: it.depth });
      }
      out += '<li>' + it.html + '</li>';
    }
    while (stack.length) out += '</' + stack.pop().tag + '>';
    return out;
  }

  function mdToHtml(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let quote = [];
    let list = [];

    const flushPara = () => {
      if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    };
    const flushQuote = () => {
      if (quote.length) out.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>');
      quote = [];
    };
    const closeLists = () => {
      if (list.length) out.push(emitList(list));
      list = [];
    };
    const flushAll = () => {
      flushPara();
      flushQuote();
      closeLists();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\t/g, '    ');

      // 围栏代码块：整段原样收走，里面什么都不解析
      const fence = line.match(/^\s*(```+|~~~+)(.*)$/);
      if (fence) {
        flushAll();
        const mark = fence[1][0].repeat(3);
        const buf = [];
        for (i++; i < lines.length; i++) {
          if (new RegExp('^\\s*' + mark).test(lines[i])) break;
          buf.push(lines[i]);
        }
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      if (!line.trim()) {
        flushAll();
        continue;
      }

      // 分隔线：X 没有 divider 块，用一行居中符号顶替，保住视觉分段
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
        flushAll();
        out.push('<p>— — —</p>');
        continue;
      }

      const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) {
        flushAll();
        // X 只有三级标题，再深的一律压到 h3
        const lv = Math.min(h[1].length, 3);
        out.push('<h' + lv + '>' + inline(h[2].trim()) + '</h' + lv + '>');
        continue;
      }

      const q = line.match(/^\s*>\s?(.*)$/);
      if (q) {
        flushPara();
        closeLists();
        quote.push(q[1]);
        continue;
      }
      flushQuote();

      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flushPara();
        list.push({ depth: li[1].length, tag: /^\d/.test(li[2]) ? 'ol' : 'ul', html: inline(li[3]) });
        continue;
      }

      // 列表项的续行（缩进的普通文本）并进上一个 li
      if (list.length && /^\s{2,}/.test(line)) {
        list[list.length - 1].html += ' ' + inline(line.trim());
        continue;
      }
      closeLists();

      // setext 标题：下一行全是 === 或 ---
      const next = lines[i + 1];
      if (next && /^\s*=+\s*$/.test(next)) {
        flushPara();
        out.push('<h1>' + inline(line.trim()) + '</h1>');
        i++;
        continue;
      }
      if (next && /^\s*-{2,}\s*$/.test(next) && line.trim()) {
        flushPara();
        out.push('<h2>' + inline(line.trim()) + '</h2>');
        i++;
        continue;
      }

      // 表格行：X 没有表格，拆成「单元格 | 单元格」的普通段落，别丢内容
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // 分隔行直接丢
        flushPara();
        out.push('<p>' + inline(line.replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ' | ')) + '</p>');
        continue;
      }

      para.push(line.trim());
    }
    flushAll();
    return out.join('');
  }

  // 「这篇看起来像 Markdown 吗」。行首的块标记，或者行内的强调 / 代码 / 链接语法，
  // 有一个算一个。
  const HAS_MD = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\(/m;

  // 纯文本兜底：编辑器万一只收 text/plain，至少字还在
  const stripMd = (src) =>
    String(src)
      .replace(/^```.*$/gm, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/\*\*|__|~~|`/g, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 把代码区域挖成等长的空白。长度不变，所以在挖过的副本上算出来的下标，
  // 拿回原文照样对得上。
  const maskCode = (md) =>
    md
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^`])(`[^`\n]*`)/g, (m, p, c) => p + c.replace(/[^\n]/g, ' '));

  // 扫出正文里**真正**的图片，返回 [{index, len, alt, url}]。
  //
  // 为什么不直接拿 imgRe 去 exec 原文：讲 Markdown 的文章会把 ![](…) 写在反引号或
  // ``` 围栏里当**例子**，那不是图片。照着改会把人家正文改烂——实测踩过：一篇讲这个
  // 功能的文章，三处示例全被换成了「图1：01-xxx.png」这样的文字，句子当场读不通。
  // 所以先挖掉代码区再找，位置从副本上取，内容回原文取。
  const imgScan = (md) => {
    const masked = maskCode(String(md || ''));
    const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
    const out = [];
    let m;
    while ((m = re.exec(masked))) out.push({ index: m.index, len: m[0].length, alt: m[1], url: m[2] });
    return out;
  };

  return {
    toHtml: mdToHtml,
    strip: stripMd,
    hasMd: (s) => HAS_MD.test(String(s || '')),
    // 图片语法。分段插图时要按它切开 Markdown，所以一并导出，免得两处各写一遍。
    // 注意：**别直接拿它 exec 正文**，代码块里的例子会被误判，走 imgScan。
    imgRe: () => /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,
    imgScan: imgScan,
  };
}

export const articleMarkdown = createArticleMarkdown();
