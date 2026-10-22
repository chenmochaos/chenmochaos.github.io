/**
 * 浏览量的浏览器侧胶水：一次 fetch 拿数字，写进 [data-view-count]。
 *
 * 本会话没计过 → 走 RPC 自增并用返回值当新数字；计过 → 走只读接口拿当前值。
 * 任何失败（网络、RLS、项目被暂停、解析不出数字）都保持隐藏，只在控制台 warn
 * 一条 —— 不显示 0 冒充有数据。
 *
 * 占位元素的宽高始终预留，数字到达只是把 visibility 打开，页头不抖动。
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.mjs';
import {
  bumpBody,
  bumpUrl,
  formatViews,
  hasCounted,
  isValidSlug,
  markCounted,
  parseCount,
  readUrl,
} from './views-core.mjs';

const TIMEOUT_MS = 5000;

function requestHeaders() {
  return { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
}

/** 返回格子里的数字，拿不到返回 null */
async function fetchCount(slug, counted) {
  const res = await fetch(counted ? readUrl(SUPABASE_URL, slug) : bumpUrl(SUPABASE_URL), {
    method: counted ? 'GET' : 'POST',
    headers: requestHeaders(),
    body: counted ? undefined : bumpBody(slug),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCount(await res.json());
}

/** 隐私模式下连 getter 都可能抛，拿不到就当没有 */
function safeSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export async function renderCounters(root = document) {
  const el = root.querySelector('[data-view-counter]');
  if (!el) return;

  const slug = el.dataset.slug;
  if (!isValidSlug(slug)) return;

  const storage = safeSessionStorage();
  const counted = hasCounted(storage, slug);
  const text = formatViews(await fetchCount(slug, counted));
  if (text === null) return;

  if (!counted) markCounted(storage, slug);

  const number = el.querySelector('[data-view-count]');
  if (!number) return;
  number.textContent = text;
  el.dataset.ready = '';
}

/*
 * 什么时候调用：不能挂在 ViewCounter 组件自己的 <script> 上 —— ClientRouter 下打包
 * 出来的 module 脚本只在首次页面加载时执行一次，从首页点进文章页时那段脚本根本
 * 不会跑。驱动放在 BaseLayout，由 astro:page-load 触发，并只在当前页真有占位元素
 * 时才 import 本模块（首页不会多下一个字节）。
 */
