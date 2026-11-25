#!/usr/bin/env node
// 第 5 期 · 历史回填（L4 摘要）
//
//   node scripts/backfill.mjs            默认 --dry：只统计，零调用、零写盘
//   node scripts/backfill.mjs --apply    真跑（要人先看过 --dry 的五个数）
//
// ── 只做三件事 ─────────────────────────────────────────────────────────
//   ① 找候选会话（复用 splitConvs，与实时链路同一套切分）
//   ② 跳过已完成（幂等判据 + 断点清单 + 每会话 2 次上限）
//   ③ 调 runConv（**唯一**的摘要入口：T3 门禁、切片、coverage、四道闸门都在里面）
//
// ── 刻意不做的事（做了就是重写第二套摘要流程）────────────────────────
//   · 不自己拼提示词、不自己切片、不自己写 coverage/l4
//   · 不用 `endTs < switchTs` 筛边界 —— 那会重跑 11-13 之后 116 个已覆盖会话，
//     白烧 116 次调用，还会把 short 覆写成别的状态
//   · 不自动触发：跑不跑是人看完成本后的决定

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatStore } from '../src/store.js';
import { splitConvs, GAP_MS, t3Blocked } from '../src/mem2/conv.js';
import { splitSlices, MAX_MSGS_PER_SLICE } from '../src/mem2/summarize.js';
import * as memStore from '../src/mem2/store.js';
import { runConv } from '../src/mem2/index.js';
import { getSwitchTs } from '../src/mem2/switch.js';
import {
  BACKFILL_KIND, BACKFILL_LIMITS, MAX_ATTEMPTS_PER_CONV,
  openRun, closeRun, doneSet, attemptsOf, bumpAttempt, markDone,
  abandonedList, gateRemain, currentRun, readRun, readTotals, resetTotals
} from '../src/mem2/backfill-state.js';

/** 并发 3、单个间隔 ≥300ms（施工单 §3.4）。 */
export const CONCURRENCY = 3;
export const MIN_GAP_MS = 300;

const pad2 = (n) => String(n).padStart(2, '0');
export function stamp(ts) {
  const d = new Date(Number(ts) || 0);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 一次会花几次调用：切片数 + 合并片（>1 片时多一次）。 */
export function callsOf(msgs) {
  const slices = splitSlices(msgs, MAX_MSGS_PER_SLICE).length;
  const merges = slices > 1 ? 1 : 0;
  return { slices, merges, calls: slices + merges };
}

/**
 * 找出这次要回填的会话。**纯读**：不改任何文件、不调 LLM。
 *
 * 判据（施工单 §3.2，写死，别自己发明）：
 *   !row                 → 回填
 *   row.state === 'failed' → 回填（每会话最多 2 次）
 *   其他（ok / short / pending） → 跳过
 *
 * ── 找 row 用两级（补丁 v1.5）──────────────────────────────────────────
 *   ① 先按 `convStartTs` 精确等值（对齐的情况，占 63%）
 *   ② 找不到再按 `convEndTs` 落区间定位（`findCoverageByEnd`，稳得多）
 * 只加 ①→② 的后备，不改变对齐样本的行为。
 *
 * ── 命中 failed 的漂移会话要**对齐 startTs**（这是补丁里最要紧的一步）──
 * 若按 endTs 找到的失败行，它的 `convStartTs` 与本次切出来的不同，就用**它的**
 * startTs 去跑。这样回填写出的 ok 行和旧 failed 行是**同一个主键**，last-wins 当场
 * 把 failed 覆盖掉 —— 不用再补一行"对账标记"，也不会留下一个没有 L4 的死 key。
 * 反过来（用新 startTs 写 ok）就会出现两个 key 各站一半，`findConvRow` 还会优先
 * 命中更早的那个死 key（于是摘要头永远挂不上）。
 *
 * 另外两条排除都有理由：
 *   · 群友 <10 条的会话**根本不进候选**：它连 LLM 都不会调，补一条 short 行
 *     只会把覆盖率的分母撑大（116 → 300+），把「≥75%」这条线变成假失败。
 *   · 已用满 2 次尝试的会话跳过，并列进「已放弃」清单。
 *
 * @returns {{items:Array, stats:object}}
 */
export function planBackfill({
  store, mem = memStore, now = Date.now(),
  done = new Set(), attemptsOf: attemptsFn = () => 0, maxCalls = 0
} = {}) {
  const chats = typeof store?.listChats === 'function' ? store.listChats() : [];
  const stats = {
    chats: 0, convs: 0, candidates: 0, alreadyDone: 0, skipped: 0, shortSkipped: 0,
    abandoned: 0, failedNow: 0, aligned: 0,
    sliceCalls: 0, mergeCalls: 0, calls: 0, callsCapped: false
  };
  const items = [];

  for (const chatKey of chats) {
    stats.chats += 1;
    const msgs = store.rangeByTs(chatKey, { fromTs: 0, toTs: now, includeSelf: true, visibleOnly: true });
    if (!msgs.length) continue;
    const { closed } = splitConvs(msgs, { nowTs: now, gapMs: GAP_MS });
    const cov = mem.readCoverage(chatKey);

    for (const conv of closed) {
      stats.convs += 1;
      const row = cov.byStart.get(conv.startTs) || memStore.findCoverageByEnd(cov, conv.endTs);

      if (row && row.state !== 'failed') { stats.skipped += 1; continue; }
      if (row && row.state === 'failed') stats.failedNow += 1;

      if (!row && t3Blocked(conv)) { stats.shortSkipped += 1; continue; }

      // 漂移对齐：失败行的 startTs 与本次切出来的不同 → 用失败行的（保持主键唯一）
      const aligned = Boolean(row && row.state === 'failed' && Number(row.convStartTs) !== Number(conv.startTs));
      const runStartTs = aligned ? Number(row.convStartTs) : conv.startTs;
      const key = `${chatKey}@${runStartTs}`;

      if (attemptsFn(chatKey, runStartTs) >= MAX_ATTEMPTS_PER_CONV) { stats.abandoned += 1; continue; }
      if (done.has(key)) { stats.alreadyDone += 1; continue; }

      const { slices, merges, calls } = callsOf(conv.messages || []);
      if (maxCalls && stats.calls + calls > maxCalls) { stats.callsCapped = true; break; }

      stats.candidates += 1;
      stats.aligned += aligned ? 1 : 0;
      stats.sliceCalls += slices;
      stats.mergeCalls += merges;
      stats.calls += calls;
      items.push({
        key, chatKey, convStartTs: runStartTs, convEndTs: conv.endTs,
        msgCount: conv.msgCount, humanMsgCount: conv.humanMsgCount,
        prevState: row ? row.state : '', aligned, slices, merges, calls,
        conv: aligned ? { ...conv, startTs: runStartTs } : conv
      });
    }
    if (stats.callsCapped) break;
  }
  return { items, stats };
}

/** 失败率两档补跑预估（10% / 15%），用来对照道 4 的余量。 */
export function retryForecast(calls) {
  return {
    p10: Math.ceil(calls * 0.10),
    p15: Math.ceil(calls * 0.15),
    cap10: calls + Math.ceil(calls * 0.10),
    cap15: calls + Math.ceil(calls * 0.15)
  };
}

/**
 * 哪些失败值得补跑（补丁 v1.6 §二）。
 *
 * 确定性失败（self-leak / phantom-silence / parse-failed / empty-content）**同一输入
 * 必同判**，重跑一万次还是失败 —— 实测补跑 79 个 self-leak 只换回 12 个 ok（15%），
 * 却花 131 次调用、把 600 的上限吃光，还连累 2 个会话停在 failed:calls。
 * 这些只能靠「改判据 / 改提示词」变好，不靠重跑。
 *
 * 可重试的是「换个时间/换次抽风就可能成功」的那几类。
 * ★ `backfill-aborted` 必须在里面：它是**被闸门截断**，不是真失败，下一 run 要能续上。
 */
export const RETRYABLE_CODES = Object.freeze([
  'call-error', 'quota', 'budget-exceeded', 'single-call-aborted', 'no-store',
  'backfill-aborted',
  // 历史遗留写法：deny() 早期把 gateReason 写进了 reason，落盘成 'calls'/'已中止：…'
  'calls', 'cost'
]);

export function isRetryable(code) {
  const c = String(code || '');
  if (RETRYABLE_CODES.includes(c)) return true;
  return c.startsWith('已中止');
}

/**
 * 从第一轮的失败里挑出该补跑的。
 * @returns {{retry:Array, deterministic:number}}
 */
export function pickRetryable(failures = [], attemptsFn = () => 0) {
  const retry = [];
  let deterministic = 0;
  for (const f of failures) {
    if (!isRetryable(f.code)) { deterministic += 1; continue; }
    if (attemptsFn(f.chatKey, f.convStartTs) >= MAX_ATTEMPTS_PER_CONV) { deterministic += 1; continue; }
    retry.push(f);
  }
  return { retry, deterministic };
}

/** 从一份 run 快照里算「已用满重试的会话」（--dry 用；不依赖进程内活动 run）。 */
export function abandonedOf(run) {
  const attempts = run?.attempts || {};
  const done = run?.done || {};
  return Object.entries(attempts)
    .filter(([, n]) => Number(n) >= MAX_ATTEMPTS_PER_CONV)
    .map(([key, n]) => ({ key, attempts: Number(n) || 0, state: done[key]?.state || 'unknown' }));
}

/**
 * failed 对账（补丁 v1.5 §2.3）：把「已经被覆盖、但 key 漂移没清掉」的 failed 行收掉。
 *
 * 大部分漂移会话在 planBackfill 里就靠**对齐 startTs** 解决了（新 ok 行与旧 failed 行
 * 同一主键，last-wins 当场覆盖）。这里兜的是剩下那批：endTs 也漂了、两级都匹配不上、
 * 于是新 ok 行落在**新 key** 上，旧 failed 行留在原地。
 *
 * 判据是**包含关系**（不是容差）：oldFailed 的 [start,end] 完全落在某条 ok/short 行的
 * 区间内 → 这段时间确实已经记下了，旧行是死数据。没有魔法数，可解释。
 *
 * 收掉的写法：append 一行同 convStartTs 的 `{...row, state:'ok', resolvedByBackfill}`。
 * 为什么不是 `state:'superseded'`：`queryState` 只认 ok/pending/failed/short，别的值会
 * 掉到 `empty` —— 那等于告诉模型「这段时间没人说话」，是撒谎；而这行确实已被覆盖。
 */
export function reconcileFailed({ store, runId = '', now = Date.now(), log = () => {} } = {}) {
  const out = { checked: 0, resolved: 0, remaining: 0, remainingDetail: [] };
  for (const chatKey of store.listChats()) {
    const cov = memStore.readCoverage(chatKey);
    const covered = cov.list.filter((r) => r.state === 'ok' || r.state === 'short');
    const failed = cov.list.filter((r) => r.state === 'failed');
    for (const row of failed) {
      out.checked += 1;
      const holder = covered.find((r) => r !== row
        && Number(r.convStartTs) <= Number(row.convStartTs)
        && Number(r.convEndTs) >= Number(row.convEndTs));
      if (!holder) {
        out.remaining += 1;
        out.remainingDetail.push({ chatKey, convStartTs: row.convStartTs, convEndTs: row.convEndTs });
        continue;
      }
      memStore.appendCoverage(chatKey, {
        ...row, state: 'ok', resolvedByBackfill: runId || null, mergedInto: holder.convStartTs, updatedAt: now
      });
      out.resolved += 1;
      log(`[backfill] 对账：${chatKey} failed@${stamp(row.convStartTs)} 已被 ${stamp(holder.convStartTs)} 覆盖 → 收掉`);
    }
  }
  return out;
}

export function printDry({ items, stats }, { abandoned = [] } = {}) {
  const f = retryForecast(stats.calls);
  const tot = readTotals();
  const leftCalls = Math.max(0, BACKFILL_LIMITS.maxCalls - tot.totalCalls);
  const leftCost = Math.max(0, BACKFILL_LIMITS.maxCost - tot.totalCost);
  const line = (k, v) => console.log(`  ${k.padEnd(24, ' ')} ${v}`);
  console.log('');
  console.log('── 回填预算（--dry，零调用零写盘）──');
  line('① 候选会话数', `${stats.candidates}`);
  line('② 预期调用数', `${stats.calls}   ＝ 切片 ${stats.sliceCalls} + 合并 ${stats.mergeCalls}`);
  line('   ③ 上限（含补跑）', `${f.cap10}（失败率 10%） / ${f.cap15}（失败率 15%）`);
  line('   道 4 余量', `${leftCalls} 次 / ${leftCost.toFixed(2)} 元`
    + `（累计已用 ${tot.totalCalls} 次 / ${tot.totalCost.toFixed(2)} 元）`
    + `${f.cap15 > leftCalls ? '  ★ 会超，先看这行' : '（在限内）'}`);
  line('④ 当前 failed 会话', `${stats.failedNow}（按 endTs 定位后的真实值）`);
  line('⑤ 已用满重试（放弃）', `${abandoned.length}`);
  if (stats.aligned) line('   其中 startTs 漂移对齐', `${stats.aligned}（用旧 key 记账，failed 才清得掉）`);
  console.log('');
  console.log('── 分布 ──');
  line('总会话（切分后）', `${stats.convs}  / ${stats.chats} 群`);
  line('跳过（ok/short/pending）', `${stats.skipped}`);
  line('跳过（群友<10，不补记）', `${stats.shortSkipped}`);
  line('断点已完成', `${stats.alreadyDone}`);
  line('多片会话（要合并调用）', `${stats.mergeCalls}`);
  if (stats.callsCapped) line('★ 被 --limit 截断', '是（只统计到上限为止）');
  if (abandoned.length) {
    console.log('  已放弃的会话：');
    for (const a of abandoned.slice(0, 10)) console.log(`    ${a.key}  attempts=${a.attempts} state=${a.state}`);
    if (abandoned.length > 10) console.log(`    …还有 ${abandoned.length - 10} 个`);
  }
  const byChat = new Map();
  for (const it of items) {
    const k = it.chatKey;
    const cur = byChat.get(k) || { n: 0, calls: 0 };
    cur.n += 1; cur.calls += it.calls;
    byChat.set(k, cur);
  }
  if (byChat.size) {
    console.log('');
    console.log('── 按群 ──');
    for (const [k, v] of byChat) line(k, `${v.n} 会话 / ${v.calls} 次`);
  }
  console.log('');
  console.log(stats.candidates === 0
    ? '没有需要回填的会话：所有会话都是 ok/short 终态。'
    : `真跑：node scripts/backfill.mjs --apply   （预计 ${stats.calls} 次调用 ≈ ¥2~4，25 分钟上下）`);
  console.log('');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apply(items, { store, log, now = Date.now }) {
  let doneCount = 0;
  let okCount = 0;
  let shortCount = 0;
  let failCount = 0;
  let abortedCalls = 0;
  const failures = [];

  const runOne = async (it) => {
    // 道 4 中止后立刻停：这不是重试能解决的，继续跑只会把 500 次上限当摆设。
    if (gateRemain().aborted) { abortedCalls += 1; return; }
    bumpAttempt(it.chatKey, it.convStartTs);
    try {
      const r = await runConv({
        chatKey: it.chatKey,
        convLike: it.conv,
        store,
        kind: BACKFILL_KIND,
        now: now(),
        log
      });
      if (r?.ok && r.code === 'ok') {
        okCount += 1;
        markDone(it.chatKey, it.convStartTs, 'ok');
      } else if (r?.ok && r.code === 'short') {
        shortCount += 1;
        markDone(it.chatKey, it.convStartTs, 'short');
      } else {
        failCount += 1;
        failures.push({ ...it, code: r?.code || 'unknown' });
      }
    } catch (error) {
      failCount += 1;
      failures.push({ ...it, code: `throw:${error?.message ?? error}` });
    } finally {
      doneCount += 1;
      if (doneCount % 20 === 0 || doneCount === items.length) {
        const g = gateRemain();
        log(`[backfill] ${doneCount}/${items.length} ok=${okCount} short=${shortCount} fail=${failCount}`
          + ` calls=${currentRun()?.calls ?? 0} cost=${(currentRun()?.cost ?? 0).toFixed(2)}元`
          + ` 余量=${g.callsLeft}次/${g.costLeft.toFixed(2)}元`);
      }
    }
  };

  // 并发 3、启动间隔 ≥300ms（单个请求本身 ~8s，实际不会堆积）
  const queue = [...items];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      if (gateRemain().aborted) break;
      const it = queue.shift();
      if (!it) break;
      await runOne(it);
      await sleep(MIN_GAP_MS);
    }
  });
  await Promise.all(workers);
  return { okCount, shortCount, failCount, failures, abortedCalls };
}

async function main(argv) {
  const applyMode = argv.includes('--apply');
  const resume = argv.includes('--resume');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const maxCalls = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 0) : 0;
  const log = (msg) => console.log(msg);
  const store = new ChatStore(0);          // 0 = 不限，回填要看全量历史

  // 道 4 的累计计数清零。**只走显式参数**，没有任何自动路径会调它 ——
  // 它是「我知道自己在重新开始」的声明，不是补救手段。
  if (argv.includes('--reset-totals')) {
    const before = readTotals();
    const after = resetTotals();
    console.log(`[backfill] 累计计数已清零：${before.totalCalls} 次 / ${before.totalCost.toFixed(2)} 元 → `
      + `${after.totalCalls} 次 / ${after.totalCost.toFixed(2)} 元（道 4 余量 ${BACKFILL_LIMITS.maxCalls} 次）`);
    return 0;
  }

  const switchTs = getSwitchTs();
  console.log(`[backfill] switchTs=${switchTs || '未设置'}`
    + `${switchTs ? `（${stamp(switchTs)} 硬切）` : '（未设置硬切标记）'}`);

  const runId = (argv.find((a) => a.startsWith('--run-id='))?.split('=')[1])
    || `bf-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;

  if (!applyMode) {
    // --dry 要报「已用满重试」和真实断点，所以读一下已有 run 文件（**只读**，不 openRun）。
    const prev = readRun(runId);
    const prevAttempts = prev?.attempts || {};
    const done = new Set(Object.keys(prev?.done || {}));
    const plan = planBackfill({
      store, now: Date.now(), maxCalls, done,
      attemptsOf: (k, ts) => Number(prevAttempts[`${k}@${Number(ts) || 0}`]) || 0
    });
    printDry(plan, { abandoned: abandonedOf(prev) });
    return 0;
  }

  const run = openRun(runId, { resume });
  if (run.aborted) {
    console.error(`[backfill] run ${runId} 已中止（${run.abortReason}），不自动续跑。`
      + '确认要继续请换一个 runId，或人工处理后再跑。');
    return 2;
  }
  console.log(`[backfill] run=${runId} 续跑：已完成 ${Object.keys(run.done).length}，`
    + `已用 ${run.calls} 次 / ${run.cost.toFixed(2)} 元`);

  const abandoned = abandonedList();
  let plan = planBackfill({
    store, now: Date.now(), maxCalls,
    done: doneSet(), attemptsOf: (k, ts) => attemptsOf(k, ts)
  });
  console.log(`[backfill] 候选 ${plan.stats.candidates} 会话 / ${plan.stats.calls} 次调用`
    + `（跳过 ${plan.stats.skipped}，断点 ${plan.stats.alreadyDone}，放弃 ${abandoned.length}）`);

  const first = await apply(plan.items, { store, log });
  console.log(`[backfill] 第一轮：ok=${first.okCount} short=${first.shortCount} fail=${first.failCount}`);

  // 失败只补跑「可能成功的」那几类（补丁 v1.6 §二）——确定性失败重跑是净亏
  const { retry, deterministic } = pickRetryable(first.failures, attemptsOf);
  if (deterministic) {
    console.log(`[backfill] 确定性失败 ${deterministic} 个（self-leak/parse 等）不补跑，`
      + '留给判据修正后的下一 run');
  }
  if (retry.length) {
    console.log(`[backfill] 补跑一轮：${retry.length} 个（可重试类）`);
    const second = await apply(retry, { store, log });
    console.log(`[backfill] 补跑：ok=${second.okCount} short=${second.shortCount} fail=${second.failCount}`);
  } else if (first.failures.length) {
    console.log('[backfill] 本轮失败全部是确定性失败，不补跑（重跑同一个输入必然同判）');
  }

  const snap = closeRun();
  const g = { calls: snap.calls, cost: snap.cost, callsLeft: Math.max(0, BACKFILL_LIMITS.maxCalls - snap.calls) };
  console.log('');
  console.log('── 结果 ──');
  console.log(`  调用 ${g.calls} 次 / 花费 ${g.cost.toFixed(2)} 元 / 道 4 余量 ${g.callsLeft} 次`);
  if (snap.aborted) console.log(`  ★ 已中止：${snap.abortReason}（不自动续跑）`);
  if (snap.costUnknownCalls) console.log(`  价格表未命中 ${snap.costUnknownCalls} 次调用（成本按 0 计，20 元上限对这部分不生效）`);

  // failed 对账（补丁 v1.5 §2.3）：漂移导致的死 failed 行在这里收掉
  const rec = reconcileFailed({ store, runId, now: Date.now(), log });
  console.log(`  failed 对账：检查 ${rec.checked}，收掉 ${rec.resolved}，剩余 ${rec.remaining}`
    + `${rec.remaining ? '（真失败，留给补跑轮/下一 run）' : ''}`);
  for (const r of rec.remainingDetail.slice(0, 10)) {
    console.log(`    未消解：${r.chatKey} ${stamp(r.convStartTs)}`);
  }

  // 覆盖率前后（完成判据：39.7% → ≥75%）
  let convs = 0, ok = 0, failed = 0;
  for (const chatKey of store.listChats()) {
    const cov = memStore.readCoverage(chatKey);
    convs += cov.list.length;
    ok += cov.list.filter((r) => r.state === 'ok').length;
    failed += cov.list.filter((r) => r.state === 'failed').length;
  }
  console.log(`  覆盖率：ok ${ok} / 唯一会话 ${convs} = ${convs ? (ok / convs * 100).toFixed(1) : 0}%`
    + `　failed ${failed}`);
  console.log('');
  return snap.aborted ? 1 : 0;
}

// 只有直接执行才跑 main（被测试 import 时不跑）。
// Windows 上 import.meta.url 是 file:///D:/...，process.argv[1] 是 D:\...，两边都 resolve 再比。
const invokedDirectly = (() => {
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || '');
  } catch { return false; }
})();
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => { console.error('[backfill] 失败：', error); process.exit(1); });
}
