// 第 1 期 · 第 3 步的单测：mem2 产物读写 + T2 的水位 / pending / 截断。
//
// 这一组测试守的是**静默丢数据**的四种形态（都不报错，只是数据没了）：
//   · 水位先于 coverage 推进   → 有人说过话的区间被判成 "没人说话"（撒谎）
//   · 截断时水位照跳           → 没处理的 conv 永久丢失
//   · 未截断时水位不推         → empty 永远推导不出来 + 每轮白扫
//   · pending 永远轮不到       → 老账一直缺（活锁，看起来功能正常）
//
// 覆盖施工单 §8.1 的：#13 #14 #22 #23 #24 #25 #26 #27 #28 #29
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mem2-store-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const SW = await import('../src/mem2/switch.js');
const M = await import('../src/mem2/store.js');
const L4 = await import('../src/mem2/index.js');
const { runT2Tick, RETRY_MAX } = L4;

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const MIN = 60 * 1000;
const T0 = new Date(2026, 10, 14, 10, 0, 0).getTime();

/** 每个用例一个独立的 mem2 根目录，互不污染。 */
let caseNo = 0;
function freshRoot() {
  caseNo += 1;
  P.setMem2Root(path.join(DATA, `case-${caseNo}`));
  return P.mem2Dir();
}

const mkMsg = (ts, self = false, text = 'x') => ({ mid: `m${ts}${self ? 's' : ''}`, ts, text, senderId: 'u1', senderName: '甲', self });

/** 假 store：只实现 T2 真正用到的两个方法（真实 rangeByTs 已在 mem2-conv 里验过）。 */
function fakeStore(msgsByChat) {
  return {
    listChats: () => Object.keys(msgsByChat),
    rangeByTs: (k, { fromTs = 0, toTs = Infinity } = {}) => (msgsByChat[k] || [])
      .filter((m) => (Number(m.ts) || 0) >= fromTs && (Number(m.ts) || 0) <= toTs)
  };
}

/** 造 n 个 conv：每个 2 条消息（1 分钟间隔），conv 之间隔 60 分钟。 */
function convMsgs(n, { base = T0, per = 60 * MIN, count = 2 } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < count; j += 1) out.push(mkMsg(base + i * per + j * MIN));
  }
  return out;
}

// ── #13 empty 四态推导（§2.3 的核心）──
{
  freshRoot();
  const K = 'group:900013';
  const lastScan = T0 + 60 * MIN;

  // 无记录 + to <= lastScan → empty（确定没人说话）
  assert.equal(M.queryState(K, { fromTs: T0, toTs: T0 + 10 * MIN, lastScanTs: lastScan }), 'empty',
    '★ 扫过且无记录 = 确认没人说话');
  // 无记录 + to > lastScan → 还没扫到（不确定，不能说 empty）
  assert.equal(M.queryState(K, { fromTs: T0, toTs: T0 + 120 * MIN, lastScanTs: lastScan }), 'unscanned',
    '★ 还没扫到 = 不确定，绝不能报 empty（那是撒谎）');

  const row = (state, extra = {}) => M.makeCoverageRow({
    chatKey: K, convStartTs: T0 + 5 * MIN, convEndTs: T0 + 10 * MIN,
    msgCount: 20, humanMsgCount: 12, state, ...extra
  });
  M.appendCoverage(K, row('pending'));
  assert.equal(M.queryState(K, { fromTs: T0, toTs: lastScan, lastScanTs: lastScan }), 'pending');

  M.appendCoverage(K, row('ok', { parseErrors: { topic: 0 } }));
  assert.equal(M.queryState(K, { fromTs: T0, toTs: lastScan, lastScanTs: lastScan }), 'ok', 'ok 优先');

  const K2 = 'group:900013b';
  M.appendCoverage(K2, M.makeCoverageRow({
    chatKey: K2, convStartTs: T0, convEndTs: T0 + MIN, msgCount: 20, humanMsgCount: 12, state: 'failed'
  }));
  assert.equal(M.queryState(K2, { fromTs: T0, toTs: lastScan, lastScanTs: lastScan }), 'failed',
    'failed 必须是"没记下"，不能退化成 empty');
  ok('#13 四态推导：ok/pending/failed/empty/unscanned 五种返回都正确（empty 与 unscanned 严格区分）');
}

// ── #14 安静时段水位照常推进（否则 empty 永远出不来）──
{
  freshRoot();
  const K = 'group:900014';
  P.setLastScanTs(K, T0);                       // 14:00 扫过
  const now = T0 + 3 * 60 * MIN;                // 现在 13:00？不：T0+3h，中间无人说话
  const st = fakeStore({ [K]: [] });
  await runT2Tick({ store: st, l4cfg: {}, now });

  const after = P.getLastScanTs(K);
  assert.equal(after, now - 30 * MIN,
    `★ 安静时段水位必须推到 now-30min（期望 ${now - 30 * MIN}，实际 ${after}）—— 卡住不动的话 empty 永远出不来`);
  assert.equal(M.queryState(K, { fromTs: T0 + 60 * MIN, toTs: T0 + 120 * MIN, lastScanTs: after }), 'empty',
    '★ 推进之后，这段才能被判成 empty（而不是"还没扫到"）');
  ok('#14 安静时段：水位推到 now−30min，且该区间随即能判为 empty');
}

// ── #22 coverage 写入失败时水位不得推进（顺序红线）──
{
  freshRoot();
  const K = 'group:900022';
  const msgs = convMsgs(1);
  const now = T0 + 3 * 60 * MIN;
  let threw = 0;
  const mem = {
    readCoverage: () => ({ rows: [], byStart: new Map(), list: [] }),
    pendingOf: () => [],
    appendCoverage: () => { threw += 1; throw new Error('disk full'); }
  };
  const st = fakeStore({ [K]: msgs });
  const stat = await runT2Tick({ store: st, mem, l4cfg: { bootstrapFromTs: T0 }, now });

  assert.equal(threw, 1, '前提：append 真的抛了');
  assert.equal(stat.writeErrors, 1);
  assert.equal(P.getLastScanTs(K), 0,
    '★ coverage 写失败时水位必须保持原值 —— 推进了就会让这段区间被误判成 empty（系统撒谎）');
  ok('#22 顺序红线：coverage 写不进去 → 水位不动（宁可下轮重复扫，也不能撒谎）');
}

// ── #23 pending 能被拾取（§5.3.1 的唯一自动化保障）──
{
  freshRoot();
  const K = 'group:900023';
  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: T0, convEndTs: T0 + 10 * MIN, msgCount: 20, humanMsgCount: 12,
    state: 'pending', attempts: 0
  }));
  const calls = [];
  const runConv = async (chatKey, row) => { calls.push(row.convStartTs); };
  const st = fakeStore({ [K]: [] });
  const stat = await runT2Tick({ store: st, l4cfg: {}, now: T0 + 60 * MIN, runConv });

  assert.equal(stat.retried, 1, `★ pending 必须被重试（retried=${stat.retried}）`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], T0, '拾取的应该是那条 pending');
  ok('#23 pending 拾取：水位早已推过去的旧账，仍能被重新捡起来处理');
}

// ── #24 先旧后新（防活锁）──
{
  freshRoot();
  const K = 'group:900024';
  const now = T0 + 5 * 60 * MIN;
  // 一条老 pending（比新会话旧得多）
  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: T0, convEndTs: T0 + 5 * MIN, msgCount: 20, humanMsgCount: 12,
    state: 'pending', attempts: 0
  }));
  // 一批新会话（水位 0 + bootstrap 指向更早，让它们都算"新"）
  const msgs = convMsgs(2, { base: T0 + 2 * 60 * MIN });
  const order = [];
  const runConv = async (chatKey, row) => { order.push(row.convStartTs); };
  await runT2Tick({ store: fakeStore({ [K]: msgs }), l4cfg: { bootstrapFromTs: T0 }, now, runConv });

  assert.ok(order.length >= 1, '至少应有调用');
  assert.equal(order[0], T0,
    `★ 第一个调用必须是那条老 pending（实际 ${order[0]}）—— 先跑新会话会造成活锁：配额永远被新会话吃掉，老账轮不到`);
  ok('#24 拾取顺序：pending 先于同轮的新会话（防活锁）');
}

// ── #25 attempts 用尽 → failed，且不再调 LLM ──
{
  freshRoot();
  const K = 'group:900025';
  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: T0, convEndTs: T0 + 10 * MIN, msgCount: 20, humanMsgCount: 12,
    state: 'pending', attempts: RETRY_MAX
  }));
  let called = 0;
  const runConv = async () => { called += 1; };
  const stat = await runT2Tick({ store: fakeStore({ [K]: [] }), l4cfg: {}, now: T0 + 60 * MIN, runConv });

  assert.equal(called, 0, '★ attempts 用尽后不能再调 LLM（否则一条坏数据每轮烧一次配额）');
  assert.equal(stat.exhausted, 1);
  const row = M.findCoverage(K, T0);
  assert.equal(row.state, 'failed');
  assert.equal(row.parseErrors.retry, 'retry-exhausted', 'parseErrors 要写清是重试用尽');
  ok(`#25 重试上限：attempts>=${RETRY_MAX} → failed + retry-exhausted，且零 LLM 调用`);
}

// ── #26 bootstrapFromTs 只生效一次 ──
{
  freshRoot();
  const K = 'group:900026';
  const msgs = convMsgs(3);
  const now = T0 + 4 * 60 * MIN;
  // ★ 记录每轮真的拿什么当起点：只看行为（有没有重复行）抓不到这个变异 ——
  //   已写过的 conv 会走 existing 分支跳过，重扫历史在后面看不见。
  const asked = [];
  const st = {
    listChats: () => [K],
    rangeByTs: (k, { fromTs = 0, toTs = Infinity } = {}) => {
      asked.push(fromTs);
      return msgs.filter((m) => (Number(m.ts) || 0) >= fromTs && (Number(m.ts) || 0) <= toTs);
    }
  };

  await runT2Tick({ store: st, l4cfg: { bootstrapFromTs: T0 }, now });
  const scan1 = P.getLastScanTs(K);
  const rows1 = M.readCoverage(K).list.length;
  assert.ok(rows1 >= 1, '第一轮应从 bootstrap 起点扫出会话');
  assert.ok(scan1 >= T0, '第一轮应写入水位');
  assert.equal(asked[0], T0, '首轮起点应等于 bootstrapFromTs');

  // 把起点改到更早：绝不能重扫历史
  const earlier = T0 - 10 * 24 * 60 * MIN;
  await runT2Tick({ store: st, l4cfg: { bootstrapFromTs: earlier }, now });
  assert.ok(asked[1] >= scan1,
    `★ 第二轮起点必须是已有水位 ${scan1}，而不是被 bootstrap 覆盖成 ${earlier}（实际 ${asked[1]}）`
    + ' —— 否则改一次配置就把整段历史重扫一遍');
  assert.equal(P.getLastScanTs(K), Math.max(scan1, now - 30 * MIN), '★ 已有水位时 bootstrap 必须失效');
  assert.equal(M.readCoverage(K).list.length, rows1, '不得因为改配置而重扫出新的历史会话');
  ok('#26 bootstrapFromTs：只在首次生效（第二轮起点即为已有水位，不会被配置覆盖）');
}

// ── #27 / #28 单轮上限 + 截断时水位不跳 ──
{
  freshRoot();
  const K = 'group:900027';
  const N = 25;
  const msgs = convMsgs(N);
  const lastTs = T0 + (N - 1) * 60 * MIN + MIN;
  const now = lastTs + 40 * MIN;
  const st = fakeStore({ [K]: msgs });
  const stat = await runT2Tick({ store: st, l4cfg: { bootstrapFromTs: T0, maxConvPerTick: 10 }, now });

  const rows = M.readCoverage(K).list;
  assert.equal(rows.length, 10, `#27 只应处理 10 个，实际写了 ${rows.length} 行`);
  assert.equal(stat.truncated, 1, '应标记为截断');
  assert.equal(rows.length + 15, N, '其余 15 个仍在待处理状态（没被写掉）');

  const tenth = rows[9];
  assert.equal(P.getLastScanTs(K), tenth.convEndTs,
    `★ 截断时水位必须停在第 10 个 conv 的 endTs（期望 ${tenth.convEndTs}，实际 ${P.getLastScanTs(K)}）`
    + ' —— 跳到 now-30min 会让剩下 15 个永久丢失，且不报任何错');
  assert.ok(P.getLastScanTs(K) < now - 30 * MIN, '截断时水位必然早于 now-30min（否则就是跳了）');
  ok('#27/#28 单轮上限：25 个只处理 10 个，水位停在第 10 个的 endTs（不跳、不丢）');

  // 再跑几轮能把剩下的处理完（证明"丢"是可恢复的）
  let rounds = 0;
  while (M.readCoverage(K).list.length < N && rounds < 10) {
    await runT2Tick({ store: st, l4cfg: { bootstrapFromTs: T0, maxConvPerTick: 10 }, now: now + (rounds + 1) * 10 * MIN });
    rounds += 1;
  }
  assert.equal(M.readCoverage(K).list.length, N, `连续跑几轮后应全部处理完（实际 ${M.readCoverage(K).list.length}/${N}）`);
  ok(`#27补 截断只是延后：连续 ${rounds + 1} 轮后 ${N} 个全部处理完，无丢失`);
}

// ── #29 未截断时水位照常推到 now-30min ──
{
  freshRoot();
  const K = 'group:900029';
  const msgs = convMsgs(3);
  const lastTs = T0 + 2 * 60 * MIN + MIN;
  const now = lastTs + 2 * 60 * MIN;
  const st = fakeStore({ [K]: msgs });
  await runT2Tick({ store: st, l4cfg: { bootstrapFromTs: T0, maxConvPerTick: 10 }, now });

  const scan = P.getLastScanTs(K);
  assert.ok(scan >= now - 30 * MIN - 60 * 1000,
    `★ 未截断时水位应推到 now-30min（期望 ≥ ${now - 30 * MIN}，实际 ${scan}）—— 否则安静时段 empty 出不来`);
  ok('#29 未截断：水位推到 now−30min，与 #28 的保守分支互补');
}

// ── #12 干跑：T2 照常算、产物零写入、水位照推 ──
{
  freshRoot();
  const K = 'group:900012';
  const msgs = convMsgs(3);
  const now = T0 + 5 * 60 * MIN;
  const logs = [];
  const stat = await runT2Tick({
    store: fakeStore({ [K]: msgs }),
    l4cfg: { bootstrapFromTs: T0, dryRun: true },
    now,
    log: (m) => logs.push(m)
  });

  assert.ok(stat.short + stat.pending === 3, `干跑也应算出 3 个会话，实际 ${stat.short + stat.pending}`);
  assert.ok(!fs.existsSync(P.coverageFile(K)), '★ 干跑不得写覆盖表（写错要清理的产物一律跳过）');
  assert.ok(logs.some((m) => m.includes('干跑')), '干跑要打日志，否则什么都看不见');
  const scan = P.getLastScanTs(K);
  assert.ok(scan >= now - 30 * MIN - 60 * 1000,
    '★ 干跑必须照推水位（否则每 10 分钟重复摘要同一批，干跑反而最烧钱）');
  ok('#12 干跑：算出 3 个会话、覆盖表零写入、水位照推、日志留痕');
}

// ── 真 store 贯通：真实 ChatStore + 真实 rangeByTs + 真实覆盖表 ──
{
  freshRoot();
  const K = 'group:900099';
  const { ChatStore } = await import('../src/store.js');
  const store = new ChatStore(0);
  // 两个会话：第一个 12 条（应 pending）、第二个 3 条（应 short），中间隔 2 小时
  for (let i = 0; i < 12; i += 1) {
    store.appendIncoming(K, { mid: `a${i}`, ts: T0 + i * MIN, senderId: 'u1', senderName: '甲', text: `话${i}` });
  }
  store.appendSelf(K, { text: '我回一句', ts: T0 + 13 * MIN });   // self 要计入 msgCount
  for (let i = 0; i < 3; i += 1) {
    store.appendIncoming(K, { mid: `b${i}`, ts: T0 + 120 * MIN + i * MIN, senderId: 'u2', senderName: '乙', text: `后${i}` });
  }
  const now = T0 + 180 * MIN;
  await runT2Tick({ store, l4cfg: { bootstrapFromTs: T0, maxConvPerTick: 10 }, now });

  const rows = M.readCoverage(K).list;
  assert.equal(rows.length, 2, `应切出 2 个会话并记账，实际 ${rows.length}`);
  assert.equal(rows[0].msgCount, 13, '★ 第一个会话 12 条群友 + 1 条机器人 = 13（self 计入 msgCount）');
  assert.equal(rows[0].humanMsgCount, 12, '★ humanMsgCount 只数群友（13 − 1）');
  assert.equal(rows[0].state, 'pending', '13 >= 10 → pending 排队');
  assert.equal(rows[1].msgCount, 3);
  assert.equal(rows[1].state, 'short', '3 < 10 → short 终态');
  assert.equal(rows[0].chatKey, K, 'chatKey 要落盘（消息条目里没有它，得从遍历上下文带过来）');
  ok('真 store 贯通：切分 + 两个计数 + state 判定 + 落盘全对（self 计入总数、不计入群友数）');
}

// ── startL4 的挂载/卸载（app.js 只调这一个入口）──
{
  freshRoot();
  const K = 'group:900031';
  const st = fakeStore({ [K]: convMsgs(1) });
  const now = T0 + 2 * 60 * MIN;

  assert.equal(L4.startL4({ store: st, l4cfg: { enabled: false } }), null,
    '★ enabled:false 必须返回 null（默认关，不挂定时器）');

  const logs = [];
  const h = L4.startL4({
    store: st, l4cfg: { enabled: true, bootstrapFromTs: T0, tickMs: 600000 },
    log: (m) => logs.push(m), now: () => now
  });
  assert.ok(h && typeof h.stop === 'function', '启用时应返回可停止的句柄');
  assert.ok(logs.some((m) => m.includes('[l4] 已启用')), '启用要打一行日志（否则不知道它在跑）');

  await h.tick();                                  // 手动跑一轮（真定时器是 10 分钟）
  assert.equal(M.readCoverage(K).list.length, 1, 'tick 应真的跑了一轮 T2 并落盘');
  assert.ok(P.getLastScanTs(K) > 0, 'tick 后水位应有值');

  h.stop();
  const before = M.readCoverage(K).list.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(M.readCoverage(K).list.length, before, 'stop 之后不应再有新的写入');
  ok('startL4：默认关时返回 null；启用后 tick 能跑、stop 能停（app.js 只依赖这两个行为）');
}

// ── #2b（第 5 期）switchTs 不被水位写入抹掉 ──
//
// 守的是第 5 期最阴的一条：`readSchema` 原来是白名单重建（只返回 3 个字段），
// 而 `setLastScanTs` 是「读 → 改 → 整体写回」——手工写进 schema.json 的 switchTs
// **在读的那一刻就没了**，下一个 tick 落盘后文件里也没有。现象是「明明写了却没有」，
// 守卫失效 → 旧模块恢复双写，而日志一切正常。
{
  freshRoot();
  const K = 'group:900026';
  const SWITCH = 1794773220000;          // 11-16 04:07，硬切实际生效时刻

  P.initSchema();
  SW.setSwitchTs(SWITCH);
  assert.equal(P.readSchema().switchTs, SWITCH, '写进去必须能读出来（透传）');

  P.setLastScanTs(K, T0);
  P.setLastScanTs(K, T0 + MIN);
  P.setLastScanTs(K, T0 + 2 * MIN);

  assert.equal(P.readSchema().switchTs, SWITCH, '连调三次 setLastScanTs 后 switchTs 仍在（内存读回）');
  const raw = JSON.parse(fs.readFileSync(path.join(P.mem2Dir(), 'schema.json'), 'utf8'));
  assert.equal(raw.switchTs, SWITCH, '落盘文件里也必须在（读→改→写回不能只写白名单字段）');
  assert.equal(P.getLastScanTs(K), T0 + 2 * MIN, '水位本身也要照常推进（修透传不能把水位弄坏）');

  // 缓存必须跟着文件走：外部改了文件（另一个进程写的），下一次读要拿到新值
  const raw2 = { ...raw }; delete raw2.switchTs;
  fs.writeFileSync(path.join(P.mem2Dir(), 'schema.json'), JSON.stringify(raw2, null, 2), 'utf8');
  SW.invalidateSchemaCache();            // 模拟「另一个进程写完、本进程 mtime 变了」
  assert.equal(SW.getSwitchTs(), 0, 'switchTs 被删掉后要立刻读到 0（缓存不能粘住旧值）');

  SW.setSwitchTs(SWITCH);
  assert.equal(SW.getSwitchTs(), SWITCH);
  ok('#2b switchTs 透传：连调三次水位写入仍在、落盘文件里有、缓存不粘旧值');
}

// ── findCoverageByEnd 的边界（第 5 期补丁 §七.1 要求自测）──
{
  freshRoot();
  const K = 'group:900027';
  const a0 = T0, a1 = T0 + 20 * MIN, b1 = T0 + 40 * MIN;
  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: a0, convEndTs: a1, msgCount: 21, humanMsgCount: 15, state: 'failed'
  }));
  M.appendCoverage(K, M.makeCoverageRow({
    chatKey: K, convStartTs: a1, convEndTs: b1, msgCount: 21, humanMsgCount: 15, state: 'ok'
  }));
  const cov = M.readCoverage(K);

  assert.equal(M.findCoverageByEnd(cov, a1).convStartTs, a0,
    '首尾相接的边界点上，必须返回「终点正好是它」的那一行（不能靠遍历顺序碰运气）');
  assert.equal(M.findCoverageByEnd(cov, a0).convStartTs, a0, '左端点算命中');
  assert.equal(M.findCoverageByEnd(cov, b1).convStartTs, a1, '右端点算命中');
  assert.equal(M.findCoverageByEnd(cov, a0 - 1), null, '区间外返回 null');
  assert.equal(M.findCoverageByEnd(cov, 0), null, '非法 ts 返回 null');
  assert.equal(M.findCoverageByEnd(null, a0), null, 'cov 为 null 不抛错');
  ok('findCoverageByEnd：边界点归属确定、两端点算命中、区间外/非法/空表都返回 null');
}

// ── l4 按月分片（第 5 步 T4 要依赖它）──
{
  freshRoot();
  const K = 'group:900030';
  const nov = new Date(2026, 10, 14, 12, 0, 0).getTime();
  const dec = new Date(2026, 11, 2, 12, 0, 0).getTime();
  M.appendL4(K, { chatKey: K, convStartTs: nov, summary: '十一月' });
  M.appendL4(K, { chatKey: K, convStartTs: dec, summary: '十二月' });

  assert.ok(fs.existsSync(path.join(P.chatDir(K), 'l4', '2026-11.jsonl')), 'l4 必须按月分片（2026-11）');
  assert.ok(fs.existsSync(path.join(P.chatDir(K), 'l4', '2026-12.jsonl')), 'l4 必须按月分片（2026-12）');
  assert.equal(M.readL4(K, '2026-11').length, 1);
  assert.equal(M.readL4(K, '2026-11')[0].summary, '十一月');
  ok('l4 按月分片：跨月各自落盘，读回不串月');
}

// 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── mem2-store：${passed} 项通过`);
