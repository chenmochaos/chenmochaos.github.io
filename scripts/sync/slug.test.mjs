import test from 'node:test';
import assert from 'node:assert/strict';
import { slugFromFilename, resolveSlug } from './slug.mjs';

test('英文文件名转成小写短横线 slug', () => {
  assert.equal(slugFromFilename('How To Learn AI'), 'how-to-learn-ai');
});

test('下划线、连续空格、连续短横线被归一化', () => {
  assert.equal(slugFromFilename('a__b   c--d'), 'a-b-c-d');
});

test('首尾短横线被裁掉', () => {
  assert.equal(slugFromFilename('-hello-'), 'hello');
});

test('纯中文文件名无法生成 slug', () => {
  assert.equal(slugFromFilename('如何以正确的视角看待大学'), '');
});

test('中英混合文件名只保留 ASCII 部分', () => {
  assert.equal(slugFromFilename('Agent 上下文 Harness'), 'agent-harness');
});

test('显式 slug 属性优先且合法时通过', () => {
  assert.deepEqual(resolveSlug({ slugProperty: 'my-post', basename: '随便什么名字' }), {
    slug: 'my-post',
    error: null,
  });
});

test('显式 slug 属性非法时报错', () => {
  const result = resolveSlug({ slugProperty: 'My Post', basename: 'x' });
  assert.equal(result.slug, null);
  assert.match(result.error, /slug 属性格式非法/);
});

test('无 slug 属性时回退到文件名', () => {
  assert.deepEqual(resolveSlug({ slugProperty: undefined, basename: 'Hello World' }), {
    slug: 'hello-world',
    error: null,
  });
});

test('文件名推不出 slug 时报错并要求补属性', () => {
  const result = resolveSlug({ slugProperty: undefined, basename: '中文标题' });
  assert.equal(result.slug, null);
  assert.match(result.error, /请.*填写 slug/);
});

test('推出来的 slug 长度不足 2 也报错', () => {
  assert.equal(resolveSlug({ slugProperty: undefined, basename: 'x' }).slug, null);
});

test('空字符串 slug 属性视为未填写', () => {
  assert.deepEqual(resolveSlug({ slugProperty: '   ', basename: 'hello' }), {
    slug: 'hello',
    error: null,
  });
});
