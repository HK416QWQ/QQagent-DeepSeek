// 记忆段前缀缓存稳定化（A+B，2026-11-03）
//
// 验证：
//   1. 成员按 QQ 号固定排序，updatedAt 变化不改字节
//   2. 锚定期间【已读信息】+【记忆】逐字节不变；新印象进【新记忆】
//   3. 新行超过预算 / 快照超龄 / 印象被删 → 重建快照，且不泄漏已删内容
//   4. B：新成员不重置锚点，印象走【新加入成员】，且不会在下一轮消失
//   5. 500 池里的第三人（不在 reset 窗口）不得把锚定轮主块撑大
//   6. 旧版快照（v 不匹配 / 无 promptSnapshot）强制重建
//
// 纯离线：临时数据目录 + 提示词记忆夹具 / ChatStore / buildUserPrompt。
// 运行：node test/prompt-memory-cache-test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-memcache-'));
process.env.QQ_AGENT_DATA_DIR = dir;

const { ChatStore } = await import('../src/store.js');
const { makePromptMemory } = await import('./fixtures/prompt-memory-stub.mjs');
const { buildUserPrompt } = await import('../src/prompt.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
assert.equal(DEFAULT_CONFIG.store.promptAnchor.maxExtraRead, 20, '默认 maxExtraRead 应为 20（B）');
cfg.persona.botName = '测试机';
cfg.persona.roleText = '你是测试群里的测试机。';
cfg.sticker.enabled = false;
cfg.store.contextTier = 4;
cfg.store.historyCount = 5;
// 主序列会连续锚定 4 轮、累计 4 条追加；预算留到 5，避免“超预算重置”
// 掩盖场景 5/6 想验证的“删除/超龄 → 重建”行为。
cfg.store.promptAnchor = { enabled: true, maxExtraRead: 5 };
setRuntimeConfig(cfg);

const store = new ChatStore(0);
const memory = makePromptMemory();
const CHAT = 'group:123';

memory.append(CHAT, 'memberImpression', '乙的第一条', { userId: '222', target: '乙' });
await new Promise((r) => setTimeout(r, 2));
memory.append(CHAT, 'memberImpression', '甲的第一条', { userId: '111', target: '甲' });

// ── 1. 固定顺序：updatedAt 变化不改字节 ──
const s1 = memory.promptSnapshot(CHAT, { userIds: ['111', '222'] });
assert.ok(s1.text.indexOf('甲的第一条') >= 0 && s1.text.indexOf('甲的第一条') < s1.text.indexOf('乙的第一条'),
  '成员应按 QQ 号升序（111 在 222 前）');
assert.ok(Array.isArray(s1.members['u:111']?.digests) && s1.members['u:111'].digests.length === 1,
  '快照成员应存内容摘要');
assert.ok(Array.isArray(s1.members['u:111']?.impressions), '本轮内存里应保留 impressions 供增量计算');
memory.append(CHAT, 'memberImpression', '乙的第二条', { userId: '222', target: '乙' });
const s2 = memory.promptSnapshot(CHAT, { userIds: ['111', '222'] });
assert.ok(s2.text.indexOf('甲的第一条') < s2.text.indexOf('乙的第一条'),
  '乙 updatedAt 变新后，成员顺序不应改变');

// ── 驱动一次“运行” ──
let mid = 1000;
let ts = Date.now() - 100000;
function read(senderId, senderName, text) {
  const e = store.appendIncoming(CHAT, { mid: ++mid, ts: ++ts, senderId, senderName, text });
  store.markEntryRead(CHAT, e.id);
}
function unread(senderId, senderName, text) {
  return store.appendIncoming(CHAT, { mid: ++mid, ts: ++ts, senderId, senderName, text });
}
function run(triggerEntries, prev, now) {
  const session = {};
  const up = buildUserPrompt({
    chatKey: CHAT, kind: 'group', chatId: '123', chatName: '测试群',
    triggerEntries, store, memory, stickerEntries: [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
    contextLimit: 5, promptAnchor: { prev }, session, now
  });
  return { up, session };
}
const readSec = (up) => {
  const s = up.indexOf('【已读信息】以下是');
  const ends = ['【记忆】\n', '【新已读信息】以下是', '【未读信息】以下是']
    .map((mark) => up.indexOf(mark, s))
    .filter((i) => i > s);
  assert.ok(s >= 0 && ends.length, '段落定位失败');
  return up.slice(s, Math.min(...ends)).replace(/\n+$/, '\n');
};
const memSec = (up) => {
  const s = up.indexOf('【记忆】\n');
  const ends = ['【新已读信息】以下是', '【未读信息】以下是']
    .map((mark) => up.indexOf(mark, s))
    .filter((i) => i > s);
  return s >= 0 && ends.length ? up.slice(s, Math.min(...ends)).replace(/\n+$/, '\n') : '';
};

'ABCDEF'.split('').forEach((t, i) => read(i % 2 ? '222' : '111', i % 2 ? '乙' : '甲', t));

// ── 2. 首轮 reset：记忆在已读之后、新已读/未读之前 ──
const G = unread('111', '甲', 'G');
const r1 = run([G], null, 1_000_000);
assert.equal(r1.session.promptAnchorMode, 'reset');
assert.ok(r1.up.indexOf('【已读信息】以下是') < r1.up.indexOf('【记忆】\n'), '记忆应在已读之后');
assert.ok(r1.up.indexOf('【记忆】\n') < r1.up.indexOf('【未读信息】以下是'), '记忆应在未读之前');
assert.ok(r1.session.promptAnchorState.memory?.text?.includes('甲的第一条'), '首轮应生成记忆快照');
assert.equal(r1.session.promptAnchorState.memory?.v, 2, '快照版本应为 2');
assert.ok(r1.session.promptAnchorState.memory?.members['u:111']?.digests?.length >= 1, '落盘快照应存摘要');
assert.equal(r1.session.promptAnchorState.memory?.members['u:111']?.impressions, undefined,
  '落盘快照不应带 impressions 原文数组');
assert.equal(r1.session.promptAnchorState.memory?.members['u:111']?.contents, undefined,
  '落盘快照不应带 contents 全量原文');
const anchor1 = r1.session.promptAnchorState;

// ── 3. 锚定轮无新印象：前缀+记忆逐字节不变 ──
const H = unread('222', '乙', 'H');
const r2 = run([H], anchor1, 1_000_010);
assert.equal(r2.session.promptAnchorMode, 'anchored');
assert.equal(readSec(r2.up), readSec(r1.up), '锚定轮已读段逐字节一致');
assert.equal(memSec(r2.up), memSec(r1.up), '锚定轮记忆段逐字节一致');
assert.ok(!r2.up.includes('【新记忆】'), '没有新印象时不应出现【新记忆】');

// ── 4. 新增印象：前缀不变，新行进【新记忆】 ──
await new Promise((r) => setTimeout(r, 2));
memory.append(CHAT, 'memberImpression', '甲的新印象', { userId: '111', target: '甲' });
const I = unread('111', '甲', 'I');
const r3 = run([I], r2.session.promptAnchorState, 1_000_020);
assert.equal(r3.session.promptAnchorMode, 'anchored');
assert.equal(readSec(r3.up), readSec(r1.up), '新增印象不应改动已读段');
assert.equal(memSec(r3.up), memSec(r1.up), '新增印象不应改动主记忆块');
assert.ok(r3.up.includes('【新记忆】') && r3.up.includes('甲的新印象'), '新印象应进【新记忆】');

// ── 5. 删除成员：下一轮必须重建，不能残留 ──
memory.removeMember(CHAT, '111');
const J = unread('222', '乙', 'J');
const r4 = run([J], r3.session.promptAnchorState, 1_000_030);
assert.equal(r4.session.promptAnchorMode, 'anchored');
assert.ok(!r4.up.includes('甲的新印象') && !r4.up.includes('甲的第一条'), '删除后不得残留任何甲的印象');
assert.ok(r4.up.includes('乙的第一条'), '其他成员的记忆应保留');

// ── 6. 超龄：重建快照，不产生【新记忆】 ──
const aged = {
  ...r4.session.promptAnchorState,
  memory: { ...r4.session.promptAnchorState.memory, at: 1_000_030 - 7 * 3600 * 1000 }
};
memory.append(CHAT, 'memberImpression', '乙的第三条', { userId: '222', target: '乙' });
const K = unread('222', '乙', 'K');
const r5 = run([K], aged, 1_000_040);
assert.ok(r5.up.includes('乙的第三条'), '超龄重建后应包含最新印象');
assert.ok(!r5.up.includes('【新记忆】'), '超龄重建后不应再走增量');

// ── 7. 增量超过 12 行：直接重建 ──
{
  const store2 = new ChatStore(0);
  const mem2 = makePromptMemory();
  const C2 = 'group:456';
  const ids = ['301', '302', '303', '304', '305'];
  for (const uid of ids) {
    mem2.append(C2, 'memberImpression', `成员${uid}旧`, { userId: uid, target: `成员${uid}` });
    const e = store2.appendIncoming(C2, { mid: ++mid, ts: ++ts, senderId: uid, senderName: `成员${uid}`, text: `hi-${uid}` });
    store2.markEntryRead(C2, e.id);
  }
  const mk = (trig, prev, now) => {
    const session = {};
    const up = buildUserPrompt({
      chatKey: C2, kind: 'group', chatId: '456', chatName: '测试群2',
      triggerEntries: trig, store: store2, memory: mem2, stickerEntries: [],
      selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
      contextLimit: 5, promptAnchor: { prev }, session, now
    });
    return { up, session };
  };
  const t1 = store2.appendIncoming(C2, { mid: ++mid, ts: ++ts, senderId: '301', senderName: '成员301', text: 'T1' });
  const a1 = mk([t1], null, 2_000_000);
  for (const uid of ids) {
    for (const n of ['新1', '新2', '新3']) {
      mem2.append(C2, 'memberImpression', `成员${uid}${n}`, { userId: uid, target: `成员${uid}` });
    }
  }
  const t2 = store2.appendIncoming(C2, { mid: ++mid, ts: ++ts, senderId: '301', senderName: '成员301', text: 'T2' });
  const a2 = mk([t2], a1.session.promptAnchorState, 2_000_010);
  assert.ok(!a2.up.includes('【新记忆】'), '新行超过 12 行应直接重建快照');
  assert.ok(a2.up.includes('成员301新3'), '重建后的主记忆块应包含最新印象');
}

// ── 8. B：新成员不重置锚点，印象走【新加入成员】，且不会在下一轮消失 ──
{
  const store3 = new ChatStore(0);
  const mem3 = makePromptMemory();
  const C3 = 'group:789';
  mem3.append(C3, 'memberImpression', '老成员401的印象', { userId: '401', target: '老成员401' });
  mem3.append(C3, 'memberImpression', '新成员402的印象', { userId: '402', target: '新成员402' });
  let m3 = 3000;
  let t3 = Date.now() - 50000;
  const rd3 = (uid, name, text) => {
    const e = store3.appendIncoming(C3, { mid: ++m3, ts: ++t3, senderId: uid, senderName: name, text });
    store3.markEntryRead(C3, e.id);
  };
  const ur3 = (uid, name, text) => store3.appendIncoming(C3, { mid: ++m3, ts: ++t3, senderId: uid, senderName: name, text });
  const mk3 = (trig, prev, now) => {
    const session = {};
    const up = buildUserPrompt({
      chatKey: C3, kind: 'group', chatId: '789', chatName: '测试群3',
      triggerEntries: trig, store: store3, memory: mem3, stickerEntries: [],
      selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
      contextLimit: 4, promptAnchor: { prev }, session, now
    });
    return { up, session };
  };
  for (const x of ['a', 'b', 'c', 'd']) rd3('401', '老成员401', x);
  const g1 = ur3('401', '老成员401', 'G');
  const b1 = mk3([g1], null, 3_000_000);
  assert.equal(b1.session.promptAnchorMode, 'reset');
  assert.ok(memSec(b1.up).includes('老成员401的印象'), '快照应含 401');
  assert.ok(!memSec(b1.up).includes('新成员402的印象'), '402 未在窗口，不应进快照');
  // 402 首次发言：不重置，印象进【新加入成员】
  const g2 = ur3('402', '新成员402', 'H');
  const b2 = mk3([g2], b1.session.promptAnchorState, 3_000_010);
  assert.equal(b2.session.promptAnchorMode, 'anchored', '新成员出现不应重置锚点（B）');
  assert.equal(readSec(b2.up), readSec(b1.up), '新成员出现时已读前缀不变');
  assert.equal(memSec(b2.up), memSec(b1.up), '新成员出现时主记忆块不变');
  assert.ok(b2.up.includes('【新加入成员】') && b2.up.includes('新成员402的印象'), '402 的印象应进【新加入成员】');
  // 402 再发言：快照未重建，印象仍应在尾段（不能消失）
  const g3 = ur3('402', '新成员402', 'I');
  const b3 = mk3([g3], b2.session.promptAnchorState, 3_000_020);
  assert.equal(b3.session.promptAnchorMode, 'anchored');
  assert.ok(b3.up.includes('新成员402的印象'), '快照重建前 402 的印象应持续出现');
}

// ── 9. 在场口径（L1 收敛 §6.3）：最近 50 条内的第三人算在场 → 主块包含他 ──
// 旧实现按"reset 窗口"取主块成员；§6.3 把口径改成「30 分钟内 或 最近 50 条」，
// 403 的两条旧消息虽然在滑窗外，但仍在最近 50 条内 → 属于在场，主块包含他。
// 「不在场 → 不进主块、快照重建」的场景在 prompt-presence-test 里单独覆盖。
{
  const store4 = new ChatStore(0);
  const mem4 = makePromptMemory();
  const C4 = 'group:654';
  mem4.append(C4, 'memberImpression', '401的印象', { userId: '401', target: '甲' });
  mem4.append(C4, 'memberImpression', '403的印象', { userId: '403', target: '丙' });
  let m4 = 4000;
  let t4 = Date.now() - 50000;
  const rd4 = (uid, name, text) => {
    const e = store4.appendIncoming(C4, { mid: ++m4, ts: ++t4, senderId: uid, senderName: name, text });
    store4.markEntryRead(C4, e.id);
  };
  const ur4 = (uid, name, text) =>
    store4.appendIncoming(C4, { mid: ++m4, ts: ++t4, senderId: uid, senderName: name, text });
  const mk4 = (trig, prev, now) => {
    const session = {};
    const up = buildUserPrompt({
      chatKey: C4, kind: 'group', chatId: '654', chatName: '测试群4',
      triggerEntries: trig, store: store4, memory: mem4, stickerEntries: [],
      selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
      contextLimit: 5, promptAnchor: { prev }, session, now
    });
    return { up, session };
  };
  // 403 的两条旧消息在 500 池里，但会被后面的 5 条窗口挤出 reset 窗口
  rd4('403', '丙', 'old1');
  rd4('403', '丙', 'old2');
  for (const x of ['a', 'b', 'c', 'd', 'e']) rd4('401', '甲', x);
  const g4 = ur4('401', '甲', 'G');
  const q1 = mk4([g4], null, 4_000_000);
  assert.equal(q1.session.promptAnchorMode, 'reset');
  assert.ok(memSec(q1.up).includes('401的印象'), 'reset 主块应含在场成员 401');
  assert.ok(memSec(q1.up).includes('403的印象'), '★ 最近 50 条内的 403 属于在场 → 进主块');
  // 403 再发言：仍在场，快照可原样复用
  const h4 = rd4('403', '丙', 'H');
  const i4 = ur4('401', '甲', 'I');
  const q2 = mk4([i4], q1.session.promptAnchorState, 4_000_010);
  assert.equal(q2.session.promptAnchorMode, 'anchored');
  assert.equal(readSec(q2.up), readSec(q1.up), '锚定轮已读段应与 reset 轮一致');
  assert.equal(memSec(q2.up), memSec(q1.up), '在场成员稳定 → 主块逐字节复用');
}

// ── 10. 旧版快照 / 缺少 promptSnapshot → 强制重建，不残留 ──
{
  const L = unread('222', '乙', 'L');
  const legacy = {
    ...r5.session.promptAnchorState,
    // 老版本没有 v，members 也可能是空对象：必须重建，不能当成“全量都在”
    memory: { text: '【对群友的印象】\n- 旧块：不应出现', at: 1_000_050, members: {} }
  };
  const r6 = run([L], legacy, 1_000_060);
  assert.equal(r6.session.promptAnchorMode, 'anchored');
  assert.ok(!r6.up.includes('旧块：不应出现'), 'v 不匹配的旧快照必须重建');
  assert.ok(memSec(r6.up).includes('乙的第三条'), '重建后应使用真实记忆');

  // 缺少 promptSnapshot 的退化实现：本轮重建，且不写快照（下一轮继续重建）
  const s = {};
  const stub = { formatForPrompt: (...args) => memory.formatForPrompt(...args) };
  const up = buildUserPrompt({
    chatKey: CHAT, kind: 'group', chatId: '123', chatName: '测试群',
    triggerEntries: [L], store, memory: stub, stickerEntries: [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
    contextLimit: 5, promptAnchor: { prev: r6.session.promptAnchorState }, session: s, now: 1_000_070
  });
  assert.equal(s.promptAnchorMode, 'anchored');
  assert.equal(s.promptAnchorState.memory, null, '没有 promptSnapshot 时不写快照');
  assert.ok(!up.includes('【新记忆】'), '没有 promptSnapshot 时不走增量');
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('✓ 记忆段缓存稳定化自测全部通过');
