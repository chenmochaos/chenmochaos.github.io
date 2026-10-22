# 文章浏览量统计 — 设计

日期：2026-10-22
状态：已确认（Supabase 自建，配置直接写进源码）

## 目标

在文章详情页显示这篇文章的累计浏览量（PV）。GitHub Pages 是纯静态托管，没有可写后端，计数存在 Supabase（Postgres）。

## 非目标

首页列表的数字、全站总浏览量、UV（纯前端拿不到 IP）、构建时预渲染计数、Realtime 实时同步、可信任的防刷。

## 展示位置

文章详情页 header 的 meta 行，顺序：日期 → （Updated）→ 浏览量 → 标签。浏览量是文章的元信息，和日期同级；放页脚要读到文末才看得到，没有信息价值。

meta 行加 `flex-wrap`：现在是不换行的 `flex items-center gap-4`，手机上加一段内容会溢出。

## 计数口径

每个浏览器会话、每篇文章计一次。用 `sessionStorage` 的 `viewed:<slug>` 去重：刷新不涨，新标签页算一次。隐私模式下 `sessionStorage` 读写可能抛错，降级为每次访问都计数（宁可多算，不要报错）。

## 数据层

```sql
-- 每篇文章一行；slug 就是 content collection 的 post.id，与 URL 一致
create table if not exists public.post_views (
  slug       text primary key,
  views      bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.post_views enable row level security;

-- 建项目时关掉了「自动暴露新表」，所以权限显式给：anon 只能 SELECT 这张表。
-- 直接写表在 RLS 层就没有策略，这里再从权限层收一道。
grant usage on schema public to anon;
grant select on public.post_views to anon;
revoke insert, update, delete on public.post_views from anon, authenticated;

-- 数字本来公开，匿名可读
drop policy if exists "public read" on public.post_views;
create policy "public read" on public.post_views
  for select to anon using (true);

-- 没有任何 insert/update/delete policy：anon 改不了表，只能走下面这个函数
create or replace function public.increment_view(p_slug text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v bigint;
begin
  if p_slug is null or p_slug = '' then
    return null;
  end if;

  insert into public.post_views (slug, views)
  values (p_slug, 1)
  on conflict (slug) do update
    set views = post_views.views + 1,
        updated_at = now()
  returning views into v;

  return v;
end;
$$;

revoke all on function public.increment_view(text) from public;
grant execute on function public.increment_view(text) to anon;

-- 让 PostgREST 立刻看到新表，不用等缓存过期
notify pgrst, 'reload schema';
```

写入只有一个口子：`security definer` 函数 + 无表级写策略。anon key 泄漏的影响面被限制在「能调这一个函数」。

## 前端

沿用知识图谱的拆分方式，纯逻辑与浏览器胶水分开：

| 文件 | 职责 |
| --- | --- |
| `src/lib/views-core.mjs` | 纯函数：slug 校验、拼请求地址、解析返回、格式化数字、会话去重判定。不碰 DOM 和 storage，storage 由调用方注入 |
| `src/lib/views-view.js` | 浏览器侧：一次 fetch，写进 DOM，失败静默 |
| `src/lib/supabase-config.mjs` | `SUPABASE_URL` / `SUPABASE_ANON_KEY` 常量 |
| `src/components/ViewCounter.astro` | 占位骨架 + 唯一一段客户端脚本 |

请求：

- 本会话没计过 → `POST /rest/v1/rpc/increment_view`，body `{ p_slug }`，用返回值当新数字
- 本会话计过 → `GET /rest/v1/post_views?slug=eq.<slug>&select=views`，只读当前值

`AbortSignal.timeout(5000)` 兜底，不发请求挂着不回来。

## 失败策略

请求失败、返回 `[]`、解析不出非负整数、RLS 配错、项目被暂停 —— 一律保持数字隐藏，控制台 `console.warn` 一条。**不显示 `0` 冒充有数据，不做假状态。**

页面本身不因为计数失败出现任何变化：占位元素的 `visibility` 从 hidden 切到 visible，宽高始终预留，数据到达前后页头不换行、不抖动。

## 配置

anon key 是 Supabase 设计上公开的（它会出现在每个访客的 JS 里，安全性来自 RLS 而非保密），所以直接写进 `src/lib/supabase-config.mjs` 并提交。本地开发和 CI 都不需要额外配置，不碰 `.env` 和 GitHub Actions。

轮换 key 时需要改这个文件。

## 风险与代价

1. **可被刷**：任何拿到 anon key 的人 curl 就能无限 +1。纯前端无法防，要防必须上 Edge Function + IP 限流。浏览量是虚荣指标，接受。
2. **免费项目暂停**：Supabase 免费项目 7 天低活跃会被暂停，暂停期间计数请求失败 → 数字隐藏。恢复窗口 1 年。
3. **首屏数字不是 SSR 的**：数字在网络请求回来后才出现。静态站不可避免；预留宽度已消除抖动。
4. **多一次客户端请求**：全站唯一新增的客户端 JS，约 1KB，只在文章详情页加载。

## 验证

- `node --test` 覆盖 `views-core.mjs`：slug 校验、URL 编码、两种返回形状的解析、格式化、storage 读写与抛错
- `pnpm dev` 手工：进文章数字 +1 → 刷新不变 → 新标签页 +1 → 断网不报错且不抖动
- `pnpm build` 通过，产物只含一段小脚本
