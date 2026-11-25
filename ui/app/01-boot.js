// 〔启动 loading 壳 / 就绪体检 / 状态栏〕——M9 拆分第 2 段
'use strict';
// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    // 未连接时展示后端诊断（2026-09-19）：区分「SnowLuma 没起 / 没登录账号 / 令牌不匹配」，
    // 不再让用户面对一句干巴巴的"未连接"猜原因。
    label.textContent = s.onebot.connected
      ? `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
      : (s.onebot.diagnosis || 'OneBot 未连接');
    label.title = s.onebot.connected ? '' : (s.onebot.error || '');
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    // 顶栏不再展示「今日用量 / 搜索次数」：完整数据在「用量与成本」页；
    // /api/status 仍返回 usage/webSearchCount（selftest 与其它调用方依赖），本单不删后端字段。
    // 运行计时锚点：后端给的是"上次返回时的 durationMs"，本地按 fetchedAt 往后推，
    // 每秒只更新文本，不再打 /api/status。
    const rt = s.runtime && s.runtime.startedAt
      ? { startedAt: s.runtime.startedAt, durationMs: Number(s.runtime.durationMs) || 0, fetchedAt: Date.now() }
      : null;
    state.runtime = rt;
    updateUptimeChip(!!s.onebot?.connected);
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    state.dataDir = s.dataDir || '';
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
    updateReadinessDots(s);
  } catch (e) { /* 忽略瞬时错误 */ }
}

/** 更新顶栏运行时长胶囊（本地每秒推进，不发请求） */
function updateUptimeChip(connected) {
  const el = $('#uptime-label');
  if (!el) return;
  const rt = state.runtime;
  if (!rt) {
    el.textContent = connected ? '运行：-' : '运行：等待连接';
    el.title = connected ? '等待运行记录' : 'OneBot 连接成功后开始计时';
    return;
  }
  el.textContent = `运行：${fmtDuration(rt.durationMs + (Date.now() - rt.fetchedAt))}`;
  el.title = `本次始于 ${fmtRunTime(rt.startedAt)}（点击查看运行记录）`;
}

setInterval(() => updateUptimeChip(!!state.status?.onebot?.connected), 1000);

// ── DeepSeek 余额 ──────────────────────────────────────────────────────────
// 余额只在后端查询（Key 不出主进程），这里只渲染金额与错误状态。
// 页面加载取一次（服务端 60 秒缓存），点 ↻ 强制刷新（服务端 5 秒内不重复请求）。
let balanceInFlight = false;
const BALANCE_SIGN = { CNY: '¥', USD: '$' };

function fmtBalanceAmount(b) {
  const sign = BALANCE_SIGN[b?.currency] || `${b?.currency || ''} `;
  return `${sign}${Number(b?.total || 0).toFixed(2)}`;
}

function balanceReasonText(reason) {
  return ({
    'no-key': '未配置 Key',
    unsupported: '仅支持官方 API',
    auth: 'Key 无效',
    timeout: '请求超时',
    network: '网络错误',
    'bad-response': '返回格式异常',
    http: '服务返回错误'
  })[reason] || '获取失败';
}

async function refreshBalance({ force = false } = {}) {
  const label = $('#balance-label');
  const btn = $('#balance-refresh');
  if (!label || balanceInFlight) return;
  balanceInFlight = true;
  if (btn) { btn.disabled = true; btn.classList.add('is-spinning'); }
  if (!label.dataset.loaded) label.textContent = '余额：查询中…';
  try {
    const r = await api(`/api/deepseek-balance${force ? '?force=1' : ''}`);
    if (r?.reason === 'empty') {
      label.textContent = '余额：暂无';
      label.title = `${r.available === false ? '账户当前不可用；' : ''}官方返回没有币种余额 · 点右侧 ↻ 刷新`;
      label.classList.toggle('alert', r.available === false);
      label.dataset.loaded = '1';
      return;
    }
    if (!r?.ok) throw new Error(balanceReasonText(r?.reason));
    label.textContent = `余额：${fmtBalanceAmount(r)}`;
    const parts = (r.infos || []).map((b) => `${b.currency} ${Number(b.total).toFixed(2)}`
      + `（赠送 ${Number(b.granted || 0).toFixed(2)} + 充值 ${Number(b.toppedUp || 0).toFixed(2)}）`);
    const unusable = r.available === false ? '账户当前不可用；' : '';
    label.title = `${unusable}${parts.join('；')} · 更新于 ${fmtClock(r.at)} · 点右侧 ↻ 刷新`;
    label.classList.toggle('alert', r.available === false);
    label.dataset.loaded = '1';
  } catch (e) {
    label.textContent = `余额：${e?.message || '获取失败'}`;
    label.title = '余额获取失败；确认模型 API 为 DeepSeek 官方地址且 Key 有效后，点右侧 ↻ 重试';
    label.classList.remove('alert');
  } finally {
    balanceInFlight = false;
    if (btn) { btn.disabled = false; btn.classList.remove('is-spinning'); }
  }
}

$('#balance-refresh')?.addEventListener('click', () => refreshBalance({ force: true }));

/** 更新顶栏就绪进度指示器（4 圆点） */
function updateReadinessDots(s) {
  const dots = $$('#readiness-dots .rdot');
  if (dots.length !== 4) return;

  const qq = s?.qqPortable || {};
  const qqRunning = !!qq.running;
  const slRunning = !!s?.snowluma?.running;
  const obConnected = !!s?.onebot?.connected;
  const cfg = state.config || {};
  const cfgReady = !!(cfg.api?.baseUrl && cfg.api?.model && (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty));

  // 圆点 0：QQ 内核
  dots[0].className = 'rdot' + (qqRunning ? ' on' : '');
  dots[0].title = qqRunning ? 'QQ 内核运行中' : 'QQ 内核未运行（点击前往启动）';

  // 圆点 1：SnowLuma
  dots[1].className = 'rdot' + (slRunning ? ' on' : '');
  dots[1].title = slRunning ? 'SnowLuma 运行中' : 'SnowLuma 未运行（点击前往启动）';

  // 圆点 2：OneBot
  dots[2].className = 'rdot' + (obConnected ? ' on' : (slRunning ? ' wait' : ''));
  dots[2].title = obConnected ? 'OneBot 已连接' : (s?.onebot?.diagnosis || (slRunning ? 'OneBot 连接中…' : 'OneBot 未连接'));

  // 圆点 3：配置完成
  dots[3].className = 'rdot' + (cfgReady ? ' on' : '');
  dots[3].title = cfgReady ? '配置已完成' : '配置未完成（点击前往设置）';
}

// 就绪圆点点击跳转
$$('#readiness-dots .rdot').forEach((dot) => {
  dot.addEventListener('click', () => {
    const target = dot.dataset.target;
    if (target === 'snowluma') switchTab('snowluma');
    else if (target === 'settings') switchTab('settings');
  });
});

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── 会话渲染合批 ──
// 运行中的会话 SSE 事件非常密：每轮"正在思考…"开/关两次 + 每个工具调用一次。
// 曾经来一条事件就全量重建一次会话列表 + 会话详情（含大提示词的 esc/innerHTML），
// 主线程被反复长阻塞，详情内容反而"更新缓慢"、还伴随滚动跳动。
// 现在：patch 立即进 state（数据不延迟），渲染合并到短定时器一次；
// 窗口内的多次事件只渲染最终状态（中间的 activity 翻转根本不必上屏）。
//
// ⚠️ 用 setTimeout 而不是 requestAnimationFrame：
//    窗口被遮挡/最小化时 Chromium 会完全停发 rAF，渲染全部积压到切回前台
//    才一次性出现 —— 用户看到的就是"不手动刷新就不更新"。
//    setTimeout 在后台页面仍会执行（最多被节流到 1s），远比不执行强。
const pendingSessionDetail = new Map();   // sessionId -> 合并后的 patch
let sessionRenderScheduled = false;

function scheduleSessionRender() {
  if (sessionRenderScheduled) return;
  sessionRenderScheduled = true;
  setTimeout(() => {
    sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}
