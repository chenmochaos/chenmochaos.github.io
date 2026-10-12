const EMBED_RE = /!\[\[([^\]\n]+?)\]\]/g;
const WIKILINK_RE = /(?<!!)\[\[([^\]\n]+?)\]\]/g;
const CALLOUT_RE = /^(\s{0,3}>[ \t]?)\[!([A-Za-z-]+)\][+-]?[ \t]*(.*)$/;

/** 按代码围栏切分，代码段标记 isCode:true，后续不做任何替换。 */
export function splitByCodeFence(body) {
  const parts = [];
  let buffer = [];
  let fenceChar = null;
  let fenceLength = 0;

  const flush = (isCode) => {
    parts.push({ isCode, text: buffer.join('\n') });
    buffer = [];
  };

  for (const line of body.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);

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
 * 近似 github-slugger 的标题锚点算法。
 * 字符类里的两个区段用 \u 转义书写：plan 原文嵌了实际的 U+2000（EN QUAD）等不可见字符，
 * 任何会规整空白的编辑器或复制粘贴都可能把它悄悄吃掉，从而静默改变锚点行为。
 */
export function headingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s+/g, '-');
}

function stripCalloutMarkers(text) {
  const kept = [];
  for (const line of text.split('\n')) {
    const marker = line.match(CALLOUT_RE);
    if (!marker) {
      kept.push(line);
      continue;
    }
    const [, prefix, , title] = marker;
    if (title.trim() === '') continue; // 只有标记的行整行丢弃
    kept.push(`${prefix}**${title.trim()}**`);
  }
  return kept.join('\n');
}

function replaceEmbeds(text, ctx) {
  return text.replace(EMBED_RE, (full, inner) => {
    const target = inner.split('|')[0].split('#')[0].trim();
    const image = ctx.copyImage(target);
    if (!image) {
      ctx.warnings.push(`缺失附件 ![[${target}]] @ ${ctx.sourceRel}`);
      return full;
    }
    return `![${image.alt}](${image.url})`;
  });
}

function replaceWikilinks(text, ctx) {
  return text.replace(WIKILINK_RE, (full, inner) => {
    const pipeIndex = inner.indexOf('|');
    const alias = pipeIndex === -1 ? null : inner.slice(pipeIndex + 1).trim();
    let target = (pipeIndex === -1 ? inner : inner.slice(0, pipeIndex)).trim();

    const hashIndex = target.indexOf('#');
    const heading = hashIndex === -1 ? null : target.slice(hashIndex + 1).trim();
    if (hashIndex !== -1) target = target.slice(0, hashIndex).trim();

    const caretIndex = target.indexOf('^');
    if (caretIndex !== -1) target = target.slice(0, caretIndex).trim();

    const resolved = ctx.resolveLink(target);
    if (!resolved) {
      ctx.warnings.push(`未解析内链 [[${target}]] @ ${ctx.sourceRel}`);
      return alias ?? target.split('/').pop();
    }

    const label = alias ?? resolved.title ?? target;
    const anchor = heading ? `#${headingAnchor(heading)}` : '';
    return `[${label}](${ctx.urlPrefix}/${resolved.slug}${anchor})`;
  });
}

/**
 * 正文转换主入口。
 * ctx: { urlPrefix, sourceRel, warnings, copyImage(target) -> {url, alt}|null, resolveLink(target) -> {slug, title}|null }
 * 图片缺失与内链未解析的警告由本模块写入 ctx.warnings，同步层负责汇总。
 * 本函数是纯文本变换：不读文件、不写文件、不拷贝（拷贝由 ctx.copyImage 的实现委托给调用方）。
 */
export function transformBody(body, ctx) {
  return splitByCodeFence(body)
    .map((part) => {
      if (part.isCode) return part.text;
      const withCallouts = stripCalloutMarkers(part.text);
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

/** 检出本次不转换的 Obsidian 语法，供同步层列入报告。代码块内的同类字符不算。 */
export function detectUnsupportedSyntax(body, sourceRel) {
  const warnings = [];
  for (const part of splitByCodeFence(body)) {
    if (part.isCode) continue;
    for (const { re, label } of UNSUPPORTED_PATTERNS) {
      const match = part.text.match(re);
      if (match) warnings.push(`未转换语法 ${label}：「${match[0]}」 @ ${sourceRel}`);
    }
  }
  return warnings;
}
