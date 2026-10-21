# Blog - Personal Website

## Project Overview
Minus 的个人博客网站，集个人名片与文章发布于一体。黑色简约高级风格，参考 https://letters.thedankoe.com/。

## Tech Stack
- **Framework**: Astro v6 + MDX
- **Styling**: Tailwind CSS v4 (CSS-first config, 无 tailwind.config.mjs)
- **Knowledge Graph**: Sigma.js + Graphology + d3-force (Obsidian-style forces/drag; 唯一允许的客户端 JS，懒加载)
- **Animation**: CSS native transitions only (no JS animation libraries)
- **Deploy**: GitHub Pages (via GitHub Actions, static) — https://chenmochaos.github.io/
- **Package Manager**: pnpm

## Directory Structure
```
Blog/
├── src/
│   ├── layouts/
│   │   ├── BaseLayout.astro      # HTML shell, meta, global styles
│   │   └── PostLayout.astro      # Article detail page layout
│   ├── components/
│   │   ├── Hero.astro            # Name + tagline + social links
│   │   ├── About.astro           # Background, skills, current focus
│   │   ├── Projects.astro        # Project cards grid
│   │   ├── PostList.astro        # Article list with title/date/excerpt
│   │   ├── KnowledgeGraph.astro  # Obsidian-style graph: posts + tags + internal links
│   │   ├── TableOfContents.astro # Article outline, right rail at xl+ (h2/h3, scroll-spy)
│   │   ├── Footer.astro          # Contact info + links
│   │   └── SocialLinks.astro     # Reusable social icon links
│   ├── pages/
│   │   ├── index.astro           # Single-page home (all sections)
│   │   └── posts/
│   │       └── [...slug].astro   # Dynamic article detail page
│   ├── content/
│   │   └── posts/                # MDX article files
│   │       └── hello-world.mdx   # Example post
│   ├── styles/
│   │   └── global.css            # Tailwind directives + custom base styles
│   ├── lib/
│   │   ├── graph-data.mjs        # Pure builder: posts/tags/links → graph JSON
│   │   └── graph-view.js         # Browser view: sigma + d3-force, Obsidian-style feel
├── public/
│   └── fonts/                    # Self-hosted fonts if needed
├── .github/
│   └── workflows/
│       └── deploy.yml            # GitHub Pages 构建 + 发布
├── astro.config.mjs
├── tsconfig.json
├── package.json
└── CLAUDE.md
```

## Naming Conventions
- Components: PascalCase (`PostList.astro`)
- Pages: kebab-case or `[...slug]` pattern
- MDX posts: kebab-case with date prefix optional (`hello-world.mdx`)
- CSS classes: Tailwind utility-first, avoid custom class names unless truly reusable
- Content collection: `posts` (singular noun collection name in config)

## Design System

### Colors (Dark Theme)
定义在 `src/styles/global.css` 的 `@theme` 里。`@theme` 的每个键都会生成对应工具类，所以颜色一律用工具类，不写死 hex（`bg-bg-card`、`text-text-dim`、`border-border`）。

```
--color-bg:        #000000    (page background)          → bg-bg
--color-bg-card:   #141414    (cards, elevated surfaces) → bg-bg-card
--color-bg-hover:  #1a1a1a    (hover states)             → bg-bg-hover
--color-border:    #262626    (dividers, card borders)   → border-border
--color-text:      #fafafa    (headings, body text)      → text-text
--color-text-muted:#a1a1a1    (paragraphs, descriptions) → text-text-muted
--color-text-dim:  #6b6b6b    (dates, footer, least important) → text-text-dim
--color-accent:    #e5e5e5    (hover highlights)         → text-accent
```

### Typography
- **Font Family**: `Inter` (body) + `system-ui` fallback
- **Heading sizes**: Hero title 4xl-6xl, section titles 2xl-3xl, card titles lg-xl
- **Body**: base (16px), leading-relaxed
- **Weight**: 300 (body), 400 (normal), 600 (headings), 700 (hero title)
- **Letter spacing**: tight for headings, normal for body

### Spacing
- Section vertical padding: `py-20` to `py-32`
- Max content width: `max-w-content` (800px, reading-optimized)
- Article detail page passes `wide` → `max-w-wide` (1328px) at `xl` and up: a 3-column track whose middle column is pinned to 47rem (752px — the 800px container minus `<main>`'s `px-6` gutters, i.e. the width the body already had), so the body keeps its exact width and centering while the right rail holds the outline. Below `xl` the rail is hidden and the article falls back to the plain single column
- Component gap: `space-y-6` to `space-y-8`

### Animations
- Page load: fade-in (`opacity 0→1, 0.6s ease`)
- Scroll reveal: elements fade-in + slight translateY (`20px→0, 0.5s`)
- Hover: color transitions (`0.2s ease`), subtle scale on project cards (`scale-[1.02]`)
- Links: underline slide-in on hover (CSS only)
- Page transitions: Astro View Transitions API (fade)

## Development Commands
```bash
pnpm dev          # Start dev server
pnpm build        # Build for production
pnpm preview      # Preview production build locally
```

## Content Authoring
手写文章是 `src/content/posts/` 下的 `.mdx`。Frontmatter schema:
```yaml
---
title: "Article Title"
description: "Short excerpt for the list view"   # 可省略；留空也可以，列表页只显示标题与日期
pubDate: 2024-01-15
updatedAt: 2024-02-20                           # 可省略；手写文章要自己填，同步产物由脚本写入
tags: ["web3", "dev"]                            # 可省略
draft: false
---
```

同步进来的文章是 `.md`（见下一节），**不要手改**。

## 内容同步（Obsidian → 博客）

文章源在 Obsidian vault `/home/minus/Wiki`。在笔记属性里把 `publish` 设为 `true`，然后：

```bash
pnpm sync          # 同步进 src/content/posts/ 与 public/images/
pnpm sync --dry    # 只预览，不写盘
```

`src/content/posts/` 下的 `*.md` 是生成文件（frontmatter 有 `syncedFrom` 标记），**禁止手改**——改动会在下次同步被覆盖。要改内容改 vault 里的源笔记。手写文章用 `.mdx`，同步产物用 `.md`：`.mdx` 走 JSX 解析，Obsidian 正文里的 `<` 或 `{` 会让构建失败。

- 同步开关：笔记属性 `publish: true`
- 必填属性：`slug`（英文小写短横线，决定 URL）、`pubDate`
- 可选属性：`title`（缺省用文件名）、`description`（缺省用 `excerpt` 或正文首段；都取不到则该字段省略，列表页只显示标题。写 `description: false` = 这篇不要摘要，列表只显示标题）、`tags`、`updated`（最后修改时间，产物里写成 `updatedAt`；缺省回落到源文件 mtime。源笔记里这个属性由 Obsidian 的 Linter 插件在保存时自动刷新，别手改）
- 文章详情页在 `updatedAt` 与 `pubDate` 不同日时，于发布日期后显示「Updated ...」
- 内链 `[[已发布笔记]]` 转成博客超链接（支持 `|别名`、`#小节`，锚点与 Astro 产物 id 一致）；指向未发布笔记的内链降级为纯文本并在报告中警告
- 图片 `![[图.png]]` 拷进 `public/images/<slug>/`
- 表格里的转义竖线 `[[笔记\|别名]]` 与普通竖线等价（Obsidian 在表格内自动转义，用户无法避免）
- 笔记嵌入 `![[笔记]]` / `![[笔记#小节]]` 降级为指向该文章的链接，不做内联展开
- 不支持：`%%注释%%`、`==高亮==`、图片尺寸语法 `![[图|300]]`、非图片附件（报告里记「不支持的附件」，与「无法解析嵌入引用」区分开）
- 生成物清单在 `.sync-manifest.json`，只有清单内的文件会被同步删除
- 脚本不执行 git 命令，commit 与 push 始终手动

## 知识图谱

`src/components/KnowledgeGraph.astro` 位于首页 Hero 与 About 之间，数据由 `src/lib/graph-data.mjs` 在构建时生成，渲染逻辑在 `src/lib/graph-view.js`：

- 节点：已发布文章 + 它们的标签；未发布笔记不进图
- 边：正文里指向 `/posts/<id>` 的内链 + 文章→标签
- 力模拟用 d3-force 复刻 Obsidian graph 的默认参数（链接距离 250、电荷 -120、中心引力 0.12），拖拽时钉住节点、松手释放并自然冷却
- 节点多（>90）时自动换一套密度参数：节点更小（4–12px）、链接距离 320、电荷 -320；布局阶段额外跑 `forceCollide`（按画布比例把屏幕半径换算回 graph 坐标，分三轮收敛并留 20% 间隙），保证初始视图和放大后节点都不重叠
- 标签在节点下方，屏幕空间做碰撞剔除；全景（`zoomFactor < 1.18`）下隐藏全部标签，放大后才显示；全景悬停时只显示鼠标所在节点的名字，放大后标签保持显示、不因悬停消失
- 悬停节点后平滑聚焦：进入 435ms、退出 300ms（退出比进入短约 31%），悬停节点与其边最亮，邻居节点保留 78% 亮度，其余节点和边几乎隐入背景；同时给 `body` 加 `graph-focus`，由 `KnowledgeGraph.astro` 的全局 CSS 把页面上其余区块压暗到 0.16、Graph 标题压到 0.25。页面压暗与画布高亮使用同一时长（进入 435ms / 退出 300ms）和同一条 S 曲线，两边同步到位。页面滚动、指针离开画布或点空白处都会收回聚焦
- 点击节点可钉住聚焦，再点一次或点空白处取消；双击空白处回到初始取景
- 滚轮默认滚页面，**Ctrl/⌘ + 滚轮**才缩放图谱（sigma `gestureTarget: 'shared'`）；触屏设备用双指缩放
- 打开时按文章创建时间（`created`）依次弹出节点（约 3s），期间模拟保留少量 alpha，让节点继续被斥力轻推收敛；`prefers-reduced-motion` 下直接全显
- sigma / graphology / d3-force 在 section 进入视口后才动态 import；这是全站唯一允许的客户端 JS
- 颜色从 `getComputedStyle` 读 `--color-*` token，不在 JS 里写死 hex
- 图的密度取决于标签复用与文章互链，一次性标签只会长成叶子

### 本地 demo 数据

文章数少时，图谱会显得稀疏。用 vault 生成一份 demo 快照，只在 `pnpm dev` 下生效：

```bash
pnpm graph:demo          # 生成 .demo/graph-demo.json
pnpm graph:demo --dry    # 只打印统计
```

demo 会用上 vault 里的全部笔记（不再过滤孤立笔记），并额外生成内容相似边（TF-IDF 余弦，每篇取最近 10 篇、至少 2 篇），把只有标签没有互链的笔记也连成网状。每篇笔记带 `created` 时间戳（frontmatter 的 `created`/`date`/`pubDate`，缺省用文件创建时间），供打开动画排序。

`.demo/` 在 `.gitignore` 里，demo 数据只通过 `import.meta.env.DEV` 分支读取，不进 commit、不进生产构建。删掉 `.demo/` 即自动回到真实文章数据。

## Rules
- No JS animation libraries — CSS transitions and Astro View Transitions only
- No component libraries (shadcn, etc.) — all components are hand-crafted
- Keep bundle size minimal: zero client-side JS by default. The knowledge graph is the only exception; it must stay lazily loaded
- Images must have explicit width/height or use Astro's `<Image>` component
- All colors from the design system, no hardcoded hex values outside Tailwind config
- Responsive: mobile-first; `md` (768px) for layout, `xl` (1280px) for the article outline rail




-