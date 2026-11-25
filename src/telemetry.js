// 匿名用量遥测：周期性把"调用次数 + token 用量"快照发到 kondius.cn，供官网做总览统计。
//
// 隐私红线：payload 只有 随机 installId + 版本号 + 四个计数器。
//   不含 QQ 号、群号、昵称、聊天内容、机器信息、IP（IP 只在服务器内存里做限流，不落库）。
// 去重原理：服务器按 installId 覆盖式 upsert —— 同一客户端无论发多少次都只算一份，
//   彻底避免"一个用户的客户端发送多份"。覆盖安装/重装系统后 data 目录还在 → installId 不变。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, ROOT } from './config.js';

const REPORT_URL = 'https://kondius.cn/qq-agent/api/telemetry';
const INTERVAL_MS = 6 * 3600 * 1000;   // 之后每 6 小时一次
const FIRST_DELAY_MS = 90 * 1000;      // 启动 90 秒后发第一次（避开启动高峰）

const ID_FILE = path.join(DATA_DIR, 'telemetry.json');
const TOTALS_FILE = path.join(DATA_DIR, 'telemetry-totals.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const LEDGER_DIR = path.join(DATA_DIR, 'usage-ledger');

const num = (x) => Number(x) || 0;
const emptyTotals = () => ({ calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} });

/** 本地日键（与 sessions.js 的 localDayKey 同口径，各自独立实现，不互相导入）。 */
function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 一个会话里的 LLM 调用次数（与用量页同口径：带 token 用量的 raw 条目数）。 */
function countLlmCalls(s) {
  let n = 0;
  for (const m of (s?.messages || [])) {
    const ru = m?.raw?.usage || {};
    if ((Number(ru.prompt_tokens) || 0) + (Number(ru.completion_tokens) || 0) > 0) n += 1;
  }
  return n;
}

/** 读 totals；不存在/损坏返回 null（不做任何重建，重建只由 ensureTelemetryTotals 负责）。 */
function readTotals() {
  try {
    const d = JSON.parse(fs.readFileSync(TOTALS_FILE, 'utf8'));
    if (!d || typeof d !== 'object') return null;
    const t = { ...emptyTotals(), ...d };
    t.toolCounts = (t.toolCounts && typeof t.toolCounts === 'object') ? t.toolCounts : {};
    return t;
  } catch { return null; }
}

/** 写 totals（临时文件 + rename，避免写一半被读到）。 */
function writeTotals(t) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${TOTALS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t), 'utf8');
    fs.renameSync(tmp, TOTALS_FILE);
    return true;
  } catch { return false; }
}

/** 读全部日账本（坏账本记日志后跳过）。 */
function readLedgers(log = console.log) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(LEDGER_DIR).filter((f) => f.endsWith('.json')).sort(); } catch { return out; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, f), 'utf8'));
      if (!d || typeof d !== 'object') continue;
      out.push({ ...d, day: String(d.day || f.replace(/\.json$/, '')) });
    } catch (e) {
      log(`[telemetry] 账本读取失败，已跳过 ${f}: ${e?.message ?? e}`);
    }
  }
  return out;
}

/**
 * 确保 totals 可读（P0-04）。**必须在 `SessionRegistry.#loadIndex()` 之前调用**：
 * 否则第一次僵尸结算会先写出只含本次增量的 partial totals，历史基数永久丢失。
 *
 * 重建规则（写死，避免双计）：
 *   1) 先汇总全部 `data/usage-ledger/*.json`；
 *   2) 账本覆盖到的日期**不再扫描**对应会话文件；
 *   3) 只有“结束日”早于“最早一本账本的 day”的历史会话才扫描一次补旧基数；
 *   4) 任何情况下不把同一天的账本汇总与会话扫描结果相加。
 *
 * 账本为空时也写一份全零 totals（否则后续结算会因 totals 不可读而一直跳过 telemetry）。
 * @returns {object|null} totals（写盘失败时为内存对象，供本次运行继续累加）
 */
export function ensureTelemetryTotals(log = console.log) {
  const existing = readTotals();
  if (existing) return existing;          // 可读：只做一次读校验，不重建

  const t = emptyTotals();
  const ledgers = readLedgers(log);
  for (const l of ledgers) {
    t.calls += num(l.llmCalls);
    t.promptTokens += num(l.promptTokens);
    t.completionTokens += num(l.completionTokens);
    t.totalTokens += num(l.totalTokens);
    for (const [k, v] of Object.entries(l.toolCounts && typeof l.toolCounts === 'object' ? l.toolCounts : {})) {
      t.toolCounts[String(k)] = (t.toolCounts[String(k)] || 0) + num(v);
    }
    if (l.llmCallsComplete === false) {
      // 迁移账本：usage-today.json 没有 llmCalls/toolCounts，且迁移发生在当天中途，
      // 无法区分“迁移前已结束的会话”。补扫会把已进账本的 attempt 再算一遍，这里不补。
      log(`[telemetry] migrated day ${l.day}: llmCalls/toolCounts incomplete`);
    }
  }

  // 只有“结束日早于最早账本日”的历史会话才补扫一次
  const earliest = ledgers.map((l) => l.day).filter(Boolean).sort()[0] || null;
  let historicalScan = 0;
  if (earliest) {
    let files = [];
    try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { /* 无会话目录 */ }
    for (const f of files) {
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { continue; }
      const u = s?.usage || {};
      // 结束日一律按 localDayKey(endedAt ?? startedAt ?? 0) 归日，不用 startedAt 单独归日
      const day = localDayKey(s?.endedAt ?? s?.startedAt ?? 0);
      if (day >= earliest) continue;      // 账本覆盖日：绝不扫描
      historicalScan += 1;
      t.calls += countLlmCalls(s);
      t.promptTokens += num(u.promptTokens);
      t.completionTokens += num(u.completionTokens);
      t.totalTokens += num(u.totalTokens);
      for (const m of (s?.messages || [])) {
        const name = m?.toolCall?.name;
        if (name) t.toolCounts[String(name)] = (t.toolCounts[String(name)] || 0) + 1;
      }
    }
  } else {
    log('[telemetry] totals 缺少迁移前基数（没有任何账本），本次不扫描会话文件');
  }

  const wrote = writeTotals(t);
  log(`[telemetry] totals rebuilt from ledger files=${ledgers.length} historicalScan=${historicalScan}${wrote ? '' : '（写盘失败，本次仅在内存中累加）'}`);
  return t;
}

/**
 * 累加一次 telemetry 增量（P0-04 的唯一写入口）。
 * totals 不可读时**返回 false 且不写盘** —— 调用方跳过本次 telemetry 更新即可，
 * 绝不在现场重建（此时账本增量已写好，重建会把同一笔 delta 再加一遍）。
 * @param {{calls?:number, promptTokens?:number, completionTokens?:number, totalTokens?:number, toolCounts?:object}} delta
 * @returns {boolean}
 */
export function addTelemetryDelta(delta) {
  try {
    const cur = readTotals();
    if (!cur) return false;
    const t = { ...emptyTotals(), ...cur };
    t.calls += num(delta?.calls);
    t.promptTokens += num(delta?.promptTokens);
    t.completionTokens += num(delta?.completionTokens);
    t.totalTokens += num(delta?.totalTokens);
    if (!t.toolCounts || typeof t.toolCounts !== 'object') t.toolCounts = {};
    const tc = delta?.toolCounts && typeof delta.toolCounts === 'object' ? delta.toolCounts : {};
    for (const [k, v] of Object.entries(tc)) {
      const n = num(v);
      if (n) t.toolCounts[String(k)] = (t.toolCounts[String(k)] || 0) + n;
    }
    return writeTotals(t);
  } catch { return false; }
}

/**
 * 读累计总量（`report()` 的读取入口）。
 * totals 可读直接返回；否则交给 `ensureTelemetryTotals()` 按账本重建一次。
 * 汇总逻辑**只在 ensureTelemetryTotals 里有一份**，这里不再重写。
 */
function loadTotals(log = console.log) {
  const t = readTotals();
  if (t) return t;
  return ensureTelemetryTotals(log);
}

/** 匿名安装 ID：随机 UUID，首次运行时生成并持久化，重装/覆盖安装不丢。 */
function installId() {
  try {
    const d = JSON.parse(fs.readFileSync(ID_FILE, 'utf8'));
    if (d?.installId) return String(d.installId);
  } catch { /* 首次运行 */ }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ID_FILE, JSON.stringify({ installId: id, createdAt: Date.now() }), 'utf8');
  } catch { /* 写失败就下次再试 */ }
  return id;
}

function appVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '');
  } catch { return ''; }
}

export async function report(log) {
  const totals = loadTotals();   // 没有用量（含重建后仍为空）就不报
  if (!totals || !Number(totals.calls)) return;
  // 工具调用明细：只留 [a-z0-9_] 形态的键、整数次数，最多 50 个键
  const toolCounts = {};
  for (const [k, v] of Object.entries(totals.toolCounts || {})) {
    const key = String(k).slice(0, 40);
    const n = Math.max(0, Number(v) | 0);
    if (/^[\w-]+$/.test(key) && n > 0 && Object.keys(toolCounts).length < 50) toolCounts[key] = n;
  }
  try {
    const res = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installId: installId(),
        version: appVersion(),
        calls: Math.max(0, Number(totals.calls) || 0),
        inputTokens: Math.max(0, Number(totals.promptTokens) || 0),
        outputTokens: Math.max(0, Number(totals.completionTokens) || 0),
        totalTokens: Math.max(0, Number(totals.totalTokens) || 0),
        tools: toolCounts
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) log(`[遥测] 上报返回 HTTP ${res.status}（不影响使用）`);
  } catch (e) {
    log(`[遥测] 上报失败（不影响使用）: ${e?.message ?? e}`);
  }
}

export function startTelemetryLoop(log = console.log) {
  const first = setTimeout(() => {
    report(log);
    const timer = setInterval(() => report(log), INTERVAL_MS);
    timer.unref?.();
  }, FIRST_DELAY_MS);
  first.unref?.();
}
