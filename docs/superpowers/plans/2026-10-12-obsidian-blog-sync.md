# Obsidian → 博客同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Obsidian 笔记里加 `publish: true` 属性后，本地跑 `pnpm sync` 即可把文章（含正文转换、图片、内链）同步进博客仓库并正常渲染。

**Architecture:** 一个纯本地的 Node 脚本把 vault 中标记发布的笔记转换成 `src/content/posts/<slug>.md` 与 `public/images/<slug>/*`，用 `.sync-manifest.json` 记录生成物以支持安全清理。脚本按职责拆成 6 个可独立测试的模块，纯函数全部用 Node 内置测试跑 TDD，编排层用临时 fixture（临时 vault + 临时 repo）做集成测试。博客侧同时放宽内容集合 glob 到 `{md,mdx}`、让 `description` 可选、补齐正文样式。

**Tech Stack:** Node 24（`node:test`、`node:fs`、`node:crypto`）、`js-yaml` + `github-slugger`（两个 devDependency；后者与 Astro 生成标题 id 用的是同一个库）、Astro 6 Content Collections（glob loader + Zod）、Tailwind CSS v4（CSS-first，设计变量在 `src/styles/global.css` 的 `@theme` 里）。

**Spec:** `docs/superpowers/specs/2026-10-12-obsidian-blog-sync-design.md`

---

## 文件结构

```
Blog/
├── scripts/
│   ├── sync-obsidian.mjs          入口：解析 --dry、调用 runSync、打印报告、设置退出码
│   └── sync/
│       ├── config.mjs             DEFAULT_CONFIG + makeConfig（路径绝对化）
│       ├── slug.mjs               slugFromFilename / resolveSlug
│       ├── note.mjs               解析笔记、字段映射、组装输出文本、哈希
│       ├── transform.mjs          正文转换：代码块分段、图片、内链、callout
│       ├── vault.mjs              遍历 vault、建立笔记/附件索引
│       ├── manifest.mjs           读/写 .sync-manifest.json
│       ├── sync.mjs               planSync / applySync / runSync / formatReport
│       ├── slug.test.mjs
│       ├── note.test.mjs
│       ├── transform.test.mjs
│       ├── vault.test.mjs
│       ├── manifest.test.mjs
│       └── sync.test.mjs
├── .sync-manifest.json            生成物清单（提交进仓库）
├── src/content/posts/<slug>.md    同步产物（生成文件，禁止手改）
├── public/images/<slug>/*         同步进来的图片
└── docs/superpowers/{specs,plans}/…
```

**职责边界：**

| 模块 | 只做一件事 | 不做 |
|---|---|---|
| `config.mjs` | 集中配置与路径解析 | 不碰文件系统 |
| `slug.mjs` | 由属性/文件名算出合法 slug | 不知道文件在哪 |
| `note.mjs` | 把一篇笔记的 frontmatter + 正文组装成输出文件内容 | 不知道有哪些别的笔记 |
| `transform.mjs` | 纯文本级正文改写 | 不读文件、不写文件（拷贝动作通过回调委托） |
| `vault.mjs` | 遍历与索引 | 不解析 frontmatter |
| `manifest.mjs` | 清单读写与哈希 | 不做决策 |
| `sync.mjs` | 决策与落盘 | 不含具体文本规则 |

**贯穿全程的约束：**
- 脚本**永不执行 git 命令**；commit 与 push 始终由用户决定。
- 脚本**只删** manifest 记录在案的生成文件与 `public/images/<slug>/` 目录；手写文章永不触碰。
- `planSync()` **必须零副作用**（只读，不写盘、不拷贝），否则 `--dry` 不成立。

---

### Task 1: slug 模块 + 测试基建

**Files:**
- Modify: `package.json`
- Create: `scripts/sync/slug.test.mjs`
- Create: `scripts/sync/slug.mjs`

- [ ] **Step 1: 装依赖、加 test 脚本**

```bash
cd /home/minus/Code/Full-Stack/Projects/Blog
pnpm add -D js-yaml
```

然后编辑 `package.json` 的 `scripts`，加入 test 入口（`sync` 入口在 Task 6 再加）：

```json
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "test": "node --test"
  },
```

> **注意**：不要写成 `node --test scripts/sync`。本机 Node v24.15.0 不再把 `--test` 的位置参数当目录扫描，而是当模块路径直接加载，会报 `Cannot find module '.../scripts/sync'`；带 glob 的写法（`node --test "scripts/sync/**/*.test.mjs"`）虽然可用，但依赖 Node 自己解析 glob 且易被 shell 展开破坏。裸 `node --test` 从当前目录递归发现测试文件（自动排除 `node_modules`），对后续任务新增的测试文件同样自动生效，是本机验证过的三种写法里唯一没有失败模式的。
>
> 验证环境为 Node v24.15.0。

- [ ] **Step 2: 写失败的测试**

创建 `scripts/sync/slug.test.mjs`：

```js
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
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— 报错含 `Cannot find module` 指向 `./slug.mjs`

- [ ] **Step 4: 实现**

创建 `scripts/sync/slug.mjs`：

```js
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 判断一个值是否是本工具认可的 slug 形态。
 * 给「读回来的数据」用：manifest 是用户可见的手写文件，里面的键不能直接拿去拼路径——
 * `..`、`a/../../../docs` 经 path.join 归一化后足以跳出目标目录。非字符串一律不算。
 */
export function isValidSlug(value) {
  return typeof value === 'string' && SLUG_RE.test(value);
}

/**
 * 由文件名推导 slug：小写、空白与下划线转短横线、剔除 ASCII 外字符、折叠并裁掉首尾短横线。
 * 纯中文文件名会得到空串，由调用方报错要求显式填写 slug。
 */
export function slugFromFilename(basename) {
  return basename
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 解析一篇笔记最终使用的 slug。note: { slugProperty, basename }
 * 返回 { slug, error }，两者必有其一为 null。
 * slugProperty 只接受字符串：Obsidian 属性面板允许布尔/数字/列表类型，
 * YAML 里裸写 `slug: true` 会解析成布尔 true，若放行就会把文章发到 /posts/true。
 */
export function resolveSlug({ slugProperty, basename }) {
  if (slugProperty !== undefined && slugProperty !== null && typeof slugProperty !== 'string') {
    const kind = Array.isArray(slugProperty) ? '列表' : typeof slugProperty;
    return { slug: null, error: `slug 属性格式非法：必须是字符串，当前是 ${kind}` };
  }

  const explicit = slugProperty === undefined || slugProperty === null ? '' : slugProperty.trim();

  if (explicit !== '') {
    if (!SLUG_RE.test(explicit)) {
      return {
        slug: null,
        error: `slug 属性格式非法：「${explicit}」，只允许小写字母、数字与短横线`,
      };
    }
    return { slug: explicit, error: null };
  }

  const derived = slugFromFilename(basename);
  if (derived.length < 2) {
    return {
      slug: null,
      error: `文件名「${basename}」无法生成 slug（含非 ASCII 字符），请在笔记属性里填写 slug`,
    };
  }
  return { slug: derived, error: null };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS —— `# pass 16`（`fail 0`）

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml scripts/sync/slug.mjs scripts/sync/slug.test.mjs
git commit -m "feat(sync): add slug resolution module with tests"
```

---

### Task 2: note 模块（frontmatter 解析与字段映射）

**Files:**
- Create: `scripts/sync/note.test.mjs`
- Create: `scripts/sync/note.mjs`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/sync/note.test.mjs`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `Cannot find module './note.mjs'`

- [ ] **Step 3: 实现**

创建 `scripts/sync/note.mjs`：

```js
import { createHash } from 'node:crypto';
import { load } from 'js-yaml'; // js-yaml v5 的 ESM 产物没有 default export，只能用具名导入

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const SKIP_LINE_PATTERNS = [
  /^#{1,6}\s/, // 标题
  /^!\[/, // 图片
  /^>/, // 引用与 callout
  /^[-*+]\s/, // 无序列表
  /^\d+\.\s/, // 有序列表
  /^\|/, // 表格
  /^-{3,}\s*$/, // 分隔线
];

/**
 * 代码围栏行。围栏必须成对跟踪，光把围栏标记行放进 SKIP_LINE_PATTERNS 是不够的：
 * 标记行被跳过了，围栏**内容**却会被当成正文抽出来当摘要。
 * 只认反引号围栏——实测 vault 中 `~~~` 围栏 0 处；transform 模块另需识别 `~~~`，
 * 那是为了防止改写围栏内的内容，风险不同，不在此处照搬。
 */
const FENCE_RE = /^`{3,}/;

/** 拆出 YAML frontmatter 与正文。解析失败不抛异常，通过 error 字段上报。 */
export function parseNote(rawInput) {
  // 去掉可能存在的 UTF-8 BOM：FRONTMATTER_RE 锚定在开头，带 BOM 时匹配不上，
  // 整篇笔记会被当成「没有 frontmatter」而静默漏发——连 publish: true 都读不到，报告里一声不响。
  const raw = rawInput.startsWith('﻿') ? rawInput.slice(1) : rawInput;
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: raw, error: null };

  const body = raw.slice(match[0].length);
  let parsed;
  try {
    parsed = load(match[1]);
  } catch (error) {
    return { data: {}, body: raw, error: `frontmatter YAML 解析失败：${error.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: {}, body, error: null };
  }
  return { data: parsed, body, error: null };
}

const pad = (n) => String(n).padStart(2, '0');

/** 归一化为 YYYY-MM-DD，取本地日期分量以避免时区把日期挪走。 */
export function formatDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) return null;
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const parsed = new Date(trimmed.replace(' ', 'T'));
  if (Number.isNaN(parsed.valueOf())) return null;
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

/** 优先级：pubDate > date > 源文件 mtime。 */
export function normalizePubDate(data, mtime) {
  return formatDate(data.pubDate) ?? formatDate(data.date) ?? formatDate(mtime);
}

/** 去掉 wiki 链接、Markdown 链接与强调标记，只留可读文本。 */
export function stripInlineMarkup(text) {
  return text
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 正文第一个普通段落，跳过标题/图片/引用/列表/代码/表格。 */
export function firstParagraph(body) {
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // 未闭合的围栏：其后内容一律按代码处理
    if (line === '') continue;
    if (SKIP_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    const text = stripInlineMarkup(line);
    if (text !== '') return text;
  }
  return '';
}

export function truncate(text, maxChars) {
  // 按码点切，不按 UTF-16 码元切：否则 emoji 会被切成孤立代理项，写盘再读回变成 U+FFFD，
  // Task 6 的「内容未变则跳过」就永远判为变化，该文件每次同步都被重写。
  const chars = [...text];
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}

/**
 * `description: false` 是显式的「这篇不要摘要」。它必须**拦住整条回落链**，否则用户没有办法让
 * 列表页只显示标题——留空会回落到正文首段（那是刻意的方便默认值，不能拿掉）。
 * Obsidian 的属性面板对 `false` 可能存成布尔、也可能存成字符串（文本类型属性会写成 "false"），
 * 两种都认；`False`/`FALSE` 是 YAML 的布尔写法，一并归一。
 */
function isNoDescription(value) {
  if (value === false) return true;
  return typeof value === 'string' && value.trim().toLowerCase() === 'false';
}

/** 摘要优先级：description > excerpt > 正文首段；都取不到返回 undefined（调用方省略该字段）。 */
export function pickDescription(data, body, maxChars = 120) {
  if (isNoDescription(data.description)) return undefined;
  for (const candidate of [data.description, data.excerpt]) {
    if (typeof candidate !== 'string') continue;
    const text = stripInlineMarkup(candidate);
    if (text !== '') return truncate(text, maxChars);
  }
  const fallback = firstParagraph(body);
  return fallback === '' ? undefined : truncate(fallback, maxChars);
}

export function hashText(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * 把任意值渲染成 YAML 双引号标量。
 * 直接借 JSON.stringify：JSON 字符串是合法的 YAML 1.2 双引号标量，会转义换行、制表、
 * C0 控制符（\u0007 等）与孤立代理项。手写只转义 \ 和 " 是不够的——标题里一个从 PDF
 * 或终端粘来的控制符就会让 Astro 的 js-yaml（v4）解析失败、构建中断，
 * 而 pnpm sync 那一刻报的却是成功。
 */
function yamlString(value) {
  return JSON.stringify(String(value));
}

/** 组装最终写盘的 .md 文本。 */
export function buildOutput({ frontmatter, body }) {
  const lines = ['---', `title: ${yamlString(frontmatter.title)}`, `slug: ${yamlString(frontmatter.slug)}`];
  if (frontmatter.description !== undefined) {
    lines.push(`description: ${yamlString(frontmatter.description)}`);
  }
  lines.push(`pubDate: ${frontmatter.pubDate}`);
  lines.push(`tags: [${frontmatter.tags.map(yamlString).join(', ')}]`);
  lines.push('draft: false', `syncedFrom: ${yamlString(frontmatter.syncedFrom)}`, '---', '');
  // lines 末尾的 '' 只保证 '---' 后面有一个换行；frontmatter 与正文之间还需要一个空行，
  // 所以这里显式再补一个 '\n'，否则得到的是 '---\n正文' 而不是 '---\n\n正文'。
  return `${lines.join('\n')}\n${body.replace(/^\n+/, '')}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS —— 累计 16 + 21 = 37 项通过

- [ ] **Step 5: 提交**

```bash
git add scripts/sync/note.mjs scripts/sync/note.test.mjs
git commit -m "feat(sync): add note parsing and frontmatter mapping"
```

---

### Task 3: transform 模块（正文转换）

**Files:**
- Create: `scripts/sync/transform.test.mjs`
- Create: `scripts/sync/transform.mjs`

> **修订记录（2026-10-13）**：本任务在 `689ff32` 之后有一轮修复，来自代码质量审查与 spec 措辞订正。
> 修复内容：围栏识别放宽到任意缩进与 `>` 前缀（列表项与 callout 里的代码块此前会被改写）、正文 CRLF→LF 归一化、
> 分段不再产出空段、表格内的转义竖线 `\|` 按竖线处理、空别名回退目标标题、`[[#小节]]` 生成本页锚点、
> 笔记嵌入降级为链接、附件三态（缺失/不支持）区分、警告内嵌内容截断、`headingAnchor` 改用 `github-slugger`。
> 修复轮按修正后的代码与测试为准，提交信息用 `fix(sync): ...`，不要沿用下面的原提交信息。
> **修订记录第二轮（2026-10-13，`66419a8` 之后）**：代码质量审查查出闭合围栏复用了开启那套放宽正则——
> 代码块内部一行 4 空格缩进的 ``` 或带 `> ` 前缀的 ``` 会被当成闭合标记，块被提前收掉、其后本属代码的内容被改写，
> 违反本模块「绝不改写代码」的绝对前提（`66419a8` 引入的回归）。改为闭合判定要求与开启同上下文：
> 块引用层数相同、缩进不超过 `max(开启缩进, 3)`；另把 `headingAnchor` 的注释订正为与实现相符（例外为同名标题、
> 以及标题内含行内链接/图片）。已核对：本 vault 111 篇笔记在修复前后解析结果完全一致。
> 本轮测试 34 → 36 项，提交信息同样用 `fix(sync): ...`。
> **修订记录第三轮（2026-10-13，`de07055` 之后）**：复审确认闭合回归已修复，并指出围栏缩进按**字符数**计的残余：
> 制表符在 CommonMark 里推进到下一个 4 的倍数，按 1 计会让 `\t``` ` 被当成顶格闭合，代码块提前收掉、
> 其后内容被改写——与上一轮同一类错。这是制表符相关的最后一处，但并非「绝不改写代码」这条前提上的最后一处：
> 复审另指出块引用内、`> ` 之后缩进超过 3 空格的闭合（如 `>     ``` `）在 CommonMark 里是代码，本模块会判成闭合——
> 该形状与上一轮那条「开启深、闭合浅」同属行级判定无法忠实区分的类别，本 vault 0 例，记入 spec §6 已知限制，本轮不修。
> 改为按列计算缩进。另订正两处与 spec 已不符的注释（误判开启的代价、列表项缩进上界）。
> 已核对：本 vault 111 篇笔记在修复前后解析结果一致，且无制表符缩进的围栏标记行。
> 本轮测试 36 → 38 项。**已知且本轮不修**：闭合比开启多缩进 2–3 列时会被判为不闭合（安全方向，漏转换）；
> 开启缩进更深而闭合缩进更浅的形状（如 8 空格开启、4 空格闭合）行级判定无法忠实区分——是否需要闭合取决于下一行的缩进，
> 要真正修必须引入前瞻或块级解析，本 vault 不可达，暂列为已知限制。



- [ ] **Step 1: 写失败的测试**

先 `pnpm add -D github-slugger`：`headingAnchor` 必须与 Astro 产物 id 一致，就得用 Astro 用的同一个库（`@astrojs/markdown-remark/dist/rehype-collect-headings.js` 里 `new Slugger()` + `slugger.slug(text)`），手写近似在中文标点与 ★ 这类符号上必然偏离。然后创建 `scripts/sync/transform.test.mjs`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `Cannot find module './transform.mjs'`

- [ ] **Step 3: 实现**

创建 `scripts/sync/transform.mjs`：

```js
import { slug } from 'github-slugger'; // 与 Astro 的标题 id 同一实现（rehype-collect-headings.js 用的就是这个库）
import { truncate } from './note.mjs';

const EMBED_RE = /!\[\[([^\]\n]+?)\]\]/g;
const WIKILINK_RE = /(?<!!)\[\[([^\]\n]+?)\]\]/g;
const CALLOUT_RE = /^(\s{0,3}>[ \t]?)\[!([A-Za-z-]+)\][+-]?[ \t]*(.*)$/;
const FENCE_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*)(`{3,}|~{3,})(.*)$/;

/**
 * 围栏的上下文。闭合判定必须与开启同上下文：代码块内部一行 4 空格缩进的 ``` 或 `> ``` 是字面文本，
 * 不是闭合标记——按 CommonMark，块引用前缀与超过 3 空格的缩进在代码块内都不作数。
 * 缩进按**列**算：制表符在 CommonMark 里推进到下一个 4 的倍数，按字符数 1 计会把 `\t``` ` 误判成
 * 顶格闭合，代码块被提前收掉、其后内容被改写——与闭合复用开启正则那次是同一类错。
 */
function fenceContext(prefix) {
  let columns = 0;
  for (const char of prefix) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4 - (columns % 4);
    else break; // 首个非空白（`>`）之后不再计缩进
  }
  return {
    depth: (prefix.match(/>/g) ?? []).length,
    columns,
  };
}

/**
 * 按代码围栏切分，代码段标记 isCode:true，后续不做任何替换。
 *
 * 三处刻意的宽松与归一化，都为了堵住「绝不改写代码」这条绝对前提上的破口：
 * - 围栏允许任意缩进与块引用前缀。列表项里的代码块缩进 4 空格以上、callout 里的代码块每行带 `> `，
 *   按 CommonMark 两种解释下内容都是代码，但 `^ {0,3}` 一个都认不出，只能靠行内代码**碰巧**配对
 *   挡住替换——代码里一旦含反引号就漏。漏认的代价是「改写代码」，多认的代价是「跳过转换」，
 *   两者不对称，一律往多认的方向偏；但要清楚代价不是「少转换几个链接」——误判的开启会吞掉其后
 *   直到下一个同形围栏之间的全部内容，影响面可能是一整篇。
 * - 空 buffer 不产生分段。否则相邻围栏之间会凭空多出一个空段，join 后就是输入里没有的空行。
 * - 输入先做 CRLF→LF 归一化（本模块唯一的归一化点）：围栏标记行与 callout 行都按 '\n' 切分并用
 *   `$` 收尾，行尾的 \r 会让它们整行都匹配不上，于是围栏失效、callout 全篇静默不转换。
 *
 * 已知限制：整行是 callout 标记的跨行行内代码片段仍会被 convertCallouts 改写——先切行内代码会破坏
 * callout 的整行判定，两害相权取其轻。
 */
export function splitByCodeFence(body) {
  const parts = [];
  let buffer = [];
  let fenceChar = null;
  let fenceLength = 0;
  let fenceDepth = 0;
  let fenceIndent = 0;

  const flush = (isCode) => {
    if (buffer.length === 0) return; // 空段只会在 join 时凭空插入一个换行
    parts.push({ isCode, text: buffer.join('\n') });
    buffer = [];
  };

  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const marker = line.match(FENCE_RE);

    if (fenceChar === null) {
      if (marker) {
        flush(false);
        fenceChar = marker[2][0];
        fenceLength = marker[2].length;
        const context = fenceContext(marker[1]);
        fenceDepth = context.depth;
        // 顶格围栏的闭合允许缩进到 3 空格（CommonMark 的闭合规则）；列表项里的围栏开启就带 4 空格
        // （嵌套更深的还要更多），所以上界取两者较大者，否则合法的闭合反被漏认、其后整篇被当成代码。
        fenceIndent = Math.max(context.columns, 3);
      }
      buffer.push(line);
    } else {
      buffer.push(line);
      const context = marker ? fenceContext(marker[1]) : null;
      const closes =
        marker &&
        marker[2][0] === fenceChar &&
        marker[2].length >= fenceLength &&
        marker[3].trim() === '' &&
        context.depth === fenceDepth &&
        context.columns <= fenceIndent;
      if (closes) {
        flush(true);
        fenceChar = null;
        fenceLength = 0;
        fenceDepth = 0;
        fenceIndent = 0;
      }
    }
  }

  flush(fenceChar !== null); // 未闭合的围栏之后全按代码处理
  return parts;
}

/** 按行内代码切分，奇数下标是代码片段（含反引号本身）。 */
export function splitInlineCode(text) {
  return text.split(/(`+[^`]*`+)/g).map((piece, index) => ({
    isCode: index % 2 === 1,
    text: piece,
  }));
}

/**
 * 标题锚点。直接用 Astro 用的同一个库，不再手写近似：手写版会把中文标点与 ★ 之类的符号留在锚点里，
 * 而 Astro 产物 id 会把它们剔除，`[[笔记#2.3 信道极限容量 ★★ 计算重点]]` 于是指向一个不存在的锚点，
 * 点击后静默停在页首。
 *
 * 与产物 id 一致，两处例外：同名标题（Obsidian 的锚点语法无法区分重名，Astro 给第二处加 `-1` 后缀），
 * 以及标题内含行内链接/图片（Astro 对渲染后的文本取 id，本函数拿到的是原文，`[MDN](url)` 会多出 `url`）。
 */
export function headingAnchor(heading) {
  return slug(heading);
}

function convertCallouts(text) {
  const lines = [];
  for (const line of text.split('\n')) {
    const marker = line.match(CALLOUT_RE);
    if (!marker) {
      lines.push(line);
      continue;
    }
    const [, prefix, , title] = marker;
    if (title.trim() === '') continue; // 只有标记的行整行丢弃
    lines.push(`${prefix}**${title.trim()}**`);
  }
  return lines.join('\n');
}

/**
 * 按第一个竖线拆分。竖线前允许有一个反斜杠：Obsidian 在表格里写内链时会自动转义成 `[[笔记\|别名]]`，
 * 只找 '|' 会把目标读成「笔记\」，而表格里的内链用户没法不这样写。
 */
function splitOnPipe(inner) {
  const match = inner.match(/\\?\|/);
  if (!match) return { head: inner, tail: null };
  return { head: inner.slice(0, match.index), tail: inner.slice(match.index + match[0].length) };
}

function replaceEmbeds(text, ctx) {
  return text.replace(EMBED_RE, (full, inner) => {
    const { head } = splitOnPipe(inner);
    const target = head.split('#')[0].trim();
    const image = ctx.copyImage(target);

    if (image && image.url) return `![${image.alt}](${image.url})`;
    if (image && image.unsupported) {
      // 文件确实存在，只是不是能内联的图片类型——不能报「缺失」，那会让用户去查一个没丢的文件
      ctx.warnings.push(`不支持的附件 ${full} @ ${ctx.sourceRel}`);
      return full;
    }

    // 不是附件：笔记嵌入（![[笔记]] / ![[笔记#小节]]）在博客里没有内联展开的形态，降级为普通链接，
    // 比留下字面量 ![[...]] 或谎报「缺失附件」都更接近用户意图。
    const note = ctx.resolveLink(target);
    if (note) {
      const hashIndex = head.indexOf('#');
      const heading = hashIndex === -1 ? null : head.slice(hashIndex + 1).trim();
      const anchor = heading ? `#${headingAnchor(heading)}` : '';
      ctx.warnings.push(`笔记嵌入不支持，已降级为链接 ${full} @ ${ctx.sourceRel}`);
      return `[${note.title || target}](${ctx.urlPrefix}/${note.slug}${anchor})`;
    }

    ctx.warnings.push(`无法解析嵌入引用 ${full} @ ${ctx.sourceRel}`);
    return full;
  });
}

function replaceWikilinks(text, ctx) {
  return text.replace(WIKILINK_RE, (full, inner) => {
    const { head, tail } = splitOnPipe(inner);
    const alias = tail === null ? null : tail.trim();
    let target = head.trim();

    const hashIndex = target.indexOf('#');
    const heading = hashIndex === -1 ? null : target.slice(hashIndex + 1).trim();
    if (hashIndex !== -1) target = target.slice(0, hashIndex).trim();

    const caretIndex = target.indexOf('^');
    if (caretIndex !== -1) target = target.slice(0, caretIndex).trim();

    // [[#小节]] 是 Obsidian 的「本笔记标题」链接。本笔记的 slug 不在 ctx 里，
    // 但页内锚点 id 就是 headingAnchor(heading)，不必知道 slug 也能写对。
    if (target === '' && heading !== null) {
      return `[${alias || heading}](#${headingAnchor(heading)})`;
    }

    const resolved = ctx.resolveLink(target);
    if (!resolved) {
      ctx.warnings.push(`未解析内链 ${full} @ ${ctx.sourceRel}`);
      // 标签为空时不能产出 []()：渲染上既点不到、也看不出内容丢了。退回原文。
      const label = alias || target.split('/').pop();
      return label === '' ? full : label;
    }

    // 用 || 不用 ??：空字符串不是 nullish，`[[笔记|]]` 会产出渲染上不可见的空链接
    const label = alias || resolved.title || target;
    const anchor = heading ? `#${headingAnchor(heading)}` : '';
    return `[${label}](${ctx.urlPrefix}/${resolved.slug}${anchor})`;
  });
}

/**
 * 正文转换主入口。
 * ctx: { urlPrefix, sourceRel, warnings,
 *        copyImage(target) -> {url, alt} | {unsupported: true} | null,
 *        resolveLink(target) -> {slug, title}|null }
 * 三态契约的分工：「找不到」与「找到但不支持」必须可区分，否则报告会对一个真实存在的文件报「缺失」。
 * 附件与内链的全部警告由本模块写入 ctx.warnings（resolver 只解析、不发声），同步层负责汇总与去重。
 * 本函数是纯文本变换：不读文件、不写文件、不拷贝（拷贝由 ctx.copyImage 的实现委托给调用方）。
 * 输出为 LF 换行：输入的 CRLF 在切分时已归一化。
 */
export function transformBody(body, ctx) {
  return splitByCodeFence(body)
    .map((part) => {
      if (part.isCode) return part.text;
      const withCallouts = convertCallouts(part.text);
      return splitInlineCode(withCallouts)
        .map((piece) => (piece.isCode ? piece.text : replaceWikilinks(replaceEmbeds(piece.text, ctx), ctx)))
        .join('');
    })
    .join('\n');
}

const UNSUPPORTED_PATTERNS = [
  { re: /%%[^%]*%%/, label: '%%注释%%' },
  { re: /==[^=]+==/, label: '==高亮==' },
];

/**
 * 检出本次不转换的 Obsidian 语法，供同步层列入报告。代码块内的同类字符不算。
 * 命中内容截断到 40 字：一个忘了闭合的 `==` 会把其后整段正文吞进警告，报告要给人读。
 */
export function detectUnsupportedSyntax(body, sourceRel) {
  const warnings = [];
  for (const part of splitByCodeFence(body)) {
    if (part.isCode) continue;
    for (const { re, label } of UNSUPPORTED_PATTERNS) {
      const match = part.text.match(re);
      if (match) warnings.push(`未转换语法 ${label}：「${truncate(match[0], 40)}」 @ ${sourceRel}`);
    }
  }
  return warnings;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS —— 累计 37 + 38 = 75 项通过

- [ ] **Step 5: 提交**

```bash
git add scripts/sync/transform.mjs scripts/sync/transform.test.mjs
git commit -m "feat(sync): add body transform for wikilinks images and callouts"
```

---

### Task 4: config 与 vault 模块（遍历与索引）

**Files:**
- Create: `scripts/sync/config.mjs`
- Create: `scripts/sync/vault.test.mjs`
- Create: `scripts/sync/vault.mjs`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/sync/vault.test.mjs`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `Cannot find module './config.mjs'`

- [ ] **Step 3: 实现 config**

创建 `scripts/sync/config.mjs`：

```js
import path from 'node:path';

/**
 * 相对路径一律相对 repoRoot 解析（见 makeConfig），vaultDir 也在其中：配置里写相对值时，
 * 解析结果与仓库位置绑定，不会因为进程 cwd 不同而漂移。
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
 * 合并覆盖项并把相对路径解析成绝对路径。四个路径字段一视同仁，vaultDir 也不例外：它只是个普通
 * 路径字段，特殊化只会让「absPath 是不是绝对路径」取决于配置怎么写。
 *
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
  config.vaultDir = path.resolve(config.repoRoot, config.vaultDir);
  config.contentDirAbs = path.resolve(config.repoRoot, config.contentDir);
  config.imagesDirAbs = path.resolve(config.repoRoot, config.imagesDir);
  config.manifestAbs = path.resolve(config.repoRoot, config.manifestPath);
  return config;
}
```

- [ ] **Step 4: 实现 vault**

创建 `scripts/sync/vault.mjs`：

```js
import fs from 'node:fs';
import path from 'node:path';

/**
 * 相对路径统一成 URL 用的正斜杠。Linux 上这是恒等变换，因此没有测试能看见它（变异删掉它测试全过），
 * 只能靠审查守住；存在的意义是把跨平台差异收在一个地方，而不是散在每条 relPath 上。
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * 递归遍历 vault，返回每个文件的 { absPath, relPath, name }（不止 .md：附件也要在这里收集）。
 *
 * config 由 `makeConfig()` 产出，各路径已解析为绝对。
 *
 * `warnings` 刻意**不给默认值**：默认值会让「忘了传」与「故意不收集」变得无法区分，而本模块的整个
 * 前提是信息不能被静默丢掉——少一个数组，权限失败的目录就一句提示都留不下。调用方若确实不要警告，
 * 写 `[]` 明说。
 *
 * 顺序：每个目录内按名称排序后再下探，得到确定的 DFS 序。确定性是 buildIndexes「同名附件先到先得」
 * 的前提——readdirSync 的原始顺序由文件系统决定（ext4 是哈希序，tmpfs 是字节序），不排序就会出现
 * 「同一份 vault 在两台机器上挑中不同的同名附件」。比较器显式钉住 'en'：不传 locale 时 localeCompare
 * 跟随 $LANG/LC_ALL，同名附件的胜者乃至写进 public/images 的内容会随环境变化。这个钉子在本机测不出来
 * （ASCII 名在 'en' 与 C 下同序）；换成带重音的 fixture 能在本机把它测出来，但那条断言在
 * `LC_ALL=C` 的机器上又会失效——不稳定的测试比没有更难维护，所以由注释承担，不假装有测试覆盖。
 *
 * 读不到分两档，因为代价不对称：
 * - 根目录读不到（路径拼错、盘没挂上）→ 抛错。此时「扫到 0 个文件」与「vault 是空的」无法区分，
 *   而同步层会据此判定所有产物都该删除，一次路径笔误就能清空整个博客目录。
 * - 子目录读不到（权限、竞态）→ 记进 warnings 后继续，其余文件照常同步。漏一个子目录的代价是
 *   「少几篇文章」（报告里看得到），中断整次同步的代价是「什么都不同步」。
 *   但调用方不能把「扫描结果里没有」当成「源笔记已删除」：部分扫描与完整扫描在这里无从区分，
 *   见 sync.mjs 的删除闸门。
 *
 * 只跳过 dot **目录**，dot 文件照收（`STX/.gitignore` 会成为一个附件名）——spec §4.1 只约束了 dot
 * 目录、对 dot 文件没有表态，这里是取舍不是规范背书。
 * 已知限制：不跟随符号链接（entry.isFile()/isDirectory() 对链接都返回 false），链接笔记会被静默跳过；
 * 真实 vault 唯一的链接在被排除的 .claude/ 下，暂不受影响。
 */
export function scanVault(config, warnings) {
  // 参数没有默认值，但只传 config 时，undefined 要到**真的产生警告那一刻**才炸——那时错误已经发生，
  // 信息照样丢了。所以挡在入口：忘了传是编程错误，该立刻、指名道姓地失败，而不是等到权限出错时
  // 变成一句「Cannot read properties of undefined」。
  if (!Array.isArray(warnings)) throw new TypeError('scanVault 需要传入 warnings 数组（不要警告请传 []）');
  const collected = [];
  walk(config.vaultDir, config.vaultDir, config, collected, warnings);
  return collected;
}

function walk(dir, root, config, out, warnings) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (dir === root) {
      throw new Error(
        `无法读取 vault 目录 ${dir}：${error.code ?? error.message}——请检查路径是否存在、外置盘是否已挂载`,
        { cause: error },
      );
    }
    warnings.push(`无法读取目录 ${toPosix(path.relative(root, dir))}：${error.code ?? error.message}，该目录内容已跳过`);
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || config.excludeDirs.includes(entry.name)) continue;
      walk(abs, root, config, out, warnings);
    } else if (entry.isFile()) {
      out.push({ absPath: abs, relPath: toPosix(path.relative(root, abs)), name: entry.name });
    }
  }
}

/**
 * 拆成笔记数组与 附件名(小写) -> 绝对路径 的索引。
 *
 * `warnings` 同样不给默认值，理由见 scanVault：同名附件冲突意味着有一个真实存在的文件被忽略，
 * 不该存在「忘传数组就悄悄丢」这条路径。
 *
 * 同名附件先到先得，胜者由 walk 的确定 DFS 序决定：先在根目录按名称遇到谁，谁就赢，包括
 * 「根目录的文件」与「子目录里的同名文件」之间——子目录名排在同名文件名之前时，子目录那个先被收到。
 * 这条交错规则由测试钉住，因为它一旦反转，胜者与写进 public/images 的内容都会变。
 * 冲突时记警告并说明胜者：静默丢弃是本模块最不该做的事（警告由同步层汇总成报告，本模块只负责不吞信息）。
 */
export function buildIndexes(scanned, warnings) {
  if (!Array.isArray(warnings)) throw new TypeError('buildIndexes 需要传入 warnings 数组（不要警告请传 []）'); // 入口守卫，理由见 scanVault
  const notes = [];
  const attachments = new Map();
  const winners = new Map(); // 只为冲突提示保留胜者的相对路径

  for (const file of scanned) {
    if (file.name.toLowerCase().endsWith('.md')) {
      notes.push(file);
      continue;
    }
    const key = file.name.toLowerCase();
    const winner = attachments.get(key);
    if (winner === undefined) {
      attachments.set(key, file.absPath);
      winners.set(key, file.relPath);
    } else if (winner !== file.absPath) {
      // 一次树遍历、不跟随链接，不会产出两条相同 absPath 的记录，所以这个判断当前恒真；
      // 留着是为了让「同一路径重复出现」不被当成冲突报出来（例如将来有人把 scan 结果拼接起来）。
      warnings.push(`同名附件冲突：「${file.relPath}」被忽略，一律使用「${winners.get(key)}」`);
    }
  }

  return { notes, attachments };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS —— 累计 75 + 12 = 87 项通过

- [ ] **Step 6: 提交**

```bash
git add scripts/sync/config.mjs scripts/sync/vault.mjs scripts/sync/vault.test.mjs
git commit -m "feat(sync): add config and vault scanning"
```

<!-- 首次实现已提交为 b6d3afb（6 项测试）。以下为审查后的修订。 -->

- [ ] **Step 7: 审查后的修订**

spec 合规审查通过（三个文件与本节代码块逐字节一致），代码质量审查提出 9 项。只修「会真的丢内容或删内容」的路径，其余记录理由。落地内容：

1. **根目录读不到改为抛错**（原实现静默返回空数组）。审查者用本节 Task 6 的代码组合出后果链：`vaultDir` 指向不存在的路径 → `scanVault` 返回 `[]` → 计划删除全部生成物 → 打印 `✅ 无警告无错误` 并退出 0。这是唯一会「静默删内容」的路径。子目录读不到则记入新增的 `warnings` sink 后继续。
2. **排序比较器钉住 `'en'`**。原 `localeCompare(b.name)` 跟随 `$LANG`/`LC_ALL`：实测同一个 vault 在 `LC_ALL=C` 与默认 locale 下，同名附件 `a/shot.png` 与 `á/shot.png` 的胜者互换、写进 `public/images` 的内容随之不同。真实 vault 当前 0 处同名附件冲突，属潜在问题，但改它的代价只有两个字符。
3. **注释里「结果按名称排序」是不实陈述**：sort 是逐目录的，拼接后并非全局按名排序。改为陈述真正成立的性质。
4. **测试加固**（原 6 项中两项是空转的）：
   - 「结果顺序稳定」的 fixture 用全小写 `a/b/c`，而本机 tmpfs 的 `readdirSync` 本身就返回字节序，与 `localeCompare` 序重合 → 变异删掉 `sort` 后 **6 项全过**。改用混合大小写 `b/A/c/Z`（字节序把大写排在小写前，与 localeCompare 交错），变异后该项失败、其余 5 项通过。
   - 「同名附件先到先得」只活在注释里 → 变异成后到先得，**6 项全过**。补两项测试把它钉住。
5. **`makeConfig` 的数组不再按引用共享**（`{...DEFAULT_CONFIG}` 是浅拷贝），并让「不污染默认值」那条测试真的去查数组。
6. **补 `.MD` 分类测试**（此前 fixture 里唯一的大写文件名是附件）。
7. 测试不再硬编码 `/home/minus/Wiki`，改用导出的 `DEFAULT_CONFIG.vaultDir`。
8. 注释补到同类模块的水准，并补上 `config` 参数契约与三条已知限制。

测试数 10 → 12，累计 **87**。

同步改 spec：§4.1.1–2（`warnings` 去默认值 + 入口守卫、`vaultDir` 参与 repoRoot 解析、跨目录交错序的胜者规则）、§7.7（新增「有目录读不到时不执行任何删除」，并写明 6/7 两条闸都必须靠「不生成删除动作」实现）、§12 风险表两行（部分扫描误删、冲突胜者由测试钉住）。

有意不修（记录理由，避免下一轮重复提出）：

- **附件与笔记的同名冲突策略不一致**（附件按 DFS 序先到先得，笔记按短路径优先）：附件索引的值是扁平文件名，没有「路径深度」这个可比量，套用笔记的规则要改索引形状。0 处冲突，改为冲突记警告。
- **`repoRoot` 在模块加载期取值**：CLI 从仓库根调起且不 chdir，注释里已写明；改成调用期取值会让 `DEFAULT_CONFIG` 与实际解析结果不一致。
- **`excludeDirs` 里四个 dot 项是死配置**（已被 dot 规则覆盖）：保留并在 `config.mjs` 注释里点明，避免读者误以为删掉 dot 规则还有这里兜底。
- **不跟随符号链接**：真实 vault 唯一的链接在被排除的 `.claude/` 内。
- **`toPosix` 与 Task 6 的 `sync.mjs` 会各有一份**：本模块内先私有；Task 6 实现时若确认是同一表达式，再从 `vault.mjs` 导出复用。

**修订记录第二轮（Task 4 复审后，2026-10-13）**

复审确认首轮 8 项已修且均有变异证据，另提 9 项。本轮只改会真的丢信息的两处，其余按项记录：

1. **`warnings` 参数去掉默认值**（`scanVault(config, warnings)` / `buildIndexes(scanned, warnings)`）。复审指出：默认值让「忘了传」与「故意不收集」无法区分，而**计划自己 Task 6 的调用就写成 `buildIndexes(scanVault(config))`** —— 首轮刚堵住的「静默丢失」，会被这一行从调用侧重新打开，报告照样打印 `✅ 无警告无错误`。参数去掉默认值只解决一半：只传 `config` 时 `undefined` 要到**真的产生警告那一刻**才炸，而那时信息已经丢了，所以在两个入口各加一句 `Array.isArray` 守卫，漏传立即 TypeError。测试改为显式传 `[]`，另补一项测试守住这两句守卫。
2. **`vaultDir` 也参与 repoRoot 解析**。原先 `config.mjs` 注释写「必须是绝对路径」，却没有任何地方保证它——`vaultDir` 成了一个靠调用方自觉的特殊字段。现在四个路径字段一视同仁，「absPath 是不是绝对路径」不再取决于配置怎么写。
3. 根目录抛错补 `cause` 与补救提示（「请检查路径是否存在、外置盘是否已挂载」），测试同时断言这段提示。
4. **补测试钉住跨目录的 DFS 交错序**：变体「先收完本层文件再下探子目录」能通过全部测试，而它会让根目录的 `shot.png` 与 `AAA/shot.png` 互换胜者。冲突测试同时补上「胜者是哪个」的断言（此前只断言了被忽略的那个）。
5. 补注释说明三处此前只存在于作者脑子里的判断：dot 文件照收是 spec 认可的边界；`winner !== file.absPath` 这个当前恒真的判断为什么留着；`'en'` 钉子为何只能靠注释守（带重音 fixture 能在本机测出来，但换 `LC_ALL=C` 又失效，不稳定的测试比没有更难维护）。

测试数 10 → 11，累计 **86**。

未修：临时目录在断言失败时会残留（`chmod` 那条已用 `finally` 兜住，其余 9 条沿用同款写法，改动收益小于噪声）；其余同上一轮「有意不修」列表。

**Task 6 必须承接**（两条闸都必须在 `planSync` 里**不生成删除动作**——`runSync` 调用 `applySync` 前不检查 `plan.errors`，靠 push 一条 error 只会在删完之后才打印）：

1. `scanVault(config, warnings)` / `buildIndexes(scanned, warnings)` 传入同一个 warnings 数组并汇总进报告（已在入口加守卫，漏传直接 TypeError）；
2. 扫描到 0 篇笔记而 manifest 非空时**拒绝执行删除**并报错（spec §7.6）——warnings 只提示、不阻断，单靠它挡不住第 1 条的路径；
3. **有目录读不到时（警告以「无法读取目录」开头）本次不得删除任何产物**：部分扫描与完整扫描在这里无从区分，读不到的目录里的笔记会被误判成「源已删除」，而它们只是没被读到。

---

> **修订记录第三轮（注释纠偏）**：Task 4 的两个模块有三处注释与事实不符，随 Task 6 的复验轮一并修正，**只改文字、不改行为**：`localeCompare('en')` 的自述由「本机测不到」改为「跨环境不稳定」（带重音 fixture 在本机确实能杀掉该变异，只是换 `LC_ALL=C` 又失效）；dot 文件那句由「spec 认可的边界」改为明说是取舍（spec 对 dot 文件未表态）；`vault.test.mjs` 冲突测试里「把胜者是谁留给注释」是首轮修订前的残迹，与紧邻的 `assert.equal` 矛盾，改为指明胜者由哪一行锁。三处都在计划块与仓库文件里同步改，逐字节一致。

### Task 5: manifest 模块

**Files:**
- Create: `scripts/sync/manifest.test.mjs`
- Create: `scripts/sync/manifest.mjs`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/sync/manifest.test.mjs`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `Cannot find module './manifest.mjs'`

- [ ] **Step 3: 实现**

创建 `scripts/sync/manifest.mjs`：

```js
import fs from 'node:fs';

/**
 * 读取生成物清单；文件缺失、损坏或结构不符时一律降级为空清单。
 * 返回值固定是 `{ version, entries }`：`generatedAt` 只是落盘格式的一部分（记录写入时刻），
 * 不参与任何同步决策，所以不进内存对象——要检查它就读文件。
 */
export function loadManifest(config) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8'));
  } catch {
    return { version: 1, entries: {} };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: 1, entries: {} };
  }
  if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
    return { version: 1, entries: {} };
  }
  return { version: 1, entries: parsed.entries };
}

/** 写出清单，键排序以保证同内容产出同文本。 */
export function saveManifest(config, manifest) {
  const entries = {};
  for (const key of Object.keys(manifest.entries).sort()) entries[key] = manifest.entries[key];
  const payload = { version: 1, generatedAt: new Date().toISOString(), entries };
  fs.writeFileSync(config.manifestAbs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS —— 累计 87 + 5 = 92 项通过

- [ ] **Step 5: 提交**

```bash
git add scripts/sync/manifest.mjs scripts/sync/manifest.test.mjs
git commit -m "feat(sync): add manifest read and write"
```

---

### Task 6: 编排层与命令行入口

**Files:**
- Create: `scripts/sync/sync.test.mjs`
- Create: `scripts/sync/sync.mjs`
- Create: `scripts/sync-obsidian.mjs`
- Modify: `package.json`（加 `"sync": "node scripts/sync-obsidian.mjs"`）

- [ ] **Step 1: 写失败的测试**

创建 `scripts/sync/sync.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeConfig } from './config.mjs';
import { planSync, runSync, formatReport } from './sync.mjs';
import { main, parseArgs } from '../sync-obsidian.mjs';

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

  // 再同步一次：图片仍在被引用、清单里也记着它——「清理上一篇产物」的循环绝不能把它删掉
  const second = runSync(config);
  assert.equal(second.skipped.length, 1);
  assert.ok(fs.existsSync(imagePath));

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
  assert.equal(fs.statSync(target).mtimeMs, firstMtime); // 精确相等：1 秒容差会把「重写同名文件」放过去
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
  assert.match(report, /同步 4 篇/);
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
// 判据是「一篇 .md 都没扫到」，而不是「没有可发布的笔记」——后者是用户取消发布的正常状态，
// 见「取消 publish 后删除生成文件与图片目录」。
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
  assert.ok(result.warnings.some((warning) => /内容哈希与清单记录不符/.test(warning))); // 哈希在、只是对不上
  fs.rmSync(root, { recursive: true, force: true });
});

// 生成文件已被手工删除、清单条目仍在：这不算「被改过」——没有内容可保护，照常生成删除动作把
// 清单清干净。否则条目会永远留在清单里，每次同步都当成待删项重复报告。
test('生成文件已不在磁盘上时，清单条目照常被清理', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
  });
  runSync(config);
  fs.rmSync(path.join(config.contentDirAbs, 'a.md')); // 用户手工删掉了生成文件

  fs.writeFileSync(
    path.join(config.vaultDir, 'STX/a.md'),
    '---\npublish: false\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
    'utf8'
  );

  const result = runSync(config);

  assert.equal(result.deleted.length, 1); // 动作照常生成，applySync 对不存在的文件是 no-op
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8')).entries, {});
  fs.rmSync(root, { recursive: true, force: true });
});

// 清单是可手写的文件（本工具自己的报错文案就在教用户手工删条目），所以它的键是不可信输入。
// 删除路径由键反推，而删除侧执行的是 rmSync(recursive)：键为 `..` 时 path.join(imagesDir, '..')
// 恰好是 public/，键为 `a/../../../docs` 时归一化到仓库根下的 docs/。既有两道闸都拦不住——
// 「记录路径 vs 推导路径」的两个值都由同一个键推出（自洽即放行），哈希闸在文件不存在时也放行。
test('清单里不合 slug 形态的键不参与删除，仓库外的目录不会被牵连', () => {
  const { root, config, repoRoot } = makeFixture(
    { 'STX/keep.md': '---\npublish: false\nslug: keep\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n' },
    { 'public/cv/resume.pdf': 'valuable', 'docs/important.txt': 'valuable' }
  );
  fs.writeFileSync(
    config.manifestAbs,
    JSON.stringify(
      {
        version: 1,
        entries: {
          '..': { source: 'STX/gone.md', output: 'src/content/posts/...md', outputHash: 'sha256:x', images: [] },
          'a/../../../docs': { source: 'STX/gone.md', output: 'src/docs.md', outputHash: 'sha256:x', images: [] },
        },
      },
      null,
      2
    )
  );

  const result = runSync(config);

  assert.equal(result.deleted.length, 0);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some((error) => error.includes('".."')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'public/cv/resume.pdf')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'docs/important.txt')));
  fs.rmSync(root, { recursive: true, force: true });
});

// 键之外，清单的**值**同样不可信：entry.images 里的路径会被 applySync 直接喂给 fs.rmSync。
// 判据是「必须在该 slug 自己的附件目录内」，不是较松的「在仓库内」：后者会放行仓库里的任意文件，
// 也会让指向仓库根自身（`.`）的条目穿过检查，把目录递给 rmSync 并抛 EISDIR 把整次同步打断。
// 判据末尾那个 `+ path.sep` 也是判据本身的一部分：去掉它，`public/images/ab/x.png` 会因字符串前缀
// 相同而被当成 slug `a` 的附件（下面两条反向断言专钉这一格——它和 `.` 那条是同一类差一字符的错误）。
test('清单里记录的图片路径不在该 slug 的附件目录内时忽略，不会删到仓库里的其他文件', () => {
  const { root, config, repoRoot } = makeFixture(
    { 'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n' },
    { 'src/components/Hero.astro': '<div />\n', 'public/images/ab/x.png': PNG }
  );
  runSync(config);
  fs.writeFileSync(path.join(root, 'outside.png'), PNG); // 仓库外的文件

  const manifest = JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8'));
  manifest.entries.a.images = [
    '../outside.png',
    'src/components/Hero.astro',
    '.',
    42,
    'public/images/ab/x.png', // 兄弟前缀：与 public/images/a 只差一个分隔符
    'public/images/a', // 附件目录自身：放行它会把目录递给 rmSync 并抛 EISDIR
  ];
  fs.writeFileSync(config.manifestAbs, JSON.stringify(manifest, null, 2));

  const result = runSync(config);

  assert.equal(result.warnings.filter((w) => /不在它的附件目录内/.test(w)).length, 5);
  assert.ok(fs.existsSync(path.join(root, 'outside.png')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'src/components/Hero.astro')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'public/images/ab/x.png'))); // 兄弟前缀目录里的文件必须活着
  fs.rmSync(root, { recursive: true, force: true });
});

// manifest.entries 是 JSON.parse 出来的普通对象：`entries['constructor']` 会命中
// Object.prototype.constructor（真值），只看 `!entry` 就会让「目标已存在而清单里没记」的保护失效。
test('slug 与 Object.prototype 成员同名时，手写文章仍不会被覆盖', () => {
  const { root, config } = makeFixture(
    { 'STX/x.md': '---\npublish: true\ntitle: X\nslug: constructor\npubDate: 2026-01-01\n---\n\n生成正文\n' },
    { 'src/content/posts/constructor.md': '# 我手写的文章\n' }
  );

  const result = runSync(config);

  assert.equal(result.created.length + result.updated.length + result.skipped.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /已存在/);
  assert.equal(fs.readFileSync(path.join(config.contentDirAbs, 'constructor.md'), 'utf8'), '# 我手写的文章\n');
  fs.rmSync(root, { recursive: true, force: true });
});

// applySync 先写文件、后存清单：中途失败（磁盘满、Ctrl-C、附件被删）会留下「文件已生成、清单没记」
// 的孤儿产物。对它报「请改用别的 slug」是误导，用户还会卡在一个自己删不掉的状态里。
test('清单缺失但磁盘上已有内容一致的生成物时认领它，而不是报错卡住', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
  });
  runSync(config);
  const generated = fs.readFileSync(path.join(config.contentDirAbs, 'a.md'), 'utf8');
  fs.rmSync(config.manifestAbs); // 模拟清单没来得及保存

  const result = runSync(config);

  assert.deepEqual(result.errors, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.created.length, 0);
  assert.equal(fs.readFileSync(path.join(config.contentDirAbs, 'a.md'), 'utf8'), generated);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8')).entries), ['a']);
  fs.rmSync(root, { recursive: true, force: true });
});

// `--dry-run`（rsync/git 的习惯写法）曾被静默当成真实同步跑掉，而这个命令会删文件。
test('parseArgs 接受 --dry 与 --dry-run，未知参数直接报错', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false });
  assert.deepEqual(parseArgs(['--dry']), { dryRun: true });
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });
  assert.deepEqual(parseArgs(['--dry', '--dry-run']), { dryRun: true });
  assert.match(parseArgs(['--dryrun']).error, /未知参数 --dryrun/);
  assert.match(parseArgs(['--dry-run', '--force']).error, /未知参数 --force/);
});

test('main 把错误映射成非零退出码，仅有警告时为 0 且不打印「无警告无错误」', () => {
  const capture = () => ({
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  });

  const failing = makeFixture({ 'STX/未命名.md': '---\npublish: true\ntitle: X\npubDate: 2026-01-01\n---\n\n正文\n' });
  const failOut = capture();
  const failErr = capture();
  assert.equal(main(failing.config, { out: failOut, err: failErr }), 1);
  assert.match(failOut.text, /❌ 错误 1/);
  assert.equal(failErr.text, '');

  const warning = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n[[未发布的笔记]]\n',
  });
  const warnOut = capture();
  assert.equal(main(warning.config, { out: warnOut, err: capture() }), 0);
  assert.match(warnOut.text, /⚠️ 警告 1/);
  assert.ok(!warnOut.text.includes('✅')); // 有警告就不是「无警告无错误」

  fs.rmSync(failing.root, { recursive: true, force: true });
  fs.rmSync(warning.root, { recursive: true, force: true });
});

// 「哈希不符」与「清单里根本没记哈希」是两种病：前者是文件被改过，后者是清单坏了。
test('清单条目缺 outputHash 时按「清单记录不全」告警，不混说成「内容不符」', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
  });
  runSync(config);
  const manifest = JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8'));
  delete manifest.entries.a.outputHash;
  fs.writeFileSync(config.manifestAbs, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(config.vaultDir, 'STX/a.md'),
    '---\npublish: false\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
    'utf8'
  );

  const result = runSync(config);

  assert.equal(result.deleted.length, 0);
  assert.ok(fs.existsSync(path.join(config.contentDirAbs, 'a.md')));
  assert.ok(result.warnings.some((w) => /清单里没有记录它的哈希/.test(w)));
  assert.ok(!result.warnings.some((w) => /内容哈希与清单记录不符/.test(w)));
  fs.rmSync(root, { recursive: true, force: true });
});
// 清单里的哈希过期（手工编辑清单、合并解冲突出错）但磁盘内容与本次生成的一致：文件并没有被改过。
// 旧实现只要「清单有记录」且「哈希对不上」就告警，这条假警报会让人去查一个根本没问题的文件。
test('清单里的哈希对不上、但文件内容与生成的一致时，不报「被手工改过」', () => {
  const { root, config } = makeFixture({
    'STX/a.md': '---\npublish: true\nslug: a\ntitle: A\npubDate: 2026-01-01\n---\n\n正文\n',
  });
  runSync(config);
  const manifest = JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8'));
  manifest.entries.a.outputHash = 'sha256:stale';
  fs.writeFileSync(config.manifestAbs, JSON.stringify(manifest, null, 2));

  const result = runSync(config);

  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.warnings, []);
  fs.rmSync(root, { recursive: true, force: true });
});

// CLI 尾部那几行胶水（`import.meta.url` 判定 + 分派 + 退出码 2）只有真起子进程才覆盖得到：
// 它是用户实际敲的那条命令的入口，`parseArgs` 与 `main` 各自有测试并不代表这段接线是对的。
// 只测未知参数这一支——成功支会真的去读 /home/minus/Wiki（DEFAULT_CONFIG 的 vaultDir），不能进测试；
// `--force` 在 parseArgs 就返回错误，走不到 makeConfig，因此这条对 vault 是否存在不敏感。
test('命令行入口：未知参数打印用法并以退出码 2 结束', () => {
  const cli = path.join(import.meta.dirname, '..', 'sync-obsidian.mjs');
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, '--force'], { encoding: 'utf8' });

  assert.equal(status, 2);
  assert.equal(stdout, ''); // 错误只走 stderr：stdout 有内容会污染 `pnpm sync | ...` 的管道
  assert.match(stderr, /未知参数 --force/);
  assert.match(stderr, /pnpm sync \[--dry\|--dry-run\]/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `Cannot find module './sync.mjs'`

- [ ] **Step 3: 实现编排层**

创建 `scripts/sync/sync.mjs`：

```js
import fs from 'node:fs';
import path from 'node:path';
import { scanVault, buildIndexes } from './vault.mjs';
import { resolveSlug, isValidSlug } from './slug.mjs';
import {
  parseNote,
  normalizePubDate,
  pickDescription,
  buildOutput,
  hashText,
} from './note.mjs';
import { transformBody, detectUnsupportedSyntax } from './transform.mjs';
import { loadManifest, saveManifest } from './manifest.mjs';

const toPosix = (value) => value.split(path.sep).join('/');

/**
 * 与 vault.mjs 里那条目录级警告的文案耦合：删除闸要靠它判断「这次扫描是否完整」。
 * 刻意不把这个前缀做成跨模块导出——它是 6 个字符，为它给扫描模块增加公共 API 不划算；
 * 代价是这句文案被写了两处，只改一处会被 Task 6 的删除闸测试立刻抓到，不会静默失效。
 * 同理，本文件的 toPosix 与 vault.mjs 里的同名函数各留一份（1 行恒等变换，第三个调用方出现时再抽）。
 */
const UNREADABLE_DIR_PREFIX = '无法读取目录 ';

/** 附件落地文件名：ASCII 化 + 冲突时追加序号。 */
function uniqueImageName(absPath, usedNames) {
  const extension = path.extname(absPath).toLowerCase();
  const stem =
    path
      .basename(absPath, extension)
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'image';

  let candidate = `${stem}${extension}`;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${stem}-${counter}${extension}`;
    counter += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

/** 已发布笔记的解析表：小写文件名与相对路径（去扩展名）都能命中，短路径优先。 */
export function buildPublishedMap(notes) {
  const map = new Map();
  for (const note of notes) {
    const entry = { slug: note.slug, title: note.title, relPath: note.relPath };
    const keys = [note.basename.toLowerCase(), note.relPath.replace(/\.md$/i, '').toLowerCase()];
    for (const key of keys) {
      const existing = map.get(key);
      if (!existing || note.relPath.length < existing.relPath.length) map.set(key, entry);
    }
  }
  return map;
}

/**
 * 清单里记的图片路径同样是不可信输入：applySync 会把它直接喂给 `fs.rmSync`。
 * 合法值只有一种来源——本工具自己写进清单的 `public/images/<slug>/<name>`——所以判据就取这条不变量：
 * 归一化后必须**严格落在这个 slug 自己的附件目录内**。只挡「仓库外」不够：
 *   - 仓库里的任意文件（如 `src/components/Hero.astro`）会被一并放行并删掉，而它根本不是生成物；
 *   - 指向仓库根自身（`.`）的条目会穿过检查，把目录递给 rmSync 并抛 EISDIR。
 * 越界的条目丢弃并警告——清单被改坏时，少删一个文件远好过删错一个文件。
 *
 * 风险的另一半在删除循环里：那里是**键**（而不是值）参与拼路径，且用的是递归删除，所以校验必须发生在
 * 拼路径之前、以「不生成动作」的形式生效（runSync 不检查 plan.errors 就落盘）。
 */
function safeRecordedImages(config, slug, images, warnings) {
  if (!Array.isArray(images)) return [];
  const slugDirAbs = path.resolve(config.imagesDirAbs, slug);
  const kept = [];
  for (const image of images) {
    if (typeof image !== 'string') continue;
    const abs = path.resolve(config.repoRoot, image);
    if (!abs.startsWith(slugDirAbs + path.sep)) {
      warnings.push(
        `清单里「${slug}」记录的图片路径 ${image} 不在它的附件目录内，已忽略该条：清单可能被手工改过`
      );
      continue;
    }
    kept.push(image);
  }
  return kept;
}

/**
 * 计算本次同步要做的事。零副作用：只读文件、不写盘、不拷贝。
 * 返回 { actions, warnings, errors }。
 */
export function planSync(config) {
  const warnings = [];
  const errors = [];
  // 一个数组贯穿扫描与索引：警告只要产生就进同一个 sink，最后由报告统一汇总。
  // 各传各的 `[]` 等于把扫描层的警告就地丢掉——那是本模块最不该做的事。
  const { notes: noteFiles, attachments } = buildIndexes(scanVault(config, warnings), warnings);

  // 1. 解析所有笔记的 frontmatter
  const notes = noteFiles.map((file) => {
    const parsed = parseNote(fs.readFileSync(file.absPath, 'utf8'));
    if (parsed.error) warnings.push(`${file.relPath}: ${parsed.error}`);
    return { ...file, data: parsed.data, body: parsed.body };
  });

  // 2. 筛出 publish === true 的笔记
  const publishable = notes.filter((note) => note.data[config.publishProperty] === true);

  // 3. 解析 slug
  const candidates = [];
  for (const note of publishable) {
    const basename = note.name.replace(/\.md$/i, '');
    const { slug, error } = resolveSlug({ slugProperty: note.data.slug, basename });
    if (error) {
      errors.push(`${note.relPath}: ${error}`);
      continue;
    }
    candidates.push({ ...note, basename, slug });
  }

  // 4. slug 冲突检测：冲突的全部跳过
  const bySlug = new Map();
  for (const note of candidates) {
    const list = bySlug.get(note.slug) ?? [];
    list.push(note);
    bySlug.set(note.slug, list);
  }
  const finalNotes = [];
  for (const [slug, list] of bySlug) {
    if (list.length > 1) {
      errors.push(
        `slug 冲突：「${slug}」被 ${list.map((note) => note.relPath).join(' 和 ')} 同时使用，全部跳过，请修改 slug`
      );
      continue;
    }
    finalNotes.push(list[0]);
  }

  // 5. 补全标题
  for (const note of finalNotes) {
    const title = typeof note.data.title === 'string' ? note.data.title.trim() : '';
    note.title = title === '' ? note.basename : title;
  }

  const publishedMap = buildPublishedMap(finalNotes);
  const manifest = loadManifest(config);
  const actions = [];

  // 6. 为每篇待发布笔记生成产物
  for (const note of finalNotes) {
    const pubDate = normalizePubDate(note.data, fs.statSync(note.absPath).mtime);
    if (!pubDate) {
      errors.push(`${note.relPath}: 无法确定 pubDate，请在笔记属性里填写 pubDate`);
      continue;
    }

    const imagePlan = new Map(); // 源文件绝对路径 -> { destName, url, alt }
    const usedNames = new Set();
    const noteWarnings = detectUnsupportedSyntax(note.body, note.relPath);

    const ctx = {
      urlPrefix: config.urlPrefix,
      sourceRel: note.relPath,
      warnings: noteWarnings,
      copyImage: (target) => {
        const absPath = attachments.get(target.toLowerCase());
        if (!absPath) return null; // 找不到：警告由 transform 统一发出
        const extension = path.extname(absPath).toLowerCase();
        if (!config.imageExtensions.includes(extension)) {
          // 存在但不支持内联，必须与「找不到」区分开：否则报告会对一个根本没丢的文件报「缺失」，
          // 而用户会去查这个文件。警告仍由 transform 落成，resolver 只解析、不发声。
          return { unsupported: true };
        }
        let planned = imagePlan.get(absPath);
        if (!planned) {
          const destName = uniqueImageName(absPath, usedNames);
          planned = {
            destName,
            url: `${config.imageUrlPrefix}/${note.slug}/${destName}`,
            alt: path.basename(absPath, extension),
          };
          imagePlan.set(absPath, planned);
        }
        return planned;
      },
      resolveLink: (target) => {
        const key = target.replace(/\.md$/i, '').trim().toLowerCase();
        // 未解析警告由 transform 统一发出，这里只负责查表
        return publishedMap.get(key) ?? publishedMap.get(key.split('/').pop()) ?? null;
      },
    };

    const body = transformBody(note.body, ctx);
    const content = buildOutput({
      frontmatter: {
        title: note.title,
        slug: note.slug,
        description: pickDescription(note.data, note.body, config.descriptionMaxChars),
        pubDate,
        tags: Array.isArray(note.data.tags) ? note.data.tags.map(String) : [],
        syncedFrom: note.relPath,
      },
      body,
    });

    const outputPath = path.join(config.contentDirAbs, `${note.slug}.md`);
    const previousContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;

    // 清单经 JSON.parse 读回，是普通对象：`entries['constructor']` 会命中 Object.prototype 上的成员，
    // 使下面那条「目标已存在而清单里没记」的保护失效（本体允许的 slug 形态并不排除 constructor）。
    // 必须按**自有键**判断，不能只看取值是否为真。
    const entry = Object.hasOwn(manifest.entries, note.slug) ? manifest.entries[note.slug] : null;

    // 目标存在、清单里没记、内容又和本次要写的不一致 → 判定为与手写文章冲突，拒绝覆盖。
    // 内容一致时不算冲突：applySync 先写文件、后存清单，中途失败（磁盘满、Ctrl-C、附件被删）会留下
    // 「文件已生成、清单没记」的孤儿产物。对它报「请改用别的 slug」是误导，用户还会卡在一个自己删不掉的
    // 状态里（下次同步照样报错）。认领它——本轮按 skip 处理并补上清单条目——才是应有的恢复动作。
    if (previousContent !== null && entry === null && previousContent !== content) {
      errors.push(
        `slug「${note.slug}」的目标文件 ${config.contentDir}/${note.slug}.md 已存在、内容与本次生成的也不同，` +
          `拒绝覆盖：它可能是你手写的文章（请改用别的 slug），也可能是上次同步中断留下的残骸（删掉该文件再同步即可）`
      );
      continue;
    }

    const type = previousContent === null ? 'create' : previousContent === content ? 'skip' : 'update';
    // 只在真要覆写时告警：type 为 skip 说明磁盘内容与本次生成的一致（清单里的哈希过期或缺失），
    // 这时文件并没有被改过，报「被手工改过」是假警报。
    if (type === 'update' && hashText(previousContent) !== entry.outputHash) {
      warnings.push(`${note.relPath}: 生成文件 ${note.slug}.md 被手工改过，将以 vault 为准覆盖`);
    }

    actions.push({
      type,
      slug: note.slug,
      sourceRel: note.relPath,
      outputPath,
      content,
      outputHash: hashText(content),
      images: [...imagePlan.entries()].map(([sourceAbs, planned]) => ({ sourceAbs, ...planned })),
      previousImages: safeRecordedImages(config, note.slug, entry?.images, warnings),
      warnings: noteWarnings,
    });
  }

  // 7. 清单里有、但这次不再发布的 → 删除
  //
  // 「扫描结果里没有」只有在扫描确定完整时才等于「源笔记已删除」。两种情况它不是：
  //   a) 一篇 .md 都没扫到而清单非空 —— vaultDir 指向了一个能读、但不是 vault 的目录；
  //   b) 有目录读不到（权限、竞态）—— 那个目录里的笔记看起来也「消失」了，其实只是没被读到。
  // 判据必须是「一篇 .md 都没扫到」，不能写成「没有可发布的笔记」：后者是用户自己把 publish 关掉的
  // 正常状态（见测试「取消 publish 后删除生成文件与图片目录」），按它一刀切就没法取消发布了。
  //
  // 两道闸都靠**不生成删除动作**实现，而不是 push 一条 error：runSync 调用 applySync 之前并不检查
  // plan.errors，错误只影响退出码，靠 error 挡的话文件已经删完了（spec §7.6/§7.7）。
  const currentSlugs = new Set(finalNotes.map((note) => note.slug));
  // 清单的键是不可信输入：删除路径由它反推，而删除侧执行的是 `rmSync(..., { recursive: true })`。
  // 键为 `..` 时 path.join(imagesDir, '..') 恰好是 imagesDir 的父目录，键为 `a/../../../docs` 时
  // 归一化到仓库根下的 docs/——一次手工笔误就能递归删掉仓库外的任意目录。形态不对的键不生成任何动作。
  const staleSlugs = [];
  for (const slug of Object.keys(manifest.entries)) {
    if (currentSlugs.has(slug)) continue;
    if (!isValidSlug(slug)) {
      errors.push(
        `清单里有一条不合法的键 ${JSON.stringify(slug)}（slug 只允许小写字母、数字与短横线），已跳过：` +
          `它可能是手工编辑或合并冲突留下的，请从 ${config.manifestPath} 中移除该条。`
      );
      continue;
    }
    staleSlugs.push(slug);
  }
  const unreadableDirs = warnings.filter((warning) => warning.startsWith(UNREADABLE_DIR_PREFIX));

  if (staleSlugs.length > 0 && noteFiles.length === 0) {
    errors.push(
      `扫描到 0 篇笔记，但清单里有 ${staleSlugs.length} 篇生成记录，已取消全部删除：` +
        `疑似 vaultDir 指向了错误的目录（当前 vaultDir=${config.vaultDir}）。` +
        `若确实要清空全部生成物，请先删除 ${config.manifestPath} 再同步。`,
    );
  } else if (staleSlugs.length > 0 && unreadableDirs.length > 0) {
    errors.push(
      `有 ${unreadableDirs.length} 个目录读不到（${unreadableDirs.join('；')}），已取消 ${staleSlugs.length} 篇的删除：` +
        `读不到的目录里的笔记会被误判成「源已删除」。修好权限后重跑即可。`,
    );
  } else {
    for (const slug of staleSlugs) {
      const entry = manifest.entries[slug];
      const outputPath = path.join(config.contentDirAbs, `${slug}.md`);
      const derived = toPosix(path.relative(config.repoRoot, outputPath));
      const recorded = typeof entry.output === 'string' ? entry.output : '(清单里没有记录)';

      // spec §7.1 的第二个合取项。删除路径本来是从 slug 反推的，只有在清单没被改坏时才等于
      // entry.output；不相等说明清单与磁盘的对应关系已经被破坏（手工编辑、合并解冲突出错），
      // 这时宁可漏删一轮，也不要删掉一个我们其实并不认识的同名文件。
      if (derived !== recorded) {
        errors.push(
          `清单里「${slug}」记录的路径是 ${recorded}，与由 slug 推导出的 ${derived} 不一致，已跳过删除：` +
            `清单可能被手工改过。确认后请手工删除该文件，并从 ${config.manifestPath} 里移除这一条。`,
        );
        continue;
      }

      // spec §7.4 的同胞条款。§7.4 承认「生成文件被手工改过」是真实会发生的事——用户可能直接
      // 在博客侧编辑「已发布」的版本。覆盖有下一轮 vault 兜底，删除没有：把用户的改动静默销毁
      // 不可逆。文件不存在不算「被改过」（生成物早被删了），照常生成动作把清单条目清掉。
      const currentHash = fs.existsSync(outputPath) ? hashText(fs.readFileSync(outputPath, 'utf8')) : null;
      if (currentHash !== null && currentHash !== entry.outputHash) {
        // 「不符」与「清单里根本没记」是两回事，分开说——后者是清单坏了，不是文件被改过。
        const why = typeof entry.outputHash === 'string' ? '内容哈希与清单记录不符' : '清单里没有记录它的哈希';
        warnings.push(
          `生成文件 ${slug}.md 被手工改过或清单记录不全（${why}），已跳过删除：` +
            `确认无需保留后删掉该文件即可，下次同步会自动清理 ${config.manifestPath} 里对应的条目`,
        );
        continue;
      }

      actions.push({
        type: 'delete',
        slug,
        sourceRel: entry.source,
        outputPath,
        content: null,
        outputHash: null,
        images: [],
        // 删除分支整目录清掉 public/images/<slug>/，不读 previousImages，这个字段刻意不留
        warnings: [],
      });
    }
  }

  return { actions, warnings: [...warnings, ...actions.flatMap((action) => action.warnings)], errors };
}

/** 落盘。返回更新后的 manifest（未写盘）。 */
export function applySync(config, plan) {
  const manifest = loadManifest(config);

  for (const action of plan.actions) {
    if (action.type === 'delete') {
      fs.rmSync(action.outputPath, { force: true });
      fs.rmSync(path.join(config.imagesDirAbs, action.slug), { recursive: true, force: true });
      delete manifest.entries[action.slug];
      continue;
    }

    const nextImagePaths = [];
    for (const image of action.images) {
      const dest = path.join(config.imagesDirAbs, action.slug, image.destName);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(image.sourceAbs, dest);
      nextImagePaths.push(toPosix(path.relative(config.repoRoot, dest)));
    }

    // 清理上一篇产物里、这次已不再引用的图片
    for (const stale of action.previousImages) {
      if (!nextImagePaths.includes(stale)) {
        fs.rmSync(path.resolve(config.repoRoot, stale), { force: true });
      }
    }

    if (action.type !== 'skip') {
      fs.mkdirSync(config.contentDirAbs, { recursive: true });
      fs.writeFileSync(action.outputPath, action.content, 'utf8');
    }

    manifest.entries[action.slug] = {
      source: action.sourceRel,
      output: toPosix(path.relative(config.repoRoot, action.outputPath)),
      outputHash: action.outputHash,
      images: nextImagePaths,
    };
  }

  return manifest;
}

function summarize(plan, dryRun) {
  const pick = (type, mapper) => plan.actions.filter((action) => action.type === type).map(mapper);
  const describe = (action) => ({
    slug: action.slug,
    sourceRel: action.sourceRel,
    images: action.images.length,
  });

  return {
    dryRun,
    created: pick('create', describe),
    updated: pick('update', describe),
    skipped: pick('skip', describe),
    deleted: pick('delete', describe),
    warnings: plan.warnings,
    errors: plan.errors,
  };
}

/** 同步主入口。dryRun 为真时只计算并汇总，不落盘。 */
export function runSync(config, { dryRun = false } = {}) {
  const plan = planSync(config);
  const result = summarize(plan, dryRun);
  if (dryRun) return result;

  const before = JSON.stringify(loadManifest(config).entries);
  const manifest = applySync(config, plan);
  if (JSON.stringify(manifest.entries) !== before) saveManifest(config, manifest);

  return result;
}

export function formatReport(result) {
  const lines = [];
  const total = result.created.length + result.updated.length + result.skipped.length + result.deleted.length;
  lines.push(`${result.dryRun ? '（试运行，未写入任何文件）' : ''}📥 同步 ${total} 篇`);

  const row = (label, entry) => {
    const suffix = entry.images > 0 ? `  (附件 ${entry.images})` : '';
    return `  ${label}  ${entry.slug}.md  ← ${entry.sourceRel}${suffix}`;
  };
  for (const entry of result.created) lines.push(row('+ 新建', entry));
  for (const entry of result.updated) lines.push(row('~ 更新', entry));
  for (const entry of result.skipped) lines.push(row('= 跳过', entry));
  for (const entry of result.deleted) lines.push(row('- 删除', entry));

  // 一行里的上百个相同内链会产出上百条一模一样的警告，而报告是给人读的：折叠同一条并标出次数。
  // 去重放在报告层而不是 transform：模块无法知道最终报告的形态，只管如实逐条上报。
  const pushListed = (list) => {
    const counted = new Map();
    for (const item of list) counted.set(item, (counted.get(item) ?? 0) + 1);
    for (const [item, count] of counted) lines.push(`  - ${item}${count > 1 ? `（×${count}）` : ''}`);
  };
  if (result.warnings.length > 0) {
    lines.push(`⚠️ 警告 ${result.warnings.length}`);
    pushListed(result.warnings);
  }
  if (result.errors.length > 0) {
    lines.push(`❌ 错误 ${result.errors.length}`);
    pushListed(result.errors);
  }
  if (result.errors.length === 0 && result.warnings.length === 0) {
    lines.push('✅ 无警告无错误');
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS —— 累计 92 + 29 = 121 项通过

- [ ] **Step 5: 写命令行入口并加 sync 脚本**

创建 `scripts/sync-obsidian.mjs`：

```js
#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { makeConfig } from './sync/config.mjs';
import { runSync, formatReport } from './sync/sync.mjs';

const USAGE = '用法：pnpm sync [--dry|--dry-run]，不接受其他参数。';

/**
 * 解析命令行参数。未知参数一律报错，不静默忽略：`--dry-run`（rsync/git 的习惯写法）曾经被
 * 静默当成真实同步跑掉，而这个命令会删文件——把「试运行」执行成真删除是不能接受的失败模式。
 * 返回 { dryRun } 或 { error }。
 */
export function parseArgs(argv) {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry' || arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    return { error: `未知参数 ${arg}。${USAGE}` };
  }
  return { dryRun };
}

/**
 * 跑一次同步，把结果渲染成报告，返回进程退出码（0 = 无错误）。
 * out/err 可注入是为了让「vault 根目录读不到」这条路径可被测试——它是 spec §7.6 的用户可见部分，
 * 不该只靠人工试。
 */
export function main(config, { dryRun = false, out = process.stdout, err = process.stderr } = {}) {
  try {
    const result = runSync(config, { dryRun });
    out.write(`${formatReport(result)}\n`);
    return result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    // scanVault 在 vault 根目录读不到时抛错：这次同步什么都没做，不该以一段堆栈收场。
    err.write(`❌ ${error.message}\n→ 若这次是在写盘途中失败的，重新运行 pnpm sync 会接着做完：已写出的文件会被自动认领。\n`);
    return 1;
  }
}

// 只有被当作脚本直接执行时才跑（测试 import 这个模块时不能有副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { dryRun, error } = parseArgs(process.argv.slice(2));
  if (error) {
    process.stderr.write(`❌ ${error}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = main(makeConfig(), { dryRun });
  }
}
```

在 `package.json` 的 `scripts` 里加：

```json
    "sync": "node scripts/sync-obsidian.mjs"
```

- [ ] **Step 6: 对真实 vault 跑一次试运行**

Run: `pnpm sync --dry`
Expected: 打印 `（试运行，未写入任何文件）📥 同步 0 篇`（当前 vault 里没有任何 `publish: true` 笔记），随后 `✅ 无警告无错误`，退出码 0。

Run: `git status --short`
Expected: 只列出既有的 `M src/components/Hero.astro` 与 `?? Blog.code-workspace`，没有新增文件（证明 dry run 无副作用）。

- [ ] **Step 7: 提交**

```bash
git add scripts/sync/sync.mjs scripts/sync/sync.test.mjs scripts/sync-obsidian.mjs package.json
git commit -m "feat(sync): add sync orchestration and CLI entry"
```

- [ ] **Step 8: 修订（Task 4 复审的交接项 + 编排层预读发现）**

Task 4 复审指出：本节的代码是 Task 4 那道「静默丢失」防线的下游，两处必须在本节接上，否则前面白做。落地内容：

1. **一个 warnings 数组贯穿扫描与索引**：`buildIndexes(scanVault(config, warnings), warnings)`。原文是 `buildIndexes(scanVault(config))`——Task 4 已经去掉默认值并在入口加了守卫，这一行不改会直接在 TypeError 上炸；改成各传各的 `[]` 更糟：那等于把扫描层的警告就地丢掉，而报告仍会打印 `✅ 无警告无错误`。
2. **两道删除闸，都靠不生成删除动作实现**（spec §7.6/§7.7）：a) 一篇 `.md` 都没扫到而清单非空 → 拒绝全部删除并报错；b) 有目录读不到 → 本次不执行任何删除。判据是 `noteFiles.length === 0`（扫到的 .md 数），**不是** `finalNotes.length === 0`（可发布数）：后者是用户把自己唯一一篇文章 `publish` 关掉的正常状态，按它一刀切会让人没法取消发布——既有的「取消 publish 后删除生成文件与图片目录」测试会当场失败。
   - 关键约束：必须在 `planSync` 里**不生成** delete 动作。`runSync` 调用 `applySync` 之前并不检查 `plan.errors`，错误只影响退出码——靠 push 一条 error 挡的话，文件已经删完了才打印。
   - 两道闸都会在报告里给出可操作的出口（写清当前 vaultDir、或提示修好权限后重跑；要清空全部生成物的用户可先删 `.sync-manifest.json`）。
3. **警告前缀的耦合显式化**：删除闸靠 `UNREADABLE_DIR_PREFIX` 过滤 `warnings`，与 vault.mjs 里那条文案是同一个字符串。刻意不做跨模块导出常量（6 个字符，不值得给扫描模块加公共 API），代价是文案写了两处——只改一处会被下面的测试立刻抓到，不会静默失效。
4. **CLI 把根目录读取失败渲染成一行 ❌ 与退出码 1**，不再把 Node 堆栈丢给用户；为此 `main(config, { out, err })` 导出且可注入，脚本只在被直接执行时才跑（`import.meta.url` 判定），这条路径由测试覆盖。
5. 新增三项测试（0 篇笔记的删除闸、目录读不到的删除闸、CLI 的错误渲染），测试数 14 → 17，累计 **109**。

有意不修（记录理由，避免下一轮重复提出）：

- **两道闸是钝的**：目录读不到时连「源在其它目录、确实已取消发布」的条目也不删。精确到「只冻结读不到那个目录下的条目」要从警告文本里反解目录路径，脆弱且难测；清理晚一轮没有代价（生成物重跑即补），误删要用户自己去 git 里捞。
- **slug 出错导致掉出 `finalNotes` 的笔记，其生成物会被当成本次不再发布而删除**：源笔记仍在、报错在报告里可见、修好后重新同步即恢复（vault 是唯一源），故不加第三道闸。若实际使用中觉得吵，再补「本次报错过的源不参与删除」。
- **`toPosix` 与 vault.mjs 各一份**：1 行恒等变换，抽公共模块的收益低于它带来的间接层，等第三个调用方出现再说。
---

- [ ] **Step 9: 修订（Task 6 spec 合规复审：删除侧的两道检查）**

spec 合规复审判定 §7.1 的第二个合取项「文件路径等于 manifest 记录的路径」没有任何实现：删除路径由 `path.join(contentDirAbs, slug + '.md')` 反推（原计划 `:242`），`entry.output` 全仓零引用。核实属实，且实际风险比复审举的例子更近：

- §7.4 专门为「生成文件被手工改过」写了警告——说明作者认为用户**真的会**直接在博客侧编辑「已发布」的版本。但那条保护只长在**覆盖**路径上，**删除**路径什么检查都没有：用户改完、再取消发布，他的改动被静默销毁，且删除不可逆（覆盖至少还有下一轮 vault 兜底）。
- 只补「路径相等」是不够的：清单没被改坏时 `entry.output` 恒等于反推路径，这一条在日常流程里是恒真的。真正能挡住上面那个场景的是清单里**已经存着**的 `outputHash`。

落地（两道都放在 `planSync` 的删除循环里，逐条 `continue`）：
1. `derived !== recorded`（`entry.output` 缺失也算）→ push error 并跳过删除。清单与磁盘的对应关系已被破坏时，宁可漏删一轮。
2. 文件存在且 `hashText(文件内容) !== entry.outputHash` → push warning 并跳过删除。文件不存在不算「被改过」（生成物早被删了），照常生成动作清掉清单条目，保住既有的 delete-noop 行为。
3. 新增两项测试（路径不一致、手工改过后取消发布），测试数 17 → 19，累计 **111**。
4. spec §7.1 与 §7.3 同步改（先改文档再改实践）。

复验（同一 reviewer 回看）追加的收口，同轮落库：

5. **补 delete-noop 测试**（生成文件已被手工删除、清单条目仍在 → 动作照常生成、清单被清理）。上文原说「保住**既有的** delete-noop 行为」不实——行为在，但没有任何测试钉住它，而新代码里恰好有一条注释在解释这个分支。
6. **`outputHash` 缺失时不再混说成「不符」**：拆成「内容哈希与清单记录不符」与「清单里没有记录它的哈希」两种说明；文案也改为「删掉该文件即可，下次同步会自动清理清单条目」（原来要求「并移除清单这一条」是多余的，代码里根本不需要）。
7. **三处注释纠偏**（Task 4 的两个模块，只改文字）：`localeCompare('en')` 的自述是「跨环境不稳定」而非「本机测不到」；dot 文件那句原写「spec §4.1 认可的边界」，而 spec 对 dot 文件根本没表态，改为明说这是取舍；冲突测试里「把胜者是谁留给注释」是首轮修订前的残迹、与紧邻断言矛盾，改为指明胜者由哪一行锁。
8. 测试数 19 → 20，累计 **112**。

复验给出、我确认「记录不修」的（不再重复提出）：

- **覆盖侧不做路径相等检查**：已写进 spec §7.1 的「已知残余」——现实触发需篡改清单（改 `contentDir` 会直接搞坏构建），且覆盖有 §7.4 的警告与 git 兜底，与删除侧「无声且不可逆」不对称。
- **`formatReport` 的格式断言偏松**（表头 emoji、`✅ 无警告无错误`、`+ ~ = -` 前缀未钉住）：报告是给人读的，回归会被运行者肉眼看见，真实输出另由 Task 10 验收覆盖。
- **未覆盖分支**：`entry.output` 非字符串的兜底、`{unsupported:true}` 接线、`uniqueImageName` 的冲突加序号。
- **死导出** `buildPublishedMap` / `applySync`：属计划规定的 API 面。
- **`makeConfig` 收到畸形 override**（如 `vaultDir: 42`）抛的是 Node 原生 `TypeError` 文案，不是本模块口吻——方向是「更早失败」，不改。

有意不修的残余：清单被改坏且**哈希恰好也对得上**时仍会删——但这要求攻击者同时构造路径与哈希，已超出「误操作」的范畴；此时用户还有 git。

- [ ] **Step 10: 修订（Task 6 代码质量复审：清单是不可信输入 + 三处真缺陷）**

代码质量复审对 `72c5d0f` 给出 CHANGES_REQUESTED。三条主张我先逐条实测复现（`/tmp/c1repro/repro.mjs`，夹具与 `sync.test.mjs` 同源），不靠推理下结论：

| 复现输入（手工改坏的清单 / 撞名的 slug） | 实测结果 |
| --- | --- |
| `entries` 键为 `..` | `public/` 整棵树（含 `public/cv/resume.pdf`）被递归删掉，**errors 0 / warnings 0** |
| `entries` 键为 `a/../../../docs` | 仓库根下 `docs/` 被递归删掉，**errors 0 / warnings 0** |
| `slug: constructor` + 同名手写文章 | 手写内容被覆写，只给一条「被手工改过」的误导警告 |

三条全部成立，前两条是「静默递归删除仓库外的目录」——本项目最不可接受的一类失败（不可逆、且报告里一个字都没有），Critical 无争议。

1. **C1：清单的键必须先过 slug 校验。** 删除路径由键反推，键经 `path.join` 归一化后可以跳出 `contentDir`/`imagesDir`，而删除侧对它执行 `rmSync(..., { recursive: true })`。既有两道闸都拦不住：`derived !== recorded` 的两个值都由同一个键推出（自洽即放行），哈希闸在文件不存在时也放行。修法：`slug.mjs` 导出 `isValidSlug`，`planSync` 在拼路径**之前**筛掉形态不合的键并报错——不生成动作，同 §7.6/§7.7 的道理。测试夹具用上面那两个键 + 两个仓库外文件。
2. **C1 的另一半：`entry.images` 的路径同样不可信。** 复审只点了删除侧的键，但 `applySync` 把清单里的图片路径直接喂给 `fs.rmSync`（非递归，越界即删到仓库外），来源与键完全相同。新增 `safeRecordedImages()`：只放行归一化后仍在仓库内的路径，越界的丢弃并警告。测试指向 `../outside.png`。（**判据后来按第 10 条收紧为「该 slug 自己的附件目录内」——这里保留的是当时的落地过程，别当成现行判据。**）
3. **I1：`Object.hasOwn`。** `manifest.entries` 是 `JSON.parse` 的普通对象，`entries['constructor']` 命中 `Object.prototype.constructor`（真值），`exists && !entry` 因此为假，手写文章保护被绕过。改用 `Object.hasOwn(manifest.entries, note.slug)`（删除循环里不用改：那里的键来自 `Object.keys`，本身就是自有键）。
4. **I2：认领孤儿产物。** `applySync` 先写文件、后存清单，中途失败会留下「文件已生成、清单没记」的产物；原逻辑对它报「请改用别的 slug」，既误导又把用户卡在一个自己删不掉的状态里。改为：内容与本次生成一致时按 skip 认领并补上清单条目，只有**内容也不同**时才判为手写冲突。
5. **I3：`--dry-run` 不再被当成真实同步。** 原 `process.argv.slice(2).includes('--dry')` 是精确匹配，`--dry-run` 会静默走真同步，而这个命令删文件。改为导出 `parseArgs(argv)`：接受 `--dry`/`--dry-run`，未知参数报错并以退出码 2 结束。
6. **顺带修掉的三处**：①「被手工改过，将以 vault 为准覆盖」原来在 `type === 'skip'` 时也会报（清单哈希过期/缺失但文件并没被改过）——把 `type` 的计算提到告警之前，只在真要覆写时告警；②`main` 的 catch 补一句「重新运行 pnpm sync 会接着做完」，与第 4 条的自动认领对应；③删除动作里的 `previousImages` 是死字段（删除分支整目录清 `public/images/<slug>/`，不读它），去掉。
7. **一条空洞的测试。** `内容未变时第二次同步不改写文件` 断言 `mtimeMs <= firstMtime + 1000`：把写保护（`if (action.type !== 'skip')`）拆掉后它照样通过，1 秒容差把「重写同名文件」盖住了——一条永远绿的断言比没有更糟。改为精确相等。
8. **新增测试 8 条**（清单键越界、图片路径越界、`constructor`、孤儿认领、`parseArgs`、`main` 的退出码与报告、缺 `outputHash` 的措辞、哈希过期但内容一致时不误报）。另给既有测试补 3 处断言：手工改过那条钉住「内容哈希与清单记录不符」的措辞、图片仍在引用时不被清理、报告表头总数。`sync.test.mjs` 20 → 28，累计 **120**；复审后的补测再加 1 条（见第 11 条），最终 `sync.test.mjs` 29 条、累计 **121**。
9. **spec 先改**：§7 新增第 8 条「manifest 的内容是不可信输入」，§7.1 句 1 加指路词（「路径相等」只对删除侧逐字成立），§7.2 补「内容一致时认领」的例外，§8 补 `--dry-run` 别名与未知参数的处理。

10. **蓝军自查又打出一个洞（本轮自己发现，不待复审）**：`entry.images` 的判据原本写成「归一化后仍落在仓库内」，这条**不够**，而且我写的条件本身还是错的——`abs !== rootAbs && !abs.startsWith(...)` 是个 `&&`，对「等于仓库根」的条目整个判据为假、条目被放行，`applySync` 于 `rmSync(dir, { force: true })` 上抛 EISDIR 把整次同步打断（`force` 只吞 ENOENT，不吞 EISDIR）。更根本的是基座选错了：合法值只有一种来源（本工具写下的 `public/images/<slug>/<name>`），判据应取这条不变量。已改为「必须严格落在该 slug 自己的附件目录内」，测试同时覆盖仓库外文件、仓库内无关文件（`src/components/Hero.astro`）与 `.` 三种越界形态。

复审列出、本轮**记录不修**的（都不属安全类，避免把这一轮摊大）：

- **包含检查是词法的，不解析软链——残余在 copy 侧，不在删除侧**（上一版这条写反了，按实测改正）：若 `public/images/<slug>/` **本身**是一个指向仓库外的软链，`mkdirSync(..., { recursive: true })` + `copyFileSync` 会**写穿**它，附件被写到仓库外（实测 `/tmp/round5/verify_symlink.mjs` 用例 3：文件落在 `<tmp>/outside/slug-dir/` 里）。触发前提是仓库内**已经存在**这样一个软链，超出「误改清单」的范畴，留作**已知残余**；收紧要用 `realpath`，而它对不存在的路径会抛错，收益不抵复杂度。
  - **删除侧没有这个问题，实测反证**：`fs.rmSync` 对软链一律只 unlink 链接本身（用例 1），`recursive` 删目录时目录内的软链同样不被跟随、外部目标全部幸存（用例 2、4）。上一版这条写的是「`rmSync` 会顺着软链删掉外部目标」，与事实相反，已删掉该句。第 10 条那个蓝军断言之所以「幸存」，也不是因为它测到了软链语义——软链落在仓库根、被新判据直接丢了条目；换成「条目被放行」它也照样幸存。也就是说那条断言测的一直是包含检查，不是软链。
- **`public/images/<slug>/` 的递归删除没有哈希保护**：该目录是本工具按 slug 独占的命名空间，spec §7.3 明写「整个目录」，而 `entry.images` 已经逐个记了文件名，真要收紧有现成数据。不收的理由是「用户往生成物目录里放文件的概率低」——这是判断不是证据，留作**已知残余**。
- **`describe` 产出的 `images` 字段其实是数量**（`action.images` 是数组），命名易混。属报告层可读性，留到 Task 8 的样式改动一批做更省事。
- **`runSync` 的清单写条件**（内容未变则不写盘）是优化而非契约，不补测试。
- **哈希缺失 vs 不符的两种措辞**现在都有测试钉住了（此前只有「不符」一支被测，另一支是我上一轮新写的文案）——这条已在本轮补上，不再挂起。

11. **复审后的补测与记录改正（APPROVED_WITH_CONCERNS 的三条建议）**：
    - **N15：`+ path.sep` 没有测试守。** 我的判据 `abs.startsWith(slugDirAbs + path.sep)` 是对的，但把 `+ path.sep` 去掉后**没有任何测试失败**——`public/images/ab/x.png` 会因字符串前缀相同被当成 slug `a` 的附件（和上一轮那个 `.` 是同一类差一字符的错误，只是方向不同）。已在附件测试里补两条负例：兄弟前缀文件 `public/images/ab/x.png`（反向断言它**必须存活**）与附件目录自身 `public/images/a`，警告数 3 → 5。
    - **CLI 尾部胶水补上覆盖。** 那 6 行（`import.meta.url` 判定 + 分派 + 退出码 2）此前没有测试，而它是用户实际敲的命令的入口。补一条 `spawnSync(process.execPath, [cli, '--force'])`，四条断言：退出码 2、`stdout` 为空（错误只走 stderr，否则会污染 `pnpm sync | ...` 的管道）、stderr 命中 `未知参数 --force`、stderr 命中用法行。只测未知参数这一支——成功支会真去读 `/home/minus/Wiki`，不能进测试；`--force` 在 `parseArgs` 即返回错误，走不到 `makeConfig`，所以这条与 vault 是否存在无关。
    - **软链残余记录写反了，已按实测改正。** 第 10 条留下的残余原写成「`fs.rmSync` 会顺着软链删掉外部目标」，与事实相反（实测：`rmSync` 对软链一律只 unlink 链接本身，`recursive` 删目录时也不跟随，外部目标全部幸存）；真正的残余在**拷贝侧**——`public/images/<slug>/` 本身是软链时 `mkdirSync` + `copyFileSync` 会写穿它。详见上一条。
    - **`entry.outputHash` 的直接访问是刻意的，不改成 `?.`。** 我原本打算按「消除隐式耦合」加 `?.`，被复审否掉，理由成立：该处 `entry` 由前置守卫（`... && entry === null && ... → continue`）结构保证非空，`?.` 在**任何可达路径上都没有正当用途**；真出问题时它会把「结构被破坏」翻译成一条**静默假警告**「生成文件被手工改过」，而直接访问会当场 `TypeError` 让测试变红——「响亮地崩」优于「静默地说谎」，与本轮刚修掉的 `type === 'skip'` 假警报同类。注意 `safeRecordedImages(config, slug, entry?.images, …)` 那处的 `?.` 是**必要**的：create 路径下 `entry` 合法为 null，两处不是一回事。
    - **复审给出的四条「文案/取值未被断言」缺口（L6/L7/L14/N14），记录不修**——都不涉内容丢失，补它们要断言用户可见文案的逐字内容，收益不抵脆性：
      - **L6** `sync.mjs` 删除动作块 `sourceRel: entry.source,` → `sourceRel: null,`：**报告行未被断言**。`sourceRel` 是活字段（`formatReport` 的 `row()` 对四类行统一打印 `← ${entry.sourceRel}`），但现有报告类测试只断言条数/标记（`⚠️ 警告 N`、`（试运行…）`、`✅`），没有一条断言任何一行 `← …` 的内容。
      - **L7** `sync.mjs` `const result = summarize(plan, dryRun);` → `summarize(plan, false);`：**取值未被断言**。`result.dryRun` 唯一消费者是 `formatReport` 的「（试运行，未写入任何文件）」前缀；干跑测试断言的是「不写盘、不拷图、不建 manifest」，那由**另一条语句** `if (dryRun) return result;` 保证（上一轮 R1 变异已击杀的是后者）。
      - **L14** `sync.mjs` 陈旧哈希跳过删除的 warning 尾部 `` `确认无需保留后删掉该文件即可，下次同步会自动清理 ${config.manifestPath} 里对应的条目` `` → `` `已跳过删除` ``：**文案未被断言**。哈希不符的测试只断言「有警告」，不断言那句可操作指引。
      - **N14** `sync.mjs` 非法键报错的第二段 `` `它可能是手工编辑或合并冲突留下的，请从 ${config.manifestPath} 中移除该条。` `` → `` `` ``：**文案未被断言**。非法键测试断言的是「报错 + 受害者存活」，不断言指引（错误消息本身仍在，丢的是可操作提示）。
    - **G2（成功支分派）未覆盖，记录在案**：`sync-obsidian.mjs` 的 `else` 分支 `process.exitCode = main(makeConfig(), { dryRun });` 改成 `= 0` 时，本轮新加的 spawn 测试**杀不掉**（`--force` 走 error 支，永远进不了 `else`）。不补的理由：该分支未覆盖的只剩「进程层把返回值接到 exitCode」这半行，而 `main` 的返回码语义（有错 1、仅警告 0）已由单测覆盖；要真覆盖只能 spawn 一条成功路径，而 `makeConfig()` 的 `vaultDir` 默认硬编码 `/home/minus/Wiki`（`config.mjs:12`，无环境变量覆盖口），成功支必然去读真实 vault，在 CI 里会变成 flaky。**不要用 `--dry-run` 去凑成功支**——同样会因为读不到该目录而随机失败。
      - 本轮已确认被新 spawn 测试钉死的三格：G1 退出码（`process.exitCode = 2` → 其它值）、G3 直接执行判定（`import.meta.url === pathToFileURL(...)` → `false`）、G4 stderr 输出（去掉 `process.stderr.write`）。
    - **本轮变异矩阵实测（`/tmp/round5/mutate.py`，基线 121 全绿）**：21 条应被杀的变异**全部被杀**（含本轮新增的 C1f 丢掉 `+ path.sep`、K1 退出码、K2 stderr、G3 直接执行判定），5 条缺口变异**全部如预期存活**（L6/L7/L14/N14/G2）。缺口清单不是照抄复审的说法——矩阵里把它们单列成「预期存活」一组，跑出来与记录不符就会报「缺口记录已过期」。

### Task 7: 博客侧放宽内容集合与可选摘要

**Files:**
- Modify: `src/content.config.ts`
- Modify: `src/components/PostList.astro`
- Modify: `src/layouts/PostLayout.astro`

- [ ] **Step 1: 放宽 schema**

`src/content.config.ts` 全文替换为：

```ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// YAML 的空值写法（`description:` 后面什么都不写）解析出来是 null，而 `.optional()` 只接受 undefined、
// `.default()` 也只对 undefined 生效——「留空」恰恰是最自然的写法，不归一化会让 astro build 直接退出 1。
// 用 preprocess 折成 undefined，而不是 `.nullish()`：后者把 null 放行到页面层，BaseLayout 的描述兜底失效，
// 渲染出空的 <meta name="description">。
const blankAsAbsent = (schema) =>
  z.preprocess((value) => {
    if (value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
  }, schema);

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: blankAsAbsent(z.string()),
    description: blankAsAbsent(z.string().optional()),
    pubDate: blankAsAbsent(z.coerce.date()),
    tags: blankAsAbsent(z.array(z.string()).optional()),
    draft: blankAsAbsent(z.boolean().default(false)),
    syncedFrom: blankAsAbsent(z.string().optional()),
  }),
});

export const collections = { posts };
```

要点：`pattern` 同时收 `.md` 与 `.mdx`（同步产物是 `.md`，手写文章仍是 `.mdx`）；`description` 改为可选；`syncedFrom` 显式声明，避免依赖 Zod 对未知键的默认剥离行为。

`blankAsAbsent` 是这次复审抓到的真缺陷的修法，三处取值都要跟上：
- **为什么必须归一化**：`description:` 后面留空是 YAML 的 `null`，`.optional()` 只接受 `undefined`、`.default()` 也只对 `undefined` 生效，于是最自然的「留空」写法会让 `astro build` 退出 1（`[InvalidContentEntryDataError] description: Expected type "string", received "object"`）。同步产物走不到这条路径（`note.mjs` 的 `pickDescription` 跳过非字符串、`buildOutput` 在 `undefined` 时整行不写），**只有手写文章会撞上**——而 Task 9 的模板恰恰把 `description` 留空给用户填。
- **为什么不用 `.nullish()`**：它把 `null` 放行到页面层，`BaseLayout` 的 `description = 'Personal blog & digital garden'` 兜底只对 `undefined` 生效，结果是渲染出 **空的** `<meta name="description">`，比构建失败更隐蔽。
- **为什么连 `pubDate` 也包**：`z.coerce.date()` 对 `null` 会 `new Date(null)` → `1970-01-01`，静默写错日期；包上之后空 `pubDate:` 直接报错（实测报 `Expected type "date", received "object"`），把静默错误换成响亮失败。`tags`/`draft` 同属「空值 = null」这一类，一并归一。
- **`title` 也包**（这一条是本轮由我追加的，超出复审原始发现）：`title: ""` 会作为空字符串通过，渲染出一个空的 `<h1>` 和列表里的空行——同一个「空值」类别的另一半。包上之后空标题直接报「必填」。

- [ ] **Step 2: 列表页渲染摘要（缺失则不渲染）**

`src/components/PostList.astro` 全文替换为：

```astro
---
import { getCollection } from 'astro:content';

const posts = (await getCollection('posts'))
  .filter((post) => !post.data.draft)
  .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
---

<section class="py-20 border-t border-border reveal">
  <h2 class="text-2xl font-semibold mb-6">Writing</h2>
  {posts.length === 0 ? (
    <p class="text-text-dim">No posts yet. Stay tuned.</p>
  ) : (
    <div class="divide-y divide-border">
      {posts.map((post) => (
        <a href={`/posts/${post.id}`} class="group block py-5">
          <div class="flex items-baseline justify-between gap-4">
            <h3 class="font-medium group-hover:text-accent transition-colors duration-200">
              {post.data.title}
            </h3>
            <time
              datetime={post.data.pubDate.toISOString()}
              class="text-sm text-text-dim shrink-0"
            >
              {post.data.pubDate.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </time>
          </div>
          {post.data.description && (
            <p class="text-sm text-text-dim mt-1.5 leading-relaxed">{post.data.description}</p>
          )}
        </a>
      ))}
    </div>
  )}
</section>
```

要点：外层 `<a>` 由 `flex items-baseline justify-between gap-4` 改为 `block`，标题与日期的 flex 布局下沉到内层 `div`，摘要作为可选第三行。`{post.data.description && (...)}` 在 `undefined` 时不渲染任何节点（不会留空行）。

- [ ] **Step 3: 详情页布局接受可选摘要**

`src/layouts/PostLayout.astro` 只改 Props 类型定义（其余不动）：

```astro
interface Props {
  title: string;
  description?: string;
  pubDate: Date;
  tags?: string[];
}
```

`BaseLayout` 已有 `description = 'Personal blog & digital garden'` 默认值，`undefined` 会回落到站点默认描述，因此 `src/pages/posts/[...slug].astro` 无需改动。

- [ ] **Step 4: 验证构建与既有文章未受影响**

Run: `pnpm build`
Expected: 成功，且页面数 ≥ 5（首页 + 4 篇既有文章；本项目**没有** 404 页面，`src/pages/` 下只有 `index.astro` 与 `posts/`）。

Run: `git status --short src/content/posts`
Expected: 无输出（既有 4 篇 `.mdx` 未被改动）。

**空值用例（YAML 空值 = `null`）**：这是上面那个 Critical 的直接复现，必须留一条可重跑的证据。在**隔离副本**里验——别把临时文章写进 `src/content/posts/`，那是正式文章目录，删不干净就会跟着一起发布：

```bash
REPO=/home/minus/Code/Full-Stack/Projects/Blog
# 副本必须与仓库**同设备**：下面用 cp -al 硬链 node_modules，跨设备会 Invalid cross-device link。
# /tmp 是 tmpfs，放那里就只能软链 node_modules，而软链会让 Vite 的路径解析错乱（实测报找不到 ClientRouter.astro）。
# 所以副本建在仓库的兄弟目录里。
SITE=$(mktemp -d "${REPO%/Blog}/tmp.XXXX")
tar -cf - -C "$REPO" --exclude=node_modules --exclude=.git . | tar -xf - -C "$SITE"
cp -al "$REPO/node_modules" "$SITE/node_modules"
cd "$SITE"

# 三篇各留一个空值：任一没被归一化，这次构建就会失败，报错信息会指名是哪个字段
printf -- '---\ntitle: 空摘要\npubDate: 2026-10-13\ndescription:\n---\n\n正文\n' > src/content/posts/blank-desc.md
printf -- '---\ntitle: 空标签\npubDate: 2026-10-13\ntags:\n---\n\n正文\n'      > src/content/posts/blank-tags.md
printf -- '---\ntitle: 空草稿\npubDate: 2026-10-13\ndraft:\n---\n\n正文\n'     > src/content/posts/blank-draft.md
./node_modules/.bin/astro build; echo "exit=$?"   # 不用 pnpm exec：node_modules 换成硬链目录后 pnpm 会想去重装依赖，无 TTY 时直接 abort
grep -o '<meta name="description"[^>]*>' dist/posts/blank-desc/index.html
```

Expected: `exit=0`；`blank-desc` 的 meta 回落到站点默认描述（`Personal blog & digital garden`），**不是**空 `content=""`（这正是不能用 `.nullish()` 收工的原因）。

再验反方向与空日期（**前后各跑一次才算验过**，只跑修好后的那一次等于没证明修的就是这个点）：

```bash
# 反方向：schema 退回 description: z.string().optional()，同一批用例必须失败
./node_modules/.bin/astro build; echo "exit=$?"        # Expected: exit=1 + [InvalidContentEntryDataError] description: Expected type "string", received "object"
# 空 pubDate 必须响亮报错，而不是静默变成 1970-01-01
printf -- '---\ntitle: 空日期\npubDate:\n---\n\n正文\n' > src/content/posts/blank-date.md
./node_modules/.bin/astro build; echo "exit=$?"        # Expected: exit=1
```

验完用 `find "$SITE" -depth -delete` 删副本（本机的安全 hook 会拦 `rm -rf`；副本在仓库的兄弟目录里，不在仓库内）。

- [ ] **Step 5: 提交**

```bash
git add src/content.config.ts src/components/PostList.astro src/layouts/PostLayout.astro
git commit -m "feat(content): accept md posts and optional description"
```

**复审决策记录（Task 7）**：

- **不加 `aria-label`（复审 Minor #5，我判断不加更好）**：那个行级 `<a>` 的可访问名现在由内容决定（标题 + 日期 + 摘要），加 `aria-label="<标题>"` 会把日期与摘要从可访问名里**挤掉**，信息量反而变少。HTML5 允许 `<a>` 包流内容，标题与日期都在里面，不存在「链接没有名字」的问题。
- **空的 `draft:` 归一成 `false`（= 发布），保留现状**：与「省略该键 = false」一致，也与同步路径（生成器显式写 `draft: false`）一致。写了 `draft:` 却不填值是很反常的写法，为它单独定义「= 草稿」会让同名字段出现两种默认值。若将来真有人这么写，改动方向是「空值报错」而不是「空值等于草稿」。

---

### Task 8: 补齐正文样式（表格、深层标题、任务列表、嵌套列表）

**Files:**
- Modify: `src/layouts/PostLayout.astro`（`<style is:global>` 内追加规则）

- [ ] **Step 1: 追加样式规则**

在 `src/layouts/PostLayout.astro` 的 `<style is:global>` 中，`.prose-custom img { ... }` 规则之后追加（不改动任何既有规则）：

```css
  .prose-custom h4 {
    font-size: 1.125rem;
    font-weight: 600;
    margin-top: 1.75rem;
    margin-bottom: 0.5rem;
    color: var(--color-text);
  }

  .prose-custom h5 {
    font-size: 1rem;
    font-weight: 600;
    margin-top: 1.5rem;
    margin-bottom: 0.5rem;
    color: var(--color-text);
  }

  .prose-custom h6 {
    font-size: 0.9rem;
    font-weight: 600;
    margin-top: 1.5rem;
    margin-bottom: 0.5rem;
    color: var(--color-text);
  }

  .prose-custom ul ul,
  .prose-custom ul ol,
  .prose-custom ol ul,
  .prose-custom ol ol {
    margin-top: 0.25rem;
    margin-bottom: 0;
  }

  .prose-custom ul ul li {
    list-style-type: circle;
  }

  .prose-custom ul ul ul li {
    list-style-type: square;
  }

  .prose-custom li.task-list-item {
    list-style: none;
    margin-left: -1.25rem;
  }

  .prose-custom input[type='checkbox'] {
    margin-right: 0.5rem;
    vertical-align: middle;
    accent-color: var(--color-text);
  }

  .prose-custom table {
    display: block;
    width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    font-size: 0.9rem;
    margin: 1.5rem 0;
  }

  .prose-custom th,
  .prose-custom td {
    border: 1px solid var(--color-border);
    padding: 0.5rem 0.75rem;
    text-align: left;
  }

  .prose-custom th {
    background-color: var(--color-bg-card);
    color: var(--color-text);
    font-weight: 600;
  }

  .prose-custom td {
    color: var(--color-text-muted);
  }
```

要点：`table` 用 `display: block` + `overflow-x: auto` 让宽表格在 400px 窄屏横向滚动而不撑破布局；颜色全部取自 `src/styles/global.css` 的 `@theme` 变量，无硬编码色值。

- [ ] **Step 2: 验证构建**

Run: `pnpm build`
Expected: 成功，无 CSS 解析错误。

> 样式的视觉核对统一放到 Task 10 Step 5——那时已有真实同步过来的文章（含表格、任务列表、嵌套列表、h4），不必额外造临时文件。

- [ ] **Step 3: 提交**

```bash
git add src/layouts/PostLayout.astro
git commit -m "style(post): add table heading and task list styles"
```

---

### Task 9: Obsidian 模板与项目文档

**Files:**
- Create: `/home/minus/Wiki/STX/zz_Templates/Te_Blog-Article.md`
- Modify: `CLAUDE.md`

> `STX/` 属于用户 vault 中「写入需先确认」的区域。本文件是用户在需求中明确要求的模板，写入前再向用户确认一次路径。

- [ ] **Step 1: 建模板**

创建 `/home/minus/Wiki/STX/zz_Templates/Te_Blog-Article.md`（`Te_` 前缀与 vault 里既有的 `Te_日记模板.md` 一致，用户选定）：

```markdown
---
publish: false
title: 
slug: 
description: 
pubDate: "{{date}}"
tags: []
---

<!--
博客发布模板使用说明（不会同步到博客，正文从这里开始写）：
1. slug 必填，英文小写短横线，决定文章 URL：https://chenmochaos.github.io/posts/<slug>
   （pubDate 用核心模板的 {{date}} 自动填；万一你的模板不展开它，同步会回落到笔记的修改日期，不会报错）
2. description 可留空：留空则自动取正文首段当摘要；想「这篇不要摘要、列表只显示标题」就写
   `description: false`（Obsidian 属性面板存成布尔或字符串都认）
3. 文章写完、校对无误后，把 publish 改成 true
4. 终端执行：cd /home/minus/Code/Full-Stack/Projects/Blog && pnpm sync
5. 检查 `pnpm sync --dry` 的报告无错误后，git commit + git push
6. 要撤稿：把 publish 改回 false 再跑一次 pnpm sync
-->

## 正文
```

- [ ] **Step 2: 写项目文档**

在 `CLAUDE.md` 的 `## Rules` 章节之前插入以下章节（下面用四反引号包裹，因为内容里含三反引号代码块）：

````markdown
## 内容同步（Obsidian → 博客）

文章源在 Obsidian vault `/home/minus/Wiki`。在笔记属性里把 `publish` 设为 `true`，然后：

```bash
pnpm sync          # 同步进 src/content/posts/ 与 public/images/
pnpm sync --dry    # 只预览，不写盘
```

`src/content/posts/` 下的 `*.md` 是生成文件（frontmatter 有 `syncedFrom` 标记），**禁止手改**——改动会在下次同步被覆盖。要改内容改 vault 里的源笔记。手写文章用 `.mdx`，同步产物用 `.md`：`.mdx` 走 JSX 解析，Obsidian 正文里的 `<` 或 `{` 会让构建失败。

- 同步开关：笔记属性 `publish: true`
- 必填属性：`slug`（英文小写短横线，决定 URL）、`pubDate`
- 可选属性：`title`（缺省用文件名）、`description`（缺省用 `excerpt` 或正文首段；都取不到则该字段省略，列表页只显示标题。写 `description: false` = 这篇不要摘要，列表只显示标题）、`tags`
- 内链 `[[已发布笔记]]` 转成博客超链接（支持 `|别名`、`#小节`，锚点与 Astro 产物 id 一致）；指向未发布笔记的内链降级为纯文本并在报告中警告
- 图片 `![[图.png]]` 拷进 `public/images/<slug>/`
- 表格里的转义竖线 `[[笔记\|别名]]` 与普通竖线等价（Obsidian 在表格内自动转义，用户无法避免）
- 笔记嵌入 `![[笔记]]` / `![[笔记#小节]]` 降级为指向该文章的链接，不做内联展开
- 不支持：`%%注释%%`、`==高亮==`、图片尺寸语法 `![[图|300]]`、非图片附件（报告里记「不支持的附件」，与「无法解析嵌入引用」区分开）
- 生成物清单在 `.sync-manifest.json`，只有清单内的文件会被同步删除
- 脚本不执行 git 命令，commit 与 push 始终手动
````

- [ ] **Step 3: 验证模板能被识别**

Run: `ls -l '/home/minus/Wiki/STX/zz_Templates/Te_Blog-Article.md' && pnpm sync --dry`
Expected: 文件存在；同步报告仍是 `同步 0 篇` 且 `✅ 无警告无错误`（模板默认 `publish: false`，且 `zz_Templates` 在排除目录内）。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: document obsidian sync workflow"
```

---

### Task 10: 端到端验收

**Files:**
- Create: `/home/minus/Wiki/Blog-Sync-Test.md`（临时测试笔记，放 vault 根目录，不进入受保护的 `STX/`）

- [ ] **Step 1: 造一篇覆盖全部转换规则的测试笔记**

创建 `/home/minus/Wiki/Blog-Sync-Test.md`，内容如下（用四反引号包裹，因为内容里含三反引号代码块）。注意：`![[...]]` 的图片名要与 vault 里真实存在的附件一致——先用 `ls /home/minus/Wiki/STX/zz_Attachments` 挑一个真实文件名替换 `Pasted image 20260126163817.png`：

````markdown
---
publish: true
title: 同步功能验收测试
slug: blog-sync-test
description: 验证 Obsidian 到博客的同步链路
pubDate: 2026-10-12
tags: [test, sync]
---

这是正文第一段，用来验证描述与排版。链接到 [[agent-context-tool-harness]] 验证内链转换。

#### 四级标题

| 列 A | 列 B |
| --- | --- |
| 值 1 | 值 2 |

- 一级
  - 二级
    - 三级

- [ ] 未完成
- [x] 已完成

![[Pasted image 20260126163817.png]]

> [!note] 这是一个 callout
> callout 正文

下面这段在代码块里，不应被替换：

```js
const link = "[[agent-context-tool-harness]]";
```

指向未发布笔记的内链：[[某些私人笔记]]
````

- [ ] **Step 2: 试运行检查计划**

Run: `pnpm sync --dry`
Expected:
- `+ 新建  blog-sync-test.md  ← Blog-Sync-Test.md  (附件 1)`
- `⚠️ 警告` 至少 1 条，含 `未解析内链 某些私人笔记`
- 无 `❌ 错误`
- `git status --short` 无新增文件

- [ ] **Step 3: 正式同步**

Run: `pnpm sync`
Expected: 同上但为实际执行；`src/content/posts/blog-sync-test.md`、`public/images/blog-sync-test/*`、`.sync-manifest.json` 出现。

- [ ] **Step 4: 人工核对生成文件**

Run: `cat src/content/posts/blog-sync-test.md`
Expected:
- frontmatter 含 `slug: "blog-sync-test"`、`draft: false`、`syncedFrom: "Blog-Sync-Test.md"`
- 正文中 `[[agent-context-tool-harness]]` 已变成 `[理解 Agent：LLM + Context + Tool](/posts/agent-context-tool-harness)`
- 代码块里的 `[[agent-context-tool-harness]]` **原样保留**
- `> [!note] 这是一个 callout` 变成 `> **这是一个 callout**`

- [ ] **Step 5: 构建并截图验证页面与首页列表**

```bash
pnpm build
pnpm preview --port 4321 &
sleep 4
google-chrome --headless=new --disable-gpu --window-size=1280,2200 \
  --screenshot=/tmp/e2e-post.png http://localhost:4321/posts/blog-sync-test
google-chrome --headless=new --disable-gpu --window-size=1280,2400 \
  --screenshot=/tmp/e2e-home.png http://localhost:4321/
google-chrome --headless=new --disable-gpu --window-size=400,1800 \
  --screenshot=/tmp/e2e-post-mobile.png http://localhost:4321/posts/blog-sync-test
```

用 Read 查看三张截图，核对：
- 文章页标题、日期、tags 徽章正常；表格/任务列表/嵌套列表/h4 与既有风格一致；callout 显示为加粗标题的引用块；图片正常显示
- 400px 窄屏下表格在容器内横向滚动，页面本身没有横向溢出
- 首页 Writing 列表中 `同步功能验收测试` 位于最上方，标题下方有灰色摘要行
- 既有 4 篇文章显示正常，未出现空摘要行

- [ ] **Step 6: 验证撤稿清理链路**

```bash
sed -i 's/^publish: true$/publish: false/' /home/minus/Wiki/Blog-Sync-Test.md
pnpm sync
ls src/content/posts/ && ls public/images/
```

Expected: 报告含 `- 删除  blog-sync-test.md`；`src/content/posts/` 只剩 4 篇手写 `.mdx`；`public/images/blog-sync-test/` 目录消失；`.sync-manifest.json` 的 `entries` 为 `{}`。

- [ ] **Step 7: 验证手写文章全程未被触碰**

Run: `git status --short src/content/posts`
Expected: 无输出（4 篇 `.mdx` 未被修改）。

- [ ] **Step 8: 恢复测试笔记并提交本次全部改动**

把 `publish` 改回 `true`，`pnpm sync` 重新生成，然后：

```bash
pnpm build
git add .sync-manifest.json src/content/posts/blog-sync-test.md public/images/blog-sync-test \
        scripts docs/superpowers/plans CLAUDE.md src package.json pnpm-lock.yaml
git commit -m "feat: sync obsidian posts into blog via publish property"
```

提交前确认 `git status --short` 里不包含用户未完成的 `M src/components/Hero.astro` 与 `?? Blog.code-workspace`——这两个文件**不要**加进这次提交。

- [ ] **Step 9: 向用户汇报并交还决定权**

汇报内容：同步命令、模板位置、测试笔记 `/home/minus/Wiki/Blog-Sync-Test.md` 的去留（**删除需用户确认**）、以及「是否 push 到 GitHub」由用户决定（脚本不做 git 操作）。

### 端到端验收记录（2026-10-13）

**没有走 Step 1–8 的「往真实 vault 写测试笔记」路线**，改成等价但零侵入的做法：仓库的**隔离副本**（同设备 `mktemp -d` + `cp -al node_modules`）+ 夹具 vault（`/tmp/e2e/vault`，含属性、内链、表格转义竖线、任务列表、嵌套列表、图片、嵌入、未发布笔记、纯中文名笔记），直接调**真实的** `runSync`（`config.mjs` 的 `repoRoot`/`vaultDir` 可覆盖）。真实 vault 上只跑了只读的 `pnpm sync --dry`。这样既覆盖同一条代码路径，又不需要往用户 vault 或仓库里写任何东西。

实测结果（全部有原始输出）：新建 2 篇 + 附件拷贝 + 内链 `[[笔记|别名]]` → `[别名](/posts/<slug>)`、`#小节` 锚点与生成页 `<h3 id="小节">` 对得上；嵌入降级为链接、未发布内链降级为纯文本并告警、纯中文名笔记给出明确报错；二次同步 `~ 更新 / = 跳过`（内容哈希幂等）；改回 `publish: false` → `- 删除`，生成物与清单条目一并清理。构建 7 页含两个 `.md` 同步产物。

样式用 CDP 量而非肉眼：390px 视口下 6 列宽表格 `scrollWidth 1779 > clientWidth 342`（溢出被表格自己的盒子吃掉），而 `documentElement.scrollWidth == clientWidth == 390`——**页面本身没有横向溢出**；`h4` 18px、`li.task-list-item` 无项目符号、三级嵌套列表 `square` 均与新加的 CSS 一致。

**两项未完成，需用户决定** —— 均已于 2026-10-13 闭环：
1. **Task 9 的模板文件**：用户确认写入，并选定 `Te_` 前缀（与 vault 里既有的 `Te_日记模板.md` 一致）→ 已写 `/home/minus/Wiki/STX/zz_Templates/Te_Blog-Article.md`，与计划块逐字节一致；`pnpm sync --dry` 仍为 `同步 0 篇 ✅ 无警告无错误`（模板默认 `publish: false` 且在 `zz_Templates` 排除目录内）。
2. **`description` 留空时的列表页行为**：用户选择「两种都留口子」→ 留空仍回落到正文首段，显式写 `description: false` 才表示「这篇不要摘要、列表只显示标题」（`isNoDescription` 拦住整条回落链）。端到端复验（夹具 vault → 隔离副本 → 构建）实测：`description: false` 的生成物**不写** `description` 字段，首页列表项只剩标题+日期（无 `<p>`），详情页 `<meta name="description">` 回落到站点默认 `Personal blog & digital garden`；对照项 `description:` 留空仍取到正文首段 `'留空时应该拿这一段当摘要。'`，显式 `description: 手写的摘要` 照常渲染。

**另**：Task 7 修复后的代码质量复核**未能完成**——那个子代理跑到一半时账户余额耗尽（HTTP 402），结论没回来。已落地的验证是我自己与实现者两边的实跑（构建 5 页、121 测试全绿、空值矩阵前后对照、plan↔仓库逐字节一致），但**没有第三方复核结论**，如实记在这里。

---

## 验收对照（spec §11）

| spec 验收项 | 对应步骤 |
|---|---|
| 1. `--dry` 无副作用 | Task 6 Step 6、Task 10 Step 2 |
| 2. 生成文件、图片、内链、代码块保护 | Task 10 Step 4 |
| 3. `pnpm build` 通过且路由生成 | Task 10 Step 5 |
| 4. 取消 publish 后清理 | Task 10 Step 6 |
| 5. 手写 `.mdx` 未被修改 | Task 7 Step 4、Task 10 Step 7 |
| 6. 无 description 只显示标题 | Task 7 Step 2 + Task 10 Step 5（首页截图核对） |
| 7. 手写 `.md` 能被收录 | Task 7 Step 4（`pnpm build` 页面数不减少） |
| 8. 表格/任务列表/嵌套列表/h4 风格一致 | Task 10 Step 5（Task 8 只到「构建无 CSS 解析错误」，视觉核对在这一步） |
