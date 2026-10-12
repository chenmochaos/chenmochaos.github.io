import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitByCodeFence,
  splitInlineCode,
  headingAnchor,
  detectUnsupportedSyntax,
  transformBody,
} from './transform.mjs';

/** 构造可控 ctx：图片与内链都按预设表解析，警告写进传入的数组。 */
function makeCtx({ images = {}, links = {}, warnings = [], sourceRel = 'STX/test.md' } = {}) {
  return {
    urlPrefix: '/posts',
    sourceRel,
    warnings,
    copyImage: (target) => images[target] ?? null,
    resolveLink: (target) => links[target] ?? null,
  };
}

const okImage = { url: '/images/post/a.png', alt: 'a' };
const okLink = { slug: 'target-post', title: '目标文章' };

test('代码围栏内容不参与替换', () => {
  const body = ['```js', 'const x = "[[笔记]]";', '```', '', '正文 [[笔记]]'].join('\n');
  const out = transformBody(body, makeCtx({ links: { 笔记: okLink } }));
  assert.ok(out.includes('const x = "[[笔记]]";'));
  assert.ok(out.includes('正文 [目标文章](/posts/target-post)'));
});

test('未闭合的代码围栏之后的内容全按代码处理', () => {
  const out = transformBody('```\n[[笔记]]\n', makeCtx({ links: { 笔记: okLink } }));
  assert.ok(out.includes('[[笔记]]'));
});

test('波浪号围栏同样生效', () => {
  const body = ['~~~', '[[笔记]]', '~~~', '[[笔记]]'].join('\n');
  const out = transformBody(body, makeCtx({ links: { 笔记: okLink } }));
  assert.equal(out.split('[目标文章]').length - 1, 1);
});

test('行内代码不参与替换', () => {
  const body = '示例 `[[笔记]]` 与 [[笔记]]';
  const out = transformBody(body, makeCtx({ links: { 笔记: okLink } }));
  assert.ok(out.includes('`[[笔记]]`'));
  assert.ok(out.includes('与 [目标文章](/posts/target-post)'));
});

test('splitInlineCode 交替标记代码与非代码片段', () => {
  const parts = splitInlineCode('a`b`c');
  assert.deepEqual(parts, [
    { isCode: false, text: 'a' },
    { isCode: true, text: '`b`' },
    { isCode: false, text: 'c' },
  ]);
});

test('图片嵌入改写为 Markdown 图片', () => {
  const out = transformBody('![[a.png]]', makeCtx({ images: { 'a.png': okImage } }));
  assert.equal(out, '![a](/images/post/a.png)');
});

test('图片嵌入带尺寸参数时忽略尺寸', () => {
  const out = transformBody('![[a.png|300]]', makeCtx({ images: { 'a.png': okImage } }));
  assert.equal(out, '![a](/images/post/a.png)');
});

test('找不到附件时保留原文并记警告', () => {
  const warnings = [];
  const out = transformBody('![[missing.png]]', makeCtx({ warnings }));
  assert.equal(out, '![[missing.png]]');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /缺失附件 !\[\[missing\.png\]\] @ STX\/test\.md/);
});

test('指向已发布笔记的内链变成绝对链接', () => {
  const out = transformBody('见 [[笔记]]。', makeCtx({ links: { 笔记: okLink } }));
  assert.equal(out, '见 [目标文章](/posts/target-post)。');
});

test('内链带别名时用别名作标签', () => {
  const out = transformBody('[[笔记|点这里]]', makeCtx({ links: { 笔记: okLink } }));
  assert.equal(out, '[点这里](/posts/target-post)');
});

test('内链带小节时保留锚点', () => {
  const out = transformBody('[[笔记#如何开始]]', makeCtx({ links: { 笔记: okLink } }));
  assert.equal(out, '[目标文章](/posts/target-post#如何开始)');
});

test('内链带块引用标识时丢弃 ^ 部分', () => {
  const out = transformBody('[[笔记^abc123]]', makeCtx({ links: { 笔记: okLink } }));
  assert.equal(out, '[目标文章](/posts/target-post)');
});

test('指向未发布笔记的内链降级为纯文本并记警告', () => {
  const warnings = [];
  const out = transformBody('见 [[没发布]]。', makeCtx({ warnings }));
  assert.equal(out, '见 没发布。');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /未解析内链 \[\[没发布\]\] @ STX\/test\.md/);
});

test('未发布内链带别名时保留别名文本', () => {
  const out = transformBody('见 [[没发布|别名]]。', makeCtx());
  assert.equal(out, '见 别名。');
});

test('无别名的未发布内链用目标名作纯文本', () => {
  assert.equal(transformBody('[[STX/AI/没发布]]', makeCtx()), '没发布');
});

test('callout 标记变成加粗标题，保留引用块', () => {
  const out = transformBody('> [!note] 提示标题\n> 正文', makeCtx());
  assert.equal(out, '> **提示标题**\n> 正文');
});

test('没有标题的 callout 只删掉标记行', () => {
  const out = transformBody('> [!warning]\n> 正文', makeCtx());
  assert.equal(out, '> 正文');
});

test('headingAnchor 匹配 github-slugger 的常见行为', () => {
  assert.equal(headingAnchor('如何开始'), '如何开始');
  assert.equal(headingAnchor('Hello World'), 'hello-world');
  assert.equal(headingAnchor('Step 1: Setup!'), 'step-1-setup');
});

test('图片与内链互不误伤（![[ 不被当内链）', () => {
  const out = transformBody('![[a.png]]', makeCtx({ images: { 'a.png': okImage }, links: { 'a.png': okLink } }));
  assert.equal(out, '![a](/images/post/a.png)');
});

test('detectUnsupportedSyntax 报告注释与高亮语法', () => {
  const warnings = detectUnsupportedSyntax('正文 %%隐藏注释%% 与 ==高亮== 文字', 'STX/a.md');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /%%注释%%/);
  assert.match(warnings[0], /STX\/a\.md/);
  assert.match(warnings[1], /==高亮==/);
});

test('detectUnsupportedSyntax 忽略代码块里的同类字符', () => {
  assert.deepEqual(detectUnsupportedSyntax('```\n%%x%%\n==y==\n```', 'STX/a.md'), []);
});

test('detectUnsupportedSyntax 对干净正文返回空数组', () => {
  assert.deepEqual(detectUnsupportedSyntax('普通正文 [[链接]]', 'STX/a.md'), []);
});
