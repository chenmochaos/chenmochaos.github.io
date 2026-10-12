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

### 4.1 `scripts/sync-obsidian.mjs`（入口）+ `scripts/sync/*.mjs`（实现）

入口只做编排，实现拆进 `scripts/sync/`：`config.mjs`、`slug.mjs`、`note.mjs`、`transform.mjs`、`vault.mjs`、`manifest.mjs`、`sync.mjs`，每个模块配同名 `*.test.mjs`（`node --test` 发现，无需配置）。依赖只有两个 devDependency：`js-yaml` 解析 frontmatter、`github-slugger` 生成与 Astro 产物一致的标题锚点（Astro 的 `rehype-collect-headings` 用的就是这个库）。配置常量集中在 `config.mjs`：

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

1. **`scanVault(config, warnings)`** — 递归遍历 vault（跳过 dot 目录与 `excludeDirs`），返回**所有**文件的 `{ absPath, relPath, name }`，不只是 `.md`：附件解析依赖这里一并收集，frontmatter 由调用方用 `parseNote()` 解析。`config` 由 `makeConfig()` 产出，各路径（含 `vaultDir`）已解析为绝对。每个目录内按名称排序后再下探，得到确定的 DFS 序（`readdirSync` 的原始顺序取决于文件系统，ext4 是哈希序、tmpfs 是字节序；不排序则同一份 vault 在不同机器上会挑中不同的同名附件）。比较器显式钉住 `'en'`：`localeCompare` 不传 locale 时跟随 `$LANG`/`LC_ALL`，会让同名附件的胜者乃至产物内容随环境变化。**vault 根目录读不到时抛错，不返回空数组**（见 §7.6）；子目录读不到则写入 `warnings` 后继续遍历。`warnings` **不给默认值**，入口另有 `Array.isArray` 守卫：默认值会让「忘了传 sink」与「故意不收集」无从区分，权限错误连一句提示都留不下；而只传一个实参时 `undefined` 要到真产生警告那一刻才炸，那时错误已经发生、信息照样丢，所以挡在入口。已知限制：不跟随符号链接（`isFile()`/`isDirectory()` 对链接都返回 false），链接笔记会被跳过。
2. **`buildIndexes(scanned, warnings)`** — 拆成 `notes`（`.md`，大小写不敏感）与 `attachments`（非 md 文件按**小写文件名**索引，值为绝对路径）。`warnings` 同样无默认值并带入口守卫。同名附件**先到先得**，胜者由 `scanVault` 的确定序决定，跨目录也不例外：逐目录按名称下探，所以子目录名排在同名文件名之前时，子目录里的那个先被收到、成为胜者（该交错规则由测试钉住）。被丢弃的那个连同胜者写入 `warnings`，不静默丢文件。
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
| `tags` | `tags` 数组 | 缺失或非数组时输出空数组 `tags: []`（详情页用 `tags.length > 0` 判断，空数组不渲染任何标签） |
| `draft` | 固定 `false` | 能被同步出来即视为已发布 |
| `syncedFrom` | 固定为源文件相对 vault 的路径 | 仅作标记；博客 schema 里声明为 `z.string().optional()` 以便可查 |

slug 冲突（两篇笔记解析出同一 slug）：两篇都跳过并报错，要求改 `slug`。

## 6. 正文转换规则

**前置**：所有替换必须先按 fenced code block（` ``` ` / `~~~`）与行内代码（反引号）分段，代码内容原样保留、绝不替换。围栏**开启**的识别容忍任意缩进与 `>` 前缀——列表项里的代码块缩进 4 空格以上、callout 里的代码块每行带 `> `，两者按 CommonMark 的解释都是代码；漏认的代价是改写代码，多认的代价是跳过转换，两者不对称，一律偏保守。注意这个代价并不是「少转换几个链接」：误判的开启会一直吞到下一个同形围栏或文件末尾，其后所有转换都被跳过——方向安全（不改写代码），但影响面可能是一整篇。

**闭合**判定不能照搬开启那套放宽：代码块内部一行 4 空格缩进的 ` ``` ` 或带 `> ` 前缀的 ` ``` ` 在 CommonMark 里都是字面文本，误当闭合会把块提前收掉、其后本属代码的内容被改写（`66419a8` 正是这个回归）。闭合要求与开启**同上下文**：块引用层数相同、缩进不超过 `max(开启缩进, 3)`——顶格围栏的闭合允许缩进到 3 空格（CommonMark 的闭合规则），列表项里的围栏开启就带 4 空格，故取两者较大者，否则合法闭合被漏认、其后整篇被当成代码。缩进按**列**算，制表符推进到下一个 4 的倍数——按字符数 1 计会让 `\t``` ` 被误判成顶格闭合，又回到改写代码。

正文入口先做 CRLF→LF 归一化，产物统一为 LF。已知限制：整行是 callout 标记的跨行行内代码片段仍会被改写（先切行内代码会破坏 callout 的整行判定）；闭合比开启多缩进 2–3 列时会被判为不闭合（方向安全，只漏转换）；开启缩进更深、闭合缩进更浅的形状（如 8 空格开启、4 空格闭合）是否需要闭合取决于**下一行**的缩进，行级判定无法忠实区分，要修必须引入前瞻或块级解析；块引用内、`> ` 之后缩进超过 3 空格的闭合（如 `>     ``` `）在 CommonMark 里是代码，本模块会判成闭合——块引用标记之后的缩进不计入列数，且制表符要按绝对列位推进，同一处修法。这两类形状本 vault 均 0 例（111 篇、451 处围栏中无制表符缩进、无块引用后 4 空格以上的围栏），暂不修；一旦出现，症状是代码块内的内容被当正文转换，且不报警告。

链接解析依赖一张全局表：所有 `publish: true` 笔记的 `笔记名 → slug`（包含本次未变更、已发布过的笔记），因此指向已发布文章的内链能稳定解析。

| Obsidian 语法 | 输出 | 备注 |
|---|---|---|
| `![[图.png]]`、`![[图.png\|300]]` | 附件拷到 `public/images/<slug>/图.png`，改写为 `![图](/images/<slug>/图.png)`（URL 做 percent-encoding） | `\|300` 尺寸语法忽略；同名附件重复引用只拷一次；表格内的竖线转义按普通竖线处理（见本节末说明）；**找不到** → 保留原文并记「无法解析嵌入引用」；**存在但不是图片**（pdf 等）→ 保留原文并记「不支持的附件」——两者必须区分，否则用户会去查一个根本没丢的文件 |
| `[[笔记]]`、`[[笔记\|别名]]` | 目标在全局表中：`[别名或目标标题](/posts/<slug>)` | 别名缺失时用目标笔记的 `title`；别名为空串时同样回退到 `title`（空串不是 nullish，用 `??` 会产出渲染上不可见的空链接）；表格内 Obsidian 自动写成的竖线转义同样按普通竖线处理（见本节末说明） |
| `[[笔记#小节]]`、`[[笔记#小节\|别名]]` | `[别名或标题](/posts/<slug>#小节)` | 锚点用与 Astro 产物 id 相同的 `github-slugger` 生成，与产物 id 一致，两处例外：同名标题（Obsidian 的锚点语法本就无法区分重名，所指为第一处）、标题内含行内链接/图片（Astro 对渲染后的文本取 id，本实现拿到的是原文，`[MDN](url)` 会多出 `url`；已核对本 vault 1653 个标题中无此形态） |
| `[[笔记^块引用]]` | 去掉 `^...` 后同上处理 | |
| `[[#小节]]` | `[小节或别名](#小节)` | 本笔记内的标题链接，生成页内锚点；`[[ ]]`、`[[]]` 这类空目标解析不到时保留原文，绝不删成空文本 |
| `![[笔记]]`、`![[笔记#小节]]` | 降级为 `[标题](/posts/<slug>)`（带锚点） | 笔记嵌入（transclusion）在博客里没有内联展开的形态，降级为链接并记警告「笔记嵌入不支持，已降级为链接」 |
| `[[未发布笔记]]` | 降级为纯文本：`别名 ?? 目标名` | 不产生死链，同时在报告中列出；标签为空时退回原文而不是输出空文本 |
| `> [!note] 标题` | `> **标题**` | 8 处 callout；类型标记丢弃，无标题的标记行整行删除 |
| `%%注释%%`、`==高亮==` | 不做转换 | 在报告中列为警告，提示人工处理 |

> **竖线的两种写法**：Obsidian 用竖线分隔「目标」与「别名」。写进 Markdown 表格时，Obsidian 会自动把它转义成反斜杠 + 竖线（`[[笔记\|别名]]`），而 `[[笔记|别名]]` 在表格里会把单元格切断。读回时两种写法一律等同处理——表格里的内链，用户没法不这样写。

**产物格式为 `.md`（不是 `.mdx`）**：`.mdx` 会按 JSX 解析，Obsidian 正文里常见的 `<` 、`{` 会让构建直接失败；`.md` 走纯 Markdown 管道无此风险，且更贴近 Obsidian 原文。需要组件能力的手写文章继续用 `.mdx`。

## 7. 安全边界（防误删）

1. 只有**同时满足**「在 manifest 中」且「文件路径等于 manifest 记录的路径」的文件才可能被删除或覆盖。手写文章（`hello-world.mdx` 等）永不被触碰。
2. 目标路径已存在但 slug 不在 manifest 中 → 判定为与手写文章冲突，报错、跳过、不覆盖。
3. 取消 `publish`（改为 `false` 或删除属性）或源笔记被删 → 删除 `src/content/posts/<slug>.md` 与 `public/images/<slug>/` 整个目录，并从 manifest 移除。
4. manifest 记录生成时的内容哈希；下次同步若发现磁盘上生成文件哈希与记录不符（说明生成文件被手工改过）→ 报告显式警告，随后仍以 vault 为准覆盖（vault 是唯一源）。
5. 脚本不执行任何 git 命令；commit 与 push 始终由用户决定。
6. **vault 根目录读不到（路径拼错、外置盘/网盘未挂载）→ 报错退出，不执行任何删除或写入。** 根目录读不到与「vault 是空的」在扫描结果上无法区分，若按空结果走 §7.3 的清理逻辑，一次路径笔误就会清空 `src/content/posts/` 下所有生成物。为此 `scanVault` 在根目录失败时抛错，且同步层另加一道闸：扫描到 0 篇笔记而 manifest 非空时，拒绝执行删除并报错（`warnings` 只作提示、不阻断，单靠它挡不住这条路径）。
7. **有目录读不到时（`warnings` 里出现「无法读取目录」）本次不执行任何删除。** 部分扫描与完整扫描在结果上同样无从区分：读不到的目录里的笔记会被误判成「源笔记已删除」，从而清掉它们的生成物。被漏读的笔记下一轮补回来即可，误删却要用户自己去 git 里捞。
   6、7 两条闸都必须在 `planSync` 里以**不生成删除动作**实现：`runSync` 调用 `applySync` 前并不检查 `plan.errors`（错误只影响退出码），所以「push 一条 error」只会在删完之后才打印出来。

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
  - 无法解析嵌入引用 ![[x.png]] @ STX/散文/y.md
❌ 错误 1
  - STX/AI/未命名.md：文件名无法生成 slug，请在笔记中填写 slug 属性
```

同一条警告重复出现时折叠成一行并在行尾标出次数（`（×100）`），但 `⚠️ 警告 N` 里的 N 仍是实际条数：一行里的上百个相同内链不该把报告刷满。

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
| `package.json` | 加 `"sync": "node scripts/sync-obsidian.mjs"`；devDependency 加 `js-yaml`、`github-slugger` | 入口与 YAML 解析、锚点 |
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
- 笔记嵌入（`![[笔记]]`）的内联展开（仅降级为链接）
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
| 跨行行内代码片段里整行是 callout 标记时会被改写 | 形状罕见；先切行内代码会破坏 callout 的整行判定，取舍已记录在 `transform.mjs` 的注释里 |
| 围栏开启识别偏保守，误判的开启会吞掉其后直到下一个同形围栏的内容 | 方向安全（跳过转换而非改写代码），按 §6 前置的取舍原则接受；已核对本 vault 111 篇笔记在修复前后解析结果一致 |
| vault 路径写错或未挂载导致扫描为空，进而在清理阶段删光生成物 | §7.6：根目录读不到即抛错；再做一道「0 篇笔记 + manifest 非空 → 拒绝删除」的闸 |
| vault 某个子目录读不到（权限、竞态）导致那里的笔记被当成「源已删除」，产物被清掉 | §7.7：只要出现「无法读取目录」警告，本次不执行任何删除；被漏读的笔记下一轮补回 |
| 同名附件冲突（同名图片分处两个目录）时丢掉一个，且附件按 DFS 序先到先得、笔记按短路径优先，两者策略不一致 | 冲突写入报告并指明胜者，不静默丢；胜者规则（含根目录与子目录同名时的交错）由测试钉住。真实 vault 当前 0 处同名附件冲突。策略不一致是有意保留：附件索引的值是扁平文件名，没有「路径深度」这个可比量 |
| vault 里的符号链接笔记不被跟随 | 已知限制（§4.1.1）；真实 vault 唯一的链接位于被排除的 `.claude/` 下，暂不受影响 |
