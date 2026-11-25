// 覆盖测试 D：静态界面层
//
// 覆盖：
//   - 样式表结构（主题块不重复、无冲突重复选择器、无死样式、括号平衡）
//   - HTML 本地资源引用全部存在
//   - 主题机制统一（data-theme + qqa-theme）
//   - ui/vendor 下的镜像文件与 src/ 逻辑一致
//   - app.js 引用的 DOM id 都能在某处被创建
//   - 弹窗可访问性（role/aria/Esc 关闭）
//
// 运行：node test/coverage-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, createChecker } from './_harness.mjs';

const c = createChecker('静态界面层覆盖');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const css = read('ui/style.css');
const html = read('ui/index.html');
const landing = read('ui/landing.html');
// M9 拆分：静态扫描面向全部 12 段拼接后的完整代码（与浏览器实际执行的集合一致）
const appJs = (await import('./_ui-load.mjs')).loadUiAppCode().code;

// ── 1. 样式表结构 ────────────────────────────────────────────────────────
c.section('1. 样式表结构');

/** 简易顶层规则解析（与审查脚本一致） */
function parseRules(src) {
  const lines = src.split('\n');
  const rules = [];
  let depth = 0, buf = '', sel = '', start = 0, inComment = false;
  for (let ln = 0; ln < lines.length; ln++) {
    let s = lines[ln].replace(/\/\*.*?\*\//g, '');
    if (inComment) { const e = s.indexOf('*/'); if (e >= 0) { inComment = false; s = s.slice(e + 2); } else continue; }
    const cs = s.indexOf('/*');
    if (cs >= 0) { const ce = s.indexOf('*/', cs); if (ce < 0) { inComment = true; s = s.slice(0, cs); } }
    for (const ch of s) {
      if (ch === '{') { if (depth === 0) { sel = buf.trim(); start = ln + 1; } depth++; buf += ch; }
      else if (ch === '}') { depth--; buf += ch; if (depth === 0) { rules.push({ sel, start, body: buf }); buf = ''; } }
      else buf += ch;
    }
    if (depth === 0) buf = '';
  }
  return rules;
}

await c.check('CSS 大括号平衡', () => {
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  assert.equal(open, close, `{ ${open} vs } ${close}`);
});

const rules = parseRules(css);

await c.check('「？」主题（已移除的彩蛋主题）基础 token 块不得残留', () => {
  // 2026-09 concept2 收敛版把「？」主题整体移除（:root + dark/light 两个 data-theme 块）。
  // 原断言要求该块"恰好出现 1 次"，但主题已删，现改为不得出现。
  const tokenBlocks = rules.filter((r) => /^\s*\[data-theme='\?'\]\s*$/.test(r.sel));
  assert.equal(tokenBlocks.length, 0, `? 主题基础 token 块应已移除，但仍出现 ${tokenBlocks.length} 次：行 ${tokenBlocks.map((r) => r.start).join(', ')}`);
  const banners = (css.match(/「？」主题 v3/g) || []).length;
  assert.equal(banners, 0, `「？」主题 v3 的注释横幅应已移除，但仍出现 ${banners} 次`);
});

await c.check('没有任何选择器被重复定义且属性值冲突', () => {
  const bySel = new Map();
  for (const r of rules) {
    const key = r.sel.replace(/\s+/g, ' ').trim();
    if (!key || key.startsWith('@')) continue;
    if (!bySel.has(key)) bySel.set(key, []);
    bySel.get(key).push(r);
  }
  const conflicts = [];
  for (const [sel, list] of bySel) {
    if (list.length < 2) continue;
    const props = new Map();
    for (const r of list) {
      const inner = r.body.slice(r.body.indexOf('{') + 1, r.body.lastIndexOf('}'));
      for (const decl of inner.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const p = decl.slice(0, i).trim();
        const v = decl.slice(i + 1).trim();
        if (!p || !v) continue;
        if (!props.has(p)) props.set(p, new Set());
        props.get(p).add(v);
      }
    }
    for (const [p, vals] of props) {
      if (vals.size > 1) conflicts.push(`${sel} { ${p}: ${[...vals].join(' VS ')} }`);
    }
  }
  assert.equal(conflicts.length, 0, `存在 ${conflicts.length} 处冲突：\n  ${conflicts.join('\n  ')}`);
});

await c.check('已删除的「保存栏」相关样式不得残留（组件已改为即时保存）', () => {
  for (const dead of ['.save-bar', '.unsaved-dot', '.saved-pulse', '.saved-flash', '#cfg-save-result', '@keyframes pulseRing', '@keyframes savedFlash']) {
    assert.ok(!css.includes(dead), `样式表里仍残留 ${dead}`);
  }
});

await c.check('引用 @keyframes 动画名都必须有定义（避免写了动画却不生效）', () => {
  const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  const used = new Set();
  for (const m of css.matchAll(/animation(?:-name)?:\s*([^;}]+)/g)) {
    for (const part of m[1].split(',')) {
      for (const tok of part.trim().split(/\s+/)) {
        if (/^[a-zA-Z][\w-]*$/.test(tok) && !/^(none|infinite|linear|ease|ease-in|ease-out|ease-in-out|forwards|backwards|both|alternate|reverse|running|paused|steps|var)$/.test(tok)) {
          used.add(tok);
        }
      }
    }
  }
  const missing = [...used].filter((k) => !defined.has(k) && !k.startsWith('--'));
  assert.equal(missing.length, 0, `使用了未定义的动画名：${missing.join(', ')}`);
});

await c.check('主题 token 齐备：两个主题都定义了颜色/阴影/前景色变量', () => {
  for (const v of ['--layer-0', '--text', '--muted', '--accent', '--green', '--red', '--orange',
    '--lift-sm', '--lift', '--lift-lg', '--paper-edge', '--depth', '--bevel', '--on-accent', '--overlay']) {
    const hits = (css.match(new RegExp(`\\${v}:`, 'g')) || []).length;
    assert.ok(hits >= 2, `${v} 只出现了 ${hits} 次（至少应在暗/亮两个主题各定义一次）`);
  }
});

// ── 2. HTML 资源引用 ─────────────────────────────────────────────────────
c.section('2. HTML 资源引用与主题机制');

function localRefs(src) {
  const out = [];
  // 只检查"子资源"（script/link/img 的 src/href）。
  // <a href> 是站内导航（落地页部署在官网时 /qq-agent/... 是有效的），不算本地资源；
  // 安装包下载链接另有专门断言。
  for (const m of src.matchAll(/<script[^>]*?src="([^"]+)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/<link[^>]*?href="([^"]+)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/<img[^>]*?src="([^"]+)"/g)) out.push(m[1]);
  return out.filter((u) => !/^(https?:|mailto:|#|data:)/.test(u));
}

await c.check('index.html 的本地资源引用全部存在', () => {
  for (const u of localRefs(html)) {
    const p = path.join(ROOT, 'ui', u.replace(/^\//, ''));
    assert.ok(fs.existsSync(p), `index.html 引用了不存在的资源：${u}`);
  }
});

await c.check('landing.html 的本地资源引用全部存在（曾经引用过不存在的 /assets/theme.*）', () => {
  // ⚠️ landing.html 是**部署到官网**的落地页：/assets/theme.* 是站点级主题包，
  // 存在于服务器上而不在本仓库 ui/ 下（本地直开由 .no-theme 兜底，见页面注释）。
  // 站级资源只校验路径前缀；与页面同目录的相对文件（如群二维码）必须本地存在。
  for (const u of localRefs(landing)) {
    if (/^\/(assets|vendor)\//.test(u)) continue;   // 站级资源，服务器侧存在
    // 群二维码图片：随 ui/ 一起分发（设置页彩蛋与 landing 都引用它）。
    if (u === 'group-qrcode.svg') {
      const p = path.join(ROOT, 'ui', u);
      assert.ok(fs.existsSync(p), `landing.html 引用的群二维码不存在：${u}`);
      continue;
    }
    if (u.startsWith('/')) {
      assert.fail(`landing.html 不应引用其它本地根路径资源：${u}`);
    } else {
      const p = path.join(ROOT, 'ui', u);
      assert.ok(fs.existsSync(p), `landing.html 引用了不存在的同目录资源：${u}`);
    }
  }
});

await c.check('两个页面的主题机制统一：data-theme + qqa-theme', () => {
  // landing.html 跟随**主站**的主题约定（localStorage 'theme' 键 + html.light/dark），
  // 与控制台（qqa-theme 键）是两套刻意的口径 —— 只对 index.html 校验控制台约定。
  for (const [name, src] of [['index.html', html]]) {
    assert.ok(/qqa-theme/.test(src), `${name} 未使用 qqa-theme 键`);
    assert.ok(/data-theme/.test(src), `${name} 未使用 data-theme 属性`);
    assert.ok(!/localStorage\.getItem\('theme'\)/.test(src), `${name} 仍在读旧的 'theme' 键`);
    assert.ok(!/html\.dark\s*\{/.test(src), `${name} 仍在使用 html.dark 选择器（永远不会命中）`);
  }
});

// ── 2.1 页签与视图容器必须成对 ───────────────────────────────────────────
//
// 加页签时最容易漏掉的第二步：只在 nav 里加了按钮，忘了加 <section id="view-xxx">。
// 后果是点上去"什么也不发生"（switchTab 把视图全隐藏了，但没有一个匹配），
// 而且不报错 —— 正是最该由静态检查兜住的一类。

c.section('2.1 页签 ↔ 视图容器');

await c.check('每个页签都有对应的 view-<name> 容器', () => {
  const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 5, `页签数量异常（${tabs.length}）：${tabs.join(', ')}`);
  const missing = tabs.filter((t) => !html.includes(`id="view-${t}"`));
  assert.equal(missing.length, 0,
    `这些页签没有对应的视图容器（点上去会没有任何反应）：${missing.join(', ')}`);
});

await c.check('「插件」页签存在，且紧挨着「技能」右边', () => {
  const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  const i = tabs.indexOf('skills');
  assert.ok(i >= 0, '找不到「技能」页签');
  assert.ok(tabs.includes('plugins'), '找不到「插件」页签');
  assert.equal(tabs[i + 1], 'plugins',
    `「插件」应当紧跟在「技能」右边，实际顺序：${tabs.join(' → ')}`);
  // 两个视图容器也都得在
  for (const id of ['view-skills', 'view-plugins']) {
    assert.ok(html.includes(`id="${id}"`), `缺少视图容器 ${id}`);
  }
});

await c.check('切换页签会加载对应页（switchTab 里两个分支都在）', () => {
  // 只加按钮不加分支 = 点进去是空白页（容器存在但没有渲染逻辑）
  assert.ok(/name === 'skills'\)\s*loadModulePage\('skill'\)/.test(appJs),
    "switchTab 里没有 skills 分支");
  assert.ok(/name === 'plugins'\)\s*loadModulePage\('plugin'\)/.test(appJs),
    "switchTab 里没有 plugins 分支");
});

await c.check('技能页与插件页按 kind 隔离（不会把插件渲染进技能页）', () => {
  // 两页共用 renderModulePage，靠 kind 过滤。过滤条件一旦写错，
  // 两页会显示一样的内容 —— 静态上先盯住"过滤用的是 kind、不是 source"。
  const m = /function renderModulePage\(kind\)[\s\S]*?\n  const items = (.+?);/.exec(appJs);
  assert.ok(m, '找不到 renderModulePage 里的条目过滤');
  assert.ok(/s\.kind === meta\.kind/.test(m[1]),
    `条目过滤没有按 kind 判型：${m[1]}`);
});

await c.check('landing.html 的下载链接与打包产物一致（官网同目录部署，相对路径即可）', () => {
  // 安装包文件名由 package.json 的 build.artifactName 决定（0.4 起是
  // QQ-Agent-V0.4-Preview-Setup.exe）。落地页与安装包同目录部署在官网，
  // 链接必须是同目录相对文件名，且与打包产物逐字一致 —— 否则官网点了 404。
  // 旧断言把名字硬编码成 "qq-agent-v<数字>-setup.exe"，与 artifactName 漂移后误报。
  const pkg = JSON.parse(read('package.json'));
  const artifact = String(pkg?.build?.artifactName || '');
  assert.ok(artifact, 'package.json 缺少 build.artifactName（打包产物名没有唯一来源）');
  const esc = artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`href="([^"]*${esc})"`).exec(landing);
  assert.ok(m, `找不到安装包下载链接（期望与 artifactName 一致：${artifact}）`);
  assert.equal(m[1], artifact, `落地页应链接同目录相对文件名 ${artifact}，实际：${m[1]}`);
});

// ── 3. vendor 镜像一致性 ─────────────────────────────────────────────────
c.section('3. vendor 镜像一致性');

await c.check('ui/vendor/tier-slider.js 与 src/tier-slider.js 的逻辑一致（去掉注释后逐字相同）', () => {
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const a = strip(read('src/tier-slider.js'));
  const b = strip(read('ui/vendor/tier-slider.js'));
  assert.equal(a, b, '两份 tier-slider 已经漂移：前端实际用的是 ui/vendor 那份，后端用 src/ 那份');
});

await c.check('ui/vendor/price-match.js 与 src/model-prices.js 的 matchPriceTable 对同一输入结果一致', async () => {
  const { matchPriceTable: backend } = await import('../src/model-prices.js');
  const { matchPriceTable: frontend } = await import('../ui/vendor/price-match.js');
  const { listOfficialPrices } = await import('../src/model-prices.js');
  const table = listOfficialPrices();
  for (const id of table.slice(0, 12).map((x) => x.id)) {
    const a = backend(id, table);
    const b = frontend(id, table);
    assert.ok(Boolean(a) === Boolean(b), `模型 ${id} 命中结果不一致：后端=${Boolean(a)} 前端=${Boolean(b)}`);
  }
});

// ── 4. DOM id 交叉检查 ───────────────────────────────────────────────────
c.section('4. DOM id 交叉检查');

await c.check('app.js 里 $(\'#id\') / getElementById 引用的 id 都能被创建', () => {
  const declared = new Set();
  // index.html 里静态声明的
  for (const m of html.matchAll(/\bid="([\w-]+)"/g)) declared.add(m[1]);
  // app.js 模板字符串里创建的字面量 id
  for (const m of appJs.matchAll(/\bid="([\w-]+)"/g)) declared.add(m[1]);
  // app.js 里用 JS 赋值的 id（如 vhs.id = 'chaos-vhs'）
  for (const m of appJs.matchAll(/\.id\s*=\s*'([\w-]+)'/g)) declared.add(m[1]);
  // 动态拼接的 id（id="${...}"）无法静态判断，忽略
  // 运行时动态拼接的选择器（'#' + fieldId）：按已知动态名单豁免
  const DYNAMIC_IDS = new Set([
    // switchHtml(id, …) 生成 id="${id}" 的开关；静态扫描看不到模板内部，按字面量调用豁免
    'cfg-useofficialprice', 'cfg-tools-enabled', 'cfg-imagesend',
    'cfg-persona-unified', 'cfg-autostart', 'cfg-closetray', 'cfg-showvision',
    'cfg-proactive', 'cfg-sticker', 'cfg-websearch', 'cfg-allowallwhenempty'
  ]);
  const refs = new Set();
  for (const m of appJs.matchAll(/\$\('#([\w-]+)'\)/g)) refs.add(m[1]);
  for (const m of appJs.matchAll(/getElementById\('([\w-]+)'\)/g)) refs.add(m[1]);
  const missing = [...refs].filter((id) => !declared.has(id) && !DYNAMIC_IDS.has(id));
  assert.equal(missing.length, 0, `这些 id 被引用但从未创建：${missing.join(', ')}`);
});

// ── 4.1 记忆三独立页 ─────────────────────────────────────────────────────
//
// 直读新单文件 `ui/app/14-mem-pages.js`，不走拼接后的 appJs：
//   ① 纳入 APP_PARTS 前后都要能跑，别让红绿取决于「有没有纳入」这个无关变量；
//   ② 拼接后 indexOf('loadImpressionPage(') 会先命中定义处，位置比较全部失真。
c.section('4.1 记忆三独立页');

const pagesSrc = read('ui/app/14-mem-pages.js');
const coreSrc = read('ui/app/00-core.js');
const loadSrc = read('test/_ui-load.mjs');
const TABS = ['mem-impression', 'mem-knowledge', 'mem-summaries'];

await c.check('S1 顶层导航：三个新入口，无「记忆库」', () => {
  const navOpen = html.indexOf('<nav id="tabs"');
  const navClose = html.indexOf('</nav>', navOpen);
  assert.ok(navOpen >= 0 && navClose > navOpen, '找不到 #tabs 导航');
  const nav = html.slice(navOpen, navClose);
  for (const t of TABS) {
    assert.ok(nav.includes(`data-tab="${t}"`), `导航缺少 data-tab="${t}"`);
  }
  assert.ok(!/data-tab="mem2"/.test(nav), '导航仍有 data-tab="mem2"');
  assert.ok(!nav.includes('记忆库'), '导航仍出现「记忆库」字样');
  assert.equal([...nav.matchAll(/data-tab="mem-/g)].length, 3, '导航里 mem-* 入口数不为 3');
  const order = [...nav.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  const start = order.indexOf('chats');
  const end = order.indexOf('usage');
  assert.ok(start >= 0 && end > start, '找不到「存档」与「用量」的锚点');
  assert.deepEqual(order.slice(start + 1, end), TABS, '三页未按 印象/知识/摘要 顺序插在存档与用量之间');
});

await c.check('S2 三个 section 都是 list-pane + detail-pane', () => {
  for (const t of TABS) {
    const at = html.indexOf(`id="view-${t}"`);
    assert.ok(at > 0, `找不到 #view-${t}`);
    const end = html.indexOf('</section>', at);
    assert.ok(end > at, `#view-${t} 没有闭合`);
    const body = html.slice(at, end);
    assert.ok(/class="view"/.test(body), `#view-${t} 缺 class="view"`);
    assert.equal((body.match(/class="list-pane"/g) || []).length, 1, `#view-${t} 的 list-pane 不是恰好 1 个`);
    assert.equal((body.match(/class="detail-pane"/g) || []).length, 1, `#view-${t} 的 detail-pane 不是恰好 1 个`);
    assert.ok(body.indexOf('class="list-pane"') < body.indexOf('class="detail-pane"'), `#view-${t} 左右顺序反了`);
  }
  assert.equal(html.split('<section').length - 1, html.split('</section>').length - 1, 'section 标签不配平（可能嵌套了）');
  assert.equal(html.split('<section').length - 1, 11, 'section 总数不是施工后的 11 个');
});

await c.check('S3 旧骨架在 html/css/js 三处都消失', () => {
  const dead = ['mem2-page', 'mem2-detail', 'mem2-tabs', 'mem2-pane',
                'mem2-head', 'mem2-main', 'mem2-list-items', 'data-mem2tab'];
  for (const [name, src] of [['index.html', html], ['style.css', css], ['14-mem-pages.js', pagesSrc]]) {
    for (const d of dead) assert.ok(!src.includes(d), `${name} 仍含 ${d}`);
  }
  assert.ok(!/MEM2_TABS|ensureMem2TabData|loadMem2View|mem2Shell|renderMem2\(/.test(pagesSrc),
    '14-mem-pages.js 里仍有旧模型标识符');
});

await c.check('S4 switchTab 三条新路由', () => {
  const map = { 'mem-impression': 'loadImpressionPage',
                'mem-knowledge': 'loadKnowledgePage', 'mem-summaries': 'loadSummariesPage' };
  for (const [tab, fn] of Object.entries(map)) {
    const re = new RegExp(`name === '${tab}'[^\\n]*?${fn}\\(\\)`);
    assert.ok(re.test(coreSrc), `switchTab 缺少 ${tab} → ${fn}()`);
  }
  assert.ok(!/loadMem2View/.test(coreSrc), 'switchTab 仍有 loadMem2View()');
});

await c.check('S5 APP_PARTS 与 index.html 脚本顺序一致', () => {
  const order = [...html.matchAll(/<script defer src="\/app\/([\w.-]+)"><\/script>/g)].map((m) => m[1]);
  const parts = [...loadSrc.matchAll(/'(\d\d-[\w.-]+\.js)'/g)].map((m) => m[1]);
  assert.deepEqual(parts, order, 'APP_PARTS 与 index.html 的 defer 顺序不一致');
  assert.ok(order.includes('14-mem-pages.js'), 'index.html 没有加载 14-mem-pages.js');
  assert.ok(!order.includes('14-mem2.js'), 'index.html 仍在加载 14-mem2.js');
});

await c.check('S6 列表滚动规则：三新 id 在内，旧 mem2 在外', () => {
  const at = css.indexOf('#session-items,');
  assert.ok(at >= 0, '找不到滚动规则组');
  const block = css.slice(at, css.indexOf('}', at) + 1);
  for (const t of ['impression', 'knowledge', 'summaries']) {
    assert.ok(block.includes(`#${t}-items`), `滚动规则组缺少 #${t}-items`);
  }
  assert.ok(!block.includes('#mem2-list-items'), '滚动规则组仍含 #mem2-list-items');
  assert.ok(block.includes('overflow-y: auto'), '滚动规则组丢了 overflow-y');
});

await c.check('S7 旧骨架样式删除、内容样式保留', () => {
  for (const dead of ['.mem2-pane', '.mem2-head', '.mem2-tabs', '.mem2-tab', '.mem2-main', '.mem2-month-row']) {
    assert.ok(!new RegExp(`\\${dead}\\s*[,{]`).test(css), `style.css 仍有 ${dead}`);
  }
  for (const keep of ['.mem2-card', '.mem2-flag', '.mem2-table', '.mem2-deletion-count', '.mem2-note']) {
    assert.ok(css.includes(keep), `style.css 丢了内容样式 ${keep}`);
  }
  assert.ok(/\.list-filter\s*\{/.test(css), 'style.css 缺 .list-filter');
  assert.ok(/\.detail-toolbar\s*\{/.test(css), 'style.css 缺 .detail-toolbar');
  assert.ok(!/\.mem2-table\s+th\s*\{[^}]*position\s*:\s*sticky/.test(css),
    '摘要表头不应 sticky：滚动时会吸附在 .detail-pane 顶部');
  assert.ok(/\.usage-table\s+thead\s+th\s*\{[^}]*position\s*:\s*sticky/.test(css),
    '.usage-table 的独立 sticky 不应被误删');
});

await c.check('S8 旧文件删除 / 新文件存在 / 段数 15', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'ui', 'app', '14-mem2.js')), 'ui/app/14-mem2.js 还在');
  assert.ok(fs.existsSync(path.join(ROOT, 'ui', 'app', '14-mem-pages.js')), 'ui/app/14-mem-pages.js 不存在');
  assert.equal([...loadSrc.matchAll(/'(\d\d-[\w.-]+\.js)'/g)].length, 15, 'APP_PARTS 段数不为 15');
});

// 花括号配平截取函数体。**只对 loadXxxPage 用**：它们内部无嵌套函数，
// 配平足够；不要拿它去截带模板字符串的渲染函数（花括号会被字符串里的 {} 干扰）。
function fnBodyOf(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `找不到 function ${name}()`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  assert.fail(`${name}() 花括号不配平`);
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

await c.check('S9 三个页面加载器都不等待网络', () => {
  for (const fn of ['loadImpressionPage', 'loadKnowledgePage', 'loadSummariesPage']) {
    const decl = new RegExp(`(async\\s+)?function\\s+${fn}\\s*\\(`).exec(pagesSrc);
    assert.ok(decl, `找不到 function ${fn}()`);
    assert.ok(!decl[1], `${fn} 被声明成 async：首屏会被网络挡住`);
    const code = stripComments(fnBodyOf(pagesSrc, fn));
    assert.ok(!/\bawait\s+[A-Za-z_$(]/.test(code), `${fn} 里出现 await：首屏会被网络挡住`);
  }
});

await c.check('S10 印象页：先出内容 → 并行发起 → chats 回来才补下拉（仅一次，且在 then 回调内）', () => {
  const code = stripComments(fnBodyOf(pagesSrc, 'loadImpressionPage'));
  const iRender = code.indexOf('renderImpressionAll(');
  const iChats  = code.indexOf('ensureChats(');
  const iPeople = code.indexOf('loadImpressionPeople(');
  assert.ok(iRender >= 0, 'loadImpressionPage 必须先调 renderImpressionAll()');
  assert.ok(iPeople > iRender, 'loadImpressionPeople() 必须在渲染之后发起（并发，不阻塞）');
  assert.ok(iChats > iRender, 'ensureChats() 不得早于首次渲染');
  assert.equal(code.split('refreshImpressionChatOptions(').length - 1, 1,
    'refreshImpressionChatOptions() 在 loadImpressionPage 内只能出现一次');
  // ★ LR-12 / C7：不能只比 lastIndexOf。必须证明 refresh 在 ensureChats().then(...) 回调体内，
  //   而不是写在 .then 之后（那样「补下拉」的时序承诺就不成立）。
  const iThen = code.indexOf('.then(', iChats);
  const iCatch = code.indexOf('.catch(', iChats);
  const iRefresh = code.indexOf('refreshImpressionChatOptions(');
  assert.ok(iThen > iChats, 'ensureChats 后没有 .then()');
  assert.ok(iRefresh > iThen, 'refresh 不在 .then 回调内（可能在 then 之前或根本没挂）');
  assert.ok(iCatch < 0 || iRefresh < iCatch, 'refresh 不在 .then 回调内（跑到了 .catch 之后）');
});

// S11 要截带模板字符串的渲染函数，不能用配平版 fnBodyOf；
// 按“下一个顶层 function 声明”切片，模板里的花括号不会干扰。
function fnRegionOf(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `找不到 function ${name}()`);
  const rest = src.slice(at + 1);
  const next = /^(?:async\s+)?function\s+/m.exec(rest);
  return next ? src.slice(at, at + 1 + next.index) : src.slice(at);
}

await c.check('S11 每条异步链路按实际写状态路径校验令牌（不搞“三处”一刀切）', () => {
  // ★ LR-12 / C8：不采用「每条链路三处校验」的一刀切，按各函数**实际写状态的路径**断言：
  //   - 有 catch 写状态（error）的：成功分支 + 失败分支 + finally 渲染，三处；
  //   - loadImpressionDeletionCount 的 catch 是静默保留旧值，**不写状态**，只有 then + finally 两处；
  //   - loadImpressionIdentity 是「结束处一次校验」的特殊口径，单列。
  const threeWay = [
    ['loadImpressionPeople', 'impression.peopleSeq'],
    ['loadImpressionDetail', 'impression.detailSeq'],
    ['loadSummariesTable', 'summaries.seq'],
    ['loadKnowledge', 'knowledge.seq']
  ];
  for (const [fn, seq] of threeWay) {
    const body = stripComments(fnRegionOf(pagesSrc, fn));
    assert.ok(new RegExp(`\\+\\+\\s*MEM_UI\\.${seq.replace(/\./g, '\\.')}`).test(body),
      `${fn} 没有 ++${seq}（令牌没递增等于没防）`);
    const checks = (body.match(new RegExp(`!==\\s*MEM_UI\\.${seq.replace(/\./g, '\\.')}`, 'g')) || []).length;
    assert.ok(checks >= 3, `${fn} 的令牌校验只有 ${checks} 处：成功/失败/finally 三处是它的实际写状态路径`);
  }
  // loadImpressionDeletionCount：catch 静默保留旧值（不写状态），只有 then + finally 两处。
  // 不要为凑「三处」给 catch 加无意义断言；旧响应竞态由 T13 单独验证。
  {
    const body = stripComments(fnRegionOf(pagesSrc, 'loadImpressionDeletionCount'));
    assert.ok(/\+\+\s*MEM_UI\.impression\.deletionSeq/.test(body), 'loadImpressionDeletionCount 没递增 deletionSeq');
    const checks = (body.match(/!==\s*MEM_UI\.impression\.deletionSeq/g) || []).length;
    assert.equal(checks, 2, `loadImpressionDeletionCount 令牌校验应为 then+finally 两处，实际 ${checks}`);
  }
  // loadImpressionIdentity：结束处一次校验是它的特殊口径（并发 worker 跑完统一判一次），单列允许。
  {
    const body = stripComments(fnRegionOf(pagesSrc, 'loadImpressionIdentity'));
    assert.ok(/\+\+\s*MEM_UI\.impression\.identitySeq/.test(body), 'loadImpressionIdentity 没递增 identitySeq');
    assert.ok(/!==\s*MEM_UI\.impression\.identitySeq/.test(body), 'loadImpressionIdentity 没有结束处令牌校验');
  }
});

await c.check('S12 三页加载器独立，渲染不跨页', () => {
  for (const fn of ['loadImpressionPage', 'loadKnowledgePage', 'loadSummariesPage']) {
    assert.ok(pagesSrc.includes(`function ${fn}(`), `缺 ${fn}()`);
  }
  // 禁止"当前可见页"写法：那是迟到响应写错页的唯一入口
  assert.ok(!/querySelector\(\s*['"`]\.view\.active/.test(pagesSrc), '出现 .view.active 选择器');
  assert.ok(!/querySelector\(\s*['"`]\.detail-pane/.test(pagesSrc), '渲染函数用 .detail-pane 泛选，会写错页');
});

await c.check('S13 印象星图存在且回填/立刻运行入口已摘除', () => {
  assert.ok(html.includes('id="impression-graph-toggle"'), '缺少星图切换按钮');
  assert.ok(!html.includes('id="impression-backfill"'), '回填按钮仍在 HTML');
  assert.ok(!html.includes('id="impression-l1-run"'), '立刻运行按钮仍在 HTML');
  for (const fn of ['renderImpressionGraph', 'loadImpressionGraphData', 'layoutImpressionGraph3D', 'buildImpressionGraphScene']) {
    assert.ok(pagesSrc.includes(`function ${fn}(`), `缺少 ${fn}()`);
  }
  for (const fn of ['selectImpressionPersonOnly', 'selectImpressionGraphNode', 'clearImpressionSelection',
    'openImpressionGraphNode', 'openImpressionPersonFromList', 'loadImpressionDetail', 'drawImpressionGraphSelectionFrame']) {
    assert.ok(pagesSrc.includes(`function ${fn}(`), `缺少 ${fn}()`);
  }
  assert.ok(pagesSrc.includes('IMPRESSION_GRAPH_X_SPREAD'), '缺少 X 拉伸常量');
  assert.ok(pagesSrc.includes('preheatImpressionGraphSprites'), '缺少贴图预热门');
  assert.ok(pagesSrc.includes('preheatImpressionGraphBaseSprites'), '缺少基础贴图预热');
  assert.ok(pagesSrc.includes('preheatImpressionGraphSceneSprites'), '缺少场景贴图预热');
  assert.ok(pagesSrc.includes('impressionGraphBaseSpritesReady'), '缺少基础贴图就绪状态');
  assert.ok(pagesSrc.includes('impressionGraphSceneSpritesReady'), '缺少场景贴图就绪状态');
  assert.ok(pagesSrc.includes('impressionGraphRunBatched'), '缺少分批预热');
  assert.ok(pagesSrc.includes('timeRemaining'), '分批预热未按 idle 剩余时间');
  assert.ok(pagesSrc.includes('准备中'), '缺少准备中占位');
  assert.ok(pagesSrc.includes('星图贴图初始化失败'), '缺少贴图失败回退');
  assert.ok(pagesSrc.includes('agentStar'), 'Agent 未使用星点贴图');
  assert.ok(/drawImage\(\s*sprites\.agentStar/.test(pagesSrc), 'Agent 未按星点贴图绘制');
  assert.ok(/IMPRESSION_GRAPH_CENTER\s*=\s*'#070b16'/.test(pagesSrc), '星图中心底色不是 #070b16');
  const bgFn = stripComments(fnRegionOf(pagesSrc, 'drawImpressionGraphBackground'));
  assert.ok(bgFn.includes('IMPRESSION_GRAPH_CENTER'), '背景未使用中心底色');
  assert.ok(bgFn.includes('IMPRESSION_GRAPH_DEEP'), '背景未使用外圈暗色');
  assert.ok(bgFn.includes('createRadialGradient'), '背景缺少中心径向渐变');
  assert.ok(!/drawImage|nebulae|dust/.test(bgFn), '背景仍绘制星云或星尘');
  const lightFn = stripComments(fnRegionOf(pagesSrc, 'drawImpressionGraphLight'));
  assert.ok(lightFn.includes('createRadialGradient'), '缺少椭圆光源渐变');
  assert.ok(lightFn.includes('rotate(-Math.PI / 6)'), '光源未倾斜 30°');
  assert.ok(lightFn.includes('scale(1, 1 / 15)'), '光源长短轴比例不是 15:1');
  assert.ok(lightFn.includes('rgba(170,198,255,0.10)'), '椭圆光源不是低透明度蓝色');
  assert.ok(lightFn.includes('rgba(255,209,102,0.08)'), '中心缺少低透明度黄色圆形光晕');
  assert.ok(lightFn.includes('Math.min(w, h) * 0.11'), '中心圆晕半径未缩小到一半');
  assert.ok(!/nebulae|dust/.test(stripComments(pagesSrc)), '星云/星尘预热或状态未移除');
  assert.ok(!/fillText\(\s*['"]Agent['"]/.test(pagesSrc), 'Agent 中心文字未删除');
  assert.ok(/Math\.max\(6,\s*node\.sr\s*\+\s*3/.test(pagesSrc), '普通节点命中范围未按印象公式缩小');
  assert.ok(/impressionGraphDrawList\.length\s*-\s*1/.test(pagesSrc), '命中测试未按深度绘制列表反向查找');
  const nodesFn = stripComments(fnRegionOf(pagesSrc, 'drawImpressionGraphNodes'));
  assert.ok(nodesFn.includes('impressionGraphDrawList.sort'), '用户/印象/Agent 未按深度合并排序');
  assert.ok(!/arc\(u\.sx,\s*u\.sy,\s*r\s*\+\s*3/.test(nodesFn), '仍有悬停圆环');
  assert.ok(!/Math\.min\(1\.2,\s*Math\.max\(-1\.2/.test(stripComments(pagesSrc)), 'pitch 仍有 ±1.2 夹紧');
  assert.ok(/IMPRESSION_GRAPH_X_SPREAD/.test(stripComments(fnRegionOf(pagesSrc, 'layoutImpressionGraph3D'))),
    '投影未应用 X 拉伸');
  assert.ok(pagesSrc.includes('graphSelectedKey'), '缺少 graphSelectedKey');
  const detailFn = stripComments(fnRegionOf(pagesSrc, 'loadImpressionDetail'));
  assert.ok(!detailFn.includes('graphSelectedKey'), '详情加载不得写 graphSelectedKey');
  const refreshFn = stripComments(fnRegionOf(pagesSrc, 'refreshImpressionPage'));
  assert.ok(refreshFn.includes('detailUserId'), '刷新未按 detailUserId');
  assert.ok(!/loadImpressionPerson\(st\.selectedUserId\)/.test(stripComments(pagesSrc)), '仍按 selectedUserId 加载详情');
  assert.ok(!/cursor:\s*(grab|grabbing)/.test(css), 'CSS 仍有抓取光标');
  assert.ok(css.includes('#impression-detail:has(#impression-graph-wrap)'), '缺少填满右侧规则');
  const codeOnly = stripComments(pagesSrc);
  assert.ok(!/showBackfillPreview|runL1Now/.test(codeOnly), '回填/立刻运行前端函数仍在');
  const detail = stripComments(fnRegionOf(pagesSrc, 'renderImpressionDetail'));
  assert.ok(/mode\s*===\s*['"]graph['"]/.test(detail), 'renderImpressionDetail 缺少星图守卫');
  assert.ok(pagesSrc.includes("'/api/mem2/graph'"), '前端未请求 /api/mem2/graph');
  const graph = stripComments(fnRegionOf(pagesSrc, 'renderImpressionGraph'));
  assert.ok(graph.includes('st.graph'), '星图未使用 st.graph');
  assert.ok(!/st\.people(?!Loaded)/.test(graph), '星图不得跟随搜索过滤后的 people');
  for (const cls of ['.mem2-graph-wrap', '.mem2-graph-tip', '.mem2-graph-controls', '.mem2-card.is-graph-focus']) {
    assert.ok(css.includes(cls), `缺少星图样式 ${cls}`);
  }
  const noLib = stripComments(pagesSrc) + html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/force-graph|d3-force/.test(noLib), '不得引入第三方力导向库');
});

await c.check('S13b 星图事件链：缩放合并、拖拽只收状态、尺寸缓存', () => {
  const zoomFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphApplyZoom'));
  assert.ok(!zoomFn.includes('drawImpressionGraph('), 'applyZoom 仍直接完整重绘');
  assert.ok(zoomFn.includes('impressionGraphRequestDraw('), 'applyZoom 未走合并绘制');
  assert.ok(zoomFn.includes('impressionGraphQueueZoomSave('), 'applyZoom 未走防抖保存');
  assert.ok(pagesSrc.includes('IMPRESSION_GRAPH_ZOOM_SAVE_MS'), '缺少缩放保存防抖常量');
  const queueFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphQueueZoomSave'));
  assert.ok(queueFn.includes('setTimeout('), '缩放保存没有防抖定时器');
  const flushFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphFlushZoomSave'));
  assert.ok(flushFn.includes('impressionGraphSaveZoom('), 'flush 未真正写盘');
  const dragFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphUpdatePointer'));
  assert.ok(!dragFn.includes('localPoint'), '拖拽 mousemove 仍读画布布局');
  assert.ok(!dragFn.includes('getBoundingClientRect'), '拖拽 mousemove 仍读 getBoundingClientRect');
  assert.ok(!dragFn.includes('impressionGraphScreenRot'), '拖拽 mousemove 仍逐事件建矩阵');
  assert.ok(!dragFn.includes('impressionGraphMatMul'), '拖拽 mousemove 仍逐事件乘矩阵');
  assert.ok(!/tip\.hidden/.test(dragFn), '拖拽 mousemove 仍写 tip.hidden');
  assert.ok(dragFn.includes("impressionGraphHoverKey = ''"), '拖拽开始未清理残留 hover');
  const tickFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphTick'));
  assert.ok(tickFn.includes('impressionGraphRotValid(st.graphView.rot)'), '自转未处理相机矩阵');
  assert.ok(tickFn.includes('impressionGraphScreenRotY'), '自转未按相机屏幕基旋转');
  const applyFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphApplyPendingDrag'));
  assert.ok(applyFn.includes('impressionGraphScreenRotY') && applyFn.includes('impressionGraphMatMul'),
    '帧内未统一计算旋转矩阵');
  const bindFn = stripComments(fnRegionOf(pagesSrc, 'bindImpressionGraphCanvas'));
  assert.ok(bindFn.includes('impressionGraphUpdatePointer'), 'mousemove 未走拖拽收状态函数');
  assert.ok(bindFn.includes('setPointerCapture'), '拖拽未启用 pointer capture');
  assert.ok(bindFn.includes("addEventListener('pointerdown'"), '缺少 pointerdown 拖拽起点');
  assert.ok(bindFn.includes("addEventListener('pointermove'"), '缺少 pointermove 拖拽更新');
  assert.ok(bindFn.includes('lostpointercapture'), '缺少 pointer capture 丢失处理');
  assert.ok(bindFn.includes('impressionGraphHideTip(tip)'), '拖拽开始未按需隐藏 tooltip');
  const wheelBlock = bindFn.slice(bindFn.indexOf("addEventListener('wheel'"));
  assert.ok(wheelBlock.length > 0, '找不到 wheel 监听');
  assert.ok(!wheelBlock.includes('drawImpressionGraph('), 'wheel 监听直接完整绘制');
  const hideFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphHideTip'));
  assert.ok(hideFn.includes('tip.hidden !== true'), 'tooltip 隐藏未先判断可见');
  const drawFn = stripComments(fnRegionOf(pagesSrc, 'drawImpressionGraph'));
  assert.ok(drawFn.includes('impressionGraphCanvasSize'), '绘制未使用尺寸缓存');
  const observerFn = stripComments(fnRegionOf(pagesSrc, 'ensureImpressionGraphObserver'));
  assert.ok(/impressionGraphCanvasSize\s*=/.test(observerFn), 'ResizeObserver 未刷新尺寸缓存');
  const teardownFn = stripComments(fnRegionOf(pagesSrc, 'teardownImpressionGraph'));
  assert.ok(teardownFn.includes('impressionGraphFlushZoomSave'), 'teardown 未 flush 缩放');
});

await c.check('S13c 星图回顾模式：按钮接线、状态机与统一可见性', () => {
  assert.ok(pagesSrc.includes('#impression-graph-recall'), '缺少回顾按钮');
  assert.ok(!html.includes('impression-graph-recall'), '回顾按钮不应写进 index.html');
  assert.ok(pagesSrc.includes('mem2-graph-recall-label') && pagesSrc.includes('aria-live'), '进度节点缺 aria-live');
  const recallCss = css.slice(css.indexOf('.mem2-graph-recall'));
  assert.ok(recallCss.includes('pointer-events: auto'), '按钮缺 pointer-events:auto');
  assert.ok(recallCss.includes('mem2-graph-recall-spin'), '缺少 spinner 动画');
  assert.ok(recallCss.includes('prefers-reduced-motion') && recallCss.includes('animation: none'),
    'reduced-motion 未关闭 spinner');
  const bindFn = stripComments(fnRegionOf(pagesSrc, 'bindMemPagesOnce'));
  const recallAt = bindFn.indexOf("closest('#impression-graph-recall')");
  const uidAt = bindFn.indexOf("closest('[data-uid]')");
  assert.ok(recallAt >= 0 && uidAt > recallAt, '回顾接线缺失或不在 [data-uid] 之前');
  assert.ok(bindFn.includes('impressionGraphStartReplay'), '回顾按钮未接启动函数');
  const startFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphStartReplay'));
  for (const guard of ['impressionGraphReplay.active', 'st.graph', 'st.graphLoading', "st.mode !== 'graph'",
    'memPageVisible', 'impressionGraphCanvas', 'impressionGraphScene', 'impressionGraphBaseSpritesReady',
    'impressionGraphSceneSpritesReady']) {
    assert.ok(startFn.includes(guard), `启动守卫缺 ${guard}`);
  }
  assert.ok(startFn.includes('impressionGraphBuildReplayOrder'), '启动未重算排序');
  assert.ok(!startFn.includes('clearImpressionSelection'), '回放开始调用了 clearImpressionSelection');
  for (const bad of ['selectedUserId', 'graphSelectedKey', 'detailUserId', 'pendingEntryId', 'detailSeq',
    'personLoading', 'st.person']) {
    assert.ok(!startFn.includes(bad), `回放开始碰了左侧状态 ${bad}`);
  }
  assert.ok(/impressionGraphHoverKey\s*=\s*''/.test(startFn), '回放开始未清 hover');
  assert.ok(/impressionGraphLastHoverKey\s*=\s*''/.test(startFn), '回放开始未清 last hover');
  assert.ok(startFn.includes('impressionGraphHideTip(document.getElementById'), '回放开始未按需隐藏 tooltip');
  const updateFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphUpdateReplayButton'));
  assert.ok(updateFn.includes('if (!btn) return'), '按钮更新未做 DOM 判空');
  assert.ok(updateFn.includes('btn.disabled = true') && updateFn.includes('btn.disabled = false'),
    '按钮禁用/恢复缺失');
  const cancelFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphCancelReplay'));
  assert.ok(cancelFn.includes('wasActive'), 'cancel 未判断 active 变化');
  assert.ok(/if\s*\(wasActive\)[\s\S]{0,80}lastCancelReason/.test(cancelFn),
    'lastCancelReason 未只在 active 变 false 时写入');
  assert.ok(/if\s*\(wasActive\)[\s\S]{0,120}cancelSeq\s*\+=\s*1/.test(cancelFn),
    'cancelSeq 未只在 active 变 false 时递增');
  assert.ok(!cancelFn.includes('clearImpressionSelection'), 'cancel 调用了 clearImpressionSelection');
  for (const bad of ['selectedUserId', 'graphSelectedKey', 'detailUserId', 'detailSeq', 'st.person']) {
    assert.ok(!cancelFn.includes(bad), `cancel 碰了左侧状态 ${bad}`);
  }
  assert.ok(cancelFn.includes('if (!restore) return'), 'restore:false 未跳过绘制');
  const teardownFn = stripComments(fnRegionOf(pagesSrc, 'teardownImpressionGraph'));
  assert.ok(teardownFn.includes("reason: 'teardown'") && teardownFn.includes('restore: false'),
    'teardown 未按 restore:false 取消回放');
  const stepFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphReplayStep'));
  assert.ok(stepFn.includes("memPageVisible('mem-impression')") && stepFn.includes('document.hidden'),
    '回放步进未做页签/隐藏双保险');
  assert.ok(stepFn.includes('lastStepAt'), '回放步进未写 lastStepAt');
  assert.ok(stepFn.includes('impressionGraphReplayFinish'), '最后一个后未直接完成');
  const finishFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphReplayFinish'));
  const iFinishOff = finishFn.indexOf('replay.active = false');
  const iFinishDraw = finishFn.indexOf('impressionGraphRequestDraw()');
  assert.ok(iFinishOff >= 0 && iFinishDraw > iFinishOff, '完成分支未在 active=false 后请求重绘');
  assert.ok(finishFn.includes('completedAt'), '完成分支未写 completedAt');
  const orderFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphBuildReplayOrder'));
  assert.ok(/createdAt\s*>\s*0|at\s*>\s*0/.test(orderFn), 'firstAt 未只在 createdAt>0 上取最小值');
  assert.ok(orderFn.includes('localeCompare'), '同 firstAt 未按 uid 字典序');
  assert.ok(!orderFn.includes('proj.users'), '排序读取了 proj.users 顺序');
  assert.ok(!orderFn.includes('MEM_UI'), '排序纯函数读了 MEM_UI');
  for (const fn of [startFn, stepFn, finishFn, cancelFn]) {
    assert.ok(!/[^A-Za-z]api\(/.test(fn), '回放路径发起了网络请求');
  }
  const nodesFn = stripComments(fnRegionOf(pagesSrc, 'drawImpressionGraphNodes'));
  assert.ok((nodesFn.match(/impressionGraphReplayVisible/g) || []).length >= 3,
    '节点/雾光/绘制列表未全部过滤');
  const edgesFn = stripComments(fnRegionOf(pagesSrc, 'drawImpressionGraphEdges'));
  assert.ok((edgesFn.match(/impressionGraphReplayVisible/g) || []).length >= 4,
    'agent-user / user-impression / hover 分支未全部过滤');
  const labelsFn = stripComments(fnRegionOf(pagesSrc, 'drawImpressionGraphLabels'));
  assert.ok(labelsFn.includes('impressionGraphReplayVisible(u)'), '标签未过滤隐藏用户');
  const frameFn = stripComments(fnRegionOf(pagesSrc, 'drawImpressionGraphSelectionFrame'));
  assert.ok(frameFn.includes('impressionGraphReplayVisible(node)'), '选中框未过滤隐藏节点');
  const hitFn = stripComments(fnRegionOf(pagesSrc, 'impressionGraphHitAt'));
  assert.ok(/for[\s\S]*impressionGraphReplayVisible\(node\)/.test(hitFn),
    '命中循环未直接过滤隐藏节点');
  const renderFn = stripComments(fnRegionOf(pagesSrc, 'renderImpressionGraph'));
  const errAt = renderFn.indexOf("reason: 'error'");
  const firstTeardown = renderFn.indexOf('teardownImpressionGraph()');
  assert.ok(errAt >= 0 && firstTeardown > errAt, 'errBlocks 分支未先按 error 取消回放');
  assert.ok(/st\.mode === 'graph'[\s\S]{0,160}ensureImpressionGraphLoop\(\)[\s\S]{0,80}impressionGraphRequestDraw\(\)/.test(bindFn),
    'visibilitychange visible 分支未补 requestDraw');
  assert.ok(coreSrc.includes('impressionGraphCancelReplay') && coreSrc.includes("reason: 'tab'"),
    'switchTab 离开印象页签未取消回放');
  const loadFn = stripComments(fnRegionOf(pagesSrc, 'loadImpressionGraphData'));
  assert.ok(/force[\s\S]{0,120}reason:\s*'refresh'/.test(loadFn), 'force 刷新入口未立即取消回放');
});

await c.check('S14 旧记忆页与旧文件名不得复活', () => {
  assert.ok(!html.includes('data-tab="memory"'), '导航仍有旧记忆页');
  assert.ok(!html.includes('id="view-memory"'), '#view-memory 仍在');
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'memory.js')), 'src/memory.js 仍在');
  // D3=A 已确认，必验：
  assert.ok(!fs.existsSync(path.join(ROOT, 'ui', 'app', '05-memory-settings.js')), '旧 05 文件名仍在');
  assert.ok(fs.existsSync(path.join(ROOT, 'ui', 'app', '05-settings-common.js')), '05 新文件名不存在');

  // D1-B：成员备注编辑入口已随旧页删除，设置侧栏也不再有记忆分区
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app', '06-settings-render.js'), 'utf8');
  assert.ok(!settingsSrc.includes("['memory', '记忆']"), '设置侧栏仍有记忆分区');
  assert.ok(!settingsSrc.includes('renderMemorySettingsSection'), 'renderMemorySettingsSection 仍在');
});

// ── 5. 可访问性 ──────────────────────────────────────────────────────────
c.section('5. 可访问性');

await c.check('弹窗外壳带 role="dialog" / aria-modal，且集成 Esc 关闭与焦点管理', () => {
  const m = /function modelModalShell\([\s\S]*?\n\}/.exec(appJs);
  assert.ok(m, '找不到 modelModalShell');
  const body = m[0];
  assert.ok(/role="dialog"/.test(body), '弹窗缺少 role="dialog"');
  assert.ok(/aria-modal="true"/.test(body), '弹窗缺少 aria-modal');
  assert.ok(/aria-label="关闭"/.test(body), '关闭按钮缺少 aria-label');
  assert.ok(/Escape/.test(body), '弹窗未处理 Esc 关闭');
  assert.ok(/focus\(/.test(body), '弹窗未做焦点管理');
});

await c.check('所有「×」图标按钮都有 aria-label', () => {
  const missing = [];
  for (const m of appJs.matchAll(/<button[^>]*>[×✕✖]<\/button>/g)) {
    if (!/aria-label=/.test(m[0])) missing.push(m[0]);
  }
  for (const m of html.matchAll(/<button[^>]*>[×✕✖]<\/button>/g)) {
    if (!/aria-label=/.test(m[0])) missing.push(m[0]);
  }
  assert.equal(missing.length, 0, `缺少 aria-label 的关闭按钮：\n  ${missing.join('\n  ')}`);
});

await c.check('index.html 里的纯图标按钮都有 aria-label 或可见文字', () => {
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const text = m[2].replace(/<[^>]*>/g, '').trim();
    if (text) continue;                      // 有可见文字
    assert.ok(/aria-label=/.test(attrs), `图标按钮缺少 aria-label：<button${attrs}>`);
  }
});

await c.check('主题切换按钮有 aria-label（键盘/读屏可用）', () => {
  assert.ok(/id="theme-btn"[^>]*aria-label=/.test(html), '#theme-btn 缺少 aria-label');
});

c.finish();
