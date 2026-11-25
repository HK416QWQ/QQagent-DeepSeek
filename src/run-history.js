// 运行记录：一次 QQ Agent 进程启动 = 一条记录。
//
// 计时起点不是进程启动，也不是首条消息，而是**该进程第一次 OneBot 连接成功**：
// 冷启动时 SnowLuma/QQ 登录可能比进程晚几十秒，用进程启动时间会把"等登录"
// 算进运行时长；同进程断线重连既不算新记录，也不重置起点。
//
// 落盘文件 data/run-history.json：{ version: 1, runs: [...] }。
// 正常退出由 stop() 结算为 stopped；崩溃/强杀没有机会结算，下次启动把
// endedAt 为空的记录按最后一次心跳 lastSeenAt 结算为 interrupted。
// 只保留最近 200 条（按 startedAt 倒序）。
//
// 心跳每 30 秒更新一次 lastSeenAt 并原子落盘（tmp + rename），
// 既让强杀后的时长误差不超过 30 秒，又不至于频繁写盘。

import fs from 'node:fs';
import path from 'node:path';

const MAX_RUNS = 200;
const HEARTBEAT_MS = 30_000;

let dataDir = null;
let filePath = null;
let runs = [];
let currentId = null;
let heartbeatTimer = null;

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const run = runs.find((r) => r.id === currentId);
    if (!run || run.endedAt != null) {
      stopHeartbeat();
      return;
    }
    run.lastSeenAt = Date.now();
    persist();
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

/** 原子落盘：先写 .tmp 再 rename，避免强杀时留下半个 JSON。 */
function persist() {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs }, null, 2));
    fs.renameSync(tmp, filePath);
  } catch { /* 运行记录写失败不影响主流程 */ }
}

function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startedAt = Number(raw.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const lastSeenAt = Number(raw.lastSeenAt);
  const endedAt = raw.endedAt == null ? null : Number(raw.endedAt);
  const durationMs = Number(raw.durationMs);
  return {
    id: String(raw.id || `run_${startedAt}`),
    startedAt,
    lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : startedAt,
    endedAt: Number.isFinite(endedAt) ? endedAt : null,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
    status: String(raw.status || (endedAt == null ? 'running' : 'stopped'))
  };
}

/**
 * 注入数据目录并载入历史记录。
 * 上次进程若没来得及结算（崩溃/强杀），running 记录按最后一次心跳结算为 interrupted。
 * 不写空文件；只有在修正旧记录（结算/截断）时才落盘。
 */
export function initRunHistory(dir) {
  stopHeartbeat();
  currentId = null;
  runs = [];

  dataDir = dir ? String(dir) : null;
  filePath = dataDir ? path.join(dataDir, 'run-history.json') : null;
  if (!filePath) return;

  let rawRuns = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed?.runs)) rawRuns = parsed.runs;
  } catch { /* 文件不存在或损坏：当作空历史 */ }

  let changed = false;
  for (const raw of rawRuns) {
    const run = normalizeRun(raw);
    if (!run) continue;
    if (run.endedAt == null) {
      const end = run.lastSeenAt || run.startedAt;
      run.endedAt = end;
      run.durationMs = Math.max(0, end - run.startedAt);
      run.status = 'interrupted';
      changed = true;
    }
    runs.push(run);
  }

  runs.sort((a, b) => b.startedAt - a.startedAt);
  if (runs.length > MAX_RUNS) {
    runs = runs.slice(0, MAX_RUNS);
    changed = true;
  }

  if (changed) persist();
}

/**
 * 首次连接成功时创建记录并立即落盘；同一进程内再次连接只更新心跳。
 * @returns {boolean} 是否新建了记录（true = 本次开始计时）
 */
export function markRunConnected(ts = Date.now()) {
  const now = Number(ts) || Date.now();
  const existing = runs.find((r) => r.id === currentId);
  if (existing && existing.endedAt == null) {
    existing.lastSeenAt = now;
    startHeartbeat();
    return false;
  }
  const run = {
    id: `run_${now}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: now,
    lastSeenAt: now,
    endedAt: null,
    durationMs: 0,
    status: 'running'
  };
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  currentId = run.id;
  persist();
  startHeartbeat();
  return true;
}

/** 正常退出：结算当前记录为 stopped，清掉当前标记与心跳。 */
export function markRunStopped(ts = Date.now()) {
  stopHeartbeat();
  const run = runs.find((r) => r.id === currentId);
  currentId = null;
  if (!run || run.endedAt != null) return false;
  const now = Number(ts) || Date.now();
  run.endedAt = now;
  run.lastSeenAt = now;
  run.durationMs = Math.max(0, now - run.startedAt);
  run.status = 'stopped';
  persist();
  return true;
}

/**
 * 给 /api/status 用的轻量现状：没有记录返回 null。
 * 顺带刷新内存里的 lastSeenAt（不落盘），这样 /api/status 不产生写盘。
 */
export function getStatusRuntime(now = Date.now()) {
  const t = Number(now) || Date.now();
  const run = runs.find((r) => r.id === currentId);
  if (!run || run.endedAt != null) return null;
  run.lastSeenAt = t;
  return {
    id: run.id,
    startedAt: run.startedAt,
    durationMs: Math.max(0, t - run.startedAt),
    status: 'running'
  };
}

/** 运行历史快照：running 记录的时长按 now 实时计算。 */
export function getRuntimeSnapshot(limit = 50, now = Date.now()) {
  const t = Number(now) || Date.now();
  const num = Number(limit);
  const n = Number.isFinite(num) ? Math.min(MAX_RUNS, Math.max(1, Math.trunc(num))) : 50;
  const current = getStatusRuntime(t);
  const list = runs.slice(0, n).map((r) => {
    const isCurrent = r.id === currentId && r.endedAt == null;
    return {
      id: r.id,
      startedAt: r.startedAt,
      lastSeenAt: isCurrent ? t : r.lastSeenAt,
      endedAt: isCurrent ? null : r.endedAt,
      durationMs: isCurrent ? Math.max(0, t - r.startedAt) : r.durationMs,
      status: isCurrent ? 'running' : r.status
    };
  });
  return { serverNow: t, current, runs: list };
}
