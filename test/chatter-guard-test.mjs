// 水聊免回（chatter-guard）：判定 / @ 剔除 / 连续计数 / 阈值 / 统计 / 挂载幂等。
// 全程离线：不启动 app、不连 OneBot，数据目录隔离到临时目录（只为 logger 兜底）。
//
// 运行：node test/chatter-guard-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-chatter-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const c = createChecker('水聊免回（chatter-guard）');
const { internals, setup } = await import('../plugins/chatter-guard/index.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { isMediaOnly, isFiller, waterReason, stripAtSegments, streaks, stats, veto, install, uninstall } = internals;

let cfg = {};
setup({ config: () => cfg });
const orch = { onebot: { selfId: '999999' } };
const entry = (text, extra = {}) => ({ id: 1, senderId: '123', senderName: '甲', text, atMe: null, atNames: [], ...extra });
const pokeEntry = (extra = {}) => entry('[拍一拍] 甲(QQ:123) 拍了拍 我', { isPoke: true, ...extra });
const reset = (next = {}) => { streaks.clear(); cfg = { ...next }; };
const resetStats = () => { stats.suppressed = 0; stats.today = 0; stats.day = ''; stats.byReason = {}; };

await c.check('1 纯媒体判定：图片/表情/空/纯标点是水，带字不是', () => {
  assert.equal(isMediaOnly('[图片]'), true);
  assert.equal(isMediaOnly('[表情12]'), true);
  assert.equal(isMediaOnly(''), true);
  assert.equal(isMediaOnly('？？？'), true);
  assert.equal(isMediaOnly('[图片]你好'), false);
});

await c.check('2 水词判定：内置词 / 重复字 / 自定义词', () => {
  for (const t of ['哈哈', '哈哈哈哈', '6', '？', '。。。', 'hhh', 'ok', 'OK']) assert.equal(isFiller(t), true, t);
  for (const t of ['在吗', '谢谢', '几点', 'Ok', '今天吃什么']) assert.equal(isFiller(t), false, t);
  assert.equal(isFiller('水', { fillerWords: '水' }), true);
});

await c.check('3 waterReason：媒体优先 / 水话其次 / 正常放行', () => {
  assert.equal(waterReason({ text: '[图片]' }), '只有表情/图片');
  assert.equal(waterReason({ text: '哈哈' }), '纯水话');
  assert.equal(waterReason({ text: '今天吃什么' }), null);
  assert.equal(waterReason({ text: '[图片]' }, { skipMedia: false }), null);
});

await c.check('3b 戳一戳：默认算水；skipPoke 关掉后放行；普通文字不受影响', () => {
  assert.equal(waterReason(pokeEntry()), '戳一戳');
  assert.equal(waterReason(pokeEntry(), { skipPoke: false }), null);
  assert.equal(waterReason(entry('拍一拍是什么')), null);
  assert.equal(waterReason(entry('[拍一拍] 甲 拍了拍 乙')), null);
});

await c.check('4 剔除 @ 片段：只做精确替换', () => {
  assert.equal(stripAtSegments('@机器人 [图片]', { atNames: ['@机器人'] }), '[图片]');
  assert.equal(stripAtSegments('@全体成员', { atNames: ['@全体成员'] }), '');
  assert.equal(stripAtSegments('@张三(QQ:1) 哈哈', { atNames: ['@张三(QQ:1)'] }), '哈哈');
  assert.equal(stripAtSegments('普通消息', {}), '普通消息');
  assert.equal(stripAtSegments('@机器人 [图片]', {}), '@机器人 [图片]');
});

await c.check('4b 前缀相同的昵称：按长度倒序替换，不拆坏长昵称', () => {
  // 先剔「@张三」会把「@张三丰」拆成「@张三」+「丰」，剩下的「丰 [图片]」就不算纯媒体。
  assert.equal(stripAtSegments('@张三 @张三丰 [图片]', { atNames: ['@张三', '@张三丰'] }), '[图片]');
  assert.equal(waterReason({ text: '@张三 @张三丰 [图片]', atNames: ['@张三', '@张三丰'] }), '只有表情/图片');
});

await c.check('5 @ + 水：先剔 @ 再判；只有 @ 的召唤不算水', () => {
  assert.equal(waterReason({ text: '@机器人 [图片]', atNames: ['@机器人'] }), '只有表情/图片');
  assert.equal(waterReason({ text: '@机器人 6', atNames: ['@机器人'] }), '纯水话');
  assert.equal(waterReason({ text: '@机器人', atNames: ['@机器人'] }), null);
  assert.equal(waterReason({ text: '@全体成员', atNames: ['@全体成员'] }), null);
});

await c.check('6 默认阈值 3：前两条放行、第三条免回', () => {
  reset();
  assert.equal(veto(orch, 'group:1', entry('[图片]')), null);
  assert.equal(veto(orch, 'group:1', entry('[图片]')), null);
  const hit = veto(orch, 'group:1', entry('[图片]'));
  assert.deepEqual({ reason: hit.reason, count: hit.count }, { reason: '只有表情/图片', count: 3 });
});

await c.check('6b 连续 3 次戳一戳：前两次放行、第三次免回', () => {
  reset();
  assert.equal(veto(orch, 'group:1', pokeEntry()), null);
  assert.equal(veto(orch, 'group:1', pokeEntry()), null);
  const hit = veto(orch, 'group:1', pokeEntry());
  assert.deepEqual({ reason: hit.reason, count: hit.count }, { reason: '戳一戳', count: 3 });
});

await c.check('6c 戳一戳与表情/水话共用连续计数', () => {
  reset();
  veto(orch, 'group:1', pokeEntry());
  veto(orch, 'group:1', entry('[图片]'));
  const hit = veto(orch, 'group:1', pokeEntry());
  assert.deepEqual({ reason: hit.reason, count: hit.count }, { reason: '戳一戳', count: 3 });
});

await c.check('6d 戳一戳之间插一句正常话 → 重新计数', () => {
  reset();
  veto(orch, 'group:1', pokeEntry());
  veto(orch, 'group:1', pokeEntry());
  veto(orch, 'group:1', entry('今天吃什么'));
  veto(orch, 'group:1', pokeEntry());
  assert.equal(streaks.get('group:1|123').count, 1);
});

await c.check('6e 戳一戳超过时间窗 → 重新计数', () => {
  reset({ windowSec: 180 });
  veto(orch, 'group:1', pokeEntry());
  streaks.get('group:1|123').at = Date.now() - 181_000;
  veto(orch, 'group:1', pokeEntry());
  assert.equal(streaks.get('group:1|123').count, 1);
});

await c.check('7 中间插一句正常话 → 重新计数', () => {
  reset();
  veto(orch, 'group:1', entry('[图片]'));
  veto(orch, 'group:1', entry('今天吃什么'));
  assert.equal(streaks.size, 0);
  veto(orch, 'group:1', entry('[图片]'));
  assert.equal(streaks.get('group:1|123').count, 1);
});

await c.check('8 超过时间窗 → 重新计数', () => {
  reset({ windowSec: 180 });
  veto(orch, 'group:1', entry('[图片]'));
  streaks.get('group:1|123').at = Date.now() - 181_000;
  veto(orch, 'group:1', entry('[图片]'));
  assert.equal(streaks.get('group:1|123').count, 1);
});

await c.check('9 阈值可配（2）', () => {
  reset({ threshold: 2 });
  assert.equal(veto(orch, 'group:1', entry('哈哈')), null);
  assert.equal(veto(orch, 'group:1', entry('哈哈')).count, 2);
});

await c.check('10 @ 时仍回：开着则 @ 的消息一律放行并清零', () => {
  reset({ alwaysReplyWhenAtMe: true });
  for (let i = 0; i < 4; i++) {
    assert.equal(veto(orch, 'group:1', entry('@机器人 [图片]', { atNames: ['@机器人'], atMe: true })), null);
  }
  assert.equal(streaks.size, 0);
});

await c.check('11 @全体成员：开着时豁免；关着时按水计数', () => {
  reset({ alwaysReplyWhenAtMe: true });
  assert.equal(veto(orch, 'group:1', entry('@全体成员 [图片]', { atNames: ['@全体成员'], atMe: false })), null);
  reset();
  const all = () => entry('@全体成员 [图片]', { atNames: ['@全体成员'], atMe: false });
  veto(orch, 'group:1', all());
  veto(orch, 'group:1', all());
  assert.equal(veto(orch, 'group:1', all()).count, 3);
});

await c.check('12 放行：无条目 / 机器人自己 / 关闭 / 私聊主人', () => {
  // 预置"已连发 2 条"：如果豁免失效，下一条会被判第 3 条，断言才抓得到。
  // 不预置的话，这些断言即使豁免逻辑写坏了也会因为"计数不足"而通过（空转）。
  const seed = (key = 'group:1|123') => { streaks.clear(); streaks.set(key, { count: 2, at: Date.now() }); };
  const kept = (key = 'group:1|123') => streaks.get(key)?.count;

  reset();
  assert.equal(veto(orch, 'group:1', null), null);

  seed();
  assert.equal(veto(orch, 'group:1', entry('[图片]', { self: true })), null);
  assert.equal(kept(), 2, '机器人自己的消息不该计数');

  seed();
  assert.equal(veto(orch, 'group:1', entry('[图片]', { senderId: '999999' })), null);
  assert.equal(kept(), 2, 'selfId 自己的消息不该计数');

  seed();
  assert.equal(veto(orch, 'group:1', entry('[图片]', { senderId: 'self' })), null);
  assert.equal(kept(), 2, 'senderId=self 不该计数');

  reset({ enabled: false });
  seed();
  assert.equal(veto(orch, 'group:1', entry('[图片]')), null);
  assert.equal(kept(), 2, '关闭时不该计数');

  reset({ ownerIds: '123' });
  seed('private:123|123');
  assert.equal(veto(orch, 'private:123', entry('[图片]')), null);
  assert.equal(kept('private:123|123'), 2, '主人私聊是管理通道，不该计数');
});

await c.check('12b 戳一戳豁免：主人私聊 / 机器人自己', () => {
  reset({ ownerIds: '123' });
  assert.equal(veto(orch, 'private:123', pokeEntry()), null);
  assert.equal(streaks.size, 0, '主人私聊不计数');

  reset();
  assert.equal(veto(orch, 'group:1', pokeEntry({ self: true })), null);
  assert.equal(veto(orch, 'group:1', pokeEntry({ senderId: '999999' })), null);
  assert.equal(veto(orch, 'group:1', pokeEntry({ senderId: 'self' })), null);
  assert.equal(streaks.size, 0, '机器人自己的戳不计数');
});

await c.check('13 统计：拦截时计数（走真实包装器）', () => {
  reset();
  resetStats();
  const proto = Orchestrator.prototype;
  const fake = { store: { markEntryRead() {} }, emit() {}, onebot: { selfId: '999999' } };
  try {
    install();
    // 预置成"已连发 2 条"，下一次命中即第 3 条 —— 包装器会直接返回，不会落到真正的 onIncoming
    streaks.set('group:1|123', { count: 2, at: Date.now() });
    assert.equal(proto.onIncoming.call(fake, 'group:1', entry('[图片]')), undefined);
    assert.equal(stats.today, 1);
    assert.equal(stats.byReason['只有表情/图片'], 1);
    assert.equal(stats.suppressed, 1);
    assert.match(stats.lastReason, /连着第 3 条/);
  } finally {
    uninstall();
    streaks.clear();
  }
});

await c.check('13b 统计：每第 10 条免回打一条汇总日志', async () => {
  reset();
  resetStats();
  const { logger } = await import('../src/logger.js');
  const logs = [];
  const orig = logger.info;
  logger.info = (module, ...args) => { if (module === 'chatter-guard') logs.push(String(args[0] ?? '')); };
  const proto = Orchestrator.prototype;
  const fake = { store: { markEntryRead() {} }, emit() {}, onebot: { selfId: '999999' } };
  try {
    install();
    for (let i = 0; i < 10; i++) {
      streaks.set('group:1|123', { count: 2, at: Date.now() });
      proto.onIncoming.call(fake, 'group:1', entry('[图片]'));
    }
    assert.equal(stats.today, 10);
    const summary = logs.filter((s) => s.startsWith('今日已免回'));
    assert.equal(summary.length, 1, `应恰好 1 条汇总，实际 ${summary.length}`);
    assert.match(summary[0], /今日已免回 10 条（只有表情\/图片 10）/);
  } finally {
    uninstall();
    delete logger.info;
    streaks.clear();
  }
});

await c.check('13c 统计：戳一戳免回按「戳一戳」记原因', () => {
  reset();
  resetStats();
  const proto = Orchestrator.prototype;
  const fake = { store: { markEntryRead() {} }, emit() {}, onebot: { selfId: '999999' } };
  try {
    install();
    streaks.set('group:1|123', { count: 2, at: Date.now() });
    assert.equal(proto.onIncoming.call(fake, 'group:1', pokeEntry()), undefined);
    assert.equal(stats.today, 1);
    assert.equal(stats.byReason['戳一戳'], 1);
    assert.match(stats.lastReason, /戳一戳（连着第 3 条）/);
  } finally {
    uninstall();
    streaks.clear();
  }
});

await c.check('14 挂载幂等：重复 install 只包一层，uninstall 还原原型', () => {
  const proto = Orchestrator.prototype;
  const original = proto.onIncoming;
  let wrapped = null;
  try {
    install();
    wrapped = proto.onIncoming;
    assert.notEqual(wrapped, original);
    install();
    assert.equal(proto.onIncoming, wrapped);
    assert.equal(proto[Symbol.for('qq-agent.chatter-guard.patch')].wrapped, wrapped);
  } finally {
    uninstall();
  }
  assert.equal(proto.onIncoming, original);
  assert.equal(proto[Symbol.for('qq-agent.chatter-guard.patch')], undefined);
});

await c.check('15 畸形条目不抛错', () => {
  reset();
  for (const e of [undefined, {}, { text: null }, { text: '[图片]', atNames: 'x' }, { text: '[图片]', senderId: 0 }]) {
    assert.doesNotThrow(() => veto(orch, 'group:1', e));
  }
});

fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(c.finish() ? 0 : 1);
