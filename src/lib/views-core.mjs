/**
 * 浏览量的纯逻辑：校验 slug、拼请求地址、解析返回、格式化数字、判断本会话是否已计过。
 *
 * 不碰 DOM、不碰 sessionStorage —— storage 由调用方注入，测试里传一个假对象即可。
 * 测试跑 `node --test`，浏览器侧胶水在 views-view.js。
 */

/** slug 就是文章 id（文件名），只允许小写字母、数字和短横线 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

/** GET /rest/v1/post_views?slug=eq.<slug>&select=views —— 只读，不计数 */
export function readUrl(baseUrl, slug) {
  const url = new URL('/rest/v1/post_views', baseUrl);
  url.searchParams.set('slug', `eq.${slug}`);
  url.searchParams.set('select', 'views');
  return url.toString();
}

/** POST /rest/v1/rpc/increment_view —— 计数并返回新值 */
export function bumpUrl(baseUrl) {
  return new URL('/rest/v1/rpc/increment_view', baseUrl).toString();
}

export function bumpBody(slug) {
  return JSON.stringify({ p_slug: slug });
}

/**
 * PostgREST 的两种返回形状：
 *   RPC increment_view → 数字（bigint 也可能被序列化成字符串）
 *   GET post_views     → [{ views: 12 }]，没有记录时是 []
 *
 * 取不出合法的非负整数就返回 null，调用方保持不显示。
 */
export function parseCount(payload) {
  const raw = Array.isArray(payload) ? payload[0]?.views : payload;
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function formatViews(n) {
  return Number.isInteger(n) && n >= 0 ? n.toLocaleString('en-US') : null;
}

const storageKey = (slug) => `viewed:${slug}`;

/** storage 在隐私模式下可能直接抛错 —— 抛了就当没计过 */
export function hasCounted(storage, slug) {
  try {
    return storage?.getItem(storageKey(slug)) === '1';
  } catch {
    return false;
  }
}

/** 写不进去也不影响本次计数，只是下次刷新会多算一次 */
export function markCounted(storage, slug) {
  try {
    storage?.setItem(storageKey(slug), '1');
  } catch {
    /* 隐私模式 / 配额满：放弃去重，不报错 */
  }
}
