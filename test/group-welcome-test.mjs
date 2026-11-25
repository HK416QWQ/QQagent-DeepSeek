// GroupWelcome 模块单测（P0-04a，19 组）。
//
// 不启 app、不连 OneBot、不碰文件：sender / timer / 时钟 / 随机全部注入。
// fake timer 捕获回调后由测试手动触发，断言"不重置"看的是"只创建了一个定时器"。
//
// 三个最容易假绿的地方（见施工单 §3.12 A/B/C）：
//   A. 退出码必须落地 —— 用 createChecker 的 finish()，它会把失败写进 process.exitCode
//   B. check 必须 await —— 用例里有 await triggerAll()，不 await 就断言等于没测
//   C. triggerAll 必须 await —— #flush 里有两处 await，不等它就是在测"还没发"
import assert from 'node:assert/strict';
import { createChecker } from './_harness.mjs';
import {
  GroupWelcome,
  WELCOME_DEBOUNCE_MS,
  WELCOME_MAX_ATS,
  WELCOME_USER_TTL_MS,
  WELCOME_STICKER_ID,
  WELCOME_VARIANTS,
  seenKey
} from '../src/group-welcome.js';

const checker = createChecker('群入群欢迎模块');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let clock = 1_000_000;   // 统一的 fake 时钟（毫秒）

/** fake timer：id 从 0 开始（专门验证实现用的是 == null 而不是 !buf.timer）。 */
function makeTimers() {
  const map = new Map();
  let seq = 0;
  return {
    setTimer(fn, ms) { const id = seq; seq += 1; map.set(id, { fn, ms }); return id; },
    clearTimer(id) { map.delete(id); },
    size() { return map.size; },
    ids() { return [...map.keys()]; },
    async triggerAll() {
      const pending = [...map.values()];
      map.clear();
      // 回调返回 promise（实现里必须 return 出去），Promise.all 才能真正等到发完
      return Promise.all(pending.map((t) => t.fn()));
    }
  };
}

/** fake sender：记录成功发送的正文与 options，可按需挂起或失败一次。 */
function makeSender() {
  const sender = {
    sent: [],
    options: [],
    attempts: 0,
    hold: null,
    failOnce: false,
    stickers: [],
    stickerAttempts: 0,
    stickerFailOnce: false,
    events: [],
    async sendTextBatch(chatKey, messages, options = {}) {
      sender.attempts += 1;
      sender.options.push(options);
      if (sender.hold) await sender.hold;
      if (sender.failOnce) { sender.failOnce = false; throw new Error('模拟发送失败'); }
      sender.sent.push(messages[0]);
      sender.events.push({ type: 'text', chatKey, text: messages[0] });
      return { sent: [{ text: messages[0] }], failed: [] };
    },
    async sendSticker(chatKey, sticker, options = {}) {
      sender.stickerAttempts += 1;
      if (sender.stickerFailOnce) {
        sender.stickerFailOnce = false;
        throw new Error('模拟表情发送失败');
      }
      sender.stickers.push({ chatKey, sticker, options });
      sender.events.push({ type: 'sticker', chatKey, sticker });
      return { message_id: 9000 + sender.stickers.length };
    }
  };
  return sender;
}

function makeStickers({ enabled = true, found = { id: WELCOME_STICKER_ID, url: 'file:///tmp/peek.png' } } = {}) {
  const stickers = {
    enabled,
    ensureCalls: 0,
    findCached(ref) {
      return found && ref === found.id ? found : null;
    },
    ensureSendable(sticker) {
      stickers.ensureCalls += 1;
      return sticker;
    }
  };
  return stickers;
}

const ev = (groupId, userId, extra = {}) => ({
  post_type: 'notice',
  notice_type: 'group_increase',
  sub_type: 'approve',
  group_id: groupId,
  user_id: userId,
  operator_id: 0,
  self_id: 888,
  time: Math.floor(Date.now() / 1000),
  ...extra
});

function makeWelcome({
  timers,
  sender,
  stickers = null,
  onebot = { selfId: '888' },
  isAllowed = () => true,
  isMuted = async () => false,
  isPaused = () => false,
  random = () => 0,
  initialSeen = new Map(),
  persistSeen = null,
  logs = []
} = {}) {
  return new GroupWelcome({
    sender,
    onebot,
    stickers,
    isAllowed,
    isMuted,
    isPaused,
    log: (m) => logs.push(String(m)),
    now: () => clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random,
    initialSeen,
    persistSeen
  });
}

// ── 1. 合并 ───────────────────────────────────────────────────────────────
await checker.check('1 合并：3 人一条、at 按入群顺序、正文 many(3)', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const w = makeWelcome({ timers, sender, random: () => 0 });
  w.onJoin(ev(456, 111));
  w.onJoin(ev(456, 222));
  w.onJoin(ev(456, 333));
  assert.equal(timers.size(), 1, '只应创建一个定时器');
  assert.equal(timers.ids()[0], 0, 'fake timer 首个 id 为 0（验证 == null 判空）');
  await timers.triggerAll();
  assert.equal(sender.sent.length, 1, '同一窗口只发一条');
  assert.deepEqual(sender.options[0].atUserIds, ['111', '222', '333']);
  assert.equal(sender.sent[0], WELCOME_VARIANTS[0].many(3), '3 人必须用带人数的句子');
});

// ── 2. 不重置 ─────────────────────────────────────────────────────────────
await checker.check('2 不重置：2 秒后第二个事件，仍只有一个定时器', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const w = makeWelcome({ timers, sender, random: () => 0 });
  w.onJoin(ev(456, 211));
  clock += 2000;                       // "2 秒后"——定时器是假的，推进时钟表达语义
  w.onJoin(ev(456, 212));
  assert.equal(timers.size(), 1, '第二个事件不应重置/新建定时器');
  await timers.triggerAll();
  assert.deepEqual(sender.options[0].atUserIds, ['211', '212']);
  assert.equal(sender.sent.length, 1);
});

// ── 3. 同 user 去重 ───────────────────────────────────────────────────────
await checker.check('3 同 user 去重：两次事件只产生一个 at', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const w = makeWelcome({ timers, sender });
  w.onJoin(ev(456, 321));
  w.onJoin(ev(456, 321));
  await timers.triggerAll();
  assert.deepEqual(sender.options[0].atUserIds, ['321']);
  assert.equal(sender.sent.length, 1);
});

// ── 4. 守卫 ───────────────────────────────────────────────────────────────
await checker.check('4 守卫：非法 group/user、selfId 双空、self-join、白名单外都不排队', async () => {
  clock = 1_000_000;
  const cases = [
    { name: 'user_id=0', build: () => ({ event: ev(456, 0) }), reason: 'invalid-user' },
    { name: 'user_id 非数字', build: () => ({ event: ev(456, 'abc') }), reason: 'invalid-user' },
    { name: 'user_id 前导零', build: () => ({ event: ev(456, '0123') }), reason: 'invalid-user' },
    { name: 'user_id 负数', build: () => ({ event: ev(456, '-1') }), reason: 'invalid-user' },
    { name: 'user_id 小数', build: () => ({ event: ev(456, '1.5') }), reason: 'invalid-user' },
    { name: 'user_id=all', build: () => ({ event: ev(456, 'all') }), reason: 'invalid-user' },
    { name: 'group_id=0', build: () => ({ event: ev(0, 111) }), reason: 'invalid-group' },
    { name: 'group_id 前导零', build: () => ({ event: ev('0456', 111) }), reason: 'invalid-group' },
    { name: 'group_id 非数字', build: () => ({ event: ev('abc', 111) }), reason: 'invalid-group' },
    { name: 'selfId 双空', build: () => ({ event: ev(456, 111, { self_id: undefined }), onebot: { selfId: '' } }), reason: 'self-id-empty' },
    { name: 'self-join', build: () => ({ event: ev(456, 888) }), reason: 'self-join' },
    { name: '白名单外', build: () => ({ event: ev(789, 111), isAllowed: () => false }), reason: 'not-allowed' }
  ];
  for (const c of cases) {
    const timers = makeTimers();
    const sender = makeSender();
    const logs = [];
    const { event, onebot, isAllowed } = c.build();
    const w = makeWelcome({ timers, sender, logs, onebot, isAllowed });
    w.onJoin(event);
    assert.equal(timers.size(), 0, `${c.name} 不应创建定时器`);
    assert.ok(logs.some((l) => l.includes(`reason=${c.reason}`)), `${c.name} 应记 reason=${c.reason}，实际 ${JSON.stringify(logs)}`);
  }
  // 非 group_increase / 非对象：静默丢弃，不记日志
  const timers = makeTimers();
  const logs = [];
  const w = makeWelcome({ timers, sender: makeSender(), logs });
  w.onJoin({ post_type: 'notice', notice_type: 'group_recall', group_id: 456, user_id: 111 });
  w.onJoin(null);
  w.onJoin('not-an-object');
  assert.equal(timers.size(), 0);
  assert.equal(logs.length, 0, '非入群事件不应产生日志噪声');
});

// ── 5. flush 重检白名单 ───────────────────────────────────────────────────
await checker.check('5 flush 重检白名单：窗口期内被移出白名单就不发', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const logs = [];
  let allowedNow = true;
  const w = makeWelcome({ timers, sender, logs, isAllowed: () => allowedNow });
  w.onJoin(ev(456, 511));
  allowedNow = false;
  await timers.triggerAll();
  assert.equal(sender.sent.length, 0, '白名单已关，不应发送');
  assert.ok(logs.some((l) => l.includes('reason=not-allowed')));
});

// ── 6. flush 重检禁言 / fail-open ─────────────────────────────────────────
await checker.check('6 禁言：true 不发；reject 按未禁言发（fail-open）', async () => {
  clock = 1_000_000;
  // 6a：确实被禁言
  {
    const timers = makeTimers();
    const sender = makeSender();
    const logs = [];
    const w = makeWelcome({ timers, sender, logs, isMuted: async () => true });
    w.onJoin(ev(456, 611));
    await timers.triggerAll();
    assert.equal(sender.sent.length, 0, '禁言中不应发送');
    assert.ok(logs.some((l) => l.includes('reason=muted')));
  }
  // 6b：查询 reject → 放行，且不产生 muted 日志
  {
    const timers = makeTimers();
    const sender = makeSender();
    const logs = [];
    const w = makeWelcome({
      timers,
      sender,
      logs,
      isMuted: async () => { throw new Error('禁言查询失败'); }
    });
    w.onJoin(ev(456, 612));
    await timers.triggerAll();
    assert.equal(sender.sent.length, 1, '查询失败应按未禁言继续');
    assert.ok(!logs.some((l) => l.includes('reason=muted')), '不应记 muted');
    assert.ok(!logs.some((l) => l.includes('发送失败')), 'fail-open 不是失败');
  }
});

// ── 7. at 参数与变体 ─────────────────────────────────────────────────────
await checker.check('7 at 参数与三档变体：单人 short、双人 many(2)、顺序=入群顺序', async () => {
  clock = 1_000_000;
  const tiers = [
    { random: () => 0, idx: 0 },
    { random: () => 0.5, idx: 1 },
    { random: () => 0.999, idx: 2 }
  ];
  for (const t of tiers) {
    const timers = makeTimers();
    const sender = makeSender();
    const w = makeWelcome({ timers, sender, random: t.random });
    w.onJoin(ev(456, 123));
    await timers.triggerAll();
    assert.deepEqual(sender.options[0].atUserIds, ['123'], '单人只 at 自己');
    assert.equal(sender.sent[0], WELCOME_VARIANTS[t.idx].short, `random=${t.random()} 应选中变体 ${t.idx + 1}`);
    assert.ok(!sender.sent[0].includes('123'), '正文不得出现 QQ 号');
  }
  for (const v of WELCOME_VARIANTS) {
    assert.ok(!/[0-9]/.test(v.short), 'short 不带人数');
    assert.ok(!v.short.includes('位'), 'short 不带"位"');
  }
  // 2 人：顺序必须等于入群顺序，正文必须带人数
  const timers = makeTimers();
  const sender = makeSender();
  const w = makeWelcome({ timers, sender, random: () => 0.5 });
  w.onJoin(ev(456, 222));
  w.onJoin(ev(456, 111));
  await timers.triggerAll();
  assert.deepEqual(sender.options[0].atUserIds, ['222', '111']);
  assert.equal(sender.sent[0], WELCOME_VARIANTS[1].many(2));
  assert.ok(!sender.sent[0].includes('222') && !sender.sent[0].includes('111'), '正文不得出现 QQ 号');
});

// ── 8. 上限 ───────────────────────────────────────────────────────────────
await checker.check('8 上限：12 人只 at 前 5 个，正文 many(12)，仍只 1 条', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const w = makeWelcome({ timers, sender, random: () => 0 });
  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const id = String(301 + i);
    ids.push(id);
    w.onJoin(ev(456, id));
  }
  await timers.triggerAll();
  assert.equal(sender.sent.length, 1, '12 人也只发一条');
  assert.equal(sender.options[0].atUserIds.length, WELCOME_MAX_ATS);
  assert.deepEqual(sender.options[0].atUserIds, ids.slice(0, WELCOME_MAX_ATS));
  assert.equal(sender.sent[0], WELCOME_VARIANTS[0].many(12));
  assert.ok(sender.sent[0].includes('12'), '正文必须带总人数');
});

// ── 9. dedupe:false ──────────────────────────────────────────────────────
await checker.check('9 dedupe:false：每次调用都带单次去重关闭', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const w = makeWelcome({ timers, sender });
  w.onJoin(ev(456, 911));
  await timers.triggerAll();
  assert.equal(sender.options[0].dedupe, false, '必须显式 dedupe:false');
  assert.ok(Array.isArray(sender.options[0].atUserIds));
});

// ── 10. 3 分钟防重复（成功态 + 哈希键 + 跨实例）─────────────────────────
await checker.check('10 防重：哈希键 32 位、成功后同人不发、跨实例仍防重、TTL 到期可再发', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  let persisted = null;
  const w = makeWelcome({ timers, sender, persistSeen: (m) => { persisted = new Map(m); } });
  w.onJoin(ev(456, 123));
  await timers.triggerAll();
  assert.equal(sender.sent.length, 1);

  const key = seenKey('456', '123');
  assert.match(key, /^[0-9a-f]{32}$/, '键必须是 32 位小写十六进制');
  assert.equal(persisted.size, 1, '成功后应落盘一条');
  assert.ok(persisted.has(key), '落盘键必须是 seenKey');
  assert.ok(!persisted.has('456:123'), '落盘不得出现明文键');

  // 同一 user 再入队：不发（内存 TTL）
  w.onJoin(ev(456, 123));
  assert.equal(timers.size(), 0, '3 分钟内同一 member 不应再排队');
  assert.equal(sender.sent.length, 1);

  // 跨实例：用同一份 persisted 当 initialSeen（等价于重启后加载）
  const timers2 = makeTimers();
  const sender2 = makeSender();
  const w2 = makeWelcome({ timers: timers2, sender: sender2, initialSeen: persisted });
  w2.onJoin(ev(456, 123));
  assert.equal(timers2.size(), 0, '新实例加载状态后仍应防重');

  // 换群仍可发：键包含群号（此刻 456:123 的记录仍然有效）
  const timers4 = makeTimers();
  const sender4 = makeSender();
  const w4 = makeWelcome({ timers: timers4, sender: sender4, initialSeen: persisted });
  w4.onJoin(ev(456, 123));
  assert.equal(timers4.size(), 0, '同群同一人仍应被挡（证明 persisted 真的生效）');
  w4.onJoin(ev(789, 123));
  assert.equal(timers4.size(), 1, '同一 QQ 换群应可单独欢迎');

  // 推进过 3 分钟：原实例可再发
  // 注意顺序：先断言"能排队"，再构造新实例 —— 一旦原实例真的发出去了，
  // persisted 会被刷新成新 ts，新实例就不再是"加载到过期记录"的场景了。
  clock += WELCOME_USER_TTL_MS;
  w.onJoin(ev(456, 123));
  assert.equal(timers.size(), 1, 'TTL 到期后原实例可再发');

  // 新实例在到期后构造：清理过期项，可再发
  const timers3 = makeTimers();
  const sender3 = makeSender();
  const w3 = makeWelcome({ timers: timers3, sender: sender3, initialSeen: persisted });
  w3.onJoin(ev(456, 123));
  assert.equal(timers3.size(), 1, '过期记录不应永久拉黑');

  await timers.triggerAll();
  assert.equal(sender.sent.length, 2);
});

// ── 11. 发送中重复 ───────────────────────────────────────────────────────
await checker.check('11 发送中重复：inFlight 挡住，完成后只 1 条', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const logs = [];
  const w = makeWelcome({ timers, sender, logs });
  let release;
  sender.hold = new Promise((r) => { release = r; });
  w.onJoin(ev(456, 1100));
  const flushing = timers.triggerAll();
  await sleep(15);   // 让 flush 越过 isMuted、进入 sendTextBatch 的 await
  assert.equal(timers.size(), 0, 'flush 期间不应再建定时器');
  w.onJoin(ev(456, 1100));
  assert.equal(timers.size(), 0, '同一 member 在发送中被挡住（不重复排队）');
  assert.ok(logs.some((l) => l.includes('reason=in-flight')), '应记 in-flight');
  sender.hold = null;
  release();
  await flushing;
  assert.equal(sender.sent.length, 1, '发送完成后仍只有 1 条');
});

// ── 12. 发送失败可重试 + 持久化失败不误报 ────────────────────────────────
await checker.check('12 失败可重试；落盘失败只记持久化失败、不重发、TTL 仍生效', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const logs = [];
  let persistCount = 0;
  const w = makeWelcome({ timers, sender, logs, persistSeen: () => { persistCount += 1; } });

  sender.failOnce = true;
  w.onJoin(ev(456, 1200));
  await timers.triggerAll();
  assert.equal(sender.sent.length, 0, '失败不应算已发送');
  assert.equal(persistCount, 0, '失败不应落盘');
  assert.ok(logs.some((l) => l.includes('[welcome] 发送失败')), '应记发送失败');
  assert.ok(!logs.some((l) => l.includes('状态持久化失败')), '失败路径不应碰持久化');

  // 失败不写 TTL、不占 inFlight：同一 member 再入队可以重试成功
  w.onJoin(ev(456, 1200));
  assert.equal(timers.size(), 1, '失败后应能重新排队');
  await timers.triggerAll();
  assert.equal(sender.sent.length, 1, '重试应成功');
  assert.equal(persistCount, 1);

  // 落盘失败：消息已经发出去，只能记持久化失败
  clock += WELCOME_USER_TTL_MS + 1;
  const timers2 = makeTimers();
  const logs2 = [];
  const w2 = makeWelcome({
    timers: timers2,
    sender,
    logs: logs2,
    initialSeen: w.recentlyWelcomed,   // 模拟"重启后加载到旧记录"，此刻已过期
    persistSeen: () => { throw new Error('模拟写盘失败'); }
  });
  w2.onJoin(ev(456, 1200));
  await timers2.triggerAll();          // 不得向外 reject
  assert.equal(sender.sent.length, 2, '落盘失败不影响已发送');
  assert.ok(logs2.some((l) => l.includes('[welcome] 状态持久化失败')), '应记持久化失败');
  assert.ok(!logs2.some((l) => l.includes('[welcome] 发送失败')), '落盘失败绝不能记成发送失败');

  // 内存 TTL 仍然生效：紧接着同一 member 再入队不发
  w2.onJoin(ev(456, 1200));
  assert.equal(timers2.size(), 0, '落盘失败后内存 TTL 仍应生效');
});

// ── 13. 入队时暂停 ───────────────────────────────────────────────────────
await checker.check('13 入队时暂停：不排队、日志 reason=paused', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const logs = [];
  let pausedNow = true;
  const w = makeWelcome({ timers, sender: makeSender(), logs, isPaused: () => pausedNow });
  w.onJoin(ev(456, 1300));
  assert.equal(timers.size(), 0, '暂停中不应排队');
  assert.ok(logs.some((l) => l.includes('reason=paused')));
  // 解除暂停后可正常排队（暂停不记 TTL）
  pausedNow = false;
  w.onJoin(ev(456, 1300));
  assert.equal(timers.size(), 1, '解除暂停后同一 member 仍可欢迎');
});

// ── 14. flush 时暂停 ─────────────────────────────────────────────────────
await checker.check('14 flush 前暂停：不发、不记 TTL', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const logs = [];
  let pausedNow = false;
  const w = makeWelcome({ timers, sender, logs, isPaused: () => pausedNow });
  w.onJoin(ev(456, 1400));
  pausedNow = true;
  await timers.triggerAll();
  assert.equal(sender.sent.length, 0, '暂停中 flush 不应发送');
  assert.ok(logs.some((l) => l.includes('reason=paused')));
  // 不记 TTL：解除暂停后再入队仍能发
  pausedNow = false;
  w.onJoin(ev(456, 1400));
  assert.equal(timers.size(), 1, '暂停不应写入 3 分钟 TTL');
});

// ── 15. stop ─────────────────────────────────────────────────────────────
await checker.check('15 stop：清定时器、已捕获的回调不发、之后的事件不排队', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const logs = [];
  let captured = null;
  // 必须在构造之前包：构造函数会把 timers.setTimer 存成实例字段
  const orig = timers.setTimer;
  timers.setTimer = (fn, ms) => { captured = fn; return orig(fn, ms); };

  const w = makeWelcome({ timers, sender, logs });
  w.onJoin(ev(456, 1500));
  assert.equal(timers.size(), 1);
  w.stop();
  assert.equal(timers.size(), 0, 'stop 应清掉所有定时器');
  await captured();                    // 模拟"已捕获但尚未执行"的回调
  assert.equal(sender.sent.length, 0, 'stop 后已捕获的回调不应发送');

  w.onJoin(ev(456, 1501));
  assert.equal(timers.size(), 0, 'stop 后不再接新事件');
  assert.ok(logs.some((l) => l.includes('reason=stopped')));
  // 幂等
  w.stop();
  assert.equal(timers.size(), 0);
});

// ── 16. 表情：成功发送顺序与参数 ──────────────────────────────────────────
await checker.check('16 表情：欢迎文字后追加探头，独立气泡且不带 at', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const stickers = makeStickers();
  const logs = [];
  const w = makeWelcome({ timers, sender, stickers, logs, random: () => 0 });

  w.onJoin(ev(456, 1600));
  await timers.triggerAll();

  assert.equal(sender.sent.length, 1, '欢迎文字仍只发一条');
  assert.deepEqual(sender.events.map((e) => e.type), ['text', 'sticker'], '必须先文字后表情');
  assert.equal(sender.stickerAttempts, 1);
  assert.equal(sender.stickers.length, 1);
  assert.equal(sender.stickers[0].chatKey, 'group:456');
  assert.equal(sender.stickers[0].sticker.id, WELCOME_STICKER_ID);
  assert.equal(stickers.ensureCalls, 1, '发送前应做一次可发送性预检');
  assert.equal(sender.stickers[0].options.atUserId ?? null, null, '表情不应 @ 人');
  assert.ok(logs.some((l) => l.includes('[welcome] 表情已发送')), '成功应记表情日志');
});

// ── 17. 表情失败不影响欢迎防重 ────────────────────────────────────────────
await checker.check('17 表情失败：文字保留、仍记防重、不误报欢迎发送失败', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const stickers = makeStickers();
  const logs = [];
  const w = makeWelcome({ timers, sender, stickers, logs, random: () => 0 });

  sender.stickerFailOnce = true;
  w.onJoin(ev(456, 1700));
  await timers.triggerAll();

  assert.equal(sender.sent.length, 1, '文字已经发出');
  assert.equal(sender.stickerAttempts, 1);
  assert.equal(sender.stickers.length, 0, '失败的表情不应记为成功');
  assert.ok(logs.some((l) => l.includes('[welcome] 表情发送失败')), '应记表情失败');
  assert.ok(!logs.some((l) => l.includes('[welcome] 发送失败')), '不得误报成欢迎发送失败');

  // 防重已写入：同一成员紧接再进群不应重新排队
  w.onJoin(ev(456, 1700));
  assert.equal(timers.size(), 0, '表情失败不应跳过防重记录');
  assert.ok(logs.some((l) => l.includes('reason=duplicate')), '应被防重挡住');
});

// ── 18. 表情关闭 / 本地缺失 ──────────────────────────────────────────────
await checker.check('18 表情关闭或缺失：欢迎照发，跳过表情', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const logs = [];
  const w = makeWelcome({
    timers,
    sender,
    stickers: makeStickers({ enabled: false }),
    logs,
    random: () => 0
  });
  w.onJoin(ev(456, 1800));
  await timers.triggerAll();
  assert.equal(sender.sent.length, 1, '表情关闭不影响欢迎文字');
  assert.equal(sender.stickerAttempts, 0);
  assert.ok(logs.some((l) => l.includes('表情跳过 reason=disabled')));

  const timers2 = makeTimers();
  const sender2 = makeSender();
  const logs2 = [];
  const w2 = makeWelcome({
    timers: timers2,
    sender: sender2,
    stickers: makeStickers({ found: null }),
    logs: logs2,
    random: () => 0
  });
  w2.onJoin(ev(457, 1801));
  await timers2.triggerAll();
  assert.equal(sender2.sent.length, 1, '本地库缺失表情时欢迎照发');
  assert.equal(sender2.stickerAttempts, 0);
  assert.ok(logs2.some((l) => l.includes('表情跳过 reason=not-found')));
});

// ── 19. 文字失败时不发表情 ────────────────────────────────────────────────
await checker.check('19 文字发送失败：不发表情，重试成功后补发', async () => {
  clock = 1_000_000;
  const timers = makeTimers();
  const sender = makeSender();
  const stickers = makeStickers();
  const w = makeWelcome({ timers, sender, stickers, random: () => 0 });

  sender.failOnce = true;
  w.onJoin(ev(456, 1900));
  await timers.triggerAll();
  assert.equal(sender.sent.length, 0);
  assert.equal(sender.stickerAttempts, 0, '文字没发出去时不应发表情');

  w.onJoin(ev(456, 1900));
  await timers.triggerAll();
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.stickerAttempts, 1, '重试成功后应补发一次表情');
});

// 顺带确认 debounce 常量没被改动（e2e 的等待窗口按它算）
assert.equal(WELCOME_DEBOUNCE_MS, 3000);

checker.finish();
