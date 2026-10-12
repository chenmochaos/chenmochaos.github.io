const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 由文件名推导 slug：小写、空白与下划线转短横线、剔除 ASCII 外字符、折叠并裁掉首尾短横线。
 * 纯中文文件名会得到空串，由调用方报错要求显式填写 slug。
 */
export function slugFromFilename(basename) {
  return basename
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 解析一篇笔记最终使用的 slug。note: { slugProperty, basename }
 * 返回 { slug, error }，两者必有其一为 null。
 */
export function resolveSlug({ slugProperty, basename }) {
  const explicit =
    slugProperty === undefined || slugProperty === null ? '' : String(slugProperty).trim();

  if (explicit !== '') {
    if (!SLUG_RE.test(explicit)) {
      return {
        slug: null,
        error: `slug 属性格式非法：「${explicit}」，只允许小写字母、数字与短横线`,
      };
    }
    return { slug: explicit, error: null };
  }

  const derived = slugFromFilename(basename);
  if (derived.length < 2) {
    return {
      slug: null,
      error: `文件名「${basename}」无法生成 slug（含非 ASCII 字符），请在笔记属性里填写 slug`,
    };
  }
  return { slug: derived, error: null };
}
