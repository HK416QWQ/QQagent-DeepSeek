// 数据保留策略：除「用量与成本」相关数据外，其余历史数据只保留 N 天（默认 180）。
// 明细范围与排除项见施工单 5.1；这里只做文件层清理，绝不碰配置/密钥/表情/登录态。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
export const DEFAULT_RETENTION_DAYS = 180;
export const DEFAULT_VIDEO_CACHE_HOURS = 72;
export const DEFAULT_VIDEO_CACHE_MAX_MB = 2048;

/** 0 或非法值 = 关闭清理；返回 0 让调用方跳过。 */
export function retentionCutoffMs(days = DEFAULT_RETENTION_DAYS, now = Date.now()) {
  const n = Math.round(Number(days));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return now - n * DAY_MS;
}

/**
 * 视频缓存专用清理：两道闸，与 retentionDays 无关。
 *
 * 为什么单独定（而不是跟着 180 天走）：
 * - 它是入站预缓存落盘的，用来兜住 QQ 直链（rkey）过期，也是出问题时唯一能
 *   复现的取证材料 → 不能太短，隔夜的现场要留得住；
 * - 单条平均 8MB，活跃群一天几百 MB → 跟着 180 天会吃几十 GB。
 *
 * 第 1 闸按 mtime 删（默认 72 小时）；
 * 第 2 闸按目录总容量删最老的（默认 2GB），**至少保留最新 1 个**——
 * 否则把上限设得比单条视频还小，刚读完的文件会被立刻删掉。
 *
 * @returns {{removed:number, freedBytes:number, expired:number, evicted:number,
 *            kept:number, totalBytes:number, dryRun:boolean, victims:Array}}
 */
export function pruneVideoCache(root, {
  hours = DEFAULT_VIDEO_CACHE_HOURS,
  maxMb = DEFAULT_VIDEO_CACHE_MAX_MB,
  dryRun = false,
  now = Date.now(),
} = {}) {
  const out = {
    removed: 0, freedBytes: 0, expired: 0, evicted: 0,
    kept: 0, totalBytes: 0, dryRun, victims: [],
  };

  let names;
  try { names = fs.readdirSync(root); } catch { return out; }   // 目录不存在 = 无事可做

  const entries = [];
  for (const name of names) {
    const p = path.join(root, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      entries.push({ path: p, name, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* 正在被占用/刚被删 → 跳过 */ }
  }

  // 第 1 闸：活过多久
  const h = Number(hours);
  const cutoff = Number.isFinite(h) && h > 0 ? now - h * HOUR_MS : 0;
  const survivors = [];
  for (const e of entries) {
    if (cutoff && e.mtimeMs < cutoff) {
      out.expired += 1;
      out.victims.push({ ...e, why: 'expired' });
    } else {
      survivors.push(e);
    }
  }

  // 第 2 闸：总容量，最老的先走，至少留 1 个
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = survivors.reduce((s, e) => s + e.size, 0);
  const mb = Number(maxMb);
  const cap = Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 0;
  let i = 0;
  if (cap) {
    while (total > cap && survivors.length - i > 1) {
      const e = survivors[i];
      total -= e.size;
      out.evicted += 1;
      out.victims.push({ ...e, why: 'over-cap' });
      i += 1;
    }
  }
  out.kept = survivors.length - i;
  out.totalBytes = total;

  if (dryRun) return out;

  for (const v of out.victims) {
    try {
      fs.rmSync(v.path, { force: true });
      out.removed += 1;
      out.freedBytes += v.size;
    } catch { /* Windows 上正在被读会 EBUSY，留给下一轮 */ }
  }
  return out;
}

/** 按文件 mtime 清理目录；recursive=true 时连子目录一起扫，并顺手删空目录。 */
function pruneByMtime(root, cutoff, { recursive = false, maxDepth = 6 } = {}) {
  let removed = 0;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (recursive && depth < maxDepth) walk(p, depth + 1);
        try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch { /* ignore */ }
        continue;
      }
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { force: true }); removed += 1; }
      } catch { /* ignore */ }
    }
  };
  walk(root, 0);
  return removed;
}

/**
 * 执行一次保留清理。sessions/store 传入运行中的实例，保证内存索引与磁盘同步。
 * 任何一项失败都只记日志，不影响其它项与主流程。
 */
export async function runRetention({ sessions = null, store = null, days, messagesDays, log = () => {} } = {}) {
  const cfgStore = getConfig()?.store ?? {};
  const configured = days == null
    ? Number(cfgStore.retentionDays ?? DEFAULT_RETENTION_DAYS)
    : Number(days);
  const cutoff = retentionCutoffMs(configured);
  // 消息存档单独的保留期（2026-11-11）。0 = 永久保留（默认）。
  // 为什么必须单独算：retentionDays 同时管 sessions(785MB) / messages /
  // backups / 代码备份。想保住 17MB 消息就把 retentionDays 设 0 的话，
  // 785MB 会话文件和全部备份会无限增长 —— 为了小头丢大头。
  // `messagesDays` 与 `days` 对称，供调用方/测试显式覆盖，缺省读配置。
  const msgConfigured = messagesDays == null
    ? Number(cfgStore.messagesRetentionDays ?? 0)
    : Number(messagesDays);
  const msgCutoff = retentionCutoffMs(msgConfigured);

  const result = {
    cutoff, sessions: 0, messages: 0, videoCache: 0, backups: 0,
    videoCacheDetail: null,
    // ★ 每个子任务的失败摘要都进这里。调用方（retentionTick）只在 errors 为空时
    //   写 20h 门闩 —— 一次失败被门闩压住，等于这一天再也不会重试。
    //   `skipped:true`（按配置无活可干）且 errors 为空视为成功。
    errors: [],
  };
  const fail = (label, e) => {
    const msg = `${label}: ${e?.message ?? e}`;
    result.errors.push(msg);
    log(`[retention] ${msg}`);
  };

  // 视频缓存先跑，且**不受 retentionDays 影响**：它有自己的一对闸（时长 + 容量）。
  // 否则把 retentionDays 设 0（不清理）就等于放任视频缓存无限长。
  try {
    const vc = pruneVideoCache(path.join(DATA_DIR, 'video-cache'), {
      hours: cfgStore.videoCacheHours ?? DEFAULT_VIDEO_CACHE_HOURS,
      maxMb: cfgStore.videoCacheMaxMb ?? DEFAULT_VIDEO_CACHE_MAX_MB,
    });
    result.videoCache = vc.removed;
    result.videoCacheDetail = vc;
    if (vc.removed > 0) {
      log(`[retention] 视频缓存清理 ${vc.removed} 个（超时 ${vc.expired}、超容量 ${vc.evicted}），`
        + `释放 ${(vc.freedBytes / 1048576).toFixed(1)}MB，保留 ${vc.kept} 个 / `
        + `${(vc.totalBytes / 1048576).toFixed(1)}MB`);
    }
  } catch (e) { fail('视频缓存清理失败', e); }

  // ★★ 消息存档清理必须放在 `if (!cutoff) return` **之前**（2026-11-11）。
  //    `retentionDays=0 + messagesRetentionDays=30` 这个组合（不删会话、只删消息）
  //    如果放在后面，会被整体跳过 —— 用户设了 30 天，结果一条都不删，
  //    而且没有任何日志，看起来像"功能没做"。
  try { result.messages = msgCutoff ? (store?.pruneBefore?.(msgCutoff) || 0) : 0; }
  catch (e) { fail('存档清理失败', e); }

  if (!cutoff) return { ...result, skipped: true };

  try { result.sessions = sessions?.pruneOlderThan?.(cutoff) || 0; }
  catch (e) { fail('会话清理失败', e); }
  try { result.backups = pruneByMtime(path.join(DATA_DIR, 'backup'), cutoff, { recursive: true }); }
  catch (e) { fail('代码备份清理失败', e); }
  try {
    const boot = path.join(DATA_DIR, 'boot-diag.log');
    if (fs.existsSync(boot) && fs.statSync(boot).mtimeMs < cutoff) {
      fs.rmSync(boot, { force: true });
      result.backups += 1;
    }
  } catch (e) { fail('boot-diag 清理失败', e); }

  const total = result.sessions + result.messages + result.videoCache
    + result.backups;
  if (total > 0) {
    log(`[retention] 已清理 ${configured} 天前的历史数据：`
      + `会话 ${result.sessions}、存档 ${result.messages}、视频缓存 ${result.videoCache}、`
      + `备份 ${result.backups}`);
  }
  return result;
}

// ── 20 小时门闩（P1-03）──────────────────────────────────────────────
//
// 为什么在 retention.js 而不是 app.js：tick 的**执行顺序**是施工单写死的
// （读门闩 → 20h 内 return → await runRetention → errors 非空只记日志 return
//   → 原子写 {ts}），抽成导出函数才能被 test/retention-latch-test.mjs 真正跑到，
// app.js 只负责接线与定时器。
export const RETENTION_LATCH_FILE = path.join(DATA_DIR, 'retention-last.json');
export const RETENTION_LATCH_MS = 20 * 60 * 60 * 1000;

export function readRetentionLatch(file = RETENTION_LATCH_FILE) {
  try { return Number(JSON.parse(fs.readFileSync(file, 'utf8'))?.ts) || 0; } catch { return 0; }
}

export function writeRetentionLatch(ts = Date.now(), file = RETENTION_LATCH_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ts }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/**
 * 单次 retention tick（含门闩）。
 *
 * @returns {{ran:boolean, wrote:boolean, reason?:string, errors?:string[], result?:object}}
 *   `ran:false` = 20 小时内已跑过；`wrote:false` 且 `ran:true` = 本次有错误，不写门闩。
 */
export async function runRetentionTick({
  file = RETENTION_LATCH_FILE,
  windowMs = RETENTION_LATCH_MS,
  now = () => Date.now(),
  run = runRetention,
  args = {},
  log = () => {},
} = {}) {
  const last = readRetentionLatch(file);
  if (last > 0 && now() - last < windowMs) return { ran: false, wrote: false, reason: 'latch' };
  const result = await run(args);
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (errors.length) {
    log(`[retention] 本次有 ${errors.length} 项失败，不写门闩（下次重试）`);
    return { ran: true, wrote: false, errors, result };
  }
  const wrote = writeRetentionLatch(now(), file);
  return { ran: true, wrote, result };
}
