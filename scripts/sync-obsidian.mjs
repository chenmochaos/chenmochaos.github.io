#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { makeConfig } from './sync/config.mjs';
import { runSync, formatReport } from './sync/sync.mjs';

const USAGE = '用法：pnpm sync [--dry|--dry-run]，不接受其他参数。';

/**
 * 解析命令行参数。未知参数一律报错，不静默忽略：`--dry-run`（rsync/git 的习惯写法）曾经被
 * 静默当成真实同步跑掉，而这个命令会删文件——把「试运行」执行成真删除是不能接受的失败模式。
 * 返回 { dryRun } 或 { error }。
 */
export function parseArgs(argv) {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry' || arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    return { error: `未知参数 ${arg}。${USAGE}` };
  }
  return { dryRun };
}

/**
 * 跑一次同步，把结果渲染成报告，返回进程退出码（0 = 无错误）。
 * out/err 可注入是为了让「vault 根目录读不到」这条路径可被测试——它是 spec §7.6 的用户可见部分，
 * 不该只靠人工试。
 */
export function main(config, { dryRun = false, out = process.stdout, err = process.stderr } = {}) {
  try {
    const result = runSync(config, { dryRun });
    out.write(`${formatReport(result)}\n`);
    return result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    // scanVault 在 vault 根目录读不到时抛错：这次同步什么都没做，不该以一段堆栈收场。
    err.write(`❌ ${error.message}\n→ 若这次是在写盘途中失败的，重新运行 pnpm sync 会接着做完：已写出的文件会被自动认领。\n`);
    return 1;
  }
}

// 只有被当作脚本直接执行时才跑（测试 import 这个模块时不能有副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { dryRun, error } = parseArgs(process.argv.slice(2));
  if (error) {
    process.stderr.write(`❌ ${error}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = main(makeConfig(), { dryRun });
  }
}
