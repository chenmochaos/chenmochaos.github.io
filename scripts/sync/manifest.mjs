import fs from 'node:fs';

/**
 * 读取生成物清单；文件缺失、损坏或结构不符时一律降级为空清单。
 * 返回值固定是 `{ version, entries }`：`generatedAt` 只是落盘格式的一部分（记录写入时刻），
 * 不参与任何同步决策，所以不进内存对象——要检查它就读文件。
 */
export function loadManifest(config) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(config.manifestAbs, 'utf8'));
  } catch {
    return { version: 1, entries: {} };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: 1, entries: {} };
  }
  if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
    return { version: 1, entries: {} };
  }
  return { version: 1, entries: parsed.entries };
}

/** 写出清单，键排序以保证同内容产出同文本。 */
export function saveManifest(config, manifest) {
  const entries = {};
  for (const key of Object.keys(manifest.entries).sort()) entries[key] = manifest.entries[key];
  const payload = { version: 1, generatedAt: new Date().toISOString(), entries };
  fs.writeFileSync(config.manifestAbs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
