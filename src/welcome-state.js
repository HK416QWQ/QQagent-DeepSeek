// welcome-seen.json 的读写与清理（P0-01b）。
//
// 这里只做文件事实，不做业务判断：
//   · 路径由调用方（app.js）传入，模块自己不读全局 DATA_DIR；
//   · 键只接受 32 位小写十六进制（SHA-256 截断 128 位），文件里不出现群号/QQ/明文键；
//   · 加载失败**必须抛错**，由 app.js 记日志后按空表启动 —— 不能静默把坏文件当空表，
//     否则"状态文件坏了"这件事永远没人发现。
import fs from 'node:fs';
import path from 'node:path';
import {
  WELCOME_SEEN_MAX,
  WELCOME_USER_TTL_MS,
  isSeenKey,
  pruneSeen
} from './group-welcome.js';

export const WELCOME_SEEN_VERSION = 1;

/**
 * 读取防重表。
 * 文件不存在 → 空 Map；JSON/版本/结构非法 → 抛错（消息不含文件内容）。
 */
export function loadWelcomeSeen(file, {
  now = Date.now(),
  ttlMs = WELCOME_USER_TTL_MS,
  max = WELCOME_SEEN_MAX
} = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;   // 权限/IO 错误原样抛
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('welcome-seen 格式无效：JSON 解析失败');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('welcome-seen 格式无效：顶层不是对象');
  }
  if (parsed.version !== WELCOME_SEEN_VERSION) {
    throw new Error(`welcome-seen 格式无效：version=${String(parsed.version)}`);
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error('welcome-seen 格式无效：entries 不是数组');
  }

  const map = new Map();
  for (const item of parsed.entries) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [key, ts] = item;
    if (!isSeenKey(key) || !Number.isFinite(ts) || ts <= 0) continue;
    // 同一 key 重复出现：保留较新的成功记录
    const prev = map.get(key);
    if (prev == null || ts > prev) map.set(key, ts);
  }

  pruneSeen(map, now, ttlMs, max);
  return map;
}

/**
 * 原子保存防重表。
 * 先克隆（绝不修改调用方 Map）→ 清理 → 按 ts 升序写临时文件 → rename 替换。
 * 失败不重试、不吞错：由 GroupWelcome 记 `[welcome] 状态持久化失败`。
 */
export function saveWelcomeSeen(file, map, {
  now = Date.now(),
  ttlMs = WELCOME_USER_TTL_MS,
  max = WELCOME_SEEN_MAX
} = {}) {
  const copy = new Map(map);
  pruneSeen(copy, now, ttlMs, max);
  const entries = [...copy.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
  });
  const payload = JSON.stringify({
    version: WELCOME_SEEN_VERSION,
    updatedAt: now,
    entries
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${now}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, file);   // 同目录 rename：POSIX/NTFS 都是原子替换
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力清理，不掩盖原错误 */ }
    throw error;
  }
}
