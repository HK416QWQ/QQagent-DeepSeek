// 第 5 期 · 回填 + 三道闸分工 + 道 4 的单测。
//
// 这一组守的是四种「看起来在跑、其实在烧钱/在骗人」的形态：
//   · 回填吃日配额        → 第 30 次之后全写 failed，判据再把 failed 捞回来（自我放大）
//   · 回填进日增量分子    → 1.6M token 顶穿 1.4M，当天实时任务全停
//   · 道 4 到限还续跑      → 「500 次上限」变成「每 5 分钟 500 次」
//   · 幂等判据写松了      → 重跑 116 个已覆盖会话、把 short 覆写成别的状态
//
// 覆盖 §6 的：#3 #4 #5 #6 #7 #13 #15
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mem2-bf-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const M = await import('../src/mem2/store.js');
const LLM = await import('../src/mem2/llm.js');
const BS = await import('../src/mem2/backfill-state.js');
const BF = await import('../scripts/backfill.mjs');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const MIN = 60 * 1000;
const T0 = new Date(2026, 10, 10, 10, 0, 0).getTime();

let caseNo = 0;
function freshRoot() {
  caseNo += 1;
  P.setMem2Root(path.join(DATA, `case-${caseNo}`));
  BS.__resetForTest();
  return P.mem2Dir();
}

/** 造一段 conv 的原始消息：human 条群友 + 1 条机器人，间隔 1 分钟。 */
function mkConv(startTs, human) {
  const out = [];
  for (let i = 0; i < human; i += 1) {
    out.push({ mid: `m${startTs}_${i}`, ts: startTs + i * MIN, text: `群友第${i}句`, senderId: 'u1', senderName: '甲', self: false });
  }
  out.push({ mid: `m${startTs}_s`, ts: startTs + human * MIN, text: '机器人应一句', senderId: 'bot', senderName: '机器人', self: true });
  return out;
}

/** 假 store：只实现回填真正用到的两个方法。 */
function fakeStore(chats) {
  return {
    listChats: () => Object.keys(chats),
    rangeByTs: (k) => (chats[k] || []).slice()
  };
}

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fakeCall = (tokens = 1000) => async () => ({
  model: 'fake-model', usage: { prompt_tokens: tokens - 100, completion_tokens: 100, total_tokens: tokens }
});

// ── #5 回填独立记账：不吃 ② 日配额、不进 ③ 日增量，但 usage.jsonl 有行 ──
{
  freshRoot();
  const dir = P.mem2Dir();
  fs.mkdirSync(dir, { recursive: true });
  const dayKey = LLM.dayKeyOf(Date.now());
  // summary 配额已打满、日增量也贴着上限 —— 这两条都是「回填不该受影响」的现场
  fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({
    dayKey, counts: { summary: 30, 'l1-refine': 0 }, tokens: 1_399_000, updatedAt: Date.now()
  }), 'utf8');

  BS.openRun('t5');
  const r = await LLM.memLlm('backfill-l4', { messages: [{ content: 'x'.repeat(100) }], call: fakeCall(1000) });
  assert.equal(r.ok, true, '回填不受 summary 日配额与日增量约束');

  const quota = JSON.parse(fs.readFileSync(path.join(dir, 'quota.json'), 'utf8'));
  assert.equal(quota.tokens, 1_399_000, '回填的 token 不许进 ③ 的分子（落点是 state.tokens += totalTokens）');
  assert.equal(quota.counts['backfill-l4'], 1, '回填单独一个观测桶');
  assert.equal(quota.counts.summary, 30, '不许动 summary 的桶');

  const rows = readJsonl(P.usageFile());
  assert.equal(rows.at(-1).kind, 'backfill-l4', 'usage.jsonl 必须照常记账且 kind 正确');

  // 同一时刻，summary 该被拒的仍然被拒（证明 ② 没被我们改坏）
  const s = await LLM.memLlm('summary', { messages: [{ content: 'x' }], call: fakeCall() });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'quota');
  BS.closeRun();
  ok('#5 回填独立记账：不吃日配额、不进日增量、usage 有行，且 summary 仍按 30 次拒');
}

// ── #6 / #13 道 4：501 次要中止，中止后不自动续跑 ──
{
  freshRoot();
  BS.openRun('t6');
  let allowed = 0;
  for (let i = 0; i < BS.BACKFILL_LIMITS.maxCalls; i += 1) {
    if (BS.backfillGate().ok) allowed += 1;
  }
  assert.equal(allowed, BS.BACKFILL_LIMITS.maxCalls, '500 次必须全部放行');
  const over = BS.backfillGate();
  assert.equal(over.ok, false, '第 501 次必须拒绝');
  assert.equal(over.reason, 'calls');

  const file = P.backfillFile('t6');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.aborted, true, '必须落盘 backfill-aborted');
  assert.equal(saved.abortReason, 'calls');

  // 关掉再从盘上续：仍是中止态（不自动续跑）
  BS.closeRun();
  const again = BS.openRun('t6', { resume: true });
  assert.equal(again.aborted, true);
  assert.equal(BS.backfillGate().ok, false, '续跑也必须继续拒绝（人没下命令就不许跑）');
  BS.closeRun();
  ok(`#6 道 4：${BS.BACKFILL_LIMITS.maxCalls} 次放行、超一次中止、写 backfill-aborted、续跑不自动恢复`);
}

// ── 道 4 的另一条上限：20 元（走同一段中止逻辑，但由成本触发；按**跨 run 累计**判）──
{
  freshRoot();
  const id = 't6b';
  fs.mkdirSync(P.backfillDir(), { recursive: true });
  fs.writeFileSync(P.totalsFile(), JSON.stringify({
    totalCalls: 120, totalCost: 25, updatedAt: Date.now()
  }), 'utf8');

  BS.openRun(id);
  const g = BS.backfillGate();
  assert.equal(g.ok, false, '累计成本已达 25 元 → 必须拒绝（换 runId 也不行）');
  assert.equal(g.reason, 'cost');
  assert.equal(JSON.parse(fs.readFileSync(P.backfillFile(id), 'utf8')).abortReason, 'cost');
  BS.closeRun();
  ok('道 4 成本线：累计成本超 20 元即中止（与次数线共用同一段中止逻辑，且不随 runId 重置）');
}

// ── #3 / #4 / #15 回填判据：ok/short/pending 跳过、failed 与无覆盖回填、群友<10 不补记 ──
{
  freshRoot();
  const A = 'group:910001';
  const B = 'group:910002';
  const c1 = T0;                                   // 无覆盖 + 12 群友 → 回填
  const c2 = T0 + 2 * 60 * MIN;                    // 无覆盖 + 5 群友 → shortSkipped
  const c3 = T0 + 4 * 60 * MIN;                    // 已 ok → 跳过
  const c4 = T0 + 6 * 60 * MIN;                    // failed → 回填

  M.appendCoverage(A, M.makeCoverageRow({
    chatKey: A, convStartTs: c3, convEndTs: c3 + 12 * MIN, msgCount: 13, humanMsgCount: 12, state: 'ok'
  }));
  M.appendCoverage(B, M.makeCoverageRow({
    chatKey: B, convStartTs: c4, convEndTs: c4 + 12 * MIN, msgCount: 13, humanMsgCount: 12, state: 'failed'
  }));

  const store = fakeStore({
    [A]: [...mkConv(c1, 12), ...mkConv(c2, 5), ...mkConv(c3, 12)],
    [B]: mkConv(c4, 12)
  });
  const plan = BF.planBackfill({ store, now: T0 + 10 * 60 * MIN });

  assert.equal(plan.stats.candidates, 2, 'c1（无覆盖）+ c4（failed）两个候选；c3 已 ok、c2 群友不足');
  assert.equal(plan.stats.failedNow, 1, 'failed 数要单列（--dry 的第 4 个数）');
  assert.equal(plan.stats.shortSkipped, 1, '群友<10 的会话不进候选');
  assert.equal(plan.stats.skipped, 1, 'ok 跳过');
  assert.equal(plan.stats.calls, 2, '两个会话各 1 次调用');
  const keys = plan.items.map((i) => i.key).sort();
  assert.deepEqual(keys, [`${A}@${c1}`, `${B}@${c4}`].sort());

  // #13：同会话用满 2 次就放弃
  const plan2 = BF.planBackfill({
    store, now: T0 + 10 * 60 * MIN,
    attemptsOf: (k, ts) => (`${k}@${ts}` === `${B}@${c4}` ? BS.MAX_ATTEMPTS_PER_CONV : 0)
  });
  assert.equal(plan2.stats.candidates, 1, '用满 2 次的会话不再进候选');
  assert.equal(plan2.stats.abandoned, 1);

  // #7：断点清单里的项要跳过
  const plan3 = BF.planBackfill({ store, now: T0 + 10 * 60 * MIN, done: new Set([`${A}@${c1}`]) });
  assert.equal(plan3.stats.candidates, 1);
  assert.equal(plan3.stats.alreadyDone, 1);

  // #15 --dry 必须打出五个数（含「上限 = 434 + 补跑」两档）
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { BF.printDry(plan, { abandoned: [] }); } finally { console.log = realLog; }
  const text = lines.join('\n');
  for (const must of ['① 候选会话数', '② 预期调用数', '③ 上限（含补跑）', '④ 当前 failed 会话', '⑤ 已用满重试（放弃）']) {
    assert.ok(text.includes(must), `--dry 必须打出「${must}」`);
  }
  assert.ok(/失败率 10%/.test(text) && /失败率 15%/.test(text), '补跑要给 10% / 15% 两档');
  assert.ok(text.includes('道 4 余量'), '道 4 的 500 次线必须让人看见');
  ok('#3/#4/#13/#15 判据：无覆盖与 failed 才回填、ok 跳过、群友<10 不补记、用满 2 次放弃、--dry 五数齐全');
}

// ── #7 断点续跑：markDone 落盘后，重开 run 仍能跳过 ──
{
  freshRoot();
  BS.openRun('t7');
  BS.markDone('group:900', T0, 'ok');
  BS.bumpAttempt('group:900', T0 + MIN);
  BS.closeRun();
  assert.equal(BS.currentRun(), null, 'closeRun 后进程内不再有活动 run');

  const again = BS.openRun('t7', { resume: true });
  assert.deepEqual([...BS.doneSet()], [`group:900@${T0}`], '已完成清单必须从盘上恢复');
  assert.equal(BS.attemptsOf('group:900', T0 + MIN), 1, '尝试次数也要从盘上恢复');
  assert.equal(again.calls, 0);

  // 不 --resume 时必须报错（防手滑把已有 run 覆盖成新的）
  let threw = false;
  try { BS.openRun('t7', { resume: false }); } catch { threw = true; }
  assert.equal(threw, true, '已有 run 时不加 --resume 必须拒绝');
  BS.closeRun();
  ok('#7 断点续跑：done/attempts 从盘上恢复；已存在的 run 不加 --resume 会拒绝');
}

// ── #16（补丁 v1.5）按 endTs 定位：startTs 漂移 40 秒的 failed 仍被认出来 ──
//
// `convStartTs` 取决于切分时刻与消息序列，实测 36.8% 的覆盖行重切后起点会漂。
// 用 startTs 精确等值找行，漂移的 failed 就永远查不到 → 判「无覆盖」→ 回填用新
// key 再写一行 ok → 旧 failed 的主键是老的，永远清不掉 → 「failed 归零」永远黄。
{
  freshRoot();
  const K = 'group:920001';
  const start = T0;
  const msgs = mkConv(start, 12);
  const lastTs = msgs[msgs.length - 1].ts;
  const drifted = start - 40 * 1000;          // 起点漂了 40 秒，终点没漂

  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: drifted, convEndTs: lastTs,
    msgCount: 13, humanMsgCount: 12, state: 'failed'
  }));

  const store = fakeStore({ [K]: msgs });
  const plan = BF.planBackfill({ store, now: T0 + 10 * 60 * MIN });

  assert.equal(plan.stats.candidates, 1, '漂移的 failed 必须仍被判为「该回填」，不能当成无覆盖的新会话');
  assert.equal(plan.stats.aligned, 1, '要认出这是「对齐」而不是新会话');
  assert.equal(plan.stats.failedNow, 1);
  assert.equal(plan.items[0].convStartTs, drifted, '必须用**旧 key** 记账（否则旧 failed 清不掉）');
  assert.equal(plan.items[0].conv.startTs, drifted, '跑的时候也要用旧 startTs');
  assert.equal(plan.items[0].key, `${K}@${drifted}`);

  // 模拟 runConv 写回 ok（同一主键）→ failed 必须当场归零
  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: drifted, convEndTs: lastTs,
    msgCount: 13, humanMsgCount: 12, state: 'ok'
  }));
  const after = M.readCoverage(K);
  assert.equal(after.list.filter((r) => r.state === 'failed').length, 0, '同主键写 ok 后 failed 计数必须为 0');
  assert.equal(after.byStart.size, 1, '仍然只有一行（last-wins），没有多出一个新 key');
  assert.equal(M.queryState(K, { fromTs: drifted, toTs: lastTs, lastScanTs: lastTs }), 'ok');
  ok('#16 按 endTs 定位：startTs 漂 40 秒的 failed 仍被认出、按旧 key 记账、写 ok 后 failed 归零');
}

// ── #17（补丁 v1.5）failed 对账：两级都没匹配上的死行，靠包含关系收掉；真失败不动 ──
{
  freshRoot();
  const K = 'group:920002';
  const deadStart = T0;
  const deadEnd = T0 + 20 * MIN;
  const realStart = T0 + 6 * 60 * MIN;
  const realEnd = realStart + 20 * MIN;

  // 死行：区间已被一条 ok 完整包住（模拟"新 ok 落在新 key"）
  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: deadStart, convEndTs: deadEnd, msgCount: 20, humanMsgCount: 15, state: 'failed'
  }));
  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: deadStart - 60 * 1000, convEndTs: deadEnd + 60 * 1000,
    msgCount: 22, humanMsgCount: 17, state: 'ok'
  }));
  // 真失败：区间没被任何 ok 覆盖，必须留着交给补跑
  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: realStart, convEndTs: realEnd, msgCount: 20, humanMsgCount: 15, state: 'failed'
  }));

  const store = fakeStore({ [K]: [] });
  const rec = BF.reconcileFailed({ store, runId: 't17', now: T0 + 60 * MIN });

  assert.equal(rec.checked, 2);
  assert.equal(rec.resolved, 1, '被完整包住的死 failed 要收掉');
  assert.equal(rec.remaining, 1, '真失败不许动（否则等于把失败洗白）');

  const cov = M.readCoverage(K);
  const dead = cov.byStart.get(deadStart);
  assert.equal(dead.state, 'ok');
  assert.equal(dead.resolvedByBackfill, 't17');
  assert.equal(dead.mergedInto, deadStart - 60 * 1000);
  assert.equal(cov.byStart.get(realStart).state, 'failed', '真失败必须还是 failed');
  // queryState 认的是四态：写成 'superseded' 会掉进 empty（= 撒谎说这段没人说话）
  assert.equal(M.queryState(K, { fromTs: deadStart, toTs: deadEnd, lastScanTs: deadEnd }), 'ok');
  ok('#17 failed 对账：被覆盖的死行收成 ok（带 resolvedByBackfill/mergedInto），真失败原样保留');
}

// ── 补丁 v1.6 #20：补跑只挑可重试的失败（确定性失败重跑是净亏）──
{
  const failures = [
    { chatKey: 'g', convStartTs: 1, code: 'self-leak' },
    { chatKey: 'g', convStartTs: 2, code: 'self-leak' },
    { chatKey: 'g', convStartTs: 3, code: 'self-leak' },
    { chatKey: 'g', convStartTs: 4, code: 'call-error' },
    { chatKey: 'g', convStartTs: 5, code: 'backfill-aborted' }
  ];
  const { retry, deterministic } = BF.pickRetryable(failures);
  assert.equal(retry.length, 2, '只补跑 call-error 与被闸门截断的两个');
  assert.deepEqual(retry.map((f) => f.code), ['call-error', 'backfill-aborted']);
  assert.equal(deterministic, 3, '三个 self-leak 一律不补跑');

  // 用满 2 次的也进"不补跑"（它们已经试过两次了）
  const again = BF.pickRetryable(failures, (k, ts) => (ts === 4 ? 2 : 0));
  assert.equal(again.retry.length, 1, 'call-error 已用满 2 次 → 不再重试');
  assert.equal(again.deterministic, 4);
  // 老数据里 deny() 曾经把 gateReason 写进 reason，落成 'calls'/'已中止：…'
  assert.equal(BF.isRetryable('calls'), true, '历史落盘的 failed:calls 必须能续上');
  assert.equal(BF.isRetryable('已中止：calls'), true);
  assert.equal(BF.isRetryable('self-leak'), false);
  ok('#20 补跑筛选：3 个 self-leak 跳过并计入「确定性失败」、2 个可重试的照跑、用满次数的不再重试');
}

// ── 补丁 v1.6 #21/#22：道 4 跨 run 累计（换 runId 绕不过）──
{
  freshRoot();
  BS.openRun('runA');
  for (let i = 0; i < 300; i += 1) BS.backfillGate();
  BS.closeRun();
  assert.equal(BS.gateRemain().callsLeft, BS.BACKFILL_LIMITS.maxCalls - 300,
    '#21 run A 用了 300 次，余量必须是 600-300');

  BS.openRun('runB');
  assert.equal(BS.gateRemain().callsLeft, BS.BACKFILL_LIMITS.maxCalls - 300,
    '#21 ★ 换一个 runId 不会把余量重置回 600（这就是「防绕过」）');
  const g = BS.backfillGate();
  assert.equal(g.ok, true);
  assert.equal(BS.readTotals().totalCalls, 301, '新 run 的调用要累到总账上');
  BS.closeRun();
  ok('#21 跨 run 累计：run A 用 300 次后，换 runB 的余量仍是 300（换 runId 绕不过道 4）');

  const after = BS.resetTotals();
  assert.equal(after.totalCalls, 0);
  assert.equal(BS.gateRemain().callsLeft, BS.BACKFILL_LIMITS.maxCalls,
    '#22 --reset-totals 后余量回到 600（只有显式清零才会回去）');
  // 落盘也要真的清零，否则重启又回来
  BS.__resetForTest();
  assert.equal(BS.readTotals().totalCalls, 0, '清零必须落盘（重启后仍是 0）');
  ok('#22 --reset-totals：余量回到 600，且清零落盘（重启不会把旧数带回来）');
}

// ── 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── mem2-backfill：${passed} 项通过`);
