// 记忆三独立页 · 运行时测试（真实 DOM + 真实后端）
//
// 运行：node test/mem4-pages-test.mjs
//
// 隔离口径（施工单 §8.3.2 / 决策 D2）：
//   · 一个进程只 bootApp() 一次 —— src/config.js 的 DATA_DIR 是模块级常量，
//     第二次 bootApp 不会换目录，还会多起一套 mock；
//   · 每条用例用唯一 uid / chatKey / mid / entryId；
//   · 删除审计是全库累计，断言一律"前 N → 后 N+1"。
//
// 执行顺序按文件内 c.check 出现顺序；T6 必须先于 T2/T3；T19 必须最后（含 /api/chats 500 桩）。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { ROOT, bootApp, sleep, waitFor, createChecker } from './_harness.mjs';

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 下面统一处理 */ }
if (!JSDOM) {
  console.error('\n✗ 本套件依赖 jsdom（已在 devDependencies）。请先 npm install，不要跳过：'
    + '跳过会让 test:coverage 记成通过，而八组用例一条都没跑。\n');
  process.exit(1);
}

const c = createChecker('记忆三独立页（真实 DOM）');
const ctx = await bootApp({});
const { base, dataDir } = ctx;

const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
let code = (await import('./_ui-load.mjs')).loadUiAppCode().code;
code = code.replace(/^'use strict';\s*$/m, '');
code = code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');

// ── 夹具（写进 ctx.dataDir，绝不碰真实 data/）────────────────────────────
const YM = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
const OLD_YM = '2024-03';
const GRP = 'group:3300000000001';        // 印象页夹具的群，同时充当摘要页的 A 群
const GRP_ID = '3300000000001';
const GRP_A = GRP;                        // 语义别名：摘要页的 A 群
const GRP_A_ID = GRP_ID;
const GRP_B = 'group:3300000000002';      // 摘要页的 B 群（"两个会话"必测）
const GRP_B_ID = '3300000000002';
// 印象页跳原文专用群：store 按 chatKey 缓存消息（内存），复用 A 群会读到 T6
// 早先载入的旧消息，覆盖写盘不生效。按 D2「每条用例用唯一 chatKey」单开一个。
const GRP_IM = 'group:3300000000009';
const GRP_IM_ID = '3300000000009';
const MID = '770001';

function writePerson(uid, rows) {
  const dir = path.join(dataDir, 'mem2', 'people');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function personRow(uid, entryId, content, groups = ['性格特质'], extra = {}) {
  return {
    entryId, userId: uid, chatKey: GRP, sourceChatKeys: [GRP],
    // ⚠ sourceBatch 必填：editEntry 会读 cur.sourceBatch.chatKey 造新版本（ui-api.js:191），
    //    缺了就是 500，会被误判成"编辑失败"。
    sourceBatch: { chatKey: GRP, userId: uid, at: 1761000000000 },
    content, groups, status: 'active',
    createdAt: 1761000000000, updatedAt: 1761000000000, ...extra
  };
}
function writeMessages(dirName, rows) {
  const dir = path.join(dataDir, 'messages', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${YM}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function writeL4(grpId, ym, rows) {
  writeJsonl(path.join(dataDir, 'mem2', `group_${grpId}`, 'l4', `${ym}.jsonl`), rows);
}

/** 摘要页的整套夹具：两个会话 + 各自的当月 L4。幂等（覆盖写），可重复调用。 */
function writeTableFixtures() {
  writeMessages(`group_${GRP_A_ID}`, [{ id: 1, mid: '710001', ts: 1761000000000, senderId: '991', senderName: '甲', text: 'A 群消息' }]);
  writeMessages(`group_${GRP_B_ID}`, [{ id: 1, mid: '710002', ts: 1761000100000, senderId: '992', senderName: '乙', text: 'B 群消息' }]);
  writeL4(GRP_A_ID, YM, [{ convStartTs: 1761000000000, summary: 'SM-A', sparse: true }]);
  writeL4(GRP_B_ID, YM, [{ convStartTs: 1761000100000, summary: 'SM-B', sparse: true }]);
}

// ── jsdom 挂载 ────────────────────────────────────────────────────────────
const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const document = window.document;

window.EventSource = class { constructor() {} addEventListener() {} close() {} };
window.alert = () => {};
window.confirm = () => true;
if (typeof window.structuredClone !== 'function') window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
// jsdom 没有 scrollIntoView：跳原文用例会以 "not a function" 红，那是环境问题不是代码问题。
window.Element.prototype.scrollIntoView = function () {};
const tier = await import(pathToFileURL(path.join(ROOT, 'src', 'tier-slider.js')).href);
const priceMod = await import(pathToFileURL(path.join(ROOT, 'ui', 'vendor', 'price-match.js')).href);
window.TIER_SLIDER_BANDS = tier.TIER_SLIDER_BANDS;
window.sliderToTier = tier.sliderToTier;
window.tierToSlider = tier.tierToSlider;
window.matchPriceTable = priceMod.matchPriceTable;

// ── 延迟 / 桩 注入：只延迟"交付"，不延迟"发出" ───────────────────────────
let delayRules = [];      // [{ match: /^\/api\/mem2\/deletions$/, ms: 800, once: true }]
let stubRules = [];       // [{ match: /^\/api\/mem2\/knowledge$/, status: 200, body: {...}, once: true, ms?: 800 }]
const requests = [];      // 全部请求路径（用例内清空）
const requestLog = [];    // [{ method, path, body }] —— 带请求体的完整记录（LR-09/T15 用）

window.fetch = async (input, init) => {
  const url = new URL(String(input), base);
  const p = url.pathname;
  const full = p + url.search;
  requests.push(full);
  // ★ 记录必须早于 stub 命中返回：否则被 stub 的 POST 根本不会进日志（T15）
  requestLog.push({
    method: init?.method || 'GET',
    path: full,
    body: init?.body            // JSON 字符串原样保留；断言时 JSON.parse
  });

  const si = stubRules.findIndex((r) => r.match.test(p));
  if (si >= 0) {
    const s = stubRules[si];
    // ★ once 必须在 await sleep 之前摘除：否则慢 stub 在睡眠期间仍留在数组里，
    //   第二条请求会再次命中它（T13 会永远拿不到 count 2）
    if (s.once) stubRules.splice(si, 1);
    if (s.ms) await sleep(s.ms);
    return new Response(JSON.stringify(s.body), { status: s.status || 200, headers: { 'content-type': 'application/json' } });
  }

  const pending = fetch(url.href, init);          // ① 真请求**立刻**发出
  // delayRules 支持两种匹配：正则（默认测 pathname）或字符串（精确比 full = p + search）。
  // 字符串形式用于区分 /api/mem2/l4?chat=A 与 ?chat=B（T9 旧月份/摘要同构）。
  const di = delayRules.findIndex((r) => typeof r.match === 'string' ? r.match === full : r.match.test(p));
  if (di >= 0) {
    const rule = delayRules[di];
    if (rule.once) delayRules.splice(di, 1);      // ② 一次性规则命中即摘
    await sleep(rule.ms);                         // ③ 只把交付往后推
  }
  return pending;
};

window.eval(code + `
;window.__MEM_UI = MEM_UI; window.__state = state; window.__switchTab = switchTab;
window.__mem = {
  loadImpressionDeletionCount, loadImpressionDetail, loadSummariesTable,
  graphSpriteStats: () => ({
    base: impressionGraphBaseSpritesReady,
    scene: impressionGraphSceneSpritesReady,
    stars: impressionGraphSprites?.stars?.size || 0,
    fogs: impressionGraphSprites?.fogs?.size || 0,
    starKeys: [...(impressionGraphSprites?.stars?.keys() || [])],
    sceneImps: impressionGraphScene?.impressions?.length || 0,
    impUids: (impressionGraphScene?.impressions || []).map((i) => String(i.uid))
  }),
  getChatsP: () => chatsP,           // chatsP 是模块私有变量，测试没有句柄可等（LR-03/LR-04/T11/T12）
  buildReplayOrder: impressionGraphBuildReplayOrder,
  cancelReplay: impressionGraphCancelReplay,
  getReplayState: () => ({
    active: impressionGraphReplay.active,
    index: impressionGraphReplay.index,
    total: impressionGraphReplay.total,
    orderLen: impressionGraphReplay.order.length,
    lastCancelReason: impressionGraphReplay.lastCancelReason,
    cancelSeq: impressionGraphReplay.cancelSeq,
    lastStepAt: impressionGraphReplay.lastStepAt,
    completedAt: impressionGraphReplay.completedAt
  })
};
`);
await sleep(400);   // 让 11-init.js 的首屏启动跑起来

// ── 用例隔离工具 ──────────────────────────────────────────────────────────
// Set/Map 要用 realm-agnostic 判型：MEM_UI 建在 jsdom 的 realm 里，
// Node 侧的 `instanceof Set` 会把它当成普通对象。
const clone = (v) => {
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object Set]') return new Set([...v]);
  if (tag === '[object Map]') return new Map(v);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = clone(v[k]);
    return o;
  }
  return v;
};
const SNAPSHOT = clone(window.__MEM_UI);

function resetPages({ chats = undefined } = {}) {
  const M = window.__MEM_UI;
  for (const k of Object.keys(SNAPSHOT)) M[k] = clone(SNAPSHOT[k]);
  delayRules.length = 0;
  stubRules.length = 0;
  requests.length = 0;
  requestLog.length = 0;                 // LR-09：requestLog 随用例隔离，否则 T15 会读到 T2 残留
  if (chats !== undefined) window.__state.chats = chats;
  window.__state.tab = '';
  window.__switchTab('sessions');            // 归位，避免上一条用例的页面留着
}
/** 等待上一笔 /api/chats 在途请求结束（chatsP 是模块私有，只能通过 getChatsP 拿句柄）。 */
async function awaitChatsIdle() {
  const p = window.__mem.getChatsP();
  if (p) await p.catch(() => {});
}
const txt = (sel) => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();

/** 左栏真实双击序列：click → click → dblclick（v1.4 单击只选中）。 */
async function openPersonRow(uid) {
  let row = document.querySelector(`#impression-items [data-uid="${uid}"]`);
  assert.ok(row, `找不到人物行 ${uid}`);
  const before = requests.filter((u) => u.split('?')[0] === `/api/mem2/people/${uid}`).length;
  row.click();
  await sleep(40);
  assert.equal(requests.filter((u) => u.split('?')[0] === `/api/mem2/people/${uid}`).length, before,
    '左栏单击不得请求详情');
  assert.equal(window.__MEM_UI.impression.selectedUserId, uid);
  assert.equal(window.__MEM_UI.impression.graphSelectedKey, `user:${uid}`);
  // 单击期间列表可能被 loadImpressionPeople 重绘：必须重查当前行再双击。
  row = document.querySelector(`#impression-items [data-uid="${uid}"]`);
  assert.ok(row, `双击前人物行消失 ${uid}`);
  row.click();
  row.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  return row;
}

try {
  // ══ T0 夹具自检 ═════════════════════════════════════════════════════════
  await c.check('T0 夹具自检：会话与消息被后端认出来', async () => {
    writeTableFixtures();                      // 幂等，T6 还会再调一次
    const chats = await ctx.request('GET', '/api/chats');
    const keys = (chats.data.chats || []).map((x) => x.chatKey || x.key);
    assert.ok(keys.length >= 2, `夹具会话不足两个：${keys.join(',')}`);
    assert.ok(keys.includes(GRP_A) && keys.includes(GRP_B), `夹具会话不在 /api/chats 里：${keys.join(',')}`);
    const msgs = await ctx.request('GET', `/api/chats/group_${GRP_A_ID}/messages?limit=10`);
    assert.ok((msgs.data.messages || []).length >= 1, '夹具消息没被 /messages 认出来（分片路径或格式错了）');
  });

  // ══ T1 三页可独立打开 ═══════════════════════════════════════════════════
  await c.check('T1 三个顶层页签各自独立，无内部页签', async () => {
    resetPages();
    const TABS = ['mem-impression', 'mem-knowledge', 'mem-summaries'];
    for (const t of TABS) {
      document.querySelector(`.tab[data-tab="${t}"]`).click();
      await sleep(120);
      const active = [...document.querySelectorAll('.view.active')];
      assert.equal(active.length, 1, `点 ${t} 后有 ${active.length} 个 .view.active`);
      assert.equal(active[0].id, `view-${t}`, `点 ${t} 后激活的是 ${active[0].id}`);
      assert.equal(document.querySelectorAll('[data-mem2tab]').length, 0, '页内仍有内部子页签');
      assert.equal(document.querySelectorAll('.tab.active').length, 1, '同时有多个页签高亮');
    }
    assert.equal(document.querySelectorAll('#mem2-page, #mem2-detail').length, 0, '旧容器还在');
    assert.equal(document.querySelector('#impression-backfill'), null, '回填按钮仍在 DOM');
    assert.equal(document.querySelector('#impression-l1-run'), null, '立刻运行按钮仍在 DOM');
  });

  // ══ T6 摘要页 ═══════════════════════════════════════════════════════════
  await c.check('T6 摘要页：chats 晚到 → 自动补表 → 稀疏列 → 空月文案', async () => {
    writeTableFixtures();                            // L4 已由它写入（summary: SM-A / SM-B）
    resetPages({ chats: [] });
    delayRules.push({ match: /^\/api\/chats$/, ms: 700 });
    window.__switchTab('mem-summaries');
    await sleep(100);
    assert.ok(/读取中/.test(txt('#summaries-items')), 'chats 未回时不是加载态');
    assert.ok(!/还没有任何会话数据/.test(txt('#summaries-items')), '把未加载冒充成空态');
    await waitFor(() => /SM-[AB]/.test(txt('#summaries-body')), 8000, '自动加载当月摘要');
    assert.equal(document.querySelector('#summaries-month').value, YM, '月份默认不是当前月');
    assert.ok(/sparse/.test(txt('#summaries-body')), '稀疏标记没渲染');
    assert.ok(document.querySelector('#summaries-items .chat-item.selected'), '没有默认选中第一个会话');

    document.querySelector('#summaries-month').value = OLD_YM;
    document.querySelector('#summaries-month').dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => /这个月没有摘要/.test(txt('#summaries-body')), 6000, '空月文案');
  });

  // ══ T2 印象页主流程 ═════════════════════════════════════════════════════
  const UID_IM = '111';                             // _harness 的 get_group_member_list 对任意群都返回 111 张三
  const E1 = `l1_${UID_IM}_1761000000001_1`;
  const E2 = `l1_${UID_IM}_1761000000002_1`;
  const E3 = `l1_${UID_IM}_1761000000003_1`;

  await c.check('T2 印象页：列表 → 详情/群信息 → 刷新不重建 → 编辑 → 软删/撤销 → 彻底删除 → 审计 → 跳原文（含 D3 找不到提示）', async () => {
    // ── 夹具（写在用例内、切页之前）──
    writePerson(UID_IM, [
      personRow(UID_IM, E1, 'EDIT-ME', ['性格特质'], { sourceMsgIds: [MID], chatKey: GRP_IM, sourceChatKeys: [GRP_IM], sourceBatch: { chatKey: GRP_IM, userId: UID_IM, at: 1761000000000 } }),
      personRow(UID_IM, E2, 'VOID-ME', ['说话风格'], { sourceMsgIds: ['999999'], chatKey: GRP_IM, sourceChatKeys: [GRP_IM], sourceBatch: { chatKey: GRP_IM, userId: UID_IM, at: 1761000000000 } }),
      personRow(UID_IM, E3, 'PURGE-ME', ['关系态度'], { chatKey: GRP_IM, sourceChatKeys: [GRP_IM], sourceBatch: { chatKey: GRP_IM, userId: UID_IM, at: 1761000000000 } })
    ]);
    writeMessages(`group_${GRP_IM_ID}`, [{ id: 1, mid: MID, ts: 1761000000000, senderId: UID_IM, senderName: '张三', text: '原文那句话' }]);

    resetPages({ chats: [] });
    window.__switchTab('mem-impression');
    if (window.__MEM_UI.impression.mode === 'graph') document.querySelector('#impression-graph-toggle').click();
    await waitFor(() => txt('#impression-count').includes('人'), 8000, '人物列表出标题');
    await waitFor(() => txt('#impression-items').includes('张三'), 8000, '人物昵称补齐');
    assert.ok(txt('#impression-items').includes(UID_IM), '人物没进左栏');
    assert.equal(document.querySelectorAll('#impression-items [data-uid]').length, 1, '人物行数不对');

    // v1.4：单击只选中并显示双击提示，不发详情请求
    const rowIm = document.querySelector(`#impression-items [data-uid="${UID_IM}"]`);
    rowIm.click();
    await sleep(60);
    assert.equal(requests.filter((u) => u.split('?')[0] === `/api/mem2/people/${UID_IM}`).length, 0, '单击发了详情请求');
    assert.ok(txt('#impression-body').includes('已选中，双击查看详情'), '单击未显示双击提示');
    assert.equal(window.__MEM_UI.impression.graphSelectedKey, `user:${UID_IM}`);
    // 选中 → 详情（IM-06：头部要有与左栏一致的昵称和群）
    await openPersonRow(UID_IM);
    await waitFor(() => txt('#impression-body').includes('EDIT-ME'), 5000, '详情加载');
    const detailTitle = txt('#impression-body h2');
    assert.ok(detailTitle.includes('张三'), 'D1 未修：详情标题没有昵称');
    assert.ok(!/^QQ\s/.test(detailTitle), 'D1 未修：详情标题退化成 QQ uid');
    assert.ok(txt('#impression-body').includes(String(GRP_IM_ID)), 'D1 未修：详情头部没有群信息');

    // D5：刷新不得重建骨架（同一 DOM 节点保留；真实输入焦点/滚动位置另列人工点验）
    const qBefore = document.querySelector('#impression-q');
    const itemsBefore = document.querySelector('#impression-items');
    qBefore.focus();
    document.querySelector('#impression-refresh').click();
    await waitFor(() => txt('#impression-items').includes('张三'), 5000, '刷新后人物列表');
    assert.equal(document.querySelector('#impression-q'), qBefore, 'D5：刷新重建了搜索框');
    assert.equal(document.querySelector('#impression-items'), itemsBefore, 'D5：刷新重建了左栏');
    await waitFor(() => txt('#impression-body').includes('EDIT-ME'), 5000, '刷新后重取详情');

    // 编辑
    document.querySelector(`[data-entry="${E1}"] [data-edit]`).click();
    await sleep(30);
    document.querySelector(`[data-edit-for="${E1}"]`).value = 'EDITED-OK';
    document.querySelector(`[data-save="${E1}"]`).click();
    await waitFor(() => txt('#impression-body').includes('EDITED-OK'), 5000, '编辑保存后重取详情');

    // 软删 → 撤销
    document.querySelector(`[data-entry="${E2}"] [data-void]`).click();
    await waitFor(() => txt('#impression-body').includes('已删除'), 5000, '软删标记');
    document.querySelector('[data-undo]').click();
    await waitFor(() => !txt('#impression-body').includes('已删除'), 5000, '撤销后标记消失');

    // 彻底删除（两段式）+ 审计增量
    const before = (await ctx.request('GET', '/api/mem2/deletions')).data.count;
    document.querySelector(`[data-entry="${E3}"] [data-purge1]`).click();
    await sleep(30);
    assert.ok(document.querySelector(`[data-purge2="${E3}"]`), '第一段没进入待确认态（不该直接删）');
    assert.equal((await ctx.request('GET', '/api/mem2/deletions')).data.count, before, '第一段就把数据删了：两段式失效');
    document.querySelector(`[data-purge2="${E3}"]`).click();
    await waitFor(() => !txt('#impression-body').includes('PURGE-ME'), 6000, '彻底删除后条目消失');
    await waitFor(() => /删除审计 \d+ 条/.test(txt('#impression-deletion-count')), 4000, '审计计数刷新');
    assert.equal((await ctx.request('GET', '/api/mem2/deletions')).data.count, before + 1, '审计增量不为 1');

    // D3：E2 指向不存在的 mid，必须在存档页给模态提示，不能写回隐藏页
    document.querySelector(`[data-entry="${E2}"] [data-jump]`).click();
    await waitFor(() => document.querySelector('#notice-ok'), 6000, 'D3：找不到原文没有模态提示');
    assert.ok(document.body.textContent.includes('999999'), 'D3：提示没有说明哪条消息');
    assert.ok(!document.querySelector('#view-mem2'), '旧隐藏页容器还在');
    document.querySelector('#notice-ok').click();
    await waitFor(() => !document.querySelector('#notice-ok'), 3000, '关闭提示');

    // 回印象页重新选中，再走 E1 的成功跳转（避免点到 E2 的坏 mid）
    window.__switchTab('mem-impression');
    await waitFor(() => document.querySelector(`#impression-items [data-uid="${UID_IM}"]`), 5000, '回到印象页');
    await openPersonRow(UID_IM);
    await waitFor(() => txt('#impression-body').includes('EDITED-OK'), 5000, '重新选中人物');

    const e1Jump = [...document.querySelectorAll('[data-entry] [data-jump]')]
      .find((btn) => btn.closest('[data-entry]')?.textContent.includes('EDITED-OK'));
    assert.ok(e1Jump, '找不到 E1 的跳原文按钮');
    e1Jump.click();
    await waitFor(() => window.__state.tab === 'chats', 5000, '跳到存档页');
    await waitFor(() => document.querySelector(`#chat-detail tr[data-mid="${MID}"]`), 6000, '消息行定位');
  });

  // ══ T3 印象页竞态 ═══════════════════════════════════════════════════════
  await c.check('T3 印象页竞态：后点的赢，旧响应不回写', async () => {
    const UID_A = '9910000000011';   // 内容 'SLOW-A'
    const UID_B = '9910000000012';   // 内容 'FAST-B'
    // 本组自备人物，不依赖 T2 的 111；必须在 resetPages 之前落盘
    writePerson(UID_A, [personRow(UID_A, `l1_${UID_A}_1761000000011_1`, 'SLOW-A', ['性格特质'])]);
    writePerson(UID_B, [personRow(UID_B, `l1_${UID_B}_1761000000012_1`, 'FAST-B', ['说话风格'])]);
    resetPages({ chats: [] });
    delayRules.push({ match: new RegExp(`^/api/mem2/people/${UID_A}$`), ms: 800, once: true });
    window.__switchTab('mem-impression');
    await waitFor(() => document.querySelector(`#impression-items [data-uid="${UID_A}"]`), 8000, 'A 进列表');
    await openPersonRow(UID_A);
    await sleep(60);
    await openPersonRow(UID_B);
    await waitFor(() => txt('#impression-body').includes('FAST-B'), 5000, 'B 先到');
    await sleep(1000);                                    // 等 A 的迟到响应落地（负面事件，只能固定等）
    assert.ok(txt('#impression-body').includes('FAST-B'), 'A 的迟到响应覆盖了 B');
    assert.ok(!txt('#impression-body').includes('SLOW-A'), '右栏出现 A 的内容');
    assert.equal(window.__MEM_UI.impression.selectedUserId, UID_B, '选中项被旧响应改回 A');
  });

  // ══ T5 知识页 ═══════════════════════════════════════════════════════════
  await c.check('T5 知识页：空态 / 卡片 / 刷新竞态 / 错误态', async () => {
    resetPages({ chats: [] });
    window.__switchTab('mem-knowledge');
    // 真实 listKnowledge() 恒空；空态文案取后端 note 里的稳定子串
    await waitFor(() => txt('#knowledge-body').includes('空是正确状态'), 5000, '空态 note');

    // 有数据卡片：必须 once，否则后面的竞态第一笔不会真正发出去
    stubRules.push({ match: /^\/api\/mem2\/knowledge$/, once: true, body: { entries: [{ content: 'K-ONE', domain: 'd1', term: 't1' }], note: '' } });
    document.querySelector('#knowledge-refresh').click();
    await waitFor(() => txt('#knowledge-body').includes('K-ONE'), 5000, '有数据卡片');
    assert.ok(txt('#knowledge-body').includes('d1 · t1'), 'domain/term 没显示');
    assert.equal(document.querySelectorAll('#knowledge-items .chat-item.selected').length, 1, '左栏不是唯一选中行');

    // D6：第一笔在途时再刷新，第二笔必须真正发出并最终赢；早退会让页面回到空态
    delayRules.push({ match: /^\/api\/mem2\/knowledge$/, ms: 800, once: true });
    document.querySelector('#knowledge-refresh').click();
    await sleep(50);
    stubRules.push({ match: /^\/api\/mem2\/knowledge$/, once: true, body: { entries: [{ content: 'K-RACE', domain: 'd2', term: 't2' }], note: '' } });
    document.querySelector('#knowledge-refresh').click();
    await waitFor(() => txt('#knowledge-body').includes('K-RACE'), 5000, '第二笔刷新结果');
    await sleep(1000);                                    // 等第一笔（慢 800ms）落地
    assert.ok(txt('#knowledge-body').includes('K-RACE'), 'D6：旧请求晚到覆盖了本次刷新');
    assert.ok(!txt('#knowledge-body').includes('空是正确状态'), 'D6：刷新被早退吃掉，页面回到空态');

    // 错误态：必须 once，且不能被当成空态
    stubRules.push({ match: /^\/api\/mem2\/knowledge$/, once: true, status: 500, body: { error: 'KN-BOOM' } });
    document.querySelector('#knowledge-refresh').click();
    await waitFor(() => txt('#knowledge-body').includes('KN-BOOM'), 5000, '错误态显示具体错误');
    assert.ok(!txt('#knowledge-body').includes('空是正确状态'), '把错误伪装成空态');
  });

  // ══ T7 跨页保护 ═════════════════════════════════════════════════════════
  await c.check('T7 跨页：摘要页慢请求迟到，不改写知识页；切回仍正确', async () => {
    resetPages({ chats: [] });
    delayRules.push({ match: /^\/api\/mem2\/l4$/, ms: 900, once: true });   // 只拖切走那一笔；切回时不能再慢
    window.__switchTab('mem-summaries');
    await waitFor(() => requests.some((u) => u.startsWith('/api/mem2/l4')), 8000, '摘要表请求已发出');
    window.__switchTab('mem-knowledge');
    // 必须等知识页自己的请求落地；不能把「读取中…」当成稳定内容
    await waitFor(() => txt('#knowledge-body').includes('空是正确状态'), 5000, '知识页空态落地');
    const knowledgeBefore = txt('#knowledge-body');
    await sleep(1200);                                            // 等摘要页迟到响应落地
    assert.equal(txt('#knowledge-body'), knowledgeBefore, '摘要页的迟到响应改写了知识页');
    assert.equal(document.querySelector('#view-mem-knowledge').classList.contains('active'), true, '视图被抢切');

    window.__switchTab('mem-summaries');
    await sleep(200);
    assert.ok(document.querySelector('#summaries-items [data-chatkey]'), '切回摘要页后会话列表丢了');
    assert.ok(!/读取中/.test(txt('#summaries-body')), '切回摘要页后表格仍是加载态');
  });

  // ══ T8 旧实现清理 ═══════════════════════════════════════════════════════
  await c.check('T8 运行时不存在旧容器 / 旧属性 / 旧状态', async () => {
    assert.equal(document.querySelectorAll('#mem2-page, #mem2-detail, #mem2-list-items').length, 0, '旧容器还在 DOM 里');
    assert.equal(document.querySelectorAll('[data-mem2tab], [data-mem2chat], [data-mem2all]').length, 0, '旧 data 属性还在');
    assert.equal(typeof window.__MEM_UI.impression, 'object', 'MEM_UI.impression 不存在');
    assert.equal('tab' in window.__MEM_UI, false, 'MEM_UI 上仍有共享 tab 字段');
  });

  // ════════════════════════════════════════════════════════════════════════
  // 以下 T9~T17 是「记忆四独立页遗留修复单」阶段 1/4 新增的用例。
  // 执行顺序：T9/T10/T11/T12/T13 会新增会话或污染 state.chats，必须排在
  // T6（依赖「默认选中第一个会话」）之后；每条开头各自 resetPages() 隔离。
  // ════════════════════════════════════════════════════════════════════════

  // ── T9/T10 专用夹具：两套唯一群，避免命中 store 内存缓存（LR-01/LR-02） ──
  const A2 = 'group:3300000000010';   // 摘要竞态 A 群
  const A2_ID = '3300000000010';
  const B2 = 'group:3300000000011';   // 摘要竞态 B 群
  const B2_ID = '3300000000011';
  const C2 = 'group:3300000000012';   // T10 空列表回落专用的第三群
  const C2_ID = '3300000000012';
  function writeRaceFixtures() {
    // 当月 + 旧月两套夹具；OLD 月份各有可识别标记（只写 B 不够，A 空结果无法证明「覆盖」）
    writeL4(A2_ID, YM, [{ convStartTs: 1761001000000, summary: 'SM-A2', sparse: true }]);
    writeL4(B2_ID, YM, [{ convStartTs: 1761001100000, summary: 'SM-B2', sparse: true }]);
    writeL4(A2_ID, OLD_YM, [{ convStartTs: 1709000000000, summary: 'SM-A2-OLD', sparse: true }]);
    writeL4(B2_ID, OLD_YM, [{ convStartTs: 1709000100000, summary: 'SM-B2-OLD', sparse: true }]);
    writeMessages(`group_${A2_ID}`, [{ id: 1, mid: '711001', ts: 1761001000000, senderId: '993', senderName: '丙', text: 'A2 消息' }]);
    writeMessages(`group_${B2_ID}`, [{ id: 1, mid: '711002', ts: 1761001100000, senderId: '994', senderName: '丁', text: 'B2 消息' }]);
  }

  // ══ T9 表格缓存竞态（LR-01，修复前必红）═════════════════════════════════
  // 摘要页一套 + 旧月份变体。
  await c.check('T9 摘要页缓存竞态：A 在途 → 切到已缓存 B → A 迟到不覆盖 B', async () => {
    writeRaceFixtures();
    resetPages({ chats: [{ chatKey: B2 }, { chatKey: A2 }] });
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 8000, 'B 当月摘要落地（进 cache）');

    delayRules.push({ match: /^\/api\/mem2\/l4$/, ms: 800, once: true });
    document.querySelector(`#summaries-items [data-chatkey="${A2}"]`).click();
    await sleep(60);
    document.querySelector(`#summaries-items [data-chatkey="${B2}"]`).click();
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 4000, 'B 命中缓存立即渲染');
    await sleep(1000);
    assert.ok(txt('#summaries-body').includes('SM-B2'), 'A 的迟到响应覆盖了 B 的摘要');
    assert.ok(!txt('#summaries-body').includes('SM-A2'), '摘要里出现了 A 的内容');
    assert.ok(document.querySelector(`#summaries-items [data-chatkey="${B2}"]`).classList.contains('selected'),
      '摘要选中态被 A 的迟到响应改走');
  });

  await c.check('T9 摘要页旧月份竞态：A/OLD 在途 → 切回已缓存 B/OLD → 不覆盖', async () => {
    writeRaceFixtures();
    resetPages({ chats: [{ chatKey: B2 }, { chatKey: A2 }] });
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 8000, 'B 当月落地');
    document.querySelector('#summaries-month').value = OLD_YM;
    document.querySelector('#summaries-month').dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => txt('#summaries-body').includes('SM-B2-OLD'), 8000, 'B/OLD 落地进 cache');

    delayRules.push({ match: /^\/api\/mem2\/l4$/, ms: 800, once: true });
    document.querySelector(`#summaries-items [data-chatkey="${A2}"]`).click();
    await sleep(60);
    document.querySelector(`#summaries-items [data-chatkey="${B2}"]`).click();
    await waitFor(() => txt('#summaries-body').includes('SM-B2-OLD'), 4000, 'B/OLD 命中缓存');
    await sleep(1000);
    assert.ok(txt('#summaries-body').includes('SM-B2-OLD'), 'A/OLD 迟到响应覆盖了 B/OLD');
    assert.ok(!txt('#summaries-body').includes('SM-A2-OLD'), '出现 A 的旧月份摘要');
  });

  // ══ T10 会话失效回落（LR-02，修复前必红）════════════════════════════════
  // 三组子场景：旧 data 复用 / A 请求在途且 B 缓存命中 / 列表为空回落；
  // 摘要一套。A 落地后不得 resetPages()（会把准备好的 chat/data 清掉）。
  await c.check('T10 摘要页：选中会话失效后旧 data 不得复用', async () => {
    writeRaceFixtures();
    resetPages({ chats: [{ chatKey: A2 }, { chatKey: B2 }] });
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-A2'), 8000, 'A 摘要落地');
    window.__state.chats = [{ chatKey: B2 }];
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 8000, '回落 B 后摘要');
    assert.ok(txt('#summaries-body').includes('SM-B2'), '旧 A 摘要被复用');
    assert.ok(!txt('#summaries-body').includes('SM-A2'), '旧 A 摘要泄漏');
    assert.ok(document.querySelector(`#summaries-items [data-chatkey="${B2}"]`).classList.contains('selected'),
      '选中未回落到 B');
  });

  await c.check('T10 摘要页：A 请求在途 → 列表只剩 B → 回落 B（缓存命中）→ A 迟到不回写', async () => {
    writeRaceFixtures();
    resetPages({ chats: [{ chatKey: B2 }, { chatKey: A2 }] });
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 8000, 'B 落地进 cache');

    delayRules.push({ match: /^\/api\/mem2\/l4$/, ms: 800, once: true });
    document.querySelector(`#summaries-items [data-chatkey="${A2}"]`).click();
    await sleep(60);

    window.__state.chats = [{ chatKey: B2 }];
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 4000, '回落 B 命中缓存');
    await sleep(1000);
    assert.ok(txt('#summaries-body').includes('SM-B2'), 'A 迟到响应覆盖了 B');
    assert.ok(!txt('#summaries-body').includes('SM-A2'), 'A 摘要泄漏');
    assert.equal(window.__MEM_UI.summaries.chat, B2, '选中未回落到 B');
  });

  await c.check('T10 摘要页：列表为空回落，旧 A 迟到不得写回；恢复后重选 B 只有 B', async () => {
    writeRaceFixtures();
    resetPages({ chats: [{ chatKey: B2 }, { chatKey: A2 }] });
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 8000, 'B 落地');

    delayRules.push({ match: /^\/api\/mem2\/l4$/, ms: 800, once: true });
    document.querySelector(`#summaries-items [data-chatkey="${A2}"]`).click();
    await sleep(60);

    window.__state.chats = [];
    stubRules.push({ match: /^\/api\/chats$/, once: true, body: { chats: [] } });
    window.__switchTab('mem-summaries');
    await waitFor(() => /还没有任何会话数据/.test(txt('#summaries-items')), 6000, '空列表回落');
    assert.equal(window.__MEM_UI.summaries.chat, '', '空列表时 st.chat 未清空');
    assert.equal(window.__MEM_UI.summaries.loading, false, '空列表时 loading 未复位');
    assert.ok(!/读取中/.test(txt('#summaries-body')), '空列表回落仍显示读取中');
    await sleep(1000);
    assert.equal(window.__MEM_UI.summaries.data, null, 'A 迟到响应在空列表后写回了 data');

    window.__state.chats = [{ chatKey: B2 }];
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 8000, '重选 B 后摘要');
    assert.ok(txt('#summaries-body').includes('SM-B2'), '重选 B 后没显示 B');
    assert.ok(!txt('#summaries-body').includes('SM-A2'), '重选 B 后出现 A 的旧数据');
  });

  // T10 的 refresh 分支（LR-02）：无 chat 时 success-empty / failed 都要复位 loading
  await c.check('T10 摘要页 refresh 无 chat：success-empty 与 failed 都要复位 loading', async () => {
    writeRaceFixtures();
    await awaitChatsIdle();
    resetPages({ chats: [] });
    stubRules.push({ match: /^\/api\/chats$/, once: true, body: { chats: [] } });
    window.__switchTab('mem-summaries');
    await waitFor(() => /还没有任何会话数据/.test(txt('#summaries-items')), 6000, 'success-empty 空态落地');
    assert.equal(window.__MEM_UI.summaries.chat, '', 'success-empty 时 chat 应为空');
    window.__MEM_UI.summaries.loading = true;
    // ★ 与摘要页同构：页面加载已消费第一条 once 桩，refresh 的第二次 /api/chats 必须重新打空桩。
    stubRules.push({ match: /^\/api\/chats$/, once: true, body: { chats: [] } });
    document.querySelector('#summaries-refresh').click();
    await waitFor(() => window.__MEM_UI.summaries.loading === false, 6000, 'refresh success-empty 复位 loading');
    assert.ok(!/读取中/.test(txt('#summaries-body')), 'success-empty 仍显示读取中');
    assert.equal(window.__MEM_UI.summaries.chat, '', 'refresh success-empty 选中了会话');
    assert.equal((window.__state.chats || []).length, 0, 'refresh success-empty 后 state.chats 不为空');
    assert.ok(!requests.some((p) => p.startsWith('/api/mem2/l4')), 'refresh success-empty 仍请求了表格');
    assert.ok(requests.filter((p) => p === '/api/chats').length >= 2, 'refresh 未重新请求 /api/chats');

    await awaitChatsIdle();
    resetPages({ chats: [] });
    stubRules.push({ match: /^\/api\/chats$/, once: true, body: { chats: [] } });
    window.__switchTab('mem-summaries');
    await waitFor(() => /还没有任何会话数据/.test(txt('#summaries-items')), 6000, 'failed 前成功进入空态');
    assert.equal(window.__MEM_UI.summaries.chat, '', 'failed 场景 chat 应为空');
    window.__MEM_UI.summaries.loading = true;
    stubRules.push({ match: /^\/api\/chats$/, once: true, status: 500, body: { error: 'BOOM' } });
    document.querySelector('#summaries-refresh').click();
    await waitFor(() => window.__MEM_UI.summaries.loading === false, 6000, 'refresh failed 复位 loading');
    assert.ok(/读取会话列表失败/.test(txt('#summaries-items')), 'failed 未显示具体错误');
    assert.ok(!/读取中/.test(txt('#summaries-body')), 'failed 仍显示读取中');
  });

  // ══ T13 删除审计旧响应（LR-06 / C4 真竞态证据）════════════════════════
  // 用可延迟 stub 的 count 1/2：第一条慢（count 1）在途时，第二条（count 2）先落地，
  // 迟到的 count 1 不得把顶栏打回 1。
  await c.check('T13 删除审计旧响应：迟到 count=1 不覆盖已落地的 count=2', async () => {
    await awaitChatsIdle();
    resetPages({ chats: [] });
    // 第一条：count 1，慢 800ms，once；第二条：count 2，即时，once
    stubRules.push({ match: /^\/api\/mem2\/deletions$/, body: { count: 1 }, ms: 800, once: true });
    stubRules.push({ match: /^\/api\/mem2\/deletions$/, body: { count: 2 }, once: true });
    window.__switchTab('mem-impression');          // 进入即触发 loadImpressionDeletionCount（慢的 count 1）
    await sleep(50);
    window.__mem.loadImpressionDeletionCount();    // 第二条 count 2 先落地
    await waitFor(() => /删除审计 2 条/.test(txt('#impression-deletion-count')), 4000, 'count 2 落地');
    await sleep(1000);                             // 等 count 1 迟到
    assert.equal(txt('#impression-deletion-count'), '删除审计 2 条', '迟到的 count=1 覆盖了 count=2');
    assert.equal(window.__MEM_UI.impression.deletionCount, 2, 'deletionCount 被打回 1');
  });

  // ══ T11 群下拉并集（LR-03，修复前必红）══════════════════════════════════
  // 某群只存在于 /api/mem2/people 的 basePeople[].chatKeys，不在 /api/chats；
  // 且 /api/chats 先返回空、people 后返回。首屏 q 空/非空都要补出该群。
  const GRP_ONLY = 'group:3300000000013';
  const UID_ONLY = '3300000000013';
  function writeChatsOnlyPerson() {
    // chatKey 与 sourceChatKeys 都指向唯一群，不与 T0/T2 的会话混在一起
    writePerson(UID_ONLY, [{
      entryId: `l1_${UID_ONLY}_1_1`, userId: UID_ONLY, chatKey: GRP_ONLY, sourceChatKeys: [GRP_ONLY],
      sourceBatch: { chatKey: GRP_ONLY, userId: UID_ONLY, at: 1761002000000 },
      content: 'ONLY-GROUP', groups: ['性格特质'], status: 'active',
      createdAt: 1761002000000, updatedAt: 1761002000000
    }]);
  }
  await c.check('T11 首屏 q 空：人物侧的群必须补进下拉（chats 空、people 后到）', async () => {
    writeChatsOnlyPerson();
    await awaitChatsIdle();
    resetPages({ chats: [] });
    // /api/chats 即时返回空；/api/mem2/people 挂延迟，保证 chats 先、people 后
    stubRules.push({ match: /^\/api\/chats$/, once: true, body: { chats: [] } });
    delayRules.push({ match: /^\/api\/mem2\/people/, ms: 400 });
    window.__switchTab('mem-impression');
    // 等 people 真正落地（不能只等 option 数量——那会被上一轮用例的陈旧 DOM 满足）
    await waitFor(() => window.__MEM_UI.impression.basePeople.some((p) => String(p.userId) === UID_ONLY), 8000, 'people 落地');
    await waitFor(() => [...document.querySelectorAll('#impression-chat option')].some((o) => o.value === GRP_ONLY), 4000, '群补进下拉');
    const opts = [...document.querySelectorAll('#impression-chat option')].map((o) => o.value);
    assert.ok(opts.includes(GRP_ONLY), `人物侧群 ${GRP_ONLY} 没进下拉：${opts.join(',')}`);
  });

  await c.check('T11 首屏 q 非空且不匹配该人物：群仍必须补进下拉', async () => {
    writeChatsOnlyPerson();
    await awaitChatsIdle();
    resetPages({ chats: [] });
    // 进入前把 q 设为不匹配该人物、清空 chatOptions（不能用上一轮空 q 的残留群冒充）
    window.__MEM_UI.impression.q = '完全不匹配的搜索词';
    window.__MEM_UI.impression.chatOptions = [];
    stubRules.push({ match: /^\/api\/chats$/, once: true, body: { chats: [] } });
    delayRules.push({ match: /^\/api\/mem2\/people/, ms: 400 });
    window.__switchTab('mem-impression');
    await waitFor(() => window.__MEM_UI.impression.basePeople.some((p) => String(p.userId) === UID_ONLY), 8000, 'people 落地');
    await waitFor(() => [...document.querySelectorAll('#impression-chat option')].some((o) => o.value === GRP_ONLY), 4000, '群补进下拉');
    const opts = [...document.querySelectorAll('#impression-chat option')].map((o) => o.value);
    assert.ok(opts.includes(GRP_ONLY), `q 非空时人物侧群 ${GRP_ONLY} 漏了：${opts.join(',')}`);
    // 确认 basePeople 含该人物、people 已过滤掉它（否则没真正打到过滤盲点）
    assert.ok(window.__MEM_UI.impression.basePeople.some((p) => String(p.userId) === UID_ONLY), 'basePeople 没有该人物');
    assert.ok(!window.__MEM_UI.impression.people.some((p) => String(p.userId) === UID_ONLY), 'people 没把该人物过滤掉');
    window.__MEM_UI.impression.q = '';
  });

  await c.check('T11 切换群筛选后刷新，旧群不消失（只增不减）', async () => {
    writeChatsOnlyPerson();
    await awaitChatsIdle();
    resetPages({ chats: [] });
    stubRules.push({ match: /^\/api\/chats$/, once: true, body: { chats: [] } });
    window.__switchTab('mem-impression');
    await waitFor(() => window.__MEM_UI.impression.basePeople.some((p) => String(p.userId) === UID_ONLY), 8000, 'people 落地');
    await waitFor(() => [...document.querySelectorAll('#impression-chat option')].some((o) => o.value === GRP_ONLY), 4000, '群补进下拉');
    // 切到该群再切回全部，再刷新，群仍应在
    document.querySelector('#impression-chat').value = GRP_ONLY;
    document.querySelector('#impression-chat').dispatchEvent(new window.Event('change', { bubbles: true }));
    await sleep(300);
    document.querySelector('#impression-chat').value = '';
    document.querySelector('#impression-chat').dispatchEvent(new window.Event('change', { bubbles: true }));
    await sleep(300);
    document.querySelector('#impression-refresh').click();
    await waitFor(() => [...document.querySelectorAll('#impression-chat option')].some((o) => o.value === GRP_ONLY), 8000, '刷新后群仍在');
    const opts = [...document.querySelectorAll('#impression-chat option')].map((o) => o.value);
    assert.ok(opts.includes(GRP_ONLY), `刷新后 ${GRP_ONLY} 从下拉消失了：${opts.join(',')}`);
  });

  // ══ T12 印象页 chats 错误态（LR-04，修复前必红）════════════════════════
  await c.check('T12-A 印象页：chats 失败可见 → 刷新成功清除（不依赖人物加载时序）', async () => {
    await awaitChatsIdle();
    resetPages({ chats: [] });
    // 第一次 /api/chats 返回 500（once），第二次（刷新）走真实端点成功
    stubRules.push({ match: /^\/api\/chats$/, once: true, status: 500, body: { error: 'CHAT-BOOM' } });
    window.__switchTab('mem-impression');
    await waitFor(() => /读取会话列表失败/.test(txt('#impression-body')), 6000, 'chats 失败显示具体错误');

    // 刷新（真实 /api/chats 成功），错误应立即消失
    document.querySelector('#impression-refresh').click();
    await waitFor(() => !/读取会话列表失败/.test(txt('#impression-body')), 6000, '刷新成功后错误清除');
    assert.equal(window.__MEM_UI.impression.chatsError, '', 'chatsError 未被清空');
  });

  await c.check('T12-B 印象页：刷新失败必须可见（从成功态起手，不是静默）', async () => {
    await awaitChatsIdle();
    resetPages({ chats: [] });
    // 先成功进入（真实 /api/chats 成功），确认无错误块
    window.__switchTab('mem-impression');
    await waitFor(() => txt('#impression-count').includes('人'), 8000, '成功进入人物列表');
    assert.ok(!/读取会话列表失败/.test(txt('#impression-body')), '成功态残留错误');
    assert.equal(window.__MEM_UI.impression.chatsError, '', '成功态 chatsError 非空');

    // ★ 先等上一笔 chatsP 结束，再清空 state.chats —— 顺序反了会被在途请求重新填满
    await awaitChatsIdle();
    window.__state.chats = [];
    stubRules.push({ match: /^\/api\/chats$/, once: true, status: 500, body: { error: 'CHAT-BOOM' } });
    document.querySelector('#impression-refresh').click();
    await waitFor(() => /读取会话列表失败/.test(txt('#impression-body')), 6000, '刷新失败显示具体错误');
    assert.ok(!/读取中/.test(txt('#impression-body')), '刷新失败卡在读取中');
  });

  // ══ T17-chats（LR-05，修复前必红）═══════════════════════════════════════
  // 旧 chat + state.chats 为空 + /api/chats 失败：摘要页不得显示「读取中…」，
  // 必须显示 chats 错误，且清空旧 chat/data/seq。
  await c.check('T17-chats 摘要页：旧 chat + 空 state.chats + chats 失败 → 显示错误而非读取中', async () => {
    writeRaceFixtures();
    await awaitChatsIdle();
    resetPages({ chats: [] });
    window.__MEM_UI.summaries.chat = A2;
    window.__MEM_UI.summaries.data = null;
    stubRules.push({ match: /^\/api\/chats$/, once: true, status: 500, body: { error: 'CHAT-BOOM' } });
    window.__switchTab('mem-summaries');
    await waitFor(() => /读取会话列表失败/.test(txt('#summaries-body')), 6000, 'chats 失败显示错误');
    assert.ok(!/读取中/.test(txt('#summaries-body')), '旧 chat 伪装成读取中（LR-05 未修）');
    assert.equal(window.__MEM_UI.summaries.chat, '', '旧 chat 未被清空');
    assert.equal(window.__MEM_UI.summaries.data, null, '旧 data 未被清空');

    // 第二段：旧 chat 的表格请求在途时 chats 失败，迟到响应不得把 data 写回（施工单 §3 验收）
    window.__MEM_UI.summaries.chat = A2;
    window.__MEM_UI.summaries.data = null;
    window.__MEM_UI.summaries.ym = YM;
    delayRules.push({ match: /^\/api\/mem2\/l4$/, ms: 800, once: true });
    window.__mem.loadSummariesTable();
    await sleep(50);                                  // 确保表格请求已发出
    assert.ok(requests.some((p) => p.startsWith('/api/mem2/l4')), '在途用例未发出表格请求');
    assert.equal(delayRules.length, 0, '表格延迟规则未命中（请求没发出）');
    stubRules.push({ match: /^\/api\/chats$/, once: true, status: 500, body: { error: 'CHAT-BOOM-2' } });
    window.__switchTab('mem-summaries');
    await waitFor(() => /读取会话列表失败/.test(txt('#summaries-body')), 6000, '在途场景 chats 失败显示错误');
    await sleep(1100);                                // 等迟到的表格响应落地
    assert.equal(window.__MEM_UI.summaries.data, null, '在途表格迟到后把 data 写回');
    assert.ok(!/读取中/.test(txt('#summaries-body')), '在途表格迟到后出现读取中');
    assert.ok(!txt('#summaries-body').includes('SM-A2'), '在途表格迟到后覆盖了错误态');
  });

  // ══ T14 印象页 B1/B3/B6（LR-08，把「代码 + T2」改成运行证据）══════════
  const UID_B3 = '3300000000014';
  function writeProfileFixture(uid, { dirty = false } = {}) {
    // B3：只写 people/<uid>.jsonl 不产生画像，必须显式写 profile.json
    const dir = path.join(dataDir, 'mem2', 'people');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${uid}.profile.json`), JSON.stringify({
      builtAt: 1761003000000, model: 'test-model',
      slots: [
        { dim: '说话风格', content: '直接', chars: 2, sourceEntryIds: ['e1'] },
        { dim: '性格特质', content: '爱猫', chars: 2, sourceEntryIds: ['e2'] }
      ],
      // dirty 用错 digest：与当前 active 的 digest 必然不一致
      sourceDigest: dirty ? 'sha1:wrong' : 'sha1:0000000000000000000000000000000000000000'
    }), 'utf8');
  }

  await c.check('T14 B3 画像：profile.json 驱动 slots/dirty；四种标记；历史版本开关', async () => {
    const UID = UID_B3;
    const E1 = `l1_${UID}_1761003000001_1`;
    const E2 = `l1_${UID}_1761003000002_1`;
    const E3 = `l1_${UID}_1761003000003_1`;
    // 四种标记各一条：pinned / void / superseded / editedFrom
    writePerson(UID, [
      personRow(UID, E1, 'PINNED-ENTRY', ['性格特质'], { pinnedByUser: true }),
      personRow(UID, E2, 'VOID-ENTRY', ['说话风格'], { status: 'void' }),
      personRow(UID, E3, 'SUPERSEDED-ENTRY', ['兴趣身份'], { status: 'superseded' }),
      personRow(UID, E3 + '_new', 'EDITED-FROM-ENTRY', ['兴趣身份'], { editedFrom: E3 })
    ]);
    writeProfileFixture(UID, { dirty: true });

    await awaitChatsIdle();
    resetPages({ chats: [] });
    window.__switchTab('mem-impression');
    await waitFor(() => document.querySelector(`#impression-items [data-uid="${UID}"]`), 8000, 'B3 人物进列表');
    await openPersonRow(UID);
    await waitFor(() => txt('#impression-body').includes('PINNED-ENTRY'), 5000, '详情加载');

    // 画像 slots + dirty（dirty 用错 digest，必然 dirty）
    assert.ok(/注入画像 \d+\/8 条/.test(txt('#impression-body')), '画像标题没渲染 slots 计数');
    assert.ok(txt('#impression-body').includes('直接'), '画像槽内容没显示');
    assert.ok(txt('#impression-body').includes('已过期'), 'dirty 未标「已过期」');
    assert.ok(txt('#impression-body').includes('已编辑'), 'pinnedByUser 的「已编辑」标记没显示');
    assert.ok(txt('#impression-body').includes('已删除'), 'void 的「已删除」标记没显示');

    // 历史版本开关：默认隐藏 superseded；切换后显示，再切回隐藏
    assert.ok(!txt('#impression-body').includes('SUPERSEDED-ENTRY'), '默认显示了 superseded 条目');
    document.querySelector('[data-showall]').click();
    await waitFor(() => txt('#impression-body').includes('SUPERSEDED-ENTRY'), 5000, '含历史版本后显示 superseded');
    assert.ok(/只看有效/.test(txt('#impression-body')), '切换后按钮文案没变');
    document.querySelector('[data-showall]').click();
    await waitFor(() => !txt('#impression-body').includes('SUPERSEDED-ENTRY'), 5000, '切回隐藏 superseded');
  });

  await c.check('T14 B6 删除审计零值隐藏 / 非零显示（仅印象页）', async () => {
    await awaitChatsIdle();
    resetPages({ chats: [] });
    // ★ 顺序：先 resetPages（清空 stubRules），再压 count:0 stub
    stubRules.push({ match: /^\/api\/mem2\/deletions$/, body: { count: 0 } });
    window.__switchTab('mem-impression');
    await waitFor(() => document.querySelector('#impression-deletion-count')?.hidden === true, 5000, '零值隐藏');
    assert.equal(window.__MEM_UI.impression.deletionCount, 0, '零值未落到状态');

    // 非零：count 1
    await awaitChatsIdle();
    resetPages({ chats: [] });
    stubRules.push({ match: /^\/api\/mem2\/deletions$/, body: { count: 1 } });
    window.__switchTab('mem-impression');
    await waitFor(() => /删除审计 1 条/.test(txt('#impression-deletion-count')), 5000, '非零显示');
    assert.equal(document.querySelector('#impression-deletion-count').hidden, false, '非零不该隐藏');

    // 仅印象页：其他三页 section 内不存在该计数节点
    for (const t of ['mem-knowledge', 'mem-summaries']) {
      document.querySelector(`.tab[data-tab="${t}"]`).click();
      await sleep(100);
      const view = document.querySelector(`#view-${t}`);
      assert.equal(view.querySelectorAll('#impression-deletion-count').length, 0, `${t} 页泄漏了删除审计计数`);
    }
  });

  await c.check('T14 B1 群筛选 / 搜索防抖 / 人物行三段信息', async () => {
    const UID = '111';   // _harness 对任意群都返回 111 张三 / 113 王五
    await awaitChatsIdle();
    resetPages({ chats: [] });
    window.__switchTab('mem-impression');
    await waitFor(() => txt('#impression-count').includes('人'), 8000, '人物列表落地');
    await waitFor(() => txt('#impression-items').includes('张三'), 8000, '昵称补齐');   // 身份补全是异步的

    // 人物行三段信息：昵称 + 群/私聊 + QQ uid（不能只剩 QQ <uid>）
    const row = txt('#impression-items [data-uid="111"]');
    assert.ok(row.includes('张三'), '人物行没有昵称（三段信息缺失）');
    assert.ok(row.includes('111'), '人物行没有 QQ uid');

    // 搜索防抖：输入后 250ms 内不应立即发请求
    const before = requests.filter((u) => u.startsWith('/api/mem2/people')).length;
    document.querySelector('#impression-q').value = '张三';
    document.querySelector('#impression-q').dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(100);   // 100ms < 250ms 防抖窗口
    const mid = requests.filter((u) => u.startsWith('/api/mem2/people')).length;
    assert.equal(mid, before, '搜索在 250ms 防抖窗口内就发了请求');
    await waitFor(() => requests.filter((u) => u.startsWith('/api/mem2/people')).length > before, 3000, '防抖后发请求');
    // q 值会被 encodeURIComponent 编码，断言 q 参数非空即可（不能比明文中文）
    assert.ok(requests.some((u) => /q=[^&]*\S/.test(u) || /q=%/.test(u)), '搜索请求没带 q 参数');
    // 清空恢复
    document.querySelector('#impression-q').value = '';
    document.querySelector('#impression-q').dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(400);   // 等防抖 timer 落地（避免污染下一条）
  });

  // ══ T15 请求体与写操作（LR-09，requestLog 直接断言 body）═══════════════
  await c.check('T15 写操作请求体：编辑/软删/撤销/彻底删除 body 严格正确', async () => {
    const UID = '3300000000015';
    const E1 = `l1_${UID}_1761004000001_1`;
    const E2 = `l1_${UID}_1761004000002_1`;
    const E3 = `l1_${UID}_1761004000003_1`;
    writePerson(UID, [
      personRow(UID, E1, 'EDIT-TARGET', ['性格特质']),
      personRow(UID, E2, 'VOID-TARGET', ['说话风格']),
      personRow(UID, E3, 'PURGE-TARGET', ['关系态度'])
    ]);

    await awaitChatsIdle();
    resetPages({ chats: [] });
    window.__switchTab('mem-impression');
    await waitFor(() => document.querySelector(`#impression-items [data-uid="${UID}"]`), 8000, 'T15 人物进列表');
    await openPersonRow(UID);
    await waitFor(() => txt('#impression-body').includes('EDIT-TARGET'), 5000, '详情加载');

    // 编辑
    document.querySelector(`[data-entry="${E1}"] [data-edit]`).click();
    await sleep(30);
    document.querySelector(`[data-edit-for="${E1}"]`).value = 'EDITED-OK';
    document.querySelector(`[data-save="${E1}"]`).click();
    await waitFor(() => txt('#impression-body').includes('EDITED-OK'), 5000, '编辑保存');
    const editReq = requestLog.find((r) => r.method === 'PATCH' && r.path.startsWith(`/api/mem2/entries/${E1}`));
    assert.ok(editReq, '没记录到 PATCH 请求');
    assert.deepEqual(JSON.parse(editReq.body), { content: 'EDITED-OK' }, '编辑 body 不是只含 content');

    // 软删
    document.querySelector(`[data-entry="${E2}"] [data-void]`).click();
    await waitFor(() => txt('#impression-body').includes('已删除'), 5000, '软删');
    const voidReq = requestLog.find((r) => r.method === 'POST' && r.path.startsWith(`/api/mem2/entries/${E2}/void`));
    assert.ok(voidReq, '没记录到 void 请求');
    assert.deepEqual(JSON.parse(voidReq.body), {}, '软删 body 应为 {}');

    // 撤销
    document.querySelector('[data-undo]').click();
    await waitFor(() => !txt('#impression-body').includes('已删除'), 5000, '撤销');
    const undoReq = requestLog.filter((r) => r.method === 'POST' && r.path.startsWith(`/api/mem2/entries/${E2}/void`))
      .find((r) => { try { return JSON.parse(r.body).undo === true; } catch { return false; } });
    assert.ok(undoReq, '撤销请求 body 没有 undo:true');

    // 彻底删除
    document.querySelector(`[data-entry="${E3}"] [data-purge1]`).click();
    await sleep(30);
    document.querySelector(`[data-purge2="${E3}"]`).click();
    await waitFor(() => !txt('#impression-body').includes('PURGE-TARGET'), 6000, '彻底删除');
    const delReq = requestLog.find((r) => r.method === 'DELETE' && r.path.startsWith(`/api/mem2/entries/${E3}`));
    assert.ok(delReq, '没记录到 DELETE 请求');
    assert.deepEqual(JSON.parse(delReq.body), { confirm: 'DELETE', reason: '用户在记忆库彻底删除' },
      '彻底删除 body 不是 { confirm:DELETE, reason }（reason 是 IM-13 固定审计文本，不许改）');
  });

  // ══ T16 B8/B14（LR-10/LR-11）════════════════════════════════════════════
  await c.check('T16 B8 跳原文：消息行加 mem2-hit 高亮，2.4s 后移除', async () => {
    // 复用 T2 已经跳过的 MID（770001，GRP_IM 群），重新进入并跳
    await awaitChatsIdle();
    resetPages({ chats: [] });
    window.__switchTab('mem-impression');
    await waitFor(() => document.querySelector('#impression-items [data-uid="111"]'), 8000, '人物进列表');
    await openPersonRow('111');
    await waitFor(() => txt('#impression-body').includes('EDITED-OK'), 5000, '详情加载');
    const jumpBtn = [...document.querySelectorAll('[data-entry] [data-jump]')]
      .find((b) => b.closest('[data-entry]')?.textContent.includes('EDITED-OK'));
    assert.ok(jumpBtn, '找不到跳原文按钮');

    // spy scrollIntoView（测试启动时已设为空函数，要断言调用必须临时替换）
    let scrolled = 0;
    const origSIV = window.Element.prototype.scrollIntoView;
    window.Element.prototype.scrollIntoView = function () { scrolled += 1; };

    jumpBtn.click();
    await waitFor(() => window.__state.tab === 'chats', 5000, '跳到存档页');
    await waitFor(() => document.querySelector(`#chat-detail tr[data-mid="${MID}"]`), 6000, '消息行定位');
    await waitFor(() => document.querySelector(`#chat-detail tr[data-mid="${MID}"]`).classList.contains('mem2-hit'), 3000, '加 mem2-hit');
    assert.ok(scrolled >= 1, 'scrollIntoView 没被调用');
    await sleep(2600);   // 等 2.4s 计时器
    assert.ok(!document.querySelector(`#chat-detail tr[data-mid="${MID}"]`).classList.contains('mem2-hit'), '2.4s 后高亮未移除');

    window.Element.prototype.scrollIntoView = origSIV;   // 恢复
  });

  await c.check('T16 B14 刷新不重建：焦点与滚动位置保留（同一 DOM 节点）', async () => {
    await awaitChatsIdle();
    resetPages({ chats: [] });
    window.__switchTab('mem-impression');
    await waitFor(() => txt('#impression-items').includes('张三'), 8000, '人物列表落地');

    const qEl = document.querySelector('#impression-q');
    const itemsEl = document.querySelector('#impression-items');
    qEl.focus();                                   // 用 focus()，不能直接给 activeElement 赋值
    assert.equal(document.activeElement, qEl, '焦点没落在搜索框');
    itemsEl.scrollTop = 120;                       // 设非零滚动位置

    document.querySelector('#impression-refresh').click();
    await waitFor(() => txt('#impression-items').includes('张三'), 5000, '刷新后列表');
    assert.equal(document.querySelector('#impression-q'), qEl, '刷新重建了搜索框');
    assert.equal(document.querySelector('#impression-items'), itemsEl, '刷新重建了左栏');
    assert.equal(document.activeElement, qEl, '刷新后焦点丢了');
    assert.equal(itemsEl.scrollTop, 120, '刷新后滚动位置被重置');
  });

  // ══ T17 摘要表格矩阵（B9/B10/B11/B13）+ KN-07 ════════════════════
  await c.check('T17 摘要页三列/计数/切会话/切月清缓存/刷新', async () => {
    writeRaceFixtures();
    await awaitChatsIdle();
    resetPages({ chats: [{ chatKey: A2 }, { chatKey: B2 }] });
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-A2'), 8000, 'A2 摘要落地');

    // 三列表头
    const head = txt('#summaries-body thead');
    assert.ok(head.includes('会话起点') && head.includes('摘要') && head.includes('稀疏'),
      `摘要页三列不对：${head}`);
    // 计数文案
    assert.ok(/摘要 · \d+ 个会话/.test(txt('#summaries-count')), 'summaries-count 文案不对');

    // 切会话
    document.querySelector(`#summaries-items [data-chatkey="${B2}"]`).click();
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 6000, '切会话后摘要');

    // 切到无数据的月份（避开 OLD_YM，用一个从没写过夹具的月份）
    const EMPTY_YM = '2020-01';
    document.querySelector('#summaries-month').value = EMPTY_YM;
    document.querySelector('#summaries-month').dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => /这个月没有摘要/.test(txt('#summaries-body')), 6000, '空月空态');

    // 切月已清当前会话缓存：切回当月应重新请求（不是拿过期缓存）
    const l4before = requests.filter((u) => u.startsWith('/api/mem2/l4')).length;
    document.querySelector('#summaries-month').value = YM;
    document.querySelector('#summaries-month').dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 6000, '切回当月');
    assert.ok(requests.filter((u) => u.startsWith('/api/mem2/l4')).length > l4before, '切回当月没重新请求（拿了过期缓存）');

    // 刷新清缓存并重新请求
    const l4before2 = requests.filter((u) => u.startsWith('/api/mem2/l4')).length;
    document.querySelector('#summaries-refresh').click();
    await waitFor(() => txt('#summaries-body').includes('SM-B2'), 6000, '刷新后摘要');
    assert.ok(requests.filter((u) => u.startsWith('/api/mem2/l4')).length > l4before2, '刷新没重新请求');
  });

  await c.check('T17 B13 三页来回切换：任一时刻仅一个 .view.active，各自状态不互清', async () => {
    writeRaceFixtures();
    await awaitChatsIdle();
    resetPages({ chats: [{ chatKey: A2 }, { chatKey: B2 }] });
    window.__switchTab('mem-summaries');
    await waitFor(() => txt('#summaries-body').includes('SM-A2'), 8000, '摘要页落地');
    const TABS = ['mem-impression', 'mem-knowledge', 'mem-summaries'];
    for (const t of TABS) {
      document.querySelector(`.tab[data-tab="${t}"]`).click();
      await sleep(120);
      assert.equal(document.querySelectorAll('.view.active').length, 1, `点 ${t} 后有多个 .view.active`);
      assert.equal(document.querySelectorAll('.tab.active').length, 1, `点 ${t} 后有多个 .tab.active`);
    }
    // 切回摘要页，状态仍在（缓存命中，不重新请求）
    const l4before = requests.filter((u) => u.startsWith('/api/mem2/l4')).length;
    document.querySelector('.tab[data-tab="mem-summaries"]').click();
    await waitFor(() => txt('#summaries-body').includes('SM-A2'), 5000, '切回摘要页');
    assert.equal(requests.filter((u) => u.startsWith('/api/mem2/l4')).length, l4before, '切回摘要页没走缓存、重新发了请求');
  });

  await c.check('T17 KN-07 知识页：已有数据切回不重复请求；刷新才重发；错误态具体', async () => {
    await awaitChatsIdle();
    resetPages({ chats: [] });
    // 第一次进入：有数据
    stubRules.push({ match: /^\/api\/mem2\/knowledge$/, once: true, body: { entries: [{ content: 'KN-DATA', domain: 'd1', term: 't1' }], note: '' } });
    window.__switchTab('mem-knowledge');
    await waitFor(() => txt('#knowledge-body').includes('KN-DATA'), 5000, '有数据卡片');
    const knCount1 = requests.filter((u) => u === '/api/mem2/knowledge').length;

    // 切走再切回：已有数据直接渲染，请求数不增
    document.querySelector('.tab[data-tab="mem-summaries"]').click();
    await sleep(150);
    document.querySelector('.tab[data-tab="mem-knowledge"]').click();
    await sleep(300);
    assert.ok(txt('#knowledge-body').includes('KN-DATA'), '切回后数据没了');
    assert.equal(requests.filter((u) => u === '/api/mem2/knowledge').length, knCount1, '切回重复请求了 knowledge');

    // 刷新：请求数才增
    document.querySelector('#knowledge-refresh').click();
    await waitFor(() => requests.filter((u) => u === '/api/mem2/knowledge').length > knCount1, 5000, '刷新后重发');
  });

  await c.check('T18 摘要页按 convStartTs 倒序（临时修复）', async () => {
    writeRaceFixtures();
    // 故意按 旧 → 新 → 中 的追加顺序写，证明 UI 会重新排序
    writeL4(A2_ID, YM, [
      { convStartTs: 1761003000000, summary: 'SM-T18-OLD', sparse: false },
      { convStartTs: 1761009000000, summary: 'SM-T18-NEW', sparse: false },
      { convStartTs: 1761006000000, summary: 'SM-T18-MID', sparse: false },
    ]);
    // 先排空上一条用例可能残留的 /api/chats，避免它晚到覆盖 resetPages 写入的 A2/B2。
    // 这里不等 L4；摘要数据由下面的 waitFor 兜底。
    await awaitChatsIdle();
    resetPages({ chats: [{ chatKey: B2 }, { chatKey: A2 }] });
    window.__switchTab('mem-summaries');

    // 先让 B2 成为默认选中，再重新查询并点击 A2，确保点击路径真实生效。
    // 不能复用首屏节点：ensureChats().then(...) 会重绘列表。
    await waitFor(
      () => document.querySelector(`#summaries-items [data-chatkey="${B2}"]`)?.classList.contains('selected'),
      8000,
      'T18 默认选中 B2'
    );
    const a2Row = document.querySelector(`#summaries-items [data-chatkey="${A2}"]`);
    assert.ok(a2Row && !a2Row.classList.contains('selected'), 'T18 点击前 A2 不应已选中');
    a2Row.click();
    await waitFor(
      () => document.querySelector(`#summaries-items [data-chatkey="${A2}"]`)?.classList.contains('selected'),
      5000,
      'T18 点击选中 A2'
    );
    await waitFor(() => txt('#summaries-body').includes('SM-T18-OLD'), 8000, 'T18 摘要落地');

    const body = txt('#summaries-body');
    const iNew = body.indexOf('SM-T18-NEW');
    const iMid = body.indexOf('SM-T18-MID');
    const iOld = body.indexOf('SM-T18-OLD');
    assert.ok(iNew >= 0 && iMid >= 0 && iOld >= 0, `T18 三行未全部渲染：${body}`);
    assert.ok(iNew < iMid && iMid < iOld, `摘要未按 convStartTs 倒序：${iNew}/${iMid}/${iOld}`);
    assert.ok(/3 条摘要/.test(body), 'T18 条数不是 3');
  });

// ══ T19 印象星图 3D 交互（必须最后：含 /api/chats 500 桩）══════════════
  await c.check('T19 星图交互 v2.2：单选/双击/四角框/详情归属/全量失效/回顾回放/降级', async () => {
    const UID_G1 = '9910000000191';
    const UID_G2 = '9910000000192';
    const UID_G3 = '9910000000193';
    const GRAPH_CHAT = 'group:3300000000201';
    const GRAPH_OTHER = 'group:3300000000202';
    const LONG_ONE = 'GRAPH-ONE-长正文：' + '星'.repeat(60);
    const G1A = `l1_${UID_G1}_1761000000001_1`;
    const G1B = `l1_${UID_G1}_1761000000002_1`;
    const G2A = `l1_${UID_G2}_1761000000001_1`;
    const origGetContext = window.HTMLCanvasElement.prototype.getContext;
    const origRect = window.HTMLCanvasElement.prototype.getBoundingClientRect;
    const origDPR = window.devicePixelRatio;
    const origMatchMedia = window.matchMedia;
    const origSIV = window.Element.prototype.scrollIntoView;
    const calls = [];
    let spoke = 0;
    const recorded = {
      arc(x, y, r) { calls.push({ type: 'arc', x, y, r }); },
      fillText(text, x, y) { calls.push({ type: 'text', text: String(text), x, y }); },
      moveTo(x, y) { calls.push({ type: 'moveTo', x, y }); },
      lineTo(x, y) { calls.push({ type: 'lineTo', x, y }); },
      drawImage(img, x, y, w, h) { calls.push({ type: 'image', x, y, w, h }); },
      fillRect(x, y, w, h) { calls.push({ type: 'rect', x, y, w, h }); },
      measureText(s) { return { width: String(s).length * 7 }; },
      createRadialGradient() { return { addColorStop() {} }; },
      setTransform() { calls.push({ type: 'frame' }); }, clearRect() {}, beginPath() {}, stroke() {}, fill() {},
      save() {}, restore() {}, setLineDash() {}, translate() {}, scale() {}
    };
    const fakeCtx = new Proxy(recorded, {
      get(t, p) { if (typeof p === 'symbol' || p in t) return Reflect.get(t, p); return () => {}; },
      set(t, p, v) { return Reflect.set(t, p, v); }
    });
    const fakeMatchMedia = (query) => ({
      matches: /prefers-reduced-motion/.test(String(query)),
      media: String(query),
      addEventListener() {}, removeEventListener() {}
    });
    const I = () => window.__MEM_UI.impression;
    const makeGraph = (list) => {
      const people = [];
      const impressions = [];
      for (const item of list) {
        people.push({
          userId: item.uid,
          activeCount: item.n,
          chatKeys: [item.group],
          chatStats: [{ chatKey: item.group, activeCount: item.n, lastUpdatedAt: 1761000000000 }]
        });
        for (let i = 0; i < item.n; i += 1) {
          impressions.push({
            entryId: `${item.uid}_imp${i}`,
            userId: item.uid,
            groups: ['性格特质'],
            createdAt: 1761000000000 + i,
            preview: item.preview || '预览',
            previewTruncated: false
          });
        }
      }
      return { people, impressions, total: impressions.length };
    };

    try {
      window.HTMLCanvasElement.prototype.getContext = () => fakeCtx;
      window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600
      });
      try { Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true }); } catch { /* ignore */ }
      window.matchMedia = fakeMatchMedia;
      window.Element.prototype.scrollIntoView = function () { spoke += 1; };
      window.localStorage.removeItem('qqa-imp-graph-scale');

      await awaitChatsIdle();
      document.querySelector('#impression-q').value = '';
      fs.rmSync(path.join(dataDir, 'mem2', 'people'), { recursive: true, force: true });
      const rowOf = (uid, eid, content, group, groups, createdAt) => personRow(uid, eid, content, groups, {
        chatKey: group,
        sourceChatKeys: [group],
        sourceBatch: { chatKey: group, userId: uid, at: 1761000000000 },
        createdAt
      });
      writePerson(UID_G1, [
        rowOf(UID_G1, G1A, LONG_ONE, GRAPH_CHAT, ['性格特质'], 1761000000200),
        rowOf(UID_G1, G1B, 'GRAPH-ONE-B', GRAPH_CHAT, ['说话风格'], 1761000000201)
      ]);
      writePerson(UID_G2, [rowOf(UID_G2, G2A, 'GRAPH-TWO', GRAPH_CHAT, ['性格特质'], 1761000000100)]);
      writePerson(UID_G3, [rowOf(UID_G3, 'g3a', 'GRAPH-THREE', GRAPH_OTHER, ['兴趣身份'], 1761000000300)]);
      resetPages({ chats: [] });
      Object.assign(I(), {
        selectedUserId: '', graphSelectedKey: '', detailUserId: '',
        person: null, personLoading: false, pendingEntryId: '', mode: 'graph'
      });
      stubRules.push({
        match: /^\/api\/groups\/33000000002(?:01|02)\/members$/,
        status: 200,
        body: { members: [
          { userId: UID_G1, nickname: '星空一', card: '' },
          { userId: UID_G2, nickname: '星空二', card: '' },
          { userId: UID_G3, nickname: '星空三', card: '' }
        ] }
      });
      window.__switchTab('mem-impression');
      await waitFor(() => txt('#impression-count').startsWith('3 人'), 8000, '全部群 3 人');
      const chatSel = document.querySelector('#impression-chat');
      chatSel.value = GRAPH_CHAT;
      chatSel.dispatchEvent(new window.Event('change', { bubbles: true }));
      await waitFor(() => txt('#impression-count').startsWith('2 人 · 3 条有效印象'), 8000, '左栏按群 2 人/3 条');
      await waitFor(() => I().identity[GRAPH_CHAT], 5000, '身份缓存就绪');
      await waitFor(() => I().graph, 8000, '图数据落地');
      await waitFor(() => txt('#impression-body .mem2-graph-summary') === '3 人 · 4 条有效印象', 4000, '图摘要全量');
      const spriteEarly = window.__mem.graphSpriteStats();
      if (!(spriteEarly.base && spriteEarly.scene)) {
        assert.equal(calls.filter((c0) => c0.type === 'image').length, 0, '贴图未就绪就画了首帧');
      }
      await waitFor(() => {
        const s = window.__mem.graphSpriteStats();
        return s.base && s.scene;
      }, 8000, '贴图两级未就绪');
      const spriteStats = window.__mem.graphSpriteStats();
      assert.equal(spriteStats.stars, 3, '用户星点未全部预热');
      assert.equal(spriteStats.fogs, 3, '雾光未全部预热');
      await waitFor(() => calls.some((c0) => c0.type === 'image'), 4000, '首帧绘制');

      const canvasEl = () => document.querySelector('#impression-graph-canvas');
      const tip = () => document.querySelector('#impression-graph-tip');
      const detailReqs = (uid) => requests.filter((u) => u.split('?')[0] === `/api/mem2/people/${uid}`).length;
      const agentPoint = () => {
        const rect = canvasEl().getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      };
      const userPoints = () => {
        const agent = agentPoint();
        return calls.filter((c0) => c0.type === 'image' && c0.w >= 12 && c0.w <= 45)
          .filter((c0) => {
            const cx = c0.x + c0.w / 2;
            const cy = c0.y + c0.h / 2;
            return Math.hypot(cx - agent.x, cy - agent.y) > 22;
          })
          .slice(-3);
      };
      const impPoints = () => calls.filter((c0) => c0.type === 'image' && c0.w < 12).slice(-4);
      const moveTo = async (pt) => {
        canvasEl().dispatchEvent(new window.MouseEvent('mousemove', {
          clientX: pt.x + pt.w / 2, clientY: pt.y + pt.h / 2, bubbles: true
        }));
        await sleep(40);
      };
      const clickAt = (pt) => canvasEl().dispatchEvent(new window.MouseEvent('click', {
        clientX: pt.x + pt.w / 2, clientY: pt.y + pt.h / 2, bubbles: true
      }));
      const dblAt = async (pt) => {
        clickAt(pt);
        await sleep(15);
        clickAt(pt);
        await sleep(15);
        canvasEl().dispatchEvent(new window.MouseEvent('dblclick', {
          clientX: pt.x + pt.w / 2, clientY: pt.y + pt.h / 2, bubbles: true
        }));
        await sleep(40);
      };
      const redrawBlank = async () => {
        calls.length = 0;
        canvasEl().dispatchEvent(new window.MouseEvent('mousemove', { clientX: 3, clientY: 3, bubbles: true }));
        await sleep(40);
      };

      // 1. 默认：无人物/Agent 常驻标签
      const texts0 = calls.filter((c0) => c0.type === 'text').map((c0) => c0.text);
      assert.equal(texts0.length, 0, `默认出现了画布文本：${texts0.join('|')}`);

      // 2. 找 G1/G2 节点
      const points = userPoints();
      let g1Pt = null;
      let g2Pt = null;
      for (const pt of points) {
        await moveTo(pt);
        if (tip().textContent.includes('星空一')) g1Pt = pt;
        if (tip().textContent.includes('星空二')) g2Pt = pt;
      }
      assert.ok(g1Pt && g2Pt, '按提示框未找到 G1/G2');
      calls.length = 0;
      await moveTo(g1Pt);
      assert.ok(tip().textContent.includes('星空一'));
      assert.ok(tip().textContent.includes(`QQ ${UID_G1}`));
      assert.ok(tip().textContent.includes('2 条有效印象'));
      assert.ok(!tip().textContent.includes('GRAPH-ONE'), '人物提示泄露正文');
      assert.equal(calls.filter((c0) => c0.type === 'arc').length, 0, '悬停人物仍画轮廓圆环');

      // 3. 单击人物：只选中、不切列表、不请求详情、画四角框
      calls.length = 0;
      clickAt(g1Pt);
      await sleep(40);
      assert.equal(I().mode, 'graph', '单击人物切了列表');
      assert.equal(I().graphSelectedKey, `user:${UID_G1}`);
      assert.equal(I().selectedUserId, UID_G1);
      assert.equal(I().detailUserId, '');
      assert.equal(detailReqs(UID_G1), 0, '单击人物请求了详情');
      assert.ok(calls.filter((c0) => c0.type === 'lineTo').length >= 11, '单击人物未画四角框');
      assert.ok(document.querySelector(`#impression-items [data-uid="${UID_G1}"]`).classList.contains('selected'),
        '左栏未同步选中');

      // 4. 普通命中范围先验证：Agent 选中前，旧范围边缘不再命中
      const agentCenter = agentPoint();
      clickAt({ x: agentCenter.x + 16 - 2, y: agentCenter.y - 2, w: 4, h: 4 });
      await sleep(30);
      assert.equal(I().graphSelectedKey, '', '缩小后的 Agent 边缘仍被命中');

      // 5. 单击 Agent：可选中，但不切列表、不请求详情
      clickAt({ x: agentCenter.x - 2, y: agentCenter.y - 2, w: 4, h: 4 });
      await sleep(30);
      assert.equal(I().graphSelectedKey, 'agent', '单击 Agent 未选中');
      assert.equal(I().selectedUserId, '', '单击 Agent 改了左栏选中');
      assert.equal(I().detailUserId, '', '单击 Agent 改了详情归属');
      assert.ok(calls.filter((c0) => c0.type === 'lineTo').length >= 8, 'Agent 选中未画四角框');

      // 6. 单击空白：清选中/详情，图仍在
      clickAt({ x: 3, y: 3, w: 1, h: 1 });
      await sleep(40);
      assert.equal(I().graphSelectedKey, '');
      assert.equal(I().selectedUserId, '');
      assert.equal(I().detailUserId, '');
      assert.equal(I().mode, 'graph');
      assert.ok(canvasEl(), '空白单击把图关了');

      // 7. 单击印象：选中印象、父人物左栏同步、不请求详情、不显示父标签
      await redrawBlank();
      let longPt = null;
      for (const pt of impPoints()) {
        calls.length = 0;
        await moveTo(pt);
        if (tip().textContent.includes('…')) { longPt = pt; break; }
      }
      assert.ok(longPt, '未找到长预览印象');
      const expectedPreview = Array.from(LONG_ONE).slice(0, 50).join('') + '…';
      assert.equal(tip().textContent, expectedPreview, '印象提示不是 50 字预览 + …');
      assert.ok(!/条有效印象/.test(tip().textContent), '印象提示显示了数量');
      calls.length = 0;
      clickAt(longPt);
      await sleep(40);
      assert.equal(I().graphSelectedKey, `imp:${G1A}`);
      assert.equal(I().selectedUserId, UID_G1);
      assert.equal(I().detailUserId, '');
      assert.equal(detailReqs(UID_G1), 0);
      assert.ok(calls.filter((c0) => c0.type === 'lineTo').length >= 11, '选中印象未画小四角框');
      const textsImp = calls.filter((c0) => c0.type === 'text').map((c0) => c0.text);
      assert.equal(textsImp.length, 0, `选中印象时出现画布文本：${textsImp.join('|')}`);

      // 7. 双击人物：真实 click→click→dblclick，切列表并加载详情
      await dblAt(g2Pt);
      await waitFor(() => I().mode === 'list' && txt('#impression-body').includes('GRAPH-TWO'), 5000, '双击人物未打开详情');
      assert.equal(I().detailUserId, UID_G2);
      assert.equal(I().selectedUserId, UID_G2);
      assert.equal(I().graphSelectedKey, `user:${UID_G2}`);

      // 8. 详情 A 打开后左栏单击 B：右栏与 detailUserId 保持 A，刷新不加载 B
      const g1ReqBefore = detailReqs(UID_G1);
      const rowG1 = document.querySelector(`#impression-items [data-uid="${UID_G1}"]`);
      rowG1.click();
      await sleep(40);
      assert.equal(I().selectedUserId, UID_G1);
      assert.equal(I().graphSelectedKey, `user:${UID_G1}`);
      assert.equal(I().detailUserId, UID_G2, '左栏单选改了详情归属');
      assert.ok(txt('#impression-body').includes('GRAPH-TWO'), '左栏单选替换了旧详情');
      assert.equal(detailReqs(UID_G1), g1ReqBefore, '左栏单选请求了新详情');
      document.querySelector('#impression-refresh').click();
      await sleep(300);
      assert.equal(I().detailUserId, UID_G2, '刷新按 selectedUserId 加载了 B');
      assert.ok(txt('#impression-body').includes('GRAPH-TWO'), '刷新后右栏不是 A');
      assert.equal(detailReqs(UID_G1), g1ReqBefore, '刷新加载了左栏新选中 B');

      // 8b. 编辑/软删/撤销/含历史只按 detailUserId，不跳到左栏新选中 G1
      document.querySelector(`[data-entry="${G2A}"] [data-edit]`).click();
      await sleep(30);
      document.querySelector(`[data-edit-for="${G2A}"]`).value = 'GRAPH-TWO-EDITED';
      document.querySelector(`[data-save="${G2A}"]`).click();
      await waitFor(() => txt('#impression-body').includes('GRAPH-TWO-EDITED'), 5000, '编辑后详情未刷新');
      assert.equal(I().detailUserId, UID_G2, '编辑把详情跳到了左栏选中');
      assert.equal(I().selectedUserId, UID_G1);
      document.querySelector('#impression-body [data-void]').click();
      await waitFor(() => txt('#impression-body').includes('已删除'), 5000, '软删未刷新');
      assert.equal(I().detailUserId, UID_G2, '软删把详情跳到了左栏选中');
      document.querySelector('[data-undo]').click();
      await waitFor(() => !txt('#impression-body').includes('已删除'), 5000, '撤销未刷新');
      assert.equal(I().detailUserId, UID_G2);
      document.querySelector('[data-showall]').click();
      await sleep(300);
      assert.equal(I().detailUserId, UID_G2, '含历史把详情跳到了左栏选中');
      assert.equal(I().selectedUserId, UID_G1);

      // 9. 左栏双击 G1：切换详情
      await openPersonRow(UID_G1);
      await waitFor(() => txt('#impression-body').includes('GRAPH-ONE'), 5000, '双击左栏未切换详情');
      assert.equal(I().detailUserId, UID_G1);

      // 10. 回图：左栏单击同步图选中并画框；左栏空白清选中/详情
      document.querySelector('#impression-graph-toggle').click();
      await waitFor(() => canvasEl(), 4000, '回图失败');
      calls.length = 0;
      document.querySelector('#impression-graph-toggle').click();
      document.querySelector('#impression-graph-toggle').click();
      await waitFor(() => canvasEl(), 4000, '再回图失败');
      const rowG2 = document.querySelector(`#impression-items [data-uid="${UID_G2}"]`);
      calls.length = 0;
      rowG2.click();
      await sleep(40);
      assert.equal(I().mode, 'graph', '图模式下左栏单击切了列表');
      assert.equal(I().graphSelectedKey, `user:${UID_G2}`);
      assert.equal(I().detailUserId, UID_G1, '左栏单击清了旧详情');
      assert.ok(calls.filter((c0) => c0.type === 'lineTo').length >= 11, '左栏单击未重绘四角框');
      document.querySelector('#impression-items').click();
      await sleep(40);
      assert.equal(I().graphSelectedKey, '');
      assert.equal(I().selectedUserId, '');
      assert.equal(I().detailUserId, '');
      assert.equal(I().mode, 'graph');

      // ── 回顾回放 v2.2（插在步骤 10 后，结束时保持 graph 模式供步骤 11）──
      {
        const R = () => window.__mem.getReplayState();
        const replayBtn = () => document.querySelector('#impression-graph-recall');
        const replayLabel = () => (replayBtn()?.querySelector('.mem2-graph-recall-label')?.textContent || '');
        const startReplay = () => {
          assert.ok(replayBtn(), '回顾按钮不存在');
          replayBtn().click();
        };
        const cancelReplay = () => window.__mem.cancelReplay({ restore: true, reason: 'manual' });
        const ensureGraph = async (label) => {
          if (I().mode !== 'graph') {
            const t = document.querySelector('#impression-graph-toggle');
            if (t) t.click();
          }
          await waitFor(() => I().mode === 'graph' && canvasEl(), 6000, `${label}：回图失败`);
          await waitFor(() => {
            const s = window.__mem.graphSpriteStats();
            return s.base && s.scene;
          }, 6000, `${label}：贴图未就绪`);
          await waitFor(() => I().graphLoading === false, 6000, `${label}：图仍在加载`);
        };
        const hoverAt = async (x, y) => {
          canvasEl().dispatchEvent(new window.MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
          await sleep(45);
        };
        const hoverNode = (pt) => hoverAt(pt.x + pt.w / 2, pt.y + pt.h / 2);
        const frameSegments = () => {
          const out = [];
          let cur = null;
          for (const c0 of calls) {
            if (c0.type === 'frame') { cur = []; out.push(cur); } else if (cur) cur.push(c0);
          }
          return out;
        };
        const frameMetric = (seg) => ({
          fog: seg.filter((c0) => c0.type === 'image' && c0.w >= 48).length,
          line: seg.filter((c0) => c0.type === 'lineTo').length,
          text: seg.filter((c0) => c0.type === 'text').length,
          img: seg.filter((c0) => c0.type === 'image').length
        });
        const lastFrame = () => {
          const segs = frameSegments();
          return segs.length ? segs[segs.length - 1] : [];
        };
        const graphReqCount = () => requests.filter((u) => u.split('?')[0] === '/api/mem2/graph').length;
        const peopleReqCount = () => requests.filter((u) => u.startsWith('/api/mem2/people/')).length;

        await ensureGraph('回放');
        const baselineGraph = JSON.parse(JSON.stringify(I().graph));
        let g3Pt = null;
        await redrawBlank();
        for (const pt of userPoints()) {
          await hoverNode(pt);
          if (tip().textContent.includes('星空三')) g3Pt = pt;
        }
        assert.ok(g3Pt, '回放用例找不到 G3');

        try {
          // R1 排序纯函数
          assert.equal(typeof window.__mem.buildReplayOrder, 'function', '缺少 buildReplayOrder 导出');
          assert.equal(typeof window.__mem.cancelReplay, 'function', '缺少 cancelReplay 导出');
          assert.equal(typeof window.__mem.getReplayState, 'function', '缺少 getReplayState 导出');
          {
            const sceneOrder = { impressions: [
              { key: 'imp:a1', uid: '2', userKey: 'user:2', createdAt: 0 },
              { key: 'imp:a2', uid: '2', userKey: 'user:2', createdAt: 150 },
              { key: 'imp:b1', uid: '1', userKey: 'user:1', createdAt: 150 },
              { key: 'imp:c1', uid: '3', userKey: 'user:3', createdAt: 0 }
            ] };
            const sceneSnapshot = JSON.stringify(sceneOrder);
            const order = window.__mem.buildReplayOrder(sceneOrder);
            assert.equal(order.map((o) => o.uid).join(','), '1,2,3',
              '排序不是“有效时间升序 → 全无效最后 → uid 字典序”');
            assert.equal(order[0].firstAt, 150);
            assert.equal(order[1].firstAt, 150);
            assert.equal(order[2].firstAt, 0, '全无效用户 firstAt 不是 0');
            assert.equal(order[1].impressionKeys.length, 2, 'impressionKeys 未包含全部印象');
            assert.equal(order[2].impressionKeys.length, 1);
            assert.equal(JSON.stringify(sceneOrder), sceneSnapshot, '排序纯函数修改了 scene');
          }

          // R2 主流程：零自动副作用、立即命中过滤、250ms 推进、完成即止、按钮
          {
            await ensureGraph('R2');
            document.querySelector(`#impression-items [data-uid="${UID_G1}"]`).click();
            await sleep(40);
            window.__mem.loadImpressionDetail(UID_G1, { select: true });
            await waitFor(() => I().person && I().detailUserId === UID_G1, 5000, 'R2 基线详情');
            const base = {
              sel: I().selectedUserId, key: I().graphSelectedKey, detail: I().detailUserId,
              person: I().person, seq: I().detailSeq, rows: document.querySelectorAll('#impression-items [data-uid]').length,
              gReq: detailReqs(UID_G1), graphReq: graphReqCount(), peopleReq: peopleReqCount()
            };
            await sleep(60);
            calls.length = 0;
            startReplay();
            const st0 = R();
            assert.equal(st0.active, true, 'R2 未启动');
            assert.equal(st0.index, 0);
            assert.equal(st0.total, 3);
            assert.equal(st0.orderLen, 3);
            assert.equal(replayLabel(), '回顾中 0/3');
            assert.equal(replayBtn().disabled, true, '运行中按钮未禁用');
            assert.ok(replayBtn().classList.contains('is-running'), '运行中缺 is-running');
            assert.equal(I().selectedUserId, base.sel, 'R2 改了左栏选中');
            assert.equal(I().graphSelectedKey, base.key, 'R2 改了图选中');
            assert.equal(I().detailUserId, base.detail, 'R2 改了详情归属');
            assert.equal(I().person, base.person, 'R2 改了详情对象');
            assert.equal(I().detailSeq, base.seq, 'R2 递增了 detailSeq');
            assert.equal(detailReqs(UID_G1), base.gReq, 'R2 发起了详情请求');
            assert.equal(document.querySelectorAll('#impression-items [data-uid]').length, base.rows, 'R2 重建了左栏');
            await sleep(50);
            const f0 = frameMetric(lastFrame());
            assert.equal(f0.img, 1, `R2 首帧不是只画 Agent：${f0.img}`);
            assert.equal(f0.line, 0, 'R2 隐藏节点仍画连线/选中框');
            assert.equal(f0.text, 0, 'R2 隐藏节点仍画标签');
            const agent = agentPoint();
            await hoverAt(agent.x, agent.y);
            assert.ok(tip().textContent.includes('3 人 · 4 条有效印象'), 'R2 Agent tooltip 不是全量');
            await hoverNode(g1Pt);
            assert.equal(tip().hidden, true, 'R2 隐藏用户仍可悬停');
            assert.equal(I().selectedUserId, base.sel, 'R2 hover 改了左栏选中');
            assert.equal(I().graphSelectedKey, base.key, 'R2 hover 改了图选中');
            assert.equal(I().detailUserId, base.detail, 'R2 hover 改了详情');
            clickAt(g1Pt);
            await sleep(40);
            assert.notEqual(I().graphSelectedKey, `user:${UID_G1}`, 'R2 隐藏节点被命中');
            assert.equal(I().selectedUserId, '', 'R2 隐藏坐标点击未走空点 A');
            await waitFor(() => R().index === 1, 2000, 'R2 未推进到 1/3');
            assert.equal(replayLabel(), '回顾中 1/3');
            await waitFor(async () => {
              await hoverNode(g2Pt);
              return tip().textContent.includes('星空二');
            }, 2500, `R2 第一位不是 G2（最早 createdAt）：${tip().textContent}`);
            await hoverNode(g1Pt);
            assert.equal(tip().hidden, true, 'R2 第二位提前可见');
            await hoverAt(agent.x, agent.y);
            assert.ok(tip().textContent.includes('3 人 · 4 条有效印象'), 'R2 1/3 Agent tooltip 不是全量');
            await waitFor(() => R().index === 2, 2000, 'R2 未推进到 2/3');
            await waitFor(async () => {
              await hoverNode(g1Pt);
              return tip().textContent.includes('星空一');
            }, 2500, 'R2 第二位不是 G1');
            await hoverNode(g3Pt);
            assert.equal(tip().hidden, true, 'R2 第三位提前可见');
            await waitFor(() => R().active === false && replayLabel() === '回顾', 2500, 'R2 未完成');
            const done = R();
            assert.equal(done.index, 3);
            assert.equal(done.total, 3);
            assert.ok(done.completedAt > 0, 'R2 未写 completedAt');
            assert.ok(done.completedAt - done.lastStepAt < 150,
              `R2 第 N 个后多等了 ${Math.round(done.completedAt - done.lastStepAt)}ms`);
            assert.equal(replayBtn().disabled, false, 'R2 完成后按钮仍禁用');
            assert.ok(!replayBtn().classList.contains('is-running'), 'R2 完成后仍 is-running');
            await sleep(300);
            assert.equal(R().index, 3, 'R2 完成后又自动重播');
            await waitFor(async () => {
              await hoverNode(g3Pt);
              return tip().textContent.includes('星空三');
            }, 2500, 'R2 完成后 G3 未恢复');
            assert.equal(graphReqCount(), base.graphReq, 'R2 新增了 graph 请求');
            assert.equal(peopleReqCount(), base.peopleReq, 'R2 新增了详情/左栏请求');
            startReplay();
            assert.equal(R().active, true, 'R2 完成后不能重启');
            assert.equal(R().index, 0);
            assert.equal(replayLabel(), '回顾中 0/3');
            cancelReplay();
            assert.equal(R().active, false);
            assert.equal(replayLabel(), '回顾');
          }

          // R2b 逐帧绘制过滤：无 hover/选中时，帧应为 Agent → 1 人 → 2 人 → 3 人
          {
            await ensureGraph('R2b');
            clickAt({ x: 3, y: 3, w: 1, h: 1 });
            await sleep(60);
            calls.length = 0;
            startReplay();
            await waitFor(() => R().active === false, 3000, 'R2b 未完成');
            await sleep(60);
            const frames = frameSegments().map(frameMetric);
            assert.ok(frames.some((m) => m.img === 1 && m.fog === 0 && m.line === 0 && m.text === 0),
              'R2b 起始帧不是只剩 Agent');
            assert.ok(frames.some((m) => m.fog === 1 && m.line === 1 && m.text === 0),
              'R2b 缺少 1 人帧（雾光/连线过滤不对）');
            assert.ok(frames.some((m) => m.fog === 2 && m.line === 2 && m.text === 0),
              'R2b 缺少 2 人帧');
            const lastM = frames[frames.length - 1];
            assert.equal(lastM.fog, 3, `R2b 完成帧雾光不是 3：${lastM.fog}`);
            assert.equal(lastM.line, 3, `R2b 完成帧连线不是 3：${lastM.line}`);
            assert.equal(lastM.text, 0, 'R2b 无选中无 hover 仍出现标签');
          }

          // R3 左栏/右栏零自动副作用（不点画布空白）
          {
            await ensureGraph('R3');
            document.querySelector(`#impression-items [data-uid="${UID_G1}"]`).click();
            await sleep(40);
            window.__mem.loadImpressionDetail(UID_G1, { select: true });
            await waitFor(() => I().person && I().detailUserId === UID_G1, 5000, 'R3 基线详情');
            const b = {
              sel: I().selectedUserId, key: I().graphSelectedKey, detail: I().detailUserId,
              person: I().person, seq: I().detailSeq, rows: document.querySelectorAll('#impression-items [data-uid]').length,
              req: detailReqs(UID_G1)
            };
            startReplay();
            calls.length = 0;
            await waitFor(() => R().index === 1, 2000, 'R3 1/3');
            assert.equal(I().selectedUserId, b.sel);
            assert.equal(I().graphSelectedKey, b.key);
            assert.equal(I().detailUserId, b.detail);
            assert.equal(I().person, b.person);
            assert.equal(I().detailSeq, b.seq, 'R3 推进时递增了 detailSeq');
            assert.equal(detailReqs(UID_G1), b.req);
            assert.equal(document.querySelectorAll('#impression-items [data-uid]').length, b.rows);
            const hiddenFrames = frameSegments().map(frameMetric);
            assert.ok(hiddenFrames.every((m) => m.line <= 1), 'R3 隐藏选中用户仍画了四角框');
            assert.ok(hiddenFrames.every((m) => m.text === 0), 'R3 隐藏选中用户仍有标签');
            await waitFor(() => R().index === 2, 2000, 'R3 2/3');
            assert.equal(I().graphSelectedKey, b.key);
            assert.equal(I().person, b.person);
            await sleep(60);
            const shownFrame = frameMetric(lastFrame());
            assert.ok(shownFrame.line >= 9, `R3 选中用户可见后未恢复四角框：${shownFrame.line}`);
            await waitFor(() => R().active === false, 2500, 'R3 未完成');
            assert.equal(I().selectedUserId, b.sel, 'R3 完成后改了左栏选中');
            assert.equal(I().graphSelectedKey, b.key, 'R3 完成后改了图选中');
            assert.equal(I().detailUserId, b.detail, 'R3 完成后改了详情');
            assert.equal(I().person, b.person, 'R3 完成后换了详情对象');
            assert.equal(I().detailSeq, b.seq, 'R3 完成后递增了 detailSeq');
            clickAt({ x: 3, y: 3, w: 1, h: 1 });
            await sleep(40);
          }

          // R4 左栏交互保持：未加载只选中、不请求；加载后出框；双击切列表并取消
          {
            await ensureGraph('R4');
            startReplay();
            await sleep(30);
            assert.equal(document.querySelectorAll('#impression-items [data-uid]').length, 2,
              'R4 回放中左栏被筛掉');
            const rowG1 = document.querySelector(`#impression-items [data-uid="${UID_G1}"]`);
            const reqBefore = detailReqs(UID_G1);
            rowG1.click();
            await sleep(50);
            assert.equal(I().selectedUserId, UID_G1);
            assert.equal(I().graphSelectedKey, `user:${UID_G1}`);
            assert.equal(detailReqs(UID_G1), reqBefore, 'R4 左栏单击请求了详情');
            await hoverNode(g1Pt);
            assert.equal(tip().hidden, true, 'R4 未加载用户在星图显示');
            await waitFor(() => R().index >= 2, 2500, 'R4 等 G1 加载');
            await sleep(60);
            assert.ok(frameMetric(lastFrame()).line >= 9, 'R4 加载后未恢复选框');
            cancelReplay();
            startReplay();
            await sleep(30);
            await openPersonRow(UID_G1);
            await waitFor(() => I().mode === 'list', 5000, 'R4 双击未切列表');
            assert.equal(R().active, false, 'R4 双击左栏未取消回放');
            await ensureGraph('R4 回图');
          }

          // R5 启动守卫 + 空 order
          {
            await ensureGraph('R5');
            I().graphLoading = true;
            try {
              startReplay();
              assert.equal(R().active, false, 'R5 数据加载中仍启动');
              assert.equal(replayBtn().disabled, false);
              assert.ok(!replayBtn().classList.contains('is-running'));
              await sleep(300);
              assert.equal(R().active, false, 'R5 守卫后仍启动');
              assert.ok(!/0\//.test(replayLabel()), 'R5 守卫后出现进度');
            } finally {
              I().graphLoading = false;
            }
            const gSnap = JSON.parse(JSON.stringify(I().graph));
            stubRules.push({
              match: /^\/api\/mem2\/graph$/, once: true, status: 200,
              body: {
                people: [{ userId: UID_G1, activeCount: 1, chatKeys: [GRAPH_CHAT], chatStats: [{ chatKey: GRAPH_CHAT, activeCount: 1, lastUpdatedAt: 1761000000200 }] }],
                impressions: [], total: 1
              }
            });
            document.querySelector('#impression-refresh').click();
            await waitFor(() => I().graph && I().graph.impressions.length === 0, 6000, 'R5 空 order 图');
            await waitFor(() => replayBtn() && window.__mem.graphSpriteStats().scene, 6000, 'R5 空 order 贴图');
            startReplay();
            assert.equal(R().active, false, 'R5 空 order 仍启动');
            assert.equal(R().orderLen, 0, 'R5 空 order 未写回');
            assert.ok(!replayBtn().classList.contains('is-running'));
            assert.ok(!/0\//.test(replayLabel()), `R5 空 order 出现进度：${replayLabel()}`);
            stubRules.push({ match: /^\/api\/mem2\/graph$/, once: true, status: 200, body: gSnap });
            document.querySelector('#impression-refresh').click();
            await waitFor(() => I().graph && I().graph.people.length === 3 && I().graph.total === 4, 6000, 'R5 恢复 3 人图');
            await ensureGraph('R5 恢复');
          }

          // R6 既有请求错误 C：先取消回放，reason 必须是 error 且不被 teardown 覆盖
          {
            await ensureGraph('R6');
            startReplay();
            assert.equal(R().active, true);
            assert.equal(R().lastCancelReason, '', 'R6 启动时未清空取消来源');
            const seqBefore = R().cancelSeq;
            stubRules.push({
              match: new RegExp(`^/api/mem2/people/${UID_G2}$`), once: true, status: 404,
              body: { error: '回顾错误桩' }, ms: 400
            });
            window.__mem.loadImpressionDetail(UID_G2, { select: true });
            await waitFor(() => R().active === false && R().lastCancelReason === 'error', 3000,
              'R6 错误未按 error 取消回放');
            assert.equal(R().cancelSeq, seqBefore + 1, 'R6 取消次数不是一次（被 teardown 覆盖）');
            const idxAtError = R().index;
            await waitFor(() => txt('#impression-body').includes('读取'), 2000, 'R6 错误未显示');
            await sleep(400);
            assert.equal(R().active, false, 'R6 出错后自动恢复回放');
            assert.equal(R().index, idxAtError, 'R6 出错后进度继续');
            assert.ok(!replayBtn()?.classList.contains('is-running'), 'R6 出错后按钮仍 running');
          }
          I().error = '';
          I().graphError = '';
          I().detailUserId = '';
          I().person = null;
          I().personLoading = false;
          document.querySelector('#impression-refresh').click();
          await ensureGraph('R6 恢复');

          // R7 force 刷新入口：先取消并保持旧全量，旧 timer 不再推进
          {
            await ensureGraph('R7');
            startReplay();
            await waitFor(() => R().index === 1, 2000, 'R7 1/3');
            stubRules.push({
              match: /^\/api\/mem2\/graph$/, once: true, status: 200,
              body: JSON.parse(JSON.stringify(I().graph)), ms: 400
            });
            document.querySelector('#impression-refresh').click();
            await waitFor(() => R().active === false && R().lastCancelReason === 'refresh', 1000,
              `R7 未在 force 入口取消：reason=${R().lastCancelReason} active=${R().active} index=${R().index} error=${I().error} graphError=${I().graphError} chatsError=${I().chatsError}`);
            assert.equal(replayLabel(), '回顾');
            assert.ok(canvasEl(), 'R7 请求在途时旧图被销毁');
            const idxRefresh = R().index;
            await sleep(300);
            assert.equal(R().index, idxRefresh, 'R7 旧回放继续推进');
            await waitFor(() => {
              const s = window.__mem.graphSpriteStats();
              return s.base && s.scene;
            }, 6000, 'R7 新图贴图未就绪');
            await ensureGraph('R7 恢复');
          }

          // R8 切列表 / 切页签 / 页面隐藏
          {
            await ensureGraph('R8');
            startReplay();
            await sleep(30);
            document.querySelector('#impression-graph-toggle').click();
            await waitFor(() => R().active === false && R().lastCancelReason === 'teardown', 1000,
              'R8 切列表未取消');
            await sleep(300);
            assert.equal(R().index, 0, 'R8 切列表后继续推进');
            await ensureGraph('R8 回图');
            await hoverNode(g1Pt);
            assert.ok(tip().textContent.includes('星空一'), 'R8 回图不是全量');

            startReplay();
            await sleep(30);
            window.__switchTab('sessions');
            await waitFor(() => R().active === false && R().lastCancelReason === 'tab', 1000,
              'R8 切页签未取消');
            const idxTab = R().index;
            await sleep(350);
            assert.equal(R().index, idxTab, 'R8 切页签后继续推进');
            window.__switchTab('mem-impression');
            await waitFor(() => canvasEl() && I().mode === 'graph', 6000, 'R8 回印象失败');
            await waitFor(() => {
              const s = window.__mem.graphSpriteStats();
              return s.base && s.scene;
            }, 6000, 'R8 回印象贴图');
            await hoverNode(g1Pt);
            assert.ok(tip().textContent.includes('星空一'), 'R8 回页签不是全量');

            startReplay();
            await sleep(30);
            let hiddenVal = false;
            const origHiddenDesc = Object.getOwnPropertyDescriptor(document, 'hidden');
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenVal });
            try {
              hiddenVal = true;
              document.dispatchEvent(new window.Event('visibilitychange'));
              await waitFor(() => R().active === false && R().lastCancelReason === 'hidden', 1000,
                'R8 隐藏未取消');
              hiddenVal = false;
              calls.length = 0;
              document.dispatchEvent(new window.Event('visibilitychange'));
              await waitFor(() => calls.some((c0) => c0.type === 'image'), 1500,
                'R8 恢复可见未立即重绘');
              await hoverNode(g1Pt);
              assert.ok(tip().textContent.includes('星空一'), 'R8 恢复可见不是全量');
            } finally {
              if (origHiddenDesc) Object.defineProperty(document, 'hidden', origHiddenDesc);
              else { try { delete document.hidden; } catch { /* ignore */ } }
            }
          }

          // R9 正常 motion loop：yaw 自转可测，完成不重启
          {
            const origMM = window.matchMedia;
            window.matchMedia = (q) => ({ matches: false, media: String(q), addEventListener() {}, removeEventListener() {} });
            try {
              if (I().mode === 'graph') {
                document.querySelector('#impression-graph-toggle').click();
                await waitFor(() => I().mode === 'list', 2000, 'R9 切列表');
              }
              document.querySelector('#impression-graph-toggle').click();
              await waitFor(() => I().mode === 'graph' && canvasEl(), 4000, 'R9 回图');
              const yaw0 = I().graphView.yaw;
              startReplay();
              await waitFor(() => Math.abs(I().graphView.yaw - yaw0) > 0.02, 2500, 'R9 loop 未自转');
              await waitFor(() => R().active === false, 3000, 'R9 回放未完成');
              assert.equal(replayLabel(), '回顾');
            } finally {
              window.matchMedia = origMM;
              if (I().mode === 'graph') {
                document.querySelector('#impression-graph-toggle').click();
                await sleep(30);
              }
              if (I().mode !== 'graph') document.querySelector('#impression-graph-toggle').click();
              await waitFor(() => I().mode === 'graph' && canvasEl(), 5000, 'R9 恢复图模式');
              await sleep(60);
            }
          }
        } finally {
          try { window.__mem.cancelReplay({ restore: true, reason: 'manual' }); } catch { /* ignore */ }
          I().graphLoading = false;
          I().error = '';
          I().graphError = '';
          if (!I().graph || (I().graph.people || []).length !== 3 || Number(I().graph.total) !== 4) {
            stubRules.push({
              match: /^\/api\/mem2\/graph$/, once: true, status: 200,
              body: JSON.parse(JSON.stringify(baselineGraph))
            });
            document.querySelector('#impression-refresh').click();
            await waitFor(() => I().graph && I().graph.people.length === 3 && I().graph.total === 4,
              6000, '回放 finally 恢复 3 人图');
          }
          await ensureGraph('回放 finally');
          if (canvasEl()) {
            clickAt({ x: 3, y: 3, w: 1, h: 1 });   // 复位到步骤 10 结束态：空点清选中/详情
            await sleep(40);
          }
        }
      }

      // 11. 双击印象：切列表、pending 生效、滚动 + 高亮
      await redrawBlank();
      let longPt2 = null;
      for (const pt of impPoints()) {
        calls.length = 0;
        await moveTo(pt);
        if (tip().textContent.includes('…')) { longPt2 = pt; break; }
      }
      assert.ok(longPt2, `回图后未找到长预览印象：replay=${JSON.stringify(window.__mem.getReplayState())} tip=${tip().textContent} images=${JSON.stringify(calls.filter((c0) => c0.type === 'image').slice(-8).map((c0) => [Math.round(c0.w)]))} sel=${I().graphSelectedKey}`);
      await dblAt(longPt2);
      await waitFor(() => I().mode === 'list' && txt('#impression-body').includes('GRAPH-ONE-长正文'), 5000, '双击印象未打开详情');
      await waitFor(() => document.querySelector(`#impression-body [data-entry="${G1A}"]`), 4000, '目标卡片不存在');
      assert.equal(I().detailUserId, UID_G1);
      assert.equal(I().graphSelectedKey, `imp:${G1A}`);
      assert.ok(spoke >= 1, 'scrollIntoView 未被调用');
      await waitFor(() => document.querySelector(`#impression-body [data-entry="${G1A}"]`).classList.contains('is-graph-focus'),
        2000, '目标卡片未高亮');

      // 12. 全量失效：A 失效、B 保留
      const rowG2Now = document.querySelector(`#impression-items [data-uid="${UID_G2}"]`);
      assert.ok(rowG2Now, '失效用例前找不到 G2 行（左栏被回放用例重建）');
      rowG2Now.click();
      await sleep(40);
      document.querySelector('#impression-graph-toggle').click();
      await waitFor(() => canvasEl(), 4000, '失效用例回图失败');
      stubRules.push({ match: /^\/api\/mem2\/graph$/, once: true, status: 200, body: makeGraph([
        { uid: UID_G2, group: GRAPH_CHAT, n: 1, preview: 'GRAPH-TWO' },
        { uid: UID_G3, group: GRAPH_OTHER, n: 1, preview: 'GRAPH-THREE' }
      ]) });
      document.querySelector('#impression-refresh').click();
      await waitFor(() => I().graph.people.length === 2, 6000, '失效图未落地');
      await waitFor(() => {
        const s = window.__mem.graphSpriteStats();
        return s.base && s.scene && s.stars === 2 && s.fogs === 2;
      }, 8000, '失效图贴图未就绪');
      assert.equal(I().selectedUserId, UID_G2, 'A 失效误清左栏 B');
      assert.equal(I().graphSelectedKey, `user:${UID_G2}`, 'A 失效误清图选中 B');
      assert.equal(I().detailUserId, '', 'A 失效未清详情归属');
      assert.equal(I().person, null, 'A 失效未清旧详情');

      // 13. 全量失效：B 失效、A 保留
      // 先在图里单击 G3，再打开 G2 详情，形成 selected=G3 / detail=G2
      await redrawBlank();
      let g3Pt = null;
      for (const pt of userPoints()) {
        await moveTo(pt);
        if (tip().textContent.includes('星空三')) g3Pt = pt;
      }
      assert.ok(g3Pt, '失效图里找不到 G3');
      let g2InGraph = null;
      for (const pt of userPoints()) {
        await moveTo(pt);
        if (tip().textContent.includes('星空二')) g2InGraph = pt;
      }
      assert.ok(g2InGraph, '失效图里找不到 G2');
      await dblAt(g2InGraph);
      await waitFor(() => I().mode === 'list' && txt('#impression-body').includes('GRAPH-TWO'), 5000, '无法打开 G2 详情');
      document.querySelector('#impression-graph-toggle').click();
      await waitFor(() => canvasEl(), 4000, '回图失败2');
      await redrawBlank();
      g3Pt = null;
      for (const pt of userPoints()) {
        await moveTo(pt);
        if (tip().textContent.includes('星空三')) g3Pt = pt;
      }
      assert.ok(g3Pt, '失效图里找不到 G3（第二次）');
      clickAt(g3Pt);
      await sleep(40);
      assert.equal(I().selectedUserId, UID_G3);
      stubRules.push({ match: /^\/api\/mem2\/graph$/, once: true, status: 200, body: makeGraph([
        { uid: UID_G1, group: GRAPH_CHAT, n: 2, preview: LONG_ONE },
        { uid: UID_G2, group: GRAPH_CHAT, n: 1, preview: 'GRAPH-TWO' }
      ]) });
      document.querySelector('#impression-refresh').click();
      await waitFor(() => I().graph.people.length === 2 && !I().graph.people.some((p) => p.userId === UID_G3), 6000, 'B 失效图未落地');
      await waitFor(() => {
        const s = window.__mem.graphSpriteStats();
        return s.base && s.scene && s.stars === 2 && s.fogs === 2;
      }, 8000, 'B 失效图贴图未就绪');
      assert.equal(I().selectedUserId, '', 'B 失效未清左栏选中');
      assert.equal(I().graphSelectedKey, '', 'B 失效未清图选中');
      assert.equal(I().detailUserId, UID_G2, 'B 失效误清详情 A');
      document.querySelector('#impression-graph-toggle').click();
      await waitFor(() => txt('#impression-body').includes('GRAPH-TWO'), 5000, 'B 失效后详情 A 丢失');

      // 14. 仅群筛选变化：不清选中/详情
      chatSel.value = GRAPH_CHAT;
      chatSel.dispatchEvent(new window.Event('change', { bubbles: true }));
      await waitFor(() => document.querySelector(`#impression-items [data-uid="${UID_G2}"]`), 8000, 'G2 行未回来');
      document.querySelector(`#impression-items [data-uid="${UID_G2}"]`).click();
      await sleep(40);
      chatSel.value = GRAPH_OTHER;
      chatSel.dispatchEvent(new window.Event('change', { bubbles: true }));
      await waitFor(() => txt('#impression-count').startsWith('1 人'), 8000, '群筛选未生效');
      assert.equal(I().selectedUserId, UID_G2, '群筛选误清左栏选中');
      assert.equal(I().graphSelectedKey, `user:${UID_G2}`, '群筛选误清图选中');
      assert.equal(I().detailUserId, UID_G2, '群筛选误清详情');

      // 15. 详情失败：清 pending
      stubRules.push({ match: new RegExp(`^/api/mem2/people/${UID_G1}$`), once: true, status: 404, body: { error: '没有这个人的画像' } });
      I().pendingEntryId = G1B;
      window.__mem.loadImpressionDetail(UID_G1, { select: true });
      await waitFor(() => I().pendingEntryId === '', 4000, '详情失败未清 pending');
      assert.equal(I().detailUserId, '', '404 未清详情归属');

      // 16. 拖拽 >3px 不触发选中/双击
      document.querySelector('#impression-graph-toggle').click();
      await waitFor(() => canvasEl(), 4000, '拖拽用例回图失败');
      clickAt({ x: 3, y: 3, w: 1, h: 1 });
      await sleep(40);
      const keyBeforeDrag = I().graphSelectedKey;
      canvasEl().dispatchEvent(new window.MouseEvent('mousedown', { clientX: 400, clientY: 300, bubbles: true }));
      canvasEl().dispatchEvent(new window.MouseEvent('mousemove', { clientX: 420, clientY: 310, bubbles: true }));
      canvasEl().dispatchEvent(new window.MouseEvent('mouseup', { clientX: 420, clientY: 310, bubbles: true }));
      clickAt({ x: 398, y: 298, w: 4, h: 4 });
      await sleep(40);
      assert.equal(I().graphSelectedKey, keyBeforeDrag, '拖拽误触发选中');

      // 16b. 俯仰不再夹紧：可越过 ±1.2；重置仍回默认
      canvasEl().dispatchEvent(new window.MouseEvent('mousedown', { clientX: 400, clientY: 300, bubbles: true }));
      canvasEl().dispatchEvent(new window.MouseEvent('mousemove', { clientX: 400, clientY: 900, bubbles: true }));
      canvasEl().dispatchEvent(new window.MouseEvent('mouseup', { clientX: 400, clientY: 900, bubbles: true }));
      await sleep(40);
      assert.ok(I().graphView.pitch > 1.2, `拖拽 pitch 仍被夹紧：${I().graphView.pitch}`);
      document.querySelector('#impression-graph-reset').click();
      assert.equal(I().graphView.yaw, 0.42);
      assert.equal(I().graphView.pitch, -0.24);
      assert.equal(I().graphView.zoom, 1);

      // 16c. 相机基向量方向：yaw 180° 后纵向、pitch 180° 后横向不反向
      I().graphView.yaw = Math.PI;
      I().graphView.pitch = 0;
      canvasEl().dispatchEvent(new window.MouseEvent('mousedown', { clientX: 400, clientY: 300, bubbles: true }));
      canvasEl().dispatchEvent(new window.MouseEvent('mousemove', { clientX: 400, clientY: 350, bubbles: true }));
      canvasEl().dispatchEvent(new window.MouseEvent('mouseup', { clientX: 400, clientY: 350, bubbles: true }));
      await sleep(30);
      assert.ok(I().graphView.pitch < 0, `yaw 180° 后纵向拖拽方向反了：${I().graphView.pitch}`);
      const rotAfter = I().graphView.rot;
      assert.ok(Array.isArray(rotAfter) && rotAfter.length === 9 && rotAfter.every(Number.isFinite),
        '相机旋转矩阵未生成或含非法值');
      document.querySelector('#impression-graph-reset').click();
      assert.equal(I().graphView.rot, null);

      I().graphView.pitch = Math.PI;
      I().graphView.yaw = 0;
      canvasEl().dispatchEvent(new window.MouseEvent('mousedown', { clientX: 400, clientY: 300, bubbles: true }));
      canvasEl().dispatchEvent(new window.MouseEvent('mousemove', { clientX: 450, clientY: 300, bubbles: true }));
      canvasEl().dispatchEvent(new window.MouseEvent('mouseup', { clientX: 450, clientY: 300, bubbles: true }));
      await sleep(30);
      assert.ok(I().graphView.yaw > 0, `pitch 180° 后横向拖拽方向反了：${I().graphView.yaw}`);
      document.querySelector('#impression-graph-reset').click();
      assert.equal(I().graphView.yaw, 0.42);
      assert.equal(I().graphView.pitch, -0.24);

      // 17. 缩放记忆与重置
      document.querySelector('#impression-graph-zoom-in').click();
      await waitFor(() => Number(window.localStorage.getItem('qqa-imp-graph-scale')) > 1, 1500,
        '缩放防抖未落盘');
      document.querySelector('#impression-graph-reset').click();
      assert.equal(I().graphView.yaw, 0.42);
      assert.equal(I().graphView.pitch, -0.24);
      assert.equal(I().graphView.zoom, 1);
      assert.equal(window.localStorage.getItem('qqa-imp-graph-scale'), null);

      // 17b. 滚轮：事件只改目标缩放，不同步重绘；localStorage 防抖后才落盘
      await sleep(40);                      // 先让上一步合并的 rAF 绘制跑完
      window.localStorage.removeItem('qqa-imp-graph-scale');
      calls.length = 0;
      canvasEl().dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
      assert.equal(calls.length, 0, 'wheel 同步触发了完整绘制');
      assert.ok(I().graphView.zoom > 1, 'wheel 未更新目标缩放');
      assert.equal(window.localStorage.getItem('qqa-imp-graph-scale'), null, 'wheel 同步写了 localStorage');
      await waitFor(() => calls.length > 0, 1500, 'wheel 后没有在下一帧重绘');
      await waitFor(() => Number(window.localStorage.getItem('qqa-imp-graph-scale')) > 1, 1500,
        '缩放防抖未落盘');

      // 18. Canvas 降级
      document.querySelector('#impression-graph-toggle').click();
      window.HTMLCanvasElement.prototype.getContext = () => null;
      document.querySelector('#impression-graph-toggle').click();
      assert.ok(txt('#impression-body').includes('当前环境不支持 Canvas 绘制'));
      window.HTMLCanvasElement.prototype.getContext = () => fakeCtx;

      // 19. 群列表失败 + 图：错误可见、不白屏
      resetPages({ chats: [] });
      stubRules.push({ match: /^\/api\/chats$/, status: 500, body: { error: 'chats-down' }, once: true });
      window.__switchTab('mem-impression');
      await waitFor(() => I().chatsError, 4000, 'chatsError 未写入');
      await waitFor(() => I().basePeople.length > 0, 5000, '人物列表未就绪');
      await waitFor(() => canvasEl(), 6000, '默认星图未出现');
      await waitFor(() => txt('#impression-body').includes('读取会话列表失败：chats-down'), 5000, '图内未显示群列表错误');
      assert.ok(canvasEl(), '错误态星图白屏');
      document.querySelector('#impression-graph-toggle').click();
    } finally {
      window.HTMLCanvasElement.prototype.getContext = origGetContext;
      window.HTMLCanvasElement.prototype.getBoundingClientRect = origRect;
      try { Object.defineProperty(window, 'devicePixelRatio', { value: origDPR, configurable: true }); } catch { /* ignore */ }
      if (origMatchMedia === undefined) {
        try { delete window.matchMedia; } catch { /* ignore */ }
      } else {
        window.matchMedia = origMatchMedia;
      }
      window.Element.prototype.scrollIntoView = origSIV;
      const toggle = document.querySelector('#impression-graph-toggle');
      if (I().mode === 'graph' && toggle) toggle.click();
      assert.equal(I().mode, 'list', 'finally 未复位为列表');
      resetPages({ chats: [] });
    }
  });

} finally {
  await ctx.teardown();
  try { dom.window.close(); } catch { /* ignore */ }
  process.exit(c.finish() ? 0 : 1);
}
