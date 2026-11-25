// 真实端到端：起真服务，**不 mock 任何接口**，
// 用 vm 加载 ui/app.js，走完整的 switchTab('usage') → loadUsageView 流程，
// 验证页面真的有内容。这是最接近用户实际操作的验证。
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

// 数据目录隔离：必须在 import src/app.js 之前设置。
// 否则用户正开着 QQ Agent 时本测试会被实例锁挡住（"已有实例在运行"），
// 那是环境冲突而不是代码回归；隔离后测试随时可跑，也不碰真实 data/。
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-usage-'));

const { createApp } = await import('../src/app.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); } };

// ── 起真服务 ──
const app = createApp({ log: () => {} });
const PORT = 40995;
const port = await app.start(PORT);
console.log('=== 真实服务已启动 :' + port + '（接口全部真实，无 mock）===\n');

// ── DOM 桩（尽量接近真实）──
function makeEl(id = '') {
  const el = {
    id, dataset: {}, _cls: new Set(), _q: {},
    style: { setProperty() {}, removeProperty() {} },
    textContent: '', innerHTML: '', value: '', checked: false, children: [],
    scrollTop: 0, scrollHeight: 1000, clientHeight: 500,
    classList: null,
    addEventListener(ev, fn) { (el._ev ||= {}); (el._ev[ev] ||= []).push(fn); },
    removeEventListener() {},
    // 程序化派发（app.js 的人设选择器/独立人设清除按钮用到）：
    // 触发已注册的同名监听器，与浏览器事件语义一致（无返回值）。
    dispatchEvent(ev) { for (const fn of (el._ev?.[ev?.type] || [])) { try { fn(ev); } catch { /* 桩忽略 */ } } },
    querySelector(sel) { el._q[sel] ||= makeEl(); return el._q[sel]; },
    querySelectorAll: () => [],
    appendChild(c) { el.children.push(c); return c; },
    remove() {}, closest: () => null, setAttribute() {}, getAttribute: () => null,
    focus() {}, scrollIntoView() {}
  };
  el.classList = {
    add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
    toggle: (c, on) => { if (on) el._cls.add(c); else el._cls.delete(c); },
    contains: (c) => el._cls.has(c)
  };
  return el;
}
const byId = new Map();
// 页签与视图桩：让 app.js 加载时能真实绑定点击事件。
// 曾经点击处理器漏了 usage 分支，而旧桩 querySelectorAll 恒返 []，
// 测试里根本没绑过点击事件 —— 于是"点页签空白"这个 bug 测试完全覆盖不到。
const TAB_NAMES = ['sessions', 'chats', 'usage', 'snowluma', 'settings'];
const tabStubs = TAB_NAMES.map((n) => { const el = makeEl(); el.dataset.tab = n; return el; });
const viewStubs = TAB_NAMES.map((n) => makeEl('view-' + n));
const document = {
  documentElement: makeEl(), body: makeEl(), head: makeEl(),
  querySelector(sel) { return sel.startsWith('#') ? document.getElementById(sel.slice(1)) : (byId.get(sel) || (byId.set(sel, makeEl()), byId.get(sel))); },
  querySelectorAll(sel) {
    if (sel === '.tab') return tabStubs;
    if (sel === '.view') return viewStubs;
    return [];
  },
  getElementById(id) { if (!byId.has('#' + id)) byId.set('#' + id, makeEl(id)); return byId.get('#' + id); },
  createElement: () => makeEl(), addEventListener() {}
};

// 真实 fetch（打到真服务）
const realFetch = async (url, opt = {}) => {
  const u = new URL(url, 'http://127.0.0.1:' + port);
  return new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port, path: u.pathname + u.search, method: opt.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-console-token': 'qq-agent-console', ...(opt.headers || {}) } },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ ok: r.statusCode < 400, status: r.statusCode, json: async () => JSON.parse(d || '{}') })); });
    rq.on('error', rej);
    if (opt.body) rq.write(opt.body);
    rq.end();
  });
};

const sandbox = {
  document, window: null,
  localStorage: { getItem: () => null, setItem() {} },
  location: { href: 'http://127.0.0.1:' + port + '/' },
  fetch: realFetch,
  EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  alert: () => {}, confirm: () => true,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: { userAgent: 'node' }, requestAnimationFrame: (f) => setTimeout(f, 0),
  URL, Intl, Math, JSON, Date, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone: (x) => JSON.parse(JSON.stringify(x)),
  // app.js 的 bindSettingsEvents 会往 window 挂 beforeunload 兜底保存 ——
  // vm 的 window 是本 sandbox 自己（无 DOM），补一个空实现让模块加载不崩。
  addEventListener() {}, removeEventListener() {},
  Event: class { constructor(type, opts = {}) { this.type = type; this.bubbles = !!opts.bubbles; } }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// M9 拆分：vendor 绑定注入 sandbox（原 import 剥离的等价物）。
const { TIER_SLIDER_BANDS, sliderToTier, tierToSlider } = await import('../src/tier-slider.js');
const { matchPriceTable } = await import('../src/model-prices.js');
Object.assign(sandbox, { TIER_SLIDER_BANDS, sliderToTier, tierToSlider, matchPriceTable });

// 按浏览器 defer 顺序拼接 12 段普通脚本后 vm 执行（桥的 import 由上面的注入顶替）。
const ctx = vm.createContext(sandbox);
const appCodeStripped = (await import('./_ui-load.mjs')).loadUiAppCode().code
  .replace(/^export\s+(function|const|let|async function|class)/gm, '$1');
new vm.Script(appCodeStripped, { filename: 'ui/app.js' }).runInContext(ctx);

// ── 真实加载配置与价格（模拟启动流程）──
console.log('=== 模拟启动：拉配置与价格 ===');
const cfg = await realFetch('/api/config').then((r) => r.json());
const priceData = await realFetch('/api/model-prices').then((r) => r.json()).catch(() => ({ prices: [], current: null }));
vm.runInContext('state.config = ' + JSON.stringify(cfg) + ';', ctx);
vm.runInContext('state.modelPrices = ' + JSON.stringify(priceData) + ';', ctx);
check('配置已加载', !!cfg, '');
check('价格已加载（prices=' + (priceData.prices || []).length + '）', !!priceData);

// ⚠️ 等启动流程 settle：app.js 加载后会跑一段初始化（拉配置、渲染设置页等），
//    期间它会把 state.tab 改成 settings。不等它跑完就开始测，
//    loadUsageView 的竞态检查会直接 return，页面停在骨架屏。
await new Promise((r) => setTimeout(r, 500));

// ── 切到用量页（完整走 switchTab）──
console.log('\n=== switchTab("usage") 完整流程 ===');
const usageBox = document.getElementById('usage-page');
// ⚠️ 每次调用前都要重设 tab：app.js 的启动流程会在 await 期间把 state.tab
//    改成 settings。loadUsageView 里有 `if (state.tab !== 'usage') return` 的
//    竞态防护（这是对的），只设一次的话数据会被白拉、页面停在骨架屏。
const setUsageTab = () => vm.runInContext("state.tab = 'usage';", ctx);
const switchTo = ctx.switchTab || sandbox.switchTab;

// 稳定化：不要指望"启动流程在固定 500ms 内 settle"。
// 启动耗时随技能/插件数量增长而变（每多一个条目就多一份清单读取与注册），
// 固定 sleep 会变成偶发假失败 —— 页面停在骨架屏，但产品行为其实是对的。
// 这里改成"设 tab → 走一次加载 → 检查是否真的渲染出来"，没出来就重试，
// 重试上限约 3 秒。真实用户点页签时启动早已结束，不存在这个问题。
let usageHtml = '';
for (let attempt = 0; attempt < 12; attempt += 1) {
  if (typeof switchTo === 'function') switchTo('usage');
  setUsageTab();
  await (ctx.loadUsageView || sandbox.loadUsageView)({ force: true });
  usageHtml = String(usageBox.innerHTML || '');
  if (usageHtml.includes('估算成本')) break;
  await new Promise((r) => setTimeout(r, 250));
}

const html = usageHtml;
console.log('  页面长度: ' + html.length + ' 字符');
check('页面有实质内容（>1000 字符）', html.length > 1000, String(html.length));
check('包含「用量与成本」标题', html.includes('用量与成本'));
check('包含「估算成本」卡片', html.includes('估算成本'));
check('包含「搜索次数」卡片（行为区）', html.includes('搜索次数'));
check('包含「调用次数」卡片', html.includes('调用次数'));
check('不是错误提示', !html.includes('加载失败'), html.slice(0, 120));
check('不是空页面', html.trim().length > 0);
// 新契约：顶部 8 张（成本/调用/总token/输入/输出/命中量/未命中/命中率）+ 行为 9 张（含会话次数）
// （发送/字数/表情包/识图/识别视频/音频识别/思考/搜索），合计 17 张（顶部 8 + 行为 9），不再有跨列大卡。
const behIdx = html.indexOf('data-block="behavior"');
const chatsIdx = html.indexOf('data-block="chats"');
const topSeg = behIdx > 0 ? html.slice(0, behIdx) : html;
const behSeg = behIdx > 0 && chatsIdx > behIdx ? html.slice(behIdx, chatsIdx) : '';
const cardCount = (seg) => (seg.match(/class="usage-card[ "]/g) || []).length;
const labelsOf = (seg) => [...seg.matchAll(/class="uc-label">([^<]*)/g)].map((m) => m[1].trim());
check('顶部统计卡 8 张', cardCount(topSeg) === 8, String(cardCount(topSeg)));
check('行为统计卡 9 张', cardCount(behSeg) === 9, String(cardCount(behSeg)));
check('顶部卡顺序（成本→调用→总token→输入→输出→命中量→未命中→命中率）',
  JSON.stringify(labelsOf(topSeg)) === JSON.stringify(['估算成本', 'API 调用次数', '总 token（输入+输出）', '输入 token', '输出 token', '缓存命中量', '缓存未命中', '缓存命中率']),
  labelsOf(topSeg).join('|'));
check('行为卡顺序（会话→发送→字数→表情包→识图→识别视频→音频识别→思考→搜索）',
  JSON.stringify(labelsOf(behSeg)) === JSON.stringify(['会话次数', '发送条数', '发送字数', '表情包数', '识图次数', '识别视频', '音频识别', '思考次数', '搜索次数']),
  labelsOf(behSeg).join('|'));
// 旧卡位：顶部搜索字段、独立「行为 · 按会话」表都必须已删除
check('顶部旧搜索字段已删除', !html.includes('data-field="search"'), '');
check('旧「行为 · 按会话」表已删除', !html.includes('data-table="bchats"') && !html.includes('行为 · 按会话'), '');
check('卡片无跨列布局', !html.includes(' wide"') && !html.includes(' wide '), '');
// 区块顺序：行为 → 按会话 → 单次会话 → 按模型（“按天”已删除）
const blockIdx = ['behavior', 'chats', 'sessions', 'models'].map((b) => html.indexOf('data-block="' + b + '"'));
check('区块顺序（行为→按会话→单次→按模型）',
  blockIdx.every((v, i) => v >= 0 && (i === 0 || v > blockIdx[i - 1])), blockIdx.join('<'));
// 日期选择器：默认某一天（YYYY-MM-DD）
const dateInput = html.match(/id="usage-date"[^>]*value="(\d{4}-\d{2}-\d{2})"/);
check('日期选择器存在且默认某一天', !!dateInput, dateInput ? dateInput[1] : '');
// 单次会话表：9 列含成本、整行可点、没有「查看」按钮
const sessHead = (html.match(/data-table="sessions">([\s\S]*?)<\/thead>/) || [])[1] || '';
const thCount = (sessHead.match(/<th[\s>]/g) || []).length;
check('单次会话表 9 列含成本', thCount === 9 && sessHead.includes('>成本<'), 'th=' + thCount);
check('单次会话无「查看」按钮', !html.includes('data-session-open') && !html.includes('>查看<'), '');

// ── 数值是否真的填了 ──
console.log('\n=== 数值填充（真实数据）===');
// DOM 桩不会解析 innerHTML，renderUsagePage 重建后 querySelector 缓存的是旧元素，
// 所以显式再调一次 updateUsagePage，确保读到的是刚填入的值。
const freshStats = await realFetch('/api/usage/stats?range=7').then((r) => r.json());
const freshSt = await realFetch('/api/status').then((r) => r.json());
ctx.updateUsagePage(freshStats, freshSt, priceData || {});
const f = (n) => String(usageBox.querySelector(`[data-field="${n}"]`)?.textContent || '');
const cost = f('cost'), runs = f('runs'), prompt = f('prompt');
const completion = f('completion'), cached = f('cached'), miss = f('miss'), rate = f('rate');
const bSearch = f('b-search');
console.log('  成本=' + cost + '  调用=' + runs + '  输入=' + prompt + '  输出=' + completion
  + '  命中量=' + cached + '  未命中=' + miss + '  命中率=' + rate + '  行为搜索=' + bSearch);
check('成本已填（¥ 开头）', cost.startsWith('¥'), cost);
check('调用次数已填（数字）', /^\d+$/.test(runs), runs);
check('输入 token 已填', prompt.length > 0, prompt);
check('输出 token 已填', /^[\d,]+$/.test(completion), completion);
check('缓存命中量已填', /^[\d,]+$/.test(cached), cached);
check('缓存未命中已填', /^[\d,]+$/.test(miss), miss);
check('缓存命中率已填（百分比）', /^\d+(\.\d+)?%$/.test(rate), rate);
// 搜索次数归行为区，来源与旧顶部一致（stats.searchCount）；顶部字段已不存在
check('行为区搜索次数已填（数字）', /^[\d,]+$/.test(bSearch), bSearch);
// 分页文案由 updateUsagePage 写进元素（本测试 DOM 桩不解析 innerHTML）
const pageInfo = String(usageBox.querySelector('#sessions-pageinfo')?.textContent || '');
check('单次会话分页文案', /^第 1 \/ \d+ 页$/.test(pageInfo), pageInfo);

// ── 各 range 都试 ──
console.log('\n=== 各时间范围 ===');
// 新契约：日期选择器传 YYYY-MM-DD，后端按天返回（today 兼容保留）
const todayKey = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
for (const rg of ['today', '7', '30', 'all', todayKey]) {
  vm.runInContext(`usageRange = '${rg}';`, ctx);
  setUsageTab();                     // 同上：每次都要重设
  await (ctx.loadUsageView || sandbox.loadUsageView)({ force: true });
  const h = String(usageBox.innerHTML || '');
  const ok = h.length > 1000 && !h.includes('加载失败');
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + 'range=' + rg.padEnd(6) + ' ' + h.length + ' 字符');
}

// ── 下钻（点行）──
console.log('\n=== 下钻明细（点行）===');
vm.runInContext("usageRange = '7';", ctx);
setUsageTab();
const stats = await realFetch('/api/usage/stats?range=7').then((r) => r.json());
const firstDay = (stats.days || [])[0];
if (firstDay) {
  const r = await realFetch(`/api/usage/breakdown?range=7&dim=day&key=${encodeURIComponent(firstDay.key)}&by=model`);
  const b = await r.json();
  check('按天下钻返回数据（rows=' + ((b.rows || []).length) + '）', r.ok && Array.isArray(b.rows));
} else {
  console.log('  （无按天数据，跳过）');
}

// ── 回归：模拟真实点击「用量」页签 ──
// 2026-09-05 bug：点击处理器 inline 复制了 switchTab 逻辑却漏了 usage 分支，
// 上面直接调 loadUsageView 的测试全绿，但用户点页签永远空白。
// 这一段走真实点击路径（触发绑定的 click 监听 → switchTab → loadUsageView）。
console.log('\n=== 回归：模拟真实点击「用量」页签 ===');
const usageTab = tabStubs.find((t) => t.dataset.tab === 'usage');
const clickHandlers = (usageTab && usageTab._ev && usageTab._ev.click) || [];
check('用量页签已绑定点击事件', clickHandlers.length > 0);
// 先切走、清空页面，模拟用户从别的页签点过来
vm.runInContext("state.tab = 'sessions';", ctx);
usageBox.innerHTML = '';
for (const fn of clickHandlers) fn({ preventDefault() {} });
let clickedHtml = '';
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 100));
  clickedHtml = String(usageBox.innerHTML || '');
  if (clickedHtml.includes('用量与成本')) break;
}
check('点击后 state.tab = usage', vm.runInContext('state.tab', ctx) === 'usage');
check('点击后页面有实质内容（含「用量与成本」）', clickedHtml.includes('用量与成本'), clickedHtml.slice(0, 80));
check('点击后不是错误提示', !clickedHtml.includes('加载失败'), clickedHtml.slice(0, 80));

await app.stop();
console.log('\n' + (fail ? 'FAILED ' + fail : 'ALL PASSED ' + pass));
process.exit(fail ? 1 : 0);
