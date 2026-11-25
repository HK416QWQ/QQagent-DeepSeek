// 第 4 期 · 检索带会话摘要头（2b）的单测。
//
// 这一层只做「给已有检索结果加一行上下文」，不动检索本身。守四件事：
//   · 二分语义写死「不回溯」——嵌套重叠时「任一包含」会给另一行
//   · 二分定位只返回覆盖行；状态过滤在调用方（摘要头只认 ok）
//   · 关闭时提示词逐字节不变（旧口径 200 字不能回退成 320）
//   · 任何异常都不许拖垮原文注入
//
// 覆盖施工单 §4 的 #1–#7。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-recall-head-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const M = await import('../src/mem2/store.js');
const R = await import('../src/auto-recall.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

let caseNo = 0;
function freshRoot() {
  caseNo += 1;
  P.setMem2Root(path.join(DATA, `case-${caseNo}`));
  return P.mem2Dir();
}

const K = 'group:800001';
const T0 = new Date(2026, 10, 12, 20, 0, 0).getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const conv = (startTs, durMs = HOUR, state = 'ok', over = {}) => ({
  chatKey: K, convStartTs: startTs, convEndTs: startTs + durMs,
  msgCount: 20, humanMsgCount: 18, state, ...over
});

// 线性扫描基准 —— **必须与二分同一「不回溯」语义**：
// 按 start 升序找「最后一个 start <= t」，只看它；它已结束就返回 null，
// 绝不回退到更早的包含区间（那是「任一包含」语义，嵌套重叠时结果不同）。
function linearFind(list, ts) {
  const arr = (Array.isArray(list) ? list : [])
    .filter((r) => Number.isFinite(Number(r?.convStartTs)) && Number.isFinite(Number(r?.convEndTs)))
    .sort((a, b) => Number(a.convStartTs) - Number(b.convStartTs));
  let best = null;
  for (const r of arr) if (Number(r.convStartTs) <= ts) best = r;
  if (!best) return null;
  return ts <= Number(best.convEndTs) ? best : null;
}

// ── #1 findConvRow：端点、空档、早于全部 ──
{
  // 三段：[1000,2000] [5000,6000] [9000,11000]，中间留空档
  const list = [conv(1000, 1000), conv(5000, 1000), conv(9000, 2000)];
  assert.equal(M.findConvRow(list, 1000)?.convStartTs, 1000, '★ ts == convStartTs 算命中（左闭）');
  assert.equal(M.findConvRow(list, 2000)?.convStartTs, 1000, '★ ts == convEndTs 算命中（右闭）');
  assert.equal(M.findConvRow(list, 5000)?.convStartTs, 5000);
  assert.equal(M.findConvRow(list, 6000)?.convStartTs, 5000);
  assert.equal(M.findConvRow(list, 11000)?.convStartTs, 9000);
  assert.equal(M.findConvRow(list, 3000), null, '两段之间的空档 → null');
  assert.equal(M.findConvRow(list, 500), null, '早于全部会话 → null');
  assert.equal(M.findConvRow([], 1000), null, '空表 → null');
  assert.equal(M.findConvRow(list, NaN), null, '非法 ts → null');
  // 缺 convEndTs 的行不能当成「无限长会话」
  assert.equal(M.findConvRow([{ convStartTs: 100, convEndTs: undefined, state: 'ok' }], 150), null,
    '★ 缺 convEndTs → null（不许当成 open-ended）');
  ok('#1 findConvRow：两端点命中、空档/早于全部/空表/非法 ts 全返回 null');
}

// ── #2 二分与线性扫描一致（含嵌套重叠）──
{
  // 20 段不连续会话
  const gaps = [];
  for (let i = 0; i < 20; i += 1) gaps.push(conv(T0 + i * 3 * HOUR, HOUR));
  // 100 个伪随机 ts（固定种子，可复现）
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const span = 20 * 3 * HOUR;
  for (let i = 0; i < 100; i += 1) {
    const ts = T0 + Math.floor(rnd() * span);
    const a = M.findConvRow(gaps, ts);
    const b = linearFind(gaps, ts);
    assert.equal(a?.convStartTs ?? null, b?.convStartTs ?? null, `ts=${ts - T0} 处二分与线性不一致`);
  }

  // 嵌套重叠：[0,3000] 与 [1000,6000] 与 [2000,2500]
  const nested = [conv(0, 3000), conv(1000, 5000), conv(2000, 500)];
  for (const ts of [0, 500, 1000, 1500, 2000, 2400, 2600, 3000, 3500, 5999, 6000, 6001]) {
    assert.equal(M.findConvRow(nested, ts)?.convStartTs ?? null, linearFind(nested, ts)?.convStartTs ?? null,
      `嵌套重叠 ts=${ts} 处二分与线性不一致`);
  }
  assert.equal(M.findConvRow(nested, 1500)?.convStartTs, 1000,
    '嵌套时取「最后一个 start ≤ t」= 1000 那行');
  assert.equal(M.findConvRow(nested, 2600), null,
    '★ 不回溯语义：最后一个 start≤t 的会话（2000）已结束 → null，绝不回退到仍在区间内的 [1000,6000]');
  assert.equal(linearFind(nested, 2600), null, '线性基准同意（否则说明基准写成了「任一包含」语义）');
  ok('#2 二分正确性：20 段 × 100 随机 ts、嵌套重叠 12 个点，结果与线性扫描完全一致（两者都是「不回溯」）');
}

// ── #4 readSummaryForConv：last-wins、空摘要降级、sparse 不降级 ──
{
  const root = freshRoot();
  const okConv = T0;
  const sparseConv = T0 + 3 * HOUR;
  const emptyConv = T0 + 6 * HOUR;
  const oneLineConv = T0 + 9 * HOUR;

  M.appendL4(K, { chatKey: K, convStartTs: okConv, convEndTs: okConv + HOUR, summary: '第一版摘要', sparse: false, topics: [], entities: [], createdAt: T0 });
  M.appendL4(K, { chatKey: K, convStartTs: okConv, convEndTs: okConv + HOUR, summary: '重跑后的第二版摘要', sparse: false, topics: [], entities: [], createdAt: T0 + 1000 });
  M.appendL4(K, { chatKey: K, convStartTs: sparseConv, convEndTs: sparseConv + HOUR, summary: '半夜几个人在刷图，代理人聊刘莳剧情', sparse: true, topics: [], entities: [], createdAt: sparseConv });
  M.appendL4(K, { chatKey: K, convStartTs: emptyConv, convEndTs: emptyConv + HOUR, summary: '   ', sparse: false, topics: [], entities: [], createdAt: emptyConv });
  M.appendL4(K, { chatKey: K, convStartTs: oneLineConv, convEndTs: oneLineConv + HOUR, summary: '只有一条', sparse: false, topics: [], entities: [], createdAt: oneLineConv });

  const r1 = M.readSummaryForConv(K, okConv);
  assert.equal(r1.summary, '重跑后的第二版摘要', '★ 同 convStartTs 多行取最后一行（append-only last-wins）');
  assert.equal(r1.convStartTs, okConv);

  const r2 = M.readSummaryForConv(K, sparseConv);
  assert.ok(r2, '★ sparse=1 不降级（实测 26/26 都有正文，一刀切会丢 57%）');
  assert.equal(r2.sparse, true, 'sparse 要记进返回值（供 stats 观察）');
  assert.ok(r2.summary.includes('刷图'));

  assert.equal(M.readSummaryForConv(K, emptyConv), null, '纯空白摘要 → null（降级）');
  assert.equal(M.readSummaryForConv(K, T0 + 100 * HOUR), null, '没有该会话的 L4 → null');
  assert.equal(M.readSummaryForConv(K, 0), null, '非法 convStartTs → null');

  // 跨月：convStartTs 落在上个月，readL4 要按 ymOf(convStartTs) 读
  const lastMonth = new Date(2026, 9, 25, 21, 0, 0).getTime();
  M.appendL4(K, { chatKey: K, convStartTs: lastMonth, convEndTs: lastMonth + HOUR, summary: '上个月的会话摘要', sparse: false, topics: [], entities: [], createdAt: lastMonth });
  assert.equal(M.readSummaryForConv(K, lastMonth)?.summary, '上个月的会话摘要', '★ 按 convStartTs 的月份读，跨月不会错位');
  assert.ok(root);
  ok('#4 readSummaryForConv：last-wins、空摘要 null、sparse 不降级、跨月按 convStartTs 读');
}

// ── #3 判据：命中分布（同会话 ≥2 且占比 ≥50%）──
{
  const covList = [
    { convStartTs: 1000, convEndTs: 5000, state: 'ok' },
    { convStartTs: 9000, convEndTs: 12000, state: 'ok' },
    { convStartTs: 20000, convEndTs: 22000, state: 'short' }
  ];
  const cfg = { enabled: true, minHitsInSameConv: 2, sameConvRatio: 0.5, maxChars: 100, extraBudget: 120 };
  const deps = {
    readCoverage: () => ({ list: covList }),
    readSummaryForConv: (k, s) => ({ summary: '那晚在聊稻草人同人文', convStartTs: s, convEndTs: 0, sparse: false })
  };
  const call = (tsList, c = cfg, d = deps) => R.buildSummaryHead(K, tsList, c, d);

  const a = call([1100, 1200, 1300, 9500]);
  assert.equal(a.stat.attached, true, '★ 3/4 条同会话 → 会话级，带摘要头');
  assert.equal(a.stat.convStartTs, 1000);
  assert.ok(a.line.startsWith('[会话 '), '渲染以 [会话 MM-DD HH:MM] 开头');

  const b = call([1100, 1200, 9500, 999999]);   // 2 同会话 / 4 条命中 = 恰好 50%
  assert.equal(b.stat.attached, true, '★ 占比恰好 50% → 仍算会话级（阈值是 < 才拒）');

  const c = call([1100, 9500]);
  assert.equal(c.stat.attached, false, '★ 2 条分散在两个会话（各 1）→ 事件级');
  assert.equal(c.stat.reason, 'event-level');

  assert.equal(call([]).stat.reason, 'event-level', '空 hitTsList → 事件级（无从判断）');
  assert.equal(call([1100]).stat.reason, 'event-level', '只有 1 条命中 → 事件级');

  // minHitsInSameConv 调高到 3 后，2 条同会话就不再带
  const strict = call([1100, 1200, 9500, 999999], { ...cfg, minHitsInSameConv: 3 });
  assert.equal(strict.stat.attached, false, '★ 门槛可配：minHits 提到 3 时 2 条同会话不带');
  ok('#3 判据：3/4 同会话 attached、恰好 50% attached、分散/单条/空 → event-level、门槛可配');
}

// ── #4（渲染侧）short → no-l4、无覆盖 → no-coverage、sparse 仍 attached ──
{
  const covList = [
    { convStartTs: 1000, convEndTs: 5000, state: 'short' },
    { convStartTs: 9000, convEndTs: 12000, state: 'ok' }
  ];
  const cfg = { enabled: true, minHitsInSameConv: 2, sameConvRatio: 0.5, maxChars: 100 };
  const deps = {
    readCoverage: () => ({ list: covList }),
    readSummaryForConv: (k, s) => (s === 9000
      ? { summary: '半夜几个人在刷图，代理人聊刘莳剧情', convStartTs: s, convEndTs: 0, sparse: true }
      : null)
  };

  const short = R.buildSummaryHead(K, [1100, 1200], cfg, deps);
  assert.equal(short.stat.attached, false);
  assert.equal(short.stat.reason, 'no-l4', '★ state=short → no-l4（没有摘要可带，不是崩溃）');
  assert.equal(short.line, '', '不带摘要头时那一行为空');

  const noCov = R.buildSummaryHead(K, [50000, 50001], cfg, deps);
  assert.equal(noCov.stat.reason, 'no-coverage', '覆盖表没有该时间段 → no-coverage');

  const sparse = R.buildSummaryHead(K, [9100, 9200], cfg, deps);
  assert.equal(sparse.stat.attached, true, '★ sparse=1 仍然带（一刀切会丢 57% 的可用摘要）');
  assert.equal(sparse.stat.sparse, true, 'sparse 只做标记，不参与「带不带」');

  const noL4 = R.buildSummaryHead(K, [9100, 9200], cfg, { ...deps, readSummaryForConv: () => null });
  assert.equal(noL4.stat.reason, 'no-l4', '会话 ok 但 L4 缺失/为空 → no-l4');
  ok('#4 渲染侧：short→no-l4、无覆盖→no-coverage、sparse 照常 attached、空摘要→no-l4');
}

// ── #5 预算：摘要 300 字截到 100；attached ≤320；未 attached ≤200 ──
// ── #6 enabled=false 逐字节不变 ──
// ── #7 异常 → 原文照常 + reason=error ──
{
  const NICK = '测试机';
  const OPT = { selfNickname: NICK, botName: NICK, selfId: '10000' };
  const hitTs = [1100, 1200, 1300, 1400];
  const fakeStore = {
    search: () => ({
      totalHits: 4,
      messages: hitTs.map((ts, i) => ({ ts, senderName: `群友${i}`, text: `第 ${i} 条原始消息内容` }))
    })
  };
  const trig = [{ mid: 1, ts: 999, text: `@${NICK} 你还记得那天聊的稻草人同人文吗` }];
  const covList = [{ convStartTs: 1000, convEndTs: 5000, state: 'ok' }];
  const longSummary = '这是一段很长的摘要'.repeat(40);        // 400 字，必被截

  const deps = {
    readCoverage: () => ({ list: covList }),
    readSummaryForConv: (k, s) => ({ summary: longSummary, convStartTs: s, convEndTs: 0, sparse: false })
  };
  const on = { enabled: true, maxChars: 100, minHitsInSameConv: 2, sameConvRatio: 0.5, extraBudget: 120 };

  const rOn = R.buildAutoRecall(fakeStore, K, trig, { ...OPT, summaryHead: on, summaryHeadDeps: deps });
  assert.equal(rOn.stats.summaryHead.attached, true);
  assert.ok(rOn.stats.summaryHead.chars <= 17 + 101 + 2, `摘要行要截到 100 字（实测 ${rOn.stats.summaryHead.chars}）`);
  assert.ok([...rOn.text].length <= 320, `★ attached 总长 ≤320（实测 ${[...rOn.text].length}）`);
  assert.ok(rOn.text.includes('[会话 '), '摘要行出现在【回溯命中】里');
  // 摘要行必须在正文之前（末尾硬截才不会切掉它）
  const lines = rOn.text.split('\n');
  assert.ok(lines[1].startsWith('[会话 '), '★ 摘要行是第 2 行（HEAD 之后、消息行之前）');

  // 未 attached → 旧口径 200，一个字节不多
  const rOff = R.buildAutoRecall(fakeStore, K, trig, { ...OPT, summaryHead: { ...on, enabled: false } });
  const rNone = R.buildAutoRecall(fakeStore, K, trig, OPT);
  assert.equal(rOff.text, rNone.text, '★ enabled=false 与完全不传 summaryHead 逐字节相同');
  assert.ok([...rOff.text].length <= 200, `★ 未 attached 时 ≤200（旧口径不回退，实测 ${[...rOff.text].length}）`);
  assert.ok(!rOff.text.includes('[会话 '), '关闭时不许出现摘要行');
  assert.equal(rOff.stats.summaryHead.reason, 'disabled');

  // #7 异常：读覆盖表抛错 → 原文照常、reason=error
  const boom = {
    readCoverage: () => { throw new Error('coverage 文件损坏'); },
    readSummaryForConv: () => { throw new Error('不该走到这里'); }
  };
  const rErr = R.buildAutoRecall(fakeStore, K, trig, { ...OPT, summaryHead: on, summaryHeadDeps: boom });
  assert.ok(rErr.text && !rErr.text.includes('[会话 '), '★ 异常时原文照常注入、只是不带摘要头');
  assert.equal(rErr.stats.summaryHead.reason, 'error');
  assert.equal(rErr.stats.summaryHead.attached, false, '不抛给主线');

  // 摘要函数本身抛错也一样
  const boom2 = { readCoverage: () => ({ list: covList }), readSummaryForConv: () => { throw new Error('L4 读坏'); } };
  const rErr2 = R.buildAutoRecall(fakeStore, K, trig, { ...OPT, summaryHead: on, summaryHeadDeps: boom2 });
  assert.ok(rErr2.text && rErr2.stats.summaryHead.reason === 'error');
  ok('#5/#6/#7 预算 320/200、摘要截 100、摘要行在正文前、关闭逐字节一致、异常降级不抛');
}

// 收尾
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── mem2-recall-summary：${passed} 项通过`);
