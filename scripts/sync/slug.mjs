const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 判断一个值是否是本工具认可的 slug 形态。
 * 给「读回来的数据」用：manifest 是用户可见的手写文件，里面的键不能直接拿去拼路径——
 * `..`、`a/../../../docs` 经 path.join 归一化后足以跳出目标目录。非字符串一律不算。
 */
export function isValidSlug(value) {
  return typeof value === 'string' && SLUG_RE.test(value);
}

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
 * slugProperty 只接受字符串：Obsidian 属性面板允许布尔/数字/列表类型，
 * YAML 里裸写 `slug: true` 会解析成布尔 true，若放行就会把文章发到 /posts/true。
 */
export function resolveSlug({ slugProperty, basename }) {
  if (slugProperty !== undefined && slugProperty !== null && typeof slugProperty !== 'string') {
    const kind = Array.isArray(slugProperty) ? '列表' : typeof slugProperty;
    return { slug: null, error: `slug 属性格式非法：必须是字符串，当前是 ${kind}` };
  }

  const explicit = slugProperty === undefined || slugProperty === null ? '' : slugProperty.trim();

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
