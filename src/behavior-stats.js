// 行为统计模块：机器人「行为层」指标的采集、持久化与聚合。
//
// 与 src/llm.js 的 token 统计（usage-today.json / 按天文件 / telemetry）**独立并存**：
// 它专门记录现有系统没采集的「行为」指标，不碰成本/token 那套（避免破坏匿名遥测
// 与既有的成本看板口径）。
//
// 采集点（全部是系统现成的统一入口，见各调用方注释）：
//   发送（条数/字数/表情包/图片/媒体）→ app.js 里 SendQueue 的 onSent
//   识图（视觉理解工具调用）          → orchestrator 工具执行循环
//   思考（带 reasoning tokens 的调用）→ orchestrator LLM 链路
//   单次会话消耗快照                → orchestrator 会话结束
//
// 数据落盘（跨重启保留）：
//   data/behavior-stats/today.json              当天内存态（含按小时）
//   data/behavior-stats/archive-<YYYY-MM-DD>.json 每日归档（含按会话明细）
//
// 聚合：buildStats(range) → { totals, hours[], days[], chats[], sessions[] }
//   range ∈ today|7|30|all，与用量页其它维度同语义。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── 会话 key 解析（group:123 / private:456）────────────────────────────
function chatNameOf(key) {
  return String(key ?? '');
}
const chatLabel = (key) => {
  const k = String(key ?? '');
  const m = /^(group|private):(.+)$/.exec(k);
  if (!m) return k || '未知';
  return m[1] === 'group' ? `群 ${m[2]}` : `私聊 ${m[2]}`;
};

// ── 日期/时间键 ─────────────────────────────────────────────────────────
function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hourKey(ts) {
  return new Date(ts).getHours();
}
/** 今天 0 点时间戳。 */
function startOfToday(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── 数据目录（与 config.js 的 DATA_DIR 同约定）──────────────────────────
// 启动时由 app.js 通过 injectDataDir(DATA_DIR) 注入，避免循环依赖。
// 未注入时按约定回退：环境变量 >> 进程 cwd/data。
let _injectDir = null;
export function injectDataDir(D) { _injectDir = D; }

function dataDirResolved() {
  if (_injectDir) return path.join(_injectDir, 'behavior-stats');
  const env = process.env.QQ_AGENT_DATA_DIR;
  if (env) return path.join(env, 'behavior-stats');
  return path.join(process.cwd(), 'data', 'behavior-stats');
}

// ── 内存态：当天累加器 ─────────────────────────────────────────────────
// dayKey -> { 基础计数 + hours: Map<hour, 计数> + chats: Map<key, 计数> + sessions: [] }
const memory = new Map(); // dayKey -> bucket

function emptyBucket(dayKey) {
  return {
    dayKey,
    sentCount: 0, charCount: 0, stickerCount: 0, imageSentCount: 0, mediaSentCount: 0,
    visionCalls: 0, thinkingCalls: 0, apiCalls: 0,
    videoCalls: 0, audioCalls: 0,
    cachedTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    hours: new Map(),   // hour -> counters
    chats: new Map(),   // chatKey -> counters
    sessions: []        // 单次会话消耗快照
  };
}

function bucket(dayKey) {
  let b = memory.get(dayKey);
  if (!b) { b = emptyBucket(dayKey); memory.set(dayKey, b); }
  return b;
}

/** 累加一个"计数对象"到一个桶（含 hours / chats 细分的通用累加）。 */
function addCounters(target, src, key, ts) {
  target.sentCount += src.sentCount || 0;
  target.charCount += src.charCount || 0;
  target.stickerCount += src.stickerCount || 0;
  target.imageSentCount += src.imageSentCount || 0;
  target.mediaSentCount += src.mediaSentCount || 0;
  target.visionCalls += src.visionCalls || 0;
  target.thinkingCalls += src.thinkingCalls || 0;
  target.videoCalls += src.videoCalls || 0;
  target.audioCalls += src.audioCalls || 0;
  target.apiCalls += src.apiCalls || 0;
  target.cachedTokens += src.cachedTokens || 0;
  target.promptTokens += src.promptTokens || 0;
  target.completionTokens += src.completionTokens || 0;
  target.totalTokens += src.totalTokens || 0;
  if (key != null && ts != null) {
    const h = hourKey(ts);
    const hb = target.hours.get(h) || emptyLocal();
    mergeLocal(hb, src); target.hours.set(h, hb);
    const cb = target.chats.get(key) || emptyLocal();
    mergeLocal(cb, src); target.chats.set(key, cb);
  }
}
function emptyLocal() { return { sentCount: 0, charCount: 0, stickerCount: 0, imageSentCount: 0, mediaSentCount: 0, visionCalls: 0, thinkingCalls: 0, apiCalls: 0, videoCalls: 0, audioCalls: 0, cachedTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }; }
function mergeLocal(t, s) {
  for (const k of ['sentCount', 'charCount', 'stickerCount', 'imageSentCount', 'mediaSentCount', 'visionCalls', 'thinkingCalls', 'apiCalls', 'videoCalls', 'audioCalls', 'cachedTokens', 'promptTokens', 'completionTokens', 'totalTokens']) {
    t[k] = (t[k] || 0) + (s[k] || 0);
  }
}

// ── 公开的采集 API（供 app.js / orchestrator.js 调用）───────────────────

/** 记录一次机器人发出的消息。kind: 'text'|'sticker'|'image'|'media'|'poke' */
export function recordSend({ chatKey, text = '', kind = 'text', ts = Date.now() }) {
  const dayKey = localDayKey(ts);
  const b = bucket(dayKey);
  const src = { sentCount: 1, charCount: 0, stickerCount: 0, imageSentCount: 0, mediaSentCount: 0 };
  if (kind === 'sticker') src.stickerCount = 1;
  else if (kind === 'image') src.imageSentCount = 1;
  else if (kind === 'media') src.mediaSentCount = 1;
  else { // text（含 poke 之类落成文本的，仍计一字符量）
    src.charCount = String(text || '').length;
  }
  addCounters(b, src, chatNameOf(chatKey), ts);
  schedulePersist();
}

/** 记录一次识图（视觉理解工具被真实调用，且产生了视觉输入）。 */
export function recordVision({ chatKey, toolName = '', imageCount = 1, ts = Date.now() }) {
  const dayKey = localDayKey(ts);
  const b = bucket(dayKey);
  const src = { visionCalls: imageCount || 1 };
  addCounters(b, src, chatNameOf(chatKey), ts);
  schedulePersist();
}

/** 记录一次"思考"（带 reasoning tokens 的 LLM 调用）。 */
export function recordThinking({ chatKey, reasoningTokens = 1, ts = Date.now() }) {
  const dayKey = localDayKey(ts);
  const b = bucket(dayKey);
  const src = { thinkingCalls: (Number(reasoningTokens) > 0 ? 1 : 0) };
  addCounters(b, src, chatNameOf(chatKey), ts);
  schedulePersist();
}

/**
 * 记录一次"识别视频"（read_video 真的把画面送到了模型；与"识图"分开计）。
 * 调用点自己负责判断 route/failure —— 这里不做语义判断，只记数。
 */
export function recordVideo({ chatKey, ts = Date.now() }) {
  const dayKey = localDayKey(ts);
  const b = bucket(dayKey);
  addCounters(b, { videoCalls: 1 }, chatNameOf(chatKey), ts);
  schedulePersist();
}

/** 记录一次"音频识别"（本地 ASR 成功产出文本：视频音轨 / 语音消息）。 */
export function recordAudio({ chatKey, ts = Date.now() }) {
  const dayKey = localDayKey(ts);
  const b = bucket(dayKey);
  addCounters(b, { audioCalls: 1 }, chatNameOf(chatKey), ts);
  schedulePersist();
}

/** 记录一次 LLM API 调用（不含 0 token 的等待/中止会话）。 */
export function recordApiCall({ chatKey, usage = null, ts = Date.now() }) {
  const dayKey = localDayKey(ts);
  const b = bucket(dayKey);
  // 调用方传进来的是接口原始 usage（snake_case，见 llm.js addUsage 的兼容链），
  // 不是 session.usage 那种 camelCase 汇总。两种都认，否则 token 全部记成 0。
  const u = usage || {};
  const prompt = Number(u.promptTokens ?? u.prompt_tokens) || 0;
  const completion = Number(u.completionTokens ?? u.completion_tokens) || 0;
  const cached = Number(
    u.cachedTokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? u.prompt_cache_hit_tokens
    ?? 0
  ) || 0;
  const src = {
    apiCalls: 1,
    cachedTokens: cached,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Number(u.totalTokens ?? u.total_tokens) || prompt + completion
  };
  addCounters(b, src, chatNameOf(chatKey), ts);
  schedulePersist();
}

/**
 * 记录一个**已结束会话**的消耗快照（单次会话级明细，供"查看单条信息消耗量"）。
 * session: { chatKey, at, cost, durationMs, usage:{...}, sentCount, charCount, stickerCount,
 *            visionCalls, thinkingCalls, apiCalls, toolCalls }
 */
export function recordSession(session = {}) {
  const chatKey = chatNameOf(session.chatKey);
  const ts = Number(session.at) || Date.now();
  const dayKey = localDayKey(ts);
  const b = bucket(dayKey);
  // 快照按时间倒序放前面（最新在前）
  b.sessions.unshift({
    chatKey,
    sessionId: String(session.sessionId || ''),
    rounds: Number(session.rounds) || 0,
    model: String(session.model || ''),
    at: ts,
    cost: session.cost == null ? null : (Number(session.cost) || 0),
    durationMs: Number(session.durationMs) || 0,
    sentCount: Number(session.sentCount) || 0,
    charCount: Number(session.charCount) || 0,
    stickerCount: Number(session.stickerCount) || 0,
    visionCalls: Number(session.visionCalls) || 0,
    videoCalls: Number(session.videoCalls) || 0,
    audioCalls: Number(session.audioCalls) || 0,
    thinkingCalls: Number(session.thinkingCalls) || 0,
    apiCalls: Number(session.apiCalls) || 0,
    toolCalls: Number(session.toolCalls) || 0,
    promptTokens: Number(session.usage?.promptTokens) || 0,
    completionTokens: Number(session.usage?.completionTokens) || 0,
    cachedTokens: Number(session.usage?.cachedTokens) || 0,
    totalTokens: Number(session.usage?.totalTokens) || 0,
    tools: (session.tools && typeof session.tools === 'object' && !Array.isArray(session.tools))
      ? session.tools : {},
  });
  // 快照条目膨胀保护：每天的明细最多留最近 2000 条
  const MAX_SESSIONS = 2000;
  if (b.sessions.length > MAX_SESSIONS) b.sessions.length = MAX_SESSIONS;
  schedulePersist();
}

// ── 持久化（防抖落盘 + 每日归档）──────────────────────────────────────
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistAll().catch(() => {}); }, 1500);
}

async function persistAll() {
  try {
    const dirR = dataDirResolved();
    fs.mkdirSync(dirR, { recursive: true });
    const now = Date.now();
    const todayKey = localDayKey(now);
    // 今天的累计（含小时/会话细分）写 today.json；历史日期归档。
    for (const [dk, b] of memory) {
      const serializable = serializeBucket(b);
      const file = path.join(dirR, dk === todayKey ? 'today.json' : `archive-${dk}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(serializable), 'utf8');
      fs.renameSync(tmp, file);
    }
  } catch (error) {
    console.warn('[behavior-stats] 持久化失败：', error?.message ?? error);
  }
}

function serializeBucket(b) {
  return {
    dayKey: b.dayKey,
    sentCount: b.sentCount, charCount: b.charCount, stickerCount: b.stickerCount,
    imageSentCount: b.imageSentCount, mediaSentCount: b.mediaSentCount,
    visionCalls: b.visionCalls, thinkingCalls: b.thinkingCalls, apiCalls: b.apiCalls,
    videoCalls: b.videoCalls, audioCalls: b.audioCalls,
    cachedTokens: b.cachedTokens, promptTokens: b.promptTokens,
    completionTokens: b.completionTokens, totalTokens: b.totalTokens,
    hours: [...b.hours.entries()].map(([h, c]) => ({ hour: h, ...c })),
    chats: [...b.chats.entries()].map(([key, c]) => ({ key, ...c })),
    sessions: b.sessions
  };
}

// ── 读取 + 聚合 ─────────────────────────────────────────────────────────
function readDayFile(dayKey) {
  const dirR = dataDirResolved();
  const file = path.join(dirR, dayKey === localDayKey(Date.now()) ? 'today.json' : `archive-${dayKey}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 跨零点后 today.json 还是昨天的内容，直到下一次落盘才归档改名。
    // 不校验 dayKey 会把昨天的累计当成"今天"读出来（面板在零点后瞬间翻错）。
    if (raw?.dayKey && raw.dayKey !== dayKey) return null;
    return normalizeSerialized(raw, dayKey);
  } catch { return null; }
}

function normalizeSerialized(raw, dayKey) {
  if (!raw) return null;
  const hours = Array.isArray(raw.hours) ? raw.hours : [];
  const chats = Array.isArray(raw.chats) ? raw.chats : [];
  return {
    dayKey: raw.dayKey || dayKey,
    sentCount: Number(raw.sentCount) || 0, charCount: Number(raw.charCount) || 0,
    stickerCount: Number(raw.stickerCount) || 0, imageSentCount: Number(raw.imageSentCount) || 0,
    mediaSentCount: Number(raw.mediaSentCount) || 0, visionCalls: Number(raw.visionCalls) || 0,
    thinkingCalls: Number(raw.thinkingCalls) || 0, apiCalls: Number(raw.apiCalls) || 0,
    videoCalls: Number(raw.videoCalls) || 0, audioCalls: Number(raw.audioCalls) || 0,
    cachedTokens: Number(raw.cachedTokens) || 0, promptTokens: Number(raw.promptTokens) || 0,
    completionTokens: Number(raw.completionTokens) || 0, totalTokens: Number(raw.totalTokens) || 0,
    hours, chats, sessions: Array.isArray(raw.sessions) ? raw.sessions : []
  };
}

/** 两个归一化日对象相加（用于跨天汇总）。 */
function addDay(a, b) {
  const r = {
    sentCount: (a.sentCount || 0) + (b.sentCount || 0),
    charCount: (a.charCount || 0) + (b.charCount || 0),
    stickerCount: (a.stickerCount || 0) + (b.stickerCount || 0),
    imageSentCount: (a.imageSentCount || 0) + (b.imageSentCount || 0),
    mediaSentCount: (a.mediaSentCount || 0) + (b.mediaSentCount || 0),
    visionCalls: (a.visionCalls || 0) + (b.visionCalls || 0),
    thinkingCalls: (a.thinkingCalls || 0) + (b.thinkingCalls || 0),
    videoCalls: (a.videoCalls || 0) + (b.videoCalls || 0),
    audioCalls: (a.audioCalls || 0) + (b.audioCalls || 0),
    apiCalls: (a.apiCalls || 0) + (b.apiCalls || 0),
    cachedTokens: (a.cachedTokens || 0) + (b.cachedTokens || 0),
    promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
    completionTokens: (a.completionTokens || 0) + (b.completionTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
  };
  return r;
}

/** 解析时间范围：返回起止时间戳。 */
function resolveRange(range) {
  const now = Date.now();
  const raw = String(range);
  if (raw === 'today') return { mode: 'today', start: startOfToday(now) };
  if (raw === '30') return { mode: '30', start: startOfToday(now - 29 * 86400000) };
  if (raw === 'all') return { mode: 'all', start: 0 };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) {
    const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
    if (Number.isFinite(start) && localDayKey(start) === raw) {
      return { mode: 'day', start, dayKey: raw };
    }
  }
  return { mode: '7', start: startOfToday(now - 6 * 86400000) }; // 默认近 7 天
}

/**
 * 聚合行为统计。返回结构：
 *   { range, rangeLabel, mode, totals, hours[], days[], chats[], sessions[] }
 * 与用量页 token 统计同构（totals/chats/hours），前端可直接复用其表格框架。
 */
export function buildStats({ range = '7' } = {}) {
  const win = resolveRange(range);
  const now = Date.now();
  const todayKey = localDayKey(now);

  // 需要扫描的天键：从窗口起点到今天（含），逐日读文件/内存。
  const keys = [];
  if (win.mode === 'all') {
    // 全部：读取磁盘所有 archive-*.json + today.json
    const dirR = dataDirResolved();
    let files = [];
    try { files = fs.readdirSync(dirR).filter((f) => /^archive-\d{4}-\d{2}-\d{2}\.json$/.test(f) || f === 'today.json'); } catch { /* 无目录 */ }
    for (const f of files) {
      const m = /^archive-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      keys.push(m ? m[1] : todayKey);
    }
    if (!keys.includes(todayKey)) keys.push(todayKey);
  } else if (win.mode === 'day') {
    // 指定某一天：只读那一天（今天仍走内存态/今天的文件）
    keys.push(win.dayKey);
  } else {
    for (let t = win.start; t <= now; t += 86400000) {
      const k = localDayKey(t);
      if (!keys.includes(k)) keys.push(k);
    }
  }

  const totals = { sessionCount: 0, sentCount: 0, charCount: 0, stickerCount: 0, imageSentCount: 0, mediaSentCount: 0, visionCalls: 0, thinkingCalls: 0, apiCalls: 0, videoCalls: 0, audioCalls: 0, cachedTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const days = [];
  const hoursByDay = new Map(); // dayKey -> { hour -> counters }
  const chats = new Map();      // chatKey -> counters
  const sessions = [];          // 单次会话快照（跨天，最新在前）

  for (const dk of keys) {
    // 优先内存态（今天可能还没落盘）；统一经 serialize+normalize 成数组形态，
    // 避免"内存桶的 hours/chats 是 Map、磁盘读的是数组"导致类型不一致。
    const mem = memory.get(dk);
    let day = readDayFile(dk);
    if (mem) day = normalizeSerialized(serializeBucket(mem), dk);
    if (!day) continue;
    // 汇总天数
    totals.sentCount += day.sentCount; totals.charCount += day.charCount;
    totals.stickerCount += day.stickerCount; totals.imageSentCount += day.imageSentCount;
    totals.mediaSentCount += day.mediaSentCount; totals.visionCalls += day.visionCalls;
    totals.thinkingCalls += day.thinkingCalls; totals.apiCalls += day.apiCalls;
    totals.videoCalls += day.videoCalls; totals.audioCalls += day.audioCalls;
    totals.cachedTokens += day.cachedTokens; totals.promptTokens += day.promptTokens;
    totals.completionTokens += day.completionTokens; totals.totalTokens += day.totalTokens;
    // 会话次数：当天真正调用过模型的会话数（0 调用的中止/空会话不计）
    const daySessionCount = (day.sessions || []).filter((s) => (Number(s.apiCalls) || 0) > 0).length;
    totals.sessionCount += daySessionCount;
    days.push({ day: dk, ...pickDay(day), sessionCount: daySessionCount });
    // 会话维度
    for (const c of (day.chats || [])) {
      const cur = chats.get(c.key) || emptyLocal();
      mergeLocal(cur, c); chats.set(c.key, cur);
    }
    // 小时维度（今天/指定某一天都按 24 小时展开）
    if (win.mode === 'today' || win.mode === 'day') {
      hoursByDay.set(dk, new Map((day.hours || []).map((h) => [Number(h.hour), h])));
    }
    // 会话快照
    for (const s of (day.sessions || [])) sessions.push({ ...s, dayKey: dk });
  }
  days.sort((a, b) => a.day.localeCompare(b.day));

  // hours 输出（今天/指定某一天按 0-23 补齐；否则最近一段每日单点不适合小柱图，前端用 days）
  let hours = [];
  if (win.mode === 'today' || win.mode === 'day') {
    const hourDayKey = win.mode === 'day' ? win.dayKey : todayKey;
    const hm = hoursByDay.get(hourDayKey) || new Map();
    // 按小时统计会话次数：取已汇总的 sessions 快照，按开始时刻归时
    const hourSessions = new Map();
    for (const s of sessions) {
      if (s.dayKey !== hourDayKey) continue;
      if (!((Number(s.apiCalls) || 0) > 0)) continue;
      const h = hourKey(Number(s.at) || 0);
      hourSessions.set(h, (hourSessions.get(h) || 0) + 1);
    }
    for (let h = 0; h < 24; h++) {
      const c = hm.get(h) || emptyLocal();
      hours.push({
        hour: h, ...c,
        sessionCount: hourSessions.get(h) || 0,
        cacheMissTokens: Math.max(0, (Number(c.promptTokens) || 0) - (Number(c.cachedTokens) || 0))
      });
    }
  }

  const chatsList = [...chats.entries()].map(([key, c]) => {
    const hitRate = c.promptTokens ? Math.min(1, (c.cachedTokens || 0) / c.promptTokens) : 0;
    return { key, chatKey: key, label: chatLabel(key), ...c, cacheHitRate: hitRate, cacheMissTokens: Math.max(0, (c.promptTokens || 0) - (c.cachedTokens || 0)) };
  }).sort((a, b) => b.totalTokens - a.totalTokens || b.sentCount - a.sentCount);

  const totalHitRate = totals.promptTokens ? Math.min(1, (totals.cachedTokens || 0) / totals.promptTokens) : 0;

  sessions.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));

  const rangeLabels = { today: '今天', '7': '近 7 天', '30': '近 30 天', all: '全部' };
  const rangeLabel = win.mode === 'day' ? win.dayKey : (rangeLabels[String(range)] || String(range));
  return {
    range: String(range),
    rangeLabel,
    mode: win.mode,
    totals: { ...totals, cacheHitRate: totalHitRate, cacheMissTokens: Math.max(0, (totals.promptTokens || 0) - (totals.cachedTokens || 0)) },
    hours,
    days,
    chats: chatsList,
    sessionsTotal: sessions.length,
    sessions: sessions.slice(0, 500)
  };
}
function pickDay(day) {
  return {
    sentCount: day.sentCount, charCount: day.charCount, stickerCount: day.stickerCount,
    imageSentCount: day.imageSentCount, mediaSentCount: day.mediaSentCount,
    visionCalls: day.visionCalls, thinkingCalls: day.thinkingCalls, apiCalls: day.apiCalls,
    videoCalls: day.videoCalls, audioCalls: day.audioCalls,
    cachedTokens: day.cachedTokens, promptTokens: day.promptTokens,
    completionTokens: day.completionTokens, totalTokens: day.totalTokens,
    cacheHitRate: day.promptTokens ? Math.min(1, (day.cachedTokens || 0) / day.promptTokens) : 0,
    cacheMissTokens: Math.max(0, (Number(day.promptTokens) || 0) - (Number(day.cachedTokens) || 0))
  };
}

/** 启动时把磁盘上已有的今天内存态载入（跨重启保留今天的累计）。 */
export function initBehaviorStats(storeDir = null) {
  if (storeDir) _injectDir = storeDir;
  const dirR = dataDirResolved();
  const todayKey = localDayKey(Date.now());
  try {
    if (fs.existsSync(dirR)) {
      // 载入今天的持久化累计
      const todayFile = path.join(dirR, 'today.json');
      if (fs.existsSync(todayFile)) {
        const raw = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
        if (raw && raw.dayKey === todayKey) {
          const b = emptyBucket(todayKey);
          // ⚠️ 这份白名单是"启动时把 today.json 读回内存"的唯一入口。
          //    新增计数维度必须同步加进来，否则每次重启当天累计会清零
          //    （emptyBucket 的 0 兜底会让它不报错、也不 NaN，最难查）。
          for (const k of ['sentCount', 'charCount', 'stickerCount', 'imageSentCount', 'mediaSentCount', 'visionCalls', 'thinkingCalls', 'apiCalls', 'videoCalls', 'audioCalls', 'cachedTokens', 'promptTokens', 'completionTokens', 'totalTokens']) b[k] = Number(raw[k]) || 0;
          for (const h of (raw.hours || [])) b.hours.set(Number(h.hour), { ...emptyLocal(), ...h });
          for (const c of (raw.chats || [])) b.chats.set(c.key, { ...emptyLocal(), ...c });
          b.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
          memory.set(todayKey, b);
        } else if (raw?.dayKey) {
          // 昨天跨零点前停掉、今天才启动：today.json 还停在旧日期，
          // 不归档就永远不会再被读到（也不会被下一次落盘改名）。
          const archive = path.join(dirR, `archive-${raw.dayKey}.json`);
          if (!fs.existsSync(archive)) fs.renameSync(todayFile, archive);
        }
      }
    }
  } catch (error) {
    console.warn('[behavior-stats] init 失败：', error?.message ?? error);
  }
}

/** 定期落盘（由 app.js 挂到定时器，额外兜底）。 */
export function flushBehaviorStats() { return persistAll(); }

// ── 测试钩子 ───────────────────────────────────────────────────────────
export function __testBehaviorStats() {
  return { memory, emptyBucket, addCounters, buildStats, initBehaviorStats, dataDirResolved };
}
