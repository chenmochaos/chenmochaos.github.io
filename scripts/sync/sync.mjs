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

/**
 * 与 vault.mjs 里那条目录级警告的文案耦合：删除闸要靠它判断「这次扫描是否完整」。
 * 刻意不把这个前缀做成跨模块导出——它是 6 个字符，为它给扫描模块增加公共 API 不划算；
 * 代价是这句文案被写了两处，只改一处会被 Task 6 的删除闸测试立刻抓到，不会静默失效。
 * 同理，本文件的 toPosix 与 vault.mjs 里的同名函数各留一份（1 行恒等变换，第三个调用方出现时再抽）。
 */
const UNREADABLE_DIR_PREFIX = '无法读取目录 ';

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
  // 一个数组贯穿扫描与索引：警告只要产生就进同一个 sink，最后由报告统一汇总。
  // 各传各的 `[]` 等于把扫描层的警告就地丢掉——那是本模块最不该做的事。
  const { notes: noteFiles, attachments } = buildIndexes(scanVault(config, warnings), warnings);

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
  //
  // 「扫描结果里没有」只有在扫描确定完整时才等于「源笔记已删除」。两种情况它不是：
  //   a) 一篇 .md 都没扫到而清单非空 —— vaultDir 指向了一个能读、但不是 vault 的目录；
  //   b) 有目录读不到（权限、竞态）—— 那个目录里的笔记看起来也「消失」了，其实只是没被读到。
  // 判据必须是「一篇 .md 都没扫到」，不能写成「没有可发布的笔记」：后者是用户自己把 publish 关掉的
  // 正常状态（见测试「取消 publish 后删除生成文件与图片目录」），按它一刀切就没法取消发布了。
  //
  // 两道闸都靠**不生成删除动作**实现，而不是 push 一条 error：runSync 调用 applySync 之前并不检查
  // plan.errors，错误只影响退出码，靠 error 挡的话文件已经删完了（spec §7.6/§7.7）。
  const currentSlugs = new Set(finalNotes.map((note) => note.slug));
  const staleSlugs = Object.keys(manifest.entries).filter((slug) => !currentSlugs.has(slug));
  const unreadableDirs = warnings.filter((warning) => warning.startsWith(UNREADABLE_DIR_PREFIX));

  if (staleSlugs.length > 0 && noteFiles.length === 0) {
    errors.push(
      `扫描到 0 篇笔记，但清单里有 ${staleSlugs.length} 篇生成记录，已取消全部删除：` +
        `疑似 vaultDir 指向了错误的目录（当前 vaultDir=${config.vaultDir}）。` +
        `若确实要清空全部生成物，请先删除 ${config.manifestPath} 再同步。`,
    );
  } else if (staleSlugs.length > 0 && unreadableDirs.length > 0) {
    errors.push(
      `有 ${unreadableDirs.length} 个目录读不到（${unreadableDirs.join('；')}），已取消 ${staleSlugs.length} 篇的删除：` +
        `读不到的目录里的笔记会被误判成「源已删除」。修好权限后重跑即可。`,
    );
  } else {
    for (const slug of staleSlugs) {
      const entry = manifest.entries[slug];
      const outputPath = path.join(config.contentDirAbs, `${slug}.md`);
      const derived = toPosix(path.relative(config.repoRoot, outputPath));
      const recorded = typeof entry.output === 'string' ? entry.output : '(清单里没有记录)';

      // spec §7.1 的第二个合取项。删除路径本来是从 slug 反推的，只有在清单没被改坏时才等于
      // entry.output；不相等说明清单与磁盘的对应关系已经被破坏（手工编辑、合并解冲突出错），
      // 这时宁可漏删一轮，也不要删掉一个我们其实并不认识的同名文件。
      if (derived !== recorded) {
        errors.push(
          `清单里「${slug}」记录的路径是 ${recorded}，与由 slug 推导出的 ${derived} 不一致，已跳过删除：` +
            `清单可能被手工改过。确认后请手工删除该文件，并从 ${config.manifestPath} 里移除这一条。`,
        );
        continue;
      }

      // spec §7.4 的同胞条款。§7.4 承认「生成文件被手工改过」是真实会发生的事——用户可能直接
      // 在博客侧编辑「已发布」的版本。覆盖有下一轮 vault 兜底，删除没有：把用户的改动静默销毁
      // 不可逆。文件不存在不算「被改过」（生成物早被删了），照常生成动作把清单条目清掉。
      if (fs.existsSync(outputPath) && hashText(fs.readFileSync(outputPath, 'utf8')) !== entry.outputHash) {
        warnings.push(
          `生成文件 ${slug}.md 被手工改过（内容哈希与清单记录不符），已跳过删除：` +
            `确认无需保留后请手工删除该文件，并从 ${config.manifestPath} 里移除「${slug}」这一条`,
        );
        continue;
      }

      actions.push({
        type: 'delete',
        slug,
        sourceRel: entry.source,
        outputPath,
        content: null,
        outputHash: null,
        images: [],
        previousImages: entry.images ?? [],
        warnings: [],
      });
    }
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
