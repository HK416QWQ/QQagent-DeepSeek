// 群入群欢迎全链路 e2e（P0-04b，17 条）。
//
// ⚠️ import 规矩（P0）：顶部只允许静态 import ./_harness.mjs 和 node 内置模块。
// 任何 src/ 下的模块都必须在 await bootApp() 之后动态 import —— logger.js 静态
// import 了 config.js，而 config.js 的 DATA_DIR 是模块加载时求值的：
// 提前 import 会让 DATA_DIR 锁死到真实 data/，updateConfig() 就会改写生产配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp, waitFor, sleep, createChecker } from './_harness.mjs';

// 456 = 常规用例群，457 = 禁言用例独占群（禁言缓存是 per-chatKey 60 秒，混用会污染）
const ctx = await bootApp({
  config: {
    allow: { groups: ['456', '457'], private: ['777'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false
  }
});

// bootApp 只等 connected；connected 在 get_login_info 返回前就可能为 true。
// 禁言用例依赖 selfId='888' 去查成员信息，这里再等一次，避免偶发假绿。
await waitFor(() => ctx.app.onebot.selfId === '888', 5000, 'OneBot selfId 就绪');

// 以下全部动态 import（必须在 bootApp 之后）
const { WELCOME_DEBOUNCE_MS, WELCOME_VARIANTS, WELCOME_MAX_ATS, WELCOME_STICKER_ID, seenKey } = await import('../src/group-welcome.js');
const { logger } = await import('../src/logger.js');

const logs = [];
const off = logger.onLog((entry) => logs.push(`${entry.module} ${entry.text}`));

const state = ctx.onebotHttp.state;
const sends = () => state.sends;
const textOf = (msg) => (msg?.body?.message ?? [])
  .filter((s) => s.type === 'text')
  .map((s) => s.data.text)
  .join('');
const atQqsOf = (msg) => (msg?.body?.message ?? [])
  .filter((s) => s.type === 'at')
  .map((s) => s.data.qq);
const imageFilesOf = (msg) => (msg?.body?.message ?? [])
  .filter((s) => s.type === 'image')
  .map((s) => s.data.file);

// 变体是随机的：e2e 只能断言"属于对应人数的文案集合"，不能断言某一固定句
const welcomeTexts = (n) => WELCOME_VARIANTS.map((v) => (n <= 1 ? v.short : v.many(n)));
const isWelcomeText = (text, n) => welcomeTexts(n).includes(text);

// 真实 group_increase 只带 group_id / operator_id / user_id / sub_type（不带 sender）。
// 测"不带 self_id"时必须传 { self_id: undefined }（JSON.stringify 会丢掉该字段）。
const pushJoin = (groupId, userId, extra = {}) => ctx.onebotWs.push({
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

const seenFile = path.join(ctx.dataDir, 'welcome-seen.json');
const readSeen = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch { return null; }
};
const hasSeenKey = (groupId, userId) => {
  const parsed = readSeen();
  return Boolean(parsed?.entries?.some(([k]) => k === seenKey(groupId, userId)));
};

const checker = createChecker('群入群欢迎 e2e');
try {
  // ── 1. 允许群单人（正例）──────────────────────────────────────────────
  await checker.check('1 允许群单人：发 1 条到 group 456', async () => {
    const n = sends().length;
    pushJoin(456, 123);
    await waitFor(() => sends().length === n + 1, 8000, '第 1 条欢迎');
    const msg = sends()[n];
    assert.equal(msg.action, 'send_group_msg');
    assert.equal(msg.body.group_id, 456);
    assert.ok(isWelcomeText(textOf(msg), 1), `正文应属于 short 集合，实际：${textOf(msg)}`);
  });

  // ── 2. 固定中性模板（1 人短句）────────────────────────────────────────
  await checker.check('2 三条模板结构：short 互不相同、不带人数', async () => {
    const first = sends()[0];
    assert.equal(WELCOME_VARIANTS.length, 3);
    const shorts = WELCOME_VARIANTS.map((v) => v.short);
    assert.equal(new Set(shorts).size, 3, '三条 short 必须互不相同');
    for (const s of shorts) {
      assert.ok(!/[0-9]/.test(s), `short 不应带阿拉伯数字：${s}`);
      assert.ok(!s.includes('位'), `short 不应带"位"：${s}`);
    }
    assert.ok(isWelcomeText(textOf(first), 1), '第 1 条正文必须是三条 short 之一（严格相等）');
  });

  // ── 3. at 段（正例）──────────────────────────────────────────────────
  await checker.check('3 at 段：恰好 1 个、qq=123、在文本段之前、正文无 CQ 码', async () => {
    const first = sends()[0];
    const segs = first.body.message;
    const atIdx = segs.findIndex((s) => s.type === 'at');
    const textIdx = segs.findIndex((s) => s.type === 'text');
    assert.equal(segs.filter((s) => s.type === 'at').length, 1);
    assert.deepEqual(atQqsOf(first), ['123']);
    assert.ok(atIdx >= 0 && textIdx >= 0 && atIdx < textIdx, 'at 段必须在文本段之前');
    assert.ok(!textOf(first).includes('[CQ:at'), '正文不得出现 [CQ:at');
  });

  // ── 4. 归档（方案 A）+ 状态落盘 ──────────────────────────────────────
  await checker.check('4 归档可见 + welcome-seen.json 只含哈希键', async () => {
    const first = sends()[0];
    const text1 = textOf(first);
    // sends 在 mock HTTP 收到请求时就写了，此时 flush 可能还没走到 appendSelf
    await waitFor(() => ctx.app.store.getChatMeta('group:456').lastText === text1, 5000, '归档写入');

    const recent = ctx.app.store.recent('group:456');
    const archived = recent.find((m) => m.self === true && m.text === text1);
    assert.ok(archived, '归档里应能找到这条 self 消息');
    assert.ok(!String(archived.text).includes('[CQ:at'), '归档文本不得含 [CQ:at');
    assert.ok(!/\d{5,}/.test(String(archived.text)), '归档文本不得含 QQ 号');

    // 不能用 sends.length 当落盘信号：必须等文件内容本身
    await waitFor(() => hasSeenKey('456', '123'), 8000, '状态文件含 seenKey(456,123)');
    const raw = fs.readFileSync(seenFile, 'utf8');
    assert.equal(readSeen().version, 1);
    assert.ok(!raw.includes('456:123'), '状态文件不得出现明文 群:QQ');
    const keys = readSeen().entries.map(([k]) => k);
    for (const k of keys) assert.match(k, /^[0-9a-f]{32}$/);
  });

  // ── 5. 合并（3 人）─────────────────────────────────────────────────
  await checker.check('5 合并：3 人一条、at 顺序=入群顺序、正文带人数 3', async () => {
    const n = sends().length;
    pushJoin(456, 201);
    pushJoin(456, 202);
    pushJoin(456, 203);
    await waitFor(() => sends().length === n + 1, 8000, '合并欢迎');
    const msg = sends()[n];
    assert.deepEqual(atQqsOf(msg), ['201', '202', '203']);
    const text = textOf(msg);
    assert.ok(isWelcomeText(text, 3), `正文应属于 many(3) 集合，实际：${text}`);
    assert.ok(text.includes('3'), '正文必须带人数');
  });

  // ── 6. 人数上限（12 人）───────────────────────────────────────────
  await checker.check('6 上限：12 人只 at 前 5 个、正文带 12、不查昵称', async () => {
    const n = sends().length;
    const callsBefore = state.memberInfoCalls.length;
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const id = String(301 + i);
      ids.push(id);
      pushJoin(456, Number(id));
    }
    await waitFor(() => sends().length === n + 1, 8000, '12 人合并欢迎');
    const msg = sends()[n];
    assert.equal(atQqsOf(msg).length, WELCOME_MAX_ATS, 'at 数量必须等于上限 5');
    assert.deepEqual(atQqsOf(msg), ids.slice(0, WELCOME_MAX_ATS));
    const text = textOf(msg);
    assert.ok(isWelcomeText(text, 12), `正文应属于 many(12) 集合，实际：${text}`);
    assert.ok(text.includes('12'));

    // 不该为了欢迎去查任何新成员的名片（禁言查询查的是 self 888，不在此列）
    const queried = state.memberInfoCalls.slice(callsBefore).map((c) => Number(c.user_id));
    for (const id of ids) {
      assert.ok(!queried.includes(Number(id)), `不应查询 ${id} 的名片（欢迎不查昵称）`);
    }
  });

  // ── 7. 自己进群（负例）────────────────────────────────────────────
  await checker.check('7 自己进群：0 条', async () => {
    const n = sends().length;
    const mark = logs.length;
    pushJoin(456, 888);
    await sleep(WELCOME_DEBOUNCE_MS + 1200);
    assert.equal(sends().length, n, '机器人自己进群不应欢迎');
    assert.ok(logs.slice(mark).some((l) => l.includes('reason=self-join')), '应记 self-join');
  });

  // ── 8. user_id=0（负例）───────────────────────────────────────────
  await checker.check('8 user_id=0：0 条，且不产生 at qq=0', async () => {
    const n = sends().length;
    const mark = logs.length;
    pushJoin(456, 0);
    await sleep(WELCOME_DEBOUNCE_MS + 1200);
    assert.equal(sends().length, n);
    assert.ok(logs.slice(mark).some((l) => l.includes('reason=invalid-user')), '应记 invalid-user');
    assert.ok(!sends().some((m) => atQqsOf(m).includes('0')), '任何一条都不应 at qq=0');
  });

  // ── 9. selfId 双空 + self_id 兜底（负例 × 2）───────────────────────
  await checker.check('9 selfId 双空跳过；self_id 兜底能认出 self-join', async () => {
    const n = sends().length;
    const saved = ctx.app.onebot.selfInfo;
    try {
      ctx.app.onebot.selfInfo = null;
      // 前置自检：确认真的是空（防止 getter 另有缓存导致本用例假绿）
      assert.equal(ctx.app.onebot.selfId, '', '前置：selfId 必须为空');

      pushJoin(456, 401, { self_id: undefined });
      await sleep(WELCOME_DEBOUNCE_MS + 1200);
      assert.equal(sends().length, n, '双源都空时不应发送');

      // 同状态下推 self_id=888 / user 888：必须走 self-join（证明 event.self_id 兜底生效）
      const mark = logs.length;
      pushJoin(456, 888, { self_id: 888 });
      await sleep(WELCOME_DEBOUNCE_MS + 1200);
      assert.equal(sends().length, n, 'self-join 不应发送');
      const added = logs.slice(mark);
      assert.ok(added.some((l) => l.includes('skip reason=self-join group=456')), '应记 self-join');
      assert.ok(!added.some((l) => l.includes('self-id-empty')), '不应走 self-id-empty（说明兜底没生效）');
    } finally {
      ctx.app.onebot.selfInfo = saved;
    }
  });

  // ── 10. 白名单拒绝（负例）─────────────────────────────────────────
  await checker.check('10 群不在 allow.groups：0 条', async () => {
    const n = sends().length;
    const mark = logs.length;
    pushJoin(789, 501);
    await sleep(WELCOME_DEBOUNCE_MS + 1200);
    assert.equal(sends().length, n, '789 不在白名单不应欢迎');
    assert.ok(logs.slice(mark).some((l) => l.includes('reason=not-allowed')), '应记 not-allowed');
  });

  // ── 11. deny 优先（负例）─────────────────────────────────────────
  await checker.check('11 deny.groups 优先：0 条', async () => {
    const n = sends().length;
    const mark = logs.length;
    try {
      ctx.app.updateConfig({ deny: { groups: ['456'] } });
      pushJoin(456, 502);
      await sleep(WELCOME_DEBOUNCE_MS + 1200);
      assert.equal(sends().length, n, 'deny 命中的群不应欢迎');
      assert.ok(logs.slice(mark).some((l) => l.includes('reason=not-allowed group=456')), '应记 not-allowed');
    } finally {
      ctx.app.updateConfig({ deny: { groups: [] } });
    }
  });

  // ── 12. allowAllWhenEmpty（正例）──────────────────────────────────
  await checker.check('12 allow.groups 为空 + allowAllWhenEmpty：欢迎', async () => {
    const n = sends().length;
    try {
      ctx.app.updateConfig({ allow: { groups: [] }, allowAllWhenEmpty: true });
      pushJoin(789, 601);
      await waitFor(() => sends().length === n + 1, 8000, 'allowAllWhenEmpty 欢迎');
      assert.ok(isWelcomeText(textOf(sends()[n]), 1));
    } finally {
      ctx.app.updateConfig({ allow: { groups: ['456', '457'] }, allowAllWhenEmpty: false });
    }
  });

  // ── 13. 禁言（负例，独占群 457）────────────────────────────────────
  await checker.check('13 机器人被禁言：0 条，日志 reason=muted', async () => {
    const n = sends().length;
    const mark = logs.length;
    // shut_up_timestamp 是 epoch 秒且判据是"到期时刻在未来"；写 600 会变成 1970 年 → 假绿
    state.memberInfoOverrides.set('457:888', { shut_up_timestamp: Math.floor(Date.now() / 1000) + 600 });
    pushJoin(457, 701);
    await sleep(WELCOME_DEBOUNCE_MS + 1200);
    assert.equal(sends().length, n, '禁言中不应欢迎');
    assert.ok(logs.slice(mark).some((l) => l.includes('skip reason=muted group=457')), '应记 muted');
  });

  // ── 14. 成功后重复事件（正例 + 负断言）────────────────────────────
  await checker.check('14 成功欢迎后立即重复事件：只 1 条', async () => {
    const n = sends().length;
    pushJoin(456, 801);
    await waitFor(() => sends().length === n + 1, 8000, '801 首次欢迎');
    // 必须等文件里出现这条记录再推第二次：否则"被 inFlight 挡住"会被误当成"TTL 生效"
    await waitFor(() => hasSeenKey('456', '801'), 8000, '状态文件含 seenKey(456,801)');
    pushJoin(456, 801);
    await sleep(WELCOME_DEBOUNCE_MS + 1200);
    assert.equal(sends().length, n + 1, '短时间内重复事件不应再发');
  });

  // ── 15. 发送失败 + 重试（正例 + 负断言）───────────────────────────
  await checker.check('15 发送失败：不写 TTL、不重试；同 user 再入群可重发', async () => {
    const n = sends().length;
    const a = state.sendAttempts.length;
    const mark = logs.length;
    try {
      state.failNextSend = true;
      pushJoin(456, 1001);
      await sleep(WELCOME_DEBOUNCE_MS + 1200);
      assert.equal(sends().length, n, '发送失败不应新增 sends');
      assert.equal(state.sendAttempts.length, a + 1, '失败后不得自动重试（只应尝试 1 次）');
      assert.ok(logs.slice(mark).some((l) => l.includes('[welcome] 发送失败')), '应记发送失败');
    } finally {
      state.failNextSend = false;
    }
    // 失败没写 TTL、也没把 user 留在 inFlight：同一 user 再推应能成功
    pushJoin(456, 1001);
    await waitFor(() => sends().length === n + 1, 8000, '重试成功');
    assert.equal(state.sendAttempts.length, a + 2, '重试应再尝试 1 次');
  });

  // ── 16. 欢迎后追加探头表情 ────────────────────────────────────────
  await checker.check('16 欢迎后追加探头表情：文字在前、image 在后、表情不 at', async () => {
    const n = sends().length;
    fs.writeFileSync(path.join(ctx.dataDir, 'stickers.json'), JSON.stringify([{
      id: WELCOME_STICKER_ID,
      url: 'file:///tmp/peek.png',
      desc: '探头 可爱'
    }]), 'utf8');
    await ctx.app.stickers.reload();

    pushJoin(456, 2101);
    await waitFor(() => sends().length === n + 2, 8000, '文字+表情');
    const textMsg = sends()[n];
    const stickerMsg = sends()[n + 1];
    assert.equal(textMsg.action, 'send_group_msg');
    assert.equal(stickerMsg.action, 'send_group_msg');
    assert.ok(isWelcomeText(textOf(textMsg), 1), `第一条应是欢迎文字，实际：${textOf(textMsg)}`);
    assert.deepEqual(imageFilesOf(stickerMsg), ['file:///tmp/peek.png']);
    assert.deepEqual(atQqsOf(stickerMsg), [], '表情不应 at 人');
  });

  // ── 17. 无 LLM ───────────────────────────────────────────────────
  await checker.check('17 整场没有调用 LLM', async () => {
    assert.equal(ctx.llm.state.requests.length, 0, `不应有 LLM 请求，实际 ${ctx.llm.state.requests.length}`);
  });
} finally {
  try { off(); } catch { /* ignore */ }
  try {
    await ctx.teardown();
  } finally {
    checker.finish();   // ★ 只有它会把失败写进 process.exitCode
  }
}
