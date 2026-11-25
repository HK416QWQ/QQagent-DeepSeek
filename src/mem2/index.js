// 第 1 期编排（2026-11-14）：T2（会话切分）+ T3/T4（摘要调用与落盘）+ 定时调度。
//
// T2 的四条硬约束（每条都对应一个会静默丢数据的坑）：
//   1. **先写 coverage、后推水位**。反过来的话，崩溃一次就会让「有人说过话」的区间
//      被 §2.3 判成 `empty` —— 那不是缺数据，是系统在撒谎（`empty` 是"确定没人说话"
//      那一档，一旦可被错误产生，整个四态都不可信了）。
//   2. **截断时水位不跳**。本轮只处理了 10 个、还剩 15 个，水位只能推到第 10 个的
//      `endTs`；推到 `now-30min` 会让那 15 个永久丢失（和 pending 悬空同类）。
//   3. **未截断时水位要推到 `now-30min`**。否则安静时段水位卡住不动，`empty` 永远
//      推导不出来，而且每轮白扫同一段。
//   4. **pending 先于新会话**。否则配额被新会话吃光，老账永远轮不到 —— 活锁。
//
// T4 的唯一硬约束是**顺序**（§3.3）：摘要行先落 L4，再落 coverage；
// L4 落盘失败标 failed，不写 ok。

import {
  GAP_MS, SHORT_HUMAN_COUNT, splitConvs, t2State, t3Blocked
} from './conv.js';
import {
  getLastScanTs, setLastScanTs, initSchema
} from './paths.js';
import * as memStore from './store.js';
import { summarizeConv } from './summarize.js';
import { memLlm } from './llm.js';
import { getConfig } from '../config.js';

/** 同一个 conv 最多试 3 次；超了标 failed，避免一条坏数据每轮烧一次配额。 */
export const RETRY_MAX = 3;

/** ISO 字符串 / 毫秒数 → 毫秒。配错返回 0（当作"没配"）。 */
function toTs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

/** 新会话来自 splitConvs（startTs/endTs）；pending 行来自覆盖表（convStartTs/convEndTs）。 */
function convTsOf(convLike) {
  return {
    startTs: Number(convLike?.convStartTs ?? convLike?.startTs) || 0,
    endTs: Number(convLike?.convEndTs ?? convLike?.endTs) || 0
  };
}

/**
 * T3 + T4：把一个 conv 变成摘要并落盘。**任何异常都不向外抛**（记忆坏了不能拖垮主链路）。
 *
 * @param {object} p
 * @param {string} p.chatKey
 * @param {object} p.convLike   {startTs,endTs,messages?} 或覆盖表行 {convStartTs,convEndTs,attempts}
 * @param {object} p.store      ChatStore（pending 行要靠它按区间重读消息）
 * @param {boolean} [p.dryRun]  干跑：照常调 LLM、照常记账，但不写 coverage/l4
 * @returns {Promise<{ok:boolean, code:string}>}
 */
export async function runConv({
  chatKey, convLike, store, mem = memStore, l4cfg = {},
  dryRun = l4cfg?.dryRun === true, now = Date.now(), log = () => {},
  llm = memLlm, persona = null,
  // ★ 第 5 期：任务类型穿线。默认 'summary' = 完全保持旧行为（不传即回旧路）。
  //   回填传 'backfill-l4'，才能享受「不吃 ② 日配额 / 不进 ③ 日熔断 / 只受道 4 约束」。
  //   不穿的后果不是"慢 15 天"，是**闭环失败**：前 30 次成功后全被 ② 拒绝 → 写 failed
  //   → 回填判据把 failed 捞回来 → 再跑再失败，failed 从 8 涨到几百、钱一直烧。
  kind = 'summary'
} = {}) {
  const { startTs, endTs } = convTsOf(convLike);
  const tag = `${chatKey} ${new Date(startTs).toISOString().slice(0, 16)}`;

  // ── 取消息 ──
  // 新会话（干跑路径）已经带 messages；pending 行只有主键，必须按区间重读 ——
  // 不能相信覆盖表里的 msgCount，那是一个可能已经过期的计数。
  let messages = Array.isArray(convLike?.messages) ? convLike.messages : null;
  if (!messages) {
    // P1-02：优先用月级读取（只读窗口覆盖的月份），没有该方法时回退 rangeByTs。
    const readRange = typeof store?.loadChatRange === 'function'
      ? store.loadChatRange.bind(store)
      : (typeof store?.rangeByTs === 'function' ? store.rangeByTs.bind(store) : null);
    if (!readRange) return { ok: false, code: 'no-store' };
    messages = readRange(chatKey, {
      fromTs: startTs, toTs: endTs || now, includeSelf: true, visibleOnly: true
    });
  }
  const conv = {
    startTs,
    endTs: endTs || (messages.length ? (Number(messages[messages.length - 1].ts) || 0) : 0),
    messages,
    msgCount: messages.length,
    humanMsgCount: messages.reduce((n, m) => n + (m?.self ? 0 : 1), 0)
  };

  // ★ attempts 只在**真的花了一次调用**（或终态失败）时 +1。
  //   配额延后不能加：一天 30 次配额在第 2 轮就打满，之后每 10 分钟 tick 一次，
  //   若延后也计数，一条 pending 会在 30 分钟内被自己的等待打成 `failed`
  //   （RETRY_MAX=3），「次日重跑」就永远等不到了。
  const prevAttempts = Number(convLike?.attempts) || 0;
  const base = {
    chatKey,
    convStartTs: conv.startTs,
    convEndTs: conv.endTs,
    msgCount: conv.msgCount,
    humanMsgCount: conv.humanMsgCount,
    nowTs: now
  };
  const srcErrors = (convLike?.parseErrors && typeof convLike.parseErrors === 'object') ? convLike.parseErrors : {};
  const prevErrors = { ...srcErrors, topic: Number(srcErrors.topic) || 0 };
  delete prevErrors.event;
  const write = (patch) => mem.appendCoverage(chatKey, memStore.makeCoverageRow({
    ...base, attempts: prevAttempts + 1, ...patch
  }));

  // ── T3 门禁（§3.2.0）：判的是**群友条数**，不是全部条数 ──
  // 一段 100 条里 95 条是机器人说的，可摘要的只有那 5 句；用总数判会拿 95 条噪音
  // 去生成一段没有群友内容的摘要。命中就直接终态 short，一次调用都不花。
  if (t3Blocked(conv)) {
    if (!dryRun) write({ state: 'short', attempts: prevAttempts });
    log(`[l4] ${tag} → short（群友 ${conv.humanMsgCount} 条 < ${SHORT_HUMAN_COUNT}，不调 LLM）`);
    return { ok: true, code: 'short' };
  }

  const r = await summarizeConv({
    chatKey, conv, llm, now, kind,
    persona: persona || getConfig()?.persona || {}
  });

  if (!r.ok) {
    // 延后 vs 失败：配额/预算类**不是**失败，转 pending 等次日（§5.3），
    // 且 attempts 不增 —— 它没花钱、也不是坏数据，不该被重试上限打成 failed。
    const defer = r.reason === 'quota' || r.reason === 'budget-exceeded';
    if (!dryRun) {
      if (defer) {
        write({
          state: 'pending',
          deferredReason: r.reason === 'quota' ? 'quota' : 'budget',
          parseErrors: prevErrors,
          attempts: prevAttempts          // ★ 延后不算一次尝试（见上面 attempts 的注释）
        });
      } else {
        write({ state: 'failed', parseErrors: { ...prevErrors, failed: r.reason } });
      }
    }
    log(`[l4] ${tag} → ${defer ? 'deferred' : 'failed'}:${r.reason}`
      // 命中原因必须进日志：只写 `failed:self-leak` 的话，运维分不清是模型真复述了
      // 机器人的话，还是检测器把某个 4 字片段误伤了 —— 这两种的处理方式完全相反。
      + `${r.hits?.length ? ` [${r.hits.slice(0, 4).join(', ')}]` : ''}`
      + `${r.summary ? `：${String(r.summary).slice(0, 80)}` : ''}`
      + `${r.hadReasoning ? '（content 为空，只拿到思考过程，按规范不采用）' : ''}`);
    return { ok: false, code: r.reason };
  }

  // ── T4 落盘（§3.3 的顺序：L4 → coverage）──
  const createdAt = Date.now();
  const rec = {
    chatKey,
    convStartTs: conv.startTs,
    convEndTs: conv.endTs,
    summary: r.summary,
    sparse: r.sparse,
    topics: r.topics,
    entities: r.entities,
    createdAt
  };

  if (dryRun) {
    // 干跑要能看到「摘要像不像人话」，否则"跑够 20 个"无从谈起（§7 表格）。
    // 只打一行、截断 —— 完整正文靠数据库工具看，不靠日志页。
    log(`[l4] 干跑摘要 ${tag} → ok ${r.slices} 片`
      + `${r.sparse ? ' sparse' : ''}：${r.summary.slice(0, 60)}`);
    return { ok: true, code: 'ok' };
  }

  const parseErrors = { topic: Number(prevErrors.topic) || 0 };

  try {
    mem.appendL4(chatKey, rec);
  } catch (error) {
    // L4 写失败 = 摘要没落下。标 failed 而不是 pending：重跑会再花一次 LLM；
    // 宁可如实记「这段没记下」。
    write({ state: 'failed', parseErrors: { ...parseErrors, failed: 'l4-write-failed' } });
    log(`[l4] ${tag} → failed:l4-write-failed ${error?.message ?? error}`);
    return { ok: false, code: 'l4-write-failed' };
  }

  write({ state: 'ok', parseErrors });
  log(`[l4] ${tag} → ok ${r.slices} 片${r.sparse ? ' sparse' : ''}`
    + ` / 群友 ${conv.humanMsgCount} 条`);
  return { ok: true, code: 'ok' };
}

/**
 * 跑一轮 T2。
 *
 * @param {object} p
 * @param {object} p.store        ChatStore（要 listChats + rangeByTs）
 * @param {object} [p.mem]        mem2 产物读写（默认真实实现；测试可注入 fake）
 * @param {object} [p.l4cfg]      config.memory.l4
 * @param {number} [p.now]        当前时刻（测试注入）
 * @param {Function} [p.log]      日志
 * @param {Function} [p.runConv]  async (chatKey, convLike) => void
 *        T3 的入口。**不传时只做"切分 + 记账"，不调 LLM**（默认由 startL4 装配）。
 * @returns {Promise<object>} 本轮统计
 */
export async function runT2Tick({ store, mem = memStore, l4cfg = {}, now = Date.now(), log = () => {}, runConv = null } = {}) {
  const cfg = l4cfg || {};
  const gapMs = GAP_MS;
  // 干跑（§7）：T2 照常算、照常打日志，但**不写覆盖表**；水位照推（否则每 10 分钟
  // 重复摘要同一批，干跑反而最烧钱）。代价：关掉 dryRun 后，干跑扫过的会话不会补摘要
  // —— 所以施工单 §7.3 要求"开写盘前先重置 data/mem2/"。启动时会打日志提醒。
  const dryRun = cfg.dryRun === true;
  const maxPerTick = Math.max(1, Number(cfg.maxConvPerTick) || 10);
  const bootstrapTs = toTs(cfg.bootstrapFromTs);
  const stat = {
    chats: 0, short: 0, pending: 0, retried: 0, exhausted: 0, truncated: 0,
    writeErrors: 0, convErrors: 0, summarized: 0
  };

  // P1-02：用 listChatKeys()（只 readdir）代替 listChats()（会把每个 chat 的消息全读进内存）
  const chats = typeof store?.listChatKeys === 'function'
    ? store.listChatKeys()
    : (typeof store?.listChats === 'function' ? store.listChats() : []);
  for (const chatKey of chats) {
    stat.chats += 1;
    const lastScan = getLastScanTs(chatKey);
    // 起点三分支（§7.1）：已有水位 → 用它；否则 bootstrapFromTs；都没有 → 只看最近 30 分钟。
    // `bootstrapFromTs` 只在没有水位时生效一次 —— 否则改一次配置就重扫一遍历史。
    const fromTs = lastScan || bootstrapTs || (now - gapMs);

    let budget = maxPerTick;
    const cov = mem.readCoverage(chatKey);

    // ── ① 先清旧账：pending 拾取 ──
    // 干跑时跳过：pending 的处理结果本来就要写回 coverage，干跑不写 → 每轮重试同一批，
    // 配额会在干跑里被无声烧光（这正是 v1.1 修过的"干跑反而最烧钱"）。
    for (const row of (dryRun ? [] : mem.pendingOf(cov))) {
      if (budget <= 0) break;
      if ((Number(row.attempts) || 0) >= RETRY_MAX) {
        // 重试用尽：不再调 LLM，标 failed。注意这里**不消耗预算** —— 它没有花钱。
        const restErrors = { ...(row.parseErrors || {}) };
        delete restErrors.event;
        mem.appendCoverage(chatKey, {
          ...row,
          state: 'failed',
          parseErrors: { ...restErrors, retry: 'retry-exhausted' },
          updatedAt: now
        });
        stat.exhausted += 1;
        continue;
      }
      if (!runConv) break;            // 还没接 T3：保持 pending 原样，不消耗 attempts
      budget -= 1;
      try {
        // attempts 由 runConv 写回时决定加不加（配额延后不加，见 runConv 注释）。
        // 这里**不能**先 +1 传进去 —— 那样一次的"等明天"就会吃掉一格重试预算。
        const r = await runConv(chatKey, row);
        if (r?.ok && r.code === 'ok') stat.summarized += 1;
      } catch (error) {
        // 单条 conv 炸了不许带走整轮：否则一个坏会话会让后面所有群都扫不到
        stat.convErrors += 1;
        log(`[l4] ${chatKey} 摘要异常（已跳过）：${error?.message ?? error}`);
      }
      stat.retried += 1;
    }

    // ── ② 再看新账：切分 + 记账 ──
    // P1-02：月级读取，只读窗口覆盖的月份（±1 月），不再为一次 tick 把该 chat
    // 的所有月份读进内存。两端都含，水位那条已经处理过，必须剔掉（同 ts 的多条
    // 都在上一次的 conv 里，一起剔是安全的）。
    const readRange = typeof store.loadChatRange === 'function'
      ? store.loadChatRange.bind(store)
      : store.rangeByTs.bind(store);
    const msgs = readRange(chatKey, { fromTs, toTs: now, includeSelf: true, visibleOnly: true })
      .filter((m) => !lastScan || (Number(m.ts) || 0) > lastScan);
    const { closed } = splitConvs(msgs, { nowTs: now, gapMs });

    let processed = 0;
    let lastProcessedEnd = 0;
    let truncated = false;
    let writeFailed = false;
    for (const conv of closed) {
      const existing = cov.byStart.get(conv.startTs);
      if (existing) {
        // 已经处理过（重复扫描是允许的，见红线"宁可白扫不可撒谎"）。不重复写、
        // 不消耗预算 —— 但进度照样往前推，否则会卡在这一段。
        lastProcessedEnd = conv.endTs;
        continue;
      }
      if (processed >= budget) { truncated = true; break; }
      const state = t2State(conv);
      if (dryRun) {
        processed += 1;
        lastProcessedEnd = conv.endTs;
        if (state === 'short') stat.short += 1; else stat.pending += 1;
        log(`[l4] 干跑 ${chatKey} ${new Date(conv.startTs).toISOString()}`
          + ` → ${state}（${conv.msgCount} 条 / 群友 ${conv.humanMsgCount} 条，不落盘）`);
        // ★ 干跑必须调 T3：干跑不写 coverage，就**没有 pending 可拾取**，不在这里
        //   调 runConv 的话一个摘要都产不出来，「跑够 20 个看质量」（§7）无从谈起。
        //   不会重复消费：本分支照推水位（§7），下一轮 fromTs 已经越过这些 conv。
        if (state !== 'short' && runConv) {
          try {
            const r = await runConv(chatKey, conv);
            if (r?.ok && r.code === 'ok') stat.summarized += 1;
          } catch (error) {
            stat.convErrors += 1;
            log(`[l4] 干跑 ${chatKey} 摘要异常（已跳过）：${error?.message ?? error}`);
          }
        }
        continue;
      }
      try {
        mem.appendCoverage(chatKey, memStore.makeCoverageRow({
          chatKey,
          convStartTs: conv.startTs,
          convEndTs: conv.endTs,
          msgCount: conv.msgCount,
          humanMsgCount: conv.humanMsgCount,
          state,
          nowTs: now
        }));
      } catch (error) {
        // ★ 顺序红线：写不进去就**不许**推水位。宁可下一轮重复扫（幂等），
        //   也不能让这段区间变成"扫过了但没记录"→ 被 §2.3 判成 empty。
        writeFailed = true;
        stat.writeErrors += 1;
        log(`[l4] ${chatKey} coverage 写入失败，本轮水位不推进：${error?.message ?? error}`);
        break;
      }
      processed += 1;
      lastProcessedEnd = conv.endTs;
      if (state === 'short') stat.short += 1; else stat.pending += 1;
    }

    if (writeFailed) continue;    // 水位保持原值

    // ── ③ 推水位（两分支，见文件头）──
    if (truncated) stat.truncated += 1;
    const nextScan = truncated
      ? lastProcessedEnd                        // 不许跳：剩下的下轮还会扫到
      : Math.max(lastProcessedEnd || 0, now - gapMs);   // 安静时段也要推进，否则 empty 出不来
    if (nextScan > 0) setLastScanTs(chatKey, nextScan);
  }
  return stat;
}

/**
 * 启动 L4 定时任务（app.js 启动时调一次）。
 * **默认关**（config.memory.l4.enabled = false）：本期产物没有任何人读，
 * 开着只是白烧配额，所以必须显式打开。
 *
 * @returns {{stop:Function}|null} null = 没开
 */
export function startL4({ store, l4cfg = {}, log = () => {}, runConv: injected = null, now = Date.now } = {}) {
  if (l4cfg?.enabled !== true) return null;
  initSchema();
  const dryRun = l4cfg?.dryRun === true;
  const tickMs = Math.max(60 * 1000, Number(l4cfg.tickMs) || 10 * 60 * 1000);
  // 默认装配真实的 T3/T4 入口；测试仍可注入假的（只数调用次数）。
  const runner = injected || ((chatKey, convLike) => runConv({
    chatKey, convLike, store, l4cfg, dryRun, now: now(), log
  }));
  let running = false;
  const tick = async () => {
    if (running) return;              // 上一轮没跑完就跳过，避免 tick 叠上来
    running = true;
    try {
      const stat = await runT2Tick({ store, l4cfg, log, runConv: runner, now: now() });
      if (stat.pending || stat.retried || stat.truncated || stat.summarized || stat.convErrors) {
        log(`[l4] T2：short=${stat.short} pending=${stat.pending} retried=${stat.retried}`
          + ` 摘要=${stat.summarized}`
          + `${stat.truncated ? ' truncated=' + stat.truncated : ''}`
          + `${stat.convErrors ? ' convErrors=' + stat.convErrors : ''}`);
      }
    } catch (error) {
      log(`[l4] T2 异常（已忽略，不影响主链路）：${error?.message ?? error}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  log(`[l4] 已启用：每 ${Math.round(tickMs / 60000)} 分钟扫一次`
    + `${dryRun ? '（干跑：不写产物）' : ''}`);
  if (dryRun) {
    // §7.3 的那条前提，写进日志而不是只写在文档里：干跑推进水位但不写覆盖表，
    // 所以干跑过的会话在关掉 dryRun 后不会被补摘要。开写盘前必须重置。
    log('[l4] 干跑提醒：不写 coverage/l4，但水位与配额照写。'
      + '关掉 dryRun 前请先 rm -rf data/mem2/（否则干跑过的会话不会补摘要）');
  }
  return { stop: () => clearInterval(timer), tick };
}
