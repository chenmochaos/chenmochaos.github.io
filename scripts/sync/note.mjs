import { createHash } from 'node:crypto';
import { load } from 'js-yaml'; // js-yaml v5 的 ESM 产物没有 default export，只能用具名导入

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const SKIP_LINE_PATTERNS = [
  /^#{1,6}\s/, // 标题
  /^!\[/, // 图片
  /^>/, // 引用与 callout
  /^[-*+]\s/, // 无序列表
  /^\d+\.\s/, // 有序列表
  /^\|/, // 表格
  /^-{3,}\s*$/, // 分隔线
];

/**
 * 代码围栏行。围栏必须成对跟踪，光把围栏标记行放进 SKIP_LINE_PATTERNS 是不够的：
 * 标记行被跳过了，围栏**内容**却会被当成正文抽出来当摘要。
 * 只认反引号围栏——实测 vault 中 `~~~` 围栏 0 处；transform 模块另需识别 `~~~`，
 * 那是为了防止改写围栏内的内容，风险不同，不在此处照搬。
 */
const FENCE_RE = /^`{3,}/;

/** 拆出 YAML frontmatter 与正文。解析失败不抛异常，通过 error 字段上报。 */
export function parseNote(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: raw, error: null };

  const body = raw.slice(match[0].length);
  let parsed;
  try {
    parsed = load(match[1]);
  } catch (error) {
    return { data: {}, body: raw, error: `frontmatter YAML 解析失败：${error.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: {}, body, error: null };
  }
  return { data: parsed, body, error: null };
}

const pad = (n) => String(n).padStart(2, '0');

/** 归一化为 YYYY-MM-DD，取本地日期分量以避免时区把日期挪走。 */
export function formatDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) return null;
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const parsed = new Date(trimmed.replace(' ', 'T'));
  if (Number.isNaN(parsed.valueOf())) return null;
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

/** 优先级：pubDate > date > 源文件 mtime。 */
export function normalizePubDate(data, mtime) {
  return formatDate(data.pubDate) ?? formatDate(data.date) ?? formatDate(mtime);
}

/** 去掉 wiki 链接、Markdown 链接与强调标记，只留可读文本。 */
export function stripInlineMarkup(text) {
  return text
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 正文第一个普通段落，跳过标题/图片/引用/列表/代码/表格。 */
export function firstParagraph(body) {
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // 未闭合的围栏：其后内容一律按代码处理
    if (line === '') continue;
    if (SKIP_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    const text = stripInlineMarkup(line);
    if (text !== '') return text;
  }
  return '';
}

export function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** 摘要优先级：description > excerpt > 正文首段；都取不到返回 undefined（调用方省略该字段）。 */
export function pickDescription(data, body, maxChars = 120) {
  for (const candidate of [data.description, data.excerpt]) {
    if (typeof candidate !== 'string') continue;
    const text = stripInlineMarkup(candidate);
    if (text !== '') return truncate(text, maxChars);
  }
  const fallback = firstParagraph(body);
  return fallback === '' ? undefined : truncate(fallback, maxChars);
}

export function hashText(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** YAML 双引号字符串，转义反斜杠与双引号。 */
function yamlString(value) {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** 组装最终写盘的 .md 文本。 */
export function buildOutput({ frontmatter, body }) {
  const lines = ['---', `title: ${yamlString(frontmatter.title)}`, `slug: ${yamlString(frontmatter.slug)}`];
  if (frontmatter.description !== undefined) {
    lines.push(`description: ${yamlString(frontmatter.description)}`);
  }
  lines.push(`pubDate: ${frontmatter.pubDate}`);
  lines.push(`tags: [${frontmatter.tags.map(yamlString).join(', ')}]`);
  lines.push('draft: false', `syncedFrom: ${yamlString(frontmatter.syncedFrom)}`, '---', '');
  // lines 末尾的 '' 只保证 '---' 后面有一个换行；frontmatter 与正文之间还需要一个空行，
  // 所以这里显式再补一个 '\n'，否则得到的是 '---\n正文' 而不是 '---\n\n正文'。
  return `${lines.join('\n')}\n${body.replace(/^\n+/, '')}`;
}
