import fs from 'node:fs';
import path from 'node:path';

/**
 * 相对路径统一成 URL 用的正斜杠。Linux 上这是恒等变换，因此没有测试能看见它（变异删掉它测试全过），
 * 只能靠审查守住；存在的意义是把跨平台差异收在一个地方。
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * 递归遍历 vault，返回每个文件的 { absPath, relPath, name }（不止 .md：附件也要在这里收集）。
 *
 * 顺序：每个目录内按名称排序后再下探，得到确定的 DFS 序。确定性是 buildIndexes「同名附件先到先得」
 * 的前提——readdirSync 的原始顺序由文件系统决定（ext4 是哈希序，tmpfs 是字节序），不排序就会出现
 * 「同一份 vault 在两台机器上挑中不同的同名附件」。比较器显式钉住 'en'：不传 locale 时 localeCompare
 * 跟随 $LANG/LC_ALL，同名附件的胜者乃至写进 public/images 的内容会随环境变化。
 *
 * 读不到的情况分两档，因为代价不对称：
 * - 根目录读不到（路径拼错、盘没挂上）→ 抛错。此时「扫到 0 个文件」与「vault 是空的」无法区分，
 *   而同步层会据此判定所有产物都该删除，一次路径笔误就能清空整个博客目录。
 * - 子目录读不到（权限、竞态）→ 记进 warnings 后继续，其余文件照常同步。漏一个子目录的代价是
 *   「少几篇文章」（报告里看得到），中断整次同步的代价是「什么都不同步」。
 *
 * 已知限制：不跟随符号链接（entry.isFile()/isDirectory() 对链接都返回 false），vault 里的链接笔记
 * 会被静默跳过。真实 vault 唯一的链接在被排除的 .claude/ 下，暂不受影响。
 */
export function scanVault(config, warnings = []) {
  const collected = [];
  walk(config.vaultDir, config.vaultDir, config, collected, warnings);
  return collected;
}

function walk(dir, root, config, out, warnings) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (dir === root) throw new Error(`无法读取 vault 目录 ${dir}：${error.code ?? error.message}`);
    warnings.push(`无法读取目录 ${toPosix(path.relative(root, dir))}：${error.code ?? error.message}，该目录内容已跳过`);
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || config.excludeDirs.includes(entry.name)) continue;
      walk(abs, root, config, out, warnings);
    } else if (entry.isFile()) {
      out.push({ absPath: abs, relPath: toPosix(path.relative(root, abs)), name: entry.name });
    }
  }
}

/**
 * 拆成笔记数组与 附件名(小写) -> 绝对路径 的索引。
 *
 * 同名附件先到先得，胜者由 walk 的确定 DFS 序决定。这条规则此前只写在注释里：变异成后到先得，
 * 全部测试照样通过。冲突会丢掉另一个真实存在的文件，所以这里记警告——静默丢弃是本模块最不该做的事
 * （报告由同步层汇总，本模块只负责不把信息吞掉）。
 */
export function buildIndexes(scanned, warnings = []) {
  const notes = [];
  const attachments = new Map();
  const winners = new Map(); // 只为冲突提示保留胜者的相对路径

  for (const file of scanned) {
    if (file.name.toLowerCase().endsWith('.md')) {
      notes.push(file);
      continue;
    }
    const key = file.name.toLowerCase();
    const winner = attachments.get(key);
    if (winner === undefined) {
      attachments.set(key, file.absPath);
      winners.set(key, file.relPath);
    } else if (winner !== file.absPath) {
      warnings.push(`同名附件冲突：「${file.relPath}」被忽略，一律使用「${winners.get(key)}」`);
    }
  }

  return { notes, attachments };
}
