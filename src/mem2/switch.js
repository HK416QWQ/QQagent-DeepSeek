// 第 5 期 · 硬切标记（switchTs）。
//
// `schema.json` 里的 `switchTs` 记录旧模块停止写入的时刻，是历史标记：
// backfill 展示与 UI 读取仍依赖它，用来判断新旧边界；它不再承担任何整理守卫职责。
//
// ── 为什么缓存要按 mtime 比，而不是「启动读一次」 ──────────────────────
// 读取方可能频繁调用，不能每轮读 6 次盘；但「启动时读一次」在**手工写了
// switchTs 却没重启**的场景下会读到旧值 —— 那是静默失效。折中是每次
// `statSync` 比对 mtime + size：一次 stat 的成本可以忽略，换来「文件改了立刻生效」。
//
//   （与第 2 期 `deepMerge` 抹键、第 5 期 §2.6 `readSchema` 白名单重建同族：
//     这三处的共同点是"看起来在读，其实读到的是自己想当然的那部分"。）

import fs from 'node:fs';
import { readSchema, schemaFile, writeJsonAtomic } from './paths.js';

/** 进程内缓存：{file, mtimeMs, size, value}。file 变化（测试换根目录）也视为失效。 */
const cache = { file: '', mtimeMs: -1, size: -1, value: null };

export function invalidateSchemaCache() {
  cache.file = '';
  cache.mtimeMs = -1;
  cache.size = -1;
  cache.value = null;
}

/**
 * 读 schema（带 mtime 缓存）。
 * 文件不存在 / stat 失败时**不写缓存**（下次重试），并回落到 readSchema 的骨架。
 */
export function readSchemaCached() {
  const file = schemaFile();
  try {
    const st = fs.statSync(file);
    if (cache.value && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.value;
    }
    const value = readSchema();
    cache.file = file;
    cache.mtimeMs = st.mtimeMs;
    cache.size = st.size;
    cache.value = value;
    return value;
  } catch {
    invalidateSchemaCache();
    return readSchema();
  }
}

/** 硬切时刻；0 = 还没切（安全默认：按"未切换"处理，绝不抛错）。 */
export function getSwitchTs() {
  return Number(readSchemaCached()?.switchTs) || 0;
}

/**
 * 写 switchTs。
 *
 * ★ 语义：`switchTs` = **旧模块停止写入的时刻**，取硬切实际生效那一刻，
 *   不是"现在"，更不许写未来时刻 —— 它同时是回退时判断新旧边界的依据，
 *   写偏几个小时，回退就会漏掉那几个小时的会话（它们已被实时链路覆盖）。
 */
export function setSwitchTs(ts, { nowTs = 0 } = {}) {
  const v = Math.round(Number(ts) || 0);
  if (!v) throw new Error('setSwitchTs: 必须给一个真实的毫秒时刻');
  if (nowTs && v > nowTs + 60_000) {
    // 未来时刻是最坏的一种错：当天看不出来，回退时才炸。
    throw new Error(`setSwitchTs: 不允许写未来时刻（${new Date(v).toISOString()}）`);
  }
  const cur = readSchema();
  const next = { ...cur, switchTs: v };
  if (!next.createdAt) next.createdAt = Date.now();
  if (!('backfillRunId' in next)) next.backfillRunId = null;
  writeJsonAtomic(schemaFile(), next);
  invalidateSchemaCache();
  return next;
}

/** 回退用：删掉 switchTs（不是置 0 —— 字段在就是"已切"）。 */
export function clearSwitchTs() {
  const cur = readSchema();
  const next = { ...cur };
  delete next.switchTs;
  writeJsonAtomic(schemaFile(), next);
  invalidateSchemaCache();
  return next;
}
