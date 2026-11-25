// 记忆任务的 LLM 包装器 + 熔断四道（第 1 期第 4 步）。
//
// ── 为什么不挂在 chatCompletion 上 ────────────────────────────────────────
// chatCompletion 是**主回复**的必经之路。把闸门挂上去 = 记忆的预算问题会让机器人
// 在所有群里不回话。所以闸门只包在 `memLlm()` 里，只有记忆任务走它；
// 主链路一行不改（本文件不 import 也不修改 chatCompletion 的实现，只是调用它）。
//
// ── 四道闸门（§5.2）────────────────────────────────────────────────────
//   ① 单次上限：**调用前预估** > 6 万 token → 拒绝，记 single-call-aborted，不重试
//   ② 任务日配额：按 kind 分桶（`kindQuota`，默认 summary 30 / l1-refine 40）→ 返回 quota，调用方转 pending（延后不丢弃）
//   ③ 日增量：当日 token > 1.4M → 停所有记忆任务，记 budget-exceeded
//   ④ 回填总闸门：**500 次 / 20 元**，任一到达即中止、写 backfill-aborted、不自动续跑
//
// ── 三道闸的分工（第 5 期定案，下一期的人一定会问"为什么回填不受日配额"）──
//   ② ③ 保护的是「日常整理别失控」：日配额防一天烧光、日增量防一次跑爆。
//   回填是**一次性**任务，它有自己的刹车（④ 500 次 / 20 元来自大纲 §5.4.8a），
//   如果也受 ②③ 管，结果不是"慢"，而是**闭环失败**：
//     前 30 次成功 → 之后全被 ② 拒绝 → runConv 写 failed → 回填判据把 failed 捞回来
//     → 再跑再失败 → failed 从 8 涨到几百、钱一直烧。判据自己放大自己的失败。
//   所以：`kind === 'backfill-l4'` 时**跳过 ② 和 ③ 的判定**，① 和 ④ 照常。
//   ★ ③ 的落点是下面的 `state.tokens += totalTokens`（不是 quotaOfKind）——
//     tokens 是全局累加、不带 kind，只改配额函数漏掉这一处，回填仍会把当天实时任务熔断。
//
// ── 两条容易写反的地方 ───────────────────────────────────────────────────
//   1. **道 1 必须调用前预估**。调用完才知道超了 = 钱已经花了。
//   2. **判闸门的代码自己抛异常时必须 fail-open**（放行）。宁可少一道保险，
//      不能让一个 bug 把记忆永久掐死 —— 记忆坏了是"记不住"，全停是"没有记忆"。
//
// ── 为什么 quota 要落盘 ─────────────────────────────────────────────────
// 纯内存计数下，反复重启就能绕过配额。这是最容易被忽略的绕过路径。

import fs from 'node:fs';
import { chatCompletion } from '../llm.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { appendLine, usageFile, quotaFile, writeJsonAtomic } from './paths.js';
import { BACKFILL_KIND, backfillGate, backfillSpend } from './backfill-state.js';

// 中文约 1.5 字符/token（偏保守），再加输出预算。
const CHARS_PER_TOKEN = 1.5;

export const LIMIT_DEFAULTS = Object.freeze({
  quotaPerDay: 30,
  // `candidate-fallback` 是 5b 加的（T6 候选池兜底，大纲 §5.4.8 的 kind 取值表）。
  // 它每次只处理一个人的几条提议，一天最多跑几个人，10 次足够；
  // 独立成桶是为了不让它挤占日常 l1-refine 的 120 次。
  // `l1-profile`（画像压缩）4 槽 × 12 人上限 = 48，留 12 余量 → 60。
  kindQuota: Object.freeze({ summary: 30, 'l1-refine': 40, 'candidate-fallback': 10, 'l1-profile': 60 }),
  tokenBudgetPerDay: 1400000,
  singleCallMaxTokens: 60000
});

// 未登记 kind 的 warn 只在进程内打一次：每轮 tick 都刷一行会把日志淹掉。
const warnedKinds = new Set();

const pad2 = (n) => String(n).padStart(2, '0');
export function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 单次调用的 token 预估（调用**前**就要知道，否则钱已经花了）。 */
export function estimateTokens(messages, maxTokens = 0) {
  const chars = (Array.isArray(messages) ? messages : [])
    .reduce((n, m) => n + String(m?.content ?? '').length, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN) + Math.max(0, Number(maxTokens) || 0);
}

// 内存计数器（进程内）；quotaFile 是它的持久化镜像。
const state = { dayKey: '', counts: Object.create(null), tokens: 0, loadedFor: '' };

function normalize(raw) {
  const pick = (v, d, name) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    logger.warn('mem2', `熔断阈值 ${name} 配置不合理（${JSON.stringify(v)}），已回落默认值 ${d}`);
    return d;
  };
  const kq = { ...LIMIT_DEFAULTS.kindQuota };
  const rawKq = raw?.kindQuota;
  if (rawKq && typeof rawKq === 'object') {
    for (const [k, v] of Object.entries(rawKq)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) kq[k] = n;
      else logger.warn('mem2', `kindQuota.${k} 配置不合理（${JSON.stringify(v)}），已忽略`);
    }
  }
  return {
    quotaPerDay: pick(raw?.quotaPerDay, LIMIT_DEFAULTS.quotaPerDay, 'quotaPerDay'),
    kindQuota: kq,
    tokenBudgetPerDay: pick(raw?.tokenBudgetPerDay, LIMIT_DEFAULTS.tokenBudgetPerDay, 'tokenBudgetPerDay'),
    singleCallMaxTokens: pick(raw?.singleCallMaxTokens, LIMIT_DEFAULTS.singleCallMaxTokens, 'singleCallMaxTokens')
  };
}

function cfgLimits() {
  const c = getConfig()?.memory?.l4 || {};
  return normalize({
    quotaPerDay: c.quotaPerDay,
    kindQuota: c.kindQuota,
    tokenBudgetPerDay: c.tokenBudgetPerDay,
    singleCallMaxTokens: c.singleCallMaxTokens
  });
}

/**
 * 跨天清零 / 首次载入。
 * ★ 必须每轮判闸门前调用（不能依赖重启或定时器）：进程跨天不重启是常态。
 */
function rollDay(dayKey) {
  const file = quotaFile();
  if (state.loadedFor !== file) {
    // 首次，或测试换了 mem2 根目录
    state.dayKey = '';
    state.counts = Object.create(null);
    state.tokens = 0;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.dayKey === dayKey) {
        state.dayKey = dayKey;
        state.counts = { ...(j.counts || {}) };
        state.tokens = Number(j.tokens) || 0;
      }
    } catch { /* 没有/坏了：从零开始 */ }
    state.loadedFor = file;
  }
  if (state.dayKey !== dayKey) {
    state.dayKey = dayKey;
    state.counts = Object.create(null);
    state.tokens = 0;
    saveQuota();
  }
}

function saveQuota() {
  try {
    writeJsonAtomic(quotaFile(), { dayKey: state.dayKey, counts: state.counts, tokens: state.tokens, updatedAt: Date.now() });
  } catch (error) {
    logger.warn('mem2', `quota.json 落盘失败（重启可能绕过配额）：${error?.message ?? error}`);
  }
}

/** 观测 / 人工重置入口（§5.4 要求有，否则只能等次日 0 点）。 */
export function getQuotaState() {
  return { dayKey: state.dayKey, counts: { ...state.counts }, tokens: state.tokens };
}

/** 日 token 预算余量（只读观测）。日扫日志要打印它，否则「压缩被预算挤掉」只能靠猜。 */
export function tokenBudgetSnapshot({ now = Date.now() } = {}) {
  rollDay(dayKeyOf(now));
  const limit = cfgLimits().tokenBudgetPerDay;
  return { tokens: state.tokens, limit, remaining: Math.max(0, limit - state.tokens) };
}

export function resetQuota({ now = Date.now() } = {}) {
  state.dayKey = dayKeyOf(now);
  state.counts = Object.create(null);
  state.tokens = 0;
  saveQuota();
  return getQuotaState();
}

/** 读 quota.json（只读，供 UI / 诊断展示）。注意它是 JSON 不是 jsonl。 */
export function readQuotaFile() {
  try { return JSON.parse(fs.readFileSync(quotaFile(), 'utf8')); } catch { return null; }
}

function deny(kind, code, detail, startedAt, extra = {}) {
  const row = {
    ts: Date.now(), dayKey: state.dayKey, kind, ok: false, code,
    ms: Date.now() - startedAt, ...detail, ...extra
  };
  try { appendLine(usageFile(), row); } catch { /* 记账失败不能反过来影响判定 */ }
  return { ok: false, reason: code, ...detail, ...extra };
}

/**
 * 记忆任务唯一的 LLM 出口。
 *
 * @param {string} kind 任务类型（'summary' | 'l1-refine'；未登记的在 kindQuota 里走兜底配额）
 * @param {object} opts
 * @param {Array}  [opts.messages]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.now]     测试注入
 * @param {Function} [opts.call]  测试注入（默认真调 chatCompletion）
 * @param {object} [opts.cfg]     测试注入（默认读 config.memory.l4，用它可以模拟"配错"）
 * @returns {Promise<{ok:true,result:object,usage:object}|{ok:false,reason:string}>}
 */
export async function memLlm(kind, {
  messages = [], maxTokens = 0, now = Date.now(), call = chatCompletion, cfg = null
} = {}) {
  const startedAt = Date.now();
  const dayKey = dayKeyOf(now);
  let limits = LIMIT_DEFAULTS;
  let gateError = '';

  try {
    rollDay(dayKey);
    limits = normalize(cfg || cfgLimits());
    // 未在 kindQuota 登记的 kind 会静默获得一个 quotaPerDay 的新桶。
    // 拼错一次（如 'l1refine'）就绕过道 2 —— 这里 warn 一次，不改变放行行为。
    // 回填是**故意**不登记的（它走道 4，不走日配额），别对它刷这条警告。
    if (limits.kindQuota && kind !== BACKFILL_KIND
        && !(kind in limits.kindQuota) && !warnedKinds.has(kind)) {
      warnedKinds.add(kind);
      logger.warn('mem2', `熔断：kind「${kind}」未在 kindQuota 登记，使用兜底配额 ${limits.quotaPerDay}/天`);
    }
    // ① 单次上限（调用前预估）
    const est = estimateTokens(messages, maxTokens);
    if (est > limits.singleCallMaxTokens) {
      return deny(kind, 'single-call-aborted', { estimatedTokens: est, limit: limits.singleCallMaxTokens }, startedAt);
    }
    // ② 任务日配额（按 kind 分桶：l1-refine 与 summary 各算各的，互不挤占）
    //    ★ 回填跳过：它没有日配额，只受 ④ 的 500 次/20 元管（见文件头"三道闸的分工"）。
    if (kind !== BACKFILL_KIND) {
      const quotaOfKind = (limits.kindQuota && limits.kindQuota[kind]) ?? limits.quotaPerDay;
      if ((state.counts[kind] || 0) >= quotaOfKind) {
        return deny(kind, 'quota', { usedToday: state.counts[kind] || 0, limit: quotaOfKind }, startedAt);
      }
    }
    // ③ 日增量
    //    ★ 回填既不计入分子（见下面的 state.tokens 累加处），也不受它拦 ——
    //      "只受 ④ 约束"是 §3.3 的原话，何况一天的实时任务打满后再拦回填，
    //      只会把回填制造的那批 failed 推给下一轮重跑。
    if (kind !== BACKFILL_KIND && state.tokens >= limits.tokenBudgetPerDay) {
      return deny(kind, 'budget-exceeded', { tokensToday: state.tokens, limit: limits.tokenBudgetPerDay }, startedAt);
    }
    // ④ 回填总闸门（500 次 / 20 元）：只对回填生效，允许时顺手记一次调用。
    if (kind === BACKFILL_KIND) {
      const gate = backfillGate();
      if (!gate.ok) {
        return deny(kind, 'backfill-aborted', {
          reason: gate.reason, calls: gate.calls, cost: Math.round(gate.cost * 100) / 100
        }, startedAt);
      }
    }
  } catch (error) {
    // ★ fail-open：判闸门自己炸了也要放行。记忆坏了是"记不住"，全停是"没有记忆"。
    gateError = String(error?.message || error);
    limits = LIMIT_DEFAULTS;
    logger.warn('mem2', `熔断判定异常，放行本次调用（fail-open）：${gateError}`);
  }

  let result = null;
  try {
    result = await call({ messages, tools: null, toolChoice: 'none', temperature: 0.3, maxTokens });
  } catch (error) {
    try {
      appendLine(usageFile(), {
        ts: Date.now(), dayKey, kind, ok: false, code: 'call-error',
        error: String(error?.message || error).slice(0, 300), ms: Date.now() - startedAt
      });
    } catch { /* ignore */ }
    return { ok: false, reason: 'call-error', error };
  }

  const usage = result?.usage || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || (promptTokens + completionTokens);

  // ④ 更新计数器（成功才算配额；失败已经在上面记过账了）
  //    ★ 回填**不进 ③ 的分子**（落点就是这一行，不是 quotaOfKind）：
  //      1.6M token 一次性回填会把 tokenBudgetPerDay(1.4M) 直接顶穿，当天实时任务全停。
  //      counts 仍单独记一个 backfill-l4 桶（只作观测，② 已跳过，不影响任何判定）。
  state.counts[kind] = (state.counts[kind] || 0) + 1;
  if (kind !== BACKFILL_KIND) state.tokens += totalTokens;
  saveQuota();
  if (kind === BACKFILL_KIND) {
    backfillSpend({ promptTokens, completionTokens, model: result?.model || '' });
  }

  try {
    appendLine(usageFile(), {
      ts: Date.now(), dayKey, kind, ok: true,
      promptTokens, completionTokens, totalTokens,
      ms: Date.now() - startedAt, model: result?.model || '',
      ...(gateError ? { gateError } : {})
    });
  } catch { /* ignore */ }

  return { ok: true, result, usage: { promptTokens, completionTokens, totalTokens } };
}

