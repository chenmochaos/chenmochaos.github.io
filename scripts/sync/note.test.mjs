import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'js-yaml';
import {
  parseNote,
  formatDate,
  normalizePubDate,
  stripInlineMarkup,
  firstParagraph,
  truncate,
  pickDescription,
  hashText,
  buildOutput,
} from './note.mjs';

test('解析 frontmatter 与正文', () => {
  const note = parseNote('---\ntitle: 标题\npublish: true\n---\n\n正文第一行\n');
  assert.equal(note.data.title, '标题');
  assert.equal(note.data.publish, true);
  assert.equal(note.body, '\n正文第一行\n');
  assert.equal(note.error, null);
});

test('没有 frontmatter 时整体视为正文', () => {
  const note = parseNote('# 只有正文\n');
  assert.deepEqual(note.data, {});
  assert.equal(note.body, '# 只有正文\n');
});

test('YAML 语法错误时报告错误且不抛异常', () => {
  const note = parseNote('---\ntitle: [未闭合\n---\n正文\n');
  assert.match(note.error, /frontmatter YAML 解析失败/);
});

test('frontmatter 不是对象（例如只有一行标量）时视为空', () => {
  assert.deepEqual(parseNote('---\njust a string\n---\n正文\n').data, {});
});

test('Date 对象格式化为 YYYY-MM-DD（取本地日期，不受时区影响）', () => {
  assert.equal(formatDate(new Date(2026, 9, 12, 0, 30)), '2026-10-12');
});

test('已是 YYYY-MM-DD 的字符串原样返回', () => {
  assert.equal(formatDate('2026-10-12'), '2026-10-12');
});

test('带时间的字符串取日期部分', () => {
  assert.equal(formatDate('2025-11-09 16:51:00'), '2025-11-09');
});

test('无法解析的日期返回 null', () => {
  assert.equal(formatDate('不是日期'), null);
  assert.equal(formatDate(undefined), null);
});

test('pubDate 优先级：pubDate > date > 文件 mtime', () => {
  const mtime = new Date(2024, 0, 1);
  assert.equal(normalizePubDate({ pubDate: '2026-10-12', date: '2025-01-01' }, mtime), '2026-10-12');
  assert.equal(normalizePubDate({ date: '2025-01-01' }, mtime), '2025-01-01');
  assert.equal(normalizePubDate({}, mtime), '2024-01-01');
});

test('stripInlineMarkup 去掉链接与强调标记', () => {
  assert.equal(stripInlineMarkup('看 [[另一篇|这篇]] 和**加粗**'), '看 这篇 和加粗');
  assert.equal(stripInlineMarkup('看 [[另一篇]] 和 `代码`'), '看 另一篇 和 代码');
  assert.equal(stripInlineMarkup('![图](http://x/y.png) 文字'), '文字');
});

test('firstParagraph 跳过标题、图片、引用、列表、代码围栏、表格', () => {
  const body = ['## 缘起', '', '> 引用', '', '- 列表项', '', '```', 'code', '```', '', '这才是第一段。']
    .join('\n');
  assert.equal(firstParagraph(body), '这才是第一段。');
});

test('firstParagraph 在完全没有正文时返回空串', () => {
  assert.equal(firstParagraph('# 只有标题\n'), '');
});

test('pickDescription 优先级：description > excerpt > 正文首段', () => {
  assert.equal(pickDescription({ description: '摘要' }, '正文首段'), '摘要');
  assert.equal(pickDescription({ excerpt: '摘录' }, '正文首段'), '摘录');
  assert.equal(pickDescription({}, '正文首段'), '正文首段');
});

test('truncate 按码点切割，不在 emoji 中间切出孤立代理项', () => {
  const text = `${'a'.repeat(119)}🚀more`;
  assert.equal(truncate(text, 120), `${'a'.repeat(119)}🚀…`);
  // 按 UTF-16 码元切会得到 'a'×119 + '\ud83d'（孤立高位代理项），写盘再读回变成 U+FFFD，
  // 于是 Task 6 的「内容未变则跳过」永远判为变化，那个文件每次同步都会被重写。
  assert.equal(truncate('🚀'.repeat(120), 120), '🚀'.repeat(120));
});

test('带 UTF-8 BOM 的笔记仍能解析出 frontmatter', () => {
  const note = parseNote('﻿---\ntitle: 标题\npublish: true\n---\n\n正文\n');
  assert.equal(note.data.publish, true);
  assert.equal(note.data.title, '标题');
  assert.equal(note.body, '\n正文\n');
  assert.equal(note.error, null);
});

test('buildOutput 的 frontmatter 能被 YAML 原样解析回来（换行、控制符、引号）', () => {
  // 用 js-yaml v5 校验往返。注意 Astro 内部用的是 v4，两者在「双引号标量里的裸换行」上行为不同
  // （v5 抛错、v4 静默折叠成空格），所以输出必须取两边都接受的形式：JSON 字符串。
  const titles = ['普通标题', 'a\nb', 'a\rb', 'a\x07b', 'a\tb', 'a"b', 'a\\b', 'a#b', '', 'null', '真：冒号'];
  for (const title of titles) {
    const out = buildOutput({
      frontmatter: { title, slug: 'a', pubDate: '2026-01-01', tags: [], syncedFrom: 'x.md' },
      body: '正文',
    });
    const lines = out.split('\n');
    const end = lines.indexOf('---', 1);
    assert.ok(end > 0, `frontmatter 未正常收尾：${JSON.stringify(out)}`);
    assert.equal(
      load(lines.slice(1, end).join('\n')).title,
      title,
      `标题没有原样往返：${JSON.stringify(title)}`,
    );
  }
});

test('pickDescription 取不到任何内容时返回 undefined', () => {
  assert.equal(pickDescription({}, '# 只有标题\n'), undefined);
  assert.equal(pickDescription({ description: '   ' }, ''), undefined);
});

// 用户口径两头都要留：留空 = 自动用正文首段（方便），写 false = 这篇不要摘要（能让列表只显示标题）。
// 「不要摘要」必须连 excerpt 与正文首段一起拦住，否则它只是「换了个回落目标」，用户仍然关不掉摘要。
test('description: false 表示「这篇不要摘要」，拦住整条回落链', () => {
  assert.equal(pickDescription({ description: false, excerpt: '摘录' }, '正文首段'), undefined);
  assert.equal(pickDescription({ description: 'false' }, '正文首段'), undefined); // Obsidian 文本属性存成字符串
  assert.equal(pickDescription({ description: 'FALSE' }, '正文首段'), undefined); // YAML 的布尔大小写写法
  // 对照：留空 / null 仍然回落到正文首段，行为不变
  assert.equal(pickDescription({ description: '' }, '正文首段'), '正文首段');
  assert.equal(pickDescription({ description: null }, '正文首段'), '正文首段');
  assert.equal(pickDescription({ description: false }, '# 只有标题\n'), undefined); // 没有正文首段也不炸
});

test('pickDescription 超长时截断并加省略号', () => {
  const long = 'a'.repeat(200);
  const result = pickDescription({ description: long }, '', 120);
  assert.equal(result.length, 121);
  assert.ok(result.endsWith('…'));
});

test('hashText 稳定且带 sha256 前缀', () => {
  assert.equal(hashText('x'), hashText('x'));
  assert.match(hashText('x'), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(hashText('x'), hashText('y'));
});

test('buildOutput 生成带引号 frontmatter 与 syncedFrom 标记', () => {
  const out = buildOutput({
    frontmatter: {
      title: '标题：带冒号和"引号"',
      slug: 'my-post',
      description: '摘要',
      pubDate: '2026-10-12',
      tags: ['ai', 'agent'],
      syncedFrom: 'STX/AI/my-post.md',
    },
    body: '\n正文\n',
  });
  const expected = [
    '---',
    'title: "标题：带冒号和\\"引号\\""',
    'slug: "my-post"',
    'description: "摘要"',
    'pubDate: 2026-10-12',
    'tags: ["ai", "agent"]',
    'draft: false',
    'syncedFrom: "STX/AI/my-post.md"',
    '---',
    '',
    '正文\n',
  ].join('\n');
  assert.equal(out, expected);
});

test('buildOutput 无 description 时省略该字段，tags 为空时输出空数组', () => {
  const out = buildOutput({
    frontmatter: { title: 'A', slug: 'a', pubDate: '2026-01-01', tags: [], syncedFrom: 'x.md' },
    body: '正文',
  });
  assert.ok(!out.includes('description:'));
  assert.ok(out.includes('tags: []'));
});
