import fs from 'node:fs';
import path from 'node:path';

/**
 * 相对路径统一成 URL 用的正斜杠。Linux 上这是恒等变换，因此没有测试能看见它（变异删掉它测试全过），
 * 只能靠审查守住；存在的意义是把跨平台差异收在一个地方，而不是散在每条 relPath 上。
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * 递归遍历 vault，返回每个文件的 { absPath, relPath, name }（不止 .md：附件也要在这里收集）。
 *
 * config 由 `makeConfig()` 产出，各路径已解析为绝对。
 *
 * `warnings` 刻意**不给默认值**：默认值会让「忘了传」与「故意不收集」变得无法区分，而本模块的整个
 * 前提是信息不能被静默丢掉——少一个数组，权限失败的目录就一句提示都留不下。调用方若确实不要警告，
 * 写 `[]` 明说。
 *
 * 顺序：每个目录内按名称排序后再下探，得到确定的 DFS 序。确定性是 buildIndexes「同名附件先到先得」
 * 的前提——readdirSync 的原始顺序由文件系统决定（ext4 是哈希序，tmpfs 是字节序），不排序就会出现
 * 「同一份 vault 在两台机器上挑中不同的同名附件」。比较器显式钉住 'en'：不传 locale 时 localeCompare
 * 跟随 $LANG/LC_ALL，同名附件的胜者乃至写进 public/images 的内容会随环境变化。这个钉子在本机测不出来
 * （ASCII 名在 'en' 与 C 下同序）；换成带重音的 fixture 能在本机把它测出来，但那条断言在
 * `LC_ALL=C` 的机器上又会失效——不稳定的测试比没有更难维护，所以由注释承担，不假装有测试覆盖。
 *
 * 读不到分两档，因为代价不对称：
 * - 根目录读不到（路径拼错、盘没挂上）→ 抛错。此时「扫到 0 个文件」与「vault 是空的」无法区分，
 *   而同步层会据此判定所有产物都该删除，一次路径笔误就能清空整个博客目录。
 * - 子目录读不到（权限、竞态）→ 记进 warnings 后继续，其余文件照常同步。漏一个子目录的代价是
 *   「少几篇文章」（报告里看得到），中断整次同步的代价是「什么都不同步」。
 *   但调用方不能把「扫描结果里没有」当成「源笔记已删除」：部分扫描与完整扫描在这里无从区分，
 *   见 sync.mjs 的删除闸门。
 *
 * 只跳过 dot **目录**，dot 文件照收（`STX/.gitignore` 会成为一个附件名）——spec §4.1 只约束了 dot
 * 目录、对 dot 文件没有表态，这里是取舍不是规范背书。
 * 已知限制：不跟随符号链接（entry.isFile()/isDirectory() 对链接都返回 false），链接笔记会被静默跳过；
 * 真实 vault 唯一的链接在被排除的 .claude/ 下，暂不受影响。
 */
export function scanVault(config, warnings) {
  // 参数没有默认值，但只传 config 时，undefined 要到**真的产生警告那一刻**才炸——那时错误已经发生，
  // 信息照样丢了。所以挡在入口：忘了传是编程错误，该立刻、指名道姓地失败，而不是等到权限出错时
  // 变成一句「Cannot read properties of undefined」。
  if (!Array.isArray(warnings)) throw new TypeError('scanVault 需要传入 warnings 数组（不要警告请传 []）');
  const collected = [];
  walk(config.vaultDir, config.vaultDir, config, collected, warnings);
  return collected;
}

function walk(dir, root, config, out, warnings) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (dir === root) {
      throw new Error(
        `无法读取 vault 目录 ${dir}：${error.code ?? error.message}——请检查路径是否存在、外置盘是否已挂载`,
        { cause: error },
      );
    }
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
 * `warnings` 同样不给默认值，理由见 scanVault：同名附件冲突意味着有一个真实存在的文件被忽略，
 * 不该存在「忘传数组就悄悄丢」这条路径。
 *
 * 同名附件先到先得，胜者由 walk 的确定 DFS 序决定：先在根目录按名称遇到谁，谁就赢，包括
 * 「根目录的文件」与「子目录里的同名文件」之间——子目录名排在同名文件名之前时，子目录那个先被收到。
 * 这条交错规则由测试钉住，因为它一旦反转，胜者与写进 public/images 的内容都会变。
 * 冲突时记警告并说明胜者：静默丢弃是本模块最不该做的事（警告由同步层汇总成报告，本模块只负责不吞信息）。
 */
export function buildIndexes(scanned, warnings) {
  if (!Array.isArray(warnings)) throw new TypeError('buildIndexes 需要传入 warnings 数组（不要警告请传 []）'); // 入口守卫，理由见 scanVault
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
      // 一次树遍历、不跟随链接，不会产出两条相同 absPath 的记录，所以这个判断当前恒真；
      // 留着是为了让「同一路径重复出现」不被当成冲突报出来（例如将来有人把 scan 结果拼接起来）。
      warnings.push(`同名附件冲突：「${file.relPath}」被忽略，一律使用「${winners.get(key)}」`);
    }
  }

  return { notes, attachments };
}
