// 历史检索（A 方案·关键词三维检索）自测
//
// 覆盖：
//   1–7   store.search 的过滤（词/时间/人/撤回/拍一拍/屏蔽名单）
//   8–11  tools.search_messages（超限收窄、上下文、空结果、时间解析、翻页）
//   12a/12b 性能（3 万条夹具）
//   14    机器人占位符排除 + df 语料口径
//   21    wordDf 边界（257 词 truncate）
//   23    offset 翻页
//   25    isVisible 重构等价性（先取后滤）
//   28    get_recent_messages 走 visibleOnly
//
// 纯离线：临时数据目录 + 真实 ChatStore / buildPastState / 真实工具定义。
// 运行：node test/search-test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-search-'));
process.env.QQ_AGENT_DATA_DIR = dir;

const { ChatStore } = await import('../src/store.js');
const { buildPastState } = await import('../src/prompt.js');
const { setRuntimeConfig, getConfig, DEFAULT_CONFIG } = await import('../src/config.js');
const { buildToolDefs, parseSearchTime, timeWordRange } = await import('../src/tools.js');

// ── 基础设施 ──────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.error(`  ✗ ${name}\n      ${e?.message || e}`);
  }
}

/** 每个用例自带一份配置（用例 17–20 要改开关，不能互相污染）。 */
function useConfig(mutate) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona.botName = '测试机';
  cfg.persona.roleText = '你是测试群里的测试机。';
  cfg.sticker.enabled = false;
  cfg.store.contextTier = 4;
  cfg.store.historyCount = 5;
  cfg.store.promptAnchor = { enabled: true, maxExtraRead: 10 };
  cfg.blocklist = {};
  cfg.globalBlocklist = [];
  cfg.memberNotes = {};
  if (typeof mutate === 'function') mutate(cfg);
  setRuntimeConfig(cfg);
  return cfg;
}

let MID = 900000;
const NOW = Date.now();

function add(store, key, { text, ts = NOW, senderId = '111', senderName = '甲', read = true, poke = false }) {
  const e = store.appendIncoming(key, { mid: ++MID, ts, senderId, senderName, text, isPoke: poke });
  if (read) store.markEntryRead(key, e.id);
  return e;
}
const toolDefs = buildToolDefs();
const SEARCH = toolDefs.find((t) => t.id === 'search_messages');
const RECENT = toolDefs.find((t) => t.id === 'get_recent_messages');

function toolCtx(store, key, session = {}) {
  return { store, chatKey: key, session, kind: 'group', chatId: String(key).split(':')[1], selfId: '999', selfNickname: '测试机', botName: '测试机' };
}
async function callTool(tool, ctx, args) {
  const r = await tool.execute(ctx, args);
  if (r.isError) throw new Error(`工具返回错误：${r.content}`);
  return JSON.parse(r.content);
}

useConfig();

// ═══ 1–2. 关键词 AND / OR ══════════════════════════════════════════════════
check('1. 纯关键词 AND：只返回同时含两词的消息', () => {
  const store = new ChatStore(0);
  const K = 'group:9001';
  add(store, K, { text: '今天天气不错' });
  add(store, K, { text: '明天开会记得带电脑' });
  add(store, K, { text: '电脑已经买了' });
  const r = store.search(K, { words: ['开会', '电脑'], context: 0 });
  assert.equal(r.totalHits, 1);
  assert.ok(r.messages[0].text.includes('开会') && r.messages[0].text.includes('电脑'));
});

check("2. mode:'any'：返回含任一词的消息（AND 时是 1 条，OR 时是 2 条）", () => {
  const store = new ChatStore(0);
  const K = 'group:9002';
  add(store, K, { text: '今天天气不错' });
  add(store, K, { text: '明天开会记得带电脑' });
  add(store, K, { text: '电脑已经买了' });
  const r = store.search(K, { words: ['开会', '电脑'], mode: 'any', context: 0 });
  assert.equal(r.totalHits, 2, 'OR 应匹配 2 条');
  assert.equal(store.search(K, { words: ['开会', '电脑'], mode: 'all', context: 0 }).totalHits, 1);
});

// ═══ 3. 时间范围 ══════════════════════════════════════════════════════════
check('3. 时间范围过滤：边界内外各 1 条，只回范围内的', () => {
  const store = new ChatStore(0);
  const K = 'group:9003';
  const t0 = NOW - 10 * 3600e3;
  const t1 = NOW - 5 * 3600e3;
  const t2 = NOW - 1 * 3600e3;
  add(store, K, { text: '范围外早', ts: t0 });
  add(store, K, { text: '范围内', ts: t1 });
  add(store, K, { text: '范围外晚', ts: t2 });
  const r = store.search(K, { words: [], from: t1, to: t1, context: 0 });
  assert.equal(r.totalHits, 1, '闭区间应含边界那一条');
  assert.equal(r.messages[0].text, '范围内');
  assert.equal(store.search(K, { words: [], from: t0, to: t2, context: 0 }).totalHits, 3);
});

// ═══ 4. 发送者过滤 ════════════════════════════════════════════════════════
check('4. 发送者过滤：QQ 号精确 + 昵称模糊各 1 例', () => {
  const store = new ChatStore(0);
  const K = 'group:9004';
  add(store, K, { text: '第一句', senderId: '9900000002', senderName: '阿牛' });
  add(store, K, { text: '第二句', senderId: '3333', senderName: '阿花' });
  const byId = store.search(K, { words: [], sender: '9900000002', context: 0 });
  assert.equal(byId.totalHits, 1);
  assert.equal(byId.messages[0].text, '第一句');
  const byName = store.search(K, { words: [], sender: '牛', context: 0 });
  assert.equal(byName.totalHits, 1);
  assert.equal(byName.messages[0].text, '第一句');
});

// ═══ 5–7. 撤回 / 拍一拍 / 屏蔽名单 ═════════════════════════════════════════
check('5. 撤回消息不返回（markRecalled 后命中数 -1）', () => {
  const store = new ChatStore(0);
  const K = 'group:9005';
  const a = add(store, K, { text: '周末有活动' });
  add(store, K, { text: '活动取消了' });
  assert.equal(store.search(K, { words: ['活动'], context: 0 }).totalHits, 2);
  store.markRecalled(K, a.mid);
  assert.equal(store.search(K, { words: ['活动'], context: 0 }).totalHits, 1);
});

check('6. 拍一拍不返回（isPoke:true 不进结果）', () => {
  const store = new ChatStore(0);
  const K = 'group:9006';
  add(store, K, { text: '[拍一拍] 甲 拍了拍 我', poke: true });
  add(store, K, { text: '真消息来了' });
  assert.equal(store.search(K, { words: ['拍了拍'], context: 0 }).totalHits, 0);
  assert.equal(store.search(K, { words: ['真消息'], context: 0 }).totalHits, 1);
});

check('7. 屏蔽名单不返回：群屏蔽 + 全局屏蔽各 1 例；自己的发言不受影响', () => {
  const store = new ChatStore(0);
  const K = 'group:9007';
  useConfig((cfg) => { cfg.blocklist = { 9007: ['9900000003'] }; cfg.globalBlocklist = ['9900000004']; });
  add(store, K, { text: '正常群友的话', senderId: '111', senderName: '甲' });
  add(store, K, { text: '被群屏蔽的人', senderId: '9900000003', senderName: '丙' });
  add(store, K, { text: '被全局屏蔽的人', senderId: '9900000004', senderName: '丁' });
  const me = store.appendSelf(K, { text: '我自己说的话', ts: NOW });
  const r = store.search(K, { words: [], context: 0 });
  assert.equal(r.totalHits, 2, '两条被屏蔽的都不该出现，自己那条要留下');
  assert.ok(r.messages.some((m) => m.id === me.id), 'self 消息不受屏蔽名单影响');
  assert.ok(!r.messages.some((m) => m.text.includes('被群屏蔽')));
  assert.ok(!r.messages.some((m) => m.text.includes('被全局屏蔽')));
  useConfig();
});

// ═══ 8. total_hits > 50 ══════════════════════════════════════════════════
await (async () => {
  const store = new ChatStore(0);
  const K = 'group:9008';
  for (let i = 0; i < 60; i += 1) add(store, K, { text: `第${i}条 关键词记录`, ts: NOW - i * 60000 });
  const r = await callTool(SEARCH, toolCtx(store, K), { keywords: '关键词' });
  check('8. total_hits > 50：只回 5 条，hint 含「收窄」', () => {
    assert.equal(r.total_hits, 60);
    assert.equal(r.shown, 5);
    assert.ok(r.messages.length === 5);
    assert.ok(String(r.hint || '').includes('收窄'), `hint 应含「收窄」，实际：${r.hint}`);
  });
})();

// ═══ 9. context ═══════════════════════════════════════════════════════════
check('9. context:1 每条带 before/after 且不越界；context:0 不带', () => {
  const store = new ChatStore(0);
  const K = 'group:9009';
  add(store, K, { text: '前一句', ts: NOW - 3000 });
  add(store, K, { text: '要找的那句', ts: NOW - 2000 });
  add(store, K, { text: '后一句', ts: NOW - 1000 });
  const withCtx = store.search(K, { words: ['要找'], context: 1 });
  assert.equal(withCtx.totalHits, 1);
  assert.equal(withCtx.messages[0].before, '甲：前一句');
  assert.equal(withCtx.messages[0].after, '甲：后一句');
  const noCtx = store.search(K, { words: ['要找'], context: 0 });
  assert.equal(noCtx.messages[0].before, undefined);
  // 越界：最后一条没有 after
  const last = store.search(K, { words: ['后一句'], context: 1 });
  assert.equal(last.messages[0].after, undefined);
});

// ═══ 10. 空结果 ═══════════════════════════════════════════════════════════
await (async () => {
  const store = new ChatStore(0);
  const K = 'group:9010';
  add(store, K, { text: '只有这一句' });
  const r = await callTool(SEARCH, toolCtx(store, K), { keywords: '根本不存在的词' });
  check('10. 空结果：total_hits=0 + hint 非空，不抛异常', () => {
    assert.equal(r.total_hits, 0);
    assert.deepEqual(r.messages, []);
    assert.ok(String(r.hint || '').length > 0);
  });
})();

// ═══ 11. 时间解析 ═════════════════════════════════════════════════════════
await (async () => {
  const store = new ChatStore(0);
  const K = 'group:9011';
  const yesterday = new Date(NOW - 24 * 3600e3);
  const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  add(store, K, { text: '昨天那条记录', ts: NOW - 24 * 3600e3 });
  add(store, K, { text: '两小时前那条', ts: NOW - 2 * 3600e3 });
  add(store, K, { text: '五小时前那条', ts: NOW - 5 * 3600e3 });

  const rToday = await callTool(SEARCH, toolCtx(store, K), { keywords: '记录', from: '昨天' });
  const rRecent = await callTool(SEARCH, toolCtx(store, K), { keywords: '', from: '最近3小时' });
  const rDate = await callTool(SEARCH, toolCtx(store, K), { keywords: '记录', from: yStr, to: yStr });
  const rBad = await callTool(SEARCH, toolCtx(store, K), { keywords: '记录', from: '上个世纪某天' });

  check('11. 时间解析：昨天 / 最近3小时 / YYYY-MM-DD 各 1 例；非法输入被忽略', () => {
    assert.equal(rToday.total_hits, 1, '「昨天」应命中昨天那条');
    assert.equal(rRecent.total_hits, 1, '「最近3小时」只含 2h 前，不含 5h 前与昨天那条');
    assert.equal(rDate.total_hits, 1, 'YYYY-MM-DD 只写日期应覆盖整天');
    assert.equal(rBad.total_hits, 1, '非法时间被忽略后仍按关键词检索，不能报错');
    assert.ok(String(rBad.hint || '').includes('无法解析'), 'hint 应说明时间参数被忽略');
  });
  check('11b. parseSearchTime：精确时刻按 Asia/Shanghai 解释，非法返回 null', () => {
    assert.equal(new Date(parseSearchTime('2026-11-03 14:00')).toISOString(), '2026-11-03T06:00:00.000Z');
    assert.equal(new Date(parseSearchTime('2026-11-03')).toISOString(), '2026-11-02T16:00:00.000Z', '只写日期 = 当天 00:00(+08)');
    assert.equal(parseSearchTime('上个世纪某天'), null);
    assert.equal(parseSearchTime('2026-13-45'), null);
  });
})();

// ═══ 12a / 12b. 性能（3 万条夹具）══════════════════════════════════════════
{
  const bigStore = new ChatStore(0);
  const BK = 'group:30000';
  const filler = ['今天吃什么', '晚上加班到十点', '那个插件挺好用', '明天记得交表', '周末去爬山', '显卡又涨价了', '这歌单不错', '下雨了带伞'];
  const msgs = [];
  for (let i = 0; i < 30000; i += 1) {
    let text = filler[i % filler.length];
    if (i % 97 === 0) text = 'deepseek 的插件配置写错了';
    msgs.push({
      id: i + 1, mid: 500000 + i, ts: NOW - i * 60000,
      senderId: String(10000 + (i % 40)), senderName: `群友${i % 40}`,
      text, self: false, read: true, reply: null, media: []
    });
  }
  // 直接塞进内存，绕过落盘（3 万次 appendIncoming 会把测试拖成分钟级）
  bigStore.chats.set(BK, { chatKey: BK, nextLocalId: 30001, messages: msgs });

  // 预算 25ms（2026-11-15 放宽，原 20ms）：应用常驻后实测基线 19-23ms，20ms 会因环境负载假失败。
  // 12a 原为单次采样，25ms 预算压在中位数上 → 改为 2 次 warm-up + 5 次中位数。
  // 12b 原先把 search 计入 wordDf 计时，50ms 预算低于复合路径中位数 → 现在只计 wordDf。
  // 25/50/80ms 三个预算全部不变；search 的延迟由 12a 覆盖。
  // samples 必须是奇数：sorted[floor(len/2)] 在偶数样本时给的是上中位数，不是两数均值。
  const benchMedian = (fn, warmups = 2, samples = 5) => {
    for (let i = 0; i < warmups; i += 1) fn();
    const raw = [];
    let last;
    for (let i = 0; i < samples; i += 1) {
      const t = performance.now();
      last = fn();
      raw.push(performance.now() - t);
    }
    const sorted = [...raw].sort((a, b) => a - b);
    return { median: sorted[Math.floor(sorted.length / 2)], raw, last };
  };

  check('12a. 性能：3 万条 + 4 个词，search() 5 次中位数 ≤ 25 ms', () => {
    const { median, raw, last } = benchMedian(() => bigStore.search(BK, {
      words: ['deepseek', '插件', '配置', '写错'], mode: 'any', context: 0
    }));
    assert.ok(last.totalHits > 0, '夹具应能命中');
    assert.ok(
      median <= 25,
      `5 次中位数 ${median.toFixed(1)} ms，超出 25 ms 预算`
        + `（各次 ${raw.map((x) => x.toFixed(1)).join('/')} ms）`
    );
    console.log(`      实测 5 次 ${raw.map((x) => x.toFixed(1)).join('/')} ms，`
      + `中位数 ${median.toFixed(2)} ms / ${last.totalHits} 命中`);
  });

  check('12b. 性能：wordDf() 40 候选 ≤ 50 ms、64 候选 ≤ 80 ms', () => {
    const words = [];
    for (let i = 0; i < 64; i += 1) words.push(`候选${String(i).padStart(2, '0')}词`);
    const words40 = words.slice(0, 40);
    const b40 = benchMedian(() => bigStore.wordDf(BK, words40));
    const b64 = benchMedian(() => bigStore.wordDf(BK, words));
    console.log(`      实测 wordDf 40 候选 5 次 ${b40.raw.map((x) => x.toFixed(1)).join('/')} ms，`
      + `中位数 ${b40.median.toFixed(2)} ms`);
    console.log(`      实测 wordDf 64 候选 5 次 ${b64.raw.map((x) => x.toFixed(1)).join('/')} ms，`
      + `中位数 ${b64.median.toFixed(2)} ms`);
    assert.ok(
      b40.median <= 50,
      `40 候选 5 次中位数 ${b40.median.toFixed(1)} ms，超出 50 ms`
        + `（各次 ${b40.raw.map((x) => x.toFixed(1)).join('/')} ms）`
    );
    assert.ok(
      b64.median <= 80,
      `64 候选 5 次中位数 ${b64.median.toFixed(1)} ms，超出 80 ms`
        + `（各次 ${b64.raw.map((x) => x.toFixed(1)).join('/')} ms）`
    );
  });
}

// ═══ 14. 占位符排除 ═══════════════════════════════════════════════════════
check('14. 占位符排除：机器人自己的 [表情包:xxx] 不进结果，df 按语料口径统计', () => {
  const store = new ChatStore(0);
  const K = 'group:9014';
  add(store, K, { text: '这个表情包不错', senderId: '111', senderName: '甲' });
  add(store, K, { text: '我也想收表情包', senderId: '222', senderName: '乙' });
  store.appendSelf(K, { text: '[表情包:abc123]', ts: NOW });
  store.appendSelf(K, { text: '[图片:xyz]', ts: NOW });
  const r = store.search(K, { words: ['表情包'], context: 0 });
  assert.equal(r.totalHits, 2, '机器人自己的发送记录不应算命中');
  assert.ok(r.messages.every((m) => !m.self));
  assert.equal(store.wordDf(K, ['表情包']).words[0].df, 2, 'df 也不该把占位符算进去');
});

// ═══ 21. wordDf 边界 ══════════════════════════════════════════════════════
check('21. wordDf() 边界：257 词不抛错且 truncated:true，64 词 false', () => {
  const store = new ChatStore(0);
  const K = 'group:9021';
  add(store, K, { text: '随便一句' });
  const many = Array.from({ length: 257 }, (_, i) => `词${i}`);
  const r257 = store.wordDf(K, many);
  assert.equal(r257.truncated, true);
  assert.equal(r257.words.length, 256);
  assert.deepEqual(Object.keys(r257).sort(), ['truncated', 'words']);
  assert.deepEqual(Object.keys(r257.words[0]).sort(), ['df', 'word']);
  const r64 = store.wordDf(K, many.slice(0, 64));
  assert.equal(r64.truncated, false);
  assert.equal(r64.words.length, 64);
});

// ═══ 23. offset 翻页 ══════════════════════════════════════════════════════
await (async () => {
  const store = new ChatStore(0);
  const K = 'group:9023';
  for (let i = 0; i < 60; i += 1) add(store, K, { text: `记录第${i}条 关键词`, ts: NOW - i * 60000 });
  const page1 = await callTool(SEARCH, toolCtx(store, K), { keywords: '关键词', offset: 0 });
  const page2 = await callTool(SEARCH, toolCtx(store, K), { keywords: '关键词', offset: 5 });
  const pageEnd = await callTool(SEARCH, toolCtx(store, K), { keywords: '关键词', offset: 60 });
  check('23. offset 翻页：total_hits=60 时 offset:5 返回第 6–10 条，offset:60 为空', () => {
    assert.equal(page1.total_hits, 60);
    assert.equal(page2.total_hits, 60, 'offset 不改变 total_hits');
    assert.ok(page2.messages.length > 0, 'offset:5 不能是空数组');
    assert.equal(page2.shown, 5, '超限时每页仍最多 5 条');
    assert.ok(!page2.messages.some((m) => page1.messages.some((p) => p.messageId === m.messageId)), '第二页不与第一页重叠');
    assert.deepEqual(pageEnd.messages, []);
  });
})();

// ═══ 25. isVisible 重构等价性 ═════════════════════════════════════════════
check('25. isVisible 重构等价：80 条窗口含 1 撤回 + 1 拍一拍 + 1 屏蔽 → count === 77，且与旧 filter 链一致', () => {
  useConfig((cfg) => { cfg.blocklist = { 9025: ['9900000003'] }; cfg.store.historyCount = 80; });
  const store = new ChatStore(0);
  const K = 'group:9025';
  const ids = [];
  for (let i = 0; i < 77; i += 1) ids.push(add(store, K, { text: `正常第${i}条`, ts: NOW - 100000 + i * 1000, senderId: String(2000 + i) }));
  const recalled = add(store, K, { text: '这条被撤回了', ts: NOW - 100000 + 77000 });
  store.markRecalled(K, recalled.mid);
  add(store, K, { text: '[拍一拍] 甲 拍了拍 乙', ts: NOW - 100000 + 78000, poke: true });
  add(store, K, { text: '屏蔽者说的话', ts: NOW - 100000 + 79000, senderId: '9900000003', senderName: '丙' });

  const past = buildPastState(store, K, { limit: 80 });
  assert.equal(past.count, 77, `应恰好 77 条（80 取 → 滤掉 3），实际 ${past.count}`);

  // 对照组：测试内内联的旧实现（原始 4 条 filter 链），不依赖 git 历史
  const legacy = (() => {
    let messages = store.recent(K, { limit: 80 });
    messages = messages.filter((m) => !m.recalled);
    messages = messages.filter((m) => !m.isPoke);
    const globalBlocked = new Set((getConfig().globalBlocklist || []).map(String));
    if (globalBlocked.size) messages = messages.filter((m) => m.self || !globalBlocked.has(String(m.senderId)));
    const blocked = new Set((getConfig().blocklist?.['9025'] || []).map(String));
    if (blocked.size) messages = messages.filter((m) => m.self || !blocked.has(String(m.senderId)));
    return messages.slice(-80);
  })();
  assert.deepEqual(past.messages.map((m) => m.id), legacy.map((m) => m.id), '与旧 filter 链输出必须逐条相同');
  // "先滤后取"会让 count 变成 80 —— 这条断言就是那根钉子
  assert.notEqual(past.count, 80, '先滤后取会把窗口前移，count 会变 80');
  useConfig();
});

// ═══ 附加：get_recent_messages 切到 visibleOnly ═════════════════════════════
await (async () => {
  const store = new ChatStore(0);
  const K = 'group:9028';
  add(store, K, { text: '正常一条' });
  const rec = add(store, K, { text: '撤回的那条' });
  store.markRecalled(K, rec.mid);
  add(store, K, { text: '[拍一拍] 甲 拍了拍 乙', poke: true });
  const r = await callTool(RECENT, toolCtx(store, K), { limit: 10 });
  check('28. get_recent_messages 走 visibleOnly：撤回/拍一拍不再从工具漏出去', () => {
    const texts = r.messages.map((m) => m.text);
    assert.ok(texts.includes('正常一条'));
    assert.ok(!texts.includes('撤回的那条'), '撤回消息不该被工具翻到');
    assert.ok(!texts.some((t) => t.includes('拍一拍')), '拍一拍不该被工具翻到');
  });
})();

// ═══ 29–35. 时间词剥离 + 翻页覆盖提示（2026-11-04）══════════════════════
//
// 夹具一律用 parseSearchTime 造"昨天/前天"的时间戳，不用 NOW-864e5：
// 后者在凌晨 0–1 点跑测试会跨到前天，变成偶发红。
//
// ⚠️ 消息正文里**不许**出现「昨天」二字。施工单原稿写的是 `昨天：军训打靶…`，
// 于是"昨天"成了真实内容词，剥不剥离都能命中 —— 用例 31/32 因此是空转的
// （实测：把剥词逻辑改成 `if (false && …)` 后 31/32 仍然全绿）。
// 去掉字面时间词后，未剥离 → 0 命中，才能真的咬住"剥词 + 推导范围"。
await (async () => {
  const Y = parseSearchTime('昨天');          // 昨天 00:00（上海）
  const store = new ChatStore(0);
  const K = 'group:9101';
  add(store, K, { text: '军训打靶五发子弹', ts: Y + 12 * 3600e3 });
  add(store, K, { text: '食堂排队排了半小时', ts: Y + 13 * 3600e3 });
  add(store, K, { text: '再刷手机明天军训要困死了', ts: Y + 14 * 3600e3 });
  add(store, K, { text: '前天：抽卡十连出货', ts: Y - 12 * 3600e3 });

  const r29 = await callTool(SEARCH, toolCtx(store, K), { keywords: ['昨天'], limit: 20 });
  check('29. keywords 只含时间词：剥离后按时间列举，hint 说明已忽略', () => {
    assert.equal(r29.total_hits, 3, `应命中昨天 3 条，实得 ${r29.total_hits}`);
    assert.ok(String(r29.hint || '').includes('已忽略时间词'), 'hint 要说明已忽略时间词');
    assert.ok(r29.range && /^\d{2}\/\d{2} \d{2}:\d{2}$/.test(r29.range.from), 'range.from 应是可读时间');
    assert.ok(r29.messages.every((m) => !String(m.text).includes('抽卡')), '不能串到前天');
  });

  const r30 = await callTool(SEARCH, toolCtx(store, K), { keywords: ['昨天'], from: '今天', to: '今天' });
  check('30. 显式 from/to 优先于时间词推导（时间词仍被剥掉）', () => {
    assert.equal(r30.total_hits, 0, '显式范围是今天，夹具里今天没有消息');
    assert.ok(String(r30.hint || '').includes('已忽略时间词'), '剥词 notice 仍要给');
    assert.ok(!r30.messages.some((m) => String(m.text).includes('军训')), '不能偷偷用昨天范围');
  });

  const r31 = await callTool(SEARCH, toolCtx(store, K), { keywords: ['昨天', '军训'], limit: 20 });
  check('31. 时间和内容混着给：只剥时间词，剩下的继续 AND', () => {
    assert.equal(r31.total_hits, 2, `应命中含"军训"的 2 条，实得 ${r31.total_hits}`);
    assert.ok(!r31.messages.some((m) => String(m.text).includes('食堂')), '食堂那条不含军训');
  });

  const K2 = 'group:9102';
  for (let i = 0; i < 60; i += 1) add(store, K2, { text: `填充条${i}`, ts: Y + 3600e3 + i * 1000 });
  const r32 = await callTool(SEARCH, toolCtx(store, K2), { keywords: ['昨天'], limit: 30 });
  check('32. 纯时间列举不套用「>50 只回 5 条」', () => {
    assert.equal(r32.total_hits, 60);
    assert.equal(r32.shown, 30, `应回 30 条，实得 ${r32.shown}`);
    assert.ok(String(r32.hint || '').includes('按时间列出'), 'hint 要说这是时间列举');
  });

  const store2 = new ChatStore(0);
  const K3 = 'group:9103';
  for (let i = 0; i < 45; i += 1) add(store2, K3, { text: `消息${i}`, ts: NOW - (45 - i) * 60e3 });
  const r33 = await callTool(RECENT, toolCtx(store2, K3), { limit: 10 });
  check('33. coverage：older 与 nextOffset 正确', () => {
    assert.equal(r33.count, 10);
    assert.equal(r33.coverage.older, 35);
    assert.equal(r33.coverage.nextOffset, 10);
    assert.ok(String(r33.hint).includes('更早还有 35 条'), 'hint 要给出剩余条数');
    assert.ok(/^\d{2}\/\d{2} \d{2}:\d{2}$/.test(r33.coverage.from), 'coverage.from 是可读时间');
  });

  const r34 = await callTool(RECENT, toolCtx(store2, K3, { pastStateCount: 30 }), { limit: 10 });
  check('34. pastStateCount 计入 skip，older 同步减少', () => {
    assert.equal(r34.count, 10);
    assert.equal(r34.coverage.older, 5, '45 − 30(skip) − 10(本页) = 5');
  });
})();

// ═══ 35. timeWordRange：周 / 月 / N 单位边界（纯函数）════════════════════════
//
// 29–34 只走过"今天 / 昨天"两个分支，其余 8 个（昨晚 / 前天 / 大前天 / 这几天 /
// 最近N / 这周 / 上周 / 上个月）零覆盖 —— 而周、月边界恰恰是最容易写错的一类
// （`(getUTCDay()+6)%7`、`Date.UTC` 减月）。这条不需要夹具，直接调纯函数。
// 断言一律换算到上海墙钟再比，避免受机器时区影响。
check('35. timeWordRange：最近N / 昨晚 / 这周 / 上周 / 上个月 的边界', () => {
  const DAY = 864e5;
  const wall = (ts) => new Date(ts + 8 * 3600e3);        // 上海墙钟
  const today0 = parseSearchTime('今天');

  const h3 = timeWordRange('最近3小时');
  assert.equal(h3.to - h3.from, 3 * 3600e3, '最近N小时必须是 [now-3h, now]，不能像 parseSearchTime 那样退化为空');
  assert.equal(timeWordRange('最近0小时'), null, 'N=0 按普通关键词处理');

  const lastNight = timeWordRange('昨晚');
  assert.equal(wall(lastNight.from).getUTCHours(), 18, '昨晚从 18:00 起算');
  assert.equal(lastNight.to, today0 - 1, '昨晚终点 = 今天 00:00 前 1ms');

  const wk = timeWordRange('这周');
  assert.equal(wall(wk.from).getUTCDay(), 1, '这周起点必须是周一');
  assert.equal(timeWordRange('上周').to, wk.from - 1, '上周终点 = 本周一 00:00 前 1ms');

  const lastMonth = timeWordRange('上个月');
  assert.equal(wall(lastMonth.from).getUTCDate(), 1, '上个月起点是 1 日 00:00');
  assert.equal(wall(lastMonth.from).getUTCMonth(), (wall(today0).getUTCMonth() + 11) % 12, '上个月 = 本月的前一个月');
  const monthStart = today0 - (wall(today0).getUTCDate() - 1) * DAY;
  assert.equal(lastMonth.to, monthStart - 1, '上个月终点 = 本月 1 日 00:00 前 1ms');

  assert.equal(timeWordRange('明天'), null, '未来向的词不剥');
  assert.equal(timeWordRange('上周五'), null, '只收整词，"上周五"按普通关键词处理');
});

// ═══ 36. offset 翻过最早一条：空页的两种成因要分开说 ═══════════════════════
//
// 会话真没历史 与 offset 越过最早一条 都会返回空数组。若共用"没有可翻的历史消息"，
// 模型会以为这个群从来没聊过 —— 而实际上它只是翻过头了。
//
// ⚠️ check() 是同步的，回调里不能直接 await（那样断言失败会变成 unhandled rejection，
// 用例照样打绿 —— 本文件 7 月就踩过这个坑）。所以外面套一层 async IIFE。
await (async () => {
  const s = new ChatStore(0);
  const K = 'group:9104';
  for (let i = 0; i < 5; i += 1) add(s, K, { text: `唯一历史${i}`, ts: NOW - (5 - i) * 60e3 });
  const over = await callTool(RECENT, toolCtx(s, K), { limit: 10, offset: 99 });
  const empty = await callTool(RECENT, toolCtx(new ChatStore(0), 'group:9105'), { limit: 10 });

  check('36. offset 越过最早一条：空页要区分于"会话没历史"', () => {
    assert.equal(over.count, 0);
    assert.equal(over.coverage, null, '空页没有覆盖范围');
    assert.ok(!String(over.hint).includes('没有可翻的历史消息'), '不能和"会话没历史"共用一句话');
    assert.ok(String(over.hint).includes('5'), `要给出可见总数，实得：${over.hint}`);

    assert.equal(empty.count, 0);
    assert.ok(String(empty.hint).includes('没有可翻的历史消息'), '真没历史时保留原话');
  });
})();

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.error(`✗ 历史检索自测失败 ${failures.length} 项（通过 ${pass} 项）`);
  for (const f of failures) console.error(`  - ${f.name}`);
  process.exit(1);
}
console.log(`✓ 历史检索自测全部通过（${pass} 项）`);
