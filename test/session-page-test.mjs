// P0-03 前端列表分页与停止全量重拉 —— 专项测试（对应施工单 §5.4 的 24 条）。
//
// 只加载 ui/app/02-sse-sessions.js 单段（顶层是函数声明 + 一个 startListPoller()），
// 用最小 stub 跑真实代码文本：不依赖真服务、不碰 data/。
//
// 关键设计：
//   - 假时钟：setTimeout/clearTimeout/Date.now 都由本文件控制，才测得出
//     "2 秒节流""60 秒补丁清理""5 秒首屏节流"这些时间条件；
//   - api 可切换"立即应答 / 挂起"两种模式，才测得出 reset 在途时的七条竞态。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'ui', 'app', '02-sse-sessions.js');
const srcText = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0, fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); }
};

// ── 假时钟 ──
let clock = 1_700_000_000_000;
const timers = new Map();
let timerSeq = 0;
const fakeSetTimeout = (fn, ms = 0) => {
  const id = ++timerSeq;
  const delay = Number(ms);
  timers.set(id, { fn, at: clock + (Number.isFinite(delay) ? delay : 0) });
  return id;
};
const fakeClearTimeout = (id) => { timers.delete(id); };
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(clock); }
  static now() { return clock; }
}
/** 推进假时钟并跑完到期定时器（中间让出微任务，让 async 回调落地）。 */
async function advance(ms) {
  const target = clock + ms;
  for (;;) {
    let pick = null;
    for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
    if (!pick) break;
    timers.delete(pick[0]);
    clock = pick[1].at;
    try { await pick[1].fn(); } catch { /* 回调异常不该中断时钟 */ }
    await flush(2);
  }
  clock = target;
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ── DOM 桩 ──
function makeEl(id = '') {
  return {
    id, dataset: {}, innerHTML: '', textContent: '', className: '',
    style: { setProperty() {}, removeProperty() {} }, children: [],
    _ev: {},
    addEventListener(t, fn) { (this._ev[t] ||= []).push(fn); },
    removeEventListener() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, closest() { return null; }, focus() {}, scrollIntoView() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
  };
}
const byId = new Map();
const $ = (sel) => {
  const key = String(sel).replace(/^#/, '');
  if (!byId.has(key)) byId.set(key, makeEl(key));
  return byId.get(key);
};

// ── EventSource 桩 ──
const handlers = new Map();
let esInst = null;
class FakeEventSource {
  constructor(url) { this.url = url; esInst = this; handlers.clear(); }
  addEventListener(type, fn) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
  }
  close() {}
}
const fire = (type, dataObj) => {
  const ev = { data: typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj) };
  for (const fn of (handlers.get(type) || [])) fn(ev);
};

// ── api 桩：立即应答 / 挂起两种模式 ──
const apiCalls = [];
const waiters = [];
let deferMode = false;
let pageProvider = () => ({ sessions: [], active: [], total: 0, totalFinished: 0, hasMore: false, nextCursor: null });
const callsTo = (re) => apiCalls.filter((p) => re.test(p));
let chatCalls = 0;
const detailCalls = [];

const sandbox = {};
const state = {
  tab: 'sessions',
  sessions: [],
  sessionActive: [],
  sessionTotal: 0,
  sessionTotalFinished: 0,
  sessionHasMore: false,
  sessionCursor: null,
  sessionLimit: 50,
  sessionsLoadedOnce: false,
  sessionsBootPromise: null,
  sessionsGeneration: 0,
  sessionsEventSeq: 0,
  sessionInflightSeqs: new Set(),
  sessionPatches: new Map(),
  sessionTombstones: new Map(),
  sseOpenedOnce: false,
  sseDisconnected: false,
  currentSessionId: null,
  unseenSessionIds: new Set(),
  seenSessionIds: new Set(),
  autoFollowRunning: false,
  config: { ui: { refreshMs: 15000 } }
};

const docHandlers = {};
const docStub = {
  hidden: false,
  getElementById: $,
  querySelector: $,
  querySelectorAll: () => [],
  addEventListener(type, fn) { (docHandlers[type] ||= []).push(fn); }
};

Object.assign(sandbox, {
  state,
  document: docStub,
  EventSource: FakeEventSource,
  URLSearchParams,
  Date: FakeDate,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  console: { log() {}, warn() {}, error() {} },
  $,
  $$: () => [],
  esc: (s) => String(s ?? ''),
  fmtTime: () => '00:00',
  fmtTokens: () => '0',
  formatChatTitle: (k, n) => n || k,
  chatNameOf: () => '群',
  STATUS_LABEL: { waiting: '等待中', running: '运行中', sent: '已发送', error: '失败', aborted: '中止' },
  SESSION_PAGE: 50,
  api: (p, opts) => {
    apiCalls.push(p);
    if (!deferMode) return Promise.resolve(pageProvider(p));
    return new Promise((resolve, reject) => waiters.push({ path: p, resolve, reject }));
  },
  // 01-boot.js 提供：详情 patch 合并 + 合批渲染
  pendingSessionDetail: new Map(),
  scheduleSessionRender: () => {},
  loadChats: async () => { chatCalls++; },
  refreshStatus: () => {},
  refreshSnowlumaLogs: () => {},
  scheduleSnowlumaReload: () => {},
  uiConfirm: async () => true,
  selectSession: null
});
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const code = srcText.replace(/^export\s+/gm, '');
const ctx = vm.createContext(sandbox);
new vm.Script(code, { filename: 'ui/app/02-sse-sessions.js' }).runInContext(ctx);
// loadSessionDetail 是受测段自己的函数（不是跨段依赖），这里包一层记录调用。
// 不能用 sandbox 里的同名 stub —— 函数声明会把 sandbox 属性遮住。
vm.runInContext(
  'loadSessionDetail = async (id) => { __ldCalls.push(id); };',
  Object.assign(ctx, { __ldCalls: detailCalls })
);

const resetState = () => {
  state.sessions = [];
  state.sessionActive = [];
  state.sessionTotal = 0;
  state.sessionTotalFinished = 0;
  state.sessionHasMore = false;
  state.sessionCursor = null;
  state.sessionLimit = 50;
  state.sessionsLoadedOnce = false;
  state.sessionsBootPromise = null;
  state.sessionsGeneration = 0;
  state.sessionsEventSeq = 0;
  state.sessionInflightSeqs = new Set();
  state.sessionPatches = new Map();
  state.sessionTombstones = new Map();
  state.sseOpenedOnce = false;
  state.sseDisconnected = false;
  state.currentSessionId = null;
  state.unseenSessionIds = new Set();
  state.seenSessionIds = new Set();
  state.autoFollowRunning = false;
  apiCalls.length = 0;
  detailCalls.length = 0;
  chatCalls = 0;
  waiters.length = 0;
  deferMode = false;
  pageProvider = () => ({ sessions: [], active: [], total: 0, totalFinished: 0, hasMore: false, nextCursor: null });
};
const row = (id, status, startedAt) => ({ id, chatKey: 'group:1', status, startedAt, trigger: id });

ctx.connectSSE();
check('连接已注册 session-start / session-end / session-update / chat-update 监听',
  ['session-start', 'session-end', 'session-update', 'chat-update'].every((t) => (handlers.get(t) || []).length > 0));
check('已注册 visibilitychange 监听（全仓此前 0 命中）', (docHandlers.visibilitychange || []).length === 1);

// ══ 1. 首屏只发一次 limit=200 ══
resetState();
pageProvider = () => ({ sessions: [row('a', 'sent', 100)], active: [], total: 1, totalFinished: 1, hasMore: false, nextCursor: null });
await Promise.all([ctx.loadSessions(), ctx.loadSessions({ quiet: true })]);
await flush();
check('1a. 首屏请求带 limit=200', apiCalls.length === 1 && /limit=200/.test(apiCalls[0]), JSON.stringify(apiCalls));
check('1b. 并发两次调用只发一次请求（sessionsBootPromise 去重）', apiCalls.length === 1, String(apiCalls.length));
check('1c. 成功后 sessionsLoadedOnce 置位', state.sessionsLoadedOnce === true);

// ══ 2. boot 与 onopen 不重复拉 ══
resetState();
pageProvider = () => ({ sessions: [row('a', 'sent', 100)], active: [], total: 1, totalFinished: 1, hasMore: false, nextCursor: null });
await ctx.loadSessions();
await flush();
const afterBoot = apiCalls.length;
esInst.onopen();                       // 首次连接：boot 已成功 → 跳过
await advance(10);
check('2. 首次 onopen 不重复拉第一页', apiCalls.length === afterBoot, `${afterBoot} -> ${apiCalls.length}`);

// ══ 3. session-start 不发列表请求 ══
resetState();
apiCalls.length = 0;
fire('session-start', { sessionId: 's1', status: 'running', startedAt: 200 });
await advance(300);
check('3. session-start 不发 /api/sessions', callsTo(/\/api\/sessions/).length === 0, JSON.stringify(apiCalls));
check('3b. session-start 落入 sessionActive 而非已完成', state.sessionActive.length === 1 && state.sessions.length === 0);

// ══ 4. 普通 session-end 不发列表请求 ══
apiCalls.length = 0;
fire('session-end', { sessionId: 's1', status: 'sent', startedAt: 200, sent: [{ text: 'x' }] });
await advance(300);
check('4. 普通 session-end 不发 /api/sessions', callsTo(/\/api\/sessions/).length === 0, JSON.stringify(apiCalls));
check('4b. 结束后从 active 移到已完成', state.sessionActive.length === 0 && state.sessions.length === 1);

// ══ 5. chat-update 不发会话列表请求 ══
apiCalls.length = 0;
state.tab = 'sessions';
fire('chat-update', {});
await advance(2500);
check('5. chat-update 在会话页不发 /api/sessions', callsTo(/\/api\/sessions/).length === 0, JSON.stringify(apiCalls));

// ══ 6. document.hidden 不发列表请求；可见时才发 ══
resetState();
state.tab = 'chats';
docStub.hidden = true;
apiCalls.length = 0;
chatCalls = 0;
fire('chat-update', {});
await advance(2500);
check('6a. 隐藏时 chat-update 不拉存档列表', chatCalls === 0, String(chatCalls));
docStub.hidden = false;
fire('chat-update', {});
await advance(2500);
check('6b. 可见时 chat-update 走 2 秒节流拉一次存档列表', chatCalls === 1, String(chatCalls));
// 2 秒节流：同一窗口内的多次 chat-update 只拉一次
fire('chat-update', {});
fire('chat-update', {});
await advance(1900);
check('6c. 2 秒节流窗口内不再重复拉', chatCalls === 1, String(chatCalls));
await advance(200);
check('6d. 超过 2 秒后才再拉一次', chatCalls === 2, String(chatCalls));

// ══ 7. 滚动加载第二页无重复 ══
resetState();
let pageNo = 0;
pageProvider = (p) => {
  pageNo++;
  if (/beforeId/.test(p)) {
    return { sessions: [row('c', 'sent', 300), row('b', 'sent', 200)], active: [], total: 4, totalFinished: 4, hasMore: false, nextCursor: null };
  }
  return { sessions: [row('b', 'sent', 200), row('a', 'sent', 100)], active: [], total: 4, totalFinished: 4, hasMore: true, nextCursor: { beforeTs: 100, beforeId: 'a' } };
};
await ctx.loadSessions();
await flush();
const beforeMore = apiCalls.length;
await ctx.loadMoreSessions();
await flush();
const ids = state.sessions.map((s) => s.id);
check('7a. 续页请求带游标', /beforeTs=100/.test(apiCalls[beforeMore] || '') && /beforeId=a/.test(apiCalls[beforeMore] || ''), apiCalls[beforeMore]);
check('7b. 追加后无重复 id', new Set(ids).size === ids.length, JSON.stringify(ids));
check('7c. 第二页内容已追加', ids.includes('c'), JSON.stringify(ids));
check('7d. hasMore 回写为 false 且游标清空', state.sessionHasMore === false && state.sessionCursor === null);
check('7e. 渲染窗口按 SESSION_PAGE 增长（50 → 100，不是直接铺到 200）', state.sessionLimit === 100, String(state.sessionLimit));

// ══ 8. 列表分母用 totalFinished（active 不进分数） ══
resetState();
state.sessions = [row('f1', 'sent', 50), row('f2', 'sent', 40)];
state.sessionActive = [row('a1', 'running', 900), row('a2', 'waiting', 800)];
state.sessionTotalFinished = 2;
state.sessionTotal = 4;
ctx.renderSessionList();
const cntText = String($('session-count').textContent || '');
check('8a. active 存在时分子分母都只数已完成（不出现 2/4 这类混算）', cntText.startsWith('2/2'), cntText);
check('8b. active 单独标注"运行中"', /\+2 运行中/.test(cntText), cntText);
// 分母是 totalFinished 而不是"本地已加载条数"：给 120 条已完成、窗口只开 60
state.sessions = Array.from({ length: 120 }, (_, i) => row(`n${i}`, 'sent', 1000 - i));
state.sessionTotalFinished = 120;
state.sessionTotal = 122;
state.sessionLimit = 60;
ctx.renderSessionList();
const cntText2 = String($('session-count').textContent || '');
check('8c. 渲染窗口小于总数时显示 60/120', cntText2.startsWith('60/120'), cntText2);
check('8d. 底部"还有 N 条"用 totalFinished 差', /还有 60 条/.test(String($('session-more').textContent || '')), String($('session-more').textContent));
check('8e. 不出现 finishedShown > totalFinished', Number(cntText2.split('/')[0]) <= Number(cntText2.split('/')[1].split(' ')[0]), cntText2);
state.sessionTotalFinished = 0;
state.sessionLimit = 50;
ctx.renderSessionList();
check('8f. totalFinished 为 0 时不显示分数', String($('session-count').textContent || '') === '+2 运行中', String($('session-count').textContent));

// ══ 9. active 会话置顶可见 ══
resetState();
state.sessions = [row('f1', 'sent', 100)];
state.sessionActive = [row('a1', 'running', 200)];
state.sessionTotalFinished = 1;
ctx.renderSessionList();
const html9 = String($('session-items').innerHTML || '');
check('9. active 行排在已完成行之前', html9.indexOf('data-id="a1"') >= 0 && html9.indexOf('data-id="a1"') < html9.indexOf('data-id="f1"'));

// ══ 10. deleted：条目消失 + 未读点清理 ══
resetState();
state.sessions = [row('x', 'sent', 100), row('y', 'sent', 90)];
state.sessionTotal = 2;
state.sessionTotalFinished = 2;
state.unseenSessionIds = new Set(['x', 'y']);
state.tab = 'usage';
fire('session-end', { sessionId: 'x', status: 'deleted' });
await flush();
check('10a. deleted 后列表移除该条', !state.sessions.some((s) => s.id === 'x'), JSON.stringify(state.sessions.map((s) => s.id)));
check('10b. deleted 后未读集合不再含该 id', !state.unseenSessionIds.has('x'), [...state.unseenSessionIds].join(','));
check('10c. deleted 计数各 −1', state.sessionTotal === 1 && state.sessionTotalFinished === 1, `${state.sessionTotal}/${state.sessionTotalFinished}`);
check('10d. deleted 写了 tombstone', state.sessionTombstones.has('x'));

// ══ 11. cleared：reset + 清空未读，不写 tombstone ══
resetState();
state.sessions = [row('x', 'sent', 100)];
state.sessionTotal = 1;
state.sessionTotalFinished = 1;
state.unseenSessionIds = new Set(['x']);
pageProvider = () => ({ sessions: [], active: [], total: 0, totalFinished: 0, hasMore: false, nextCursor: null });
apiCalls.length = 0;
const genBefore = state.sessionsGeneration;
fire('session-end', { status: 'cleared', removed: 1 });
await flush();
check('11a. cleared 触发一次 reset 请求', callsTo(/\/api\/sessions/).length === 1, JSON.stringify(apiCalls));
check('11b. cleared 清空未读集合', state.unseenSessionIds.size === 0);
check('11c. cleared 递增代际', state.sessionsGeneration === genBefore + 1);
check('11d. cleared 不写 tombstone', state.sessionTombstones.size === 0);
check('11e. cleared 不解析 removed（列表以服务端为准）', state.sessions.length === 0);

// ══ 12. discarded：当前详情清空 ══
resetState();
state.sessions = [row('d1', 'sent', 100)];
state.sessionTotal = 2;
state.sessionTotalFinished = 2;
state.sessionActive = [row('d2', 'waiting', 200)];
state.currentSessionId = 'd2';
state.sessionDetail = { id: 'd2' };
$('session-detail').innerHTML = '<div>旧内容</div>';
fire('session-end', { sessionId: 'd2', status: 'discarded', discarded: true });
await flush();
check('12a. discarded 后当前会话被取消选中', state.currentSessionId === null);
check('12b. discarded 后详情区显示空提示', /选择左侧会话/.test(String($('session-detail').innerHTML || '')));
check('12c. discarded 只回退 total（active 行）', state.sessionTotal === 1 && state.sessionTotalFinished === 2, `${state.sessionTotal}/${state.sessionTotalFinished}`);

// ══ 13. 删除/清空入口不再额外发全量请求（源码契约） ══
const delBlock = srcText.slice(srcText.indexOf('确定删除这条会话记录'), srcText.indexOf('if (firstRender || (s.status === \'running\''));
check('13a. 删除按钮 handler 里不再出现 loadSessions', !/loadSessions\(/.test(delBlock));
check('13b. 删除按钮 handler 走本地移除 + tombstone', /removeSessionById\(/.test(delBlock) && /addSessionTombstone\(/.test(delBlock));
const feedbackSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app', '10-feedback.js'), 'utf8');
const clearBlock = feedbackSrc.slice(feedbackSrc.indexOf('// 会话列表「清空」'), feedbackSrc.indexOf('// 会话列表「群发」'));
check('13c. 清空按钮 handler 里不再出现 loadSessions', !/loadSessions\(/.test(clearBlock));

// ══ 14. loadSessions({quiet:true}) 调用点仍能正常工作 ══
resetState();
pageProvider = () => ({ sessions: [row('q', 'sent', 100)], active: [], total: 1, totalFinished: 1, hasMore: false, nextCursor: null });
await ctx.loadSessions({ quiet: true });
await flush();
check('14. quiet 调用仍会 reset 第一页并落地', state.sessions.length === 1 && state.sessions[0].id === 'q');

// ══ 15. SESSION_KEEP 裁剪逻辑已不存在 ══
check('15a. 源码里没有 SESSION_KEEP 引用', !/SESSION_KEEP/.test(srcText));
check('15b. 源码里没有 slice(0, SESSION_KEEP) 式硬裁剪', !/slice\(0,\s*SESSION_KEEP\)/.test(srcText));
const coreSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app', '00-core.js'), 'utf8');
check('15c. 00-core.js 不再定义 SESSION_KEEP', !/const\s+SESSION_KEEP/.test(coreSrc));

// ══ 16. 计数转移表（先判位置再迁移） ══
resetState();
const inv = () => state.sessionTotalFinished + state.sessionActive.length === state.sessionTotal;
fire('session-start', { sessionId: 'k1', status: 'running', startedAt: 100 });
check('16a. 新 start：total+1、finished 不变', state.sessionTotal === 1 && state.sessionTotalFinished === 0, `${state.sessionTotal}/${state.sessionTotalFinished}`);
check('16a2. 不变量成立', inv());
fire('session-end', { sessionId: 'k1', status: 'sent', startedAt: 100 });
check('16b. active→终态：只 +finished、total 不变', state.sessionTotal === 1 && state.sessionTotalFinished === 1, `${state.sessionTotal}/${state.sessionTotalFinished}`);
fire('session-end', { sessionId: 'k2', status: 'sent', startedAt: 90 });
check('16c. 未知终态 end：两者各 +1', state.sessionTotal === 2 && state.sessionTotalFinished === 2, `${state.sessionTotal}/${state.sessionTotalFinished}`);
check('16c2. 不变量成立', inv());
fire('session-update', { sessionId: 'k3', status: 'running', startedAt: 110 });
check('16d. 未知 active update：只 +total', state.sessionTotal === 3 && state.sessionTotalFinished === 2, `${state.sessionTotal}/${state.sessionTotalFinished}`);
check('16d2. 不变量成立', inv());
fire('session-end', { sessionId: 'k3', status: 'deleted' });
check('16e. 删除 active 行：只 −total', state.sessionTotal === 2 && state.sessionTotalFinished === 2, `${state.sessionTotal}/${state.sessionTotalFinished}`);
check('16e2. 不变量成立', inv());
fire('session-end', { sessionId: 'k2', status: 'deleted' });
check('16f. 删除 finished 行：两者各 −1', state.sessionTotal === 1 && state.sessionTotalFinished === 1, `${state.sessionTotal}/${state.sessionTotalFinished}`);
check('16f2. 不变量成立', inv());
// 重复事件不重复加减
fire('session-end', { sessionId: 'k2', status: 'deleted' });
check('16g. 重复 deleted 不再扣减', state.sessionTotal === 1 && state.sessionTotalFinished === 1, `${state.sessionTotal}/${state.sessionTotalFinished}`);
// 普通 end 若移除前是 active，必须走 active→终态，不能走插入行
resetState();
state.sessionActive = [row('m1', 'running', 100)];
state.sessionTotal = 1;
fire('session-end', { sessionId: 'm1', status: 'sent', startedAt: 100 });
check('16h. 普通 end 在移除前是 active → 只 +finished（不当成插入 +1/+1）',
  state.sessionTotal === 1 && state.sessionTotalFinished === 1, `${state.sessionTotal}/${state.sessionTotalFinished}`);

// ══ 17. 重试事件：真实 session-update 把已完成 id 移到 active ══
resetState();
state.sessions = [row('r1', 'error', 100)];
state.sessionTotal = 1;
state.sessionTotalFinished = 1;
fire('session-update', { sessionId: 'r1', status: 'running', startedAt: 100 });
check('17a. 终态→active：从已完成移除', !state.sessions.some((s) => s.id === 'r1'));
check('17b. 终态→active：写入 active', state.sessionActive.some((s) => s.id === 'r1'));
check('17c. 分母 −1、total 不变', state.sessionTotal === 1 && state.sessionTotalFinished === 0, `${state.sessionTotal}/${state.sessionTotalFinished}`);
check('17d. 不重复（active 里只有一条）', state.sessionActive.length === 1);
check('17e. 不变量成立', state.sessionTotalFinished + state.sessionActive.length === state.sessionTotal);

// ══ 18. 在途竞态（a–g 七条） ══
// 18a：reset 在途时 deleted，旧快照不得复活该 id
resetState();
deferMode = true;
pageProvider = () => ({ sessions: [row('x', 'sent', 100)], active: [], total: 1, totalFinished: 1, hasMore: false, nextCursor: null });
const p18a = ctx.loadSessions();
await flush(1);
fire('session-end', { sessionId: 'x', status: 'deleted' });
check('18a0. 补丁已记录（请求在途）', state.sessionPatches.size >= 1, String(state.sessionPatches.size));
waiters.shift().resolve({ sessions: [row('x', 'sent', 100)], active: [], total: 1, totalFinished: 1, hasMore: false, nextCursor: null });
await p18a; await flush();
check('18a. 旧快照不复活已删除 id', !state.sessions.some((s) => s.id === 'x') && !state.sessionActive.some((s) => s.id === 'x'),
  JSON.stringify(state.sessions.map((s) => s.id)));
deferMode = false;

// 18b：reset 在途时普通 end，旧快照里的 active 行必须被改回终态
resetState();
deferMode = true;
const p18b = ctx.loadSessions();
await flush(1);
fire('session-end', { sessionId: 'y', status: 'sent', startedAt: 200 });
waiters.shift().resolve({ sessions: [], active: [row('y', 'running', 200)], total: 1, totalFinished: 0, hasMore: false, nextCursor: null });
await p18b; await flush();
check('18b. 旧快照里的 active 行被补丁改回终态（不复活成 running）',
  state.sessionActive.length === 0 && state.sessions.some((s) => s.id === 'y' && s.status === 'sent'),
  JSON.stringify({ active: state.sessionActive.map((s) => s.id), fin: state.sessions.map((s) => s.id) }));
check('18b2. 计数：total 1 / finished 1', state.sessionTotal === 1 && state.sessionTotalFinished === 1, `${state.sessionTotal}/${state.sessionTotalFinished}`);
deferMode = false;

// 18c：reset 在途时新 id 的 start，旧快照不含它 → 补丁必须放回 active
resetState();
deferMode = true;
const p18c = ctx.loadSessions();
await flush(1);
fire('session-start', { sessionId: 'z', status: 'running', startedAt: 300 });
waiters.shift().resolve({ sessions: [], active: [], total: 0, totalFinished: 0, hasMore: false, nextCursor: null });
await p18c; await flush();
check('18c. 窗口内新建的会话不丢失（回到 active）', state.sessionActive.some((s) => s.id === 'z'), JSON.stringify(state.sessionActive.map((s) => s.id)));
check('18c2. 计数 total 1', state.sessionTotal === 1 && state.sessionTotalFinished === 0, `${state.sessionTotal}/${state.sessionTotalFinished}`);
deferMode = false;

// 18d：loadMore 在途时 reset，旧页不得追加
resetState();
pageProvider = () => ({ sessions: [row('p1', 'sent', 500)], active: [], total: 3, totalFinished: 3, hasMore: true, nextCursor: { beforeTs: 500, beforeId: 'p1' } });
await ctx.loadSessions();
await flush();
state.sessionHasMore = true;
state.sessionCursor = { beforeTs: 500, beforeId: 'p1' };
deferMode = true;
const p18d = ctx.loadMoreSessions();
await flush(1);
// 期间 reset：代际递增（这里用真实 loadSessions 触发，但它的请求也挂起）
const p18dReset = ctx.loadSessions();
await flush(1);
// 先让 loadMore 的响应回来（此时代际已变）
const moreWaiter = waiters.shift();
moreWaiter.resolve({ sessions: [row('old', 'sent', 10)], active: [], total: 3, totalFinished: 3, hasMore: false, nextCursor: null });
await p18d; await flush();
check('18d. 在途旧页被代际丢弃，不追加', !state.sessions.some((s) => s.id === 'old'), JSON.stringify(state.sessions.map((s) => s.id)));
// 收尾：resolve reset
waiters.shift().resolve({ sessions: [row('p1', 'sent', 500)], active: [], total: 1, totalFinished: 1, hasMore: false, nextCursor: null });
await p18dReset; await flush();
deferMode = false;

// 18e：同一新 id 窗口内先 start 后 end（旧快照两个都不含）
resetState();
deferMode = true;
const p18e = ctx.loadSessions();
await flush(1);
fire('session-start', { sessionId: 'w', status: 'running', startedAt: 400 });
fire('session-end', { sessionId: 'w', status: 'sent', startedAt: 400 });
check('18e0. 同 id 两条补丁各存一条（不能互相覆盖）', state.sessionPatches.size === 2, String(state.sessionPatches.size));
waiters.shift().resolve({ sessions: [], active: [], total: 0, totalFinished: 0, hasMore: false, nextCursor: null });
await p18e; await flush();
check('18e. 会话出现在已完成列表', state.sessions.some((s) => s.id === 'w'), JSON.stringify(state.sessions.map((s) => s.id)));
check('18e2. 不残留在 active', !state.sessionActive.some((s) => s.id === 'w'));
check('18e3. total+1 且 finished+1', state.sessionTotal === 1 && state.sessionTotalFinished === 1, `${state.sessionTotal}/${state.sessionTotalFinished}`);
check('18e4. 不重复', state.sessions.filter((s) => s.id === 'w').length === 1);
deferMode = false;

// 18f：reset 在途超过 60 秒，期间的补丁不得被清理；结束后才按 60 秒清理
resetState();
deferMode = true;
const p18f = ctx.loadSessions();
await flush(1);
for (let i = 0; i < 3; i++) fire('session-start', { sessionId: `f${i}`, status: 'running', startedAt: 700 + i });
const patchCount = state.sessionPatches.size;
check('18f0. 在途期间记录 3 条补丁', patchCount === 3, String(patchCount));
await advance(120_000);            // 请求仍然挂着
check('18f. 慢请求在途时补丁不被清理', state.sessionPatches.size === patchCount, String(state.sessionPatches.size));
waiters.shift().resolve({ sessions: [], active: [], total: 0, totalFinished: 0, hasMore: false, nextCursor: null });
await p18f; await flush();
check('18f2. 请求结束后按 60 秒清理（在途期间的旧补丁被清掉）', state.sessionPatches.size === 0, String(state.sessionPatches.size));
check('18f3. 在途 seq 已从集合删除', state.sessionInflightSeqs.size === 0, String(state.sessionInflightSeqs.size));
deferMode = false;

// 18g：重放只应用、不新增
resetState();
deferMode = true;
const p18g = ctx.loadSessions();
await flush(1);
fire('session-start', { sessionId: 'g1', status: 'running', startedAt: 800 });
const sizeBefore = state.sessionPatches.size;
const seqBefore = state.sessionsEventSeq;
waiters.shift().resolve({ sessions: [], active: [], total: 0, totalFinished: 0, hasMore: false, nextCursor: null });
await p18g; await flush();
check('18g. 重放前后 sessionPatches.size 不变（重放不写回补丁）', state.sessionPatches.size === sizeBefore, `${sizeBefore} -> ${state.sessionPatches.size}`);
check('18g2. 重放不递增 sessionsEventSeq', state.sessionsEventSeq === seqBefore, `${seqBefore} -> ${state.sessionsEventSeq}`);
check('18g3. 重放确实生效（g1 在 active）', state.sessionActive.some((s) => s.id === 'g1'));
deferMode = false;

// ══ 18h. cleared 落在首屏 reset 在途 ══
resetState();
state.unseenSessionIds = new Set(['u1']);
deferMode = true;
pageProvider = () => ({ sessions: [row('stale', 'sent', 100)], active: [], total: 1, totalFinished: 1, hasMore: false, nextCursor: null });
const p18h = ctx.loadSessions({ quiet: true });
await flush(1);
check('18h0. 首屏请求在途', state.sessionsBootPromise !== null && waiters.length === 1, 'waiters=' + waiters.length);
const genBefore18h = state.sessionsGeneration;
fire('session-end', { status: 'cleared', removed: 1 });
await flush(1);
check('18h1. cleared 即使 boot 在途也递增代际', state.sessionsGeneration === genBefore18h + 1, genBefore18h + ' -> ' + state.sessionsGeneration);
check('18h2. cleared 清空未读集合', state.unseenSessionIds.size === 0, String(state.unseenSessionIds.size));
const staleW18h = waiters.shift();
staleW18h.resolve({ sessions: [row('stale', 'sent', 100)], active: [], total: 1, totalFinished: 1, hasMore: false, nextCursor: null });
await p18h; await flush(2);
check('18h3. 旧快照未复活已清空行', state.sessions.length === 0, JSON.stringify(state.sessions.map((s) => s.id)));
check('18h4. 旧请求结束后补发一页', waiters.length === 1 && apiCalls.length === 2, 'waiters=' + waiters.length + ', api=' + apiCalls.length);
const freshW18h = waiters.shift();
if (freshW18h) freshW18h.resolve({ sessions: [], active: [], total: 0, totalFinished: 0, hasMore: false, nextCursor: null });
await flush(3);
check('18h5. 补发页落地且列表为空', state.sessions.length === 0 && state.sessionTotal === 0 && state.sessionTotalFinished === 0,
  JSON.stringify({ n: state.sessions.length, total: state.sessionTotal, fin: state.sessionTotalFinished }));
check('18h6. boot promise 已清空', state.sessionsBootPromise === null);
deferMode = false;
// ══ 19. boot 失败：标志不置位、promise 清空、onopen 能补拉 ══
resetState();
deferMode = true;
const p19 = ctx.loadSessions();
await flush(1);
waiters.shift().reject(new Error('boom'));
await p19; await flush();
check('19a. 失败后 sessionsLoadedOnce 仍为 false', state.sessionsLoadedOnce === false);
check('19b. 失败后 sessionsBootPromise 清空', state.sessionsBootPromise === null);
check('19c. 失败后不在途 seq 残留', state.sessionInflightSeqs.size === 0);
deferMode = false;
pageProvider = () => ({ sessions: [row('ok', 'sent', 100)], active: [], total: 1, totalFinished: 1, hasMore: false, nextCursor: null });
esInst.onopen();
await flush();
check('19d. onopen 补拉成功并落地', state.sessionsLoadedOnce === true && state.sessions.some((s) => s.id === 'ok'));
check('19e. 补拉只发一次', apiCalls.length === 2, JSON.stringify(apiCalls));

// ══ 20. hidden→visible ══
resetState();
state.tab = 'sessions';
docStub.hidden = false;
apiCalls.length = 0;
chatCalls = 0;
pageProvider = () => ({ sessions: [], active: [], total: 0, totalFinished: 0, hasMore: false, nextCursor: null });
await advance(6000);                   // 越过上一轮留下的 5 秒首屏节流窗口
for (const fn of docHandlers.visibilitychange) fn();
await flush();
check('20a. 会话页恢复可见补第一页', callsTo(/\/api\/sessions/).length === 1, JSON.stringify(apiCalls));
check('20b. 恢复可见同时补存档列表', chatCalls === 1, String(chatCalls));
apiCalls.length = 0;
chatCalls = 0;
for (const fn of docHandlers.visibilitychange) fn();   // 5 秒内重复触发
await flush();
check('20c. 5 秒内重复恢复可见只拉一次第一页', callsTo(/\/api\/sessions/).length === 0, JSON.stringify(apiCalls));
state.tab = 'chats';
chatCalls = 0;
for (const fn of docHandlers.visibilitychange) fn();
await flush();
check('20d. 存档页恢复可见至少补 chats', chatCalls === 1, String(chatCalls));
docStub.hidden = false;

// ══ 21. autoFollow 查 sessionActive ══
resetState();
state.autoFollowRunning = true;
state.currentSessionId = null;
pageProvider = () => ({ sessions: [row('fin', 'sent', 100)], active: [row('act', 'running', 200)], total: 2, totalFinished: 1, hasMore: false, nextCursor: null });
await ctx.loadSessions();
await flush();
check('21. autoFollow 选中 active 的第一条（state.sessions 不含 active）', detailCalls[0] === 'act', JSON.stringify(detailCalls));

// ══ 22. 当前打开的是 active 会话 → 仍刷新详情 ══
resetState();
state.autoFollowRunning = false;
state.currentSessionId = 'act';
pageProvider = () => ({ sessions: [row('fin', 'sent', 100)], active: [row('act', 'running', 200)], total: 2, totalFinished: 1, hasMore: false, nextCursor: null });
await ctx.loadSessions();
await flush();
check('22. 当前打开 active 会话时触发 loadSessionDetail', detailCalls.includes('act'), JSON.stringify(detailCalls));

// ══ 23. 清空确认文案口径 ══
const totalExpr = (feedbackSrc.match(/const total = ([\s\S]*?);\n\s*const running = ([\s\S]*?);/) || [])[1];
const runningExpr = (feedbackSrc.match(/const total = ([\s\S]*?);\n\s*const running = ([\s\S]*?);/) || [])[2];
check('23a. 文案口径表达式可提取', !!totalExpr && !!runningExpr);
if (totalExpr && runningExpr) {
  const evalWith = (st) => new Function('state', `return [${totalExpr}, ${runningExpr}];`)(st);
  const [t1, r1] = evalWith({ sessionTotal: 15000, sessions: new Array(200).fill({ status: 'sent' }), sessionActive: [{ status: 'running' }] });
  check('23b. total 用 sessionTotal（不是已加载的 200）', t1 === 15000, String(t1));
  check('23c. running 用 sessionActive 长度', r1 === 1, String(r1));
  const [t2, r2] = evalWith({ sessions: [{}, {}], sessionActive: [{}] });
  check('23d. sessionTotal 缺失时回退两数组之和', t2 === 3, String(t2));
  check('23e. 回退时 running 仍为 1', r2 === 1, String(r2));
}

// ══ 24. session-update 命中 active：只 patch 该数组 ══
resetState();
state.sessionActive = [row('a9', 'running', 100)];
state.sessionTotal = 1;
fire('session-update', { sessionId: 'a9', status: 'running', activity: '正在思考…', rounds: 3, startedAt: 100 });
check('24a. 命中 active 时不往已完成里插重复条目', state.sessions.length === 0, String(state.sessions.length));
check('24b. active 行被就地更新', state.sessionActive.length === 1
  && state.sessionActive[0].activity === '正在思考…' && state.sessionActive[0].rounds === 3);
check('24c. 计数不变', state.sessionTotal === 1 && state.sessionTotalFinished === 0, `${state.sessionTotal}/${state.sessionTotalFinished}`);
// 两个数组都没有才插入，且按 status 落到对应一边
fire('session-update', { sessionId: 'b9', status: 'error', startedAt: 90 });
check('24d. 两边都没有时按 status 插入已完成', state.sessions.some((s) => s.id === 'b9'));
check('24e. 插入终态：两者各 +1', state.sessionTotal === 2 && state.sessionTotalFinished === 1, `${state.sessionTotal}/${state.sessionTotalFinished}`);

console.log('\n会话列表分页（P0-03）：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
