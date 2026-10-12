import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeConfig } from './config.mjs';
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
  const rel = scanVault(config).map((f) => f.relPath).sort();
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
  assert.deepEqual(scanVault(config).map((f) => f.relPath), ['STX/AI/keep.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scanVault 结果顺序稳定（按名称排序）', () => {
  const { root, config } = makeVault({ 'STX/b.md': 'x', 'STX/a.md': 'y', 'STX/c.md': 'z' });
  assert.deepEqual(scanVault(config).map((f) => f.name), ['a.md', 'b.md', 'c.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildIndexes 分离笔记与附件，附件按小写文件名索引', () => {
  const { root, config } = makeVault({
    'STX/a.md': 'x',
    'STX/zz_Attachments/Pasted Image 1.PNG': 'img',
  });
  const { notes, attachments } = buildIndexes(scanVault(config));
  assert.deepEqual(notes.map((f) => f.name), ['a.md']);
  assert.equal(attachments.get('pasted image 1.png'), path.join(root, 'STX/zz_Attachments/Pasted Image 1.PNG'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('makeConfig 把相对路径解析为基于 repoRoot 的绝对路径', () => {
  const config = makeConfig({ repoRoot: '/tmp/repo' });
  assert.equal(config.contentDirAbs, '/tmp/repo/src/content/posts');
  assert.equal(config.imagesDirAbs, '/tmp/repo/public/images');
  assert.equal(config.manifestAbs, '/tmp/repo/.sync-manifest.json');
});

test('makeConfig 覆盖项生效且不污染默认值', () => {
  const a = makeConfig({ vaultDir: '/tmp/v1' });
  const b = makeConfig();
  assert.equal(a.vaultDir, '/tmp/v1');
  assert.equal(b.vaultDir, '/home/minus/Wiki');
});
