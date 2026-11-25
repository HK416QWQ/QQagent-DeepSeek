// 表情包开关与数据层测试（2026-11-02）
//
// 覆盖施工单 §7.2 的 13 个用例：
//   · 总开关 / 收藏开关的工具可用性闸
//   · 收藏关闭时 sync 不请求 QQ、collect 直接拒绝
//   · emojiId 落库、id 切换不丢字段、resId 不被误当 emoji_id
//   · 本地 desc / emojiId 补丁、按 emojiId 命中、reload
//   · 发送不再有随机停顿
//   · 系统提示 / 覆盖提示 / finish-merge 插件随总开关一致
//   · 用户角色卡原文不动，关闭时追加说明
//
// 运行：node test/sticker-settings-test.mjs
// 数据目录一律用临时 QQ_AGENT_DATA_DIR，绝不碰真实 data/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChecker, sleep, ROOT } from './_harness.mjs';

// ── 环境：临时数据目录（必须在 import src 模块之前设好）──────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-sticker-settings-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'sticker-images'), { recursive: true });

// ── mock OneBot（HTTP API）──────────────────────────────────────────────
const scenario = {
  favList: [],
  fetchCalls: 0
};
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const action = String(req.url || '').replace(/^\//, '');
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    const reply = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    if (action === 'fetch_custom_face_detail') {
      scenario.fetchCalls += 1;
      return reply(scenario.favList);
    }
    if (action === 'add_custom_face') return reply({ emoji_id: 'E1' });
    if (action === 'modify_custom_face') return reply(null);
    if (action === 'get_image') return reply({ file: '', url: '' });
    if (action === 'send_group_msg') return reply({ message_id: 9001 });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '未知动作' }));
  });
});
const mockPort = await new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));
const base = `http://127.0.0.1:${mockPort}`;

const { getConfig, updateConfig } = await import('../src/config.js');
const { OneBotClient } = await import('../src/onebot.js');
const { StickerManager } = await import('../src/sticker-manager.js');
const {
  saveStickerStore, loadStickerStore, mergeStickerLibrary, findSticker
} = await import('../src/stickers.js');
const { getToolAvailability, getTool } = await import('../src/tool-registry.js');
const { buildToolDefs } = await import('../src/tools.js');
const { buildSystemPrompt, buildUserPrompt } = await import('../src/prompt.js');
const { promptSections } = await import('../plugins/finish-merge/index.js');

const onebot = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: base, accessToken: '', httpToken: '', onEvent: () => {} });
const originalRoleText = getConfig().persona.roleText;

// 确保内置工具已注册（幂等）
buildToolDefs();

const c = createChecker('表情包开关与数据层');

// ── 1. 总开关关闭：所有表情工具被拒 ─────────────────────────────────────
await c.check('1. 总开关关闭：send_sticker 与 category=sticker 工具全部被拒', () => {
  for (const id of ['send_sticker', 'list_stickers', 'get_sticker_image', 'sticker_note', 'collect_sticker']) {
    const r = getToolAvailability(id, { toolsCfg: { enabled: true }, stickerEnabled: false });
    assert.equal(r.enabled, false, `${id} 应被禁用`);
    assert.equal(r.code, 'sticker-disabled', `${id} 的 code 应为 sticker-disabled，实际 ${r.code}`);
  }
});

// ── 2. 收藏开关关闭：只拒 collect_sticker ───────────────────────────────
await c.check('2. 收藏开关关闭：collect_sticker 被拒，send_sticker / list_stickers 仍可用', () => {
  const collect = getToolAvailability('collect_sticker', { toolsCfg: { enabled: true }, stickerEnabled: true, stickerCollectEnabled: false });
  assert.equal(collect.enabled, false);
  assert.equal(collect.code, 'sticker-collect-disabled');
  for (const id of ['send_sticker', 'list_stickers']) {
    const r = getToolAvailability(id, { toolsCfg: { enabled: true }, stickerEnabled: true, stickerCollectEnabled: false });
    assert.equal(r.enabled, true, `${id} 不应受收藏开关影响`);
  }
});

// ── 3. 同步闸：收藏关闭不请求 QQ ────────────────────────────────────────
await c.check('3. 收藏关闭时 sync(true) 返回缓存且不调用 fetch_custom_face_detail', async () => {
  updateConfig({ sticker: { collectEnabled: false } });
  scenario.fetchCalls = 0;
  const sm = new StickerManager(onebot);
  const r = await sm.sync(true);
  assert.equal(r.disabled, true);
  assert.equal(r.fromCache, true);
  assert.equal(scenario.fetchCalls, 0, '收藏关闭时不应请求 fetch_custom_face_detail');
  updateConfig({ sticker: { collectEnabled: true } });
});

// ── 4. 收藏闸：collect 直接拒绝 ─────────────────────────────────────────
await c.check('4. 收藏关闭时 collect 报“收藏表情功能未开启”', async () => {
  updateConfig({ sticker: { collectEnabled: false } });
  const sm = new StickerManager(onebot);
  await assert.rejects(
    () => sm.collect('9001', { url: `${base}/x.png`, file: '', note: '测试' }),
    (e) => /收藏表情功能未开启/.test(String(e.message))
  );
  updateConfig({ sticker: { collectEnabled: true } });
});

// ── 5. emojiId 落库 ─────────────────────────────────────────────────────
await c.check('5. sync 后条目写入 emojiId', async () => {
  saveStickerStore([]);
  scenario.favList = [{ emoji_id: 'E1', resId: 'E1', url: 'https://p.qpic.cn/qq_expression/test/E1.png', md5: 'M1' }];
  const sm = new StickerManager(onebot);
  await sm.sync(true);
  assert.equal(sm.entries.length, 1);
  assert.equal(sm.entries[0].id, 'E1');
  assert.equal(sm.entries[0].emojiId, 'E1');
});

// ── 5b. id 从 resId 切到 emoji_id：旧字段不丢 + 幂等 ────────────────────
await c.check('5b. mergeStickerLibrary：id 切换保留 localFile/localNote/tags/useCount 且幂等', () => {
  const old = [{ id: 'R9', resId: 'R9', localFile: 'C:/x/9.gif', localNote: '旧笔记', tags: ['笑'], useCount: 7 }];
  const once = mergeStickerLibrary(old, [{ emoji_id: 'E9', resId: 'R9', url: 'https://example.com/9.png' }]);
  assert.equal(once.length, 1, '不能出现 R9 + E9 两条');
  assert.equal(once[0].id, 'E9');
  assert.equal(once[0].resId, 'R9');
  assert.equal(once[0].emojiId, 'E9');
  assert.equal(once[0].localFile, 'C:/x/9.gif');
  assert.equal(once[0].localNote, '旧笔记');
  assert.deepEqual(once[0].tags, ['笑']);
  assert.equal(once[0].useCount, 7);
  const twice = mergeStickerLibrary(once, [{ emoji_id: 'E9', resId: 'R9' }]);
  assert.equal(twice.length, 1, '重复同步应保持 1 条');
  assert.equal(twice[0].id, 'E9');
  assert.equal(twice[0].localNote, '旧笔记');
  assert.equal(twice[0].useCount, 7);
  assert.deepEqual(twice[0].tags, ['笑']);
});

// ── 5c. 可读本地文件 + QQ http：保留 file:/// ───────────────────────────
await c.check('5c. 本地文件可读（url=file:///）+ QQ http：保留 file:///，persistFailed=false，重复合并稳定', () => {
  const file = path.join(dataDir, 'sticker-images', 'c.png');
  fs.writeFileSync(file, Buffer.from('c'));
  const fileUrl = pathToFileURL(file).href;
  const old = [{ id: 'C1', resId: 'C1', localFile: fileUrl, url: fileUrl, persistFailed: true }];
  const fetched = [{ emoji_id: 'C1', resId: 'C1', url: 'https://example.com/c.png' }];
  const once = mergeStickerLibrary(old, fetched);
  assert.equal(once.length, 1);
  assert.equal(once[0].url, fileUrl, 'url 应保持本地路径');
  assert.equal(once[0].localFile, fileUrl, 'localFile 不应变化');
  assert.equal(once[0].persistFailed, false);
  const twice = mergeStickerLibrary(once, fetched);
  assert.equal(twice[0].url, fileUrl, '重复合并 url 不变');
  assert.equal(twice[0].persistFailed, false, '重复合并 persistFailed 不变');
});

// ── 5d. localFile 可读但 url 是 http：升级回 file:/// ───────────────────
await c.check('5d. localFile 可读但 url 是 http + QQ http：url 升级为 file:///，persistFailed=false', () => {
  const file = path.join(dataDir, 'sticker-images', 'd.png');
  fs.writeFileSync(file, Buffer.from('d'));
  const fileUrl = pathToFileURL(file).href;
  const old = [{ id: 'D1', resId: 'D1', localFile: fileUrl, url: 'https://cdn.local/d.png', persistFailed: false }];
  const merged = mergeStickerLibrary(old, [{ emoji_id: 'D1', resId: 'D1', url: 'https://example.com/d.png' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, fileUrl, 'url 应升级为本地路径');
  assert.equal(merged[0].localFile, fileUrl, 'localFile 不应变化');
  assert.equal(merged[0].persistFailed, false);
});

// ── 5e. localFile 指向不存在的文件：回落 QQ http ────────────────────────
await c.check('5e. localFile 指向不存在的文件 + QQ http：url 取 QQ http，有 emoji_id 时 persistFailed=false', () => {
  const missing = pathToFileURL(path.join(dataDir, 'sticker-images', 'missing-e.png')).href;
  const old = [{ id: 'E5', resId: 'E5', localFile: missing, url: missing, persistFailed: false }];
  const merged = mergeStickerLibrary(old, [{ emoji_id: 'E5', resId: 'E5', url: 'https://example.com/e.png' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, 'https://example.com/e.png', '本地丢失应回落 QQ 地址');
  assert.equal(merged[0].persistFailed, false);
});

// ── 5f. 无本地、无 emojiId、旧标记 false：纠正为 true ───────────────────
await c.check('5f. 无本地、无 emojiId、旧 persistFailed=false + QQ 无 emoji_id：合并后为 true', () => {
  const old = [{ id: 'F1', resId: 'F1', url: 'https://old.example.com/f.png', persistFailed: false }];
  const merged = mergeStickerLibrary(old, [{ resId: 'F1', url: 'https://new.example.com/f.png' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'F1');
  assert.equal(merged[0].persistFailed, true, '应纠正错标');
  assert.equal(merged[0].url, 'https://new.example.com/f.png');
});

// ── 5g. 本地丢失 + QQ 无 url + 旧 url 是死 file:///：不回退死链 ─────────
await c.check('5g. 本地文件丢失 + QQ 无 url + 旧 url 是死 file:///：url 为空，persistFailed=true', () => {
  const dead = pathToFileURL(path.join(dataDir, 'sticker-images', 'dead-g.png')).href;
  const old = [{ id: 'G1', resId: 'G1', url: dead, localFile: dead, persistFailed: false }];
  const merged = mergeStickerLibrary(old, [{ resId: 'G1' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, '', '不能留死 file 链接');
  assert.equal(merged[0].persistFailed, true);
});

// ── 5h. 本地丢失 + QQ 无 url + 旧 url 是 http：保留旧 http ──────────────
await c.check('5h. 本地文件丢失 + QQ 无 url + 旧 url 是 http：保留旧 http，有 emojiId 时 persistFailed=false', () => {
  const missing = pathToFileURL(path.join(dataDir, 'sticker-images', 'missing-h.png')).href;
  const old = [{ id: 'H1', resId: 'H1', localFile: missing, url: 'https://old.example.com/h.png', persistFailed: true }];
  const merged = mergeStickerLibrary(old, [{ emoji_id: 'H1', resId: 'H1' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, 'https://old.example.com/h.png', '应保留旧 http');
  assert.equal(merged[0].persistFailed, false);
});

// ── 5i. 看图工具：受控目录内 file:/// 可读，目录外拒绝 ─────────────────
await c.check('5i. get_sticker_image：受控目录内 file:/// 返回 data:image/，目录外仍报“只允许 http(s)”', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const inside = path.join(dataDir, 'sticker-images', 'pick.png');
  fs.writeFileSync(inside, png);
  const insideUrl = pathToFileURL(inside).href;
  const tool = getTool('get_sticker_image');
  assert.ok(tool, 'get_sticker_image 应已注册');
  const okResult = await tool.execute(
    { stickers: { find: async () => ({ id: 'pick', url: insideUrl, desc: '' }) } },
    { stickerId: 'pick' }
  );
  assert.notEqual(okResult.isError, true, `不应报错：${okResult.content}`);
  const imagePart = Array.isArray(okResult.content) && okResult.content.find((p) => p.type === 'image_url');
  assert.ok(imagePart, '应包含 image_url 部件');
  assert.ok(String(imagePart.image_url.url).startsWith('data:image/'), '应返回 data:image/ 数据 URL');

  const outside = path.join(dataDir, 'outside.png');
  fs.writeFileSync(outside, png);
  const outsideUrl = pathToFileURL(outside).href;
  const badResult = await tool.execute(
    { stickers: { find: async () => ({ id: 'outside', url: outsideUrl, desc: '' }) } },
    { stickerId: 'outside' }
  );
  assert.equal(badResult.isError, true, '目录外文件必须拒绝');
  assert.ok(String(badResult.content).includes('只允许 http(s)'), `错误信息应含“只允许 http(s)”，实际：${badResult.content}`);
});

// ── 6. resId 不是 emoji_id ──────────────────────────────────────────────
await c.check('6. 只返回 resId/id（无 emoji_id）时 emojiId 为空', async () => {
  saveStickerStore([]);
  scenario.favList = [{ resId: 'R9', id: 'R9' }];
  const sm = new StickerManager(onebot);
  await sm.sync(true);
  assert.equal(sm.entries.length, 1);
  assert.equal(sm.entries[0].id, 'R9');
  assert.equal(sm.entries[0].emojiId, '', '不能把 resId 兜底成 emojiId');
});

// ── 7. 本地 desc / emojiId 补丁 + 按 emojiId 命中 ───────────────────────
await c.check('7. note 支持 desc/emojiId 补丁，且 findSticker 认 emojiId', async () => {
  saveStickerStore([]);
  scenario.favList = [{ emoji_id: 'E1', resId: 'E1', url: 'https://p.qpic.cn/qq_expression/test/E1.png', md5: 'M1' }];
  const sm = new StickerManager(onebot);
  await sm.sync(true);
  const updated = sm.note('E1', { desc: '新备注', note: '新笔记', emojiId: 'E9' });
  assert.equal(updated.desc, '新备注');
  assert.equal(updated.localNote, '新笔记');
  assert.equal(updated.emojiId, 'E9');
  assert.ok(findSticker(sm.entries, 'E9'), 'findSticker 应认 emojiId');
  const byEmoji = sm.note('E9', { note: '按 emojiId 命中' });
  assert.ok(byEmoji, '按 emojiId 应命中同一条');
  assert.equal(byEmoji.id, 'E1', 'id 不应被改掉');
  assert.equal(byEmoji.localNote, '按 emojiId 命中');
  assert.equal(sm.entries.length, 1, '库里仍应只有这一条');
});

// ── 8. reload：外部改盘后内存同步 ───────────────────────────────────────
await c.check('8. reload() 读取外部脚本写入的 localNote', async () => {
  saveStickerStore([{ id: 'reload-1', resId: 'reload-1', localNote: '旧笔记' }]);
  const sm = new StickerManager(onebot);
  assert.equal(sm.entries[0].localNote, '旧笔记');
  const arr = loadStickerStore();
  arr[0].localNote = '外部脚本新笔记';
  saveStickerStore(arr);
  const count = await sm.reload();
  assert.equal(count, 1);
  assert.equal(sm.entries[0].localNote, '外部脚本新笔记');
});

// ── 9. 无延迟（静态检查）────────────────────────────────────────────────
await c.check('9. sendSticker 不再有 600~1500ms 随机停顿，且 #checkRate 仍在', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src/sender.js'), 'utf8');
  assert.ok(!text.includes('sleep(randInt(600, 1500))'), '不应再有表情发送前的随机停顿');
  const fn = text.slice(text.indexOf('sendSticker('));
  assert.ok(fn.includes('#checkRate'), 'sendSticker 仍应保留发送频率校验');
});

// ── 10. 系统提示随总开关一致 ────────────────────────────────────────────
await c.check('10. 总开关关闭：系统提示去掉表情段，保留【拍一拍】；开启后恢复', () => {
  updateConfig({ sticker: { enabled: false } });
  const off = buildSystemPrompt({ persona: getConfig().persona, skillContext: { stickerEnabled: false } });
  for (const needle of ['【表情包策略', 'send_sticker', 'get_sticker_image', 'stickerId']) {
    assert.ok(!off.includes(needle), `关闭时不应出现 ${needle}`);
  }
  assert.ok(off.includes('【拍一拍】'), '拍一拍不属于表情包体系，应保留');
  updateConfig({ sticker: { enabled: true } });
  const on = buildSystemPrompt({ persona: getConfig().persona, skillContext: { stickerEnabled: true } });
  for (const needle of ['【表情包策略', 'send_sticker', 'get_sticker_image']) {
    assert.ok(on.includes(needle), `开启时应恢复 ${needle}`);
  }
});

// ── 11. 系统提示覆盖路径同样受总开关约束 ────────────────────────────────
await c.check('11. systemPromptOverride 路径在总开关关闭时也不出现 send_sticker', () => {
  updateConfig({ persona: { systemPromptOverride: '自定义系统提示（不含角色变量）' }, sticker: { enabled: false } });
  const off = buildSystemPrompt({ persona: getConfig().persona, skillContext: { stickerEnabled: false } });
  assert.ok(off.includes('自定义系统提示'));
  assert.ok(!off.includes('send_sticker'), '覆盖路径也不应出现 send_sticker');
  updateConfig({ persona: { systemPromptOverride: '' }, sticker: { enabled: true } });
});

// ── 12. finish-merge 插件段 ─────────────────────────────────────────────
await c.check('12. finish-merge：关闭去掉 send_sticker/stickerId，开启与缺省保留', () => {
  const off = promptSections({ stickerEnabled: false })[0].content;
  assert.ok(!off.includes('send_sticker'), '关闭时不应出现 send_sticker');
  assert.ok(!off.includes('stickerId'), '关闭时不应出现 stickerId');
  assert.ok(off.includes('收尾') && off.includes('send_message'), '其他原有文案应保留');
  const on = promptSections({ stickerEnabled: true })[0].content;
  assert.ok(on.includes('send_sticker'), '开启时应包含 send_sticker');
  const dft = promptSections({})[0].content;
  assert.ok(dft.includes('send_sticker'), '缺省 fail-open 应包含 send_sticker');
});

// ── 13. 角色卡原文不动，关闭时追加说明 ──────────────────────────────────
await c.check('13. buildUserPrompt：角色卡原文不变，关闭时追加【表情包功能已关闭】', () => {
  const roleText = '你是测试机器人，可以 send_sticker 发表情。';
  const makeCtx = () => ({
    chatKey: 'group:456',
    kind: 'group',
    chatId: '456',
    triggerEntries: [{ id: 1, mid: 1, senderId: '111', senderName: '张三', text: '在吗', media: [], ts: Date.now() }],
    stickerEntries: [],
    contextLimit: 0,
    activeTopic: '',
    selfNickname: '',
    memory: { formatForPrompt: () => '' },
    // 桩 store 要满足 buildPastState / 静默召回用到的最小契约（2026-11-04）：
    // 可见性谓词 + 语料统计。这里 recent 返回空数组，谓词恒真，行为与从前一致。
    store: {
      recent: () => [],
      visibilityContext: () => ({ global: new Set(), group: new Set() }),
      isVisible: () => true,
      wordDf: () => ({ truncated: false, words: [] }),
      search: () => ({ totalHits: 0, words: [], messages: [] })
    },
    session: {},
    promptAnchor: { prev: null }
  });

  updateConfig({ persona: { roleText }, sticker: { enabled: false } });
  const off = buildUserPrompt(makeCtx());
  assert.ok(off.includes(roleText), '角色卡原文应保持不动');
  assert.ok(off.includes('【表情包功能已关闭】'), '关闭时应追加说明');
  assert.ok(off.indexOf(roleText) < off.indexOf('【表情包功能已关闭】'), '说明应在角色卡之后');

  updateConfig({ sticker: { enabled: true } });
  const on = buildUserPrompt(makeCtx());
  assert.ok(on.includes(roleText), '开启时角色卡原文仍在');
  assert.ok(!on.includes('【表情包功能已关闭】'), '开启时不应出现关闭说明');
});

// 还原测试改过的人设，避免污染（临时目录，仅为本进程内后续断言留干净状态）
updateConfig({ persona: { roleText: originalRoleText } });

mock.close();
fs.rmSync(dataDir, { recursive: true, force: true });
await sleep(50);
console.log('');
process.exit(c.finish() ? 0 : 1);
