// 记忆注入选人口径（L1 收敛 §6.3 / §6.4 测试 3–10）
//
// 覆盖：
//   3. 30 分钟窗口：31 分钟前且不在最近 50 条 → 不进；
//   4. 最近 50 条内但超过 30 分钟 → 进；
//   5. 触发者不在窗口内 → 必进；
//   6. 被 @ 者不在窗口内 → 必进（atIds）；
//   7. 被回复者不在窗口内 → 必进（新消息 senderId / 老消息 reply.mid 命中）；
//   8. 没人可算在场 → 回落最近 3–5 个非 self 发言人；
//   9. 老消息无 atIds、atNames 精确匹配 → 进保护集；对不上/同名歧义 → 跳过；
//  10. 锚定轮上一轮成员已不在场 → 本轮 members 不含他（快照重建）。
//
// 纯离线：3–9 直接驱动纯函数；10 走真实 ChatStore / 提示词记忆夹具 / buildUserPrompt。
// 运行：node test/prompt-presence-test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-presence-'));
process.env.QQ_AGENT_DATA_DIR = dir;

const { ChatStore } = await import('../src/store.js');
const { makePromptMemory } = await import('./fixtures/prompt-memory-stub.mjs');
const { buildUserPrompt, selectPresenceUserIds, buildMemberNameIndex } = await import('../src/prompt.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

let count = 0;
const ok = (msg) => { count += 1; console.log('  ✓', msg); };

const NOW = 10_000_000;
const MIN = 60 * 1000;
const msg = (senderId, ts, extra = {}) => ({ mid: extra.mid ?? `${senderId}-${ts}`, ts, senderId, ...extra });
const recent = (senderId, n, ts, extra = {}) => Array.from({ length: n }, () => msg(senderId, ts, extra));

// ── 3. 30 分钟窗口：31 分钟前且不在最近 50 条 → 不进 ──
{
  const pool = [msg('111', NOW - 31 * MIN), ...recent('222', 50, NOW - MIN)];
  const r = selectPresenceUserIds(pool, [], NOW);
  assert.ok(!r.userIds.includes('111'), '31 分钟前且被 50 条挤出 → 不在场');
  assert.ok(r.userIds.includes('222'), '刚说话的 222 在场');
  assert.equal(r.protectedIds.length, 0);
  ok('#3 30 分钟窗口外的旧发言人被排除');
}

// ── 4. 最近 50 条内但超过 30 分钟 → 进 ──
{
  const pool = [msg('111', NOW - 31 * MIN), msg('222', NOW - MIN)];
  const r = selectPresenceUserIds(pool, [], NOW);
  assert.ok(r.userIds.includes('111'), '31 分钟前的消息仍在最近 50 条 → 在场');
  ok('#4 最近 50 条内的旧发言人保留');
}

// ── 5. 触发者不在窗口内 → 必进（保护集）──
{
  const trigger = msg('111', NOW - 3 * 60 * MIN);
  const pool = [...recent('222', 50, NOW - MIN), trigger];
  const r = selectPresenceUserIds(pool, [trigger], NOW);
  assert.ok(r.protectedIds.includes('111'), '触发者进保护集');
  assert.ok(r.userIds.includes('111'), '触发者即使 3 小时前发过言也必进');
  ok('#5 触发者不在窗口内也必进');
}

// ── 6. 被 @ 者不在窗口内 → 必进（atIds，过滤 all/空值）──
{
  const trigger = msg('222', NOW - MIN, { atIds: ['333', 'all', '', null] });
  const r = selectPresenceUserIds([trigger], [trigger], NOW);
  assert.ok(r.protectedIds.includes('333'), 'atIds 里的 QQ 进保护集');
  assert.ok(!r.protectedIds.includes('all'), 'atIds 的 all 被过滤');
  assert.ok(!r.protectedIds.includes(''), 'atIds 的空值被过滤');
  assert.ok(r.userIds.includes('333'), '@ 到的人即使没发过言也进');
  ok('#6 被 @ 者不在窗口内也必进');
}

// ── 7. 被回复者不在窗口内 → 必进（reply.senderId / 老消息 reply.mid 命中）──
{
  const oldTarget = msg('444', NOW - 3 * 60 * MIN, { mid: 'q-old-1' });
  const pool = [oldTarget, ...recent('222', 50, NOW - MIN)];
  const t1 = msg('222', NOW - MIN, { reply: { mid: 'q-old-1', senderId: null } });
  const r1 = selectPresenceUserIds(pool, [t1], NOW);
  assert.ok(r1.protectedIds.includes('444'), '老消息只带 reply.mid → 在池里按 mid 找回被回复者');
  assert.ok(r1.userIds.includes('444'));

  const t2 = msg('222', NOW - MIN, { reply: { mid: 'q-not-in-pool', senderId: null } });
  const r2 = selectPresenceUserIds(pool, [t2], NOW);
  assert.ok(!r2.protectedIds.includes('444'), 'mid 在池里找不到 → 不猜');

  const t3 = msg('222', NOW - MIN, { reply: { mid: null, senderId: '555' } });
  const r3 = selectPresenceUserIds(pool, [t3], NOW);
  assert.ok(r3.protectedIds.includes('555'), '新消息带 reply.senderId → 直接进保护集');
  ok('#7 被回复者不在窗口内也必进（reply.mid 命中）');
}

// ── 8. 没人可算在场 → 回落最近 3–5 个非 self 发言人 ──
{
  // 群友 2 小时前说过话，最近 50 条全是机器人自己发的 → 窗口与最近 50 条都没有群友
  const old = ['111', '222', '333', '444', '555', '666'].map((uid) => msg(uid, NOW - 2 * 60 * MIN));
  const selfs = recent('999', 50, NOW - MIN, { self: true });
  const r = selectPresenceUserIds([...old, ...selfs], [], NOW);
  assert.equal(r.userIds.length, 5, '回落取最近 5 个发言人');
  assert.ok(['222', '333', '444', '555', '666'].every((uid) => r.userIds.includes(uid)), '按时间降序取最近的 5 个');
  assert.ok(!r.userIds.includes('111'), '第 6 旧的人被 5 人上限挤掉');
  assert.ok(!r.userIds.includes('999'), '机器人自己不参与回落');
  assert.ok(!selectPresenceUserIds([], [], NOW).userIds.length, '全空池 → 空结果不报错');
  ok('#8 无人可算在场时回落最近 5 个发言人');
}

// ── 9. 老消息无 atIds、atNames 精确匹配 → 进保护集；对不上/歧义 → 跳过 ──
{
  const nameIndex = buildMemberNameIndex([
    { name: '甲', userId: '111', lastTs: 1000 },
    { name: '乙', userId: '222', lastTs: 2000 },
    { name: '丙', userId: '333', lastTs: 3000 },
    { name: '丙', userId: '334', lastTs: 3000 }    // 同名且同样近 → 歧义
  ]);
  const old = msg('222', NOW - 5 * 60 * MIN, { atNames: ['@甲', '乙', '丙', '丁', '@'] });
  const r = selectPresenceUserIds([old], [old], NOW, { nameIndex });
  assert.ok(r.protectedIds.includes('111'), 'atNames 精确对上「甲」→ 进保护集');
  assert.ok(r.protectedIds.includes('222'), 'atNames 对上「乙」→ 进保护集');
  assert.ok(!r.protectedIds.includes('333') && !r.protectedIds.includes('334'), '「丙」同名歧义 → 不猜');
  assert.ok(!r.userIds.includes('333'), '对不上的人不因 @ 进入');

  // atIds 存在（即使全是无效值）→ 不再回落 atNames，避免两套口径叠加
  const both = msg('222', NOW - 5 * 60 * MIN, { atIds: ['all'], atNames: ['@甲'] });
  const r2 = selectPresenceUserIds([both], [both], NOW, { nameIndex });
  assert.ok(!r2.protectedIds.includes('111'), '有 atIds 时以 atIds 为准，不回落 atNames');

  assert.equal(nameIndex.get('丙').ambiguous, true, '同名同近 → 标记歧义');
  ok('#9 老消息 atNames 精确匹配进保护集，对不上/歧义跳过');
}

// ── 10. 锚定轮上一轮成员已不在场 → 本轮 members 不含他（快照重建）──
{
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona.botName = '测试机';
  cfg.persona.roleText = '你是测试群里的测试机。';
  cfg.sticker.enabled = false;
  cfg.store.contextTier = 4;
  cfg.store.historyCount = 5;
  cfg.store.promptAnchor = { enabled: true, maxExtraRead: 20 };
  setRuntimeConfig(cfg);

  const store = new ChatStore(0);
  const memory = makePromptMemory();
  const CHAT = 'group:888';

  memory.append(CHAT, 'memberImpression', '甲的第一条', { userId: '111', target: '甲' });
  memory.append(CHAT, 'memberImpression', '乙的第一条', { userId: '222', target: '乙' });

  const T = Date.now();
  let mid = 9000;
  let ts = T - 3 * 3600 * 1000;
  const read = (uid, name, text) => {
    const e = store.appendIncoming(CHAT, { mid: ++mid, ts: ++ts, senderId: uid, senderName: name, text });
    store.markEntryRead(CHAT, e.id);
  };

  for (let i = 0; i < 5; i += 1) read('111', '甲', `甲-老${i}`);
  for (let i = 0; i < 35; i += 1) read('222', '乙', `乙-老${i}`);
  const G = store.appendIncoming(CHAT, { mid: ++mid, ts: ++ts, senderId: '222', senderName: '乙', text: 'G' });

  const run = (triggerEntries, prev, now) => {
    const session = {};
    const up = buildUserPrompt({
      chatKey: CHAT, kind: 'group', chatId: '888', chatName: '测试群',
      triggerEntries, store, memory, stickerEntries: [],
      selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
      contextLimit: 5, promptAnchor: { prev }, session, now
    });
    return { up, session };
  };
  const memSec = (up) => {
    const s = up.indexOf('【记忆】\n');
    const ends = ['【新已读信息】以下是', '【未读信息】以下是']
      .map((mark) => up.indexOf(mark, s))
      .filter((i) => i > s);
    return s >= 0 && ends.length ? up.slice(s, Math.min(...ends)) : '';
  };

  const r1 = run([G], null, T);
  assert.equal(r1.session.promptAnchorMode, 'reset');
  assert.ok(memSec(r1.up).includes('甲的第一条') && memSec(r1.up).includes('乙的第一条'),
    '首轮两人都在最近 50 条内 → 主块含两人');
  assert.ok(r1.session.promptAnchorState.memory?.members['u:111'], '快照含 111');

  // 15 条新已读（≤ maxExtraRead=20 → 仍锚定），把 111 的 5 条挤出最近 50 条；
  // 新消息 ts 都在 30 分钟窗口外/内不影响 111（他的消息已 3 小时前）
  ts = T - 10 * 60 * 1000;
  for (let i = 0; i < 15; i += 1) read('222', '乙', `乙-新${i}`);
  const H = store.appendIncoming(CHAT, { mid: ++mid, ts: ++ts, senderId: '222', senderName: '乙', text: 'H' });
  const now2 = T + 60 * 1000;
  const r2 = run([H], r1.session.promptAnchorState, now2);

  assert.equal(r2.session.promptAnchorMode, 'anchored', '15 条追加在预算内 → 仍锚定');
  assert.ok(!r2.up.includes('甲的第一条'), '111 不在场 → 主块不得残留他的印象');
  assert.ok(memSec(r2.up).includes('乙的第一条'), '在场的 222 保留');
  assert.ok(!r2.session.promptAnchorState.memory?.members['u:111'], '重建后的快照不再含 111');
  assert.equal(r2.session.promptAnchorState.memory?.at, now2, '快照已重建（at = 本轮 now）');
  ok('#10 锚定轮上一轮成员不在场 → 快照重建、members 不含他');
}

// ── 11. 在场者超过读盘上限 → 按 lastTs 降序截到 120，受保护者永不裁 ──
{
  const trigger = msg('0001', NOW - 3 * 60 * MIN);          // 3 小时前，不在窗口、不在最近 50 条
  const crowd = Array.from({ length: 200 }, (_, i) => msg(String(1000 + i), NOW - MIN));
  const r = selectPresenceUserIds([trigger, ...crowd], [trigger], NOW);
  assert.equal(r.userIds.length, 120, '★ 最多读 120 人的档案');
  assert.ok(r.userIds.includes('0001'), '★ 受保护者即使 ts 最老也不裁');
  assert.equal(r.userIds[0], '0001', '受保护者排最前（其余按 lastTs 降序）');
  assert.ok(r.userIds.includes('1118'), 'ts 相同时按 uid 升序取满');
  assert.ok(!r.userIds.includes('1119'), 'uid 更大的被截断');
  // 同一输入两次 → 逐字节一致（确定性）
  assert.deepEqual(r.userIds, selectPresenceUserIds([trigger, ...crowd], [trigger], NOW).userIds);
  ok('#11 超过 120 人时按 lastTs 截断，受保护者不裁，结果确定');
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`── prompt-presence：${count} 项通过`);