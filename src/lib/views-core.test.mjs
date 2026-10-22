import assert from 'node:assert/strict';
import test from 'node:test';

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

const BASE = 'https://abc.supabase.co';

/** 最小可用的 storage 替身 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => Object.fromEntries(map),
  };
}

test('isValidSlug 只接受小写字母数字短横线', () => {
  assert.equal(isValidSlug('hello-world'), true);
  assert.equal(isValidSlug('web3-notes-2'), true);
  assert.equal(isValidSlug(''), false);
  assert.equal(isValidSlug('Hello'), false);
  assert.equal(isValidSlug('a/b'), false);
  assert.equal(isValidSlug('..'), false);
  assert.equal(isValidSlug(null), false);
  assert.equal(isValidSlug(42), false);
});

test('readUrl 拼出只读查询并编码 slug', () => {
  const url = new URL(readUrl(BASE, 'hello-world'));
  assert.equal(url.pathname, '/rest/v1/post_views');
  assert.equal(url.searchParams.get('slug'), 'eq.hello-world');
  assert.equal(url.searchParams.get('select'), 'views');
});

test('bumpUrl 指向 RPC，bumpBody 用 p_slug', () => {
  assert.equal(bumpUrl(BASE), 'https://abc.supabase.co/rest/v1/rpc/increment_view');
  assert.deepEqual(JSON.parse(bumpBody('hello-world')), { p_slug: 'hello-world' });
});

test('parseCount 兼容 RPC 标量与 GET 数组两种形状', () => {
  assert.equal(parseCount(12), 12);
  assert.equal(parseCount('12'), 12);
  assert.equal(parseCount(0), 0);
  assert.equal(parseCount([{ views: 5 }]), 5);
  assert.equal(parseCount([]), null);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount(undefined), null);
  assert.equal(parseCount(-1), null);
  assert.equal(parseCount(1.5), null);
  assert.equal(parseCount('abc'), null);
  assert.equal(parseCount([{}]), null);
});

test('formatViews 加千分位，非法输入返回 null', () => {
  assert.equal(formatViews(0), '0');
  assert.equal(formatViews(999), '999');
  assert.equal(formatViews(1234), '1,234');
  assert.equal(formatViews(1234567), '1,234,567');
  assert.equal(formatViews(null), null);
  assert.equal(formatViews(-5), null);
  assert.equal(formatViews('12'), null);
});

test('同一会话只计一次：markCounted 后 hasCounted 为 true', () => {
  const storage = fakeStorage();
  assert.equal(hasCounted(storage, 'hello-world'), false);
  markCounted(storage, 'hello-world');
  assert.equal(hasCounted(storage, 'hello-world'), true);
  // 不同文章互不影响
  assert.equal(hasCounted(storage, 'other-post'), false);
  assert.deepEqual(storage.dump(), { 'viewed:hello-world': '1' });
});

test('storage 抛错时降级为「没计过」而不是崩溃', () => {
  const hostile = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
  };
  assert.equal(hasCounted(hostile, 'hello-world'), false);
  assert.doesNotThrow(() => markCounted(hostile, 'hello-world'));
  assert.equal(hasCounted(null, 'hello-world'), false);
  assert.doesNotThrow(() => markCounted(null, 'hello-world'));
});
