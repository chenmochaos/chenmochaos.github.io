import { slug } from 'github-slugger'; // 与 Astro 的标题 id 同一实现（rehype-collect-headings.js 用的就是这个库）
import { truncate } from './note.mjs';

const EMBED_RE = /!\[\[([^\]\n]+?)\]\]/g;
const WIKILINK_RE = /(?<!!)\[\[([^\]\n]+?)\]\]/g;
const CALLOUT_RE = /^(\s{0,3}>[ \t]?)\[!([A-Za-z-]+)\][+-]?[ \t]*(.*)$/;

/**
 * 按代码围栏切分，代码段标记 isCode:true，后续不做任何替换。
 *
 * 三处刻意的宽松与归一化，都为了堵住「绝不改写代码」这条绝对前提上的破口：
 * - 围栏允许任意缩进与块引用前缀。列表项里的代码块缩进 4 空格以上、callout 里的代码块每行带 `> `，
 *   按 CommonMark 两种解释下内容都是代码，但 `^ {0,3}` 一个都认不出，只能靠行内代码**碰巧**配对
 *   挡住替换——代码里一旦含反引号就漏。收紧的代价是「少转换几个链接」，漏认的代价是「改写代码」，
 *   两者不对称，一律往多认的方向偏。
 * - 空 buffer 不产生分段。否则相邻围栏之间会凭空多出一个空段，join 后就是输入里没有的空行。
 * - 输入先做 CRLF→LF 归一化（本模块唯一的归一化点）：围栏标记行与 callout 行都按 '\n' 切分并用
 *   `$` 收尾，行尾的 \r 会让它们整行都匹配不上，于是围栏失效、callout 全篇静默不转换。
 *
 * 已知限制：整行是 callout 标记的跨行行内代码片段仍会被 convertCallouts 改写——先切行内代码会破坏
 * callout 的整行判定，两害相权取其轻。
 */
export function splitByCodeFence(body) {
  const parts = [];
  let buffer = [];
  let fenceChar = null;
  let fenceLength = 0;

  const flush = (isCode) => {
    if (buffer.length === 0) return; // 空段只会在 join 时凭空插入一个换行
    parts.push({ isCode, text: buffer.join('\n') });
    buffer = [];
  };

  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const marker = line.match(/^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/);

    if (fenceChar === null) {
      if (marker) {
        flush(false);
        fenceChar = marker[1][0];
        fenceLength = marker[1].length;
      }
      buffer.push(line);
    } else {
      buffer.push(line);
      const closes =
        marker && marker[1][0] === fenceChar && marker[1].length >= fenceLength && marker[2].trim() === '';
      if (closes) {
        flush(true);
        fenceChar = null;
        fenceLength = 0;
      }
    }
  }

  flush(fenceChar !== null); // 未闭合的围栏之后全按代码处理
  return parts;
}

/** 按行内代码切分，奇数下标是代码片段（含反引号本身）。 */
export function splitInlineCode(text) {
  return text.split(/(`+[^`]*`+)/g).map((piece, index) => ({
    isCode: index % 2 === 1,
    text: piece,
  }));
}

/**
 * 标题锚点。直接用 Astro 用的同一个库，不再手写近似：手写版会把中文标点与 ★ 之类的符号留在锚点里，
 * 而 Astro 产物 id 会把它们剔除，`[[笔记#2.3 信道极限容量 ★★ 计算重点]]` 于是指向一个不存在的锚点，
 * 点击后静默停在页首。除同名标题外（Obsidian 的锚点语法本就无法区分重名），与产物 id 完全一致。
 */
export function headingAnchor(heading) {
  return slug(heading);
}

function convertCallouts(text) {
  const lines = [];
  for (const line of text.split('\n')) {
    const marker = line.match(CALLOUT_RE);
    if (!marker) {
      lines.push(line);
      continue;
    }
    const [, prefix, , title] = marker;
    if (title.trim() === '') continue; // 只有标记的行整行丢弃
    lines.push(`${prefix}**${title.trim()}**`);
  }
  return lines.join('\n');
}

/**
 * 按第一个竖线拆分。竖线前允许有一个反斜杠：Obsidian 在表格里写内链时会自动转义成 `[[笔记\|别名]]`，
 * 只找 '|' 会把目标读成「笔记\」，而表格里的内链用户没法不这样写。
 */
function splitOnPipe(inner) {
  const match = inner.match(/\\?\|/);
  if (!match) return { head: inner, tail: null };
  return { head: inner.slice(0, match.index), tail: inner.slice(match.index + match[0].length) };
}

function replaceEmbeds(text, ctx) {
  return text.replace(EMBED_RE, (full, inner) => {
    const { head } = splitOnPipe(inner);
    const target = head.split('#')[0].trim();
    const image = ctx.copyImage(target);

    if (image && image.url) return `![${image.alt}](${image.url})`;
    if (image && image.unsupported) {
      // 文件确实存在，只是不是能内联的图片类型——不能报「缺失」，那会让用户去查一个没丢的文件
      ctx.warnings.push(`不支持的附件 ${full} @ ${ctx.sourceRel}`);
      return full;
    }

    // 不是附件：笔记嵌入（![[笔记]] / ![[笔记#小节]]）在博客里没有内联展开的形态，降级为普通链接，
    // 比留下字面量 ![[...]] 或谎报「缺失附件」都更接近用户意图。
    const note = ctx.resolveLink(target);
    if (note) {
      const hashIndex = head.indexOf('#');
      const heading = hashIndex === -1 ? null : head.slice(hashIndex + 1).trim();
      const anchor = heading ? `#${headingAnchor(heading)}` : '';
      ctx.warnings.push(`笔记嵌入不支持，已降级为链接 ${full} @ ${ctx.sourceRel}`);
      return `[${note.title || target}](${ctx.urlPrefix}/${note.slug}${anchor})`;
    }

    ctx.warnings.push(`无法解析嵌入引用 ${full} @ ${ctx.sourceRel}`);
    return full;
  });
}

function replaceWikilinks(text, ctx) {
  return text.replace(WIKILINK_RE, (full, inner) => {
    const { head, tail } = splitOnPipe(inner);
    const alias = tail === null ? null : tail.trim();
    let target = head.trim();

    const hashIndex = target.indexOf('#');
    const heading = hashIndex === -1 ? null : target.slice(hashIndex + 1).trim();
    if (hashIndex !== -1) target = target.slice(0, hashIndex).trim();

    const caretIndex = target.indexOf('^');
    if (caretIndex !== -1) target = target.slice(0, caretIndex).trim();

    // [[#小节]] 是 Obsidian 的「本笔记标题」链接。本笔记的 slug 不在 ctx 里，
    // 但页内锚点 id 就是 headingAnchor(heading)，不必知道 slug 也能写对。
    if (target === '' && heading !== null) {
      return `[${alias || heading}](#${headingAnchor(heading)})`;
    }

    const resolved = ctx.resolveLink(target);
    if (!resolved) {
      ctx.warnings.push(`未解析内链 ${full} @ ${ctx.sourceRel}`);
      // 标签为空时不能产出 []()：渲染上既点不到、也看不出内容丢了。退回原文。
      const label = alias || target.split('/').pop();
      return label === '' ? full : label;
    }

    // 用 || 不用 ??：空字符串不是 nullish，`[[笔记|]]` 会产出渲染上不可见的空链接
    const label = alias || resolved.title || target;
    const anchor = heading ? `#${headingAnchor(heading)}` : '';
    return `[${label}](${ctx.urlPrefix}/${resolved.slug}${anchor})`;
  });
}

/**
 * 正文转换主入口。
 * ctx: { urlPrefix, sourceRel, warnings,
 *        copyImage(target) -> {url, alt} | {unsupported: true} | null,
 *        resolveLink(target) -> {slug, title}|null }
 * 三态契约的分工：「找不到」与「找到但不支持」必须可区分，否则报告会对一个真实存在的文件报「缺失」。
 * 附件与内链的全部警告由本模块写入 ctx.warnings（resolver 只解析、不发声），同步层负责汇总与去重。
 * 本函数是纯文本变换：不读文件、不写文件、不拷贝（拷贝由 ctx.copyImage 的实现委托给调用方）。
 * 输出为 LF 换行：输入的 CRLF 在切分时已归一化。
 */
export function transformBody(body, ctx) {
  return splitByCodeFence(body)
    .map((part) => {
      if (part.isCode) return part.text;
      const withCallouts = convertCallouts(part.text);
      return splitInlineCode(withCallouts)
        .map((piece) => (piece.isCode ? piece.text : replaceWikilinks(replaceEmbeds(piece.text, ctx), ctx)))
        .join('');
    })
    .join('\n');
}

const UNSUPPORTED_PATTERNS = [
  { re: /%%[^%]*%%/, label: '%%注释%%' },
  { re: /==[^=]+==/, label: '==高亮==' },
];

/**
 * 检出本次不转换的 Obsidian 语法，供同步层列入报告。代码块内的同类字符不算。
 * 命中内容截断到 40 字：一个忘了闭合的 `==` 会把其后整段正文吞进警告，报告要给人读。
 */
export function detectUnsupportedSyntax(body, sourceRel) {
  const warnings = [];
  for (const part of splitByCodeFence(body)) {
    if (part.isCode) continue;
    for (const { re, label } of UNSUPPORTED_PATTERNS) {
      const match = part.text.match(re);
      if (match) warnings.push(`未转换语法 ${label}：「${truncate(match[0], 40)}」 @ ${sourceRel}`);
    }
  }
  return warnings;
}
