import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, makeConfig } from './config.mjs';
import { scanVault, buildIndexes } from './vault.mjs';

/** 建一个临时 vault 目录树，返回 { root, config }。 */
function makeVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  for (const [relative, content] of Object.entries(files)) {
    const abs = path.join(root, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return { root, config: makeConfig({ vaultDir: root }) };
}

test('scanVault 递归收集文件并给出相对路径', () => {
  const { root, config } = makeVault({ 'STX/AI/a.md': 'x', 'Top.md': 'y' });
  const rel = scanVault(config, []).map((f) => f.relPath).sort();
  assert.deepEqual(rel, ['STX/AI/a.md', 'Top.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scanVault 跳过 dot 目录与配置里的排除目录', () => {
  const { root, config } = makeVault({
    '.obsidian/app.json': '{}',
    '.trash/old.md': 'x',
    'STX/zz_Templates/t.md': 'y',
    'STX/.trash/x.md': 'z',
    'STX/AI/keep.md': 'k',
  });
  assert.deepEqual(scanVault(config, []).map((f) => f.relPath), ['STX/AI/keep.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

// 全小写的文件名在本机 tmpfs 上 readdirSync 已按字节序返回 a,b,c，与 localeCompare 序恰好重合，
// 于是删掉 sort 这项测试照样通过（变异验证：0 fail），名字里的「按名称排序」就落空了。
// 混合大小写把两种序分开：字节序把大写排在小写前，localeCompare 按字母序交错。
test('scanVault 结果顺序稳定（按名称排序）', () => {
  const { root, config } = makeVault({ 'STX/b.md': 'x', 'STX/A.md': 'y', 'STX/c.md': 'z', 'STX/Z.md': 'w' });
  assert.deepEqual(scanVault(config, []).map((f) => f.name), ['A.md', 'b.md', 'c.md', 'Z.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

// 根目录读不到时「扫到 0 个文件」与「vault 是空的」无法区分，而同步层会据此判定所有产物都该删除
test('vault 根目录读不到时抛错，不静默返回空', () => {
  const config = makeConfig({ vaultDir: path.join(os.tmpdir(), 'vault-that-does-not-exist') });
  let err;
  try {
    scanVault(config, []);
  } catch (error) {
    err = error;
  }
  assert.ok(err, '根目录读不到时必须抛错');
  // 提示要能指导下一步：路径拼错与盘未挂载是这条错误最常见的两个成因
  assert.match(err.message, /无法读取 vault 目录 .*请检查路径是否存在/);
  assert.equal(err.cause.code, 'ENOENT'); // 原始 fs 错误不能丢，否则排查时只剩一句中文
});

// 权限位对 root 无效，以 root 跑测试时这条用例没有意义
test('子目录读不到时记警告并继续扫描其余文件', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('以 root 运行时权限位不起作用');
    return;
  }
  const { root, config } = makeVault({ 'locked/secret.md': 'y', 'open/a.md': 'x' });
  const locked = path.join(root, 'locked');
  fs.chmodSync(locked, 0o000);
  try {
    const warnings = [];
    assert.deepEqual(scanVault(config, warnings).map((f) => f.relPath), ['open/a.md']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /无法读取目录 locked：EACCES/);
  } finally {
    fs.chmodSync(locked, 0o755); // 先恢复权限再删，否则 rmSync 清不掉 000 目录
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildIndexes 分离笔记与附件，附件按小写文件名索引', () => {
  const { root, config } = makeVault({
    'STX/a.md': 'x',
    'STX/zz_Attachments/Pasted Image 1.PNG': 'img',
  });
  const { notes, attachments } = buildIndexes(scanVault(config, []), []);
  assert.deepEqual(notes.map((f) => f.name), ['a.md']);
  assert.equal(attachments.get('pasted image 1.png'), path.join(root, 'STX/zz_Attachments/Pasted Image 1.PNG'));
  fs.rmSync(root, { recursive: true, force: true });
});

// 「忘了传 sink」曾经等于「静默丢弃警告」：默认值让权限错误连一句提示都留不下。
// 参数现在没有默认值，但只传一个实参时 undefined 要到真产生警告那一刻才炸——守卫必须挡在入口。
test('两个函数都拒绝缺省的 warnings 参数', () => {
  const { root, config } = makeVault({ 'a.md': 'x' });
  assert.throws(() => scanVault(config), /scanVault 需要传入 warnings 数组/);
  assert.throws(() => buildIndexes([]), /buildIndexes 需要传入 warnings 数组/);
  fs.rmSync(root, { recursive: true, force: true });
});

// 先到先得此前只活在注释里：变异成后到先得，全部测试照样通过
test('同名附件先到先得并记录冲突警告', () => {
  const { root, config } = makeVault({ 'AAA/shot.png': 'first', 'zzz/shot.png': 'second' });
  const warnings = [];
  const { attachments } = buildIndexes(scanVault(config, warnings), warnings);
  assert.equal(attachments.get('shot.png'), path.join(root, 'AAA/shot.png'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /同名附件冲突：「zzz\/shot\.png」被忽略/);
  // 这一行只锁警告文本（改成后到先得时文本不变），胜者由上面那条 assert.equal 锁死
  assert.match(warnings[0], /一律使用「AAA\/shot\.png」/);
  fs.rmSync(root, { recursive: true, force: true });
});

// 跨目录的 DFS 交错序同样没人守：变体「先收完本层文件再下探子目录」能通过全部测试，
// 而它会让根目录的 shot.png 与 AAA/shot.png 互换胜者。目录名 'AAA' 排在文件名 'shot.png' 前面，
// 所以子目录那个先被收到、成为胜者——这是「按名称逐目录下探」的直接推论，钉住它。
test('跨目录按名称交错下探，同名附件胜者随之确定', () => {
  const { root, config } = makeVault({ 'shot.png': 'root-level', 'AAA/shot.png': 'nested' });
  const scanned = scanVault(config, []);
  assert.deepEqual(scanned.map((f) => f.relPath), ['AAA/shot.png', 'shot.png']);
  const { attachments } = buildIndexes(scanned, []);
  assert.equal(attachments.get('shot.png'), path.join(root, 'AAA/shot.png'));
  fs.rmSync(root, { recursive: true, force: true });
});

// notes 用小写后缀判定，但此前 fixture 里唯一的大写文件名是附件——.MD 走哪条分支没人验过
test('大写扩展名的 .MD 文件仍算笔记', () => {
  const { root, config } = makeVault({ 'STX/A.MD': 'x', 'STX/zz_Attachments/B.PNG': 'y' });
  const { notes, attachments } = buildIndexes(scanVault(config, []), []);
  assert.deepEqual(notes.map((f) => f.name), ['A.MD']);
  assert.equal(attachments.size, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('makeConfig 把相对路径解析为基于 repoRoot 的绝对路径', () => {
  const config = makeConfig({ repoRoot: '/tmp/repo', vaultDir: 'Wiki' });
  assert.equal(config.vaultDir, '/tmp/repo/Wiki'); // vaultDir 与其余三个字段一视同仁
  assert.equal(config.contentDirAbs, '/tmp/repo/src/content/posts');
  assert.equal(config.imagesDirAbs, '/tmp/repo/public/images');
  assert.equal(config.manifestAbs, '/tmp/repo/.sync-manifest.json');
});

test('makeConfig 覆盖项生效且不污染默认值', () => {
  const a = makeConfig({ vaultDir: '/tmp/v1' });
  const b = makeConfig();
  assert.equal(a.vaultDir, '/tmp/v1');
  assert.equal(b.vaultDir, DEFAULT_CONFIG.vaultDir);
  // 数组若按引用共享，任何一次 push 都会污染所有 config 与默认值——只查标量查不出来
  const before = [...DEFAULT_CONFIG.excludeDirs];
  assert.notEqual(a.excludeDirs, DEFAULT_CONFIG.excludeDirs);
  assert.notEqual(b.imageExtensions, DEFAULT_CONFIG.imageExtensions);
  a.excludeDirs.push('tmp-notes');
  assert.deepEqual(DEFAULT_CONFIG.excludeDirs, before);
  assert.deepEqual(b.excludeDirs, before);
});
