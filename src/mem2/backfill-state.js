// 第 5 期 · 回填的 run 状态与道 4 总闸门（500 次 / 20 元）。
//
// ── 为什么单独一个模块 ─────────────────────────────────────────────────
// `llm.js` 是记忆任务的唯一出口，它必须能在**调用前**判「还能不能跑」。
// 这个判定需要读 run 状态（计数 + 是否已中止），而 run 状态的写方是回填脚本。
// 放在 llm.js 里会让「调度」和「闸门」纠缠在一起；放在脚本里则 llm.js 读不到。
//
// ── 三个数存在同一个文件里，不是巧合 ───────────────────────────────────
//   calls / cost   → 道 4 的两条上限（任一到达即中止）
//   done{}         → 断点续跑（中断后跳过已完成）
//   attempts{}     → 每会话最多 2 次（防失败自我放大，见 §3.2）
// 拆成三个文件必然出现「计数说跑了 200、断点清单说 120」这种对不上的状态。
//
// ── 中止后不许自动续跑 ─────────────────────────────────────────────────
// 到限只是把 `aborted` 写进 run 文件；要不要继续是**人**的决定。
// 自动续跑会让「500 次上限」变成「每 5 分钟 500 次」，这是大纲道 4 明确禁止的。

import fs from 'node:fs';
import { getConfig } from '../config.js';
import { resolveModelPrice, priceAt } from '../model-prices.js';
import { logger } from '../logger.js';
import { backfillFile, totalsFile, writeJsonAtomic } from './paths.js';

/** 回填专用的 kind（`summarize.js` 两处 llm 调用都会收到它）。 */
export const BACKFILL_KIND = 'backfill-l4';

/**
 * 道 4：任一到达即中止。成本线来自大纲 §5.4.8a，不许改。
 *
 * ★ 次数线 500 → **600**（第 5 期补丁 v1.5 裁决）：
 *   500 是按「434 次」估的，而 434 只算了切片、**漏了合并调用**；
 *   实测口径是「切片 438 + 合并 52 = 490」，加补跑（10%~15%）= 539~564，
 *   500 不是"有点紧"而是**必超**。提 600 后「一次跑完含补跑」成立，
 *   而成本侧仍是 490 次 ≈ 1.8M token ≈ ¥4，离 20 元线差一个数量级。
 */
export const BACKFILL_LIMITS = Object.freeze({ maxCalls: 600, maxCost: 20 });

/** 同一会话最多回填几次（第 1 次 + 1 次补跑）。见施工单 §3.2。 */
export const MAX_ATTEMPTS_PER_CONV = 2;

/** 会话主键：群 + 会话起点，与 coverage 的主键口径一致。 */
export function convKey(chatKey, convStartTs) {
  return `${String(chatKey)}@${Number(convStartTs) || 0}`;
}

/** 进程内活动 run（由脚本 openRun 设置；应用进程里恒为 null）。 */
let active = null;

/**
 * 跨 run 的累计计数（`mem2/backfill/_totals.json`）。
 *
 * ── 为什么不能只靠 active.calls ────────────────────────────────────────
 * 那是 per-run 的：换个 runId 就归零，道 4 的「一次性大批量失控要拦」就变成
 * 「每次换 id 都能再跑 600 次」—— 刹车变成装饰。
 *
 * ── 初始值定案：0（不是 600）──────────────────────────────────────────
 * 之前那 600 次是**修 self-leak 判据之前**烧掉的（¥2.76，已如实记在 usage.jsonl）。
 * 道 4 是刹车，不是账本：账本在 usage.jsonl，一分不少都在。若把 600 记进来，
 * 新 run 一次都跑不了（600-600=0），等于把「修完判据再补跑」这条路锁死。
 * 所以：**真实的钱照实记账，刹车额度按新的开始算**，两边不混。
 */
let totals = null;

function totalsNow() {
  if (!totals) {
    try {
      const j = JSON.parse(fs.readFileSync(totalsFile(), 'utf8'));
      totals = {
        totalCalls: Number(j?.totalCalls) || 0,
        totalCost: Number(j?.totalCost) || 0,
        updatedAt: Number(j?.updatedAt) || 0
      };
    } catch {
      totals = { totalCalls: 0, totalCost: 0, updatedAt: 0 };
    }
  }
  return totals;
}

function saveTotals() {
  if (!totals) return;
  totals.updatedAt = Date.now();
  try { writeJsonAtomic(totalsFile(), totals); } catch (error) {
    logger.warn('mem2', `回填累计计数落盘失败（道 4 余量会失真）：${error?.message ?? error}`);
  }
}

/** 只读快照（UI / 回报用）。 */
export function readTotals() {
  const t = totalsNow();
  return { totalCalls: t.totalCalls, totalCost: t.totalCost, updatedAt: t.updatedAt };
}

/** 人工清零（`--reset-totals` 专用；没有任何自动路径会调它）。 */
export function resetTotals() {
  totals = { totalCalls: 0, totalCost: 0, updatedAt: Date.now() };
  saveTotals();
  return readTotals();
}

function blank(runId, now) {
  return {
    runId,
    startedAt: now,
    updatedAt: now,
    calls: 0,
    tokens: 0,
    cost: 0,
    costUnknownCalls: 0,
    aborted: false,
    abortReason: '',
    finishedAt: 0,
    done: {},
    attempts: {}
  };
}

function persist() {
  if (!active) return;
  active.updatedAt = Date.now();
  try {
    writeJsonAtomic(backfillFile(active.runId), active);
  } catch (error) {
    // 落盘失败不影响本次调用，但会让断点/计数失真 —— 必须喊出来。
    logger.warn('mem2', `回填 run 状态落盘失败（断点与计数会失真）：${error?.message ?? error}`);
  }
}

/**
 * 打开（或从断点续上）一个 run。
 * @param {string} runId
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {boolean} [opts.resume=true] 已有 run 文件时是否续上（false = 报错，防手滑重跑）
 */
export function openRun(runId, { now = Date.now(), resume = true } = {}) {
  const id = String(runId || '').trim();
  if (!id) throw new Error('openRun: runId 必填');
  const file = backfillFile(id);
  let run = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && j.runId === id) run = j;
  } catch { /* 没有就是新建 */ }

  if (run && !resume) {
    throw new Error(`run ${id} 已存在（calls=${run.calls} aborted=${run.aborted}），要续跑请加 --resume，要重来请换一个 runId`);
  }
  if (!run) run = blank(id, now);
  // 缺字段的老文件补全（回填中途升级代码不能炸）
  for (const [k, v] of Object.entries(blank(id, now))) {
    if (run[k] === undefined) run[k] = v;
  }
  if (!run.done || typeof run.done !== 'object') run.done = {};
  if (!run.attempts || typeof run.attempts !== 'object') run.attempts = {};
  active = run;
  totalsNow();                 // 道 4 的余量按跨 run 累计算，开跑前先加载
  persist();
  return active;
}

export function currentRun() {
  return active;
}

/** 只读：读一份 run 文件（供 --dry 报「已用满重试」而不产生任何写入）。 */
export function readRun(runId) {
  try {
    const j = JSON.parse(fs.readFileSync(backfillFile(runId), 'utf8'));
    return (j && typeof j === 'object') ? j : null;
  } catch { return null; }
}

export function closeRun({ finished = true } = {}) {
  if (!active) return null;
  if (finished) active.finishedAt = Date.now();
  persist();
  const snapshot = active;
  active = null;
  return snapshot;
}

/** 已完成（拿到终态）的会话集合。 */
export function doneSet() {
  return new Set(Object.keys(active?.done || {}));
}

export function markDone(chatKey, convStartTs, state) {
  if (!active) return;
  active.done[convKey(chatKey, convStartTs)] = { state: String(state || ''), at: Date.now() };
  persist();
}

export function attemptsOf(chatKey, convStartTs) {
  return Number(active?.attempts?.[convKey(chatKey, convStartTs)]) || 0;
}

export function bumpAttempt(chatKey, convStartTs) {
  if (!active) return 0;
  const k = convKey(chatKey, convStartTs);
  const n = (Number(active.attempts[k]) || 0) + 1;
  active.attempts[k] = n;
  persist();
  return n;
}

/** 已用满重试、被放弃的会话（--dry 要单独打印，见 §3.2）。 */
export function abandonedList() {
  const run = active;
  if (!run) return [];
  return Object.entries(run.attempts)
    .filter(([, n]) => Number(n) >= MAX_ATTEMPTS_PER_CONV)
    .map(([key, n]) => ({ key, attempts: Number(n) || 0, state: run.done[key]?.state || 'unknown' }));
}

/**
 * 单次调用的成本（元）。价格表查不到就记 0 并计数 —— **不编一个假价格**：
 * 编了会让「20 元上限」变成假保护，不如让 costUnknownCalls 显式增长。
 */
function costOf({ promptTokens = 0, completionTokens = 0, model = '' } = {}) {
  try {
    const cfg = getConfig();
    const p = resolveModelPrice(String(model || cfg?.api?.model || ''), cfg);
    const tier = p?.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, Date.now()) : p;
    const inRate = Number(tier?.in) || 0;
    const outRate = Number(tier?.out) || 0;
    if (!inRate && !outRate) return { cost: 0, known: false };
    return {
      cost: (Number(promptTokens) || 0) / 1_000_000 * inRate
        + (Number(completionTokens) || 0) / 1_000_000 * outRate,
      known: true
    };
  } catch {
    return { cost: 0, known: false };
  }
}

/** 中止并把原因写进 run（不自动续跑，要人再下命令）。 */
function abort(reason, detail = {}) {
  if (!active) return;
  if (!active.aborted) {
    active.aborted = true;
    active.abortReason = reason;
    active.finishedAt = Date.now();
    logger.error('mem2', `回填已中止（${reason}）：calls=${active.calls}`
      + ` cost=${active.cost.toFixed(2)}元 ${detail.note || ''}`);
  }
  persist();
}

/**
 * 道 4 —— 调用**前**判。允许时顺手 +1（上限要在第 501 次之前拦住，不能事后补）。
 *
 * @returns {{ok:true, calls:number, cost:number}|{ok:false, reason:string, calls:number, cost:number}}
 */
export function backfillGate() {
  if (!active) {
    // 应用进程里永远没有 active run：fail-open（正常 tick 不该被回填闸门误伤）。
    return { ok: true, calls: 0, cost: 0, noRun: true };
  }
  const t = totalsNow();
  if (active.aborted) {
    return { ok: false, reason: `已中止：${active.abortReason || 'unknown'}`, calls: t.totalCalls, cost: t.totalCost };
  }
  // ★ 判的是**跨 run 累计**（t.totalCalls），不是 active.calls —— 否则换个 runId 就绕过
  if (t.totalCalls >= BACKFILL_LIMITS.maxCalls) {
    abort('calls', { note: `（累计上限 ${BACKFILL_LIMITS.maxCalls} 次）` });
    return { ok: false, reason: 'calls', calls: t.totalCalls, cost: t.totalCost };
  }
  if (t.totalCost >= BACKFILL_LIMITS.maxCost) {
    abort('cost', { note: `（累计上限 ${BACKFILL_LIMITS.maxCost} 元）` });
    return { ok: false, reason: 'cost', calls: t.totalCalls, cost: t.totalCost };
  }
  active.calls += 1;
  t.totalCalls += 1;
  saveTotals();
  persist();
  return { ok: true, calls: t.totalCalls, cost: t.totalCost };
}

/**
 * 调用**后**记账（成本要等 usage 回来才知道）。
 * 到限只标记中止；本次调用已经发生，钱已经花了，如实在账上。
 */
export function backfillSpend({ promptTokens = 0, completionTokens = 0, model = '' } = {}) {
  if (!active) return { aborted: false };
  const { cost, known } = costOf({ promptTokens, completionTokens, model });
  active.tokens += (Number(promptTokens) || 0) + (Number(completionTokens) || 0);
  active.cost += cost;
  if (!known) active.costUnknownCalls += 1;
  const t = totalsNow();
  t.totalCost += cost;
  if (t.totalCost >= BACKFILL_LIMITS.maxCost) {
    saveTotals();
    abort('cost', { note: `（累计上限 ${BACKFILL_LIMITS.maxCost} 元）` });
  } else {
    saveTotals();
    persist();
  }
  return { aborted: active.aborted, calls: active.calls, cost: active.cost };
}

/** 观测用：当前余量（UI / --dry / 结束后打印）。**按跨 run 累计算。** */
export function gateRemain() {
  const t = totalsNow();
  return {
    callsLeft: Math.max(0, BACKFILL_LIMITS.maxCalls - t.totalCalls),
    costLeft: Math.max(0, BACKFILL_LIMITS.maxCost - t.totalCost),
    usedCalls: t.totalCalls,
    usedCost: t.totalCost,
    aborted: Boolean(active?.aborted),
    abortReason: active?.abortReason || ''
  };
}

/** 测试专用：清空进程内活动 run 与累计缓存（不动磁盘）。 */
export function __resetForTest() {
  active = null;
  totals = null;
}
