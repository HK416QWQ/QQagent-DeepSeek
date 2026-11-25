// 第 1 期 · 第 1 + 2 + 2.5 步的单测：paths / 会话切分 / store.rangeByTs。
//
// 这三步全是零风险的（不调 LLM、不写产物），所以单测可以做得比较狠：
// 边界条件写死，后面任何一步改坏了这里先红。
//
// 覆盖施工单 §8.1 的：#1 #2 #3(纯判据部分) #4 #15 #17(rangeByTs 部分)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mem2-conv-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const { splitConvs, t2State, t3Blocked, GAP_MS } = await import('../src/mem2/conv.js');
const { ChatStore } = await import('../src/store.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const MIN = 60 * 1000;
// 固定基准时刻，避免"跑测试时刚好跨零点"导致偶发失败
const T0 = new Date(2026, 10, 14, 21, 0, 0).getTime();   // 2026-11-14 21:00 本地

const mk = (ts, text = 'x', self = false) => ({ mid: `m${ts}`, ts, text, senderId: 'u1', senderName: '甲', self });

// ── 第 1 步：paths + schema ──
{
  P.setMem2Root(path.join(DATA, 'mem2'));
  const s0 = P.initSchema();
  assert.equal(s0.schemaVersion, 1, 'schemaVersion 应为 1');
  assert.ok(s0.createdAt > 0, 'initSchema 应写 createdAt');
  assert.ok(fs.existsSync(P.schemaFile()), 'schema.json 应已落盘');

  assert.equal(P.getLastScanTs('group:1'), 0, '没扫过 → 0（由 bootstrapFromTs 决定起点）');
  assert.equal(P.setLastScanTs('group:1', T0), T0);
  assert.equal(P.getLastScanTs('group:1'), T0, '能读回刚写的水位');
  assert.equal(P.getLastScanTs('group:2'), 0, '不同群的水位互不影响');

  // initSchema 幂等：已有 createdAt 时不得覆盖（否则重置水位）
  const s1 = P.initSchema();
  assert.equal(s1.createdAt, s0.createdAt, 'initSchema 重复调用不得重写 createdAt');
  assert.equal(P.getLastScanTs('group:1'), T0, 'initSchema 不得冲掉水位');

  // 目录名 ↔ chatKey
  assert.equal(P.safeKey('group:999900001'), 'group_999900001');
  assert.equal(P.chatKeyFromDir('group_999900001'), 'group:999900001');
  assert.equal(P.chatKeyFromDir('private_123456'), 'private:123456');
  assert.equal(P.chatKeyFromDir('nodash'), '', '没有下划线的目录名不是合法 chatKey');

  // 月度分片名按本地时间
  assert.equal(P.ymOf(new Date(2026, 10, 14, 23, 59).getTime()), '2026-11');
  assert.equal(P.ymOf(new Date(2026, 0, 1, 0, 0).getTime()), '2026-01');

  // append / readJsonl：坏行跳过，不抛
  P.appendLine(path.join(DATA, 'mem2', 'probe.jsonl'), { a: 1 });
  fs.appendFileSync(path.join(DATA, 'mem2', 'probe.jsonl'), '{坏行\n', 'utf8');
  P.appendLine(path.join(DATA, 'mem2', 'probe.jsonl'), { a: 2 });
  const rows = P.readJsonl(path.join(DATA, 'mem2', 'probe.jsonl'));
  assert.equal(rows.length, 2, '坏行应被跳过，好行不能连坐');
  ok('第1步 paths：schema 幂等、水位能读能写、目录名互转、坏行跳过');
}

// ── #1 间隔 29min 不断、31min 断（边界精确）──
{
  const r = splitConvs([
    mk(T0),
    mk(T0 + 29 * MIN),          // 29 分钟：同一个 conv
    mk(T0 + 29 * MIN + 31 * MIN) // 再 31 分钟：新 conv
  ], { nowTs: T0 + 3 * 60 * MIN });
  assert.equal(r.closed.length + (r.open ? 1 : 0), 2, `应切成 2 段，实际 ${r.closed.length}+${r.open ? 1 : 0}`);
  assert.equal(r.closed[0].msgCount, 2, '29 分钟不断：前两条同段');
  assert.equal(r.closed[1].msgCount, 1, '31 分钟断：第三条自己一段');

  // 恰好在 30 分钟：不算断（规则是 > 30min）
  const r2 = splitConvs([mk(T0), mk(T0 + GAP_MS)], { nowTs: T0 + 60 * MIN });
  assert.equal(r2.closed.length, 1, '恰好 30 分钟不应切断（判据是 > 30min）');
  assert.equal(r2.closed[0].msgCount, 2);
  ok('#1 切分边界：29min 不断 / 恰好 30min 不断 / 31min 断');
}

// ── #2 跨零点不断（实测 12.2% 的会话跨自然日）──
{
  const before = new Date(2026, 10, 14, 23, 50).getTime();
  const after = new Date(2026, 10, 15, 0, 10).getTime();   // 20 分钟后
  const r = splitConvs([mk(before), mk(before + 5 * MIN), mk(after)], { nowTs: after + 60 * MIN });
  assert.equal(r.closed.length, 1, '跨零点应按 ts 间隔切，不看自然日');
  assert.equal(r.closed[0].msgCount, 3);
  assert.equal(new Date(r.closed[0].startTs).getDate(), 14, '起点在前一天');
  assert.equal(new Date(r.closed[0].endTs).getDate(), 15, '终点在后一天');
  ok('#2 跨零点不断：按 ts 间隔切，与自然日边界无关');
}

// ── #3 short 判据（纯函数部分）──
{
  const short = { msgCount: 9, humanMsgCount: 9 };
  const enough = { msgCount: 10, humanMsgCount: 10 };
  assert.equal(t2State(short), 'short', '<10 条 → short（终态，不进 T3）');
  assert.equal(t2State(enough), 'pending', '>=10 条 → pending 排队');
  // ★ T2/T3 两个口径必须不同：100 条里群友只说 5 句
  const botHeavy = { msgCount: 100, humanMsgCount: 5 };
  assert.equal(t2State(botHeavy), 'pending', 'T2 看总条数 100 → 排队');
  assert.equal(t3Blocked(botHeavy), true, '★ T3 看群友条数 5 < 10 → 不调 LLM（口径不同，不能混用）');
  assert.equal(t3Blocked(enough), false);
  ok('#3 short 判据：T2 用总条数、T3 用群友条数，同一条数据两个结论是设计如此');
}

// ── #4 6h 兜底：连续不断的群也会强制关闭 ──
{
  // 每 20 分钟一条，连续 7 小时（永远不会因 30min 间隔关闭）
  const msgs = [];
  for (let i = 0; i * 20 * MIN <= 7 * 60 * MIN; i += 1) msgs.push(mk(T0 + i * 20 * MIN));
  const nowTs = T0 + 7 * 60 * MIN + 10 * MIN;    // 最后一条刚过 10 分钟
  const r = splitConvs(msgs, { nowTs });
  assert.ok(r.closed.length >= 1, '6h 兜底必须至少关掉一段，否则永远不产出');
  const c = r.closed[0];
  assert.ok(c.endTs - c.startTs >= 6 * 60 * MIN, '被强制关闭的那段本身要够长');
  // 最后一条距 now 只有 10 分钟（< 30min），若只按间隔判就永远不关
  assert.ok(nowTs - msgs[msgs.length - 1].ts < GAP_MS, '前提：最后一条仍在静默窗口内');
  ok(`#4 6h 兜底：连续 7 小时的群被强制关闭（${r.closed.length} 段已关）`);
}

// ── #15 rangeByTs：区间语义含两端（真实 ChatStore，只读）──
{
  const st = new ChatStore(0);
  const K = 'group:900015';
  st.appendIncoming(K, { mid: 'a', ts: 100, senderId: 'u1', senderName: '甲', text: '一' });
  st.appendIncoming(K, { mid: 'b', ts: 200, senderId: 'u1', senderName: '甲', text: '二' });
  st.appendIncoming(K, { mid: 'c', ts: 300, senderId: 'u1', senderName: '甲', text: '三' });

  const fileBefore = fs.readFileSync(path.join(DATA, 'messages', 'group_900015', '1970-01.jsonl'), 'utf8');
  const mtimeBefore = fs.statSync(path.join(DATA, 'messages', 'group_900015', '1970-01.jsonl')).mtimeMs;

  const r1 = st.rangeByTs(K, { fromTs: 200 });
  assert.equal(r1.length, 2, '★ fromTs 那条必须在结果里（两端都含）');
  assert.deepEqual(r1.map((m) => m.ts), [200, 300]);

  const r2 = st.rangeByTs(K, { fromTs: 0, toTs: 200 });
  assert.deepEqual(r2.map((m) => m.ts), [100, 200], 'toTs 也含');

  assert.equal(st.rangeByTs(K, { fromTs: 301 }).length, 0, '区间外返回空');
  assert.equal(st.rangeByTs(K, { fromTs: 50, toTs: 80 }).length, 0, '完全不相交返回空');

  // 只读：读操作不得改存档文件（这是给"以后有人顺手整理"设的闸）
  const fileAfter = fs.readFileSync(path.join(DATA, 'messages', 'group_900015', '1970-01.jsonl'), 'utf8');
  const mtimeAfter = fs.statSync(path.join(DATA, 'messages', 'group_900015', '1970-01.jsonl')).mtimeMs;
  assert.equal(fileAfter, fileBefore, '★ rangeByTs 不得改动存档内容');
  assert.equal(mtimeAfter, mtimeBefore, '★ rangeByTs 不得触发落盘（mtime 不变）');
  ok('#15 rangeByTs：两端含边界、不相交返回空、且不产生任何写盘');
}

// ── #17 rangeByTs 的 self / visibleOnly 语义（这一步只验取值，标记格式在第 5 步）──
{
  const st = new ChatStore(0);
  const K = 'group:900017';
  st.appendIncoming(K, { mid: 'h1', ts: 1000, senderId: 'u1', senderName: '甲', text: '群友的话' });
  st.appendSelf(K, { text: '机器人自己的话', ts: 1001 });
  st.appendIncoming(K, { mid: 'h2', ts: 1002, senderId: 'u2', senderName: '乙', text: '会被撤回' });
  st.markRecalled(K, 'h2');

  const withSelf = st.rangeByTs(K, { fromTs: 0, visibleOnly: true, includeSelf: true });
  assert.equal(withSelf.length, 2, `★ visibleOnly:true 不得把 self 滤掉（实际 ${withSelf.length} 条）`);
  assert.ok(withSelf.some((m) => m.self), '★ 必须能取到机器人自己的发言（要当对话背景，见 §3.2.0）');
  assert.ok(!withSelf.some((m) => m.mid === 'h2'), '撤回的消息必须被滤掉');

  const noSelf = st.rangeByTs(K, { fromTs: 0, visibleOnly: true, includeSelf: false });
  assert.equal(noSelf.length, 1, 'includeSelf:false 才排除机器人（两个参数各管一半）');
  assert.ok(!noSelf.some((m) => m.self));
  ok('#17 rangeByTs：visibleOnly 不排除 self（这是要的），includeSelf:false 才排除；撤回的被滤掉');
}

// 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── mem2-conv：${passed} 项通过`);
