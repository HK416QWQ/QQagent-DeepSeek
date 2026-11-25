// 第 1 期 · 第 4 步的单测：memLlm 的四道熔断。
//
// 这组测试守的是**两件方向相反**的事：
//   · 该拦的时候必须拦住（道 1/2/3），否则死循环会把钱烧光；
//   · **判闸门的代码自己炸了必须放行**（fail-open），否则一个 bug 就能让机器人
//     永远没有记忆 —— 而且不会报错，只是"记不住"。
//
// 第 4 步之所以排在最后，是因为它离主链路最近；但本文件（mem2/llm.js）**不改
// chatCompletion**，只是包在外面，所以这里能放心地把每种闸门都跑一遍。
//
// 覆盖施工单 §8.1 的：#7 #8 #9 #10 #11
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mem2-llm-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const L = await import('../src/mem2/llm.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

let caseNo = 0;
function freshRoot() {
  caseNo += 1;
  P.setMem2Root(path.join(DATA, `llm-${caseNo}`));
  const now = new Date(2026, 10, 14, 12, 0, 0).getTime();
  L.resetQuota({ now });
  return P.mem2Dir();
}

/** 假 LLM：返回固定 usage，记录调用次数与最后一次入参。 */
function fakeCall(usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) {
  const fn = async (args) => {
    fn.calls += 1;
    fn.lastArgs = args;
    return { message: { role: 'assistant', content: 'SUMMARY: 测试' }, usage, model: 'fake-model' };
  };
  fn.calls = 0;
  fn.lastArgs = null;
  return fn;
}

const DAY1 = new Date(2026, 10, 14, 12, 0, 0).getTime();
const DAY2 = new Date(2026, 10, 15, 12, 0, 0).getTime();
const msgs = (chars) => [{ role: 'user', content: 'x'.repeat(chars) }];

// ── #7 道 1：调用前预估超 6 万 → 拒绝且不重试 ──
{
  freshRoot();
  const call = fakeCall();
  // 105,000 字符 ÷ 1.5 = 70,000 token > 60,000
  const r = await L.memLlm('summary', { messages: msgs(105000), now: DAY1, call });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'single-call-aborted');
  assert.equal(call.calls, 0, '★ 超限必须连调用都不发（调用后才知道就晚了，钱已经花了）');
  assert.ok(r.estimatedTokens > 60000, `预估应超限，实际 ${r.estimatedTokens}`);

  // 边界：刚好不超的要放行
  const call2 = fakeCall();
  const r2 = await L.memLlm('summary', { messages: msgs(89000), now: DAY1, call: call2 });   // ≈59,334
  assert.equal(r2.ok, true, '未超限应正常调用');
  assert.equal(call2.calls, 1);

  // 限额可配（配成 0 应回落默认而不是"全部拒绝"）
  const call3 = fakeCall();
  const r3 = await L.memLlm('summary', { messages: msgs(3000), now: DAY1, call: call3, cfg: { singleCallMaxTokens: 0, quotaPerDay: 0, tokenBudgetPerDay: 0 } });
  assert.equal(r3.ok, true, '配置填 0 必须回落默认值，不能把记忆全停掉');
  ok('#7 道1 单次上限：7 万 token 拒绝且零调用；边界放行；配置为 0 回落默认');
}

// ── #8 道 2：第 31 次 summary → quota ──
{
  freshRoot();
  const call = fakeCall();
  for (let i = 0; i < 30; i += 1) {
    const r = await L.memLlm('summary', { messages: msgs(300), now: DAY1, call });
    assert.equal(r.ok, true, `第 ${i + 1} 次应成功`);
  }
  assert.equal(call.calls, 30);

  const over = await L.memLlm('summary', { messages: msgs(300), now: DAY1, call });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'quota', '★ 第 31 次必须是 quota（转 pending 等次日，不是丢弃）');
  assert.equal(call.calls, 30, '超额后不得再调用');

  // 配额落盘：重启也不该绕过（§5.5）
  const q = L.readQuotaFile();
  assert.ok(q && q.counts && q.counts.summary >= 30,
    `★ quota.json 必须落盘（实际 ${JSON.stringify(q?.counts)}）—— 不落盘的话反复重启就能绕过配额`);
  assert.equal(q.dayKey, L.dayKeyOf(DAY1));
  ok('#8 道2 日配额：第 31 次返回 quota、零调用，且配额已落盘（重启绕不过）');
}

// ── #9 道 3：当日 token 超 1.4M → 全停 ──
{
  freshRoot();
  const call = fakeCall({ prompt_tokens: 400000, completion_tokens: 100000, total_tokens: 500000 });
  assert.equal((await L.memLlm('summary', { messages: msgs(300), now: DAY1, call })).ok, true);
  assert.equal((await L.memLlm('summary', { messages: msgs(300), now: DAY1, call })).ok, true);
  assert.equal((await L.memLlm('summary', { messages: msgs(300), now: DAY1, call })).ok, true);  // 1.5M
  const over = await L.memLlm('summary', { messages: msgs(300), now: DAY1, call });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'budget-exceeded');
  assert.equal(call.calls, 3, '★ 日增量超限后不能再调用');

  // 另一个 kind 也要停（"停所有记忆任务"，不是只停 summary）
  const other = await L.memLlm('l1-extract', { messages: msgs(300), now: DAY1, call });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'budget-exceeded', '★ 日增量是全局闸门，换 kind 也不行');
  ok('#9 道3 日增量：超 1.4M 后所有 kind 全停（不是只停 summary）');
}

// ── #10 fail-open：判闸门的代码抛错时必须放行 ──
{
  freshRoot();
  const call = fakeCall();
  const boom = {
    get quotaPerDay() { throw new Error('配置读取炸了'); },
    tokenBudgetPerDay: 1400000,
    singleCallMaxTokens: 60000
  };
  const r = await L.memLlm('summary', { messages: msgs(300), now: DAY1, call, cfg: boom });
  assert.equal(r.ok, true, '★ fail-open：闸门自身抛错必须放行，否则一个 bug 就让机器人永远没有记忆');
  assert.equal(call.calls, 1, '★ 必须真的调用了');

  // 放行要留痕（不然"为什么超额还在跑"查不出来）
  const usageLines = P.readJsonl(P.usageFile());
  assert.ok(usageLines.some((x) => x.gateError), 'fail-open 必须在 usage.jsonl 里留 gateError');
  ok('#10 fail-open：闸门抛错 → 照常调用 + usage.jsonl 留 gateError');
}

// ── #11 跨天自动清零（不重启进程）──
{
  freshRoot();
  const call = fakeCall();
  for (let i = 0; i < 30; i += 1) await L.memLlm('summary', { messages: msgs(200), now: DAY1, call });
  assert.equal((await L.memLlm('summary', { messages: msgs(200), now: DAY1, call })).reason, 'quota');

  // 同进程、不同 dayKey：模拟"进程跨天没重启"
  const next = await L.memLlm('summary', { messages: msgs(200), now: DAY2, call });
  assert.equal(next.ok, true, '★ 跨天必须自动清零（不能依赖重启或定时器）');
  const st = L.getQuotaState();
  assert.equal(st.dayKey, L.dayKeyOf(DAY2));
  assert.equal(st.counts.summary, 1, '新的一天计数从 1 开始');
  assert.equal(st.tokens, 150, 'token 累计也要清零');
  ok('#11 跨天：dayKey 变化 → 配额与 token 自动清零，无需重启');
}

// ── #12 道 2 按 kind 分桶（第 2 期前置）：l1-refine 与 summary 各算各的 ──
{
  freshRoot();
  const call = fakeCall();
  for (let i = 0; i < 40; i += 1) {
    const r = await L.memLlm('l1-refine', { messages: msgs(200), now: DAY1, call });
    assert.equal(r.ok, true, `l1-refine 第 ${i + 1} 次应成功`);
  }
  const over = await L.memLlm('l1-refine', { messages: msgs(200), now: DAY1, call });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'quota', '★ 第 41 次 l1-refine 必须是 quota');
  assert.equal(over.limit, 40, `★ limit 必须报分桶值 40（不是兜底的 30），实际 ${over.limit}`);

  // 同一个 kind 打满后，另一个 kind 不能被连坐（分桶的意义就在这里）
  const s = await L.memLlm('summary', { messages: msgs(200), now: DAY1, call });
  assert.equal(s.ok, true, '★ l1-refine 打满不得影响 summary（共用一个计数器就是没分桶）');

  // config 覆盖：只给 l1-refine 5 次 → 第 6 次被拒。
  // 必须传全字段，否则其余三项各打一条 warn，6 次循环刷 18 行噪音。
  const cfg = { quotaPerDay: 30, tokenBudgetPerDay: 1400000, singleCallMaxTokens: 60000, kindQuota: { 'l1-refine': 5 } };
  P.setMem2Root(path.join(DATA, 'llm-cov-1'));
  L.resetQuota({ now: DAY1 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await L.memLlm('l1-refine', { messages: msgs(200), now: DAY1, call, cfg })).ok, true);
  }
  const covOver = await L.memLlm('l1-refine', { messages: msgs(200), now: DAY1, call, cfg });
  assert.equal(covOver.reason, 'quota', '★ config 里的 kindQuota 必须生效（第 6 次被拒）');
  assert.equal(covOver.limit, 5, `limit 应报 5，实际 ${covOver.limit}`);

  // 未登记的 kind 走兜底 quotaPerDay(30)：拼错 kind 也不会变成无限制
  freshRoot();
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await L.memLlm('foo', { messages: msgs(200), now: DAY1, call })).ok, true);
  }
  const fooOver = await L.memLlm('foo', { messages: msgs(200), now: DAY1, call });
  assert.equal(fooOver.reason, 'quota', '★ 未登记 kind 必须有兜底配额，不能裸奔');
  assert.equal(fooOver.limit, 30, `兜底 limit 应报 30，实际 ${fooOver.limit}`);
  ok('#12 道2 分桶：l1-refine 第 41 次拒(limit 40)/ summary 不受影响 / config 覆盖到 5 / 未登记 kind 走 30');
}

// ── 记账：成功调用要能在 usage.jsonl 里对上（本期唯一的"账单"）──
{
  freshRoot();
  const call = fakeCall({ prompt_tokens: 800, completion_tokens: 120, total_tokens: 920 });
  await L.memLlm('summary', { messages: msgs(500), now: DAY1, call });
  const rows = P.readJsonl(P.usageFile()).filter((x) => x.ok);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'summary');
  assert.equal(rows[0].promptTokens, 800);
  assert.equal(rows[0].completionTokens, 120);
  assert.equal(rows[0].totalTokens, 920);
  assert.ok(rows[0].ms >= 0);
  assert.equal(rows[0].model, 'fake-model');
  ok('记账：usage.jsonl 里 token/耗时/模型齐全（本期唯一能看见成本的地方）');
}

// ── 调用抛错：要记 call-error，且不消耗配额 ──
{
  freshRoot();
  const bad = async () => { throw new Error('upstream 500'); };
  const r = await L.memLlm('summary', { messages: msgs(200), now: DAY1, call: bad });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'call-error');
  assert.equal(L.getQuotaState().counts.summary || 0, 0, '失败的调用不占配额（否则一次网络抖动就烧掉一天）');
  const rows = P.readJsonl(P.usageFile()).filter((x) => x.code === 'call-error');
  assert.equal(rows.length, 1, 'call-error 要留痕');
  ok('调用失败：记 call-error、不占配额、不影响后续');
}

// 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── mem2-llm：${passed} 项通过`);
