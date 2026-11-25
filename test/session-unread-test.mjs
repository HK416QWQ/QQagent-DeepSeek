// 会话列表「选中不被顶掉 + 新会话未读点」回归测试。
//
// 背景（2026-11-09 UI 四项修复 · 问题 1）：
//   用户正在看某条历史会话时，来了一条新会话 —— 原先 session-start 处理器无条件
//   调 selectSession(active.id)，右侧详情被顶掉，用户正在读的内容消失。
//   修法是加守卫 `!state.currentSessionId`。但这条守卫的代价是：**不再自动跳转**，
//   新消息在左侧列表里没有任何持久痕迹（.new-item 只是几百毫秒的淡入动画）。
//   所以同一批改动里补了 .session-unread-dot（点开即消）。
//
// 为什么单独写这个文件：问题 1 是"少一个判断"型 bug，回归时不会报错、只会行为变回去，
// 没有任何断言盯着它 —— 当初就是这么悄悄坏掉的。这里只加载 02-sse-sessions.js 单段
// （它顶层只有函数声明 + 一个 startListPoller()），用最小 stub 跑真实代码文本，
// 不依赖真服务、不碰 data/。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); }
};

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

// ── EventSource 桩：把 handler 存下来手动触发 ──
const handlers = new Map();
class FakeEventSource {
  constructor(url) { this.url = url; handlers.clear(); }
  addEventListener(type, fn) { (handlers.get(type) || handlers.set(type, []).get(type)).push(fn); }
  close() {}
}
const fire = (type, dataObj) => {
  const ev = { data: typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj) };
  for (const fn of (handlers.get(type) || [])) fn(ev);
};

// ── 受测代码的运行环境 ──
const selected = [];           // selectSession 调用记录
// P0-03 口径：state.sessions 只存已完成，state.sessionActive 只存 running/waiting。
// 夹具必须分开给，否则自动跟随（查 sessionActive）走不到 selectSession。
const state = {
  tab: 'usage',                // 不是 sessions：避免 selectSession 里触发详情渲染
  sessions: [
    { id: 'old', chatKey: 'group:3', status: 'sent', startedAt: 1000, trigger: 'c' }
  ],
  sessionActive: [
    // s1 的 startedAt 最大 → active[0]，即"最新一条"，与真实场景一致
    { id: 's1', chatKey: 'group:1', status: 'waiting', startedAt: 5000, trigger: 'a' },
    { id: 's2', chatKey: 'group:2', status: 'running', startedAt: 3000, trigger: 'b' }
  ],
  sessionTotal: 3,
  sessionTotalFinished: 1,
  sessionHasMore: false,
  sessionCursor: null,
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
  autoFollowRunning: true,
  sessionLimit: 30,
  config: { ui: { refreshMs: 15000 } }
};

const sandbox = {
  state,
  document: {
    hidden: false,
    getElementById: $,
    querySelector: $,
    querySelectorAll: () => [],
    addEventListener() {}          // visibilitychange 已在受测段里注册
  },
  EventSource: FakeEventSource,
  URLSearchParams,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  console,
  // 跨段依赖（00-core 等提供），这里给最小实现
  $, $$: () => [],
  esc: (s) => String(s ?? ''),
  // loadSessions 会真的调 api('/api/sessions?...')，必须回真实形状，
  // 否则 state.sessionActive 被覆盖成 []，"自动跟随"这条根本走不到 selectSession。
  api: async () => ({
    sessions: state.sessions,
    active: state.sessionActive,
    total: state.sessionTotal,
    totalFinished: state.sessionTotalFinished,
    hasMore: false,
    nextCursor: null
  }),
  fmtTime: () => '00:00',
  fmtTokens: () => '0',
  formatChatTitle: (k, n) => n || k,
  chatNameOf: () => '群',
  SESSION_PAGE: 30,
  STATUS_LABEL: { waiting: '等待中', running: '运行中', sent: '已发送', error: '失败' },
  scheduleListReload: () => {},
  loadChats: async () => {},
  loadSessionDetail: async () => {},
  refreshStatus: () => {},
  refreshSnowlumaLogs: () => {},
  scheduleSnowlumaReload: () => {},
  uiConfirm: async () => true,
  window: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const code = fs.readFileSync(path.join(ROOT, 'ui', 'app', '02-sse-sessions.js'), 'utf8')
  .replace(/^export\s+/gm, '');
const ctx = vm.createContext(sandbox);
new vm.Script(code, { filename: 'ui/app/02-sse-sessions.js' }).runInContext(ctx);
// selectSession 是受测段自己的函数，包一层记录调用（不改逻辑）
ctx.__select = ctx.selectSession;
vm.runInContext('selectSession = async (id) => { __calls.push(id); return __select(id); };', Object.assign(ctx, { __calls: selected }));

ctx.connectSSE();
check('connectSSE 已注册 session-start 监听', (handlers.get('session-start') || []).length > 0);

// ── 1. 未选中任何会话：仍然自动跟随（新方案不能把跟随一起废掉）──
state.currentSessionId = null;
fire('session-start', { sessionId: 's1' });
await new Promise((r) => setImmediate(r));
check('1. 未选中时自动跟随新会话（selectSession(s1)）', selected.includes('s1'), JSON.stringify(selected));

// ── 2. 已选中旧会话：不许顶掉 + 必须打未读点 ──
// 断言"一次都不能调 selectSession"，而不是"没选中 s2"：
// active 是列表里第一个 waiting/running 的会话（不一定是刚 start 的那条），
// 只盯 s2 的话，守卫被删掉时它会去选 s1 —— 测试照样绿，等于没测。
selected.length = 0;
state.currentSessionId = 'old';
fire('session-start', { sessionId: 's2' });
await new Promise((r) => setImmediate(r));
check('2a. 已选中会话时不会被新会话顶掉（selectSession 零调用）', selected.length === 0, JSON.stringify(selected));
check('2b. 新会话被标为未读', state.unseenSessionIds.has('s2'), [...state.unseenSessionIds].join(','));
check('2c. 正在看的会话不会被打点', !state.unseenSessionIds.has('old'), [...state.unseenSessionIds].join(','));

// ── 3. 同一个会话正在看：再报一次 start 不该打点 ──
state.currentSessionId = 's2';
fire('session-start', { sessionId: 's2' });
await new Promise((r) => setImmediate(r));
check('3. 正在看的会话重复 start 不打点', !state.unseenSessionIds.has('s2'), [...state.unseenSessionIds].join(','));

// ── 4. 渲染：未读会话带小圆点，已读会话不带 ──
state.currentSessionId = 'old';
state.unseenSessionIds = new Set(['s2']);
ctx.renderSessionList();
const listHtml = String($('session-items').innerHTML || '');
const dotFor = (id) => {
  const m = listHtml.match(new RegExp('data-id="' + id + '"[\\s\\S]*?</div>\\s*</div>'));
  void m;
  // 按块切分更稳：拿 id 之前的最近一段 session-item 开始位置
  const idx = listHtml.indexOf('data-id="' + id + '"');
  if (idx < 0) return null;
  const start = listHtml.lastIndexOf('<div class="session-item', idx);
  const next = listHtml.indexOf('<div class="session-item', idx);
  const block = listHtml.slice(start, next > 0 ? next : listHtml.length);
  return block.includes('session-unread-dot');
};
check('4a. 未读会话渲染出小圆点', dotFor('s2') === true);
check('4b. 已读会话没有小圆点', dotFor('s1') === false, String(dotFor('s1')));
check('4c. 圆点带 title（鼠标悬停能说明是什么）', listHtml.includes('title="有新会话，点开即消"'));

// ── 5. 点开即消 ──
await ctx.selectSession('s2');
check('5. 点开会话后未读点消除', !state.unseenSessionIds.has('s2'), [...state.unseenSessionIds].join(','));

// ── 6. 坏数据不炸 ──
let threw = false;
try { fire('session-start', '{不是 JSON'); } catch { threw = true; }
check('6. event.data 是坏 JSON 时不抛异常', !threw);

// ── 7. CSS 契约：等待中行与小圆点必须有样式（曾出现"只有 class 没样式"）──
const css = fs.readFileSync(path.join(ROOT, 'ui', 'style.css'), 'utf8');
check('7a. .session-unread-dot 有样式', /\.session-unread-dot\s*\{/.test(css));
check('7b. .session-waiting-row 有样式', /\.session-item\.session-waiting-row/.test(css));

console.log('\n会话未读/跟随：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
