import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeConfig } from './config.mjs';
import { loadManifest, saveManifest } from './manifest.mjs';

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  return { root, config: makeConfig({ repoRoot: root }) };
}

test('manifest 不存在时返回空清单', () => {
  const { root, config } = makeRepo();
  assert.deepEqual(loadManifest(config), { version: 1, entries: {} });
  fs.rmSync(root, { recursive: true, force: true });
});

test('saveManifest 落盘后 loadManifest 能读回', () => {
  const { root, config } = makeRepo();
  saveManifest(config, {
    version: 1,
    entries: { b: { source: 'b.md' }, a: { source: 'a.md' } },
  });

  // 落盘格式看文件本身：loadManifest 只承诺 { version, entries }，generatedAt 不进内存对象
  const raw = fs.readFileSync(config.manifestAbs, 'utf8');
  const written = JSON.parse(raw);
  assert.equal(written.version, 1);
  assert.match(written.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(written.entries), ['a', 'b']); // 键已排序
  assert.ok(raw.endsWith('}\n'), '文件以换行结尾');

  const loaded = loadManifest(config);
  assert.deepEqual(Object.keys(loaded.entries), ['a', 'b']);
  assert.equal(loaded.entries.a.source, 'a.md');
  fs.rmSync(root, { recursive: true, force: true });
});

test('manifest 内容损坏时降级为空清单', () => {
  const { root, config } = makeRepo();
  fs.writeFileSync(config.manifestAbs, '{ 这不是 json', 'utf8');
  assert.deepEqual(loadManifest(config), { version: 1, entries: {} });
  fs.rmSync(root, { recursive: true, force: true });
});

test('manifest 结构不符（entries 不是对象）时降级为空清单', () => {
  const { root, config } = makeRepo();
  fs.writeFileSync(config.manifestAbs, JSON.stringify({ entries: 'nope' }), 'utf8');
  assert.deepEqual(loadManifest(config), { version: 1, entries: {} });
  fs.rmSync(root, { recursive: true, force: true });
});

test('saveManifest 输出以换行结尾且缩进为 2', () => {
  const { root, config } = makeRepo();
  saveManifest(config, { version: 1, entries: {} });
  const raw = fs.readFileSync(config.manifestAbs, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.ok(raw.includes('\n  "version": 1'));
  fs.rmSync(root, { recursive: true, force: true });
});
