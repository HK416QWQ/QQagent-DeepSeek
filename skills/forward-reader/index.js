// 转发记录阅读器（forward-reader）
//
// ── 这个技能解决什么 ──
// 用户的原话：「让 QQ Agent 看到转发的聊天记录内的内容」。
// 实测（读了 data/messages 里的真实存档 + 直接打协议端接口）发现三个具体缺口：
//   · 机器人回「看不了」：转发展开失败时存档里只剩占位符 [合并转发聊天记录]；
//   · 套娃看不到：内置只展开一层，转发里的转发又是占位符（实测嵌套 id 其实可查）；
//   · 图片看不到：图片只有 [图片] 占位，模型不知道里面有什么；
//   另外还实测出「转发里的 QQ 号不可信」（见 lib/forward.js 文件头）。
//
// ── 为什么是技能（skills/）而不是插件（plugins/）──
// 「看懂转发内容」必须经过模型理解、由模型判断要不要接话 —— 属于"要动脑子"的一类，
// 按开发规范应做成技能。插件适合"命中规则就固定执行、不过模型"的确定性逻辑
// （比如开播提醒、链接转发）。
//
// ── 自动是怎么做到的（本技能的关键）──
// 技能钩子里拿不到 ctx.onebot（框架只给工具执行上下文），所以钩子无法直接调协议端。
// 这里改成向**本机协议端**发 HTTP（lib/bridge.js，地址与 token 自动从 data/config.json
// 读），于是能在 `before-context` 阶段——也就是提示词组装**之前**——把转发就地展开、
// 写回消息存档。等提示词拼出来时，模型看到的就是展开后的普通消息，
// 它自然会像处理普通群聊一样判断要不要接话，不需要用户开口、也不会多触发一次回复。
//
// 写回存档用的 ctx.store.updateByMid 与内置 read_forward 工具是同一个 API，
// 一次展开永久有效（存档页、金句墙、后续几轮都能直接读到内容）。

let log = () => {};
let cfg = () => ({});
let fetchImpl = null;
let diskLog = null;   // 项目 logger；导入失败时降级为 null，不影响技能
let compressImage = null;

let libsPromise = null;
let F = null;   // lib/forward.js
let B = null;   // lib/bridge.js

/** 已经成功展开过的 chatKey#mid（避免同一轮/连续几轮重复打协议端）。 */
const expandedOk = new Set();
const EXPANDED_CACHE_MAX = 800;

/** 本次运行的结果，供 before-llm-messages 注入提示（key = sessionId）。 */
const runNotes = new Map();
const RUN_NOTES_MAX = 50;

/** 最近一次运行时视觉能力是否可用（before-context 先跑，工具执行时用得上）。 */
let visionEnabled = true;

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}
function err(message) { return { content: `错误：${message}`, isError: true }; }

function persist(level, message) {
  try { diskLog?.[level]?.('skill:forward-reader', message); } catch { /* 落盘失败不影响聊天 */ }
}

// 把错误压成固定分类，绝不把 error.message 原文写进日志
function errorCode(error) {
  const msg = String(error?.message ?? error ?? '');
  if (error?.budgetExhausted) return 'budget_exhausted';
  if (error?.notForward) return 'not_forward';
  if (error?.name === 'AbortError' || /超时|timeout/i.test(msg)) return 'timeout';
  if (error?.retcode === 100 || /payload is empty/i.test(msg)) return 'payload_empty';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'unreachable';
  return 'other';
}

/** 协议端"这个 message_id 解不出正文"（而不是网络故障）。 */
function isPayloadEmpty(error) {
  return error?.retcode === 100 || /retcode=100|payload is empty/i.test(String(error?.message ?? error ?? ''));
}

/**
 * lib 必须用带时间戳的动态 import。
 * 静态 import 的 URL 不带 query，热重载时框架只换掉 index.js 自己，
 * lib 会一直命中第一次加载的旧模块（qzone 技能踩过这个坑：改了规则、重载后没生效）。
 */
function loadLibs() {
  if (!libsPromise) {
    libsPromise = Promise.all([
      import(`./lib/forward.js?t=${Date.now()}`),
      import(`./lib/bridge.js?t=${Date.now()}`)
    ]).then(([forwardMod, bridgeMod]) => ({ F: forwardMod, B: bridgeMod }))
      .catch((error) => { libsPromise = null; throw error; });
  }
  return libsPromise;
}

function num(key, fallback, min, max) {
  const n = Number(cfg()[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function expandOptions() {
  return {
    maxDepth: num('maxDepth', 2, 1, 3),
    maxNodes: num('maxNodes', 60, 1, 500),
    maxChars: num('maxChars', 9000, 200, 60000)
  };
}

function endpointOptions() {
  return {
    url: String(cfg().onebotHttpUrl ?? '').trim(),
    token: String(cfg().onebotAccessToken ?? '').trim(),
    fetchImpl
  };
}

/**
 * 取节点。顶层用 message_id，嵌套用 forward 段里的 64 位 id。
 *
 * ── 为什么要有回落（2026-11-01 实测）──
 * SnowLuma 对**负数 message_id** 调 get_forward_msg 常返回 retcode 100
 * "download forward message payload is empty"，但同一个转发用消息段里的
 * 64 位 id（{ id }）就能正常取到，8 小时前的老转发也可以。
 * 所以 message_id 解不出时，先用 get_msg 拿这条消息的 forward 段 id 再试一次。
 * 目标不是转发（模型给错了 #数字，比如给了一条引用消息）时抛 notForward，
 * 由工具层改读它前面最近的一条转发或给出准确提示。
 */
function callApi(ctx, action, params, { timeoutMs = null, deadline = 0 } = {}) {
  const ob = ctx?.onebot;
  if (ob && typeof ob.call === 'function') return ob.call(action, params);
  let limit = timeoutMs;
  if (deadline) {
    const left = deadline - Date.now() - HOOK_RESERVE_MS;
    if (left < HOOK_CALL_MIN_MS) throw budgetError();
    limit = Math.min(HOOK_CALL_MAX_MS, left);
  }
  return B.callOneBot(action, params, {
    ...endpointOptions(),
    timeoutMs: limit ?? num('timeoutMs', 8000, 2000, 20000)
  });
}

/** 从 get_msg 的响应里找转发段的 64 位 id（工具路径返回 data，HTTP 路径返回整个包）。 */
function forwardSegId(resp) {
  const d = resp?.data ?? resp;
  const segs = Array.isArray(d?.message) ? d.message : (Array.isArray(d?.segments) ? d.segments : []);
  const seg = segs.find((s) => s?.type === 'forward');
  return seg ? (F.forwardIdOf(seg) || '') : '';
}

function makeGetNodes(ctx, opts = {}) {
  return async (id) => {
    const key = String(id ?? '').trim();
    // 64 位转发 id（嵌套层 / 模型直接给）——直接用 id 参数取，最可靠
    if (!/^-?\d+$/.test(key)) return callApi(ctx, 'get_forward_msg', { id: key }, opts);
    try {
      return await callApi(ctx, 'get_forward_msg', { message_id: Number(key) }, opts);
    } catch (error) {
      if (!isPayloadEmpty(error)) throw error;
      const msg = await callApi(ctx, 'get_msg', { message_id: Number(key) }, opts);
      const fid = forwardSegId(msg);
      if (!fid) throw Object.assign(new Error('这条消息不是合并转发'), { notForward: true });
      return callApi(ctx, 'get_forward_msg', { id: fid }, opts);
    }
  };
}

const HOOK_BUDGET_MS = 4200;    // 框架 5000ms，留 800ms 给写回与后续注入
const HOOK_RESERVE_MS = 600;    // 每次调用前先预留的收尾时间
const HOOK_CALL_MAX_MS = 1800;  // 单次协议端请求上限
const HOOK_CALL_MIN_MS = 1200;  // 剩余预算低于此值就不开新请求

function budgetError() {
  return Object.assign(new Error('自动展开预算用尽'), { budgetExhausted: true });
}

function hookGetNodes(deadline) {
  return makeGetNodes(null, { deadline });
}

const IMAGE_MIME = (buf) => {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;        // 下载判废阈值
const TARGET_IMAGE_BYTES = 1.2 * 1024 * 1024;   // 压缩目标
const FINAL_IMAGE_BYTES = 1.5 * 1024 * 1024;    // 单图最终上限（base64 前）
const IMAGE_TIMEOUT_MS = 10000;

// 图片 URL 来自转发节点，不能当可信输入：只做协议/字面量内网检查（不做 DNS 解析）
const PRIVATE_HOST_RE = /^(?:localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;
const PRIVATE_V6_RE = /^\[(?:::1?|::ffff:(?:127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/i;

function assertImageUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('图片地址不合法'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('图片地址不是 http/https');
  const host = u.hostname.toLowerCase();
  if (!host || host.endsWith('.local') || PRIVATE_HOST_RE.test(host) || PRIVATE_V6_RE.test(host)) {
    throw new Error('图片地址指向本机/内网，已拒绝');
  }
  return u.toString();
}

/** 把转发里的图片下载成 data URL（视觉模型直接能看的那种）。 */
async function imageToDataUrl(rawUrl) {
  const url = assertImageUrl(rawUrl);
  const doFetch = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*;q=0.8' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    assertImageUrl(res.url || url);                       // 重定向后的地址也要校验
    const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) throw new Error(`不是图片（${type.split(';')[0]}）`);

    let buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('图片内容为空');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片太大（${(buf.length / 1024 / 1024).toFixed(1)}MB）`);

    let mime = IMAGE_MIME(buf);
    if (compressImage && buf.length > 512 * 1024) {
      try {
        const c = await compressImage(buf, { maxDim: 1568, maxBytes: TARGET_IMAGE_BYTES });
        if (c?.buffer?.length) { buf = c.buffer; mime = c.mime || mime; }
      } catch { /* 压缩失败用原图，下面还有体积兜底 */ }
    }
    if (buf.length > FINAL_IMAGE_BYTES) {
      throw new Error(`图片压缩后仍有 ${(buf.length / 1024 / 1024).toFixed(1)}MB（本机可能没有 ffmpeg），已跳过`);
    }
    return `data:${mime};base64,${buf.toString('base64')}`;
  } finally {
    clearTimeout(timer);
  }
}

/** 找本轮/最近一条可读的转发消息的 message_id。 */
function pickMessageId(ctx, arg) {
  const raw = String(arg ?? '').trim().replace(/^[#＃]/, '');
  if (raw) return F.isMessageId(raw) ? raw : { invalid: true, raw };
  let recent = [];
  try { recent = ctx?.store?.recent?.(ctx.chatKey, { limit: 40 }) ?? []; } catch { recent = []; }
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const m = recent[i];
    if (m?.mid != null && F.looksLikeForward(m.text)) return String(m.mid);
  }
  return null;
}

/** 给错 #数字时，优先改读那条消息之前最近的一条转发（多半就是它引用的那条）。 */
function pickNearbyForwardMid(ctx, target) {
  let recent = [];
  try { recent = ctx?.store?.recent?.(ctx.chatKey, { limit: 40 }) ?? []; } catch { recent = []; }
  const at = recent.findIndex((m) => String(m?.mid) === String(target));
  for (let i = (at >= 0 ? at - 1 : recent.length - 1); i >= 0; i -= 1) {
    const m = recent[i];
    if (m?.mid != null && F.looksLikeForward(m.text)) return String(m.mid);
  }
  return null;
}

/** 展开失败时给模型的说明（失败分类决定措辞，不把协议端原文丢给模型）。 */
function forwardFailure(error, mid) {
  if (error?.notForward) {
    return err(`这条消息（#${mid}）不是合并转发，也没找到可以改读的转发。请让用户把内容贴出来。`);
  }
  if (isPayloadEmpty(error)) {
    return err(`这条转发（#${mid}）的正文协议端确实取不到（SnowLuma 返回 payload is empty；消息 id 和转发 id 都试过了）。通常是这条消息在 QQ 侧已经失效，不要编造内容；如实告诉用户「这条转发的正文我这边取不到，如果是重要内容，麻烦把文字直接贴一下」，也不要笼统说「我打不开」。`);
  }
  return err(`展开转发失败：${B ? B.humanError(error) : String(error?.message ?? error)}`);
}

export async function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  fetchImpl = typeof api.fetch === 'function' ? api.fetch : null;
  try {
    const mod = await import('../../src/logger.js');
    diskLog = mod.logger || null;
  } catch { diskLog = null; }
  try {
    const mod = await import('../../src/image-compress.js');
    compressImage = mod.compressImage || null;
  } catch { compressImage = null; }
  const libs = await loadLibs();
  F = libs.F;
  B = libs.B;

  api.registerTool({
    id: 'forward_read',
    name: '读转发记录',
    description: '完整读取一条「合并转发聊天记录」：把套娃转发一起展开（默认 2 层），比上下文里那份更全，还能把转发里的图片直接给你看。用法：messageId 填那条转发消息前的 #数字（省略 = 最近一条转发）。上下文里出现 [合并转发聊天记录] / [转发消息 …] / 「…（还有 N 条未展开）」，或者想看转发里的图片时用它。转发节点里的人只保证昵称，QQ 号不可信，别用来 @ 人或记印象。',
    category: 'query',
    icon: '📨',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）。省略则自动取最近一条转发。' },
        depth: { type: 'integer', description: '往下钻几层套娃转发，1~3，默认用设置里的值（2）。' },
        includeImages: { type: 'boolean', description: '是否把转发里的图片一起返回给你看。默认按设置里的张数上限；传 false = 只要文字。' }
      }
    },
    async execute(ctx, args) {
      try {
        const picked = pickMessageId(ctx, args?.messageId);
        if (picked && typeof picked === 'object' && picked.invalid) {
          return err(`messageId 要填聊天记录里的 #数字（可能为负数），收到的是「${String(picked.raw).slice(0, 20)}」。`);
        }
        if (picked == null) {
          return err('这个会话里没找到合并转发的消息（最近 40 条里没有）。可以用 #消息号 指定具体那条，或请用户把那段文字直接贴一下。');
        }
        const mid = /^-?\d+$/.test(String(picked)) ? Number(picked) : picked;
        const opts = expandOptions();
        const depth = Number(args?.depth);
        if (Number.isFinite(depth)) opts.maxDepth = Math.min(3, Math.max(1, Math.trunc(depth)));
        const getNodes = makeGetNodes(ctx);

        let readMid = mid;          // 实际读到的那条（给错了目标时会改成最近一条转发）
        let redirectNote = '';
        let r;
        try {
          r = await F.expandForward(readMid, { getNodes, ...opts });
        } catch (error) {
          persist('warn', 'event=tool_fail mid=' + readMid + ' retcode=' + (error?.retcode ?? 'n/a') + ' code=' + errorCode(error));
          if (!error?.notForward) return forwardFailure(error, readMid);
          // 模型给错了 #数字（常见：给成引用消息/普通消息）——改读它前面最近的一条转发，并说明改了什么
          const alt = pickNearbyForwardMid(ctx, mid);
          if (!alt || String(alt) === String(readMid)) return forwardFailure(error, readMid);
          persist('info', 'event=tool_redirect mid=' + readMid + ' to=' + alt);
          redirectNote = `（你给的 #${readMid} 不是合并转发，已自动改读它前面最近的一条转发 #${alt}。）\n`;
          readMid = alt;
          try {
            r = await F.expandForward(readMid, { getNodes, ...opts });
          } catch (error2) {
            persist('warn', 'event=tool_fail mid=' + readMid + ' retcode=' + (error2?.retcode ?? 'n/a') + ' code=' + errorCode(error2));
            return forwardFailure(error2, readMid);
          }
        }
        if (!r?.ok) {
          persist('warn', 'event=tool_fail mid=' + readMid + ' retcode=n/a code=empty');
          return err(`这条转发（#${readMid}）没能展开：${r?.error || '内容为空'}。如实告诉用户即可，不要编造内容。`);
        }

        // 写回存档：下次谁读这条消息都能直接看到展开后的内容
        try { ctx.store?.updateByMid?.(ctx.chatKey, readMid, { text: r.text, appendMedia: r.media || [] }); } catch { /* 存档写失败不影响本次返回 */ }

        const parts = [{
          type: 'text',
          text: `${redirectNote}转发记录 #${readMid}（共 ${r.totalNodes} 条${r.nestedForwards ? `，含 ${r.nestedForwards} 段嵌套转发` : ''}${r.imageCount ? `，${r.imageCount} 张图片` : ''}）：\n${r.text}`
        }];

        // 图片：直接作为多模态内容给模型看（视觉模型能读懂）。并发取图，串行最坏 3×10s。
        const wantImages = args?.includeImages !== false && visionEnabled;
        const limit = wantImages ? Math.min(num('maxImages', 3, 0, 20), 3) : 0;
        const results = await Promise.all((r.images || []).slice(0, limit).map((img) => {
          if (!img?.url) return null;
          return imageToDataUrl(img.url).then(
            (url) => ({ url }),
            (error) => ({ skipped: String(error?.message ?? error) })
          );
        }));
        const skipped = [];
        let attached = 0;
        for (const item of results) {
          if (!item) continue;
          if (item.url) {
            parts.push({ type: 'image_url', image_url: { url: item.url } });
            attached += 1;
          } else if (item.skipped) {
            skipped.push(item.skipped);
          }
        }
        if (attached) {
          parts[0].text += `\n（下面 ${attached} 张就是这条转发里的图片，直接看图说话。）`;
        } else if (r.imageCount) {
          parts[0].text += `\n（这条转发里有 ${r.imageCount} 张图片，本次没取图；需要的话可以让我再看一次，或用内置的 get_message_images 看 #${readMid}。）`;
        }
        if (skipped.length) parts[0].text += `\n（有 ${skipped.length} 张图没取到：${skipped.slice(0, 2).join('；')}）`;
        persist('info', 'event=tool_ok mid=' + readMid + ' nodes=' + r.totalNodes + ' images=' + (r.imageCount || 0));
        return { content: parts };
      } catch (error) {
        persist('warn', 'event=tool_fail mid=n/a retcode=' + (error?.retcode ?? 'n/a') + ' code=' + errorCode(error));
        return err(`读转发失败：${B ? B.humanError(error) : String(error?.message ?? error)}`);
      }
    }
  });

  log('转发记录阅读器已加载');
}

export const hooks = {
  /**
   * 自动展开 —— 本技能的核心。
   * 时机：提示词组装**之前**跑，此时 updateByMid 写回去的内容，模型这一轮就能看到。
   * 约束：只碰"确实还没展开好"的消息；一次最多处理 2 条、每条有超时；
   *      任何失败都静默降级（记日志 + 让模型看到一句解释），绝不影响正常聊天。
   */
  async 'before-context'(ctx) {
    try {
      if (!F || !B) return;
      visionEnabled = ctx?.visionEnabled !== false;
      if (cfg().enabled === false) return;
      if (cfg().autoExpand === false) return;

      const store = ctx?.store;
      const chatKey = ctx?.chatKey;
      const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
      if (!store || !chatKey || !entries.length) return;

      const done = [];
      const failed = [];
      let budget = 2;
      const deadline = Date.now() + HOOK_BUDGET_MS;

      for (const entry of entries) {
        if (budget <= 0) break;
        const mid = entry?.mid;
        if (mid == null) continue;
        const text = String(entry?.text ?? '');
        if (!F.looksLikeForward(text) || !F.needsExpand(text)) continue;   // 已展开好的不动
        const cacheKey = `${chatKey}#${mid}`;
        if (expandedOk.has(cacheKey)) continue;

        budget -= 1;
        try {
          const r = await F.expandForward(mid, { getNodes: hookGetNodes(deadline), ...expandOptions() });
          if (r?.ok && r.text) {
            try { store.updateByMid(chatKey, mid, { text: r.text, appendMedia: r.media || [] }); } catch { /* 写存档失败不影响本轮提示 */ }
            expandedOk.add(cacheKey);
            if (expandedOk.size > EXPANDED_CACHE_MAX) expandedOk.clear();
            done.push({ mid, imageCount: r.imageCount, nested: r.nestedForwards, totalNodes: r.totalNodes });
            persist('info', 'event=auto_ok mid=' + mid + ' nodes=' + r.totalNodes + ' nested=' + (r.nestedForwards || 0) + ' truncated=' + (r.truncated || 0) + ' images=' + (r.imageCount || 0));
            log(`自动展开转发 #${mid}：${r.totalNodes} 条${r.nestedForwards ? `，含 ${r.nestedForwards} 段嵌套` : ''}${r.imageCount ? `，${r.imageCount} 张图` : ''}`);
          } else {
            persist('warn', 'event=auto_fail mid=' + mid + ' retcode=n/a code=empty');
            failed.push({ mid, reason: r?.error || '内容为空' });
          }
        } catch (error) {
          if (error?.budgetExhausted) {
            persist('info', 'event=budget_exhausted mid=' + mid + ' wrote=0');
            break;
          }
          const reason = error?.notForward
            ? '这条消息不是合并转发'
            : (isPayloadEmpty(error) ? '协议端取不到正文（message_id 与转发 id 都试过了）' : B.humanError(error));
          persist('warn', 'event=auto_fail mid=' + mid + ' retcode=' + (error?.retcode ?? 'n/a') + ' code=' + errorCode(error));
          failed.push({ mid, reason });
          log(`自动展开转发 #${mid} 失败：${reason}`);
        }
      }

      if (done.length || failed.length) {
        runNotes.set(String(ctx.sessionId ?? ''), { done, failed });
        if (runNotes.size > RUN_NOTES_MAX) {
          const first = runNotes.keys().next();
          if (!first.done) runNotes.delete(first.value);
        }
      }
    } catch (error) {
      log('自动展开流程异常（已忽略，不影响本轮回复）：' + (error?.message ?? error));
    }
  },

  /**
   * 给模型补一句说明。
   * 不注入的话，模型看到 [合并转发通用占位符] 只会回"我看不了"，
   * 看到 [图片] 也不会想到去取图。
   */
  async 'before-llm-messages'(ctx) {
    try {
      const key = String(ctx?.sessionId ?? '');
      const note = runNotes.get(key);
      if (!note) return;
      runNotes.delete(key);

      const messages = Array.isArray(ctx?.messages) ? ctx.messages : null;
      if (!messages?.length) return;
      const showHint = cfg().showImageHint !== false;
      const lines = [];

      for (const d of note.done || []) {
        lines.push(`你刚收到一条合并转发的聊天记录（消息 #${d.mid}），内容已经自动展开在上面了：直接当普通消息读、正常判断要不要接话就行，**不要说"我看不到转发内容"**。`);
        if (d.nested) lines.push(`里面还套着 ${d.nested} 段转发，也已经一并展开。`);
        if (d.imageCount && showHint) {
          lines.push(`这条转发里还有 ${d.imageCount} 张图片：想看就用 get_message_images（messageId 填 ${d.mid}），或者调 forward_read 让它把图片一起给你。`);
        }
      }
      for (const f of note.failed || []) {
        lines.push(`这条合并转发（#${f.mid}）没能展开：${f.reason}。用户问起时照实说明（例如"这条转发的正文我这边取不到，如果是重要内容，麻烦把文字直接贴一下"），不要自己下结论，不要编造内容，也不要笼统说"我打不开"。`);
      }
      if (!lines.length) return;

      const nudge = `\n\n[系统提示·转发记录] ${lines.join(' ')}`;
      const last = messages[messages.length - 1];
      if (last && typeof last.content === 'string') last.content += nudge;
      else if (last && Array.isArray(last.content)) last.content.push({ type: 'text', text: nudge });
      else messages.push({ role: 'user', content: nudge });
    } catch (error) {
      log('转发提示注入异常（已忽略）：' + (error?.message ?? error));
    }
  }
};
