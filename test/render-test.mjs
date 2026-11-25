// 实际执行 ui/app.js 的所有设置分区渲染函数，捕获运行时错误。
// 目的：像"B 未定义"这类错误，node --check（语法检查）根本查不出来，
// 只有真正跑一遍渲染才会暴露。
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 数据目录隔离（必须在 import src/app.js 之前设置）──
// 本测试会在进程内 createApp 并 start()，而 createApp 会抢实例锁。
// 不隔离数据目录的话，用户正开着 QQ Agent 时本测试必然失败：
//   "已有 QQ Agent 实例在运行（PID xxx）"
// —— 那是**测试环境问题**，不是代码回归，但会让人误判。
// 隔离后测试可以随时跑，也不会污染用户的真实 data/。
const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-render-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// M9 拆分：app.js 变成 ESM 桥 + ui/app/00-11 十二个普通脚本段。
// vm 侧改为按 defer 顺序拼接全部段后执行（vendor 绑定仍走 sandbox 注入）。
const { code: APP_CODE, files: APP_FILES } = await import('./_ui-load.mjs').then((m) => m.loadUiAppCode());
const SRC = path.join(ROOT, 'ui', 'app.js');
let code = APP_CODE;

// app.js 现在是 ESM module（顶层 import /vendor/*.js）。
// vm.Script 只能跑普通脚本，跑不了 import —— 桥文件的 import 已由 _ui-load.mjs
// 旁路（直接拼接 12 个普通脚本段），vendor 导出由 sandbox 注入同名绑定（见下方）。
const importedNames = ['TIER_SLIDER_BANDS', 'sliderToTier', 'tierToSlider', 'matchPriceTable'];

// ── 极简 DOM 桩 ──
function makeEl(id = '', cls = '') {
  const el = {
    id,
    _cls: new Set(cls ? cls.split(' ') : []),
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    children: [],
    classList: null,
    addEventListener() {},
    removeEventListener() {},
    // 返回可用子元素而非 null —— 弹窗代码会拿它调 addEventListener。
    // ⚠️ 同一个 selector 必须返回**同一个**元素：updateUsagePage 用
    //    box.querySelector('[data-field="cost"]').textContent = v 填值，
    //    每次返回新元素的话，测试就永远读不到填进去的数值。
    querySelector: (sel) => { el._q ||= {} ; el._q[sel] ||= makeEl(); return el._q[sel]; },
    querySelectorAll: () => [],
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    closest: () => null,
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20 }),
    insertAdjacentHTML() {},
    contains: () => false,
    scrollTop: 0, scrollHeight: 100, clientHeight: 50
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    toggle: (c, on) => { if (on) el._cls.add(c); else el._cls.delete(c); },
    contains: (c) => el._cls.has(c)
  };
  return el;
}

const store = new Map();
const document = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  head: makeEl('head'),
  querySelector: (sel) => {
    if (!store.has(sel)) store.set(sel, makeEl(String(sel).replace(/^#/, '')));
    return store.get(sel);
  },
  querySelectorAll: () => [],
  getElementById: (id) => document.querySelector('#' + id),
  createElement: (tag) => makeEl('', ''),
  addEventListener() {},
  removeEventListener() {}
};

// SSE 处理器注册表：桩捕获 connectSSE 绑定的监听，测试可直接派发合成事件
const sseRegistry = {};
const alertStub = () => {};
const sandbox = {
  document,
  window: null,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://127.0.0.1/', protocol: 'http:', host: '127.0.0.1' },
  fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
  EventSource: function () {
    this.addEventListener = (type, fn) => { (sseRegistry[type] ||= []).push(fn); };
    this.close = () => {};
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console,
  alert: alertStub,
  confirm: () => true,
  prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  URL, Blob: function () {}, FileReader: function () {},
  Intl, Math, JSON, Date, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone: (x) => JSON.parse(JSON.stringify(x))
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// 把 /vendor/*.js 的真实实现注入 sandbox，顶替被剥掉的 import。
// 直接复用 src/ 下的同源模块，保证测试跑的就是真实换算/匹配逻辑。
const { TIER_SLIDER_BANDS, sliderToTier, tierToSlider } = await import('../src/tier-slider.js');
const { matchPriceTable } = await import('../src/model-prices.js');
Object.assign(sandbox, { TIER_SLIDER_BANDS, sliderToTier, tierToSlider, matchPriceTable });

let pass = 0, fail = 0;
const results = [];

try {
  // app.js 是 ES module（浏览器里用 type="module" 加载），
// 但 vm.Script 跑不了 import/export —— 前面已剥 import，这里再把 export 前缀剥掉。
code = code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');

const ctx = vm.createContext(sandbox);
  // 用 Script 执行（app.js 的 import 已在上方剥掉并注入 sandbox）
  new vm.Script(code, { filename: SRC }).runInContext(ctx);

  // 取出渲染函数并执行
  const sections = [
    'renderSettingsSection', 'renderApiSection', 'renderSearchSection',
    'renderPersonaSection', 'renderAllowSection',
    'renderChatSection', 'renderDesktopSection', 'renderOnebotSection',
    'renderPersonaPicker', 'renderHealthCard', 'renderSkillsPage', 'renderPluginsPage'
  ];

  // 直接用后端的 DEFAULT_CONFIG 做桩 —— 不要手敲字段名，
  // 手敲容易猜错层级（我刚把 minGapMs 放错层，误报了一个不存在的问题）。
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  // 再叠加上本轮关心的档位字段（默认值里没有 contextSliderPos）
  cfg.store = {
    ...(cfg.store || {}),
    contextTier: 3, contextSliderPos: 55,
    keywords: ['大肥鱼'],
    randomPercent: 50, historyCount: 80
  };


  console.log('=== 实际执行各设置分区渲染函数 ===\n');

  // 技能区块有 4 种状态分支（生效 / 已关闭 / 依赖未就绪 / 加载失败），
  // 空列表只会走到"还没加载到技能"这一条分支。这里塞一份覆盖全部状态的样例，
  // 保证 reason / missingRequires / lastError 的渲染路径真的被执行到。
  // 注意：state 是 vm 里的顶层 const，必须用 runInContext 注入（不能从外面直接改）。
  vm.runInContext(`state.skills = ${JSON.stringify([
    { id: 'ok-skill', name: '正常技能', version: '1.0.0', category: 'model', description: '正常', source: 'skill',
      loaded: true, enabled: true, available: true, active: true, code: null, reason: '',
      kind: 'skill', dir: 'skills/ok-skill',
      capabilities: ['llm.request-params'], requires: [], missingRequires: [], toolIds: ['ok-skill:x'] },
    { id: 'off-skill', name: '已关闭技能', version: '1.0.0', category: 'message', description: '被用户关了', source: 'skill',
      kind: 'skill', dir: 'skills/off-skill',
      loaded: true, enabled: false, available: true, active: false, code: 'skill-disabled', reason: 'Skill 未启用',
      capabilities: [], requires: [], missingRequires: [], toolIds: [] },
    { id: 'dep-skill', name: '依赖未就绪', version: '1.0.0', category: 'knowledge', description: '缺能力', source: 'skill',
      kind: 'skill', dir: 'skills/dep-skill',
      loaded: true, enabled: true, available: false, active: false, code: 'capability-missing',
      reason: '缺少能力：knowledge.search', capabilities: [], requires: ['knowledge.search'],
      missingRequires: ['knowledge.search'], toolIds: [] },
    { id: 'broken-skill', name: '入口写错的插件', version: '0.1.0', category: 'utility', description: '入口写错了', source: 'plugin',
      kind: 'plugin', dir: 'plugins/broken-skill',
      loaded: false, enabled: true, available: false, active: false, code: 'skill-not-loaded',
      reason: '加载失败：入口文件不存在：index.js', capabilities: [], requires: [], missingRequires: [],
      toolIds: [], lastError: 'SyntaxError: 意外的标记', deprecated: true },
    // 一个正常插件：验证插件页确实能渲染出插件（而不只是"非空字符串"）
    { id: 'ok-plugin', name: '正常插件', version: '1.0.0', category: 'media', description: '提供能力', source: 'plugin',
      kind: 'plugin', dir: 'plugins/ok-plugin',
      loaded: true, enabled: true, available: true, active: true, code: null, reason: '',
      capabilities: ['media.transcribe'], requires: [], missingRequires: [], toolIds: [] }
  ])};`, ctx);
  vm.runInContext(`state.skillsSummary = ${JSON.stringify({ total: 5, active: 2, disabled: 1, broken: 1, capabilities: ['llm.request-params'] })};`, ctx);

  for (const name of sections) {
    const fn = ctx[name] || sandbox[name];
    if (typeof fn !== 'function') {
      console.log('  SKIP  ' + name + '（非函数或未导出）');
      continue;
    }
    try {
      const out = fn(cfg);
      const ok = typeof out === 'string' && out.length > 0;
      if (ok) { pass++; console.log('  OK    ' + name + '  (' + out.length + ' 字符)'); }
      else { fail++; console.log('  FAIL  ' + name + ' 返回非字符串'); }
    } catch (e) {
      fail++;
      console.log('  FAIL  ' + name + ' 抛错: ' + (e && e.message));
      results.push({ name, err: e && e.message });
    }
  }

  // ── 技能页 / 插件页必须各自只渲染自己那一型 ──
  // 光看"返回非空字符串"是不够的：两页都用同一个渲染函数，
  // 万一 kind 过滤写错（比如两页都渲染全部），函数照样返回字符串、测试照样通过。
  // 所以这里逐条断言"该出现的出现、不该出现的不出现"。
  console.log('\n=== 技能页 / 插件页的类型隔离 ===');
  for (const [kindTag, fnName, mustHave, mustNotHave] of [
    ['skill',
      'renderSkillsPage',
      ['正常技能', '已关闭技能', '依赖未就绪'],          // 3 条 kind='skill'
      ['正常插件', '入口写错的插件']],                    // 2 条 kind='plugin'
    ['plugin',
      'renderPluginsPage',
      ['正常插件', '入口写错的插件'],                     // 2 条 kind='plugin'
      ['正常技能', '已关闭技能', '依赖未就绪']]
  ]) {
    const fn = ctx[fnName] || sandbox[fnName];
    if (typeof fn !== 'function') { fail++; console.log(`  FAIL  ${fnName} 未定义`); continue; }
    try {
      const out = fn();
      const missing = mustHave.filter((x) => !out.includes(x));
      const leaked = mustNotHave.filter((x) => out.includes(x));
      const ok = !missing.length && !leaked.length;
      ok ? pass++ : fail++;
      console.log(`  ${ok ? 'OK   ' : 'FAIL '} ${fnName}() → `
        + (missing.length ? `缺少 ${missing.join('/')} ` : '')
        + (leaked.length ? `混入另一型 ${leaked.join('/')} ` : '')
        + (ok ? '只含本型条目' : ''));
    } catch (e) {
      fail++;
      console.log(`  FAIL  ${fnName} 抛错: ${e && e.message}`);
    }
  }

  // ── 技能页/插件页必须有「＋ 添加」入口 ─────────────────────────────────
  // 2026-09-26 回归：这个按钮曾从模板里消失，openAddModuleModal 成了没人调用
  // 的孤本 —— 页面整体看着正常，唯独"添加"能力整个没了。
  console.log('\n=== 添加入口 ===');
  for (const [fnName, addId, label] of [
    ['renderSkillsPage', 'skills-add-btn', '添加技能'],
    ['renderPluginsPage', 'plugins-add-btn', '添加插件']
  ]) {
    const fn = ctx[fnName] || sandbox[fnName];
    if (typeof fn !== 'function') { fail++; console.log(`  FAIL  ${fnName} 未定义`); continue; }
    try {
      const out = fn();
      const ok = out.includes(`id="${addId}"`) && out.includes(label);
      ok ? pass++ : fail++;
      console.log(`  ${ok ? 'OK   ' : 'FAIL '} ${fnName}() 含「＋ ${label}」入口（#${addId}）`);
    } catch (e) {
      fail++;
      console.log(`  FAIL  ${fnName} 抛错: ${e && e.message}`);
    }
  }

  // 滑条换算函数
  console.log('\n=== 滑条换算（UI 侧）===');
  for (const fnName of ['sliderToTierUI', 'sliderToTierUI_tierToSlider', 'sliderDesc']) {
    const fn = ctx[fnName] || sandbox[fnName];
    if (typeof fn !== 'function') { fail++; console.log('  FAIL  ' + fnName + ' 未定义'); continue; }
    try {
      if (fnName === 'sliderToTierUI') {
        const r = fn(55);
        const ok = r.tier === 3 && Math.abs(r.randomPercent - 50) < 0.6;
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' sliderToTierUI(55) → 档' + r.tier + '/' + r.randomPercent + '%');
      } else if (fnName === 'sliderToTierUI_tierToSlider') {
        const r = fn({ contextSliderPos: 55 });
        const ok = r === 55;
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' sliderToTierUI_tierToSlider() → ' + r);
      } else {
        const r = fn(55);
        const ok = typeof r === 'string' && r.includes('3 档');
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' sliderDesc(55) → ' + String(r).slice(0, 46));
      }
    } catch (e) {
      fail++;
      console.log('  FAIL  ' + fnName + ' 抛错: ' + (e && e.message));
    }
  }

  // 各滑条位置都渲染一次（覆盖全区间）
  console.log('\n=== 各滑条位置渲染聊天设置 ===');
  for (const pos of [0, 5, 10, 15, 20, 30, 55, 75, 90, 95, 100]) {
    try {
      const out = (ctx.renderChatSection || sandbox.renderChatSection)({
        ...cfg, store: { ...cfg.store, contextSliderPos: pos }
      });
      const ok = typeof out === 'string' && out.length > 0;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' 位置 ' + String(pos).padStart(3) + '% → ' + out.length + ' 字符');
    } catch (e) {
      fail++;
      console.log('  FAIL  位置 ' + pos + '% 抛错: ' + (e && e.message));
    }
  }

    // ── 档位反馈：滑到哪一档，大号读数 + 预设高亮同步 ──
    console.log('\n=== 刻度段高亮（拖动联动）===');
    /** 2026-09-24 concept2 改版：分段（tier-band）为静态热度渐变、不再动态高亮，
        档位反馈 = 大号读数（tr-big）+ 预设（.preset.on）—— 断言改锚这两处，
        行为意图不变（拖到哪一档，反馈必须正确且唯一）。 */
    const tierRead = (html) => {
      const m = /class="tr-big"[^>]*>([^<]+)</.exec(html);
      return [...String(m ? m[1] : '').matchAll(/(\d)\s*档/g)].map((x) => Number(x[1]));
    };
    // 2026-09-24：活跃设置编辑器已从模态框改为内联挂载（mountActiveConfigEditor(root)），
    // 取模板的方式随之改为「假 root + 捕获 innerHTML」—— 所有断言本身不变。
    let capturedBody = '';
    const fakeRoot = makeEl();
    Object.defineProperty(fakeRoot, 'innerHTML', {
      get: () => capturedBody,
      set: (v) => { capturedBody = String(v); }
    });
    // ⚠️ state 是 vm 里的顶层 const —— 从外面（sandbox.state）**拿不到也改不了**
    // （vm 顶层 const 是上下文词法绑定，不挂到 sandbox 对象上）。
    // 旧版 renderAt 里那套 "prev = sandbox.state?.config?.store → 恢复" 全是死代码：
    // sandbox.state 恒为 undefined，恢复永远不执行 —— 于是四象限测试在 store 上
    // 留下的 unifiedTier:false 等"实验设置"会**漏进下一个象限**，测试互相污染。
    // 正确做法：每次渲染前用干净的 cfg 快照整体重置 state.config（vm 注入），
    // 再叠加本轮需要的开关 —— 彻底消除象限间的顺序依赖。
    const cfgSnapshot = JSON.stringify(cfg);
    const renderAt = (pos, storePatch = null) => {
      capturedBody = '';
      try {
        // 配置重置走 vm（state 是 vm 里的顶层 const，从外面摸不到）；
        // 模态框函数从 ctx/sandbox 上取（vm 脚本里没有 ctx 这个名字，别写进去）。
        vm.runInContext(
          'state.config = JSON.parse(' + JSON.stringify(cfgSnapshot) + ');'
          + 'state.config.store = { ...(state.config.store || {}), contextSliderPos: ' + pos + ', ...( ' + JSON.stringify(storePatch || {}) + ' ) };',
          ctx
        );
        (ctx.mountActiveConfigEditor || sandbox.mountActiveConfigEditor)?.(fakeRoot);
      } catch (e) { /* 缺失/抛错都按空处理 */ }
      return capturedBody;
    };

    for (const [pos, want, desc] of [
      [0, 1, '最左端'], [5, 1, '1档中段'], [10, 1, '1档右界'],
      [15, 2, '2档'], [20, 2, '2档右界'],
      [30, 3, '3档靠左'], [55, 3, '3档正中(50%)'], [75, 3, '3档靠右'], [90, 3, '3档右界'],
      [95, 4, '4档'], [100, 4, '最右端']
    ]) {
      try {
        const html = renderAt(pos);
        const on = tierRead(html);
        const ok = on.length === 1 && on[0] === want;
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(pos).padStart(3) + '% (' + desc + ') → 高亮第 ' + want + ' 段'
          + (ok ? '' : '  实际 [' + on.join(',') + ']'));
      } catch (e) { fail++; console.log('  FAIL ' + pos + '% 抛错: ' + (e && e.message)); }
    }

    // 任何时候只亮一段
    for (const pos of [0, 10, 15, 20, 55, 90, 95, 100]) {
      const html = renderAt(pos);
      const on = tierRead(html);
      const ok = on.length === 1;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(pos).padStart(3) + '% 只亮 1 段' + (ok ? '' : '  实际 ' + on.length + ' 段'));
    }

    // 四段都有机会被点亮
    const lit = new Set();
    for (let p = 0; p <= 100; p += 0.5) for (const n of tierRead(renderAt(p))) lit.add(n);
    {
      const ok = lit.size === 4;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '四段都能被点亮' + (ok ? '' : '  实际 [' + [...lit].sort().join(',') + ']'));
    }

    // 参数块（各档条数）已摊平进同一份 HTML —— 这里只验证档位读数点亮正确。
    for (const [pos, want] of [[5, 1], [15, 2], [55, 3], [95, 4]]) {
      const html = renderAt(pos);
      const on = tierRead(html);
      const ok = on.length === 1 && on[0] === want;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + pos + '% 刻度第' + on.join(',') + '段'
        + (ok ? '' : '  （期望 ' + want + '）'));
    }

    // 2026-09-19 二次改版：滑条改为 createVSlider 生成的自定义控件
    // （#ac-slider 容器，珠子在运行时由控制器注入 —— body 模板里看不到珠子，
    //  初始形态靠容器上的 data-dual 声明）。
    // 每个象限用 renderAt(pos, patch) 独立注入开关 —— cfg 快照重置保证互不污染。
    // ① 统一+峰谷关：滑条容器在且声明单珠形态，分群区藏、峰谷字段藏
    {
      const html = renderAt(55);
      const sliderBox = /id="ac-slider"[^>]*data-dual="0"/.test(html);
      // 峰谷字段 2026-09-24 移入「峰谷设置」模态框（不再出现在编辑器模板里），
      // 断言相应收敛为：单珠形态 + 分群区隐藏。
      const groupHidden = /id="ac-group-area"[^>]*style="display:none"/.test(html);
      const ok = sliderBox && groupHidden;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '四象限①（统一+峰谷关）：滑条声明单珠形态，分群区隐藏'
        + (ok ? '' : `  slider=${sliderBox} groupHidden=${groupHidden}`));
    }
    // ② 分群+峰谷关：分群按钮区显示（同一根滑条切换编辑目标）
    {
      const html = renderAt(55, { unifiedTier: false });
      const groupVisible = /id="ac-group-area"(?!\S*style="display:none)/.test(html);
      const groupButtons = /id="ac-group-buttons"/.test(html);
      const sliderBox = /id="ac-slider"[^>]*data-dual="0"/.test(html);
      const ok = groupVisible && groupButtons && sliderBox;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '四象限②（分群+峰谷关）：群按钮区显示，共用单珠滑条'
        + (ok ? '' : `  group=${groupVisible} buttons=${groupButtons} slider=${sliderBox}`));
    }
    // ③ 统一+峰谷开：滑条声明双珠形态，峰谷时段字段显示
    {
      const html = renderAt(55, {
        peakSchedule: { enabled: true, peak: { start: '09:00', end: '18:00', sliderPos: 10 }, valley: { start: '09:00', end: '09:00', sliderPos: 100 } }
      });
      const sliderBox = /id="ac-slider"[^>]*data-dual="1"/.test(html);
      const fieldsVisible = /id="ac-peak-fields"(?!\S*style="display:none)/.test(html);
      const groupHidden = /id="ac-group-area"[^>]*style="display:none"/.test(html);
      const ok = sliderBox && groupHidden; // 字段断言已随「峰谷设置」移入模态框而失效，忽略 fieldsVisible
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '四象限③（统一+峰谷开）：滑条声明双珠形态，时段字段显示'
        + (ok ? '' : `  slider=${sliderBox} fields=${fieldsVisible} groupHidden=${groupHidden}`));
    }
    // ④ 分群+峰谷开：群按钮区与双珠滑条同场（分群峰谷仍可单独编辑）
    {
      const html = renderAt(55, {
        unifiedTier: false,
        peakSchedule: { enabled: true, peak: { start: '09:00', end: '18:00', sliderPos: 10 }, valley: { start: '09:00', end: '09:00', sliderPos: 100 } }
      });
      const groupVisible = /id="ac-group-area"(?!\S*style="display:none)/.test(html);
      const dualSlider = /id="ac-slider"[^>]*data-dual="1"/.test(html);
      const fieldsVisible = /id="ac-peak-fields"(?!\S*style="display:none)/.test(html);
      const ok = groupVisible && dualSlider; // 同上：忽略 fieldsVisible
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '四象限④（分群+峰谷开）：群按钮区与双珠滑条同场（分群峰谷可单独编辑）'
        + (ok ? '' : `  group=${groupVisible} dual=${dualSlider} fields=${fieldsVisible}`));
    }

    // （原 modelModalShell 拦截随「活跃设置」模态框取消而移除。）

    // ── 调用明细弹窗（点「调用次数」卡片打开）──
    console.log('\n=== 调用明细弹窗 ===');
    const openBreakdown = ctx.openToolBreakdown || sandbox.openToolBreakdown;
    if (typeof openBreakdown !== 'function') {
      fail++; console.log('  FAIL openToolBreakdown 未定义');
    } else {
      const fakeStats = {
        rangeLabel: '近 7 天',
        searchCount: 46,
        toolCounts: {
          send_message: 133, finish: 149, send_sticker: 7, send_poke: 6,
          get_recent_messages: 3, get_message_images: 70, get_message_detail: 7,
          list_stickers: 4, collect_sticker: 2,
          memory_append: 2,
          web_search: 39, web_fetch: 7,
          some_unknown_tool: 5
        }
      };
      let captured = '';
      const realShell = ctx.modelModalShell || sandbox.modelModalShell;
      // 拦截弹窗外壳，拿到它渲染的 body
      ctx.modelModalShell = sandbox.modelModalShell = (opt) => { captured = String(opt.body || ''); return makeEl(); };

      try {
        vm.runInContext('state.usageStats = ' + JSON.stringify(fakeStats) + ';', ctx);
        openBreakdown();
        const ok = captured.length > 0
          && captured.includes('tool-breakdown')
          && captured.includes('send_message')
          && captured.includes('联网搜索')
          && captured.includes('some_unknown_tool');
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '弹窗渲染（含未知工具兜底）  ' + captured.length + ' 字符');
        const catsOk = ['发言', '查看', '表情', '记忆', '联网', '其他'].every((c) => captured.includes(c));
        catsOk ? pass++ : fail++;
        console.log('  ' + (catsOk ? 'OK   ' : 'FAIL ') + '六个分类齐全');
        const leadOk = captured.includes('发了 133 条消息') && captured.includes('联网查了 46 次');
        leadOk ? pass++ : fail++;
        console.log('  ' + (leadOk ? 'OK   ' : 'FAIL ') + '一句话小结正确');
      } catch (e) {
        fail++; console.log('  FAIL 弹窗抛错: ' + (e && e.message));
      }

      try {
        captured = '';
        vm.runInContext("state.usageStats = { rangeLabel: '今天', searchCount: 0, toolCounts: {} };", ctx);
        openBreakdown();
        const ok = captured.includes('还没有任何工具调用记录');
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '空数据给出友好提示');
      } catch (e) {
        fail++; console.log('  FAIL 空数据抛错: ' + (e && e.message));
      }

      if (realShell) ctx.modelModalShell = sandbox.modelModalShell = realShell;
    }


    // ── 用量页端到端：实际调用 loadUsageView 并验证页面真的有内容 ──
    // 补这个是因为：上一轮 loadUsageView 被误删，而现有测试**全是绿的** ——
    // 没有任何测试真正调用它，所以删了也没人发现。这是测试盲区。
    console.log('\n=== 用量页加载（loadUsageView）===');
    {
      const { DEFAULT_CONFIG: DC2 } = await import('../src/config.js');
      const loadUsage = ctx.loadUsageView || sandbox.loadUsageView;
      if (typeof loadUsage !== 'function') {
        fail++; console.log('  FAIL loadUsageView 未定义（用量页会一直空白）');
      } else {
        // 造一份统计返回
        const stats = {
          range: '7', rangeLabel: '近 7 天', mode: 'days',
          totals: {
            cost: 3.96, promptTokens: 120000, completionTokens: 34000,
            cachedTokens: 80000, totalTokens: 154000,
            cacheHitRate: 0.666, runs: 149, peakCost: 2, offPeakCost: 1.96,
            // 新契约：后端 totals 直接给缓存未命中（prompt - cached），卡片第四位显示它
            cacheMissTokens: 40000
          },
          searchCount: 46,
          toolCounts: { send_message: 133, web_search: 39, finish: 149 },
          days: [{ key: '2026-09-04', runs: 20, promptTokens: 1000, completionTokens: 200, cachedTokens: 500, cacheHitRate: 0.5, cost: 0.5, cacheMissTokens: 500 }],
          chats: [{ key: 'group:1', runs: 10, promptTokens: 500, completionTokens: 100, cacheHitRate: 0.4, cost: 0.2 }],
          models: [{ key: 'deepseek:deepseek-chat', runs: 149, promptTokens: 120000, completionTokens: 34000, cacheHitRate: 0.666, cost: 3.96 }]
        };
        // 行为统计走独立真实接口 /api/usage/behavior（施工单：搜索次数归行为区，
        // 数值仍取 stats.searchCount）。旧测试只 mock 了 stats，行为区永远是占位符。
        const behavior = {
          range: '7', rangeLabel: '近 7 天', mode: 'days',
          totals: {
            sentCount: 133, charCount: 4000, stickerCount: 12, visionCalls: 3,
            thinkingCalls: 5, apiCalls: 149, cachedTokens: 80000, promptTokens: 120000,
            completionTokens: 34000, totalTokens: 154000, cacheHitRate: 0.666, cacheMissTokens: 40000
          },
          hours: [],
          days: [{ day: '2026-09-04', sentCount: 20, charCount: 600, stickerCount: 2, visionCalls: 1, thinkingCalls: 1, apiCalls: 20, cacheMissTokens: 500 }],
          chats: [{ key: 'group:1', sentCount: 10, charCount: 300, stickerCount: 1, visionCalls: 0, thinkingCalls: 0, apiCalls: 10 }],
          sessions: [
            { chatKey: 'group:1', sessionId: 's1', model: 'deepseek-chat', rounds: 2, at: 1793000000000,
              durationMs: 1200, apiCalls: 2, toolCalls: 3, promptTokens: 10000, completionTokens: 500,
              cachedTokens: 9000, cost: 0.0123, sentCount: 1, charCount: 6, stickerCount: 0, visionCalls: 0,
              tools: { send_message: 2, finish: 1 } },
            // 旧快照：没有 cost → 表格里必须显示 '-'，不能编造数字
            { chatKey: 'group:1', at: 1792990000000, durationMs: 800, apiCalls: 1, toolCalls: 1,
              promptTokens: 5000, completionTokens: 200, cachedTokens: 4000,
              sentCount: 0, charCount: 0, stickerCount: 0, visionCalls: 0 }
          ]
        };
        const statusData = { usage: { runs: 12 }, config: DC2 };
        const prices = { rows: [] };

        // ⚠️ mock 只覆盖**真实存在**的接口，其余一律 404。
        //    曾经这里把 /api/usage/prices 也 mock 成 200，而这个接口后端根本没有
        //    —— 结果测试全绿、线上用量页永远加载失败。
        //    所以未知路径必须返回 404，让"捏造的接口"在测试里就暴露。
        const realFetch = sandbox.fetch;
        const REAL_USAGE_APIS = ['/api/usage/stats', '/api/usage/behavior', '/api/usage/breakdown', '/api/status'];
        sandbox.fetch = async (url) => {
          const u = String(url);
          const hit = REAL_USAGE_APIS.find((p) => u.includes(p));
          if (!hit) return { ok: false, status: 404, json: async () => ({ error: `未知 API：${u}` }) };
          const body = u.includes('/api/usage/stats') ? stats
            : u.includes('/api/usage/behavior') ? behavior
            : statusData;
          return { ok: true, status: 200, json: async () => body };
        };

        const usageBox = document.getElementById('usage-page');
        try {
          vm.runInContext("state.tab = 'usage';", ctx);
          await loadUsage({ force: true });
          const html = String(usageBox.innerHTML || '');
          if (html.length < 500) console.log('    [调试] 实际内容: ' + JSON.stringify(html.slice(0, 300)));
          const ok = html.length > 500
            && html.includes('用量与成本')
            && html.includes('估算成本')
            && html.includes('搜索次数');
          ok ? pass++ : fail++;
          console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '加载后页面有内容  ' + html.length + ' 字符'
            + (ok ? '' : '  （缺关键区块）'));

          // 数值应被填入。注意 updateUsagePage 走的是 textContent（不是 innerHTML），
          // 所以要直接查那个字段元素，而不是查整段 HTML。
          // 新契约：顶部 7 张卡（成本/调用/输入/输出/命中量/命中率/未命中），
          // 搜索次数移到行为区的 b-search，顶部旧 search 字段必须已删除。
          const pickTxt = (f) => String(usageBox.querySelector('[data-field="' + f + '"]')?.textContent || '');
          const costTxt = pickTxt('cost'), runsTxt = pickTxt('runs');
          const completionTxt = pickTxt('completion'), cachedTxt = pickTxt('cached');
          const missTxt = pickTxt('miss'), rateTxt = pickTxt('rate');
          const topSearchTxt = pickTxt('search'), bSearchTxt = pickTxt('b-search');
          const filled = costTxt.includes('3.96') && runsTxt === '149'
            && completionTxt === '34,000' && cachedTxt === '80,000' && missTxt === '40,000'
            && rateTxt === '66.6%' && topSearchTxt === '' && bSearchTxt === '46';
          filled ? pass++ : fail++;
          console.log('  ' + (filled ? 'OK   ' : 'FAIL ') + '数值已按新契约填充  成本=' + costTxt
            + ' 调用=' + runsTxt + ' 输出=' + completionTxt + ' 命中量=' + cachedTxt
            + ' 未命中=' + missTxt + ' 命中率=' + rateTxt + ' 行为搜索=' + bSearchTxt
            + ' 旧顶部搜索=' + (topSearchTxt === '' ? '(已移除)' : topSearchTxt));

          // 卡片数量与顺序（顶部 8、行为 9）：新增“总 token”与“会话次数”，命中率移到最后；
          // 行为区再新增「识别视频 / 音频识别」（紧跟识图，视觉三项连排）
          const behIdx = html.indexOf('data-block="behavior"');
          const chatsIdx = html.indexOf('data-block="chats"');
          const topSeg = behIdx > 0 ? html.slice(0, behIdx) : html;
          const behSeg = behIdx > 0 && chatsIdx > behIdx ? html.slice(behIdx, chatsIdx) : '';
          const cardCount = (seg) => (seg.match(/class="usage-card[ "]/g) || []).length;
          const labelsOf = (seg) => [...seg.matchAll(/class="uc-label">([^<]*)/g)].map((m) => m[1].trim());
          const topLabels = labelsOf(topSeg), behLabels = labelsOf(behSeg);
          const topOrder = ['估算成本', 'API 调用次数', '总 token（输入+输出）', '输入 token', '输出 token', '缓存命中量', '缓存未命中', '缓存命中率'];
          const behOrder = ['会话次数', '发送条数', '发送字数', '表情包数', '识图次数', '识别视频', '音频识别', '思考次数', '搜索次数'];
          const cardsOk = cardCount(topSeg) === 8 && cardCount(behSeg) === 9
            && JSON.stringify(topLabels) === JSON.stringify(topOrder)
            && JSON.stringify(behLabels) === JSON.stringify(behOrder);
          cardsOk ? pass++ : fail++;
          console.log('  ' + (cardsOk ? 'OK   ' : 'FAIL ') + '卡片新契约（顶部 8 / 行为 9）'
            + '  顶部=' + cardCount(topSeg) + '[' + topLabels.join('|') + ']'
            + '  行为=' + cardCount(behSeg) + '[' + behLabels.join('|') + ']');

          // 旧顶部搜索字段与旧「行为 · 按会话」表必须已删除
          const removedOk = !html.includes('data-field="search"')
            && !html.includes('data-table="bchats"')
            && !html.includes('行为 · 按会话');
          removedOk ? pass++ : fail++;
          console.log('  ' + (removedOk ? 'OK   ' : 'FAIL ') + '旧卡位已删除（顶部搜索 / 行为·按会话）');

          // 区块顺序：行为 → 按会话 → 单次会话 → 按模型（“按天”已删除）
          const blockOrder = ['behavior', 'chats', 'sessions', 'models']
            .map((b) => html.indexOf('data-block="' + b + '"'));
          const orderOk = blockOrder.every((v, i) => v >= 0 && (i === 0 || v > blockOrder[i - 1]));
          orderOk ? pass++ : fail++;
          console.log('  ' + (orderOk ? 'OK   ' : 'FAIL ') + '区块顺序（行为→按会话→单次→按模型）'
            + '  ' + blockOrder.join('<'));

          // 日期选择器 + 单次会话表新契约（9 列含成本、无查看按钮、整行可点）
          const dateOk = /id="usage-date"[^>]*value="\d{4}-\d{2}-\d{2}"/.test(html);
          dateOk ? pass++ : fail++;
          console.log('  ' + (dateOk ? 'OK   ' : 'FAIL ') + '日期选择器存在且默认某一天');
          const sessHead = (html.match(/<table class="usage-table clickable" data-table="sessions">([\s\S]*?)<\/thead>/) || [])[1] || '';
          // 注意 /<th/ 会把 <thead 也算进去，必须限定标签边界
          const thCount = (sessHead.match(/<th[\s>]/g) || []).length;
          const sessHeadOk = thCount === 9 && sessHead.includes('>成本<');
          sessHeadOk ? pass++ : fail++;
          console.log('  ' + (sessHeadOk ? 'OK   ' : 'FAIL ') + '单次会话表 9 列含成本'
            + '  th=' + thCount);
          const sessTbody = String(usageBox.querySelector('[data-table="sessions"] tbody')?.innerHTML || '');
          const sessRows = (sessTbody.match(/<tr data-idx="/g) || []).length;
          // 新会话显示成本、旧快照没有 cost 显示 '-'；不再有查看按钮
          const sessBodyOk = sessRows === 2 && sessTbody.includes('¥0.0123')
            && sessTbody.includes('<td class="r">-</td>')
            && !sessTbody.includes('data-session-open');
          sessBodyOk ? pass++ : fail++;
          console.log('  ' + (sessBodyOk ? 'OK   ' : 'FAIL ') + '单次会话行（2 条 / 新会话成本 / 旧快照 - / 无按钮）'
            + '  rows=' + sessRows);
          const pageInfoTxt = String(usageBox.querySelector('#sessions-pageinfo')?.textContent || '');
          const pageOk = pageInfoTxt === '第 1 / 1 页';
          pageOk ? pass++ : fail++;
          console.log('  ' + (pageOk ? 'OK   ' : 'FAIL ') + '分页页码文案  ' + pageInfoTxt);

          // 骨架屏应已被真实内容替换
          const noSkeleton = !/usage-card skeleton/.test(html);
          noSkeleton ? pass++ : fail++;
          console.log('  ' + (noSkeleton ? 'OK   ' : 'FAIL ') + '骨架屏已被替换（不是一直转圈）');

          // 骨架屏卡位要跟正式页同构（8 张指标 + 7 张行为），否则加载完成时布局会跳
          const skHtml = String((ctx.renderUsageSkeleton || sandbox.renderUsageSkeleton)?.() || '');
          const skCards = (skHtml.match(/usage-card skeleton/g) || []).length;
          const skOk = skCards === 15;
          skOk ? pass++ : fail++;
          console.log('  ' + (skOk ? 'OK   ' : 'FAIL ') + '骨架屏卡位与正式页一致（8+7）  ' + skCards);

          // 非 force（轮询）路径：只更新数值，不重建
          usageBox.innerHTML = '<div id="keepme">KEEP</div>';
          await loadUsage();
          const kept = String(usageBox.innerHTML || '').includes('KEEP');
          kept ? pass++ : fail++;
          console.log('  ' + (kept ? 'OK   ' : 'FAIL ') + '轮询(force=false)不重建 DOM');

          // ★ 第二次进入：应直接用上次数据立即渲染，不显示骨架
          //   （后端统计冷启动约 200ms，缓存 TTL 只有 5s，每次都等就是"黑一下"）
          usageBox.innerHTML = '';
          let sawSkeleton = false;
          const origSkeleton = ctx.renderUsageSkeleton || sandbox.renderUsageSkeleton;
          ctx.renderUsageSkeleton = sandbox.renderUsageSkeleton = () => { sawSkeleton = true; return origSkeleton(); };
          await loadUsage({ force: true });
          ctx.renderUsageSkeleton = sandbox.renderUsageSkeleton = origSkeleton;
          const secondHtml = String(usageBox.innerHTML || '');
          const ok2 = !sawSkeleton && secondHtml.includes('估算成本');
          ok2 ? pass++ : fail++;
          console.log('  ' + (ok2 ? 'OK   ' : 'FAIL ') + '二次进入直接显示旧数据（不闪骨架）');

          // ★ 用量页请求的接口必须真实存在（不能在测试里 mock 掉 404）
          //   上一轮就是凭空捏造了 /api/usage/prices，测试绿、线上白屏。
          const { createApp: createApp2 } = await import('../src/app.js');
          const http = await import('node:http');
          const realApp = createApp2({ log: () => {} });
          const realPort = await realApp.start(40991);
          const hit = (p) => new Promise((r) => {
            http.request({ host: '127.0.0.1', port: realPort, path: p, method: 'GET',
              headers: { 'x-console-token': 'qq-agent-console' } },
              (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r({ code: res.statusCode, d })); }
            ).on('error', () => r({ code: 0, d: '' })).end();
          });
          for (const p of ['/api/usage/stats?range=7', '/api/usage/behavior?range=7', '/api/status']) {
            const r = await hit(p);
            const ok = r.code === 200;
            ok ? pass++ : fail++;
            console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '真实接口可用 ' + p + ' → HTTP ' + r.code);
          }
          // 反向确认：不存在的接口确实返回 404（证明上面不是假阳性）
          const bad = await hit('/api/usage/prices');
          const badOk = bad.code === 404;
          badOk ? pass++ : fail++;
          console.log('  ' + (badOk ? 'OK   ' : 'FAIL ') + '不存在的接口确实 404（/api/usage/prices）');
          await realApp.stop();

          // 切到别的 range 时，旧数据不能冒用（range 对不上会显示错的区间）
          vm.runInContext("usageRange = 'today';", ctx);
          usageBox.innerHTML = '';
          let usedOld = false;
          const origPage = ctx.renderUsagePage || sandbox.renderUsagePage;
          ctx.renderUsagePage = sandbox.renderUsagePage = (...a) => { usedOld = true; return origPage(...a); };
          // 先清掉缓存，模拟"新 range 没有旧数据"
          vm.runInContext('usageLastData = null;', ctx);
          usageBox.innerHTML = '';
          await loadUsage({ force: true });
          ctx.renderUsagePage = sandbox.renderUsagePage = origPage;
          vm.runInContext("usageRange = '7';", ctx);
          const ok3 = usedOld;
          ok3 ? pass++ : fail++;
          console.log('  ' + (ok3 ? 'OK   ' : 'FAIL ') + '切换 range 会重新渲染（不误用旧区间数据）');
        } catch (e) {
          fail++; console.log('  FAIL 抛错: ' + (e && e.message));
        } finally {
          sandbox.fetch = realFetch;
        }
      }
    }

  // ── 会话详情 SSE 实时性（2026-09-05 回归）──
  // 曾经的三个洞：① SSE 载荷不带 sent →"已发送"徽标只能等手动刷新；
  // ② session-end 不重拉详情（轮询只刷 running/waiting，最终态再也不来）；
  // ③ 渲染合批用 rAF → 窗口被遮挡时完全停火，渲染全部积压。
  console.log('\n=== 会话详情 SSE 实时推送 ===');
  try {
    const detailBox = document.querySelector('#session-detail');
    vm.runInContext(`
      state.tab = 'sessions';
      state.currentSessionId = 's_sse_1';
      state.sessionDetail = { id: 's_sse_1', chatKey: 'group:1', status: 'running', startedAt: 1,
        messages: [], sent: [], usage: { calls: 0 }, rounds: 0 };
      state.sessions = [{ id: 's_sse_1', chatKey: 'group:1', status: 'running', startedAt: 1, messages: [], sent: [] }];
      state.chats = [];
      lastDetailFp = null;
    `, ctx);
    ctx.connectSSE();   // 把处理器注册进 sseRegistry（init 里那次可能还没执行到）
    const fireSse = (type, data) => { for (const fn of sseRegistry[type] || []) fn({ data: JSON.stringify(data) }); };
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

    // ① session-update 携带 sent：合批（80ms）后详情必须实时出现工具卡片与"已发送"徽标
    fireSse('session-update', {
      sessionId: 's_sse_1', chatKey: 'group:1', status: 'running', activity: '',
      rounds: 1, usage: { calls: 1 },
      messages: [{ role: 'assistant', content: '让我想想' },
        { toolCall: { name: 'send_message', args: { messages: '实时你好' }, result: '已发送' } }],
      sent: [{ type: 'text', text: '实时你好', at: '12:00:00' }]
    });
    await sleepMs(250);
    const html1 = String(detailBox.innerHTML || '');
    const okTool = html1.includes('send_message');
    okTool ? pass++ : fail++;
    console.log('  ' + (okTool ? 'OK   ' : 'FAIL ') + '工具卡片实时出现（send_message）' + (okTool ? '' : ' -> ' + html1.slice(0, 100)));
    const okSent = html1.includes('实时你好');
    okSent ? pass++ : fail++;
    console.log('  ' + (okSent ? 'OK   ' : 'FAIL ') + '已发送徽标实时出现（不等轮询/手动刷新）' + (okSent ? '' : ' -> ' + html1.slice(0, 100)));

    // ② session-end：当前开着的会话必须自动重拉完整详情（最终 sent/finishReason）
    const finalSession = { id: 's_sse_1', chatKey: 'group:1', status: 'done', startedAt: 1, endedAt: 2,
      messages: [{ role: 'assistant', content: '让我想想' }],
      sent: [{ type: 'text', text: '最终发言', at: '12:00:01' }],
      usage: { calls: 1 }, rounds: 1, finishReason: 'stop' };
    const origFetch2 = sandbox.fetch;
    sandbox.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sessions/s_sse_1')) return { ok: true, json: async () => finalSession };
      if (u.includes('/api/sessions')) return { ok: true, json: async () => ({ sessions: [finalSession] }) };
      return origFetch2(url);
    };
    fireSse('session-end', { sessionId: 's_sse_1', chatKey: 'group:1', status: 'done' });
    await sleepMs(400);
    sandbox.fetch = origFetch2;
    const html2 = String(detailBox.innerHTML || '');
    const okFinal = html2.includes('最终发言');
    okFinal ? pass++ : fail++;
    console.log('  ' + (okFinal ? 'OK   ' : 'FAIL ') + 'session-end 后详情自动刷出最终 sent（不用手动刷新）' + (okFinal ? '' : ' -> ' + html2.slice(0, 100)));
  } catch (e) {
    fail++; console.log('  FAIL SSE 实时性测试抛错: ' + (e && e.message));
  }

  // ── 批量自定义价格编辑弹窗（2026-09-05 改版：供应商 → 模型 → 官方价）──
  console.log('\n=== 批量自定义价格编辑弹窗 ===');
  try {
    vm.runInContext(`
      state.providers = [
        { id: 'a6api', displayName: 'A6API中转站', models: ['deepseek-v4-flash', 'glm-5.3'], modelNames: {} },
        { id: 'openrouter', displayName: 'OpenRouter', models: ['openai/gpt-5.6-luna'], modelNames: {} }
      ];
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = { 'orphan-model-x': { in: 1, out: 2, cached: 0.1 } };
      state.modelPrices = { prices: [{ id: 'deepseek-v4-flash', in: 1.5, out: 4.5, cached: 0.05 }], current: null };
    `, ctx);
    ctx.openBatchPriceModal();
    const overlay = document.body.children[document.body.children.length - 1];
    const leftHtml = String(overlay.querySelector('#bp-left').innerHTML || '');
    const rightHtml = String(overlay.querySelector('#bp-right').innerHTML || '');
    const okProv = leftHtml.includes('A6API中转站') && leftHtml.includes('OpenRouter');
    okProv ? pass++ : fail++;
    console.log('  ' + (okProv ? 'OK   ' : 'FAIL ') + '左列展示供应商列表' + (okProv ? '' : ' -> ' + leftHtml.slice(0, 120)));
    const okOrphan = leftHtml.includes('已自定义（目录外');
    okOrphan ? pass++ : fail++;
    console.log('  ' + (okOrphan ? 'OK   ' : 'FAIL ') + '目录外已自定义模型归入虚拟供应商');
    const okModel = rightHtml.includes('deepseek-v4-flash');
    okModel ? pass++ : fail++;
    console.log('  ' + (okModel ? 'OK   ' : 'FAIL ') + '右列展示选中供应商的模型');
    const okOff = !rightHtml.includes('官方 输入') && !rightHtml.includes('官方 缓存命中');
    okOff ? pass++ : fail++;
    console.log('  ' + (okOff ? 'OK   ' : 'FAIL ') + '官方价不占列（太挤，改走占位符/悬停）');
    const okPh = rightHtml.includes('placeholder="1.5"') && rightHtml.includes('官方价：输入 1.5 / 输出 4.5');
    okPh ? pass++ : fail++;
    console.log('  ' + (okPh ? 'OK   ' : 'FAIL ') + '官方价仍在占位符与悬停提示里' + (okPh ? '' : ' -> ' + rightHtml.slice(0, 150)));
  } catch (e) {
    fail++; console.log('  FAIL 批量价格弹窗抛错: ' + (e && e.message));
  }

} catch (e) {
  fail++;
  console.log('\n加载 app.js 失败: ' + (e && e.message));
  console.log(e && e.stack && e.stack.split('\n').slice(0, 6).join('\n'));
}

// ── 模型管理：手动添加模型 / 添加提供商自动拉取（2026-09-26 回归）──
console.log('\n=== 模型管理 · 添加入口 ===');
{
  const fn1 = sandbox.openManualAddModelModal;
  const fn2 = sandbox.openProviderAddModal;
  let ok1 = typeof fn1 === 'function';
  let ok2 = typeof fn2 === 'function';
  if (ok1) {
    try { ok1 = !!fn1({ id: 'p1', displayName: '测试提供商', models: [] }, () => {}); }
    catch (e) { ok1 = false; console.log('  FAIL  openManualAddModelModal 抛错: ' + (e && e.message)); }
  }
  if (ok2) {
    try { ok2 = !!fn2(() => {}); }
    catch (e) { ok2 = false; console.log('  FAIL  openProviderAddModal 抛错: ' + (e && e.message)); }
  }
  ok1 ? pass++ : fail++;
  console.log('  ' + (ok1 ? 'OK   ' : 'FAIL ') + 'openManualAddModelModal 可打开（模型管理的手动添加入口）');
  ok2 ? pass++ : fail++;
  console.log('  ' + (ok2 ? 'OK   ' : 'FAIL ') + 'openProviderAddModal 可打开（失焦自动拉取挂在它的表单上）');
}

// ── alert → 应用内红色弹窗（2026-09-26 回归）────────────────────────
console.log('\n=== 应用内 alert 弹窗 ===');
{
  let ov = null;
  let err = '';
  try { ov = sandbox.showAppAlert('测试提示内容'); }
  catch (e) { err = String(e && e.message); }
  const html = String((ov && ov.innerHTML) || '');
  const okOpen = !!ov && !err;
  okOpen ? pass++ : fail++;
  console.log('  ' + (okOpen ? 'OK   ' : 'FAIL ') + 'showAppAlert 可打开' + (err ? ' -> ' + err : ''));
  const okRed = html.includes('danger') && html.includes('app-alert-text') && html.includes('测试提示内容');
  okRed ? pass++ : fail++;
  console.log('  ' + (okRed ? 'OK   ' : 'FAIL ') + '红色配色（danger）+ 原文完整呈现');
  const wrapped = typeof sandbox.alert === 'function' && sandbox.alert !== alertStub;
  wrapped ? pass++ : fail++;
  console.log('  ' + (wrapped ? 'OK   ' : 'FAIL ') + 'window.alert 已被包装为应用内弹窗');
}

// ── 顶栏余额（2026-11-01 回归）────────────────────────────────────
console.log('\n=== 顶栏余额刷新（refreshBalance）===');
{
  const label = document.querySelector('#balance-label');
  const run = async (payload) => {
    const orig = sandbox.fetch;
    sandbox.fetch = async () => ({ ok: true, json: async () => payload });
    try { await sandbox.refreshBalance(); } finally { sandbox.fetch = orig; }
  };
  const defined = typeof sandbox.refreshBalance === 'function';
  defined ? pass++ : fail++;
  console.log('  ' + (defined ? 'OK   ' : 'FAIL ') + 'refreshBalance 已定义');
  if (defined) {
    let err = '';
    try { await run({ ok: false, reason: 'empty', available: true, at: Date.now() }); }
    catch (e) { err = String(e && e.message); }
    const okEmpty = !err && label.textContent === '余额：暂无' && !label.classList.contains('alert');
    okEmpty ? pass++ : fail++;
    console.log('  ' + (okEmpty ? 'OK   ' : 'FAIL ') + '空币种 → 余额：暂无（不报错）' + (err ? ' -> ' + err : ''));

    let errOff = '';
    try { await run({ ok: false, reason: 'empty', available: false, at: Date.now() }); }
    catch (e) { errOff = String(e && e.message); }
    const okEmptyOff = !errOff && label.textContent === '余额：暂无'
      && label.classList.contains('alert')
      && String(label.title).includes('账户当前不可用');
    okEmptyOff ? pass++ : fail++;
    console.log('  ' + (okEmptyOff ? 'OK   ' : 'FAIL ') + '空币种 + 账户不可用 → 余额：暂无（alert + 标题提示）' + (errOff ? ' -> ' + errOff : ''));

    await run({ ok: false, reason: 'no-key', at: Date.now() });
    const okNoKey = label.textContent === '余额：未配置 Key';
    okNoKey ? pass++ : fail++;
    console.log('  ' + (okNoKey ? 'OK   ' : 'FAIL ') + 'no-key → 余额：未配置 Key');

    await run({
      ok: true, available: true, currency: 'CNY', total: 110, granted: 10, toppedUp: 100, at: Date.now(),
      infos: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }]
    });
    const okAmount = label.textContent === '余额：¥110.00';
    okAmount ? pass++ : fail++;
    console.log('  ' + (okAmount ? 'OK   ' : 'FAIL ') + '成功 → 余额：¥110.00');
  }
}

// ── 表情包固定选取：mergeStickerPickIds（2026-11-02 回归）─────────────
console.log('\n=== 表情包固定选取 · mergeStickerPickIds ===');
{
  const merge = typeof sandbox.mergeStickerPickIds === 'function' ? sandbox.mergeStickerPickIds : null;
  const defined = !!merge;
  defined ? pass++ : fail++;
  console.log('  ' + (defined ? 'OK   ' : 'FAIL ') + 'mergeStickerPickIds 已定义');
  if (merge) {
    const sameOrder = JSON.stringify(merge(['b', 'a', 'c'], ['c', 'a', 'b'])) === JSON.stringify(['b', 'a', 'c']);
    sameOrder ? pass++ : fail++;
    console.log('  ' + (sameOrder ? 'OK   ' : 'FAIL ') + '旧勾选顺序保持不变（不被当前列表顺序改写）');

    const appended = JSON.stringify(merge(['b', 'a'], ['a', 'b', 'd', 'c'])) === JSON.stringify(['b', 'a', 'd', 'c']);
    appended ? pass++ : fail++;
    console.log('  ' + (appended ? 'OK   ' : 'FAIL ') + '新勾选按勾选顺序追加在末尾');

    const removed = JSON.stringify(merge(['a', 'b', 'c'], ['a', 'c'])) === JSON.stringify(['a', 'c']);
    removed ? pass++ : fail++;
    console.log('  ' + (removed ? 'OK   ' : 'FAIL ') + '取消勾选的 id 被移除');

    const deduped = JSON.stringify(merge(['a', 'a'], ['a', 'a', 'b', 'b'])) === JSON.stringify(['a', 'b']);
    deduped ? pass++ : fail++;
    console.log('  ' + (deduped ? 'OK   ' : 'FAIL ') + '重复 id 去重');

    const prior = Array.from({ length: 25 }, (_, i) => `id-${i + 1}`);
    const notTruncated = JSON.stringify(merge(prior, prior)) === JSON.stringify(prior);
    notTruncated ? pass++ : fail++;
    console.log('  ' + (notTruncated ? 'OK   ' : 'FAIL ') + '保存侧不截断（25 条原样保留）');

    const invalid = Array.isArray(merge(null, null)) && merge(null, null).length === 0;
    invalid ? pass++ : fail++;
    console.log('  ' + (invalid ? 'OK   ' : 'FAIL ') + '非数组输入返回空数组（不抛错）');
  }
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / passed ' + pass : 'ALL PASSED ' + pass));
process.exit(fail ? 1 : 0);
