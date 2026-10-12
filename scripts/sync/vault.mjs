import fs from 'node:fs';
import path from 'node:path';

/** 递归遍历 vault，跳过 dot 目录与 excludeDirs，结果按名称排序以保证顺序稳定。 */
export function scanVault(config) {
  const collected = [];
  walk(config.vaultDir, config.vaultDir, config, collected);
  return collected;
}

function walk(dir, root, config, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录读不到（权限/竞态）时静默跳过，不影响其余文件
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || config.excludeDirs.includes(entry.name)) continue;
      walk(abs, root, config, out);
    } else if (entry.isFile()) {
      out.push({
        absPath: abs,
        relPath: path.relative(root, abs).split(path.sep).join('/'),
        name: entry.name,
      });
    }
  }
}

/** 拆成笔记数组与 附件名(小写) -> 绝对路径 的索引。同名附件先到先得（顺序已排序）。 */
export function buildIndexes(scanned) {
  const notes = [];
  const attachments = new Map();

  for (const file of scanned) {
    if (file.name.toLowerCase().endsWith('.md')) {
      notes.push(file);
      continue;
    }
    const key = file.name.toLowerCase();
    if (!attachments.has(key)) attachments.set(key, file.absPath);
  }

  return { notes, attachments };
}
