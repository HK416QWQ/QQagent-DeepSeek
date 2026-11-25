// 〔SnowLuma 控制台页签〕——内嵌 127.0.0.1:5099 的 SnowLuma 原生 WebUI。
//
// 为什么用 webview 而不是 iframe：SnowLuma 回
//   x-frame-options: DENY / content-security-policy: frame-ancestors 'none'
// 被 iframe 嵌套一律拒绝。Electron 的 webview 是独立 guest webContents，不受这两条约束。
//
// ── 登录（2026-11-09 重做，B 方案）─────────────────────────────────────
// 旧实现有两个死结：① 用 window.prompt 收密码 —— Electron 根本没实现 prompt，
// 点「记住密码」等于什么都没发生（凭据文件从来没生成过）；② 就算存上了，
// 靠 executeJavaScript 往 React 受控输入框里塞值 + 点提交，五个软环节都随
// WebUI 升级失效，密码还得明文进页面。
//
// 现在：密码存在主进程（safeStorage），由主进程 POST /api/login 换 token，
// 渲染层只把 token 写进 guest 的 localStorage（SnowLuma 前端的 tokenStore 就读这个键），
// 然后重新加载回 `/`（总览）。全程不做 DOM 操作，失败有明确错误码。
'use strict';

const SNOWLUMA_CONSOLE_SRC = 'http://127.0.0.1:5099/';
const SNOWLUMA_PARTITION = 'persist:snowluma-webui';
// SnowLuma 前端存令牌用的键（api 客户端 tokenStore.load() 读它）
const SL_TOKEN_KEY = 'snowluma_token';

// 登录探针：让 guest 用自己的会话问一下鉴权状态。
//   200 → 已登录，别动
//   401 → 需要登录（含"本地根本没有 token"）
//   0   → 页面没加载好 / 服务没起来（这两种情况都不该去尝试登录）
//
// ⚠️ 必须自己带上 localStorage 里的 token：SnowLuma 的鉴权只认
//    `x-snowluma-token` / `Authorization: Bearer`，那张 cookie 只覆盖 /avatar 路径。
//    不带 token 的话，**已登录状态下也会拿到 401** —— 会导致每次 dom-ready 都白登一次。
const SL_PROBE_JS = `(() => {
  try {
    const tk = localStorage.getItem(${JSON.stringify(SL_TOKEN_KEY)}) || '';
    if (!tk) return 401;
    return fetch('/api/auth/state', { headers: { 'x-snowluma-token': tk } })
      .then((r) => r.status).catch(() => 0);
  } catch { return 0; }
})()`;

/**
 * 当前环境能不能用 webview。
 * 浏览器直连控制台（非 Electron）时没有 qqAgentShell，也不会有 webview 自定义元素。
 * ⚠️ 只在函数调用时执行 createElement —— 本文件会被 UI 测试的 sandbox 加载，
 *    顶层不能碰 DOM/Electron。
 */
function snowlumaConsoleSupported() {
  if (!window.qqAgentShell?.snowlumaCred?.login) return false;
  try {
    return typeof document.createElement('webview').reload === 'function';
  } catch { return false; }
}

// ── 提示条 ──
let slHintEl = null;
function slHint(text, isError = false) {
  if (!slHintEl) return;
  slHintEl.textContent = text || '';
  slHintEl.classList.toggle('slc-hint-err', !!isError);
}

const SL_ERR_TEXT = {
  'bad-password': '保存的密码不对，点「密码已保存」重新设置',
  'needs-totp': '该控制台开了两步验证，需要手动输入验证码',
  'cooldown': '刚登录失败过，稍后再试（避免把服务端限流打满）',
  'locked': '服务端限流中',
  'offline': '连不上 SnowLuma，请先到「内核与日志」启动',
  'no-credential': '还没保存密码，点「设置密码」',
  'bad-request': '请求被服务端拒绝（客户端 bug）',
  'unsupported': '当前环境不支持自动登录',
  'error': '登录失败'
};

function slErrText(r) {
  if (!r) return SL_ERR_TEXT.error;
  const base = SL_ERR_TEXT[r.code] || r.message || SL_ERR_TEXT.error;
  if ((r.code === 'cooldown' || r.code === 'locked') && Number(r.waitSec) > 0) {
    return `${base}（约 ${r.waitSec} 秒）`;
  }
  return base;
}

// 并发闸：dom-ready 与切页签可能同时触发，别让两条流程同时去换 token。
let slLoginBusy = false;

/**
 * 保证控制台处于已登录状态。已登录 → 不动；未登录 → 用保存的密码自动登录一次。
 * @param {HTMLElement} frame webview 元素
 * @param {{force?:boolean}} opt force=true 表示用户手动触发（绕过冷却）
 */
async function slEnsureLogin(frame, { force = false } = {}) {
  if (!frame || slLoginBusy) return { ok: false, code: 'busy' };
  slLoginBusy = true;
  try {
    let status = 0;
    try { status = Number(await frame.executeJavaScript(SL_PROBE_JS)) || 0; } catch { status = 0; }
    if (status === 200) { slHint('已登录'); return { ok: true, already: true }; }
    // 探针拿不到明确 401（页面没加载好 / 服务没起）就别去试密码：
    // 那个阶段发请求只会白吃一次服务端限流额度。
    if (status !== 401) return { ok: false, code: 'offline' };

    const api = window.qqAgentShell?.snowlumaCred;
    if (!api?.login) return { ok: false, code: 'unsupported' };

    const res = await api.login({ force });
    if (res?.ok) {
      const token = String(res.token || '');
      if (token) {
        // 写进 guest 的 localStorage：SnowLuma 启动时 tokenStore 读这个键，
        // 等价于"它自己登录成功后做的事"。JSON.stringify 保证转义安全。
        try {
          await frame.executeJavaScript(
            `localStorage.setItem(${JSON.stringify(SL_TOKEN_KEY)}, ${JSON.stringify(token)})`
          );
        } catch { /* origin 还没就绪：下面的重载会再走一次 */ }
      }
      slHint(res.mustChangePassword ? '已登录，但该控制台要求先修改密码' : '已自动登录', false);
      try { frame.loadURL(SNOWLUMA_CONSOLE_SRC); } catch { /* ignore */ }
      return res;
    }

    slHint(slErrText(res), true);
    return res;
  } finally {
    slLoginBusy = false;
  }
}

/** 设置/修改/清除访问密码的弹窗。 */
async function slOpenPasswordModal({ frame, onChanged } = {}) {
  const api = window.qqAgentShell?.snowlumaCred;
  if (!api) return;
  let saved = false;
  try { saved = !!(await api.load())?.ok; } catch { saved = false; }

  const overlay = modelModalShell({
    head: 'SnowLuma 访问密码',
    body: `
      <div class="app-alert-text">密码只保存在本机，用系统密钥环加密（safeStorage）。保存后进入控制台会自动登录，不用再手输。</div>
      <div class="field" style="margin-top:10px">
        <input type="password" id="slc-pwd" autocomplete="off" spellcheck="false" placeholder="输入 SnowLuma 访问密码" />
      </div>
      <label class="checkbox-row" style="margin-top:8px;display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="slc-pwd-show" /> <span>显示密码</span>
      </label>
      <div class="slc-pwd-err" id="slc-pwd-err"></div>`,
    foot: `${saved ? '<button class="btn btn-danger" id="slc-pwd-clear">清除密码</button>' : ''}
           <button class="btn" id="slc-pwd-cancel">取消</button>
           <button class="btn btn-primary" id="slc-pwd-save">保存并登录</button>`
  });

  const input = overlay.querySelector('#slc-pwd');
  const showEl = overlay.querySelector('#slc-pwd-show');
  const errEl = overlay.querySelector('#slc-pwd-err');
  const saveBtn = overlay.querySelector('#slc-pwd-save');
  const clearBtn = overlay.querySelector('#slc-pwd-clear');
  const setErr = (t) => { if (errEl) errEl.textContent = t || ''; };

  showEl?.addEventListener('change', () => { input.type = showEl.checked ? 'text' : 'password'; });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveBtn?.click(); }
  });
  setTimeout(() => { try { input?.focus(); } catch { /* ignore */ } }, 30);

  overlay.querySelector('#slc-pwd-cancel')?.addEventListener('click', () => closeModelModal(overlay));

  clearBtn?.addEventListener('click', async () => {
    if (!(await uiConfirm('清除本机保存的 SnowLuma 密码？清除后进入控制台需要手动登录。'))) return;
    try { await api.clear(); } catch { /* ignore */ }
    await onChanged?.();
    closeModelModal(overlay);
    slHint('已清除保存的密码');
  });

  saveBtn?.addEventListener('click', async () => {
    const pwd = input?.value ?? '';          // 不 trim：密码首尾可能有空格
    if (!pwd) { setErr('请输入密码'); input?.focus(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存并登录…';
    setErr('');
    try {
      const r = await api.save(pwd);
      if (!r?.ok) { setErr(r?.error || '保存失败'); return; }
      await onChanged?.();
      const res = await slEnsureLogin(frame, { force: true });
      if (res?.ok) { closeModelModal(overlay); return; }
      // 连不上时密码已经存好了，别把弹窗卡在这儿：用户可能只是想先填好，等启动后再用。
      if (res?.code === 'offline') {
        closeModelModal(overlay);
        slHint('密码已保存；SnowLuma 启动后会自动登录');
        return;
      }
      setErr(slErrText(res));                // 失败不关窗，让用户直接改密码重试
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存并登录';
    }
  });
}

async function loadSnowlumaConsole() {
  const box = $('#snowluma-console-page');
  if (!box) return;
  // 已渲染过就直接复用：重建会丢登录态渲染和 guest 页内状态。
  // 但每次切回页签都要补一次"已登录就不管、未登录就自动登"。
  if (box.dataset.ready === '1') {
    const old = box.querySelector('#slc-frame');
    // IPC 异常不该冒成 unhandledRejection：自动登录是"锦上添花"，失败就维持现状
    if (old) slEnsureLogin(old).catch(() => {});
    return;
  }

  if (!snowlumaConsoleSupported()) {
    box.innerHTML = `
      <div class="hint" style="padding:16px;line-height:1.8">
        当前不在桌面客户端内，无法内嵌 SnowLuma 控制台。<br>
        <a class="btn btn-small" href="${SNOWLUMA_CONSOLE_SRC}" target="_blank" rel="noopener">在新标签页打开</a>
      </div>`;
    box.dataset.ready = '1';
    return;
  }

  box.innerHTML = `
    <div class="slc-bar">
      <span class="slc-url">${SNOWLUMA_CONSOLE_SRC}</span>
      <button class="btn btn-small" id="slc-reload" title="重新加载控制台">刷新</button>
      <button class="btn btn-small" id="slc-cred" title="保存访问密码，进入控制台时自动登录">设置密码</button>
      <span class="muted" id="slc-hint" style="font-size:12px"></span>
    </div>`;

  // ⚠️ webview 必须用 createElement 建，不能写进上面的 innerHTML。
  //    自定义元素在 innerHTML 解析时**不保证**被 upgrade（部分 Electron 版本不会），
  //    表现是：容器里有 <webview> 标签、也有宽高，但内容永远空白、控制台一点报错都没有。
  //    createElement 走同步 upgrade 路径，不存在这个半坏状态。
  const frame = document.createElement('webview');
  frame.id = 'slc-frame';
  frame.setAttribute('src', SNOWLUMA_CONSOLE_SRC);
  frame.setAttribute('partition', SNOWLUMA_PARTITION);
  // ⚠️ 不要写 allowpopups：它在 Electron 里是**布尔属性**（实现是 hasAttribute），
  //    写成 allowpopups="false" 等于**开启**弹窗，与意图相反。直接不写就是关。
  frame.style.cssText = 'flex:1;width:100%;min-height:0;display:flex';
  box.querySelector('.slc-bar').after(frame);

  slHintEl = box.querySelector('#slc-hint');

  // 加载失败兜底：SnowLuma 没启动（5099 没人监听）时，guest 自己会渲染 Chromium 的
  // 灰底错误页 —— 用户看到的是"网页无法访问"，不知道是服务没开。盖一层人话提示 + 重试。
  // did-fail-load 对被导航打断也会报（errorCode -3 ERR_ABORTED），那是正常跳转，必须滤掉。
  const clearFail = () => { const el = box.querySelector('.slc-fail'); if (el) el.remove(); };
  frame.addEventListener('did-fail-load', (e) => {
    if (e && e.errorCode === -3) return;
    if (e && e.isMainFrame === false) return;
    if (box.querySelector('.slc-fail')) return;
    const el = document.createElement('div');
    el.className = 'slc-fail';
    el.innerHTML = `
      <div class="slc-fail-title">连不上 SnowLuma 控制台</div>
      <div class="slc-fail-desc">${SNOWLUMA_CONSOLE_SRC} 没有响应。请先到「内核与日志」页签确认 SnowLuma 已启动，再点下面的重试。<br>${esc(String(e?.errorDescription || '加载失败'))}</div>
      <button class="btn btn-small" id="slc-retry">重试</button>`;
    const retry = el.querySelector('#slc-retry');
    if (retry) retry.addEventListener('click', () => { clearFail(); try { frame.reload(); } catch { /* ignore */ } });
    box.appendChild(el);
  });
  // 加载成功就把覆盖层摘掉（自动登录触发的跳转同理）
  frame.addEventListener('dom-ready', clearFail);
  frame.addEventListener('did-finish-load', clearFail);

  const credBtn = box.querySelector('#slc-cred');
  // 按钮文案随"有没有存过密码"变；load 只回答有没有（不再把明文密码交回渲染层）
  const refreshCredState = async () => {
    let has = false;
    try { has = !!(await window.qqAgentShell.snowlumaCred.load())?.ok; } catch { has = false; }
    if (credBtn) {
      credBtn.textContent = has ? '密码已保存' : '设置密码';
      credBtn.title = has ? '已保存访问密码，点击可修改或清除' : '保存访问密码，进入控制台时自动登录';
    }
    return has;
  };
  await refreshCredState();

  credBtn?.addEventListener('click', () => slOpenPasswordModal({ frame, onChanged: refreshCredState }));

  box.querySelector('#slc-reload')?.addEventListener('click', () => {
    try { frame.reload(); } catch { /* ignore */ }
  });

  // 每次（重新）加载完都补一次登录检查：token 是服务端内存态，SnowLuma 一重启就失效，
  // 所以"打开就有登录态"这件事不能假设。
  frame.addEventListener('dom-ready', () => { slEnsureLogin(frame).catch(() => {}); });

  box.dataset.ready = '1';
}
