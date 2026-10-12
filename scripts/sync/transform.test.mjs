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
function makeCtx({
  images = {},
  unsupported = [],
  links = {},
  warnings = [],
  sourceRel = 'STX/test.md',
} = {}) {
  return {
    urlPrefix: '/posts',
    sourceRel,
    warnings,
    copyImage: (target) => images[target] ?? (unsupported.includes(target) ? { unsupported: true } : null),
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

// 列表项里的代码块缩进 4 空格以上，按 `^ {0,3}` 认不出围栏，此前只能靠行内代码碰巧配对挡住改写
test('缩进 4 空格以上的围栏同样受保护', () => {
  const body = ['- 步骤', '', '    ```js', '    const s = `[[笔记]]`;', '    ```', '', '[[笔记]]'].join('\n');
  const out = transformBody(body, makeCtx({ links: { 笔记: okLink } }));
  assert.ok(out.includes('const s = `[[笔记]]`;'));
  assert.equal(out.split('[目标文章]').length - 1, 1);
});

// callout 里包代码块时每行带 `> ` 前缀，此前完全认不出围栏，代码里的内链会被改写成超链接。
// 代码内容里必须含反引号：不含时两个围栏行会被 splitInlineCode 凑成一对行内代码，
// 白捡一层保护，测试就成了假阳性（在旧实现上照样通过）。
test('块引用前缀的围栏同样受保护', () => {
  const body = ['> ```js', '> const s = `[[笔记]]`;', '> ```', '', '[[笔记]]'].join('\n');
  const out = transformBody(body, makeCtx({ links: { 笔记: okLink } }));
  assert.ok(out.includes('const s = `[[笔记]]`;'));
  assert.equal(out.split('[目标文章]').length - 1, 1);
});

// CRLF 会让围栏标记行与 callout 行整行匹配不上：围栏失效导致代码被改写，callout 全篇静默不转换
test('CRLF 正文的围栏与 callout 仍正常处理', () => {
  const body = '> [!note] 标题\r\n> 正文\r\n\r\n```\r\n[[笔记]]\r\n```\r\n\r\n[[笔记]]';
  const out = transformBody(body, makeCtx({ links: { 笔记: okLink } }));
  assert.ok(out.startsWith('> **标题**\n> 正文\n\n```'));
  assert.ok(out.includes('```\n[[笔记]]\n```'));
  assert.equal(out.includes('\r'), false);
  assert.equal(out.split('[目标文章]').length - 1, 1);
});

test('splitByCodeFence 只产出有内容的分段，拼接回来与输入逐字节相同', () => {
  assert.deepEqual(splitByCodeFence('a\n```\nb\n```\nc'), [
    { isCode: false, text: 'a' },
    { isCode: true, text: '```\nb\n```' },
    { isCode: false, text: 'c' },
  ]);
  assert.deepEqual(splitByCodeFence(''), [{ isCode: false, text: '' }]);
  // 相邻围栏之间曾凭空多出一个空段，join 后就是输入里没有的空行
  const adjacent = '```\na\n```\n```\nb\n```';
  assert.deepEqual(splitByCodeFence(adjacent), [
    { isCode: true, text: '```\na\n```' },
    { isCode: true, text: '```\nb\n```' },
  ]);
  for (const body of [adjacent, '```\na\n````\n\n~~~\nb\n~~~\n', 'a\n~~~\nb\n~~~']) {
    assert.equal(
      splitByCodeFence(body)
        .map((part) => part.text)
        .join('\n'),
      body,
    );
  }
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

// Obsidian 在表格里写内链会自动写成 `![[a.png\|300]]`，只找 '|' 会把目标读成「a.png\」
test('表格里转义竖线的图片尺寸同样忽略', () => {
  const out = transformBody('| a | ![[a.png\\|300]] |', makeCtx({ images: { 'a.png': okImage } }));
  assert.ok(out.includes('![a](/images/post/a.png)'));
});

test('找不到附件时保留原文并记警告', () => {
  const warnings = [];
  const out = transformBody('![[missing.png]]', makeCtx({ warnings }));
  assert.equal(out, '![[missing.png]]');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /无法解析嵌入引用 !\[\[missing\.png\]\] @ STX\/test\.md/);
});

// 附件真实存在、只是不能内联时不能报「缺失」：那会让用户去查一个根本没丢的文件
test('附件存在但不是图片时记「不支持」而不是「缺失」', () => {
  const warnings = [];
  const out = transformBody('![[doc.pdf]]', makeCtx({ unsupported: ['doc.pdf'], warnings }));
  assert.equal(out, '![[doc.pdf]]');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /不支持的附件 !\[\[doc\.pdf\]\] @ STX\/test\.md/);
});

// 笔记嵌入（transclusion）在博客里没有内联展开的形态，此前按缺失附件处理：页面留字面量、报告报假警告
test('笔记嵌入降级为链接并记警告', () => {
  const warnings = [];
  const out = transformBody('![[笔记#如何开始]]', makeCtx({ links: { 笔记: okLink }, warnings }));
  assert.equal(out, '[目标文章](/posts/target-post#如何开始)');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /笔记嵌入不支持，已降级为链接 !\[\[笔记#如何开始\]\] @ STX\/test\.md/);
  assert.equal(transformBody('![[笔记]]', makeCtx({ links: { 笔记: okLink } })), '[目标文章](/posts/target-post)');
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

// Obsidian 在表格里写内链会自动转义竖线，用户没法不这样写
test('表格里转义竖线的内链按别名解析', () => {
  const out = transformBody('| a | [[笔记\\|点这里]] |', makeCtx({ links: { 笔记: okLink } }));
  assert.ok(out.includes('[点这里](/posts/target-post)'));
});

// 空字符串不是 nullish：用 ?? 会产出 []()——渲染上既点不到、也看不出内容丢了
test('别名为空时回退到目标标题，不产出空标签链接', () => {
  assert.equal(transformBody('[[笔记|]]', makeCtx({ links: { 笔记: okLink } })), '[目标文章](/posts/target-post)');
  assert.equal(
    transformBody('[[笔记|   ]]', makeCtx({ links: { 笔记: okLink } })),
    '[目标文章](/posts/target-post)',
  );
});

// [[#小节]] 是 Obsidian 的「本笔记标题」链接；此前目标为空会被解析失败并删成空文本
test('同笔记标题链接生成本页锚点', () => {
  assert.equal(transformBody('见 [[#如何开始]]。', makeCtx()), '见 [如何开始](#如何开始)。');
  assert.equal(transformBody('见 [[#如何开始|上面]]。', makeCtx()), '见 [上面](#如何开始)。');
  // 标签保留原文，锚点走与 Astro 产物 id 一致的 slug
  assert.equal(
    transformBody('[[#2.3 信道极限容量 ★★ 计算重点]]', makeCtx()),
    '[2.3 信道极限容量 ★★ 计算重点](#23-信道极限容量--计算重点)',
  );
});

test('目标为空且解析不到时保留原文而不是删成空', () => {
  const warnings = [];
  const out = transformBody('见 [[ ]] 和 [[|别名]]。', makeCtx({ warnings }));
  assert.equal(out, '见 [[ ]] 和 别名。');
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((warning) => warning.includes('@ STX/test.md')));
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

test('headingAnchor 与 Astro 产物 id 一致', () => {
  assert.equal(headingAnchor('如何开始'), '如何开始');
  assert.equal(headingAnchor('Hello World'), 'hello-world');
  assert.equal(headingAnchor('Step 1: Setup!'), 'step-1-setup');
  // 手写近似会把这两条里的标点与 ★ 留在锚点里，而产物 id 会剔除它们
  assert.equal(headingAnchor('2.3 信道极限容量 ★★ 计算重点'), '23-信道极限容量--计算重点');
  assert.equal(headingAnchor('中文，标点。测试！'), '中文标点测试');
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

// 一个忘了闭合的 `==` 会把其后整段正文吞进警告，报告是给人读的
test('detectUnsupportedSyntax 截断超长的命中内容', () => {
  const [warning] = detectUnsupportedSyntax(`==${'x'.repeat(100000)}==`, 'STX/a.md');
  assert.ok(warning.length < 200, `警告长度 ${warning.length}`);
  assert.match(warning, /==高亮==/);
  assert.match(warning, /@ STX\/a\.md$/);
});

// 闭合围栏此前复用开启那套放宽正则：代码块内部一行 4 空格缩进的 ``` 或带 `> ` 的 ``` 会被当成闭合标记，
// 块被提前收掉，其后本属代码的内容当正文改写——按 CommonMark 这两行都是字面文本（缩进超 3 空格、
// 块引用前缀在代码块内都不作数），漏认的方向才是安全的。这是 66419a8 引入的回归。
test('代码块内部缩进或带块引用前缀的围栏不构成闭合', () => {
  const bodies = ['```\n    ```\nafter [[笔记]]\n```', '```\n> ```\nafter [[笔记]]\n```'];
  for (const body of bodies) {
    const out = transformBody(body, makeCtx({ links: { 笔记: okLink } }));
    assert.ok(out.includes('after [[笔记]]'), out);
    assert.equal(out.split('[目标文章]').length - 1, 0, out);
  }
});

// 上层修复不能把合法的闭合一并挡掉：顶格开启、闭合缩进 3 空格（CommonMark 允许），
// 以及列表项里开启与闭合同为 4 空格
test('合法的闭合仍被认出（顶格缩进 3 空格、列表项 4 空格）', () => {
  const shallow = transformBody('```\ncode [[笔记]]\n   ```\n\n[[笔记]]', makeCtx({ links: { 笔记: okLink } }));
  assert.ok(shallow.includes('code [[笔记]]'), shallow);
  assert.equal(shallow.split('[目标文章]').length - 1, 1, shallow);

  const list = transformBody('- 步骤\n\n    ```js\n    const s = `[[笔记]]`;\n    ```\n\n[[笔记]]', makeCtx({ links: { 笔记: okLink } }));
  assert.ok(list.includes('const s = `[[笔记]]`;'), list);
  assert.equal(list.split('[目标文章]').length - 1, 1, list);
});

// 缩进按列算：制表符在 CommonMark 里推进到下一个 4 的倍数，按字符数 1 计会让 `\t``` ` 被当成顶格闭合，
// 代码块提前收掉、其后内容被改写——与闭合复用开启正则那次同一类错。
test('制表符缩进的围栏同样不构成闭合', () => {
  const body = '```\n\t```\nafter [[笔记]]\n```';
  const out = transformBody(body, makeCtx({ links: { 笔记: okLink } }));
  assert.ok(out.includes('after [[笔记]]'), out);
  assert.equal(out.split('[目标文章]').length - 1, 0, out);
});

// 反向守门：制表符开启、制表符闭合的代码块仍要能正常闭合，不能被上一处一并挡掉。
// 代码行里必须含反引号，否则两个围栏行会被 splitInlineCode 凑成一对行内代码而白捡一层保护。
test('制表符开启并闭合的围栏仍被认出', () => {
  const body = '\t```js\n\tconst s = `[[笔记]]`;\n\t```\n\n[[笔记]]';
  const out = transformBody(body, makeCtx({ links: { 笔记: okLink } }));
  assert.ok(out.includes('const s = `[[笔记]]`;'), out);
  assert.equal(out.split('[目标文章]').length - 1, 1, out);
});
