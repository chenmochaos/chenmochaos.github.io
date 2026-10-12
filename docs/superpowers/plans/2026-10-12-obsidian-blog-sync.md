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

/** 摘要优先级：description > excerpt > 正文首段；都取不到返回 undefined（调用方省略该字段）。 */
export function pickDescription(data, body, maxChars = 120) {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `Cannot find module './config.mjs'`

- [ ] **Step 3: 实现 config**

创建 `scripts/sync/config.mjs`：

```js
import path from 'node:path';

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
  excludeDirs: ['.obsidian', '.trash', '.claude', '.claudian', 'zz_Templates', 'node_modules'],
  imageExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'],
};

/** 合并覆盖项并把相对路径解析成绝对路径。 */
export function makeConfig(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
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

/** 递归遍历 vault，跳过 dot 目录与 excludeDirs，结果按名称排序以保证顺序稳定。 */
export function scanVault(config) {
  const collected = [];
  walk(config.vaultDir, config.vaultDir, config, collected);
  return collected;
}

function walk(dir, root, config, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录读不到（权限/竞态）时静默跳过，不影响其余文件
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || config.excludeDirs.includes(entry.name)) continue;
      walk(abs, root, config, out);
    } else if (entry.isFile()) {
      out.push({
        absPath: abs,
        relPath: path.relative(root, abs).split(path.sep).join('/'),
        name: entry.name,
      });
    }
  }
}

/** 拆成笔记数组与 附件名(小写) -> 绝对路径 的索引。同名附件先到先得（顺序已排序）。 */
export function buildIndexes(scanned) {
  const notes = [];
  const attachments = new Map();

  for (const file of scanned) {
    if (file.name.toLowerCase().endsWith('.md')) {
      notes.push(file);
      continue;
    }
    const key = file.name.toLowerCase();
    if (!attachments.has(key)) attachments.set(key, file.absPath);
  }

  return { notes, attachments };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS —— 累计 75 + 6 = 81 项通过

- [ ] **Step 6: 提交**

```bash
git add scripts/sync/config.mjs scripts/sync/vault.mjs scripts/sync/vault.test.mjs
git commit -m "feat(sync): add config and vault scanning"
```

---

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
  const loaded = loadManifest(config);
  assert.deepEqual(Object.keys(loaded.entries), ['a', 'b']); // 键已排序
  assert.equal(loaded.entries.a.source, 'a.md');
  assert.match(loaded.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
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

/** 读取生成物清单；文件缺失、损坏或结构不符时一律降级为空清单。 */
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
Expected: PASS —— 累计 81 + 5 = 86 项通过

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
import { makeConfig } from './config.mjs';
import { planSync, runSync, formatReport } from './sync.mjs';

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
  assert.ok(result.warnings.some((w) => /未解析内链 private-note/.test(w)));
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
import { resolveSlug } from './slug.mjs';
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
 * 计算本次同步要做的事。零副作用：只读文件、不写盘、不拷贝。
 * 返回 { actions, warnings, errors }。
 */
export function planSync(config) {
  const warnings = [];
  const errors = [];
  const { notes: noteFiles, attachments } = buildIndexes(scanVault(config));

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
    const entry = manifest.entries[note.slug];
    const exists = fs.existsSync(outputPath);

    // 目标存在但不在清单里 → 与手写文章冲突，拒绝覆盖
    if (exists && !entry) {
      errors.push(
        `slug「${note.slug}」的目标文件 ${config.contentDir}/${note.slug}.md 已存在且不是生成文件，拒绝覆盖（请改用别的 slug）`
      );
      continue;
    }

    const previousContent = exists ? fs.readFileSync(outputPath, 'utf8') : null;
    if (entry && previousContent !== null && hashText(previousContent) !== entry.outputHash) {
      warnings.push(`${note.relPath}: 生成文件 ${note.slug}.md 被手工改过，将以 vault 为准覆盖`);
    }

    const type = previousContent === null ? 'create' : previousContent === content ? 'skip' : 'update';
    actions.push({
      type,
      slug: note.slug,
      sourceRel: note.relPath,
      outputPath,
      content,
      outputHash: hashText(content),
      images: [...imagePlan.entries()].map(([sourceAbs, planned]) => ({ sourceAbs, ...planned })),
      previousImages: entry?.images ?? [],
      warnings: noteWarnings,
    });
  }

  // 7. 清单里有、但这次不再发布的 → 删除
  const currentSlugs = new Set(finalNotes.map((note) => note.slug));
  for (const [slug, entry] of Object.entries(manifest.entries)) {
    if (currentSlugs.has(slug)) continue;
    actions.push({
      type: 'delete',
      slug,
      sourceRel: entry.source,
      outputPath: path.join(config.contentDirAbs, `${slug}.md`),
      content: null,
      outputHash: null,
      images: [],
      previousImages: entry.images ?? [],
      warnings: [],
    });
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
Expected: PASS —— 累计 86 + 14 = 100 项通过

- [ ] **Step 5: 写命令行入口并加 sync 脚本**

创建 `scripts/sync-obsidian.mjs`：

```js
#!/usr/bin/env node
import { makeConfig } from './sync/config.mjs';
import { runSync, formatReport } from './sync/sync.mjs';

const dryRun = process.argv.slice(2).includes('--dry');
const result = runSync(makeConfig(), { dryRun });

process.stdout.write(`${formatReport(result)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
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

---

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

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date(),
    tags: z.array(z.string()).optional(),
    draft: z.boolean().default(false),
    syncedFrom: z.string().optional(),
  }),
});

export const collections = { posts };
```

要点：`pattern` 同时收 `.md` 与 `.mdx`（同步产物是 `.md`，手写文章仍是 `.mdx`）；`description` 改为可选；`syncedFrom` 显式声明，避免依赖 Zod 对未知键的默认剥离行为。

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
Expected: 成功，且页面数 ≥ 5（首页 + 404 + 4 篇既有文章）。

Run: `git status --short src/content/posts`
Expected: 无输出（既有 4 篇 `.mdx` 未被改动）。

- [ ] **Step 5: 提交**

```bash
git add src/content.config.ts src/components/PostList.astro src/layouts/PostLayout.astro
git commit -m "feat(content): accept md posts and optional description"
```

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

- [ ] **Step 3: 验证构建**

Run: `pnpm build`
Expected: 成功，无 CSS 解析错误。

> 样式的视觉核对统一放到 Task 10 Step 5——那时已有真实同步过来的文章（含表格、任务列表、嵌套列表、h4），不必额外造临时文件。

- [ ] **Step 4: 提交**

```bash
git add src/layouts/PostLayout.astro
git commit -m "style(post): add table heading and task list styles"
```

---

### Task 9: Obsidian 模板与项目文档

**Files:**
- Create: `/home/minus/Wiki/STX/zz_Templates/Blog-Article.md`
- Modify: `CLAUDE.md`

> `STX/` 属于用户 vault 中「写入需先确认」的区域。本文件是用户在需求中明确要求的模板，写入前再向用户确认一次路径。

- [ ] **Step 1: 建模板**

创建 `/home/minus/Wiki/STX/zz_Templates/Blog-Article.md`：

```markdown
---
publish: false
title: 
slug: 
description: 
pubDate: 2026-10-12
tags: []
---

<!--
博客发布模板使用说明（不会同步到博客，正文从这里开始写）：
1. slug 必填，英文小写短横线，决定文章 URL：https://chenmochaos.github.io/posts/<slug>
2. description 可留空，留空则首页列表只显示标题与日期
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
- 可选属性：`title`（缺省用文件名）、`description`（缺省用 `excerpt` 或正文首段；都取不到则该字段省略，列表页只显示标题）、`tags`
- 内链 `[[已发布笔记]]` 转成博客超链接（支持 `|别名`、`#小节`，锚点与 Astro 产物 id 一致）；指向未发布笔记的内链降级为纯文本并在报告中警告
- 图片 `![[图.png]]` 拷进 `public/images/<slug>/`
- 表格里的转义竖线 `[[笔记\|别名]]` 与普通竖线等价（Obsidian 在表格内自动转义，用户无法避免）
- 笔记嵌入 `![[笔记]]` / `![[笔记#小节]]` 降级为指向该文章的链接，不做内联展开
- 不支持：`%%注释%%`、`==高亮==`、图片尺寸语法 `![[图|300]]`、非图片附件（报告里记「不支持的附件」，与「无法解析嵌入引用」区分开）
- 生成物清单在 `.sync-manifest.json`，只有清单内的文件会被同步删除
- 脚本不执行 git 命令，commit 与 push 始终手动
````

- [ ] **Step 3: 验证模板能被识别**

Run: `ls -l '/home/minus/Wiki/STX/zz_Templates/Blog-Article.md' && pnpm sync --dry`
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
| 8. 表格/任务列表/嵌套列表/h4 风格一致 | Task 8 Step 3、Task 10 Step 5 |
