// 省调用：一批"只发了消息"的工具结果之后，本地判定可以结束，省掉没有意义的一轮。
//
// ── 为什么要这个 ────────────────────────────────────────────────────────────
// 模型发完消息后，系统还要再问一次模型"要不要收尾"。2026-10-27 实测 233 个会话打了
// 447 次 API 调用，其中 137 次（30.6%）的那一步只做了一件事：调 finish。
// orchestrator 里早就有 reply.local-policy 这个钩子（src/orchestrator.js 的 #capFirst），
// 但一直没有插件提供它 —— 本插件补上这个提供者。
//
// ── 判定规则（v2，最终版）────────────────────────────────────────────────────
//   0. 本批至少一条 send_message 显式带 end:true（不猜"模型是不是说完了"）
//   1. 本批至少一次 send_message（只 send_poke 不结束）
//   2. 除了发送类工具和 finish，本批不能有其它工具（模型显然还要往前走）
//   3. 发送类工具总次数 ≤ 2，且同类工具不超过 2 次（允许"文字+表情"两个气泡）
//   4. 每条 send_message 的结果都要"干净成功"（全败 / 部分失败 / 结果不是 JSON 都不结束）
//   5. messages 允许字符串也允许数组（数组=分条发送，提示词推荐的形态）；配置可关
//   6. 本批新增发送记录里至少一条文本带非空 messageId（去重命中时为空）
//   7. 预告式结尾（正文 + 每条消息文本的尾部 80 字）命中 TRAILER_RE → 不结束
//   8. 本批含 finish 时通常不会走到钩子，但函数要能处理它且不抛错
//
// ── 怎么开关 / 怎么回退 ──────────────────────────────────────────────────────
//   开关：QQ Agent →「插件」页 → 找到「省调用·发送后自动收尾」→ 启用/禁用
//   回退：禁用（或删掉本目录）→ 能力消失 → orchestrator 的 #capFirst 返回 null
//         → 行为完全回到原样。这是软依赖，禁用即完全回退。
//
// ⚠️ 没有 git 的项目里，"禁用"永远比"删代码"快 —— 怀疑误伤时先禁用。

const DEFAULT_TRAILER_RE = /等(我|一下|会儿|下)|稍等|我(先)?看看|我查(一下|查)?|我(试|找)试?|马上(回来|就好|就来)|待会(儿)?(再说|回)|回头(再说|聊)|缓一下|让我(先)?(看|查|找)|等(下|会儿)再/;

/** 发送动作类工具：它们只"交付"，不需要看结果就能决定下一步。 */
const DELIVERY_TOOLS = new Set(['send_message', 'send_sticker', 'send_poke']);

let log = () => {};

/** 解析工具的 arguments（orchestrator 传过来的是 JSON 字符串）。坏 JSON 返回 null。 */
function parseArgs(call) {
  const raw = call?.function?.arguments;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw ?? '{}')); } catch { return null; }
}

/** 解析工具结果的 content（ok() 序列化后的 JSON）。不是 JSON 就返回 null —— 调用方按失败处理。 */
function parseResultPayload(content) {
  if (content && typeof content === 'object') return content;
  const body = String(content ?? '').trim();
  if (!body.startsWith('{')) return null;          // 错误文案（"错误：…"）走这条路
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/** 消息内容的尾部（判定"预告式结尾"只看结尾，避免正文开头的'我看看'误伤）。 */
function tailOf(value, n = 80) {
  return String(value ?? '').slice(-n);
}

/** messageId 存在且非空才算"真发出去了"（去重命中时是 null，旧存档甚至没有这个字段）。 */
function hasRealMessageId(item) {
  if (!item || item.messageId === null || item.messageId === undefined) return false;
  return String(item.messageId) !== '';
}

/**
 * 纯判定：本批能否本地收尾。
 * @param {object} input { batch: { calls, results, newSent, text }, config }
 * @returns {{ shouldEnd: boolean, reason: string }}
 */
export function canEndReplyBatch(input = {}) {
  const batch = input.batch || {};
  const cfg = input.config || {};
  const calls = Array.isArray(batch.calls) ? batch.calls : [];
  const results = Array.isArray(batch.results) ? batch.results : [];
  const newSent = Array.isArray(batch.newSent) ? batch.newSent : [];
  const deny = (reason) => ({ shouldEnd: false, reason });

  // 规则 1/2/3：只允许"发送类"工具 + finish；最多 2 次，同类最多 2 次
  const sendIdx = [];
  const counts = {};
  for (let i = 0; i < calls.length; i++) {
    const name = String(calls[i]?.function?.name ?? '');
    if (!name) return deny('工具名缺失');
    if (name === 'finish') continue;
    if (!DELIVERY_TOOLS.has(name)) return deny(`本批还有需要看结果的工具：${name}`);
    counts[name] = (counts[name] || 0) + 1;
    if (name === 'send_message') sendIdx.push(i);
  }
  if (!sendIdx.length) return deny('本批没有 send_message');
  const totalSend = Object.values(counts).reduce((a, b) => a + b, 0);
  if (totalSend > 2) return deny(`发送类工具调用 ${totalSend} 次（上限 2）`);
  if (Object.values(counts).some((c) => c > 2)) return deny('同类发送工具重复调用');

  // 规则 0：必须显式声明 end:true。没有声明就不猜——多气泡补发被截断的代价
  // 远大于省下的那一轮。参数只解析一次，规则 5 复用这份结果。
  const sendArgs = [];
  for (const i of sendIdx) {
    const args = parseArgs(calls[i]);
    if (!args) return deny('send_message 参数不是合法 JSON');
    sendArgs.push(args);
  }
  if (!sendArgs.some((args) => args.end === true)) return deny('没有显式 end:true（不猜模型是否说完）');

  // 规则 4：每条 send_message 都要"干净成功"。
  // 全败 → isError:true；部分失败 → 返回的是 ok()，只有 failed 计数能看出来（A1-c）。
  for (const i of sendIdx) {
    const r = results[i];
    if (!r) return deny('缺少对应的工具结果');
    if (r.isError === true) return deny('发送失败');
    const payload = parseResultPayload(r.content);
    if (!payload) return deny('工具结果不是 JSON（保守起见不结束）');
    if (Number(payload.failed) > 0) return deny(`有 ${payload.failed} 条没发出去`);
    if (Number(payload.sent) === 0) return deny('一条都没发出去');
  }

  // 规则 5：字符串或数组都允许（数组=分条，是提示词推荐形态）；配置可关
  const messages = [];
  for (const args of sendArgs) {
    const m = args.messages;
    if (Array.isArray(m)) {
      if (cfg.allowArrayMessages === false) return deny('分条发送（allowArrayMessages 已关）');
      messages.push(...m.map((x) => String(x ?? '')));
    } else {
      messages.push(String(m ?? ''));
    }
  }

  // 规则 6：必须有"真的发出去"的证据（去重命中时 messageId 为空；旧条目没有这个字段）
  const textSent = newSent.filter((s) => s && s.type === 'text');
  if (!textSent.length) return deny('本批没有新增文本发送记录');
  if (!textSent.some(hasRealMessageId)) return deny('没有拿到 messageId（可能被去重跳过）');

  // 规则 7：预告式结尾（正文 + 每一条消息文本的尾部）
  if (cfg.checkTrailer !== false) {
    for (const t of [tailOf(batch.text), ...messages.map((m) => tailOf(m))]) {
      if (DEFAULT_TRAILER_RE.test(t)) return deny('结尾像预告（等我/稍等/我看看）');
    }
  }

  return { shouldEnd: true, reason: '本批已交付完毕' };
}

// ── 观测计数（只统计，不参与任何判定）────────────────────────────────────
// 目的：量出「已经交付、但模型没写 end:true」的批次有多少，跑 2–3 天再决定
// 要不要动提示词。判定逻辑与返回值不变。
const stats = { deliveredNoEnd: 0 };

function isCleanSendResult(result) {
  // ⚠️ 工具结果是 result.content（不是 result.result）——
  //    session 存档里的字段叫 result，不要把两处混淆。
  if (!result || result.isError) return false;
  try {
    const p = JSON.parse(String(result?.content ?? ''));
    if (p.failed) return false;
    return Number(p.sent) > 0 || p.sent === true;
  } catch { return false; }
}

/** 本批 send_message 全部干净成功、但没有任何一条带 end:true → 记一笔。 */
function noteDeliveredWithoutEnd(batch) {
  const calls = Array.isArray(batch?.calls) ? batch.calls : [];
  const results = Array.isArray(batch?.results) ? batch.results : [];
  const idx = [];
  for (let i = 0; i < calls.length; i++) {
    if (String(calls[i]?.function?.name ?? '') === 'send_message') idx.push(i);
  }
  if (!idx.length) return;
  if (!idx.every((i) => isCleanSendResult(results[i]))) return;   // 没交付成功的不算
  if (idx.some((i) => parseArgs(calls[i])?.end === true)) return;  // 带了 end 的不算（另有规则挡）
  stats.deliveredNoEnd += 1;
  const names = calls.map((c) => String(c?.function?.name ?? '')).filter(Boolean);
  log(`[reply-auto-end] 已交付但没写 end:true（累计 ${stats.deliveredNoEnd}）：${names.join(' + ')}`);
}

// 配置读取：setup(api) 才能拿到 api.config()，而 providers 的函数在模块顶层。
// 用模块级变量做闭包，别去挂 globalThis（会污染全局，也不利于热重载）。
let readConfig = () => ({});

export function setup(api) {
  log = api?.log || (() => {});
  readConfig = () => {
    try { return api?.config?.() || {}; } catch { return {}; }
  };
  // 每次调用都重新读配置（不在 setup 里快照），插件页改设置立即生效。
  // 注意：setup 在"已加载"时就会跑，不代表已启用（默认关闭，等表情同批率达标后再开）。
  log('省调用·发送后自动收尾已加载：启用后只在模型显式 end:true 时本地结束');
}

export function available() {
  return { ok: true };
}

export const providers = {
  'reply.local-policy': (payload = {}) => {
    const r = canEndReplyBatch({ batch: payload?.batch, config: readConfig() });
    if (r.shouldEnd) log(`本地收尾：${r.reason}`);
    else noteDeliveredWithoutEnd(payload?.batch);
    return r;
  }
};

/** 测试用。 */
export const internals = { parseArgs, tailOf, DEFAULT_TRAILER_RE, stats };
