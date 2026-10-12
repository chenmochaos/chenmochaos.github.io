# Obsidian → 博客单向上传同步 设计文档

日期：2026-10-12
状态：待实施
关联项目：`/home/minus/Code/Full-Stack/Projects/Blog`，Vault：`/home/minus/Wiki`

## 1. 问题

博客文章目前靠从 Obsidian 手动复制粘贴。源笔记改动后博客不跟着变，同一篇文章要维护两份。

目标：在 Obsidian 笔记里加一个 `publish: true` 属性即视为"要发布"，本地跑一条命令把文章同步进博客仓库，无需手动搬运内容。

## 2. 关键约束（决定了方案形态）

| 约束 | 事实 | 影响 |
|---|---|---|
| 构建环境 | GitHub Actions 从仓库构建静态站，推 `main` 即部署 | 内容必须在仓库内，不能软链到本地 vault |
| Vault 位置 | `/home/minus/Wiki`，**不是 git 仓库** | 无法用 submodule |
| Vault 隐私 | 173 篇笔记含日记、面试、理财等私人内容 | 整个 vault 不能进 git |
| 现有约定 | 文章必须落在 `src/content/posts/`，loader glob 当前为 `**/*.mdx` | 同步产物须写进该目录 |
| 手动操作纪律 | git push 属用户保留操作 | 脚本不得执行任何 git 命令 |

**结论**：唯一合理形态是「本地同步脚本把 vault 中标记发布的笔记转换并复制进仓库」。Astro 直接指向 vault 路径的方案在 CI 上必然构建失败，否决。

## 3. 架构

```
/home/minus/Wiki/STX/**.md    (frontmatter: publish: true)
        │
        │  pnpm sync   →  scripts/sync-obsidian.mjs
        ▼
src/content/posts/<slug>.md         生成的副本（frontmatter 带 syncedFrom 标记）
public/images/<slug>/*              附件副本
.sync-manifest.json                 生成物清单（用于清理与一致性校验）
        │
        │  用户手动 git commit + git push
        ▼
GitHub Actions → https://chenmochaos.github.io/
```

单向：Vault 是唯一内容源，博客侧的文件全部是派生产物。

## 4. 组件

### 4.1 `scripts/sync-obsidian.mjs`

零业务依赖（仅用 `node:fs` / `node:path` / `node:crypto` + `gray-matter` 解析 frontmatter），配置常量集中在文件顶部：

```js
const CONFIG = {
  vaultDir: '/home/minus/Wiki',
  publishProperty: 'publish',
  contentDir: 'src/content/posts',
  imagesDir: 'public/images',
  manifestPath: '.sync-manifest.json',
  excludeDirs: ['.obsidian', '.trash', '.claude', '.claudian', 'zz_Templates', 'node_modules'],
  descriptionMaxChars: 120,
};
```

脚本以仓库根目录为工作目录（由 `pnpm sync` 从根目录调起），所有相对路径均相对于 `process.cwd()` 解析。

职责分解（各自可独立理解与测试）：

1. **`scanVault()`** — 递归遍历 vault（跳过 `excludeDirs`），返回所有 `.md` 文件及其解析后的 frontmatter。
2. **`buildIndexes(files)`** — 建立两个索引：`noteName → file`（笔记按文件名基名）、`attachmentName → file`（所有非 md 文件按文件名基名，用于解析 `![[图片]]`）。
3. **`resolveSlugs(publishable)`** — 为每篇待发布笔记确定 slug，检出冲突与非法 slug。
4. **`transformBody(body, ctx)`** — 正文转换（见 §6），按代码块分段，代码块内不做任何替换。
5. **`writeOutputs()`** — 写文件、拷贝附件、写 manifest。生成内容与磁盘上现有文件完全一致时不重写（避免无意义的 git diff 与 mtime 抖动），报告中记为"跳过"。
6. **`cleanup()`** — 删除已取消发布/源文件已删除的生成物。
7. **`report()`** — 打印同步结果。

### 4.2 Obsidian 模板 `STX/zz_Templates/Blog-Article.md`

```markdown
---
publish: false
title: 
slug: 
description: 
pubDate: 2026-10-12
tags: []
---
```

- `publish` 默认 `false`：避免写了一半的草稿被一次 `pnpm sync` 误发出去，文章写完再翻成 `true`。
- `slug` 必填且必须是英文小写短横线格式，它决定文章 URL `/posts/<slug>`。
- 模板所在目录 `zz_Templates` 在 `excludeDirs` 内，模板自身不会被当成文章。

## 5. 字段映射

| 输出字段 | 取值优先级 | 缺省行为 |
|---|---|---|
| `title` | `title` → 文件名（去扩展名） | 两者皆空：报错并跳过该篇 |
| `slug` | `slug` 属性 → 文件名净化（小写、空格转 `-`、剔除 ASCII 外字符、折叠连续 `-`） | 净化为空或长度 < 2：报错并跳过，要求补 `slug` |
| `description` | `description` → `excerpt` → 正文首个普通段落（跳过标题、图片、引用、列表行）截断 120 字 | 都取不到：**不写该字段**（列表页与详情页均不显示摘要） |
| `pubDate` | `pubDate` → `date` → 源文件 mtime | 归一化为 `YYYY-MM-DD` |
| `tags` | `tags` 数组 | 缺失则省略字段 |
| `draft` | 固定 `false` | 能被同步出来即视为已发布 |
| `syncedFrom` | 固定为源文件相对 vault 的路径 | 仅作标记，博客 schema 会忽略该键 |

slug 冲突（两篇笔记解析出同一 slug）：两篇都跳过并报错，要求改 `slug`。

## 6. 正文转换规则

**前置**：所有替换必须先按 fenced code block（` ``` ` / `~~~`）与行内代码（反引号）分段，代码内容原样保留、绝不替换。

链接解析依赖一张全局表：所有 `publish: true` 笔记的 `笔记名 → slug`（包含本次未变更、已发布过的笔记），因此指向已发布文章的内链能稳定解析。

| Obsidian 语法 | 输出 | 备注 |
|---|---|---|
| `![[图.png]]`、`![[图.png\|300]]` | 附件拷到 `public/images/<slug>/图.png`，改写为 `![图](/images/<slug>/图.png)`（URL 做 percent-encoding） | `\|300` 尺寸语法忽略；同名附件重复引用只拷一次；附件找不到则保留原文并记警告 |
| `[[笔记]]`、`[[笔记\|别名]]` | 目标在全局表中：`[别名或目标标题](/posts/<slug>)` | 别名缺失时用目标笔记的 `title` |
| `[[笔记#小节]]`、`[[笔记#小节\|别名]]` | `[别名或标题](/posts/<slug>#小节)` | 锚点小节名按原文本输出 |
| `[[笔记^块引用]]` | 去掉 `^...` 后同上处理 | |
| `[[未发布笔记]]` | 降级为纯文本：`别名 ?? 目标名` | 不产生死链，同时在报告中列出 |
| `> [!note] 标题` | `> **标题**` | 8 处 callout；类型标记丢弃，无标题的标记行整行删除 |
| `%%注释%%`、`==高亮==` | 不做转换 | 在报告中列为警告，提示人工处理 |

**产物格式为 `.md`（不是 `.mdx`）**：`.mdx` 会按 JSX 解析，Obsidian 正文里常见的 `<` 、`{` 会让构建直接失败；`.md` 走纯 Markdown 管道无此风险，且更贴近 Obsidian 原文。需要组件能力的手写文章继续用 `.mdx`。

## 7. 安全边界（防误删）

1. 只有**同时满足**「在 manifest 中」且「文件路径等于 manifest 记录的路径」的文件才可能被删除或覆盖。手写文章（`hello-world.mdx` 等）永不被触碰。
2. 目标路径已存在但 slug 不在 manifest 中 → 判定为与手写文章冲突，报错、跳过、不覆盖。
3. 取消 `publish`（改为 `false` 或删除属性）或源笔记被删 → 删除 `src/content/posts/<slug>.md` 与 `public/images/<slug>/` 整个目录，并从 manifest 移除。
4. manifest 记录生成时的内容哈希；下次同步若发现磁盘上生成文件哈希与记录不符（说明生成文件被手工改过）→ 报告显式警告，随后仍以 vault 为准覆盖（vault 是唯一源）。
5. 脚本不执行任何 git 命令；commit 与 push 始终由用户决定。

manifest 结构：

```json
{
  "version": 1,
  "generatedAt": "2026-10-12T14:00:00.000Z",
  "entries": {
    "<slug>": {
      "source": "STX/AI/how-to-learn.md",
      "output": "src/content/posts/how-to-learn.md",
      "outputHash": "sha256:...",
      "images": ["public/images/how-to-learn/foo.png"]
    }
  }
}
```

## 8. 命令行与报告

- `pnpm sync` — 执行同步
- `pnpm sync --dry` — 只计算并打印计划，不写盘、不删文件

报告格式（stdout）：

```
📥 同步 3 篇
  + 新建  how-to-learn.md        ← STX/AI/how-to-learn.md
  ~ 更新  agent-notes.md         ← STX/AI/agent-notes.md  (附件 1)
  - 删除  old-post.md            ← 源已取消 publish
⚠️ 警告 2
  - 未解析内链 [[未发布笔记]] @ STX/AI/how-to-learn.md
  - 缺失附件 ![[x.png]] @ STX/散文/y.md
❌ 错误 1
  - STX/AI/未命名.md：文件名无法生成 slug，请在笔记中填写 slug 属性
```

退出码：有错误时非 0（便于日后接入 pre-commit 或 CI 校验）；仅有警告时为 0。

## 9. 博客侧配套改动

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/content.config.ts` | loader pattern 改为 `**/*.{md,mdx}` | 同步产物是 `.md`，当前 glob 只收 `.mdx`（此坑已踩过 3 次） |
| `src/content.config.ts` | `description: z.string().optional()` | 无摘要的文章是合法状态 |
| `src/components/PostList.astro` | 标题下方渲染 `post.data.description`，缺失时不渲染该行 | 当前组件根本没渲染摘要，需先补上才能谈"没有就不显示" |
| `src/layouts/PostLayout.astro` | `description?: string` | 类型跟随 schema |
| `src/layouts/PostLayout.astro` | `.prose-custom` 补齐表格、h4/h5/h6、任务列表、嵌套列表样式 | 见 §9.1 |
| `src/pages/posts/[...slug].astro` | 透传 `post.data.description`（可为 `undefined`） | 同上 |
| `src/layouts/BaseLayout.astro` | 不改 | 已有 `description = 'Personal blog & digital garden'` 兜底，`undefined` 不会渲染成字符串 "undefined" |
| `package.json` | 加 `"sync": "node scripts/sync-obsidian.mjs"`；devDependency 加 `gray-matter` | 入口与 YAML 解析 |
| `CLAUDE.md` | 新增「内容同步」章节：同步命令、生成文件禁止手改、模板字段约定、`.md` 与 `.mdx` 的分工 | 约束先行，规则进文档 |
| `STX/zz_Templates/Blog-Article.md` | 新建模板 | 用户要求 |

`.sync-manifest.json` 提交进仓库（体积小，记录生成物来源）。

### 9.1 正文样式补齐（`.prose-custom`）

Vault 中实际使用但博客样式表未覆盖的元素统计：表格 11 篇、任务列表 9 篇、h4 及更深标题 3 篇、嵌套列表 23 篇。Obsidian 笔记同步过来后这些元素会以裸样式渲染，需补齐，全部沿用既有设计变量（`--color-border`、`--color-bg-card`、`--color-text-muted` 等）：

| 元素 | 样式要求 |
|---|---|
| `table` | 宽度自适应容器、`border-collapse`、表头背景用 `--color-bg-card`、单元格边框用 `--color-border`、字号 `0.9rem`；窄屏可横向滚动 |
| `h4` / `h5` / `h6` | 按 `1.125rem` / `1rem` / `0.9rem` 递减，字重 600，与 h2/h3 同一套上边距节奏 |
| 任务列表 | 去掉 `li` 默认圆点，`list-style: none` + 负外边距归位，输入框与文本基线对齐，复选框用 `accent-color` 跟随强调色 |
| 嵌套列表 | 二级及更深层换用 `circle` / `square` 标记，行高略收紧，保证层级一眼可辨 |

不改动现有已定义的 h2/h3/p/a/blockquote/pre/code/img 规则。

## 10. 非目标

- 双向同步（博客 → Vault）
- 自动 `git commit` / `git push`
- `![[图|300]]` 的尺寸渲染（仅忽略尺寸标记）
- callout 的类型化样式（仅去除标记保留引用块）
- 监听文件变化的常驻 watch 进程
- 图片压缩与 Git LFS

## 11. 验收标准

每条都可用命令复现：

1. `pnpm sync --dry` 打印计划，`git status` 无任何变化。
2. 在 vault 新建测试笔记（`publish: true`、合法 `slug`、含一个指向已发布文章的内链、一张 `![[图片]]`、一段带 `[[` 的代码块）→ `pnpm sync`：
   - 生成 `src/content/posts/<slug>.md`，frontmatter 含 `syncedFrom`；
   - 图片出现在 `public/images/<slug>/`；
   - 内链变成 `[... ](/posts/<目标 slug>)`；
   - 代码块内的 `[[` 原样保留；
   - manifest 出现该条记录。
3. `pnpm build` 通过，路由 `/posts/<slug>` 生成。
4. 把测试笔记改 `publish: false` → `pnpm sync` → 生成文件与图片目录被删除，manifest 记录消失。
5. 全流程结束后 `git status` 中 `hello-world.mdx`、`agent-context-tool-harness.mdx`、`ollama-qwen-coder-continue-autocomplete.mdx`、`redis-cache-strategies.mdx` 均未被修改。
6. 一篇无 `description` 的文章：首页列表只显示标题与日期（无摘要行、无空行占位），文章详情页正常渲染，`<meta name="description">` 回落到站点默认值。
7. 手写一篇 `.md` 文章放进 `src/content/posts/`，`pnpm build` 能正常收录（验证 glob 放宽生效）。
8. 构造一篇含表格、任务列表、嵌套列表、h4 的同步文章，页面渲染后元素间距、边框、字号与既有 h2/h3、列表风格一致，无裸样式；1280px 与 400px 两个宽度下表格不撑破布局。

## 12. 风险

| 风险 | 应对 |
|---|---|
| 生成文件与图片进 git，仓库体积增长 | 当前量级可忽略（单篇图片 < 1MB）；后续量大再评估 LFS |
| vault 路径硬编码 | 集中在 `CONFIG`，改一处即可；CI 不跑同步脚本，无影响 |
| 内链目标未被标记发布时降级为纯文本 | 符合预期（用户要求），并在报告中列出以便补 `publish` |
| 部分 Obsidian 语法（`%%`、`==`）未转换 | 明确列为非目标，报告警告提示 |
