// 聊天级 meta + listChatKeys + meta-index 缓存（P1-01a，对应施工单 §8.4）。
//
// 测试 8（冷缓存首次 /api/chats 全量）与 12（切换后 <50ms）属于 P1-01b 的验收，
// P1-01a 阶段 `/api/chats` 仍走 `listChats() + getChatMeta()` 全量，不能提前断言。
//
// 为什么每处“冷启动”都重新 import：meta 缓存是模块级的，同一实例内的
// `peekChatMeta` 永远命中内存，测不出“从磁盘读、按指纹判活”。
// import 带不同 query 会得到新的模块实例（`src/config.js` 共享缓存，DATA_DIR 不变）。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-chatmeta-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const STORE_URL = pathToFileURL(path.join(ROOT, 'src', 'store.js')).href;
const MSG_DIR = path.join(DATA, 'messages');
const META_INDEX = path.join(DATA, 'meta-index.json');
const safeKey = (k) => String(k).replace(/[^a-z0-9_]/gi, '_');
const dirOf = (k) => path.join(MSG_DIR, safeKey(k));
const shardOf = (k, ym) => path.join(dirOf(k), `${ym}.jsonl`);
const legacyOf = (k) => path.join(MSG_DIR, `${safeKey(k)}.json`);
const ymOf = (ts) => {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const readMetaIndex = () => JSON.parse(fs.readFileSync(META_INDEX, 'utf8'));

let coldSeq = 0;
async function loadStore() {
  coldSeq += 1;
  return import(`${STORE_URL}?cold=${coldSeq}`);
}

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

// 统一用大时间戳，避免后续 pruneBefore 之类按 cutoff 扫描时误伤别的用例
const T = 1_760_000_000_000;

const mod = await loadStore();
const { ChatStore } = mod;
const S = new ChatStore(0);

try {
  // ══ 1. appendIncoming ══
  await check('1. 追加他人消息：total/unread/lastTs/lastText 正确', () => {
    const k = 'group:1001';
    S.appendIncoming(k, { mid: 'm1', ts: T + 1000, senderId: 'u1', senderName: '甲', text: '你好' });
    let m = S.getChatMeta(k);
    assert.equal(m.total, 1);
    assert.equal(m.unread, 1);
    assert.equal(m.lastTs, T + 1000);
    assert.equal(m.lastText, '你好');

    S.appendIncoming(k, { mid: 'm2', ts: T + 2000, senderId: 'u2', senderName: '乙', text: '在吗' });
    m = S.getChatMeta(k);
    assert.equal(m.total, 2);
    assert.equal(m.unread, 2, '两条他人消息都应计未读');
    assert.equal(m.lastTs, T + 2000);
    assert.equal(m.lastText, '在吗');

    // 落盘后的分片确实写入（后面缓存指纹要用）
    assert.ok(fs.existsSync(shardOf(k, ymOf(T + 2000))), '应写入对应月份分片');
  });

  // ══ 2. appendSelf ══
  await check('2. 追加自己消息：total+1、unread 不变、last 更新', () => {
    const k = 'group:1002';
    S.appendIncoming(k, { mid: 'm1', ts: T + 1000, senderId: 'u1', senderName: '甲', text: '问' });
    S.appendSelf(k, { text: '答', ts: T + 2000, mid: 'm2' });
    const m = S.getChatMeta(k);
    assert.equal(m.total, 2);
    assert.equal(m.unread, 1, '自己发的不算未读');
    assert.equal(m.lastTs, T + 2000);
    assert.equal(m.lastText, '答');
  });

  // ══ 3. markAllRead / markEntryRead / markUnreadInWindow ══
  await check('3. markAllRead/markEntryRead/markUnreadInWindow：unread 正确，self/已读不减', () => {
    const k = 'group:1003';
    // a 要落在「窗口起点（b.ts - 5 分钟）」之前，否则 markUnreadInWindow 会把两条都翻回来
    const a = S.appendIncoming(k, { mid: 'a', ts: T - 400000, senderId: 'u1', senderName: '甲', text: 'a' });
    S.appendIncoming(k, { mid: 'b', ts: T + 2000, senderId: 'u1', senderName: '甲', text: 'b' });
    const self = S.appendSelf(k, { text: '我', ts: T + 3000, mid: 'c' });
    assert.equal(S.getChatMeta(k).unread, 2);

    // 针对 self 的 markEntryRead 必须返回 false，且未读数量不变
    assert.equal(S.markEntryRead(k, self.id), false, 'self 不能被标已读');
    assert.equal(S.getChatMeta(k).unread, 2, 'self 的 false 返回不得减未读');

    // 真正标一条未读
    assert.equal(S.markEntryRead(k, a.id), true);
    assert.equal(S.getChatMeta(k).unread, 1);
    // 已读的再标：返回 false，不能继续减
    assert.equal(S.markEntryRead(k, a.id), false);
    assert.equal(S.getChatMeta(k).unread, 1);

    // markAllRead 返回实际置读条数
    assert.equal(S.markAllRead(k), 1);
    assert.equal(S.getChatMeta(k).unread, 0);
    assert.equal(S.markAllRead(k), 0, '全已读后再标应为 0');

    // 窗口内翻回未读
    const n = S.markUnreadInWindow(k, T + 2000, T + 2000);
    assert.equal(n, 1, '只应翻回窗口内的 b');
    assert.equal(S.getChatMeta(k).unread, 1);
  });

  // ══ 4. drainUnread / drainUnreadFrom ══
  await check('4. drainUnread / drainUnreadFrom：按实际置读条数结算 unread', () => {
    const k = 'group:1004';
    S.appendIncoming(k, { mid: 'a', ts: T + 1000, senderId: 'u1', senderName: '甲', text: '旧积压' });
    S.appendIncoming(k, { mid: 'b', ts: T + 2000, senderId: 'u1', senderName: '甲', text: '触发' });
    S.appendIncoming(k, { mid: 'c', ts: T + 3000, senderId: 'u1', senderName: '甲', text: '追加' });
    assert.equal(S.getChatMeta(k).unread, 3);

    const r = S.drainUnreadFrom(k, T + 2000);
    assert.equal(r.batch.length, 2, '触发点及之后的 2 条进批次');
    assert.equal(r.archived, 1, '触发点之前的旧积压沉入历史');
    assert.equal(S.getChatMeta(k).unread, 0, '全部置读后未读为 0');

    const k2 = 'group:1004b';
    S.appendIncoming(k2, { mid: 'x', ts: T + 1000, senderId: 'u1', senderName: '甲', text: 'x' });
    S.appendIncoming(k2, { mid: 'y', ts: T + 2000, senderId: 'u1', senderName: '甲', text: 'y' });
    const taken = S.drainUnread(k2);
    assert.equal(taken.length, 2, 'drainUnread 返回被取走的未读数组');
    assert.equal(S.getChatMeta(k2).unread, 0);
  });

  // ══ 5. markRecalled ══
  await check('5. markRecalled：撤回的消息不再计入未读，lastTs/lastText 仍指向最后一条', () => {
    const k = 'group:1005';
    S.appendIncoming(k, { mid: 'a', ts: T + 1000, senderId: 'u1', senderName: '甲', text: '第一条' });
    S.appendIncoming(k, { mid: 'b', ts: T + 2000, senderId: 'u1', senderName: '甲', text: '要撤回的' });
    assert.equal(S.getChatMeta(k).unread, 2);

    assert.equal(S.markRecalled(k, 'b'), true);
    const m = S.getChatMeta(k);
    assert.equal(m.unread, 1, '撤回的消息被置读，未读减 1');
    // 撤回不删消息：预览仍是最后一条（P1-01b 重算 lastTs/lastText 时必须保持这个结果）
    assert.equal(m.lastTs, T + 2000);
    assert.equal(m.lastText, '要撤回的');

    assert.equal(S.markRecalled(k, '不存在的 mid'), false);
    assert.equal(S.getChatMeta(k).unread, 1);
  });

  // ══ 6. remove / prune / clear / trim ══
  await check('6. removeByLocalIds/pruneBefore/clearChat/#trim 后 meta 重算正确', () => {
    const k = 'group:1006';
    const a = S.appendIncoming(k, { mid: 'a', ts: T + 100, senderId: 'u1', senderName: '甲', text: 'old' });
    S.appendIncoming(k, { mid: 'b', ts: T + 200, senderId: 'u1', senderName: '甲', text: 'new' });

    assert.equal(S.removeByLocalIds(k, [a.id]), 1);
    let m = S.getChatMeta(k);
    assert.equal(m.total, 1);
    assert.equal(m.unread, 1);
    assert.equal(m.lastText, 'new');

    // 只保留 ts >= cutoff 的。注意 pruneBefore 遍历**所有** chat，
    // 返回值是全局条数（其它用例的旧消息也会被算进去），这里只断言本 chat 的结果。
    assert.equal(S.pruneBefore(0), 0, 'cutoff 非法时直接不删');
    assert.equal(S.getChatMeta(k).total, 1);
    S.pruneBefore(T + 250);
    assert.equal(S.getChatMeta(k).total, 0, '早于 cutoff 的消息应被删掉');

    // clearChat
    S.appendIncoming(k, { mid: 'c', ts: T + 300, senderId: 'u1', senderName: '甲', text: 'c' });
    S.clearChat(k);
    m = S.getChatMeta(k);
    assert.equal(m.total, 0);
    assert.equal(m.unread, 0);
    assert.equal(m.lastText, '');

    // #trim：超过 maxPerChat 裁掉最老的
    const kt = 'group:1006t';
    const trimmed = new ChatStore(2);
    trimmed.appendIncoming(kt, { mid: 't1', ts: T + 1, senderId: 'u1', senderName: '甲', text: '1' });
    trimmed.appendIncoming(kt, { mid: 't2', ts: T + 2, senderId: 'u1', senderName: '甲', text: '2' });
    trimmed.appendIncoming(kt, { mid: 't3', ts: T + 3, senderId: 'u1', senderName: '甲', text: '3' });
    const tm = trimmed.getChatMeta(kt);
    assert.equal(tm.total, 2, 'maxPerChat=2 时只保留最近两条');
    assert.equal(tm.lastText, '3');
    assert.equal(tm.lastTs, T + 3);
  });

  // ══ 7. 缓存：命中 / 旧月份追加失效 / legacy 变化失效 / 自身写盘不失效 ══
  await check('7. meta-index 指纹：命中、旧月份追加与 legacy 变化都 miss、自身写盘不 miss', async () => {
    const k = 'group:1007';
    S.appendIncoming(k, { mid: 'a', ts: T + 1000, senderId: 'u1', senderName: '甲', text: '今天' });
    // 新建的 chat 走 loadChat 的空分支（磁盘上还没有文件），不会自动 seed；
    // 用 recomputeMeta 显式做一次「重算 + 同步缓存」，等价于冷加载后的 seed。
    S.recomputeMeta(k);
    assert.ok(mod.flushMetaCache() > 0, 'flushMetaCache 应写盘');
    assert.ok(fs.existsSync(META_INDEX), '缓存文件应存在');
    const written = readMetaIndex();
    assert.equal(written.version, 1);
    assert.ok(written.chats[safeKey(k)], '缓存里应有该 chat');

    // 冷启动（新模块实例，必须从磁盘读）
    const m2 = await loadStore();
    let hit = m2.peekChatMeta(k);
    assert.equal(hit.hit, true, '指纹未变时应命中');
    assert.equal(hit.meta.total, 1);
    assert.equal(hit.meta.lastText, '今天');

    // 追加**旧月份**文件：只取“最新月文件”的实现会漏判
    const oldYm = '2020-01';
    fs.writeFileSync(shardOf(k, oldYm), `${JSON.stringify({ id: 9001, ts: Date.parse('2020-01-05T00:00:00'), text: '补录旧消息', self: false, read: true })}\n`, 'utf8');
    const m3 = await loadStore();
    hit = m3.peekChatMeta(k);
    assert.equal(hit.hit, false, '旧月份追加必须让缓存失效');
    assert.equal(hit.stale, true);

    // 重建缓存后自身写盘不能导致永久 miss
    const s3 = new m3.ChatStore(0);
    s3.recomputeMeta(k);
    m3.flushMetaCache();
    const m4 = await loadStore();
    assert.equal(m4.peekChatMeta(k).hit, true, '缓存自身写盘不得改变指纹');

    // legacy 扁平文件变化：删分片目录、写 .json → 指纹整体变化
    fs.rmSync(dirOf(k), { recursive: true, force: true });
    fs.writeFileSync(legacyOf(k), JSON.stringify({
      nextLocalId: 2,
      messages: [{ id: 1, mid: 'a', ts: T + 1000, senderId: 'u1', senderName: '甲', text: '旧格式', self: false, read: false }]
    }), 'utf8');
    const m5 = await loadStore();
    hit = m5.peekChatMeta(k);
    assert.equal(hit.hit, false, 'legacy 文件出现/变化必须让缓存失效');

    // 再加载一次应能读 legacy 并种回缓存
    const s5 = new m5.ChatStore(0);
    const lm = s5.getChatMeta(k);
    assert.equal(lm.total, 1);
    assert.equal(lm.lastText, '旧格式');
    s5.recomputeMeta(k);
    m5.flushMetaCache();
    const m6 = await loadStore();
    assert.equal(m6.peekChatMeta(k).hit, true);
    assert.equal(m6.peekChatMeta(k).meta.lastText, '旧格式');
  });

  // ══ 9. 计数器破坏后 recomputeMeta 恢复 ══
  await check('9. 计数器被破坏后 recomputeMeta 能恢复到真实值', () => {
    const k = 'group:1009';
    S.appendIncoming(k, { mid: 'a', ts: T + 1000, senderId: 'u1', senderName: '甲', text: '一' });
    S.appendIncoming(k, { mid: 'b', ts: T + 2000, senderId: 'u1', senderName: '甲', text: '二' });
    const st = S.chats.get(k);
    assert.ok(st, 'chat 应已加载');
    st.meta = { total: 99, unread: 42, lastTs: 1, lastText: '坏值' };   // 故意破坏

    const fixed = S.recomputeMeta(k);
    assert.equal(fixed.total, 2);
    assert.equal(fixed.unread, 2);
    assert.equal(fixed.lastTs, T + 2000);
    assert.equal(fixed.lastText, '二');
    assert.equal(S.getChatMeta(k).total, 2, 'recompute 后 getChatMeta 也应正确');
  });

  // ══ 10. listChatKeys ══
  await check('10. listChatKeys 返回磁盘 ∪ 内存，且不触发 #state 加载', async () => {
    const m = await loadStore();
    // 磁盘上放一个从未加载过的 chat（直接写分片，不经过 Store）
    const diskKey = 'group:2010';
    fs.mkdirSync(dirOf(diskKey), { recursive: true });
    fs.writeFileSync(shardOf(diskKey, '2021-03'), `${JSON.stringify({ id: 1, ts: Date.parse('2021-03-01T00:00:00'), text: '磁盘上', self: false, read: false })}\n`, 'utf8');
    // 干扰项：_legacy、非数字后缀、普通目录、无关文件
    fs.mkdirSync(path.join(MSG_DIR, '_legacy'), { recursive: true });
    fs.mkdirSync(path.join(MSG_DIR, 'group_abc'), { recursive: true });
    fs.mkdirSync(path.join(MSG_DIR, 'random_dir'), { recursive: true });
    fs.writeFileSync(path.join(MSG_DIR, 'notes.txt'), 'x', 'utf8');
    // 旧扁平格式
    fs.writeFileSync(legacyOf('private:2011'), JSON.stringify({ nextLocalId: 1, messages: [] }), 'utf8');

    const s = new m.ChatStore(0);
    const keys = s.listChatKeys();
    assert.ok(keys.includes(diskKey), '磁盘目录必须被发现');
    assert.ok(keys.includes('private:2011'), '旧扁平 .json 也必须被发现');
    assert.equal(keys.includes('group_abc'), false, '非数字后缀不算 chat');
    assert.equal(keys.includes('random_dir'), false, '无关目录不算 chat');
    assert.equal(keys.some((k) => k.includes('_legacy')), false, '_legacy 是迁移源，不是 chat');
    assert.equal(s.chats.size, 0, 'listChatKeys 不得调用 #state（否则会全部加载）');

    // 内存中尚未落盘的 chat 也要在
    s.chats.set('private:2012', { chatKey: 'private:2012', nextLocalId: 1, messages: [], meta: { total: 0, unread: 0, lastTs: 0, lastText: '' } });
    assert.ok(s.listChatKeys().includes('private:2012'), '内存中未落盘的 chat 必须合并进来');
  });

  // ══ 11. P1-01b：/api/chats 读路径已切换，排序与群名保留 ══
  await check('11. /api/chats 走 listChatKeys+chatMetaForList，保留 lastTs 排序与群名', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    const i = src.indexOf("pattern: '/api/chats'");
    assert.ok(i > 0, '应能定位 /api/chats');
    const block = src.slice(i, i + 900);
    assert.ok(/store\.listChatKeys\(\)/.test(block), 'P1-01b 应改用 listChatKeys（readdir，不全量加载）');
    assert.ok(/chatMetaForList/.test(block), 'P1-01b 应走 chatMetaForList');
    assert.equal(/store\.listChats\(\)/.test(block), false, '不应再全量 listChats');
    assert.ok(/b\.lastTs - a\.lastTs/.test(block), '必须保留 lastTs 倒序');
    assert.ok(/chatName/.test(block), '必须保留群名富化');

    // 行为：同一实例内新消息与已读立即反映（增量 meta 必须跟得上）
    const k = 'group:1011';
    S.appendIncoming(k, { mid: 'a', ts: T + 5000, senderId: 'u1', senderName: '甲', text: '新消息' });
    assert.equal(S.getChatMeta(k).unread, 1, '新消息后角标应立即可见');
    S.markAllRead(k);
    assert.equal(S.getChatMeta(k).unread, 0, '已读后角标应立即归零');
    assert.equal(S.chatMetaForList(k).total, 1, '列表读路径与 getChatMeta 同源');
  });

  // ══ 13. updateByMid ══
  await check('13. updateByMid：展开最后一条后 lastText 立即更新，非最后一条不影响预览', () => {
    const k = 'group:1013';
    S.appendIncoming(k, { mid: 'a', ts: T + 1000, senderId: 'u1', senderName: '甲', text: '占位一' });
    S.appendIncoming(k, { mid: 'b', ts: T + 2000, senderId: 'u1', senderName: '甲', text: '[合并转发] 占位' });
    let m = S.getChatMeta(k);
    assert.equal(m.lastText, '[合并转发] 占位');

    // 非最后一条：lastTs/lastText 不变
    assert.equal(S.updateByMid(k, 'a', { text: '展开后的第一条' }), true);
    m = S.getChatMeta(k);
    assert.equal(m.lastTs, T + 2000);
    assert.equal(m.lastText, '[合并转发] 占位', '非最后一条更新不影响预览');
    assert.equal(m.total, 2);
    assert.equal(m.unread, 2);

    // 最后一条：lastText 必须立即跟着变，total/unread 不变
    assert.equal(S.updateByMid(k, 'b', { text: '展开后的转发正文' }), true);
    m = S.getChatMeta(k);
    assert.equal(m.lastTs, T + 2000, 'ts 未变，lastTs 不变');
    assert.equal(m.lastText, '展开后的转发正文', '最后一条展开后 lastText 必须同步');
    assert.equal(m.total, 2);
    assert.equal(m.unread, 2);

    // 补媒体不影响文本
    assert.equal(S.updateByMid(k, 'b', { appendMedia: [{ url: 'http://x/1.jpg', file: '1.jpg' }] }), true);
    assert.equal(S.getChatMeta(k).lastText, '展开后的转发正文');
    assert.equal(S.updateByMid(k, '不存在', { text: 'x' }), false);
  });

  // ══ 8. 冷缓存首次全量 → 第二次全命中（不再 loadChat）══
  const LIST_KEYS = Array.from({ length: 60 }, (_, i) => `group:${8000 + i}`);
  await check('8. 冷缓存首次解析全部 chat 并写缓存，第二次起 loadChat 次数为 0', async () => {
    const mSeed = await loadStore();
    const seed = new mSeed.ChatStore(0);
    for (let i = 0; i < LIST_KEYS.length; i += 1) {
      seed.appendIncoming(LIST_KEYS[i], {
        mid: `seed-${i}`, ts: T + i * 1000, senderId: 'u1', senderName: '甲', text: `第${i}条`
      });
    }
    mSeed.flushMetaCache();
    // 真正的“冷缓存”：文件都在，但缓存被清空（等价于首次装上本版本）
    fs.rmSync(META_INDEX, { force: true });

    const m1 = await loadStore();
    const s1 = new m1.ChatStore(0);
    assert.equal(s1.chats.size, 0, '冷启动时不应有任何 chat 在内存');
    const first = LIST_KEYS.map((k) => s1.chatMetaForList(k));
    assert.equal(s1.chats.size, LIST_KEYS.length, '首次请求必须解析全部 chat 并写出缓存');
    assert.equal(first[0].total, 1);
    assert.equal(first[0].lastText, '第0条');
    assert.ok(m1.flushMetaCache() > 0, '首次解析后应写出缓存');

    const m2 = await loadStore();
    const s2 = new m2.ChatStore(0);
    const second = LIST_KEYS.map((k) => s2.chatMetaForList(k));
    assert.equal(s2.chats.size, 0, '第二次请求必须全部命中缓存，loadChat 调用次数为 0');
    assert.equal(second[59].lastText, '第59条', '缓存里的 lastText 必须正确');
  });

  // ══ 12. 第二次请求 <50ms、lastTs 倒序 ══
  await check('12. 第二次请求（群名已缓存）<50ms，且按 lastTs 倒序', async () => {
    const m = await loadStore();
    const s = new m.ChatStore(0);
    const t0 = performance.now();
    const metas = LIST_KEYS.map((k) => s.chatMetaForList(k)).sort((a, b) => b.lastTs - a.lastTs);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `第二次请求应 <50ms（实际 ${ms.toFixed(1)}ms）`);
    assert.ok(metas[0].lastTs > metas[1].lastTs, '必须按 lastTs 倒序');
    assert.equal(metas[0].lastText, '第59条', '最新一条应在最前');
    assert.equal(s.chats.size, 0, '计时路径不得触发加载');
  });
} finally {
  try { mod.flushMetaCache(); } catch { /* ignore */ }
}

console.log(`\n聊天 meta + listChatKeys（P1-01）：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
