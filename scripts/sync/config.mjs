import path from 'node:path';

/**
 * 相对路径一律相对 repoRoot 解析（见 makeConfig）。vaultDir 不参与解析：它指向 vault 而非仓库产物，
 * 必须是绝对路径，否则 walk 产出的 absPath 名不副实。
 *
 * repoRoot 取模块加载时的 process.cwd()：`pnpm sync` 从仓库根调起且中途不 chdir，两者等价；
 * 写成常量是为了让这份默认值本身可读、可被测试直接断言。
 */
export const DEFAULT_CONFIG = {
  repoRoot: process.cwd(),
  vaultDir: '/home/minus/Wiki',
  publishProperty: 'publish',
  contentDir: 'src/content/posts',
  imagesDir: 'public/images',
  manifestPath: '.sync-manifest.json',
  urlPrefix: '/posts',
  imageUrlPrefix: '/images',
  descriptionMaxChars: 120,
  // 开头四项已被 vault.mjs 的 dot 规则覆盖，列在这里只是把「不该同步的东西」写全，便于阅读；
  // 真正独立起作用的是 zz_Templates 与 node_modules。别删掉 dot 规则后以为这里还在兜底。
  excludeDirs: ['.obsidian', '.trash', '.claude', '.claudian', 'zz_Templates', 'node_modules'],
  imageExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'],
};

/**
 * 合并覆盖项并把相对路径解析成绝对路径。
 * 数组也复制一份：`{...DEFAULT_CONFIG}` 是浅拷贝，共享的数组被任何调用方 push 一次，
 * 就会同时污染 DEFAULT_CONFIG 与之后创建的每一个 config。
 */
export function makeConfig(overrides = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    excludeDirs: [...(overrides.excludeDirs ?? DEFAULT_CONFIG.excludeDirs)],
    imageExtensions: [...(overrides.imageExtensions ?? DEFAULT_CONFIG.imageExtensions)],
  };
  config.contentDirAbs = path.resolve(config.repoRoot, config.contentDir);
  config.imagesDirAbs = path.resolve(config.repoRoot, config.imagesDir);
  config.manifestAbs = path.resolve(config.repoRoot, config.manifestPath);
  return config;
}
