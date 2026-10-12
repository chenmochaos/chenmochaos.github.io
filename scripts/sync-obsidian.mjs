#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { makeConfig } from './sync/config.mjs';
import { runSync, formatReport } from './sync/sync.mjs';

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
    err.write(`❌ ${error.message}\n`);
    return 1;
  }
}

// 只有被当作脚本直接执行时才跑（测试 import 这个模块时不能有副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(makeConfig(), { dryRun: process.argv.slice(2).includes('--dry') });
}
