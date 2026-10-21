import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  extractHrefs,
  normalizePostHref,
  normalizeTags,
  stripCode,
} from './graph-data.mjs';

const post = (id, options = {}) => ({
  id,
  data: {
    title: options.title ?? id,
    tags: options.tags ?? [],
    draft: options.draft ?? false,
    pubDate: options.pubDate ?? null,
  },
  body: options.body ?? '',
});

test('buildGraph: 空输入返回空图', () => {
  assert.deepEqual(buildGraph([]), {
    nodes: [],
    edges: [],
    stats: { posts: 0, tags: 0, links: 0 },
  });
  assert.deepEqual(buildGraph(undefined).nodes, []);
});

test('buildGraph: 标签生成节点与边，大小写不敏感去重', () => {
  const graph = buildGraph([
    post('a', { tags: ['redis', 'Redis', ' backend ', '#redis'] }),
  ]);

  assert.equal(graph.nodes.length, 3);
  assert.deepEqual(
    graph.nodes.filter((node) => node.type === 'tag').map((node) => node.label).sort(),
    ['#backend', '#redis']
  );
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every((edge) => edge.type === 'tag'));

  const postNode = graph.nodes.find((node) => node.type === 'post');
  assert.equal(postNode.degree, 2);
  assert.equal(postNode.url, '/posts/a');
});

test('buildGraph: 文章内链生成 link 边并去重', () => {
  const graph = buildGraph([
    post('a', {
      body: [
        'See [B](/posts/b).',
        'Again [B](/posts/b#section).',
        '[B with title](/posts/b "title").',
        '<a href="/posts/b">html</a>',
      ].join('\n'),
    }),
    post('b'),
  ]);

  assert.equal(graph.stats.links, 1);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].type, 'link');
  assert.equal(graph.nodes.find((node) => node.key === 'post:a').degree, 1);
  assert.equal(graph.nodes.find((node) => node.key === 'post:b').degree, 1);
});

test('buildGraph: 双向链接只保留一条边', () => {
  const graph = buildGraph([
    post('a', { body: '[B](/posts/b)' }),
    post('b', { body: '[A](/posts/a)' }),
  ]);

  assert.equal(graph.stats.links, 1);
  assert.equal(graph.edges.length, 1);
});

test('buildGraph: 自链、悬空链接、草稿文章都被忽略', () => {
  const graph = buildGraph([
    post('a', { body: '[self](/posts/a) [ghost](/posts/ghost)' }),
    post('draft', { draft: true, tags: ['ai'], body: '[A](/posts/a)' }),
  ]);

  assert.equal(graph.stats.posts, 1);
  assert.equal(graph.stats.tags, 0);
  assert.equal(graph.stats.links, 0);
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(graph.nodes.map((node) => node.key), ['post:a']);
});

test('buildGraph: 同源绝对链接能解析，外部站的 /posts 不解析', () => {
  const siteOrigin = 'https://chenmochaos.github.io';
  const same = buildGraph(
    [post('a', { body: '[B](https://chenmochaos.github.io/posts/b)' }), post('b')],
    { siteOrigin }
  );
  assert.equal(same.stats.links, 1);

  const external = buildGraph(
    [post('a', { body: '[B](https://other.example/posts/b)' }), post('b')],
    { siteOrigin }
  );
  assert.equal(external.stats.links, 0);
});

test('buildGraph: 代码围栏与行内代码里的链接不算内链', () => {
  const graph = buildGraph([
    post('a', {
      body: [
        '```md',
        '[B](/posts/b)',
        '```',
        '',
        'Inline `[B](/posts/b)`.',
        '',
        'Real [B](/posts/b).',
      ].join('\n'),
    }),
    post('b'),
  ]);

  assert.equal(graph.stats.links, 1);
});

test('buildGraph: 输出顺序稳定', () => {
  const posts = [
    post('b', { tags: ['z'], body: '[A](/posts/a)' }),
    post('a', { tags: ['a'], body: '[B](/posts/b)' }),
  ];
  assert.deepEqual(buildGraph(posts), buildGraph([...posts].reverse()));
});

test('buildGraph: 节点带 created，标签取最早文章时间', () => {
  const graph = buildGraph([
    post('a', { tags: ['x'], pubDate: '2024-02-01' }),
    post('b', { tags: ['x'], pubDate: new Date('2024-01-01T00:00:00Z') }),
    post('c'),
  ]);

  assert.equal(graph.nodes.find((node) => node.key === 'post:a').created, Date.parse('2024-02-01'));
  assert.equal(graph.nodes.find((node) => node.key === 'post:b').created, Date.parse('2024-01-01T00:00:00Z'));
  assert.equal(graph.nodes.find((node) => node.key === 'post:c').created, 0);
  assert.equal(graph.nodes.find((node) => node.key === 'tag:x').created, Date.parse('2024-01-01T00:00:00Z'));
});

test('normalizePostHref: 只接受 /posts/<id> 形态', () => {
  assert.equal(normalizePostHref('/posts/foo'), 'foo');
  assert.equal(normalizePostHref('/posts/foo/'), 'foo');
  assert.equal(normalizePostHref('/posts/foo#section'), 'foo');
  assert.equal(normalizePostHref('/posts/foo?x=1'), 'foo');
  assert.equal(normalizePostHref('/posts/foo/bar'), null);
  assert.equal(normalizePostHref('/blog/foo'), null);
  assert.equal(normalizePostHref('https://example.com/posts/foo'), null);
  assert.equal(
    normalizePostHref('https://example.com/posts/foo', 'https://example.com'),
    'foo'
  );
});

test('normalizeTags: 去空白、去前导 #、保持首次写法', () => {
  assert.deepEqual(normalizeTags([' Redis ', '#redis', '', null, 'AI']), [
    { key: 'redis', label: 'Redis' },
    { key: 'ai', label: 'AI' },
  ]);
  assert.deepEqual(normalizeTags(undefined), []);
});

test('stripCode: 去掉围栏代码与行内代码', () => {
  const body = 'before\n```js\nconst x = 1;\n```\nafter `code`';
  const stripped = stripCode(body);
  assert.ok(!stripped.includes('const x'));
  assert.ok(!stripped.includes('code'));
  assert.ok(stripped.includes('before'));
  assert.ok(stripped.includes('after'));
});

test('extractHrefs: 同时抓 Markdown 与 HTML 链接', () => {
  const hrefs = extractHrefs('[A](/posts/a) <a href="/posts/b">B</a>');
  assert.deepEqual(hrefs, ['/posts/a', '/posts/b']);
});
