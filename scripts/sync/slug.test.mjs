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
  assert.equal(result.error, 'slug 属性格式非法：「My Post」，只允许小写字母、数字与短横线');
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
  assert.equal(result.error, '文件名「中文标题」无法生成 slug（含非 ASCII 字符），请在笔记属性里填写 slug');
});

test('推出来的 slug 长度不足 2 也报错', () => {
  const result = resolveSlug({ slugProperty: undefined, basename: 'x' });
  assert.equal(result.slug, null);
  assert.equal(result.error, '文件名「x」无法生成 slug（含非 ASCII 字符），请在笔记属性里填写 slug');
});

test('空字符串 slug 属性视为未填写', () => {
  assert.deepEqual(resolveSlug({ slugProperty: '   ', basename: 'hello' }), {
    slug: 'hello',
    error: null,
  });
});

test('布尔型 slug 属性被拒绝（YAML 裸写 slug: true 解析为布尔）', () => {
  const result = resolveSlug({ slugProperty: true, basename: 'fallback' });
  assert.equal(result.slug, null);
  assert.equal(result.error, 'slug 属性格式非法：必须是字符串，当前是 boolean');
});

test('数字型 slug 属性被拒绝', () => {
  const result = resolveSlug({ slugProperty: 2024, basename: 'fallback' });
  assert.equal(result.slug, null);
  assert.equal(result.error, 'slug 属性格式非法：必须是字符串，当前是 number');
});

test('列表型 slug 属性被拒绝（哪怕只有一个元素）', () => {
  const result = resolveSlug({ slugProperty: ['my-post'], basename: 'fallback' });
  assert.equal(result.slug, null);
  assert.equal(result.error, 'slug 属性格式非法：必须是字符串，当前是 列表');
});

test('显式 slug 的边界形式一律拒绝', () => {
  for (const bad of ['-lead', 'trail-', 'my--post', 'my_post', 'My-Post', 'a b', 'a/b']) {
    const result = resolveSlug({ slugProperty: bad, basename: 'x' });
    assert.equal(result.slug, null, `应拒绝「${bad}」`);
    assert.equal(result.error, `slug 属性格式非法：「${bad}」，只允许小写字母、数字与短横线`);
  }
});

test('推导出的 slug 满足安全不变式：要么长度不足 2，要么被 resolveSlug 原样接受', () => {
  // 不要在这里抄一份 SLUG_RE 副本——副本会与实现漂移，且抄来的副本根本约束不到模块。
  // 改用公开 API 反查：resolveSlug 只在 slug 形如 ^[a-z0-9]+(-[a-z0-9]+)*$ 时才接受，
  // 因此"被接受"等价于"不含 `/`、不含 `.`、无可逃出 src/content/posts/ 的字符"。
  const inputs = [
    'A B', '已有--双横线', '---', '   ', 'a', 'MiXeD CaSe 123', 'emoji 😀 name', '_',
    'a/b', 'a..b', '..', 'a.b', '.hidden', 'a/b/../c',
  ];
  for (const input of inputs) {
    const derived = slugFromFilename(input);
    if (derived.length < 2) continue;
    assert.deepEqual(
      resolveSlug({ slugProperty: derived, basename: 'ignored' }),
      { slug: derived, error: null },
      `「${input}」→「${derived}」未被 resolveSlug 接受，说明产物 slug 不满足形态要求`,
    );
  }
});
