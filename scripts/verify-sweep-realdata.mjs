// 真实数据副本 + fake LLM：验「扫描游标」这条路径（2026-11-17 复核要求）。
//
//   node scripts/verify-sweep-realdata.mjs
//
// 为什么单独做这件事：
//   · 现有单测是 freshRoot() 合成 85 条消息，没经历过真实 people/*.jsonl（573 行、84 条 active）
//     和 6 个群的真实候选池形状；
//   · `l1-scan.json` 不存在**是预期行为**（只在整段 SKIP / 空原文时推进），等 06:00 也证明不了它
//     —— 那一槽若没有 SKIP 批次，文件同样不出现，会拿到一个假阴性。
//
// 边界（逐条对上红线）：
//   · 不启动应用、不连 OneBot、不发网络：LLM 是本地 fake；
//   · 不动真实目录：messages / mem2 / config 全量复制到临时目录后再跑；
//   · 不烧配额：fake 直接返回，不经过 memLlm 的配额计数；
//   · 不冒充「验证 06:00 调度」：这里只验游标与预算，槽位触发是另一件事。
//
// 验的五件事：
//   ① SKIP 批次推进游标、落盘格式 v1、重启可重读；
//   ② 游标按 (uid, chatKey) 分开记，且等于该群该人最后一条消息的 ts（不串群）；
//   ③ 有效水位 = max(条目水位, 游标)：二次 sweep 零提炼调用；
//   ④ 候选按群分组：同一人的批次不跨群；
//   ⑤ 画像预算预留：置脏 1 人时，即使前面提炼用掉调用，画像仍然被建出来。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = path.resolve('data');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-sweep-real-'));
const say = (s = '') => console.log(s);
let failures = 0;
const check = (cond, name, detail = '') => {
  if (cond) say(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  else { failures += 1; say(`  ✗ ${name}${detail ? `（${detail}）` : ''}`); }
};
const cp = (from, to) => fs.cpSync(from, to, { recursive: true });

// ── 0. 复制真实数据（只复制脚本要读的三样，不碰 993M 的 sessions）──
say(`[verify] 源: ${SRC}`);
if (!fs.existsSync(path.join(SRC, 'mem2'))) {
  console.error('[verify] 找不到 data/mem2，先在项目根目录跑');
  process.exit(2);
}
cp(path.join(SRC, 'messages'), path.join(TMP, 'messages'));
cp(path.join(SRC, 'mem2'), path.join(TMP, 'mem2'));
if (fs.existsSync(path.join(SRC, 'config.json'))) cp(path.join(SRC, 'config.json'), path.join(TMP, 'config.json'));
const sizeOf = (p) => {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((s, n) => s + sizeOf(path.join(p, n)), 0);
};
say(`[verify] 副本: ${TMP}（messages ${(sizeOf(path.join(TMP, 'messages')) / 1048576).toFixed(1)}MB`
  + ` / mem2 ${(sizeOf(path.join(TMP, 'mem2')) / 1048576).toFixed(1)}MB）`);

process.env.QQ_AGENT_DATA_DIR = TMP;
const P = await import('../src/mem2/paths.js');
const M = await import('../src/mem2/store.js');
const L1 = await import('../src/mem2/l1.js');
const PR = await import('../src/mem2/profile.js');
const { ChatStore } = await import('../src/store.js');
P.setMem2Root(path.join(TMP, 'mem2'));

const store = new ChatStore(0);
const chatKeys = store.listChats();
const now = Date.now();
say(`[verify] 群 ${chatKeys.length} 个: ${chatKeys.join(', ')}`);
say(`[verify] mem2 根: ${P.mem2Dir()}；游标文件存在=${fs.existsSync(P.l1ScanFile())}`);

// ── fake LLM：一律 SKIP（模拟「这批没有新信息」），绝不发网络 ──
const kinds = [];
const fakeLlm = async (kind) => {
  kinds.push(kind);
  if (kind === PR.PROFILE_KIND) {
    return {
      ok: true, usage: { completionTokens: 18 },
      result: { model: 'fake', message: { content: '说话风格｜1｜说话短促，爱用口头禅收尾，情绪直接外露' } }
    };
  }
  return { ok: true, usage: { completionTokens: 3 }, result: { model: 'fake', message: { content: 'SKIP' } } };
};

// ── ① 第一次 sweep ──
const logs1 = [];
const t1 = await L1.runDailySweep({ store, now, memLlmImpl: fakeLlm, log: (m) => logs1.push(String(m)) });
say(`\n[1] 第一次 sweep：群=${t1.chats} 提炼=${t1.refined} 跳过=${t1.skipped} 调用=${t1.calls}`
  + ` 失败=${t1.failed} 候选兜底=${t1.candidateFallback} 冲突解除=${t1.conflictsResolved}`);
const cursorRaw = fs.existsSync(P.l1ScanFile()) ? fs.readFileSync(P.l1ScanFile(), 'utf8') : '';
check(fs.existsSync(P.l1ScanFile()), '① 游标文件已落盘（SKIP 批次才会推进）');
const cursorFile = cursorRaw ? JSON.parse(cursorRaw) : { v: 0, cursor: {} };
check(cursorFile.v === 1, '① 游标格式 v1', `v=${cursorFile.v}`);
const cursorPairs = Object.entries(cursorFile.cursor || {})
  .flatMap(([uid, byChat]) => Object.entries(byChat || {}).map(([chatKey, ts]) => ({ uid, chatKey, ts })));
say(`[1] 游标条目 ${cursorPairs.length} 条，涉及 ${new Set(cursorPairs.map((p) => p.uid)).size} 人`);
check(cursorPairs.length > 0, '① 至少推进了一条 (uid, chatKey) 游标');
check(t1.failed === 0, '① 无失败调用（fake 全部 ok）', `failed=${t1.failed}`);
check(logs1.some((l) => l.includes('日扫完成')), '① 日扫日志落了一条汇总');

// ── ② 游标不串群：每条游标必须等于「该人该群最后一条消息的 ts」 ──
const msgsByChat = new Map(chatKeys.map((k) => [k, store.rangeByTs(k, { fromTs: 0, toTs: now }) || []]));
const maxTsOf = (chatKey, uid) => {
  let max = 0;
  for (const m of msgsByChat.get(chatKey) || []) {
    if (String(m.senderId) === uid && Number(m.ts) > max) max = Number(m.ts);
  }
  return max;
};
const badGroup = cursorPairs.filter((p) => p.ts !== maxTsOf(p.chatKey, p.uid));
check(badGroup.length === 0, '② 每条游标 = 该人该群最后一条消息 ts（候选没串群、endTs 没取跨群最大值）',
  badGroup.length ? `${badGroup.length} 条不符，例 ${JSON.stringify(badGroup[0])}` : `${cursorPairs.length}/${cursorPairs.length}`);
const unknownChat = cursorPairs.filter((p) => !chatKeys.includes(p.chatKey));
check(unknownChat.length === 0, '② 游标 key 全是真实 chatKey');

// ── ②b 批次不跨群：拿真实的多群发言人直接验 buildBatchesByChat ──
const crossCount = (uid) => {
  const msgs = chatKeys.flatMap((k) => (msgsByChat.get(k) || []).filter((m) => String(m.senderId) === uid));
  const batches = L1.buildBatchesByChat(msgs);
  const mixed = batches.filter((b) => {
    const keys = new Set((b.messages || []).map((m) => String(m.chatKey || k0(m))));
    return keys.size > 1;
  });
  return { batches: batches.length, mixed: mixed.length };
};
function k0() { return ''; }
const multiGroupUid = (() => {
  const byUid = new Map();
  for (const k of chatKeys) for (const m of msgsByChat.get(k) || []) {
    const u = String(m.senderId || '');
    if (!/^\d+$/.test(u)) continue;
    if (!byUid.has(u)) byUid.set(u, new Set());
    byUid.get(u).add(k);
  }
  const hit = [...byUid.entries()].filter(([, s]) => s.size >= 2).sort((a, b) => b[1].size - a[1].size)[0];
  return hit ? { uid: hit[0], groups: hit[1].size } : null;
})();
if (multiGroupUid) {
  const r = crossCount(multiGroupUid.uid);
  check(r.mixed === 0, `②b 跨 ${multiGroupUid.groups} 群的人 ${multiGroupUid.uid}：批次不跨群`, `批=${r.batches}`);
} else {
  say('  · 没有跨群发言人，跳过 ②b');
}

// ── ③ 有效水位 = max(条目水位, 游标) ──
let wmChecked = 0;
let wmBad = 0;
for (const p of cursorPairs) {
  const person = M.readPerson(p.uid);
  const wm = L1.effectiveWatermarks(person.list, cursorFile.cursor[p.uid] || {}).get(p.chatKey) || 0;
  const entryWm = Math.max(0, ...person.list
    .filter((e) => (e.sourceChatKeys || []).includes(p.chatKey))
    .map((e) => Number(e.sourceBatch?.endTs) || 0));
  wmChecked += 1;
  if (wm < p.ts || wm < entryWm) wmBad += 1;
}
check(wmBad === 0, '③ 有效水位 ≥ 游标且 ≥ 条目水位', `${wmChecked} 对`);

// ── ④ 收敛：每轮最多 15 人（MAX_PEOPLE_PER_TICK），真实数据一轮跑不完 ──
// 这里不假设「第二轮就该零调用」：第一轮只覆盖 15 人，剩下的要靠后续轮次续跑。
// 真正要钉的是「最终会收敛」+「收敛后同一批不再重炼」。
let rounds = 1;
let lastCalls = t1.calls;
const roundCalls = [t1.calls];
while (lastCalls > 0 && rounds < 12) {
  const before = kinds.length;
  const t = await L1.runDailySweep({ store, now, memLlmImpl: fakeLlm, log: () => {} });
  rounds += 1;
  lastCalls = t.calls;
  roundCalls.push(t.calls);
  say(`[4] 第 ${rounds} 轮：提炼=${t.refined} 跳过=${t.skipped} 调用=${t.calls}`
    + `（本轮 l1=${kinds.slice(before).filter((k) => k === 'l1-refine').length}）`);
}
check(lastCalls === 0, '④ 多轮续跑后收敛到零调用', `${rounds} 轮，每轮调用 ${roundCalls.join('/')}`);
const cursorSettled = fs.readFileSync(P.l1ScanFile(), 'utf8');
const beforeStable = kinds.length;
const tEnd = await L1.runDailySweep({ store, now, memLlmImpl: fakeLlm, log: () => {} });
check(tEnd.calls === 0 && kinds.length === beforeStable, '④ 收敛后同一批不再重炼（零调用）',
  `calls=${tEnd.calls}`);
check(fs.readFileSync(P.l1ScanFile(), 'utf8') === cursorSettled, '④ 收敛后游标字节不变');
const settledPairs = Object.entries(JSON.parse(cursorSettled).cursor || {})
  .flatMap(([uid, byChat]) => Object.entries(byChat || {}).map(([chatKey, ts]) => ({ uid, chatKey, ts })));
check(settledPairs.length >= cursorPairs.length, '④ 游标只增不减', `${cursorPairs.length} → ${settledPairs.length}`);
const settledBad = settledPairs.filter((p) => p.ts !== maxTsOf(p.chatKey, p.uid));
check(settledBad.length === 0, '④ 收敛后每条游标仍 = 该人该群最后一条消息 ts',
  `${settledPairs.length} 条，不符 ${settledBad.length}`);

// ── ⑤ 画像预算预留：置脏 1 人（副本里删画像），看它能不能被建出来 ──
const victim = cursorPairs
  .map((p) => p.uid)
  .filter((u, i, a) => a.indexOf(u) === i)
  .sort((a, b) => (M.readPerson(b).list.length - M.readPerson(a).list.length))[0];
const victimProfile = path.join(P.mem2Dir(), 'people', `${victim}.profile.json`);
const hadProfile = fs.existsSync(victimProfile);
if (hadProfile) fs.rmSync(victimProfile);
const dirtyQueue = PR.buildProfileQueue();
check(dirtyQueue.some((q) => q.uid === victim && q.reason === 'no-profile'),
  '⑤ 置脏生效：队列里出现该 uid', `queue=${dirtyQueue.length} victim=${victim}`);
const callsBefore3 = kinds.length;
const t3 = await L1.runDailySweep({ store, now, memLlmImpl: fakeLlm, log: () => {} });
const profileCalls3 = kinds.slice(callsBefore3).filter((k) => k === PR.PROFILE_KIND).length;
check(profileCalls3 >= 1, '⑤ 画像预算预留：提炼之后仍给画像留了调用', `profileCalls=${profileCalls3}`);
check(fs.existsSync(victimProfile), '⑤ 画像已重建落盘', victim);
if (fs.existsSync(victimProfile)) {
  const p = JSON.parse(fs.readFileSync(victimProfile, 'utf8'));
  const dims = new Set((p.slots || []).map((s) => s.dim));
  check(dims.size === 4, '⑤ 重建后四维齐全（空维走确定性补位，不靠模型写满）',
    `槽=${p.slots?.length} 维=${[...dims].join('/')}`);
  const sens = p.slots.flatMap((s) => PR.scanSensitive(s.content));
  check(sens.length === 0, '⑤ 重建画像无题材词', sens.join('/'));
}

// ── ⑥ 线上预算口径：maxCallsPerTick=30（config.memory.l1）──
// 上面 ④ 用的是 Infinity（默认），真实槽位带 30 次上限。要验的是「撞上限时是 aborted 而不是 failed、
// 已 SKIP 的批次游标照样推进、下一轮从断点续跑」——不是「跑不完 = 坏了」。
say('');
const cfgMaxCalls = 30;
try { fs.rmSync(P.l1ScanFile(), { force: true }); } catch { /* 重置游标 */ }
const beforeLimit = kinds.length;
const t6 = await L1.runDailySweep({ store, now, memLlmImpl: fakeLlm, log: () => {}, maxCalls: cfgMaxCalls });
const calls6 = kinds.length - beforeLimit;
check(calls6 <= cfgMaxCalls, `⑥ maxCalls=${cfgMaxCalls} 时调用不超预算`, `calls=${calls6}`);
check(t6.failed === 0, '⑥ 撞上限不是失败（aborted 语义）', `failed=${t6.failed}`);
const cursor6 = JSON.parse(fs.readFileSync(P.l1ScanFile(), 'utf8')).cursor || {};
const pairs6 = Object.entries(cursor6).flatMap(([uid, byChat]) =>
  Object.entries(byChat || {}).map(([chatKey, ts]) => ({ uid, chatKey, ts })));
check(pairs6.length > 0 && pairs6.length <= cfgMaxCalls, '⑥ 撞上限前已 SKIP 的批次游标已落盘',
  `${pairs6.length} 条`);
// 撞上限是「跑到一半停」，所以游标只能保证 ≤ 本群最后一条 ts 且停在批边界（不是跨群最大值）
check(pairs6.every((p) => p.ts > 0 && p.ts <= maxTsOf(p.chatKey, p.uid)),
  '⑥ 断点处游标 ≤ 本群最后一条 ts（停在批边界，不是跨群最大值）',
  pairs6.map((p) => `${p.uid}@${p.chatKey}:${p.ts === maxTsOf(p.chatKey, p.uid) ? '尾' : '批界'}`).join(' '));
const beforeLimit2 = kinds.length;
const t7 = await L1.runDailySweep({ store, now, memLlmImpl: fakeLlm, log: () => {}, maxCalls: cfgMaxCalls });
const pairs7 = Object.entries(JSON.parse(fs.readFileSync(P.l1ScanFile(), 'utf8')).cursor || {})
  .flatMap(([uid, byChat]) => Object.entries(byChat || {}));
check(pairs7.length > pairs6.length, '⑥ 下一轮从断点续跑（游标继续增长）',
  `${pairs6.length} → ${pairs7.length}，本轮调用 ${kinds.length - beforeLimit2}`);
check(t7.failed === 0, '⑥ 续跑轮同样无失败');

// ── 收尾 ──
say(`\n[verify] 调用分布：${Object.entries(kinds.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {}))
  .map(([k, v]) => `${k}=${v}`).join(' ')}`);
say(`[verify] 真实目录未被修改：${SRC}（本次只在 ${TMP} 内读写）`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
if (failures) { say(`\n[verify] 失败 ${failures} 项`); process.exit(1); }
say('\n[verify] 全部通过');
