// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
//
// 重构说明：所有工具通过 registerTool() 注册到 tool-registry.js，
// 支持在设置页按卡片勾选启用/禁用。
import fs from 'node:fs';
import { getConfig } from './config.js';
import { normalizeMessageList, unquoteJsonString } from './util.js';
import { formatStickerList } from './stickers.js';
import { skillManager } from './skills/manager.js';
import { validateImageUrl, safeFetchBinary, browseLockState, checkBrowseLock } from './safe-fetch.js';
import { webSearch, webFetch } from './web-search.js';
import { expandForwardNodes, transcribeVoice, voicePlaceholder } from './onebot.js';
import { registerTool, listTools, getTool, getToolAvailability } from './tool-registry.js';
import { holidayOn, upcomingHoliday } from './holidays.js';
import { detectImageType } from './image-type.js';
import { prepareImage, IMAGE_LIMITS } from './image-prep.js';
import { logger } from './logger.js';
import { localStickerPath } from './sticker-manager.js';
import { isGifBuffer, gifToVideoDataUrl, resolveGifRoute } from './gif-to-video.js';
import { recordVideo, recordAudio } from './behavior-stats.js';
import { makeCandidateRow, appendCandidate } from './mem2/store.js';

// send_image 的显式白名单：image-type.js 扩容后会认出 bmp/tiff/heic，
// 但"发网图"的语义仍是只认 png/jpg/gif/webp 直链，不能跟着嗅探一起放开。
const SEND_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 当前配置的 GIF 选路（vision/video 开关组合，规则矩阵见 resolveGifRoute 注释）。 */
function currentGifRoute() {
  const cfg = getConfig();
  return resolveGifRoute({ vision: cfg.api?.vision !== false, video: cfg.api?.video === true });
}

// 只负责取字节和 GIF 选路，不拼 data URL、不做图片守卫。
async function fetchImageForModel(url, timeoutMs = 30000) {
  // 表情库的本地转存是 file:///，validateImageUrl 只认 http(s)。
  // 复用发送侧的受控目录闸：只读取 data/sticker-images 内的文件，
  // 不能对任意 file:/// 直接 readFile（否则模型可借看图工具读本机任意文件）。
  const local = localStickerPath(url);
  let buffer;
  let contentType = '';
  if (local) {
    buffer = fs.readFileSync(local);
  } else {
    const safeUrl = await validateImageUrl(url);
    ({ buffer, contentType } = await safeFetchBinary(safeUrl));
  }
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  // GIF 在这里分岔（规则矩阵见 resolveGifRoute）：
  //   vision+video 都开 → 转 mp4 按 video 部件发（llm.js 自动切视频专用模型）；
  //   只开 vision      → GIF 按图片原样发（读不了的模型由 llm.js 的"图片被拒"
  //                      降级路径换首帧重试 —— 见 image-compat 的 llm.retry-advisor）；
  //   vision 没开      → 看图工具整体不可用，不会被调到。
  if (isGifBuffer(buffer) && currentGifRoute() === 'video') {
    const video = await gifToVideoDataUrl(buffer);
    if (video) {
      return {
        kind: 'video',
        gifVideo: {
          dataUrl: video.dataUrl,
          frames: video.frames,
          width: video.width,
          height: video.height
        }
      };
    }
    // 转换失败（没 ffmpeg / 文件异常）→ 落到下面的普通图片路径，按原样发
  }
  return { kind: 'image', buffer, contentType };
}

// 只负责守卫和组装图片部件。守卫省略时 parts=[]，由调用方汇总成文本说明，不抛错。
async function prepareImageResult(url, { msgId = null, imageIndex = 0 } = {}) {
  const fetched = await fetchImageForModel(url);
  if (fetched.kind === 'video') {
    return { gifVideo: fetched.gifVideo, meta: { kind: 'gif-video' } };
  }
  const prep = await prepareImage(fetched.buffer, { contentType: fetched.contentType });
  // EXIF Orientation 5–8：存储画面与显示画面差 90°，必须让人知道 ffmpeg 是按显示尺寸扶正后切的。
  // 只在这种"容易切错"的情况下多打一条；1–4 静默（不刷日志）。
  const ori = prep.meta.input?.orientation || 1;
  if (ori >= 5) {
    const inMeta = prep.meta.input;
    logger.info('media', `orientation=${ori} stored=${inMeta.storedWidth}x${inMeta.storedHeight} display=${inMeta.width}x${inMeta.height} msg=${msgId ?? '-'} idx=${imageIndex}`);
  }
  return {
    parts: prep.parts.map((p) => ({
      type: 'image_url',
      image_url: { url: `data:${p.mime};base64,${p.buffer.toString('base64')}` }
    })),
    // 判**输出** mime，不是 input：GIF 已被缩成静态 JPEG 时不能仍声称是 GIF。
    // drop 时 output 为 null → false，也是对的（没有可发的部件）。
    isGif: prep.meta.output?.mime === 'image/gif',
    // 原始 GIF 字节留着：模型拒收 GIF 时降级重试要取首帧。非 GIF 返回 null。
    gifBuffer: isGifBuffer(fetched.buffer) ? fetched.buffer : null,
    meta: { ...prep.meta, msgId, imageIndex }
  };
}

/**
 * 把 prepareImageResult 的结果组装成工具返回的 content parts。
 * GIF 转出的视频用 video_url 部件（llm.js 检测到会自动切视频专用模型），
 * 其余仍是 image_url。GIF 按原图（gif-image 路线）发送时：能读 GIF 的模型
 * 看得到动图，读不了的会在网关报错后由 image-compat 的降级路径换首帧重试。
 */
function getImagePartsOrVideo(text, results) {
  const parts = [{ type: 'text', text }];
  const gifAsImage = [];
  for (const r of results) {
    if (r?.gifVideo) {
      parts.push({ type: 'video_url', video_url: { url: r.gifVideo.dataUrl } });
      continue;
    }
    if (r?.failed || r?.removed) continue;     // 下载失败 / 被总预算移除：不产生部件
    if (Array.isArray(r?.parts)) {
      parts.push(...r.parts);
      if (r?.isGif) gifAsImage.push(r);
    }
  }
  if (gifAsImage.length) {
    parts[0].text += `\n（其中 ${gifAsImage.length} 张是 GIF 动图，按原图发送：部分模型只能看到第一帧，读不了时会自动换成首帧重试）`;
  }
  return {
    content: parts,
    videoCount: parts.filter((p) => p.type === 'video_url').length
  };
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// ── 时间解析（search_messages 用，2026-11-04）──────────────────────────────
// 一律按 Asia/Shanghai 解释：机器可能跑在任意时区，而"昨天"对群友永远是东八区
// 的昨天。实现方式是把墙钟时间转成 "UTC 时刻 - 8h"，不依赖系统 TZ。
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

function shanghaiTs(y, mo, d, hh = 0, mi = 0, ss = 0, ms = 0) {
  return Date.UTC(y, mo - 1, d, hh, mi, ss, ms) - SHANGHAI_OFFSET_MS;
}

/** Date.UTC 会把 13 月 45 日"顺延"成合法日期 —— 入参必须自己校验。 */
function validYmd(y, mo, d) {
  if (!(y >= 1970 && y <= 3000)) return false;
  if (!(mo >= 1 && mo <= 12)) return false;
  if (!(d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 东八区的"今天"零点。 */
function shanghaiTodayStart() {
  const shifted = new Date(Date.now() + SHANGHAI_OFFSET_MS);
  return shanghaiTs(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * 解析一个时间入参。支持：YYYY-MM-DD、YYYY-MM-DD HH:mm、MM-DD HH:mm、
 * 今天 / 昨天 / 前天 / 最近N小时 / 最近N天。
 *
 * @param {string} raw
 * @param {{ end?: boolean }} [opts] end=true 时"只有日期"按当天 23:59:59.999 算
 * @returns {number|null} epoch ms；无法解析返回 null（调用方负责忽略该参数）
 */
export function parseSearchTime(raw, { end = false } = {}) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    if (!validYmd(+y, +mo, +d)) return null;
    return end ? shanghaiTs(+y, +mo, +d, 23, 59, 59, 999) : shanghaiTs(+y, +mo, +d);
  }
  const dateTime = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (dateTime) {
    const [, y, mo, d, hh, mi, ss] = dateTime;
    if (!validYmd(+y, +mo, +d) || +hh > 23 || +mi > 59 || +(ss || 0) > 59) return null;
    return shanghaiTs(+y, +mo, +d, +hh, +mi, +(ss || 0));
  }
  const mdTime = /^(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})$/.exec(s);
  if (mdTime) {
    const shifted = new Date(Date.now() + SHANGHAI_OFFSET_MS);
    const [, mo, d, hh, mi] = mdTime;
    if (!validYmd(shifted.getUTCFullYear(), +mo, +d) || +hh > 23 || +mi > 59) return null;
    return shanghaiTs(shifted.getUTCFullYear(), +mo, +d, +hh, +mi);
  }
  const today = shanghaiTodayStart();
  if (s === '今天') return end ? today + 864e5 - 1 : today;
  if (s === '昨天') return end ? today - 1 : today - 864e5;
  if (s === '前天') return end ? today - 864e5 - 1 : today - 2 * 864e5;
  const ago = /^最近\s*(\d+(?:\.\d+)?)\s*(小时|天|分钟)$/.exec(s);
  if (ago) {
    const n = Number(ago[1]);
    const unit = ago[2] === '小时' ? 3600e3 : ago[2] === '天' ? 864e5 : 60e3;
    if (!(n > 0)) return null;
    return Date.now() - n * unit;
  }
  return null;
}

/**
 * 纯时间词 → 检索范围（毫秒）。返回 null 表示"不是时间词"，按普通关键词处理。
 *
 * 背景（2026-11-04）：模型把"昨天"当内容词传进 keywords，而没人会在消息里写
 * "昨天"，AND 检索必然 0 命中（实测 [昨天] → 0 条，只给 from/to → 284 条）。
 *
 * 只收**过去向**的词：明天/后天指向未来，搜历史必然空集，剥掉反而误导模型。
 * 也不收 前段时间/之前 这类无法定量的词。
 *
 * ⚠️ 不能直接用 parseSearchTime 的 end 分支：`最近N小时` 的 start 与 end 都返回
 * now - N，区间长度退化为 0。这里对 ago 形式单独算 to = now。
 * ⚠️ 上面那句 `now` 是真参数，不是摆设：今天/昨天/周/月的边界都从它推，
 * 传进来的时刻决定"今天"是哪天（默认 Date.now()，线上行为不变）。
 */
export function timeWordRange(word, now = Date.now()) {
  const w = String(word ?? '').trim().replace(/\s+/g, '');
  if (!w) return null;
  const nowMs = Number(now) || Date.now();
  const DAY = 864e5;
  // 东八区的"今天零点" —— 从 now 推，不用 shanghaiTodayStart()（那个只认 Date.now()）
  const shiftedNow = new Date(nowMs + SHANGHAI_OFFSET_MS);
  const today = shanghaiTs(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth() + 1, shiftedNow.getUTCDate());
  const dayStart = (n) => today - n * DAY;

  if (w === '今天' || w === '今日' || w === '今早') return { from: today, to: nowMs };
  if (w === '昨天' || w === '昨日') return { from: dayStart(1), to: today - 1 };
  if (w === '昨晚') return { from: dayStart(1) + 18 * 3600e3, to: today - 1 };
  if (w === '前天') return { from: dayStart(2), to: dayStart(1) - 1 };
  if (w === '大前天') return { from: dayStart(3), to: dayStart(2) - 1 };
  if (w === '这几天' || w === '最近') return { from: dayStart(6), to: nowMs };

  const ago = /^最近(\d+(?:\.\d+)?)(分钟|小时|天)$/.exec(w);
  if (ago) {
    const n = Number(ago[1]);
    const unit = ago[2] === '分钟' ? 60e3 : ago[2] === '小时' ? 3600e3 : DAY;
    if (!(n > 0)) return null;
    return { from: nowMs - n * unit, to: nowMs };
  }

  // 周/月：以上海墙钟的周一、1 号为界（上海无夏令时，一天恒为 864e5）
  const wall = new Date(today + SHANGHAI_OFFSET_MS);
  const dow = (wall.getUTCDay() + 6) % 7;              // 0 = 周一（getUTCDay 的 0 是周日）
  const weekStart = today - dow * DAY;
  if (w === '这周' || w === '本周') return { from: weekStart, to: nowMs };
  if (w === '上周') return { from: weekStart - 7 * DAY, to: weekStart - 1 };
  if (w === '上个月' || w === '上月') {
    const prev = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 1));
    const prevStart = prev.getTime() - SHANGHAI_OFFSET_MS;
    const monthStart = today - (wall.getUTCDate() - 1) * DAY;
    return { from: prevStart, to: monthStart - 1 };
  }
  return null;
}

/** 检索结果里的时间显示（与 get_recent_messages 同口径）。 */
function searchTimeText(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 *
 * 重构后：工具定义注册到 tool-registry，这里从 registry 读取并过滤。
 */
export function buildToolDefs() {
  // 确保所有工具已注册（幂等）
  registerAllTools();
  // 加载插件工具（如果还没加载）
  loadPluginTools();
  return listTools();
}

/** 加载插件工具（幂等） */
let pluginToolsLoaded = false;
function loadPluginTools() {
  if (pluginToolsLoaded) return;
  pluginToolsLoaded = true;
  // 插件工具已在 app.js 启动时通过 loadPlugins() 注册到 registry
  // 这里只需要确保 registry 里有它们
}

/** 注册所有内置工具到 registry。 */
function registerAllTools() {
  // 消息发送类
  registerTool({
    id: 'send_message',
    name: '发送消息',
    description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊；要发到别处用 send_to）。不管几句，全部放进同一次调用的 messages 数组：字符串=一条；字符串数组=分多条（例如 ["在的","咋了"]）。不要发一条、下一轮再补一条，后面的轮次很容易晚到。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。要发表情就带 stickerId 一次发完；分两轮发，表情会晚到一轮，甚至可能发不出去。不要在字符串内部用空格分句。发之前先想好这一轮要说几句，全部放进同一次调用；确认这就是这次回复的全部、发完不再补时，在这次调用带 end:true。还有话要补就不要带——不要先带 end:true 发一条、下一轮再补。',
    category: 'messaging',
    icon: '💬',
    parameters: {
      type: 'object',
      properties: {
        messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
        atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' },
        stickerId: {
          type: 'string',
          description: '可选：同时发一个表情（id 从 list_stickers 获取）。文字和表情是两个气泡，但只花一次工具调用。**要发表情就一次发完，不要留到下一轮。**'
        },
        end: {
          type: 'boolean',
          description: '可选。你这次回复要说的都在这次调用里、发完不再补时设为 true：全部发送成功后系统会直接结束，省掉下一轮模型调用。还有话要补、或不确定，就不要传；不要先带 end:true 发一条、之后再补。'
        }
      },
      required: ['messages']
    },
    async execute(ctx, args) {
      try {
        const messages = normalizeMessageList(args.messages);
        if (!messages.length) {
          return err(args.stickerId ? '消息内容为空；只发表情请用 send_sticker' : '消息内容为空');
        }
        const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
        ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at, messageId: s.messageId ?? null })));
        ctx.emit('session-update', ctx.session.id);
        // ── 可选：同一条回复里追加一个表情 ────────────────────────────────
        // 直接复用 send_sticker 自己的 execute：40 行校验（ensureSendable / 白名单 /
        // URL 校验 / 路径自愈）一行都不复制，tool.guard、限频、去重、留档全部照旧。
        // 表情失败只报告、不返回 err：文字已经发出去了，这一轮只该"报告"不该"重试"。
        let stickerSent = false;
        let stickerNote = '';
        if (args.stickerId) {
          // ⚠️ toolsCfg 必须显式传：getToolAvailability 的默认值是 {}，
          //    漏传等于跳过"单工具开关"（tool-registry.js 的注释专门警告过这一点）
          const stickerCfg = getConfig().sticker || {};
          const avail = getToolAvailability('send_sticker', {
            toolsCfg: getConfig().tools,
            stickerEnabled: stickerCfg.enabled !== false,
            stickerCollectEnabled: stickerCfg.collectEnabled !== false
          });
          if (!avail.enabled) {
            stickerNote = `（表情工具当前不可用：${avail.reason}，未发表情）`;
          } else {
            try {
              const r = await getTool('send_sticker').execute(ctx, {
                stickerId: args.stickerId,
                replyToMessageId: args.replyToMessageId ?? null,
                atUserId: null // 表情不 @ 人：@ 挂在文字那条上就够了
              });
              stickerSent = r?.isError !== true;
              if (!stickerSent) stickerNote = `（表情没发出去：${String(r?.content ?? '').slice(0, 80)}）`;
            } catch (error) {
              stickerNote = `（表情没发出去：${error?.message ?? error}）`;
            }
          }
        }
        const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
        if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
        if (args.stickerId) note.push(stickerSent ? '表情也已发出。' : `文字已发出，但表情没发成功${stickerNote}。不要重发文字。`);
        return ok({ sent: result.sent.length, failed: result.failed.length, stickerSent, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'send_to',
    name: '发送到指定会话',
    // 描述动态化：开关关闭时明确说"没权限"，避免模型白试一次；
    // 开启时引导先用 get_chats 查目标。默认关闭（社交敏感操作）。
    description: (() => {
      const cross = getConfig().tools?.crossChatSend === true;
      const base = '把消息发送到另一个群/私聊（不在当前会话里说，而是去别处说）。适用于：有人明确让你转告某人/某群、你主动去私聊某人。';
      return cross
        ? `${base}先用 get_chats 查可用的 chatKey，再传 targetChatKey（形如 group:123 / private:456）。只在有明确理由时使用，不要骚扰别人。`
        : `${base}（当前未开启：管理员可在 设置 → 工具与技能 打开「允许跨会话发送」。）`;
    })(),
    category: 'messaging',
    icon: '📨',
    // 工具级可用性：开关关闭时整组工具不可见（getToolAvailability 的第 5 层），
    // 比描述提示更硬 —— 模型连试的机会都没有。
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        targetChatKey: { type: 'string', description: '目标会话：group:群号 / private:QQ号（用 get_chats 查，不要自己编）' },
        messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }
      },
      required: ['targetChatKey', 'messages']
    },
    async execute(ctx, args) {
      try {
        // 硬校验三连：开关 → 格式 → 白名单。描述里的引导不是安全边界。
        if (getConfig().tools?.crossChatSend !== true) {
          return err('跨会话发送未开启（管理员可在 设置 → 工具与技能 里打开）。');
        }
        const wantTarget = String(args.targetChatKey ?? '').trim();
        if (!/^(group|private):\d+$/.test(wantTarget)) {
          return err('targetChatKey 格式应为 group:群号 或 private:QQ号');
        }
        if (wantTarget === ctx.chatKey) {
          return err(`目标 ${wantTarget} 就是当前会话，直接用 send_message 即可。`);
        }
        const [tKind, tId] = wantTarget.split(':');
        const allow = getConfig().allow || {};
        const allowList = (tKind === 'group' ? allow.groups : allow.private) || [];
        // 白名单空名单口径必须与消息入口 app.allowed() 一致（群/私聊统一：
        // 空名单 + allowAllWhenEmpty 才放行）。曾经私聊在这里无条件放行，
        // 入口拒收私聊、send_to 却能替模型把消息发给任意私聊 QQ —— 同一
        // 白名单概念两处判定相反。
        const allowedAll = allowList.length === 0 && getConfig().allowAllWhenEmpty === true;
        if (!(allowList.map(String).includes(tId) || allowedAll)) {
          return err(`目标 ${wantTarget} 不在白名单内，不能发送。`);
        }
        const messages = normalizeMessageList(args.messages);
        if (!messages.length) return err('消息内容为空');
        const result = await ctx.sender.sendTextBatch(wantTarget, messages, {});
        ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, to: wantTarget, messageId: s.messageId ?? null })));
        ctx.emit('session-update', ctx.session.id);
        const note = [`已发送到 ${wantTarget}。不要输出汇报。`];
        if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}）`);
        return ok({ sent: result.sent.length, failed: result.failed.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'send_sticker',
    name: '发送表情',
    description: '发送一个 QQ 收藏表情（一张表情单独占一个气泡，不能附带文字；要和文字分成两个气泡时，优先用 send_message 的 stickerId 一起发——两轮发表情会让它晚到，同一次回复里依次调用 send_message、send_sticker 也可以）。stickerId 从 list_stickers 获取。',
    category: 'messaging',
    icon: '😀',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情 id' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
        atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        let sticker = await ctx.stickers.find(unquoteJsonString(args.stickerId));
        if (!sticker) return err(`找不到表情 ${args.stickerId}，请先用 list_stickers 获取有效 id`);
        if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
        // 发送前预检：http 直链（QQ 图床 rkey ~1 小时过期）尽量升级成本地转存，
        // 失败则交给 sender 的三级回退链。本地转存过的条目直通。
        if (typeof ctx.stickers.ensureSendable === 'function') {
          sticker = await ctx.stickers.ensureSendable(sticker);
        }
        // 本地收藏图片（file:/// 路径，收藏时已转存）不走公网 URL 校验，
        // 但必须落在受控的 data/sticker-images/ 目录内 —— 本地库条目若被污染
        // 指向任意本地文件（配置、密钥），不设闸就会被 OneBot 发出去。
        const isLocalFile = String(sticker.url).startsWith('file:///');
        if (isLocalFile) {
          const healed = localStickerPath(sticker.url);
          if (!healed) {
            return err(`表情 ${sticker.id} 的本地图片已丢失（受控收藏目录里找不到它），已拒绝发送`);
          }
          // 搬家自愈：发送用重定位后的受控路径（部署换目录后旧绝对路径已失效）
          sticker.url = `file:///${healed.replace(/\\/g, '/')}`;
        } else {
          try {
            await validateImageUrl(sticker.url);
          } catch (error) {
            return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
          }
        }
        const result = await ctx.sender.sendSticker(ctx.chatKey, sticker, {
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
        ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
        ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), messageId: result?.message_id ?? null });
        ctx.emit('session-update', ctx.session.id);
        return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'list_stickers',
    name: '查看表情库',
    description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。',
    category: 'sticker',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
        limit: { type: 'integer', description: '最多返回条数，默认 24' }
      }
    },
    async execute(ctx, args) {
      try {
        const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
        return ok(result);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'get_sticker_image',
    name: '查看表情图片',
    description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
    category: 'sticker',
    icon: '🖼️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: { stickerId: { type: 'string', description: '表情 id' } },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const sticker = await ctx.stickers.find(args.stickerId);
        if (!sticker) return err(`找不到表情 ${args.stickerId}`);
        if (!sticker.url) return err('该表情没有图片地址');
        const r = await prepareImageResult(sticker.url);
        if (!r.gifVideo && (!r.parts || r.parts.length === 0)) {
          const code = r?.meta?.dropped?.code || 'unknown';
          return err(`表情图片未能安全发送：${code}`);
        }
        const built = getImagePartsOrVideo(`表情 ${sticker.id}（备注：${sticker.desc || '无'}）：`, [r]);
        if (r.gifVideo) {
          built.content[0].text += `\n（这是 GIF 动图，已转成 ${r.gifVideo.frames} 帧、最长边 ${Math.max(r.gifVideo.width, r.gifVideo.height) || '≤480'}px 的视频输入，画面按视频发给模型）`;
        }
        return {
          ...built,
          mediaMeta: {
            sources: 1,
            parts: r.parts?.length || 0,
            tiles: r.meta?.output?.tiles || 0,
            dropped: r.meta?.dropped ? 1 : 0,
            bytesIn: r.meta?.input?.bytes || 0,
            bytesOut: r.meta?.output?.bytes || 0,
            droppedReasons: r.meta?.dropped ? [r.meta.dropped.code] : []
          }
        };
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'sticker_note',
    name: '备注表情',
    description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
    category: 'sticker',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情 id（list_stickers 返回的那个，照抄不要改）' },
        note: { type: 'string', description: '你的理解/含义' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
        usage: { type: 'string', description: '适用场景（可选）' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.stickers.note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
        if (!entry) return err(`找不到表情 ${args.stickerId}`);
        return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'collect_sticker',
    name: '收藏表情',
    description: '收藏别人刚发的表情/图片到你的表情库（偶尔用，收藏前先 get_message_images 看图确认）。需要备注一句简短说明。',
    category: 'sticker',
    icon: '⭐',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
        note: { type: 'string', description: '一句简短备注（帮未来的你识别）' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && (m.url || m.file));
        if (!imageMedia) return err('该消息没有可收藏的图片');
        // collect 会把图片转存到本地（双保险）并**必定入 QQ 收藏**（add_custom_face，
        // 即 QQ"把图片变成表情"的同款能力）；QQ 入库失败会在 warning 里如实标注
        const saved = await ctx.stickers.collect(args.messageId, {
          url: imageMedia.url || '',
          file: imageMedia.file || '',
          note: String(args.note ?? '')
        });
        return ok({
          collected: true,
          id: saved.id,
          note: saved.localNote,
          emojiId: saved.emojiId || '',
          qqSaved: !!saved.emojiId,
          localSaved: !!saved.localFile,
          ...(saved.qqCollectError
            ? { warning: `已${saved.localFile ? '本地收藏' : '记录'}，但入 QQ 收藏失败：${saved.qqCollectError}` }
            : {})
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'send_poke',
    name: '拍一拍',
    description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
    category: 'messaging',
    icon: '👋',
    parameters: {
      type: 'object',
      properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
    },
    async execute(ctx, args) {
      try {
        if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
          return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
        }
        let target = args.targetUserId;
        if (target !== undefined && target !== null && String(target).trim() !== '') {
          target = Number(target);
          if (!Number.isInteger(target) || target <= 0) {
            return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
          }
          await ctx.sender.poke(ctx.chatKey, target);
        } else {
          await ctx.sender.poke(ctx.chatKey, null);
        }
        return ok({ poked: true });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'get_recent_messages',
    name: '查看历史消息',
    description: '按时间倒序往前翻当前会话的历史消息，用于"接着刚才那段继续读"。要定位某句话、某个人说的某件事，用 search_messages；本工具不带筛选条件，只负责连续阅读。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。消息文本出现 [合并转发聊天记录] 时，用 forward-reader__forward_read 展开看内容。',
    category: 'query',
    icon: '📜',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
        offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
      }
    },
    async execute(ctx, args) {
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      const offset = Math.max(0, Number(args.offset) || 0);
      // visibleOnly：撤回 / 拍一拍 / 屏蔽名单的消息不再从这里漏出去
      // （以前提示词里看不到、工具里翻得到，等于绕过全部过滤）
      const skip = offset + (ctx.session.pastStateCount || 0);
      const messages = ctx.store.recent(ctx.chatKey, {
        limit, offset: skip, visibleOnly: true
      });
      // 这一页覆盖了哪段时间、更早还有多少条（2026-11-04）
      // 没有这两个数，模型翻到"能说两条"就停：实测一次会话只覆盖昨天的 18.9%，
      // 却把最后 50 分钟当成"昨天"作答。
      const totalVisible = ctx.store.countVisible(ctx.chatKey);
      const older = Math.max(0, totalVisible - skip - messages.length);
      const oldest = messages[0];
      const newest = messages[messages.length - 1];
      return ok({
        count: messages.length,
        coverage: messages.length ? {
          from: searchTimeText(oldest.ts),
          to: searchTimeText(newest.ts),
          older,
          // 下一页该传什么 offset：用返回条数而不是 limit（末页可能不足）
          nextOffset: older > 0 ? offset + messages.length : null
        } : null,
        hint: messages.length
          ? (older > 0
            ? `这一页是 ${searchTimeText(oldest.ts)} → ${searchTimeText(newest.ts)}，更早还有 ${older} 条；` +
              `继续往前翻用 offset:${offset + messages.length}` +
              (older >= 200 ? '。要看"某一天"的完整内容，改用 search_messages 只给 from/to 按时间列举' : '')
            : `已经翻到头了（${searchTimeText(oldest.ts)} 是可见的最早一条）`)
          // 空页有两种成因，别用同一句话：会话真没历史 vs offset 翻过了最早一条。
          // 后者若也说"没有可翻的历史消息"，模型会以为这个群从没聊过。
          : (totalVisible === 0
            ? '没有可翻的历史消息'
            : `已经翻到最早了：这一页要从第 ${skip + 1} 条开始，但本会话可见消息只有 ${totalVisible} 条；把 offset 调小可回看`),
        messages: messages.map((m) => ({
          messageId: m.mid ?? undefined,
          time: searchTimeText(m.ts),
          // sender 带 QQ 号（与提示词历史同口径）：模型按 id 对齐人，@/拍一拍/记印象才不会指错
          sender: m.self ? '我' : `${m.senderName}${m.senderId ? `(QQ:${m.senderId})` : ''}`,
          senderId: m.self ? undefined : (m.senderId || undefined),
          text: m.text
        }))
      });
    }
  });

  // ── 历史检索（关键词三维检索，2026-11-04）────────────────────────────────
  // 与 get_recent_messages 的分工：那个是"连续阅读"，这个是"定位"。
  // 描述里必须写清这个分工，否则模型仍然只翻不看（历史 6,588 个会话里
  // get_recent_messages 只被调了 140 次 = 3.4%）。
  registerTool({
    id: 'search_messages',
    name: '搜索历史消息',
    description: '定位当前会话的历史消息（比 get_recent_messages 适合找"以前说过的某件事"）：可按关键词、按发送人、按时间，也可组合。keywords 默认多词 AND，放内容词；问"某人说过什么"用 sender；只记得日子就用 from/to。命中过多时会提示收窄，用 offset 可继续翻。',
    category: 'query',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '关键词，1-8 个；中文短语直接给，默认 AND 匹配。专有名词、配置项名、话题词。人名不要放这里，只会命中引用/提到这个名字的消息，要找某人说过什么请用 sender'
        },
        sender: { type: 'string', description: '发送者：QQ 号或昵称/备注名，可只填一部分。问『某人说过什么』时填这里，一次拿全他的发言' },
        from: { type: 'string', description: '起始时间 YYYY-MM-DD HH:mm，可只写 YYYY-MM-DD；也支持 昨天 / 最近3小时' },
        to: { type: 'string', description: '结束时间，同上；不填 = 现在' },
        limit: { type: 'integer', description: '默认 10，最大 30' },
        offset: { type: 'integer', description: '跳过前 N 条命中，用于翻页' },
        context: { type: 'integer', description: '0 或 1；1 = 每条附前后各一条上下文，默认 1' },
        mode: { type: 'string', enum: ['all', 'any'], description: '多关键词关系，默认 all' }
      }
    },
    async execute(ctx, args) {
      try {
        const a = args || {};
        const limit = Math.min(30, Math.max(1, Number(a.limit) || 10));
        const offset = Math.max(0, Number(a.offset) || 0);
        const context = Number(a.context) === 0 ? 0 : 1;
        const mode = a.mode === 'any' ? 'any' : 'all';
        const rawWords = Array.isArray(a.keywords) ? a.keywords : (a.keywords === undefined || a.keywords === null ? [] : [a.keywords]);
        const words = rawWords.map((w) => String(w ?? '').trim()).filter(Boolean).slice(0, 8);

        let from = 0;
        let to = Infinity;
        let fromGiven = false;      // 新增：区分"没给"与"给了但解析失败"
        let toGiven = false;        // 新增
        const notices = [];
        if (a.from !== undefined && a.from !== null && String(a.from).trim() !== '') {
          const v = parseSearchTime(a.from);
          if (v === null) notices.push(`起点时间「${a.from}」无法解析，已忽略`);
          else { from = v; fromGiven = true; }
        }
        if (a.to !== undefined && a.to !== null && String(a.to).trim() !== '') {
          const v = parseSearchTime(a.to, { end: true });
          if (v === null) notices.push(`终点时间「${a.to}」无法解析，已忽略`);
          else { to = v; toGiven = true; }
        }

        // ── 时间词剥离（2026-11-04）──────────────────────────────────────────
        // "昨天"不是内容词，没人会在消息里写它。关键词被时间词占满时，
        // 原来的 AND 检索必然 0 命中（实测：["昨天"] → 0 条；只给 from/to → 284 条）。
        // 这里把它从关键词里摘出来，改走"按时间列举"。
        const droppedWords = words.filter((w) => timeWordRange(w) !== null);
        let effWords = words;
        if (droppedWords.length) {
          const ranges = droppedWords.map((w) => timeWordRange(w)).filter(Boolean);
          if (!fromGiven && !toGiven && ranges.length) {
            // 没给显式时间 → 用时间词推导（多个时间词取最宽的并集）
            from = Math.min(...ranges.map((r) => r.from));
            to = Math.max(...ranges.map((r) => r.to));
          }
          // ⚠️ 只有确实拿到范围时才剥词。否则 words 变空 + 全时间轴
          // = 退化成"全库列举"（实测 words=[] 且无范围 → 整个保留期全量 4926 条）。
          if (from > 0 || to !== Infinity) {
            effWords = words.filter((w) => !droppedWords.includes(w));
            // 只给了 to 没给 from 时不能说"1970 年起"，用开放式表述
            const fromText = from > 0 ? searchTimeText(from) : '最早';
            notices.push(
              `已忽略时间词「${droppedWords.join('、')}」，检索范围 ${fromText}` +
              `${to === Infinity ? ' 至今' : `～${searchTimeText(to)}`}`
            );
          }
        }
        // 纯时间列举：关键词被剥空、但有确定范围
        const pureTime = effWords.length === 0 && (from > 0 || to !== Infinity);

        const res = ctx.store.search(ctx.chatKey, {
          words: effWords, mode, sender: String(a.sender ?? '').trim(), from, to, limit, offset, context
        });
        const total = res.totalHits;
        // 超限只限制"这次返回几条"，不改可翻范围（offset 仍作用于完整命中集）
        // 纯时间列举不走"只看 5 条"：那个封顶是为关键词命中几千条设计的，
        // 而时间列举本来就限定在窄窗口里，回 5 条等于什么都看不到（实测昨天可见 302 条）。
        const cap = pureTime ? Math.min(limit, 30) : (total > 50 ? 5 : limit);
        const page = res.messages.slice(0, cap);

        // 分级提示：0 必须排在 ≤2 前面判（0 也满足 ≤2，顺序反了空结果会拿到"稀疏"）
        let hint = null;
        if (total === 0) hint = '没有命中。可换关键词、放宽时间，或用 get_recent_messages 顺序查看';
        else if (pureTime) {
          // 284 条按 limit 20 要翻 15 页。超过 100 条时明确建议"加词"，
          // 别再让它一页页挪 —— 这是本单唯一不需要新字段就能省的往返。
          hint = `按时间列出 ${total} 条，本次显示 ${page.length} 条；用 offset 翻页`
            + (total > 100 ? '，建议再加一个关键词缩小范围' : '，或加关键词缩小范围');
        }
        else if (total > 50) hint = `命中 ${total} 条，请收窄范围：加时间、指定 sender，或换更具体的词`;
        else if (total <= 2) hint = '结果稀疏，可用 get_recent_messages 看该时段完整上下文';
        if (notices.length) hint = hint ? `${notices.join('；')}。${hint}` : notices.join('；');

        return ok({
          total_hits: total,
          shown: page.length,
          // 纯时间列举时告诉模型这次拿到的是哪个窗口（否则它不知道范围从哪来）
          ...(pureTime ? { range: {
            from: from > 0 ? searchTimeText(from) : '最早',
            to: to === Infinity ? searchTimeText(Date.now()) : searchTimeText(to)
          } } : {}),
          hint,
          messages: page.map((m) => ({
            messageId: m.mid ?? undefined,
            time: searchTimeText(m.ts),
            sender: m.self ? '我' : `${m.senderName}${m.senderId ? `(QQ:${m.senderId})` : ''}`,
            senderId: m.self ? undefined : (m.senderId || undefined),
            text: m.text,
            ...(context ? { before: m.before ?? null, after: m.after ?? null } : {})
          }))
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'read_forward',
    name: '展开转发消息',
    description: '展开查看合并转发的聊天记录。消息文本出现 [合并转发聊天记录] 或 [转发消息 …] 占位符时用。参数填那条转发消息前的 #数字（千万别用方括号里那串长 id，会过期报错）。展开结果会写回存档。若返回的 note 标记“不完整”，请改用 **forward-reader__forward_read** 再展开一次（本工具只展开一层，且不钻嵌套）。',
    category: 'query',
    icon: '📨',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        // 存档里已是展开文本（收消息时已展开/之前展开过）→ 直接给，不再请求 QQ
        // 存档文本是否"不完整"（用于提示模型改用技能工具）。新增形态都在这里登记。
        const FORWARD_INCOMPLETE_RE = /（还有 \d+ 条未展开）|内容太长，后面还有约 \d+ 条没展开|\[合并转发聊天记录\]|\[转发消息|未展开（当前上限|嵌套转发打不开|没有可用的定位 id/;
        if (String(entry.text || '').startsWith('[合并转发 共')) {
          const archived = String(entry.text || '');
          const onlyHead = /^\[合并转发 共\d+条\]\s*$/.test(archived.trim());
          const incomplete = onlyHead || FORWARD_INCOMPLETE_RE.test(archived);
          return ok({
            messageId: entry.mid,
            text: archived,
            note: incomplete
              ? '存档里有一份展开文本，但**不完整**（被截断、只有标题行，或含未展开/打不开的嵌套转发）。需要完整内容时，请改用 **forward-reader__forward_read**（转发阅读技能）再展开一次；本工具 read_forward 只展开一层，别用它代替。'
              : '该转发已完整展开（读的是存档）'
          });
        }
        const r = await ctx.onebot.call('get_forward_msg', { message_id: Number(entry.mid) });
        const nodes = Array.isArray(r?.messages) ? r.messages : [];
        const ex = await expandForwardNodes(nodes);
        if (!ex || !ex.text) return err('协议端没有返回这条转发的内容（可能发送太久已被清理，也可能是协议端读取失败）。如实告诉用户即可，不要编造内容。');
        // 写回存档：一次展开，永久升级这条记录（模型/存档页/金句墙都受益）
        ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: ex.text, appendMedia: ex.media || [] });
        return ok({ messageId: entry.mid, text: ex.text, images: (ex.media || []).length });
      } catch (error) {
        return err(`展开失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'get_active_members',
    name: '查看活跃成员',
    description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
    category: 'query',
    icon: '👥',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
    },
    async execute(ctx, args) {
      const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
      return ok({
        members: members.map((m) => ({
          userId: m.userId,
          name: m.name,
          lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
          recentCount: m.count
        }))
      });
    }
  });

  registerTool({
    id: 'get_chats',
    name: '查看可用会话',
    description: '列出机器人参与的会话（chatKey、名字、最近消息时间）。跨会话发送（send_message 的 targetChatKey）前用它查目标。',
    category: 'query',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 20，最大 50' } }
    },
    async execute(ctx, args) {
      const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
      const chats = ctx.store.listChats()
        .map((key) => ({ key, ...(ctx.store.getChatMeta(key) || {}) }))
        .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
        .slice(0, limit);
      return ok({
        count: chats.length,
        chats: chats.map((c) => ({
          chatKey: c.key,
          lastActive: c.lastTs ? new Date(c.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
          recentText: String(c.lastText || '').slice(0, 30)
        }))
      });
    }
  });

  registerTool({
    id: 'get_message_detail',
    name: '查看消息详情',
    description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
    category: 'query',
    icon: '📄',
    parameters: {
      type: 'object',
      properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
      required: ['messageId']
    },
    async execute(ctx, args) {
      const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
      if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
      return ok({
        messageId: entry.mid,
        time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
        sender: entry.self ? '我' : entry.senderName,
        senderId: entry.senderId,
        text: entry.text,
        reply: entry.reply
      });
    }
  });

  registerTool({
    id: 'get_message_images',
    name: '查看消息图片',
    description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用。id 用聊天记录里每条消息前的 #数字。',
    category: 'query',
    icon: '🖼️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        const urls = (entry.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
        if (!urls.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);

        // ① 逐张准备：results 与 urls 等长，失败项占位 { failed:true }，序号才能对上"第 N 张"
        const results = [];
        for (let i = 0; i < urls.length; i++) {
          try {
            results.push(await prepareImageResult(urls[i], { msgId: args.messageId, imageIndex: i }));
          } catch (e) {
            results.push({ failed: true, index: i, message: String(e?.message ?? e) });
          }
        }
        // 全部下载失败仍走 err（早于裁预算与统计）
        if (urls.length && results.every((r) => r.failed)) {
          return err(`图片获取失败：${results.map((r) => r.message).filter(Boolean).join('；')}`);
        }

        // ② 总媒体预算：标记而不是 splice；求和必须跳过已 removed，
        //   否则 while 条件恒真，会一路删到 victim 为 undefined（多删变成全删）。
        const usedBytes = (list) => list.reduce((n, r) => n + (r.removed ? 0 : (r?.meta?.output?.bytes || 0)), 0);
        while (usedBytes(results) > IMAGE_LIMITS.maxTotalMediaBytes) {
          const victim = results
            .filter((r) => !r.failed && !r.removed && r?.meta?.output)
            .sort((a, b) => (b.meta.output.bytes || 0) - (a.meta.output.bytes || 0))[0];
          if (!victim) break;
          victim.removed = true;
          victim.removeCode = 'total_media_budget';
        }

        // ③ 统计（②完成后的结果）
        const okResults = results.filter((r) => !r.failed && !r.removed);
        const sources = results.length;
        const partsCount = okResults.reduce((n, r) => n + (r?.parts?.length || 0), 0);
        const videoCount = okResults.filter((r) => r?.gifVideo).length;
        const droppedItems = results
          .map((r, i) => (
            r.failed ? { index: i, code: 'download_failed' }
            : r.removed ? { index: i, code: r.removeCode || 'total_media_budget' }
            : (r?.meta?.dropped ? { index: i, code: r.meta.dropped.code } : null)
          ))
          .filter(Boolean);
        const dropped = droppedItems.length;
        const droppedReasons = droppedItems.map((d) => d.code);
        const failedCount = results.filter((r) => r.failed).length;
        const note = failedCount ? `（另有 ${failedCount} 张获取失败）` : '';
        // 只数"真的产出了部件"的原图；一张切片图有多个 parts，但仍算 1 张（按结果项计数）。
        const okImageCount = okResults.filter(
          (r) => !r?.gifVideo && Array.isArray(r?.parts) && r.parts.length > 0
        ).length;
        // 切片图单独用「长图（N 块）」文案：一张切 4 块仍是 1 张图，不能算成 4 张。
        const tiledResults = okResults.filter(
          (r) => !r?.gifVideo && (r?.meta?.output?.tiles || 0) > 1
        );
        const plainImageCount = okImageCount - tiledResults.length;
        const tileLines = tiledResults.map((r) => {
          const o = r.meta.output;
          const vertical = (o.height || 0) >= (o.width || 0);   // 竖图沿高度切 → 从上到下
          return `1 张长图（已按${vertical ? '从上到下' : '从左到右'}切成 ${o.tiles} 块，块间至少 ${IMAGE_LIMITS.tileOverlap}px 重叠；请按顺序理解）`;
        });
        const what = [
          plainImageCount ? `${plainImageCount} 张图片` : '',
          ...tileLines,
          videoCount ? `${videoCount} 段视频（由 GIF 动图转换，≤480px/≤24帧）` : ''
        ].filter(Boolean).join(' + ') || '没有可发送的图片';
        const omitted = results
          .map((r, i) => {
            if (r.failed) return '';
            const code = r.removed ? (r.removeCode || 'total_media_budget') : r?.meta?.dropped?.code;
            if (!code) return '';
            const idx = Number.isInteger(r?.meta?.imageIndex) ? r.meta.imageIndex : i;
            return `（第 ${idx + 1} 张图片未能安全发送：${code}；请勿猜测其内容）`;
          })
          .join('');

        // ④ buildMediaMeta
        const buildMediaMeta = () => ({
          sources,
          parts: partsCount,
          tiles: okResults.reduce((n, r) => n + (r?.meta?.output?.tiles || 0), 0),
          dropped,
          bytesIn: okResults.reduce((n, r) => n + (r?.meta?.input?.bytes || 0), 0),
          bytesOut: okResults.reduce((n, r) => n + (r?.meta?.output?.bytes || 0), 0),
          droppedReasons
        });

        // ⑤ built
        const text = `消息 ${args.messageId} 的内容${note}：${what}。${omitted}`;
        const built = getImagePartsOrVideo(text, results);
        // ⑥ mediaMeta 必须真的挂到返回对象上（不写这一行，日志与统计会静默失效）
        return { ...built, mediaMeta: buildMediaMeta() };
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'read_voice',
    name: '重读语音',
    description: '重试转写一条语音消息（本地语音识别）。消息文本出现 [语音] 或 [语音·转写失败:...] 时可用——首次转写失败后，用这个工具把那条语音再识别一次。id 用聊天记录里每条消息前的 #数字。',
    category: 'query',
    icon: '🎤',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: { messageId: { type: ['integer', 'string'], description: '那条语音消息的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        const rec = (entry.media || []).find((m) => m.kind === 'record' && (m.file || m.url));
        if (!rec) return err(`消息 ${args.messageId} 没有可重读的语音（media 里没有 record 段）。`);
        if (!ctx.onebot) return err('语音识别需要 OneBot 客户端，当前不可用。');

        // 复用 ingest 的转写通道：media 里存了 record 段（file/url），
        // materializeAudio 会走 get_record 取音频，再交给 media-audio 转写。
        const r = await transcribeVoice({ file: rec.file, url: rec.url }, ctx.onebot);

        // 成功且有文本 → 计一次音频识别；ok 但空文本 = 确实没人声，不计数。
        if (r?.ok && r.text) { try { recordAudio({ chatKey: ctx.chatKey }); } catch { /* 统计失败不影响 */ } }

        // 回填：转写成功就把文本写回这条消息，让下一次运行时不再显示 [语音]。
        if (r?.ok && r.text) {
          try {
            ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: `[语音转文字] ${r.text}` });
          } catch { /* 回填失败不影响本次返回 */ }
        }

        // 占位符复用同一套文案：模型看到的和 ingest 时完全一致，不会出现两套说法。
        return ok(voicePlaceholder(r));
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'memory_append',
    name: '记录印象',
    description: '记一条对群友的长期印象（先记入待定池，系统整理后才会进入【记忆】）。只记"以后和这个人打交道时用得上"的稳定印象：他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题、别踩的坑。太临时的事情不要记。userId 必须填对方的 QQ 号（不知道就先调 get_active_members / get_recent_messages 查）；target 填备注名/群名片/昵称，用于展示。来源标记：群友明确要求你记住某件事时填 kind=user_request；你自己判断值得记的填 model_proposal（默认）。注意：这只是标记来源，不代表必须记录——系统仍会统一裁决，可能丢弃。',
    category: 'memory',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['memberImpression'], description: '记忆分类（目前只支持 memberImpression = 群友印象）' },
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（数字）' },
        target: { type: 'string', description: '对方名字（备注名/群名片/昵称）' },
        content: { type: 'string', description: '印象内容（≤120字，稳定、可跨多次聊天使用）' },
        kind: {
          type: 'string', enum: ['user_request', 'model_proposal'],
          description: '来源标记：群友明确说"你记住"时填 user_request，你自己觉得值得记就留空（默认 model_proposal）。只是来源标签，不保证被采纳。'
        }
      },
      required: ['category', 'userId', 'content']
    },
    async execute(ctx, args) {
      const userId = String(args.userId ?? '').trim();
      if (!/^\d{1,15}$/.test(userId)) {
        return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。先用 get_active_members 查准确 QQ 号再记。`);
      }
      const content = String(args.content ?? '').trim();
      if (!content) return err('content 不能为空。');

      // 第 2 期 §3.1：写入降级为候选池，**不再直接进 L1**。
      // 理由见施工单 §2.3：对话里的「你记住」多数是玩笑，让它即时生效等于让玩笑
      // 决定画像。候选池 pending 不注入、不可检索，由提炼阶段统一裁决。
      const ts = Date.now();
      // 工具层拿不到「触发本次运行的那条消息 id」，用当前最后一条群友发言近似 ——
      // 提炼时按 ts ± 窗口回看上下文，精度够用；留空会让 msgId 永远是空串。
      let msgId = '';
      try {
        const last = ctx.store?.recent?.(ctx.chatKey, { limit: 1, includeSelf: false }) || [];
        msgId = String(last[last.length - 1]?.mid || '');
      } catch { /* 取不到就留空，不影响记账 */ }

      const row = makeCandidateRow({
        entryId: `cand_${ts}_${Math.random().toString(36).slice(2, 7)}`,
        kind: String(args.kind || 'model_proposal'),
        fromUserId: userId,
        msgId,
        text: content,
        ts,
        status: 'pending'
      });
      try {
        appendCandidate(ctx.chatKey, row);
      } catch (error) {
        return err(`候选池写入失败：${error?.message ?? error}`);
      }
      // 回给模型的话必须诚实：它记了，但没生效。若说「已记住」，模型下一轮会
      // 据此对群友重复这个印象，而那时它其实还不可检索。
      return ok({
        saved: true, pending: true, entryId: row.entryId, kind: row.kind,
        note: '已记入待定池，系统整理后才会进入【记忆】；现在检索不到这条。'
      });
    }
  });

  registerTool({
    id: 'report_feedback',
    name: '反馈问题',
    description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
    category: 'system',
    icon: '📢',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'warning', 'error'], description: '反馈等级：info=提示 / warning=警告 / error=出错' },
        message: { type: 'string', description: '反馈内容（一句话说清哪里有问题）' }
      },
      required: ['message']
    },
    async execute(ctx, args) {
      const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
      ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
      ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
      return ok({ reported: true });
    }
  });

  registerTool({
    id: 'web_search',
    name: '联网搜索',
    description: '联网搜索（Bing），返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
    category: 'web',
    icon: '🔍',
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索词' } },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const result = await webSearch(String(args.query ?? ''));
        if (!result.results.length) {
          return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
        }
        return ok(result);
      } catch (error) {
        return err(`搜索失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'web_fetch',
    name: '抓取网页',
    description: '只读抓取网页正文（≤2 万字符）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。禁止访问内网/本机地址。',
    category: 'web',
    icon: '📄',
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
      required: ['url']
    },
    async execute(ctx, args) {
      try {
        // 浏览锁定开启时逐跳校验白名单（与 send_image/search_images 同一口径；
        // 曾经漏传导致锁定形同虚设）
        const result = await webFetch(String(args.url ?? ''), { browseLocked: browseLockState().enabled });
        const body = String(result.body || '');
        return ok({
          url: result.url,
          statusCode: result.statusCode,
          truncated: result.truncated || body.length > 20000,
          content: body.slice(0, 20000)
        });
      } catch (error) {
        return err(`抓取失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'finish',
    name: '结束会话',
    description: '明确结束本次处理。一般来说**不需要调用它**：发完消息、话说完就自然结束，不必再调 finish 专门收尾；决定不说话时，直接不调任何工具结束即可（不会发出任何内容，这是正常选项，不是失职）。**要说的话必须走 send_message 发出去——写在正文里不会发到 QQ**，rescue 也不会替你补发。只有在需要给管理端留一句收尾理由、或处于活跃期要判断话题结束时才用它（summary 写一句给自己看的理由；话题结束填"话题结束"）。处于活跃期时，若判断话题已结束/偏离，也用它结束（reason 填"话题结束"）。',
    category: 'system',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）。活跃期判断话题结束时填"话题结束"' },
        activeTopic: { type: 'string', description: '开启活跃期时才填：用一句话概括当前聊天的话题大方向（15字内，如"周末去哪玩"）。仅在【活跃模式】未激活、而这次对话确实值得你持续参与时填写；平时不要填。' }
      },
      required: ['summary']
    },
    async execute(ctx, args) {
      ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
      // 活跃模式（chatActive）：模型在 finish 时带回话题总结。
      // orchestrator 读取 session.activeTopic 决定是否开启/维持活跃期。
      const topic = String(args.activeTopic ?? '').trim();
      if (topic) ctx.session.activeTopic = topic.slice(0, 60);
      return ok({ finished: true });
    }
  });

  // ── 提醒（闹钟/计时）──
  registerTool({
    id: 'set_reminder',
    name: '设置提醒',
    description: '设置一个定时提醒（闹钟）。到点后机器人会在当前群里主动发一条提醒消息。适用：群友说"X分钟后提醒我"、"明天早上叫我"、"X点提醒我吃饭"。delayMinutes（多少分钟后）和 atTime（具体时间，如"18:30"或"2026-09-12 08:00"）二选一。',
    category: 'system',
    icon: '⏰',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容（到点要发的话，如"该吃饭了"、"你让提醒你的：开会"）' },
        delayMinutes: { type: 'number', description: '多少分钟后提醒（与 atTime 二选一）' },
        atTime: { type: 'string', description: '具体时间提醒，格式 "HH:MM"（今天/明天）或 "YYYY-MM-DD HH:MM"（与 delayMinutes 二选一）' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args.text ?? '').trim();
      if (!text) return err('提醒内容为空');
      let dueAt = null;
      if (args.delayMinutes != null && Number(args.delayMinutes) > 0) {
        dueAt = Date.now() + Number(args.delayMinutes) * 60000;
      } else if (args.atTime) {
        dueAt = parseAtTime(String(args.atTime));
        if (!dueAt) return err('时间格式不对：用 "HH:MM"（如 18:30）或 "YYYY-MM-DD HH:MM"');
        if (dueAt <= Date.now()) return err('这个时间已经过了，请给个未来的时间');
      } else {
        return err('请提供 delayMinutes（多少分钟后）或 atTime（具体时间）之一');
      }
      if (!ctx.reminders) return err('提醒服务未启用');
      const entry = ctx.reminders.add({ chatKey: ctx.chatKey, text, dueAt, createdBy: String(ctx.selfId || '') });
      const when = new Date(dueAt);
      const whenStr = `${when.getMonth() + 1}月${when.getDate()}日 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      return ok({ set: true, id: entry.id, dueAt, note: `已设置提醒：${whenStr} 到点我会在本群说「${text}」。` });
    }
  });

  registerTool({
    id: 'list_reminders',
    name: '查看提醒',
    description: '查看当前会话里还没触发的所有提醒（闹钟）。适用：群友问"我设了什么提醒"、"还有哪些闹钟"。',
    category: 'system',
    icon: '📋',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      if (!ctx.reminders) return err('提醒服务未启用');
      const list = ctx.reminders.pending(ctx.chatKey);
      if (!list.length) return ok({ count: 0, note: '当前没有待触发的提醒。' });
      const lines = list.map((r) => {
        const d = new Date(r.dueAt);
        const whenStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `- [${r.id}] ${whenStr}：${r.text}`;
      });
      return ok({ count: list.length, reminders: lines.join('\n') });
    }
  });

  registerTool({
    id: 'cancel_reminder',
    name: '取消提醒',
    description: '取消一个还没触发的提醒（闹钟）。id 从 list_reminders 获取。适用：群友说"取消那个提醒"、"别提醒我了"。',
    category: 'system',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要取消的提醒 id（list_reminders 里 [r_xxx] 那个）' } },
      required: ['id']
    },
    async execute(ctx, args) {
      if (!ctx.reminders) return err('提醒服务未启用');
      const id = String(args.id ?? '').trim();
      if (!id) return err('请提供提醒 id');
      const ok_ = ctx.reminders.cancel(id);
      return ok_ ? ok({ cancelled: true, id }) : err(`没找到提醒 ${id}（可能已触发或 id 不对，用 list_reminders 查一下）`);
    }
  });

  // ── 节假日问候 ──
  registerTool({
    id: 'check_holiday',
    name: '查询节日',
    description: '查询今天或最近有什么节日（春节/中秋/端午/元旦/国庆等中国法定与常见节日）。用于在节日时主动向群友送上问候。适用：想知道"今天是什么节日"、"最近有什么节日可以蹭个祝福"。返回节日名称与一句参考祝福语，你可以据此自然发挥（别照抄）。',
    category: 'system',
    icon: '🎉',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '往后查几天内的最近节日（默认 7 天；0 表示只查今天）' }
      }
    },
    async execute(ctx, args) {
      const today = holidayOn(new Date());
      const days = args.days != null ? Math.max(0, Number(args.days) || 0) : 7;
      const upcoming = upcomingHoliday(days);
      const out = {
        today: today ? { name: today.name, greeting: today.greeting, type: today.type } : null,
        upcoming: upcoming ? { name: upcoming.name, date: upcoming.date, daysAway: upcoming.daysAway, greeting: upcoming.greeting } : null
      };
      let note;
      if (today) {
        note = `今天是${today.name}！可以自然地送上祝福（参考：${today.greeting}）。`;
      } else if (upcoming) {
        note = upcoming.daysAway === 0
          ? `今天是${upcoming.name}。`
          : `今天不是节日。最近的是 ${upcoming.daysAway} 天后的${upcoming.name}（${upcoming.date}）。`;
      } else {
        note = `今天不是节日，未来 ${days} 天内也没有常见节日。`;
      }
      return ok({ ...out, note });
    }
  });

  // ── 发网图（send_image / search_images）────────────────────────────────
  //
  // 补的是一个明显缺口：此前机器人只能发 QQ 收藏的表情（send_sticker），
  // **无法主动发一张网上找的图**。
  //
  // 安全校验：预览确认、字节魔数校验、safe-fetch（SSRF 防护 + 限量 + 浏览锁定）。
  registerTool({
    id: 'send_image',
    name: '发送网图',
    description: '把一张网上找到的图片发到当前聊天。默认需要先预览确认（send_image(url, preview=true) 看一眼，再 send_image(url) 发出）。只支持 png/jpg/gif/webp 直链；网页地址不是图片。',
    category: 'media',
    icon: '🖼️',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片直链（要整条照抄，不要改动路径字符）' },
        preview: { type: 'boolean', description: 'true = 先只给自己看一眼、不发送' },
        note: { type: 'string', description: '可选：配一句话一起发' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：引用某条消息的 id' },
        atUserId: { type: ['integer', 'string'], description: '可选：@ 某人（填 QQ 号）' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      try {
        const cfg = getConfig();
        const opt = cfg.security?.imageSend || {};

        const url = String(args.url ?? '').trim();
        if (!url) return err('url 不能为空');
        if (!/^https?:\/\//i.test(url)) {
          return err('只支持 http(s) 图片直链。本地文件路径不能发（那会暴露宿主文件系统）。');
        }
        // 每次运行的状态挂在 ctx 上（ctx 每次运行新建，天然隔离、不用持久化）
        ctx.sendImageState = ctx.sendImageState || { previewed: [], previews: 0, sent: 0 };
        const st = ctx.sendImageState;

        const isPreview = args.preview === true;
        const lock = cfg.security?.browseLock || {};
        // 浏览锁定站点内的图可跳过预览：站内图源可信，省一轮
        const lockCheck = checkBrowseLock(url, browseLockState());
        const trusted = lockCheck.enabled && lockCheck.allowed && opt.skipPreviewForLockedHosts !== false;

        if (!isPreview) {
          if (opt.requirePreview !== false && !trusted && !st.previewed.includes(url)) {
            return err('发图前要先看一眼：先调 send_image(url, preview=true) 确认这张图合适，再调 send_image(url) 发送。');
          }
          if (st.sent >= Math.max(1, Number(opt.maxPerRun) || 3)) {
            return err(`本次运行已经发了 ${st.sent} 张图，达到上限（设置里可调）。`);
          }
        } else if (st.previews >= Math.max(1, Number(opt.maxPreviewsPerRun) || 5)) {
          return err(`本次运行预览次数已达上限（${st.previews} 次）。挑最有把握的一张直接发。`);
        }

        // 下载：safe-fetch 全套防护（DNS 固定、逐跳校验、限量、浏览锁定）
        const maxBytes = Math.max(1, Number(opt.maxBytesMB) || 5) * 1024 * 1024;
        let buffer;
        let contentType;
        try {
          ({ buffer, contentType } = await safeFetchBinary(url, maxBytes, { browseLocked: !!lock.enabled }));
        } catch (error) {
          const msg = String(error?.message ?? error);
          // 404 多半是模型抄 URL 时手抖（实测把 /2026/04/xx.jpg 抄成 /2026-04-xx.jpg），
          // 提醒它原样复制，别自己"修复"路径
          const hint = /HTTP 404/.test(msg)
            ? '（地址可能抄错了：请从 web_fetch / search_images 返回的 images 里原样复制，不要改动路径字符；也可能是图已删除）'
            : '';
          return err(`图片下载失败：${msg}${hint}`);
        }
        if (!buffer || !buffer.length) return err('图片内容为空');

        // 魔数校验：只认能直接喂给模型的安全格式。很多"图片链接"其实返回 HTML（防盗链页/错误页）。
        // image-type.js 扩容后会返回 image/bmp / image/tiff / image/heic，而 send_image 的语义
        // 仍是"只认 png/jpg/gif/webp"，所以这里必须套显式白名单，不能跟着扩容一起放开。
        const t = detectImageType(buffer);
        const mime = t && SEND_IMAGE_MIMES.has(t.mime) ? t.mime : null;
        if (!mime) {
          const head = buffer.subarray(0, 200).toString('utf8').trim().toLowerCase();
          if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
            return err('这个地址返回的是网页（HTML），不是图片直链。先用 web_fetch 抓那页，再从它返回的 images 里挑一条直链。');
          }
          return err(`这个地址返回的不是图片（Content-Type: ${contentType || '未知'}）。只支持 png/jpg/gif/webp 直链。`);
        }

        const b64 = buffer.toString('base64');
        if (isPreview) {
          st.previews += 1;
          if (!st.previewed.includes(url)) st.previewed.push(url);
          // 问图片格式兼容 Skill：这种格式能不能喂给当前模型。
          // webp/avif 在部分本地视觉接口会直接 400，那会把整轮打挂 ——
          // 比"这轮看不到图"严重得多，所以改成字节校验后让模型自己决定发不发。
          let supported = true;
          try {
            for (const p of skillManager.getCapabilityProviders('image.mime-support', {})) {
              const r = p.fn({ mime });
              if (r && r.supported === false) supported = false;
              break;
            }
          } catch { /* 能力坏了不影响预览 */ }

          if (!supported) {
            return ok(`这张图是 ${mime}（约 ${Math.round(buffer.length / 1024)}KB）。当前视觉接口不支持 ${mime}，看不到画面内容，但字节已校验过是真图、QQ 里能正常显示。你觉得合适就直接调 send_image(url) 发出去（URL 照抄：${url}）。`);
          }
          return { content: imageParts(`这张图（${mime}，约 ${Math.round(buffer.length / 1024)}KB）——觉得合适就立刻调 send_image(url) 发出去：`, [`data:${mime};base64,${b64}`]) };
        }

        // 传 url 而不是只传 base64：OneBot 的 image 段原生支持 http 直链，让**协议端
        // 自己去下载**，body 从 MB 级降到几十字节。而 base64 内联走 HTTP body 时，
        // 5MB 的图（本工具 maxBytesMB 默认值）base64 后 6.7MB，很容易撞上发送超时 ——
        // 这正是"图画出来了但发不出去"的同一个根因。
        // `url` 是刚经 safe-fetch 校验并成功下载过的地址，交给协议端取是安全的。
        // 保留 dataUrl 作为回退：协议端取不到时（防盗链 / 协议端在别的机器）自动改用 base64。
        const result = await ctx.sender.sendImage(ctx.chatKey, { url, dataUrl: `base64://${b64}` }, {
          note: args.note,
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
        st.sent += 1;
        ctx.session.sent.push({
          type: 'image',
          text: `[图片${args.note ? `:${String(args.note).slice(0, 40)}` : ''}]`,
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        ctx.emit('session-update', ctx.session.id);
        return ok({ sent: true, messageId: result?.message_id ?? null, note: '图片已发送。' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'search_images',
    name: '搜索网图',
    description: '搜网图，直接拿到"能发的图片直链"。用法：先 search_images("关键词") 看列表，再挑一条用 send_image(url) 发出去。被要求"发张图/来点表情/找张照片"时用它。',
    category: 'web',
    icon: '🔎',
    requiresVision: false,
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（越具体越准）' },
        limit: { type: 'integer', description: '最多返回几条，默认 8' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const cfg = getConfig();
        const query = String(args.query ?? '').trim();
        if (!query) return err('query 不能为空');
        const limit = Math.min(12, Math.max(1, Number(args.limit) || 8));

        // 动态取图搜能力：特性检测，避免 web-search 缺这个函数时整个注册就崩
        let searchImages = null;
        try {
          const mod = await import('./web-search.js');
          searchImages = typeof mod.searchImages === 'function' ? mod.searchImages : null;
        } catch { /* 下面统一报错 */ }
        if (!searchImages) {
          return err('图搜能力不可用（web-search 里没有 searchImages）。请用 web_search 找图片页面，再用 web_fetch 拿 images。');
        }

        const list = await searchImages(query, { limit, browseLocked: browseLockState().enabled });
        if (!Array.isArray(list) || !list.length) {
          return ok({ query, results: [], note: '没搜到图。换个更具体的关键词再试一次（最多搜 3 次）。' });
        }
        return ok({
          query,
          results: list.slice(0, limit).map((r) => ({ title: String(r?.title ?? '').slice(0, 60), url: String(r?.url ?? '') })),
          note: '挑一条用 send_image(url) 发出去；url 要整条照抄，不要改。都不贴切就换个更具体的词再搜一次（最多搜 3 次）。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── 视频读取 ──
  registerTool({
    id: 'read_video',
    name: '读取视频',
    description: '读取消息里的视频。会返回时长/分辨率等元信息，并根据设置页的「视频模式」把画面交给模型：原生视频输入（全模态模型）或抽帧截图（普通视觉模型）。适用：群友发了一个视频，你想"看看"里面是什么。需要消息 id（聊天记录里的 #数字）。',
    category: 'query',
    icon: '🎬',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '那条带视频的消息的 QQ 消息 id（聊天记录里的 #数字）' },
        frames: { type: ['integer', 'string'], description: '可选：本次要抽几帧（1~12）。不传用设置页的默认值。' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        const videoMedia = (entry.media || []).find((m) => m.kind === 'video');
        if (!videoMedia) return err('该消息没有视频（媒体里没有 video 段）');
        if (!ctx.videoReader) return err('视频读取服务未启用');
        const info = await ctx.videoReader.probe(videoMedia, { count: Number(args.frames) || 0 });

        // 行为统计：读视频单独计"识别视频"，不再混进"识图"。
        //
        // ⚠️ 必须判 route：probe() 在「取不到文件 / 抽帧失败」时**不抛异常**，
        //    而是返回 route='meta' + failure（见 video-reader 的 320-326 / 381-386）。
        //    那种情况模型一帧都没看到，记一次"识别视频"会让面板虚高且验收看不出来。
        //    音频独立判：音轨转写不依赖画面路线，route=meta 时也可能拿到了文本。
        try {
          const sawFrames = info.route === 'frames' || info.route === 'native';
          if (sawFrames && !info.failure) recordVideo({ chatKey: ctx.chatKey });
          if (info.audio?.ok === true) {
            recordAudio({ chatKey: ctx.chatKey });
            // 单次会话弹窗要看「音频识别」：顺带记到 session 层。
            // session.behavior 可能还没建（orchestrator 在工具返回后才初始化），这里自建。
            if (ctx.session) {
              ctx.session.behavior = ctx.session.behavior || { visionCalls: 0, thinkingCalls: 0 };
              ctx.session.behavior.audioCalls = (ctx.session.behavior.audioCalls || 0) + 1;
            }
          }
        } catch { /* 统计失败不影响读视频 */ }

        // 元信息（不含画面）单独作为文本返回。
        // ⚠️ 必须把画面字段剥掉再序列化：
        //    以前是把 frameDataUrl（base64 图片）直接塞进这个 JSON 字符串，
        //    结果整张图被当成**文本**送进上下文 —— 模型既看不到图，
        //    又要为几十万 token 的 base64 付钱。画面一律走下面的 parts。
        const isSheet = Array.isArray(info.cells) && info.cells.length > 0;
        const metaOut = {
          messageId: entry.mid,
          durationSec: info.durationSec,
          width: info.width,
          height: info.height,
          sizeBytes: info.sizeBytes,
          format: info.format,
          route: info.route,
          routeReason: info.routeReason,
          frameCount: isSheet ? info.cells.length : (Array.isArray(info.frames) ? info.frames.length : 0),
          // 分镜图用 cells（格号↔时刻）替代 frameTimes：同一串时间点不发两遍
          ...(isSheet
            ? { grid: info.grid || null, cells: info.cells }
            : { frameTimes: info.frameTimes }),
          // 让模型能判断"全看完了还是只看到一部分"：只给 route/routeReason 两句自由文本，
          // 它没法如实说"我只看了前 20 分钟"。
          truncated: info.truncated === true,
          failure: info.failure || null,
          coverage: info.coverage || null,
          note: info.note || '已读取视频信息。'
        };
        // 音轨观测：lang / chars 是"到底有没有人声"的原始依据，值得如实透出。
        // event 故意**不**放进来 —— 它是"主导音频事件"，对白叠一层配乐就会被判成
        // BGM，模型拿到会反推"这是音乐、所以没人说话"，这个误判已经发生过一次。
        // 它只落日志（见 video-reader 的「音轨转写」那条），要查去日志页签看。
        const audioMeta = summarizeAudio(info.audio);
        if (audioMeta) metaOut.audio = audioMeta;
        const metaText = JSON.stringify(metaOut, null, 1);

        // 原生视频输入：把视频地址作为 video 部分交给模型（由 llm.js 换成 videoModel）
        if (info.route === 'native' && info.nativeUrl) {
          return {
            content: [
              { type: 'text', text: `${metaText}\n\n（画面已作为视频输入发送）` },
              { type: 'video_url', video_url: { url: info.nativeUrl } }
            ]
          };
        }

        // 抽帧：分镜图是 1 张、均匀抽帧是 N 张，两种都走同一段组装
        if (info.route === 'frames' && Array.isArray(info.frames) && info.frames.length) {
          const lead = Array.isArray(info.cells) && info.cells.length
            ? `（以下 1 张分镜图，共 ${info.cells.length} 格；格号见 cells 字段）`
            : `（以下 ${info.frames.length} 张是抽帧截图，不是连续视频）`;
          return {
            content: [
              { type: 'text', text: `${metaText}\n\n${lead}` },
              ...info.frames.map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
          };
        }

        // 只给元信息（off / 抽帧不可用 / 全模态模型没配）
        return ok(metaOut);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });
}

/**
 * 音轨观测字段：只取结构性信息，**不含原文**——原文由 note 里那句转写负责，
 * 这里再放一份只会让同一段话在上下文里出现两次。
 * 返回 null 表示"插件没参与"（没装 / 被关），调用方据此不加这个字段：
 * 没装插件时 read_video 的返回必须与接入前完全一致，回滚才彻底。
 */
function summarizeAudio(audio) {
  if (!audio || audio.silent) return null;
  if (audio.ok !== true) {
    return { ok: false, code: String(audio.code || ''), error: String(audio.error || '').slice(0, 200) };
  }
  return {
    ok: true,
    lang: String(audio.lang || ''),
    // 与 #audioLine 同一个口径（去掉空白和标点）：只有「お！」这种一两个字符的量，
    // 才看得出"整段音轨其实只蹦出一个字"，光看 text 长度会被标点骗过去。
    chars: String(audio.text || '').replace(/[\s\p{P}]/gu, '').length,
    // 是否走了「整段吞掉人声 → 切 3 秒段重识别」的兜底。模型据此知道
    // 时间轴是分段拼的、个别段可能是误识，不必把每个词都当真。
    segmented: audio.segmented === true,
    truncated: audio.truncated === true,
    tookMs: Number(audio.tookMs) || 0
  };
}

/** 解析 "HH:MM" 或 "YYYY-MM-DD HH:MM" 为时间戳；解析不了返回 null。 */
function parseAtTime(raw) {
  const s = String(raw || '').trim();
  // YYYY-MM-DD HH:MM；严格校验边界，避免 Date 把 2 月 31 日归一化成 3 月 3 日
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const hour = Number(m[4]), minute = Number(m[5]);
    const d = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (month < 1 || month > 12 || hour > 23 || minute > 59
      || d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
      || d.getHours() !== hour || d.getMinutes() !== minute) return null;
    return d.getTime();
  }
  // HH:MM（今天；若已过则明天）
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = Number(m[1]), minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   // 今天已过 → 明天
    return d.getTime();
  }
  return null;
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.id || d.name,   // 优先用 id（英文标识），兼容旧版 name 字段
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  // 兼容：name 可能是 id（英文）或 name（中文显示名）
  const def = defs.find((d) => d.id === name || d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
