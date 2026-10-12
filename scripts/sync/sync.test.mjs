import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeConfig } from './config.mjs';
import { planSync, runSync, formatReport } from './sync.mjs';
import { main } from '../sync-obsidian.mjs';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * 建一个临时 repo + 临时 vault。
 * vaultFiles: 相对 vault 的路径 -> 内容（字符串按 utf8 写，Buffer 直接写）
 */
function makeFixture(vaultFiles = {}, repoFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-sync-'));
  const vaultDir = path.join(root, 'vault');
  const repoRoot = path.join(root, 'repo');

  for (const [relative, content] of Object.entries(vaultFiles)) {
    const abs = path.join(vaultDir, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  for (const [relative, content] of Object.entries(repoFiles)) {
    const abs = path.join(repoRoot, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  fs.mkdirSync(path.join(repoRoot, 'src/content/posts'), { recursive: true });

  return { root, config: makeConfig({ repoRoot, vaultDir }), repoRoot };
}

const postFile = (relative) => path.join('src/content/posts', relative);
const readPost = (config, slug) => fs.readFileSync(path.join(config.contentDirAbs, `${slug}.md`), 'utf8');

test('首次同步生成 .md、拷贝图片并写入 manifest', () => {
  const { root, config, repoRoot } = makeFixture({
    'STX/AI/my-post.md': [
      '---',
      'publish: true',
      'title: 我的文章',
      'slug: my-post',
      'description: 一句话摘要',
      'pubDate: 2026-10-12',
      'tags: [ai, agent]',
      '---',
      '',
      '正文第一段。',
      '',
      '![[shot.png]]',
    ].join('\n'),
    'STX/zz_Attachments/shot.png': PNG,
  });

  const result = runSync(config);

  const content = readPost(config, 'my-post');
  assert.ok(content.includes('title: "我的文章"'));
  assert.ok(content.includes('slug: "my-post"'));
  assert.ok(content.includes('description: "一句话摘要"'));
  assert.ok(content.includes('pubDate: 2026-10-12'));
  assert.ok(content.includes('tags: ["ai", "agent"]'));
  assert.ok(content.includes('draft: false'));
  assert.ok(content.includes('syncedFrom: "STX/AI/my-post.md"'));
  assert.ok(content.includes('![shot](/images/my-post/shot.png)'));

  const imagePath = path.join(repoRoot, 'public/images/my-post/shot.png');
  assert.ok(fs.existsSync(imagePath));

  const manifest = JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8'));
  assert.equal(manifest.entries['my-post'].source, 'STX/AI/my-post.md');
  assert.equal(manifest.entries['my-post'].output, 'src/content/posts/my-post.md');
  assert.deepEqual(manifest.entries['my-post'].images, ['public/images/my-post/shot.png']);

  assert.equal(result.created.length, 1);
  assert.deepEqual(result.errors, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('内容未变时第二次同步不改写文件', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
  });

  runSync(config);
  const target = path.join(config.contentDirAbs, 'a.md');
  const firstMtime = fs.statSync(target).mtimeMs;

  const second = runSync(config);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.created.length + second.updated.length, 0);
  assert.ok(fs.statSync(target).mtimeMs <= firstMtime + 1000);
  fs.rmSync(root, { recursive: true, force: true });
});

test('取消 publish 后删除生成文件与图片目录', () => {
  const { root, config, repoRoot } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n![[p.png]]\n',
    'STX/p.png': PNG,
  });
  runSync(config);
  assert.ok(fs.existsSync(path.join(repoRoot, 'public/images/a/p.png')));

  fs.writeFileSync(
    path.join(config.vaultDir, 'STX/a.md'),
    '---\npublish: false\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n![[p.png]]\n',
    'utf8'
  );
  const result = runSync(config);

  assert.equal(result.deleted.length, 1);
  assert.ok(!fs.existsSync(path.join(config.contentDirAbs, 'a.md')));
  assert.ok(!fs.existsSync(path.join(repoRoot, 'public/images/a')));
  const manifest = JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8'));
  assert.deepEqual(manifest.entries, {});
  fs.rmSync(root, { recursive: true, force: true });
});

test('--dry 不写盘、不拷图、不建 manifest', () => {
  const { root, config, repoRoot } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n![[p.png]]\n',
    'STX/p.png': PNG,
  });

  const preview = runSync(config, { dryRun: true });

  assert.equal(preview.created.length, 1);
  assert.ok(!fs.existsSync(path.join(config.contentDirAbs, 'a.md')));
  assert.ok(!fs.existsSync(path.join(repoRoot, 'public/images/a')));
  assert.ok(!fs.existsSync(config.manifestAbs));
  fs.rmSync(root, { recursive: true, force: true });
});

test('目标文件存在但不是生成文件时拒绝覆盖并报错', () => {
  const { root, config } = makeFixture(
    { 'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n新正文\n' },
    { [postFile('a.md')]: '---\ntitle: 手写\n---\n\n手写正文\n' }
  );

  const result = runSync(config);

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /拒绝覆盖/);
  assert.equal(fs.readFileSync(path.join(config.contentDirAbs, 'a.md'), 'utf8'), '---\ntitle: 手写\n---\n\n手写正文\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('生成文件被手工改过时给出警告但仍以 vault 为准覆盖', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
  });
  runSync(config);
  fs.appendFileSync(path.join(config.contentDirAbs, 'a.md'), '\n手改的一行\n', 'utf8');

  const result = runSync(config);

  assert.ok(result.warnings.some((w) => /被手工改过/.test(w)));
  assert.ok(!readPost(config, 'a').includes('手改的一行'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('指向已发布笔记的内链变成超链接，未发布的降级为纯文本并警告', () => {
  const { root, config } = makeFixture({
    'STX/target.md': '---\npublish: true\nslug: target-post\ntitle: 目标\ndescription: 目标摘要\npubDate: 2026-01-01\n---\n\n目标正文\n',
    'STX/source.md': '---\npublish: true\nslug: source-post\ntitle: 来源\npubDate: 2026-01-02\n---\n\n见 [[target]] 和 [[private-note]]。\n',
  });

  const result = runSync(config);
  const content = readPost(config, 'source-post');

  assert.ok(content.includes('[目标](/posts/target-post)'));
  assert.ok(content.includes('见 [目标](/posts/target-post) 和 private-note。'));
  assert.ok(result.warnings.some((w) => /未解析内链 \[\[private-note\]\]/.test(w))); // 警告里带 [[ ]]（同 transform 的既有行为）
  fs.rmSync(root, { recursive: true, force: true });
});

test('纯中文文件名且无 slug 属性时报错跳过，不生成文件', () => {
  const { root, config } = makeFixture({
    'STX/中文标题.md': '---\npublish: true\ntitle: 中文标题\npubDate: 2026-01-01\n---\n\n正文\n',
  });

  const result = runSync(config);

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /填写 slug/);
  assert.deepEqual(fs.readdirSync(config.contentDirAbs), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('两篇笔记 slug 相同时全部跳过并报错', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: dup\ntitle: A\npubDate: 2026-01-01\n---\n\nA\n',
    'STX/b.md': '---\npublish: true\nslug: dup\ntitle: B\npubDate: 2026-01-02\n---\n\nB\n',
  });

  const result = runSync(config);

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /slug 冲突/);
  assert.deepEqual(fs.readdirSync(config.contentDirAbs), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('publish 属性缺失或非 true 的笔记被忽略', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: false\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\nA\n',
    'STX/b.md': '---\nslug: b\ntitle: B\npubDate: 2026-01-01\n---\n\nB\n',
    'STX/c.md': '---\npublish: yes\nslug: c\ntitle: C\npubDate: 2026-01-01\n---\n\nC\n',
  });

  const result = runSync(config);

  assert.deepEqual(fs.readdirSync(config.contentDirAbs), []);
  assert.deepEqual(result.created, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('planSync 零副作用：不落盘、不拷图', () => {
  const { root, config, repoRoot } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n![[p.png]]\n',
    'STX/p.png': PNG,
  });

  planSync(config);

  assert.deepEqual(fs.readdirSync(config.contentDirAbs), []);
  assert.ok(!fs.existsSync(path.join(repoRoot, 'public/images/a')));
  assert.ok(!fs.existsSync(config.manifestAbs));
  fs.rmSync(root, { recursive: true, force: true });
});

test('不再引用的旧图片被清理', () => {
  const { root, config, repoRoot } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n![[old.png]]\n',
    'STX/old.png': PNG,
  });
  runSync(config);
  const oldPath = path.join(repoRoot, 'public/images/a/old.png');
  assert.ok(fs.existsSync(oldPath));

  fs.writeFileSync(
    path.join(config.vaultDir, 'STX/a.md'),
    '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n不再引用图片\n',
    'utf8'
  );
  runSync(config);

  assert.ok(!fs.existsSync(oldPath));
  assert.ok(fs.existsSync(path.join(config.contentDirAbs, 'a.md')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('formatReport 汇总各状态并逐条列出问题', () => {
  const report = formatReport({
    dryRun: true,
    created: [{ slug: 'a', sourceRel: 'STX/a.md' }],
    updated: [{ slug: 'b', sourceRel: 'STX/b.md', images: 2 }],
    skipped: [{ slug: 'c', sourceRel: 'STX/c.md' }],
    deleted: [{ slug: 'd', sourceRel: 'STX/d.md' }],
    warnings: ['未解析内链 [[x]] @ STX/a.md'],
    errors: ['STX/e.md: 请在笔记属性里填写 slug'],
  });
  assert.match(report, /试运行/);
  assert.match(report, /新建\s+a\.md/);
  assert.match(report, /更新\s+b\.md\s+← STX\/b\.md\s+\(附件 2\)/);
  assert.match(report, /跳过\s+c\.md/);
  assert.match(report, /删除\s+d\.md/);
  assert.match(report, /未解析内链/);
  assert.match(report, /填写 slug/);
});

test('formatReport 折叠重复出现的同一条警告', () => {
  const report = formatReport({
    dryRun: false,
    created: [],
    updated: [],
    skipped: [],
    deleted: [],
    warnings: Array.from({ length: 3 }, () => '未解析内链 [[x]] @ STX/a.md'),
    errors: [],
  });
  assert.match(report, /⚠️ 警告 3/);
  assert.equal(report.split('未解析内链 [[x]]').length - 1, 1); // 只列一行
  assert.match(report, /（×3）/);
});

// 闸门 a：vaultDir 指向一个能读、但没有 .md 的目录时，「扫描结果里没有」不等于「源笔记已删除」。
// 判据是「一篇 .md 都没扫到」，而不是「没有可发布的笔记」——后者见上一条测试，是正常状态。
test('一篇笔记都没扫到而清单非空时，拒绝删除并报错', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
  });
  runSync(config);
  assert.ok(fs.existsSync(path.join(config.contentDirAbs, 'a.md')));

  fs.rmSync(path.join(config.vaultDir, 'STX'), { recursive: true, force: true }); // vault 仍可读，只是空的

  const result = runSync(config);

  assert.equal(result.deleted.length, 0);
  assert.ok(fs.existsSync(path.join(config.contentDirAbs, 'a.md')), '误判成源已删除会清空博客目录');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /扫描到 0 篇笔记/);
  assert.match(result.errors[0], /\.sync-manifest\.json/); // 报错要给出可操作的出口
  const manifest = JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8'));
  assert.equal(manifest.entries.a.source, 'STX/a.md'); // 清单也不能被清
  fs.rmSync(root, { recursive: true, force: true });
});

// 闸门 b：部分扫描与完整扫描在结果上无从区分，读不到的目录里的笔记会被误判成「源已删除」。
// 权限位对 root 无效，以 root 跑测试时这条用例没有意义。
test('有目录读不到时本次不删除任何产物', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('以 root 运行时权限位不起作用');
    return;
  }
  const { root, config } = makeFixture({
    'STX/locked/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
    'STX/open.md': '---\npublish: true\nslug: open\ntitle: Open\npubDate: 2026-01-01\n---\n\n正文\n',
  });
  runSync(config);
  assert.ok(fs.existsSync(path.join(config.contentDirAbs, 'a.md')));

  fs.writeFileSync(
    path.join(config.vaultDir, 'STX/open.md'),
    '---\npublish: true\nslug: open\ntitle: Open\npubDate: 2026-01-01\n---\n\n改过的正文\n',
    'utf8'
  );
  const locked = path.join(config.vaultDir, 'STX/locked');
  fs.chmodSync(locked, 0o000);
  let result;
  try {
    result = runSync(config);
  } finally {
    fs.chmodSync(locked, 0o755); // 先恢复权限再删，否则 rmSync 清不掉 000 目录
  }

  assert.equal(result.deleted.length, 0);
  assert.ok(fs.existsSync(path.join(config.contentDirAbs, 'a.md')), '读不到 ≠ 已删除');
  assert.ok(result.warnings.some((warning) => /无法读取目录/.test(warning)));
  assert.ok(result.errors.some((error) => /无法读取目录/.test(error)));
  fs.rmSync(root, { recursive: true, force: true });
});

// scanVault 在 vault 根目录读不到时抛错（spec §7.6），CLI 要把它渲染成一行 ❌ 与退出码 1，
// 而不是把 Node 堆栈丢给用户：这条路径上「什么都没做」，不该看起来像崩了。
test('命令行入口把 vault 根目录读取失败渲染成 ❌ 与退出码 1', () => {
  const config = makeConfig({ vaultDir: path.join(os.tmpdir(), 'vault-that-does-not-exist') });
  let out = '';
  let err = '';
  const code = main(config, { out: { write: (chunk) => (out += chunk) }, err: { write: (chunk) => (err += chunk) } });

  assert.equal(code, 1);
  assert.equal(out, ''); // 没有报告：这次同步什么都没做
  assert.match(err, /❌ .*无法读取 vault 目录/);
});

// spec §7.1 的第二个合取项：可删的路径必须等于清单记录的路径。删除路径由 slug 反推，只在清单
// 没被改坏时才相等；不相等说明清单与磁盘的对应关系已被破坏，宁可漏删一轮也不删错文件。
test('清单记录的路径与推导出的路径不一致时跳过删除并报错', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
  });
  runSync(config);
  assert.ok(fs.existsSync(path.join(config.contentDirAbs, 'a.md')));

  // 模拟清单被手工改过或合并解冲突出错
  const manifest = JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8'));
  manifest.entries.a.output = 'src/content/posts/somewhere-else.md';
  fs.writeFileSync(config.manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // 取消发布让「a」成为待删项；此时仍有 1 篇 .md 被扫到，闸门 a 不会触发
  fs.writeFileSync(
    path.join(config.vaultDir, 'STX/a.md'),
    '---\npublish: false\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
    'utf8'
  );

  const result = runSync(config);

  assert.equal(result.deleted.length, 0);
  assert.ok(fs.existsSync(path.join(config.contentDirAbs, 'a.md')), '路径对不上时不能删');
  assert.ok(result.errors.some((error) => /不一致/.test(error)));
  fs.rmSync(root, { recursive: true, force: true });
});

// 删除比覆盖更严。spec §7.4 已经承认「生成文件被手工改过」真实会发生（用户直接在博客侧编辑
// 「已发布」的版本），覆盖有下一轮 vault 兜底，删除没有——静默销毁用户的改动不可逆。
test('生成文件被手工改过后取消发布不会静默删除', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
  });
  runSync(config);

  const generated = path.join(config.contentDirAbs, 'a.md');
  fs.appendFileSync(generated, '\n我手写的一段补充\n', 'utf8');

  fs.writeFileSync(
    path.join(config.vaultDir, 'STX/a.md'),
    '---\npublish: false\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
    'utf8'
  );

  const result = runSync(config);

  assert.equal(result.deleted.length, 0);
  assert.match(fs.readFileSync(generated, 'utf8'), /我手写的一段补充/); // 改动还在
  assert.ok(result.warnings.some((warning) => /手工改过/.test(warning)));
  fs.rmSync(root, { recursive: true, force: true });
});
