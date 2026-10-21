#!/usr/bin/env node
/**
 * 用 Obsidian vault 生成一份知识图谱 demo 快照，写进 `.demo/graph-demo.json`。
 *
 * 这个文件只在 `astro dev` 下被读取（见 KnowledgeGraph.astro 的 import.meta.env.DEV 分支），
 * 并且 `.demo/` 在 .gitignore 里：vault 里绝大多数笔记是私有的，demo 数据不能进 commit，
 * 也不能进生产构建。等博客文章多了、图谱本身足够密，删掉 `.demo/` 就自动回到真实文章数据。
 *
 * 节点：
 *   note:<vault 相对路径，去 .md>   vault 里的每篇笔记
 *   tag:<小写标签>                 frontmatter 与正文里的标签
 * 边：
 *   link      [[wikilink]] 解析到的笔记（嵌入 ![[笔记]] 也算，图片附件不算）
 *   similar   正文内容相似（TF-IDF 余弦，取每篇最近邻）的笔记——vault 里手写链接很少，
 *             只靠链接图会散成一堆孤立的星；相似边把主题相近的笔记连成真正的网络
 *   tag       笔记 → 标签
 *
 * 每篇笔记带 created 时间戳（frontmatter 的 created/date/pubDate，缺省用文件创建时间），
 * 图谱打开时按它依次弹出节点。
 *
 * 用法：pnpm graph:demo [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeConfig } from './sync/config.mjs';
import { scanVault, buildIndexes } from './sync/vault.mjs';
import { parseNote } from './sync/note.mjs';
import { splitByCodeFence, splitInlineCode } from './sync/transform.mjs';

export const DEMO_OUTPUT = '.demo/graph-demo.json';
export const DEMO_STATS = '.demo/graph-demo.stats.json';

// 相似边的密度：每篇取最近的 8 篇，余弦低于 0.06 的不要。113 篇笔记约能连出 300+ 条边，
// 视觉上是网状而不是星群；再密就开始把无关主题也连起来了。
const SIMILARITY_TOP_K = 10;
const SIMILARITY_THRESHOLD = 0.05;
// 每篇至少连 2 个最近邻，哪怕分数低于阈值——否则冷门笔记会变成画布边缘孤立的小点。
const SIMILARITY_MIN_NEIGHBORS = 2;

// `[[目标|别名]]`、`[[目标#小节]]`、`[[目标^块]]`；前面带 ! 的嵌入也匹配，交给 resolve 判断
const WIKILINK_RE = /!?\[\[([^\]\n]+?)\]\]/g;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf)$/i;

// 正文内联标签。前缀限定为行首/空白/常见标点，避免把 https://x/#frag 或 markdown 标题算进来。
// 标题 `# 标题` 的 # 后面是空格，天然不匹配。
const INLINE_TAG_RE = /(^|[\s(（\[【"'，,;；:：])#([\p{L}\p{N}_/-]+)/gu;

/** 标签归一化：去前导 #、去空白、大小写不敏感去重；纯数字不算标签（与 Obsidian 一致）。 */
function addTag(list, seen, raw) {
  if (typeof raw !== 'string') return;
  const label = raw.trim().replace(/^#+/, '').trim();
  if (!label || /^\d+$/.test(label)) return;
  const key = label.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ key, label });
}

function frontmatterTags(data) {
  const list = [];
  const seen = new Set();
  // Obsidian 的属性面板允许 `tags` 列表，也允许 `tag` 单数 / 逗号分隔的字符串
  for (const field of ['tags', 'tag']) {
    const value = data?.[field];
    if (Array.isArray(value)) {
      for (const item of value) addTag(list, seen, item);
    } else if (typeof value === 'string') {
      for (const item of value.split(/[,\s]+/)) addTag(list, seen, item);
    }
  }
  return list;
}

function inlineTags(body) {
  const list = [];
  const seen = new Set();
  for (const block of splitByCodeFence(body)) {
    if (block.isCode) continue;
    for (const piece of splitInlineCode(block.text)) {
      if (piece.isCode) continue;
      for (const match of piece.text.matchAll(INLINE_TAG_RE)) {
        addTag(list, seen, match[2]);
      }
    }
  }
  return list;
}

/** `[[目标|别名]]` → 目标（去掉 #小节 / ^块引用），非笔记附件返回 null。 */
export function parseWikilinkTarget(inner) {
  const pipe = inner.indexOf('|');
  let target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const hash = target.indexOf('#');
  if (hash !== -1) target = target.slice(0, hash).trim();
  const caret = target.indexOf('^');
  if (caret !== -1) target = target.slice(0, caret).trim();
  if (!target) return null; // [[#小节]] 是本页锚点，不产生边
  if (IMAGE_RE.test(target)) return null;
  return target.replace(/\.md$/i, '');
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

/** 把 frontmatter 日期或文件时间转成 epoch ms；解析不了返回 0（排在最前面）。 */
function toEpoch(value) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

const HAN_RE = /[\p{Script=Han}]/u;
const TOKEN_RE = /[\p{Script=Han}]|[\p{L}\p{N}]+/gu;

/**
 * 内容相似度用的词袋：中文按相邻两字成 bigram，英文/数字按词。代码、链接语法先剥掉——
 * 否则每篇笔记的 `[[...]]` 片段会互相「相似」。
 */
function similarityTokens(text) {
  const clean = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[\[([^\]|#^]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, ' $1 ')
    .replace(/[#>*_\-\[\]()~=|]/g, ' ');
  const pieces = clean.match(TOKEN_RE) ?? [];
  const tokens = [];
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    if (HAN_RE.test(piece)) {
      const next = pieces[index + 1];
      if (next && HAN_RE.test(next)) tokens.push(piece + next);
    } else {
      tokens.push(piece.toLowerCase());
    }
  }
  return tokens;
}

/**
 * 每篇笔记的相似邻居（无向、去重后的 note key 对）。O(n²) 对 100+ 篇笔记完全够用，
 * 不值得为了它引入向量库。
 */
export function similarityPairs(notes, topK = SIMILARITY_TOP_K, threshold = SIMILARITY_THRESHOLD) {
  const docs = notes.map((note) => {
    const counts = new Map();
    for (const token of similarityTokens(`${note.title} ${note.body}`)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return { key: note.key, counts };
  });

  const documentFrequency = new Map();
  for (const doc of docs) {
    for (const token of doc.counts.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const total = docs.length;
  const vectors = new Map();
  for (const doc of docs) {
    const vector = new Map();
    let norm = 0;
    for (const [token, count] of doc.counts) {
      const weight = (1 + Math.log(count)) * Math.log((total + 1) / ((documentFrequency.get(token) ?? 0) + 1));
      if (weight <= 0) continue;
      vector.set(token, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [token, weight] of vector) vector.set(token, weight / norm);
    vectors.set(doc.key, vector);
  }

  const cosine = (a, b) => {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let score = 0;
    for (const [token, weight] of small) {
      const other = large.get(token);
      if (other) score += weight * other;
    }
    return score;
  };

  const pairs = [];
  for (const note of notes) {
    const ranked = notes
      .filter((other) => other.key !== note.key)
      .map((other) => ({ key: other.key, score: cosine(vectors.get(note.key), vectors.get(other.key)) }))
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key, 'en'))
      .slice(0, topK);
    ranked.forEach(({ key, score }, index) => {
      if (index >= SIMILARITY_MIN_NEIGHBORS && score < threshold) return;
      pairs.push(note.key < key ? [note.key, key] : [key, note.key]);
    });
  }
  return pairs;
}

/**
 * 解析 wikilink 目标。优先按 vault 相对路径匹配，其次按文件名。
 * 同名笔记取路径最短、再按字典序的那篇——确定性的选择好过随机，歧义数量会写进报告。
 */
function makeResolver(notes) {
  const byPath = new Map();
  const byName = new Map();
  for (const note of notes) {
    byPath.set(note.relNoExt.toLowerCase(), note);
    const key = note.basename.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(note);
  }

  return (target) => {
    const normalized = target.replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/')) {
      const hit = byPath.get(normalized);
      if (hit) return { note: hit, ambiguous: false };
    }
    const candidates = byName.get(normalized) ?? [];
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return { note: candidates[0], ambiguous: false };
    const sorted = [...candidates].sort(
      (a, b) => a.relNoExt.split('/').length - b.relNoExt.split('/').length || a.relNoExt.localeCompare(b.relNoExt, 'en'),
    );
    return { note: sorted[0], ambiguous: true };
  };
}

function readPublishMap(repoRoot) {
  const map = new Map();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, '.sync-manifest.json'), 'utf8'));
    for (const [slug, entry] of Object.entries(manifest.entries ?? {})) {
      map.set(toPosix(entry.source), slug);
    }
  } catch {
    // 没有 manifest（或读坏了）只是少了「已发布笔记可点击跳转」，不影响 demo
  }
  return map;
}

/**
 * @param {ReturnType<typeof makeConfig>} config
 * @returns {{graph: object, report: {notes: number, tags: number, links: number, similar: number, unresolved: number, ambiguous: number}}}
 */
export function buildDemoGraph(config) {
  const warnings = [];
  const scanned = scanVault(config, warnings);
  const { notes: noteFiles } = buildIndexes(scanned, warnings);
  const published = readPublishMap(config.repoRoot);

  const notes = noteFiles
    .map((file) => {
      const raw = fs.readFileSync(file.absPath, 'utf8');
      const { data, body } = parseNote(raw);
      const relNoExt = file.relPath.replace(/\.md$/i, '');
      const basename = path.posix.basename(relNoExt);
      const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : basename;
      // 创建时间：优先 frontmatter 里明确写的日期，其次文件创建时间。Linux 上 birthtime
      // 在 ext4 可用；实在拿不到就退回 mtime（至少顺序稳定）。
      const stat = fs.statSync(file.absPath);
      const created =
        toEpoch(data?.created) ||
        toEpoch(data?.date) ||
        toEpoch(data?.pubDate) ||
        Math.round(stat.birthtimeMs) ||
        Math.round(stat.mtimeMs) ||
        0;
      return {
        key: `note:${relNoExt}`,
        relNoExt,
        relPath: file.relPath,
        basename,
        title,
        body,
        tags: [...frontmatterTags(data), ...inlineTags(body)],
        url: published.has(file.relPath) ? `/posts/${published.get(file.relPath)}` : null,
        created,
      };
    })
    .sort((a, b) => a.relNoExt.localeCompare(b.relNoExt, 'en'));

  const resolve = makeResolver(notes);
  const tags = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const linkedPairs = new Set();
  let unresolved = 0;
  let ambiguous = 0;
  let linkCount = 0;
  let similarCount = 0;

  const addEdge = (source, target, type) => {
    const [a, b] = [source, target].sort();
    const key = `${type}:${a}--${b}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ key, source: a, target: b, type });
    if (type === 'link') {
      linkCount += 1;
      linkedPairs.add(`${a}--${b}`);
    }
    if (type === 'similar') similarCount += 1;
  };

  for (const note of notes) {
    for (const tag of note.tags) {
      const tagKey = `tag:${tag.key}`;
      if (!tags.has(tag.key)) {
        tags.set(tag.key, { key: tagKey, type: 'tag', label: `#${tag.label}`, created: note.created });
      } else {
        const tagNode = tags.get(tag.key);
        // 标签跟着最早使用它的笔记出现。
        if (note.created && (!tagNode.created || note.created < tagNode.created)) tagNode.created = note.created;
      }
      addEdge(note.key, tagKey, 'tag');
    }

    const seenTargets = new Set();
    for (const block of splitByCodeFence(note.body)) {
      if (block.isCode) continue;
      for (const piece of splitInlineCode(block.text)) {
        if (piece.isCode) continue;
        for (const match of piece.text.matchAll(WIKILINK_RE)) {
          const target = parseWikilinkTarget(match[1]);
          if (!target) continue;
          const resolved = resolve(target);
          if (!resolved) {
            unresolved += 1;
            continue;
          }
          if (resolved.ambiguous) ambiguous += 1;
          const other = resolved.note;
          if (other.key === note.key || seenTargets.has(other.key)) continue;
          seenTargets.add(other.key);
          addEdge(note.key, other.key, 'link');
        }
      }
    }
  }

  // 内容相似边。已经用 wikilink 连起来的笔记不再重复连；相似边的权重只用于视觉
  // （更细、更淡），不参与统计的 links。
  for (const [a, b] of similarityPairs(notes)) {
    if (linkedPairs.has(`${a}--${b}`)) continue;
    addEdge(a, b, 'similar');
  }

  const nodes = notes.map((note) => ({
    key: note.key,
    type: 'note',
    label: note.title,
    url: note.url,
    degree: 0,
    created: note.created,
  }));
  for (const tag of tags.values()) nodes.push({ ...tag, url: null, degree: 0, created: tag.created ?? 0 });

  const byKey = new Map(nodes.map((node) => [node.key, node]));
  for (const edge of edges) {
    const source = byKey.get(edge.source);
    const target = byKey.get(edge.target);
    if (source) source.degree += 1;
    if (target) target.degree += 1;
  }

  nodes.sort((a, b) => a.key.localeCompare(b.key, 'en'));
  edges.sort((a, b) => a.key.localeCompare(b.key, 'en'));

  const graph = {
    demo: true,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    stats: { posts: notes.length, tags: tags.size, links: linkCount + similarCount },
  };
  const report = {
    notes: notes.length,
    tags: tags.size,
    links: linkCount,
    similar: similarCount,
    unresolved,
    ambiguous,
  };
  return { graph, report, warnings };
}

export function main(config, { dryRun = false, out = process.stdout, err = process.stderr } = {}) {
  try {
    const { graph, report, warnings } = buildDemoGraph(config);
    const body = `${JSON.stringify(graph, null, 2)}\n`;
    if (!dryRun) {
      const target = path.join(config.repoRoot, DEMO_OUTPUT);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      fs.writeFileSync(path.join(config.repoRoot, DEMO_STATS), `${JSON.stringify(report, null, 2)}\n`);
    }
    out.write(`${dryRun ? '预览' : '写入'} ${DEMO_OUTPUT}\n`);
    out.write(`  ${report.notes} notes · ${report.tags} tags · ${report.links} links · ${report.similar} related\n`);
    out.write(`  ${report.unresolved} unresolved links · ${report.ambiguous} ambiguous links\n`);
    for (const warning of warnings) out.write(`  ⚠ ${warning}\n`);
    out.write('\n这份数据只在 pnpm dev 下生效，.demo/ 已被 gitignore；删掉 .demo/ 即回到真实文章数据。\n');
    return 0;
  } catch (error) {
    err.write(`❌ 生成 demo 图谱失败：${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !['--dry', '--dry-run'].includes(arg));
  if (unknown.length > 0) {
    process.stderr.write(`❌ 未知参数 ${unknown.join(' ')}。用法：pnpm graph:demo [--dry]\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = main(makeConfig(), {
      dryRun: args.includes('--dry') || args.includes('--dry-run'),
    });
  }
}
