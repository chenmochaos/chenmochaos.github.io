/**
 * 知识图谱的数据构建。
 *
 * 输入是 Astro content collection 的条目（已包含 frontmatter 与原始正文），输出是一份
 * 可以直接内嵌到页面的 JSON。纯函数、不碰文件系统，测试跑 `node --test`。
 *
 * 节点：
 *   post:<id>  已发布文章（created 取 pubDate，供打开动画排序）
 *   tag:<key>  标签，key 小写归一化（created 取最早使用它的文章）
 *
 * 边（无向、去重）：
 *   link  正文里指向 /posts/<id> 的链接
 *   tag   文章 frontmatter 的 tags
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;

// Markdown 内联链接：[label](/posts/foo "title") 或 [label](</posts/foo>)。只取目标，标题可选。
const MD_LINK_RE = /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

// MDX 里也可能直接写 <a href="/posts/foo">。
const HTML_HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

const POST_PATH_RE = /^\/posts\/([^/?#]+)\/?$/;

/** 去掉围栏代码与行内代码，避免代码示例里的链接被当成真实内链。 */
export function stripCode(body) {
  return String(body ?? '')
    .replace(FENCE_RE, '')
    .replace(INLINE_CODE_RE, '');
}

/** 抓出正文里所有可能是站内文章链接的 href。 */
export function extractHrefs(body) {
  const hrefs = [];
  for (const match of String(body ?? '').matchAll(MD_LINK_RE)) {
    hrefs.push(match[1] ?? match[2]);
  }
  for (const match of String(body ?? '').matchAll(HTML_HREF_RE)) {
    hrefs.push(match[1] ?? match[2]);
  }
  return hrefs;
}

/**
 * 把 href 归一化成文章 id。只接受相对路径 /posts/<id>，或与 siteOrigin 同源的绝对地址。
 * 查询串、锚点、尾斜杠都剥掉。
 */
export function normalizePostHref(href, siteOrigin = '') {
  if (!href) return null;
  let value = String(href).trim();
  const origin = String(siteOrigin ?? '').replace(/\/+$/, '');
  if (origin && (value === origin || value.startsWith(origin + '/'))) {
    value = value.slice(origin.length) || '/';
  }
  value = value.split('#')[0].split('?')[0];
  const match = value.match(POST_PATH_RE);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * 标签归一化：去空白、去前导 #、大小写不敏感去重，保留首次出现的写法用于展示。
 */
export function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const label = raw.trim().replace(/^#+/, '').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push({ key, label });
  }
  return tags;
}

/**
 * 把 frontmatter / content collection 里的时间转成 epoch ms。无法解析时返回 0，
 * 动画会把这些节点排在最前面。
 */
function toEpoch(value) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * @param {Array<{id: string, body?: string|null, data?: {title?: string|null, tags?: string[]|null, draft?: boolean|null, pubDate?: Date|string|null}}>} posts
 * @param {{siteOrigin?: string}} [options]
 * @returns {{nodes: Array<object>, edges: Array<object>, stats: {posts: number, tags: number, links: number}}}
 */
export function buildGraph(posts, options = {}) {
  const siteOrigin = options.siteOrigin ?? '';
  const visible = (Array.isArray(posts) ? posts : [])
    .filter((post) => post && !post.data?.draft)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const postIds = new Set(visible.map((post) => post.id));
  const edges = [];
  const edgeKeys = new Set();
  const tags = new Map();
  const createdByKey = new Map();

  const addEdge = (source, target, type) => {
    const [a, b] = [source, target].sort();
    const key = `${type}:${a}--${b}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ key, source: a, target: b, type });
  };

  for (const post of visible) {
    const postKey = `post:${post.id}`;
    createdByKey.set(postKey, toEpoch(post.data?.pubDate));

    for (const tag of normalizeTags(post.data?.tags)) {
      const tagKey = `tag:${tag.key}`;
      if (!tags.has(tag.key)) {
        tags.set(tag.key, {
          key: tagKey,
          type: 'tag',
          label: `#${tag.label}`,
          // 标签不是独立创建的东西：它跟着最早使用它的文章一起出现。
          created: createdByKey.get(postKey),
        });
      } else {
        const known = tags.get(tag.key).created;
        const mine = createdByKey.get(postKey);
        if (mine && (!known || mine < known)) tags.get(tag.key).created = mine;
      }
      addEdge(postKey, tagKey, 'tag');
    }

    const body = stripCode(post.body);
    for (const href of extractHrefs(body)) {
      const targetId = normalizePostHref(href, siteOrigin);
      if (!targetId || targetId === post.id || !postIds.has(targetId)) continue;
      addEdge(postKey, `post:${targetId}`, 'link');
    }
  }

  const nodes = visible.map((post) => ({
    key: `post:${post.id}`,
    type: 'post',
    label: post.data?.title?.trim() || post.id,
    url: `/posts/${post.id}`,
    degree: 0,
    created: createdByKey.get(`post:${post.id}`) ?? 0,
  }));
  for (const tag of tags.values()) {
    nodes.push({ ...tag, degree: 0, created: tag.created ?? 0 });
  }

  const byKey = new Map(nodes.map((node) => [node.key, node]));
  for (const edge of edges) {
    byKey.get(edge.source).degree += 1;
    byKey.get(edge.target).degree += 1;
  }

  nodes.sort((a, b) => a.key.localeCompare(b.key));
  edges.sort((a, b) => a.key.localeCompare(b.key));

  return {
    nodes,
    edges,
    stats: {
      posts: visible.length,
      tags: tags.size,
      links: edges.filter((edge) => edge.type === 'link').length,
    },
  };
}
