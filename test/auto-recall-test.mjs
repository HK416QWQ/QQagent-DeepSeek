// 第 0 期 2a：B 触发自动检索的单测。
//
// ── 这份测试真正在防什么 ──
// 2026-11-04 那版「静默召回」上线当天就被删了：136 轮注入 29 次只有 8 次相关
// （27.6%），prompt.js 涨了 316 行。所以这里的断言不是"功能能跑"，而是钉住
// **它没有长回旧样子**：触发必须是双条件 AND（不是每轮）、抽不出词必须放弃
// （不退回 n-gram）、不触发时提示词必须字节不变（缓存命中率 95% 不能掉）。
//
// 施工单 §6.1① 的 6 条正例里，第 3、6 条在 §2.1 的字面规则下其实不可能命中：
//   · 「阿杰是什么还记得吗」——无 `你`、无 @，条件 B 不成立
//   · 「@bot 你之前说的那个游戏叫什么」——13 词表里一个都没有，条件 A 不成立
// 处理见 isRecallIntent 里的注释：`你…说` 句式、以及**带疑问语气的**省主语「还记得吗」
// 这两支同时充当 A 和 B。⚠️ 裸「还记得」不能无条件充当 B —— 那样「我还记得捞第一关」
// 「没想到阿宇还记得蝴蝶行动」这类第一/第三人称陈述会被误判成「在问机器人」（见第 2b 组）。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-recall-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const { isRecallIntent, pickWords, buildAutoRecall } = await import('../src/auto-recall.js');
const { buildUserPrompt } = await import('../src/prompt.js');
const { ChatStore } = await import('../src/store.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const NICK = '测试机器人';
const OPT = { selfNickname: NICK, botName: NICK, selfId: '10000' };

// ── 1. 判定正例：6 条必须命中 ──
{
  const cases = [
    [`@${NICK} 你还记得阿宝吗`, 'A+B 全有'],
    ['你还记得我吗', '第二人称句式'],
    ['阿杰是什么还记得吗', '★ 省略主语，只靠裸「还记得」'],
    [`@${NICK} 我上次怎么你了`, '★ 抽词为空，但判定必须为是'],
    ['那你还记得昨天阿芳问的那个北约问题吗', 'A+B 全有'],
    [`@${NICK} 你之前说的那个游戏叫什么`, '★ 13 词表一个都不含，靠「你…说」']
  ];
  for (const [text, note] of cases) {
    assert.equal(isRecallIntent(text, OPT), true, `正例必须命中：${text}（${note}）`);
  }
  ok('判定正例 6/6 命中（含两条靠句式补上的：裸「还记得」、「你之前说」）');
}

// ── 2. 判定反例：10 条必须不命中 ──
{
  const cases = [
    ['之前还能刚刚好卡着我的髂骨', '「之前」是纯时间状语，不在词表'],
    ['以前没汉化，玩不了', '同上'],
    ['当时乌克兰还急着还债呢', '同上'],
    ['我叫你一声，你敢答应吗', '「答应」全是梗，已剔除'],
    ['命中率就是这次上传的东西跟上次相同的地方', '有「上次」但没面向机器人'],
    ['我之前发过一个P90和mdr的', '不含「你」，B 不成立'],
    // ★ 以下 4 条是 2026-11-13 修「双条件退化」时补的：含标记词（A 真）但都是陈述句
    ['我还记得捞第一关', '第一人称陈述：A 真，但不面向机器人'],
    ['没想到阿宇还记得蝴蝶行动', '第三人称陈述：同上'],
    ['到现在我还记得这句话', '同上'],
    ['我还记得我大学的时候我前面两个女的讨论挖矿讨论了一节课', '同上']
  ];
  for (const [text, note] of cases) {
    assert.equal(isRecallIntent(text, OPT), false, `反例不能命中：${text}（${note}）`);
  }
  ok('判定反例 10/10 未命中（含 4 条第三人称陈述：A 真 B 假）');
}

// ── 2c. ★ 泛指型提问必须否掉（2026-11-14 三次自然样本 3/3 失败）──
{
  // 「你说过的最X的Y」问的是 AI 自己，不是共同经历：没有时间锚点、没有事件锚点，
  // 抽词只能抽到「最X的Y」里那个形容词。三次真实样本：
  //   你讲过最骚的话     → 抽「的话」
  //   你说过的最温柔的话 → 抽「过的」
  //   你说过的最可爱的话 → 抽「可爱」hits=64（词表拦不住实义词，只能否判定）
  const generic = [
    [`@${NICK} 你讲过最骚的话是什么`, '你已经修过的那个槽位'],
    [`@${NICK} 你说过的最温柔的话是什么`, '凑巧库里没有「温柔」，靠运气才没注入'],
    [`@${NICK} 那你说过的最可爱的话是什么`, '「可爱」库里有 64 条 → 词表拦不住'],
    [`@${NICK} 你说过最搞笑的话是啥`, '「过最」不带「的」也要认']
  ];
  for (const [t, note] of generic) {
    assert.equal(isRecallIntent(t, OPT), false, `泛指型提问不能触发：${t}（${note}）`);
  }
  // 但带时间锚点时是特指，必须仍能触发
  assert.equal(isRecallIntent(`@${NICK} 你上次说过的最重要的事是什么`, OPT), true,
    '带时间锚点的是真回溯，不能一起否掉');
  assert.equal(isRecallIntent(`@${NICK} 你之前说的那个游戏叫什么`, OPT), true,
    '特指（那个）不受影响');
  ok('★ 泛指型提问 4/4 否掉，且不误伤带锚点的真回溯');
}

// ── 2b. ★ 双条件不可退化（回归锁）──
{
  // 曾经的写法 `(marker||you) && (at||you)` 里 you 同时出现在两侧，
  // 一旦 you 为真整个表达式恒真 → 双条件退化成单条件，含「还记得」就触发。
  // 这一组专门钉住「A 和 B 必须真的是两个独立条件」。
  const aTrueBFalse = [
    '我还记得捞第一关',
    '没想到阿宇还记得蝴蝶行动',
    '他上次说他要去北京',
    '我之前发过一个P90和mdr的'
  ];
  for (const t of aTrueBFalse) {
    assert.equal(isRecallIntent(t, OPT), false, `A 真 B 假不能触发：${t}`);
  }
  // 反向：@了机器人但没在回溯，也不能触发
  assert.equal(isRecallIntent(`@${NICK} 今天吃什么`, OPT), false, 'B 真 A 假不能触发');
  // 而「带疑问语气的省主语问句」必须能过（它是 A∧B 同一支）
  assert.equal(isRecallIntent('阿杰是什么还记得吗', OPT), true, '疑问语气的省主语问句必须触发');
  assert.equal(isRecallIntent('你还记得阿宝吗', OPT), true, '第二人称疑问必须触发');
  ok('★ 双条件不可退化：A 真 B 假 / B 真 A 假 均不触发，疑问句仍能过');
}

// ── 3. 抽词：与施工单 §1.2 的表一致 ──
{
  const expect = [
    // §1.2 写的是「记住/昨天/昵称」——「记住」是笔误：§2.2 的停用表明确含「记得」，
    // 不过滤它就会被当内容词去检索（正是旧功能噪音的来源之一）。
    // v1.27：「昨天」这类时间词已进 VAGUE 表（不指向任何实体，检索只会捞回「谁都在说时间」），
    // 所以第 3 个位置让给了真正的实体「北约」。
    ['你还记得昨天阿猫阿狗问你那个北约的问题是什么吗', ['阿猫', '阿狗', '北约']],
    ['你还记得阿宝吗', ['阿宝']],              // 连续单字合并保住专名
    ['阿杰是什么还记得吗', ['阿杰']],           // 同上，且「是」不能并进来
    ['我上次怎么你了', []],                    // 无内容词 → 放弃
    ['你还记得我是谁吗', []],                  // 身份类自动落到不触发（第 2 期才做）
    ['你还记得我今天跟你说过啥吗', []],        // ★ v1.27：时间词 + 虚指词全被过滤 → 不再自命中
    ['你还记得我让你发笨蛋阿杰那事吗', ['笨蛋']] // ★ v1.27：「阿杰那事」是指代不是实体
  ];
  for (const [text, want] of expect) {
    assert.deepEqual(pickWords(text, [NICK]), want, `抽词不符：${text}`);
  }
  ok('抽词 7/7：专名保住；时间/虚指词被滤掉；「…那事」不当作锚点');
}

// ── 4. ★ 判定命中 ≠ 注入：抽词为空时必须返回空 text ──
{
  const fakeStore = { search: () => ({ totalHits: 1, messages: [{ ts: Date.now(), senderName: 'X', text: 'x' }] }) };
  for (const text of ['我上次怎么你了', '你还记得我是谁吗']) {
    assert.equal(isRecallIntent(`@${NICK} ${text}`, OPT), true, `前提：${text} 判定应为命中`);
    const r = buildAutoRecall(fakeStore, 'group:1', [{ mid: 1, ts: Date.now(), text: `@${NICK} ${text}` }], OPT);
    assert.equal(r.text, '', `★ 「${text}」抽不出内容词 → 不能注入任何东西`);
    assert.equal(r.stats.hit, false);
    assert.deepEqual(r.stats.words, []);
  }
  ok('★ 判定为是但抽词为空 → text 为空、hit=false（不注入空段）');
}

// ── 4b. ★ 一手证据优先：自己的转述不能排在原始消息前面（v1.31）──
// 起因：问「阿明打 xyz」，注入首条是机器人自己 20 分钟前的回答，
// 于是这次回答一字不差重复了它 —— 事实对时是复读，事实错时错误固化。
{
  const ts = Date.now();
  const fakeStore = {
    search: () => ({
      totalHits: 3,
      messages: [
        // 刻意把 self 放在最前，模拟「自己那条最新、TF-IDF 又高」的真实排序
        { ts: ts - 1000, self: true, senderName: '我', text: '记得呀～阿强说阿明拉着她打xyz打到崩溃' },
        { ts: ts - 2000, self: false, senderName: '阿红', text: '阿明之前拉着我打xyz，可给我折磨坏了' },
        { ts: ts - 3000, self: false, senderName: '阿强', text: '阿明之前拉着我打xyz' }
      ]
    })
  };
  const r = buildAutoRecall(fakeStore, 'group:1',
    [{ mid: 1, ts, text: `@${NICK} 你还记得阿明上次打 xyz 打崩那事吗` }], OPT);
  assert.ok(r.text, '前提：这条应当注入');
  const bodyLines = r.text.split('\n').slice(1);
  assert.ok(!bodyLines[0].includes('记得呀'),
    `★ 自己的旧回答不能排第一，实际首行：${bodyLines[0]}`);
  assert.ok(bodyLines[0].includes('阿红') || bodyLines[0].includes('阿强'),
    `★ 首行必须是原始消息，实际：${bodyLines[0]}`);
  ok('★ 一手证据优先：自身发言沉底，原始消息排前');
}

// ── 4c. ★ 合并转发不能当群内证据（v1.32）──
// 实测：「谁拍得最多」抽「最多」hits=1，唯一命中是合并转发。
// 转发内容是别处的聊天记录，既不是本群发生的事、也没有上下文，充当证据等于捏造对话。
{
  const ts = Date.now();
  const onlyForward = buildAutoRecall(
    { search: () => ({ totalHits: 2, messages: [
      { ts: ts - 1000, self: false, senderName: 'A', text: '[合并转发 共27条] X: 所以是某人' },
      { ts: ts - 2000, self: false, senderName: 'B', text: '[合并转发 共3条] Y: 哈哈' }
    ] }) }, 'group:1',
    [{ mid: 1, ts, text: `@${NICK} 你还记得阿明打 xyz 打崩吗` }], OPT);
  assert.equal(onlyForward.text, '', '★ 只剩合并转发时应完全不注入');

  const mixed = buildAutoRecall(
    { search: () => ({ totalHits: 2, messages: [
      { ts: ts - 1000, self: false, senderName: 'A', text: '[合并转发 共27条] X: 所以是某人' },
      { ts: ts - 2000, self: false, senderName: 'B', text: '阿明之前拉着我打xyz' }
    ] }) }, 'group:1',
    [{ mid: 1, ts, text: `@${NICK} 你还记得阿明打 xyz 打崩吗` }], OPT);
  assert.ok(mixed.text.includes('阿明之前拉着我打xyz'), '正常消息必须保留');
  assert.ok(!mixed.text.includes('合并转发'), '★ 转发消息不能出现在注入里');
  ok('★ 合并转发被过滤：只剩转发时不注入，混合时只留正常消息');
}

// ── 5. ★ 缓存保护：不触发时提示词逐字节不变 ──
// 这是本单唯一的"性能"验收：前缀缓存命中率 95%，注入段必须"不触发时完全不存在"。
{
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona.botName = '测试机';
  cfg.persona.roleText = '你是测试机。';
  cfg.sticker.enabled = false;
  cfg.store.historyCount = 5;
  cfg.store.promptAnchor = { enabled: false };
  setRuntimeConfig(cfg);

  const store = new ChatStore(0);
  const memory = null;
  const CHAT = 'group:900001';
  const ts0 = Date.now() - 60000;
  store.appendIncoming(CHAT, { mid: 1, ts: ts0, senderId: 'u1', senderName: '甲', text: '今天吃啥' });
  store.markEntryRead(CHAT, 1);
  const triggerEntries = [store.appendIncoming(CHAT, { mid: 2, ts: ts0 + 1000, senderId: 'u2', senderName: '乙', text: '随便' })];

  const base = {
    chatKey: CHAT, kind: 'group', chatId: '900001', chatName: '测试群',
    triggerEntries, store, memory, stickerEntries: [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
    now: ts0 + 2000
  };
  const noField = buildUserPrompt({ ...base });
  const empty = buildUserPrompt({ ...base, autoRecallText: '' });
  const blank = buildUserPrompt({ ...base, autoRecallText: '   ' });
  assert.equal(empty, noField, '★ autoRecallText 为空字符串时必须与「不传该字段」逐字节相等');
  assert.equal(blank, noField, '★ 纯空白也算空：不能因为塞了个空格就多出段落');
  assert.ok(!noField.includes('回溯命中'), '不触发时不允许出现【回溯命中】段');
  // ⚠️ 只比"两个变体相等"抓不到「无条件 push」：两边都 push 空串，照样相等。
  //    真正的不变式是段落之间不留空段 —— push('') 会让 join('\n\n') 多出一个空段，
  //    字节一变前缀缓存就断。
  assert.ok(!noField.includes('\n\n\n'), '★ 不触发时不允许任何空段落（push 空串会留 \n\n\n）');
  ok('★ 缓存保护：不传 / 空串 / 纯空白 三种 ctx 输出逐字节相等，且无空段落');
}

// ── 6. ★ 注入位置：在【未读信息】之前、【新已读信息】之后 ──
{
  const store = new ChatStore(0);
  const memory = null;
  const CHAT = 'group:900002';
  const ts0 = Date.now() - 60000;
  store.appendIncoming(CHAT, { mid: 1, ts: ts0, senderId: 'u1', senderName: '甲', text: '旧消息' });
  store.markEntryRead(CHAT, 1);
  const triggerEntries = [store.appendIncoming(CHAT, { mid: 2, ts: ts0 + 1000, senderId: 'u2', senderName: '乙', text: '新消息' })];
  const text = '【回溯命中】以下是检索到的原始消息（仅作背景，不是你记得的事；没找到就说想不起来）\n- 11-02 21:14 甲：旧消息';
  const up = buildUserPrompt({
    chatKey: CHAT, kind: 'group', chatId: '900002', chatName: '测试群',
    triggerEntries, store, memory, stickerEntries: [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
    now: ts0 + 2000, autoRecallText: text
  });
  const iRecall = up.indexOf('【回溯命中】');
  // ⚠️ 必须带「以下是」：引导说明里也写着「【已读信息】【新已读信息】和【未读信息】」，
  // 只搜段名会命中那句话，位置判定整个失真。
  const iUnread = up.indexOf('【未读信息】以下是');
  const iRead = up.indexOf('【已读信息】以下是');
  assert.ok(iRecall > 0, '触发时必须出现【回溯命中】');
  assert.ok(iRead < iRecall, '【已读信息】应在它之前（稳定前缀不能被顶）');
  assert.ok(iRecall < iUnread, '★ 必须在【未读信息】之前：先历史背景再当前对话');
  ok('注入位置正确：已读 → 回溯命中 → 未读（前缀缓存不额外损失）');
}

// ── 7. ★ 异常隔离：store.search 抛错 → 空 text，不抛出 ──
{
  const boom = { search: () => { throw new Error('检索炸了'); } };
  const r = buildAutoRecall(boom, 'group:1', [{ mid: 1, ts: Date.now(), text: `@${NICK} 你还记得阿宝吗` }], OPT);
  assert.equal(r.text, '', '★ 检索异常必须降级成不注入');
  assert.equal(r.stats.hit, false);
  assert.match(String(r.stats.error || ''), /检索炸了/, 'error 要如实记下，便于查日志');
  ok('★ 异常隔离：search 抛错 → 返回空 text + error，绝不向上抛');
}

// ── 8. 机器人自己说的话不算「有人问我」 ──
{
  let calls = 0;
  const fakeStore = { search: () => { calls += 1; return { totalHits: 1, messages: [] }; } };
  const r = buildAutoRecall(fakeStore, 'group:1', [
    { mid: 1, ts: Date.now(), self: true, text: `我还记得阿宝` },
    { mid: 2, ts: Date.now(), self: true, text: '你之前说的那个' }
  ], OPT);
  assert.equal(r.text, '');
  assert.equal(calls, 0, '全是自己的发言 → 连检索都不该发生');
  ok('跳过 m.self：机器人自己的发言不触发检索');
}

// ── 9. 查询构造：必须单词 any（绝不允许多词 all），0 命中不注入 ──
{
  const seen = [];
  const fakeStore = {
    search: (k, o) => {
      seen.push({ mode: o.mode, words: o.words, to: o.to });
      return { totalHits: 2, messages: [
        { ts: Date.now() - 5000, senderName: '甲', text: '阿宝说过这个' },
        { ts: Date.now() - 9000, senderName: '乙', text: '阿宝又提了一次' }
      ] };
    }
  };
  const NOW = Date.now();
  const r = buildAutoRecall(fakeStore, 'group:1', [{ mid: 1, ts: NOW, text: '你还记得阿宝吗' }], OPT);
  // ★ v1.27：抽出的词全部来自同一句提问，多词 all 的唯一命中就是提问自己。
  //   实测 [A, B, C] 走 all = 1 条（那句提问），单词「A」= 上百条。
  assert.ok(seen.every((c) => c.mode === 'any'), '★ 不许再用多词 all（那是自我闭环）');
  assert.ok(seen.every((c) => c.words.length === 1), '★ 每次查询只用一个锚点词');
  assert.ok(seen.every((c) => c.to <= NOW - 1), '★ 时间上界必须早于本轮，否则命中提问自己');
  assert.equal(r.stats.hits, 2);
  assert.match(r.text, /【回溯命中】/, '应有段头');
  assert.match(r.text, /不是你记得的事/, '★ 必须写明"不是你记得的事"，否则模型会把检索结果当自己的记忆');
  assert.match(r.text, /- \d{2}-\d{2} \d{2}:\d{2} 甲：阿宝说过这个/, '行格式：- MM-DD HH:MM 谁：原文');
  assert.equal(r.stats.hit, true);

  const none = buildAutoRecall({ search: () => ({ totalHits: 0, messages: [] }) }, 'group:1',
    [{ mid: 1, ts: Date.now(), text: '你还记得阿宝吗' }], OPT);
  assert.equal(none.text, '', '全部 0 命中 → 不注入（不留空段）');
  ok('★ 单词 any 查询（非多词 all）+ 时间上界排除本轮；0 命中不注入');
}

// ── 9b. ★ 自命中防护：hits=1 的候选（只出现在提问里）不能被当成锚点 ──
{
  const calls = [];
  const fakeStore = {
    search: (k, o) => {
      calls.push(o.words[0]);
      // 「打崩」只命中 1 条（就是那句提问）；「阿明」命中 127 条（旧事）
      if (o.words[0] === '打崩') return { totalHits: 1, messages: [{ ts: 1, senderName: 'X', text: '你还记得那次阿明打 xyz 打崩了吗' }] };
      if (o.words[0] === 'xyz') return { totalHits: 0, messages: [] };
      return { totalHits: 127, messages: [{ ts: 2, senderName: '阿强', text: '阿明之前拉着我打xyz' }] };
    }
  };
  const r = buildAutoRecall(fakeStore, 'group:1', [{ mid: 1, ts: Date.now(), text: '你还记得那次阿明打 xyz 打崩了吗' }], OPT);
  assert.ok(!r.text.includes('你还记得那次阿明打 xyz 打崩了吗'), '★ 绝不能把提问自己注入回去');
  assert.equal(r.stats.words[0], '阿明', '★ hits=1 的「打崩」要跳过，落到「阿明」');
  ok('★ 自命中防护：hits=1 的候选跳过，改用真实锚点');
}

// ── 10. 格式化硬约束：≤3 行 / 每行原文 ≤60 字 / 总长 ≤200 ──
{
  const long = 'x'.repeat(200);
  const fakeStore = {
    search: () => ({
      totalHits: 9,
      messages: [
        { ts: Date.now(), senderName: '一二三四五六七八九十甲乙丙丁', text: long },
        { ts: Date.now() - 1000, senderName: '乙', text: long },
        { ts: Date.now() - 2000, senderName: '丙', text: long },
        { ts: Date.now() - 3000, senderName: '丁', text: long }
      ]
    })
  };
  const r = buildAutoRecall(fakeStore, 'group:1', [{ mid: 1, ts: Date.now(), text: '你还记得阿宝吗' }], OPT);
  const lines = r.text.split('\n');
  assert.ok(lines.length <= 4, `段头 + 最多 3 行，实际 ${lines.length} 行`);
  assert.ok(r.text.length <= 200, `★ 总长必须 ≤200，实际 ${r.text.length}`);
  for (const l of lines.slice(1)) {
    const body = l.slice(l.indexOf('：') + 1);
    assert.ok(body.length <= 60, `每行原文截断 60 字，实际 ${body.length}`);
  }
  ok(`格式化约束：${lines.length - 1} 行 / 总长 ${r.text.length} 字（≤200）`);
}

// ── 11. 特征清单自查（施工单 §2.8：按特征判，不按行数判）──
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'auto-recall.js'), 'utf8');
  // 必须没有：n-gram 滑窗枚举（旧功能的直接死因）
  assert.ok(!/slice\(\s*i\s*,\s*i\s*\+\s*[23]\s*\)/.test(src), '★ 不允许 n-gram 滑窗枚举');
  assert.ok(!/\.substring\(/.test(src), '★ 不允许 substring 式滑窗');
  // 必须没有：冷却 / 状态文件（旧版靠它压制频率，说明触发太频）
  assert.ok(!/auto-recall-recent|cooldown|dedup/i.test(src), '★ 不允许任何冷却 / 去重状态');
  // 必须没有：IO（除 store.search 外零 IO，保证可独立回滚）
  assert.ok(!/require\(['"]fs['"]\)|from ['"]node:fs['"]|from ['"]fs['"]/.test(src), '★ 不允许 fs');
  assert.ok(!/\bfetch\(|https?:\/\//.test(src), '★ 不允许网络请求');
  // 必须没有：第二个检索模式开关（复杂度膨胀的起点）
  assert.ok(!/searchMode|fallbackMode|modeSwitch/.test(src), '★ 不允许第二个检索模式开关');
  // config 只多一个键
  // ⚠️ 2026-11-14 更新：`l4` 是第 1 期（L4 时段摘要）显式新增的键，属合法增长。
  // ⚠️ 2026-11-15 更新：`l1` 是第 2 期（L1 人物档案日扫）显式新增的键，属合法增长。
  // ⚠️ 2026-11-16 更新：`inject` 是第 3 期（四层装配）显式新增的键，属合法增长。
  // ⚠️ 2026-11-16 更新：`autoRecallSummaryHead` 是第 4 期（检索摘要头）显式新增的键。
  //    **必须是兄弟键**：磁盘上 `autoRecall` 是布尔 true，deepMerge 遇到「override 不是对象」
  //    会整个赋值，把配置嵌进 autoRecall 会被 true 覆盖 → 静默失效。
  //    这条断言在这里正好当守卫用：谁想把它塞进 autoRecall，键数就对不上。
  //    这条断言的意图是「第 0 期没有顺手塞别的开关」，不是「memory 永远只有 6 个键」——
  //    所以按实际核对：多了谁就必须说得出来，说不出就是偷偷扩张。
  const memKeys = Object.keys(DEFAULT_CONFIG.memory).sort();
  assert.deepEqual(memKeys, ['autoRecall', 'autoRecallSummaryHead', 'inject', 'l1', 'l4'],
    '★ config.memory 只剩检索 / 摘要 / 调度 / 注入四类键（整理五键已随旧系统摘除）');
  assert.equal(DEFAULT_CONFIG.memory.autoRecall, false, '★ 默认必须是关（先灰度看日志）');
  // 第 1 期：L4 摘要默认也必须关（产物没人读，开着只是白烧配额）
  assert.equal(DEFAULT_CONFIG.memory.l4?.enabled, false, '★ L4 默认必须关');
  assert.equal(DEFAULT_CONFIG.memory.l4?.dryRun, true, '★ L4 默认必须干跑');
  // 单文件：不存在第二个新模块
  for (const f of ['auto-recall-store.js', 'auto-recall-cache.js', 'recall.js']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'src', f)), `★ 不允许额外的 ${f}`);
  }
  ok('特征清单 11 条全过（无 n-gram / 无冷却文件 / 无 IO / config 只多 1 键 / 默认关）');
}

// 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── auto-recall：${passed} 项通过`);
