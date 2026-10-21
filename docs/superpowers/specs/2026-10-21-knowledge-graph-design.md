# 知识图谱可视化设计

日期：2026-10-21
状态：已实现（2026-10-22）

## 目标

在首页 Hero 与 About 之间加入一张 Obsidian 风格的知识图谱：文章是节点，标签是枢纽节点，文章之间的 `[[内链]]` 是边。支持 hover 高亮邻居、节点拖拽、画布平移、滚轮缩放、点击跳转。

## 非目标

- 不做标签详情页、搜索、过滤面板、图谱设置面板。
- 不把未发布笔记放进图里。
- 不引入 React 或 UI 图库；力模拟只用 d3-force。
- 不做服务端渲染或实时数据接口，图谱数据在构建时生成。

## 位置

`src/pages/index.astro` 中插在 `<Hero />` 与 `<About />` 之间。section 复用现有节奏：

```
py-20 border-t border-border reveal
```

标题 `Graph` 与右侧统计行（`41 notes · 18 links · 37 tags`）同一行，不设副标题；section 顶部 `pt-10` 贴近分隔线。宽度跟随 `max-w-content`（800px），画布高度 `clamp(400px, 60vh, 620px)`。

## 数据模型

### 节点

```json
{ "key": "post:redis-cache-strategies", "type": "post", "label": "Redis 缓存处理策略", "url": "/posts/redis-cache-strategies", "degree": 3 }
{ "key": "tag:redis", "type": "tag", "label": "#redis", "degree": 1 }
```

- 文章节点：来自 `getCollection('posts')`，过滤 `draft`。`url` 固定为 `/posts/<post.id>`（与 `[...slug].astro` 的 `getStaticPaths` 一致）。
- 标签节点：每个标签一个，只来自已发布文章。标签去首尾空白、去重、大小写不敏感归一化，显示保留首次出现的写法并加 `#` 前缀。

### 边

- 文章 → 文章：从正文抓指向 `/posts/<id>` 的链接。支持 Markdown 链接与 HTML `href`，支持锚点、尾斜杠、可选 title。忽略自链、指向不存在或草稿文章的链接。
- 文章 → 标签：frontmatter 的 `tags`。
- 无向边，按节点对去重；同一对节点只保留一条。`degree` 为去重后的邻接边数。

### 生成方式

纯函数 `buildGraph(posts)` 放 `src/lib/graph-data.mjs`，输入是 Astro content collection 的条目，输出 `{ nodes, edges, stats }`。组件 frontmatter 调用后把结果 `JSON.stringify` 内嵌到 `<script type="application/json">`，不做运行时请求。

## 渲染

- 客户端脚本在 section 进入视口时才动态 import `sigma`、`graphology`、`d3-force`。
- d3-force 在创建 sigma 之前离线跑 240 tick 得到稳定布局；空闲时模拟静止，只有拖拽（alphaTarget 0.3）会唤醒它，松手后自然冷却。
- 初始位置按黄金角螺旋均匀分布，避免随机布局导致每次刷新形态不同。
- 节点尺寸按 Obsidian 的 `max(8, min(3*sqrt(degree+1), 30))` 映射到区块内的屏幕像素半径，并随缩放按 `sqrt(1/zoom)` 变化。
- 标签在屏幕空间做贪心碰撞剔除（优先级：活动节点 → 邻居 → 笔记 → 标签 → 度数），标签之间、标签与节点之间留出空隙；悬停/聚焦时显示完整标题。
- `ResizeObserver` 监听容器尺寸，调用 `sigma.resize()`。
- WebGL2 不可用时显示降级提示，不加载图库。

## 交互

- hover 节点：高亮该节点及一跳邻居，其余节点和边压暗到接近背景。
- 点击文章节点：跳转到该文章。
- 点击标签节点：聚焦该标签的邻居文章，再点同一节点或点空白清除。
- 拖拽节点：更新节点坐标，禁用相机平移；松手后短暂重启布局。
- 拖拽空白：平移画布。滚轮：缩放。双击空白：复位相机。
- 移动端：单指平移、双指缩放、点按文章跳转。

## 视觉

全部取现有设计 token，不新增颜色：

| 元素 | token |
| --- | --- |
| 页面背景 | `--color-bg` |
| 文章节点 | `--color-accent` |
| 标签节点 | `--color-text-muted`，半径更小 |
| 边 | `--color-border`，半透明 |
| hover 节点/边 | `--color-text` / `--color-text-dim` |
| 标签文字 | 笔记 `--color-text-muted`，标签 `--color-text-dim`，`Inter` |
| 非邻居淡出 | opacity 0.2 |

颜色通过 `getComputedStyle(container)` 读取 CSS 变量，不在 JS 里写死 hex。

## 生命周期

站点使用 Astro `ClientRouter`（View Transitions）。脚本监听 `astro:page-load` 初始化，`astro:before-swap` 销毁（`sigma.kill()`、`simulation.stop()`、移除 camera 监听、断开 observer），并用容器上的标记防止重复初始化。

## 可访问性与 SEO

canvas 内容对爬虫和读屏不可见。section 内放：

- `role="img"` + `aria-label` 描述图规模；
- 一份 `sr-only` 的文章链接列表；
- 一句 `N posts · M links · K tags` 的可见统计。

Writing 区块本身是完整文章列表，爬虫不会丢正文入口。

## 文件清单

- 新增 `src/lib/graph-data.mjs`：纯数据构建。
- 新增 `src/lib/graph-data.test.mjs`：`node --test` 覆盖链接解析、去重、草稿过滤、悬空链接、标签归一化。
- 新增 `src/lib/graph-view.js`：sigma + d3-force 渲染、交互、标签碰撞剔除。
- 新增 `scripts/build-demo-graph.mjs`：从本地 vault 生成 demo 快照（`pnpm graph:demo`，产物在 gitignore 的 `.demo/`）。
- 新增 `src/components/KnowledgeGraph.astro`：数据、标记、样式、客户端脚本。
- 修改 `src/pages/index.astro`：插入组件。
- 修改 `package.json`：新增 `sigma`、`graphology`、`d3-force`。
- 修改 `CLAUDE.md`：目录结构、依赖、客户端 JS 例外说明。

## 验证

1. `pnpm test` 全绿。
2. `pnpm build` 成功，产物中包含内嵌的图谱 JSON。
3. 检查 `dist/_astro/` 中新增 chunk 的 gzip 体积。
4. `pnpm dev` 手动检查：滚动到图谱、hover、拖拽、缩放、点击文章跳转、点击标签聚焦、移动端视口、View Transitions 往返后不重复初始化。
5. 浏览器控制台无报错。

## 风险

- `sigma` 与 `graphology` 版本兼容性：安装后锁版本，构建验证。
- demo 快照来自私有 vault，必须只走 `import.meta.env.DEV` 分支且 `.demo/` 保持 gitignore；生产构建已验证不含私有标题。
- View Transitions 下重复初始化或内存泄漏：用生命周期钩子 + 标记位处理。
- 当前数据稀疏（5 篇文章、13 个一次性标签、0 条文章互链），图会呈现为 5 个互不相连的小星。这是内容问题，不是实现问题；标签复用和文章互链增加后自然改善。

## 2026-10-22 增补

上线后的手感与数据密度调整：

- **缩放手势**：`gestureTarget: 'shared'`。普通滚轮滚动页面，Ctrl/⌘ + 滚轮才缩放图谱；触屏单指滚动页面、双指缩放。Sigma 自带的 shared 手势提示条文字置空，不弹出。
- **打开动画**：数据层为每个节点写入 `created`（文章取 `pubDate`，标签取最早关联文章的时间），视图层按 `created` 排序后给每个节点分配错峰延迟，节点从小尺寸、透明弹到完整状态，标签在节点完全出现后才参与碰撞剔除。总时长约 1.4s；`prefers-reduced-motion: reduce` 下直接全显。
- **初始取景**：`autoRescale: 'once'` + `stagePadding` 保证首帧包含全部节点。已在 752×400、752×600、342×506 三种画布下验证 0 个节点越界。
- **密集图参数**：节点数 > 90 时自动切换为更小节点（4–12px）、链接距离 320、电荷 -240，避免密集图挤成一个白团。
- **demo 数据**：vault 全部笔记入图，并新增 `similar` 边（TF-IDF 余弦，每篇最近 10 篇、至少 2 篇），把只有标签没有互链的笔记连成网状；`--orphans` 参数随过滤逻辑一起移除。
- **悬停聚焦**：悬停节点时用平滑过渡（smoothstep）把图分成三层——悬停节点与它的边最亮（边为 accent 色、接近全不透明），邻居节点约 78% 亮度，其余节点与边淡到接近背景。进入 435ms（原 420ms 与 450ms 的平均值），退出缩短到 300ms（比进入短约 31%），离场更利落。同时给 `body` 加 `graph-focus`，页面其余区块通过 CSS `opacity` 过渡压暗到 0.16、Graph 标题压到 0.25，形成「熄灯只留这一簇」的效果。页面压暗与画布高亮使用同一时长和同一条 S 曲线（CSS 用 `cubic-bezier(0.3333, 0, 0.6667, 1)` 等价 smoothstep），并通过「进入用 `.graph-focus` 规则的 435ms、退出回到基础规则的 300ms」实现非对称时长；`.reveal` 自带的 0.5s transition 被一并覆盖。指针离开画布、页面滚动、点击空白处都会收回聚焦；点击节点可钉住聚焦，双击空白处恢复初始取景。已在桌面与触屏（点按）验证，View Transitions 跳转后不残留 `graph-focus`。
- **打开动画放慢**：单节点淡入时长 620ms、整体错峰 3000ms（150 节点约 3.6s 完成）。动画期间模拟保留 `alpha 0.12` 继续运行，节点会被斥力轻轻推开、慢慢收敛，形成 Obsidian 式力场感；位移经验证不超出已冻结的取景范围。
- **节点防重叠**：布局阶段新增 `forceCollide`。由于 d3 坐标是 graph 空间而节点尺寸是屏幕像素，按「节点铺满画布」的比例把像素半径换算回 graph 单位，并用三轮「估算比例 → 设半径 → 迭代」收敛，额外留 20% 间隙。150 节点在初始视图与各放大级别下重叠对数均为 0。
- **标签缩放阈值**：`zoomFactor < 1.18`（初始全景）时隐藏全部标签，避免 150 个名字糊在一起；放大越过阈值后重新参与屏幕空间碰撞剔除。全景悬停时只破例显示鼠标所在节点的名字（邻居也不显示）；放大后的标签不随聚焦淡出而消失，避免悬停一下标题突然空掉。
