// 水聊免回（chatter-guard）：连着发表情包 / 一直说水话的时候，就不接了。
//
// 使用者要求（2026-10-07）："如果连续对话对方一直在发表情包或者说垃圾话就不用回了"。
//
// ── 为什么拦在入口（onIncoming）而不是靠提示词 ────────────────────────────
// 在入站处直接不触发会话 = **0 token** ✓ 模型根本不会被叫醒。
// 靠提示词则每次都要花一轮上下文（约 1.7 万 token）才决定"不回" ✗ 又贵又偶尔手滑。
//
// 挂载方式与 `nsfw-guard` / `repeat-echo` 同款：包一层 `Orchestrator.prototype.onIncoming`，
// 命中就"标已读 + 通知界面 + **不调用原方法**" —— 原方法一跑就会按档位判定甚至排唤醒，
// 那就挡不住了。补丁放在原型上并用 Symbol 记着，热重载只换判定函数、不会包两层 ✓
//
// ── 判定的克制之处 ────────────────────────────────────────────────────────
// **没有**采用"字数太少就算水"这种规则 —— 那会把「在吗」「谢谢」「几点」一起误伤 ✗
// 只认三类明确的水：
//   ① 只有表情/图片/卡片，没有一个字
//   ② 命中内置水词表（哈哈、草、6、?、。。。、笑死…）
//   ③ 同一个字重复（哈哈哈哈）或全是标点（？？？）
//   ④ 连续戳一戳（同一人 3 分钟内戳 3 次；与表情/水话共用连续计数）
// 判定前先把渲染进正文的 @ 片段剔掉：「@机器人 [图片]」算纯媒体；
// 但**只有 @、没有别的内容**仍是召唤，不算水（避免连点两下 @ 被当成刷屏）。
// 而且必须**连着** N 条、且在时间窗内 —— 中间插一句正常话就重新计数 ✓
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；配置在 data/config.json 不受影响。

import { Orchestrator } from '../../src/orchestrator.js';
import { logger } from '../../src/logger.js';
import { getConfig } from '../../src/config.js';

const PLUGIN_ID = 'chatter-guard';
const PATCH_KEY = Symbol.for('qq-agent.chatter-guard.patch');

/** 内置水词表（纯水、没有信息量的）。刻意**不含**「在吗」「谢谢」「好的」这类需要回应的。 */
const DEFAULT_FILLERS = [
  '哈哈', '哈哈哈', '哈哈哈哈', '嘿嘿', '嘻嘻', '呵呵', '噗', '草', '卧槽', '我草',
  '6', '666', '牛', '牛啊', '秀', '好活', '绝了', '笑死', '笑死我', '绷', '乐',
  'emmm', 'emm', '呃', '嗯', '啊这', '这', '?', '？', '。。。', '...', '……',
  '233', 'hhh', 'hhhh', 'xd', 'ojbk', '彳亍', '行吧', 'ok', 'OK',
];

let api = null;
const stats = { suppressed: 0, today: 0, day: '', byReason: {}, lastReason: '', lastAt: 0, lastChat: '' };
/** `${chatKey}|${senderId}` → { count, at } */
const streaks = new Map();
const MAX_STREAK_KEYS = 600;

function settings() { return api?.config?.() || {}; }

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 日切重置；返回今日已免回条数。只作展示，不参与判定。 */
function todayCount() {
  const day = todayKey();
  if (stats.day !== day) { stats.day = day; stats.today = 0; stats.byReason = {}; }
  return stats.today;
}

function noteSuppressed(hit, chatKey) {
  todayCount();
  stats.suppressed += 1;
  stats.today += 1;
  const reason = String(hit.reason || '未知');
  stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
  stats.lastReason = `${hit.reason}（连着第 ${hit.count} 条）`;
  stats.lastChat = chatKey;
  stats.lastAt = Date.now();
  // 每 10 条汇总一次：日志面板能直接看到今天的免回量，不必翻每条明细
  if (stats.today % 10 === 0) {
    const parts = Object.entries(stats.byReason).map(([k, v]) => `${k} ${v}`).join(' / ');
    logger.info(PLUGIN_ID, `今日已免回 ${stats.today} 条（${parts}）`);
  }
}

function splitWords(raw) {
  const out = [];
  for (const item of String(raw ?? '').split(/[,，、;；\s]+/)) {
    const w = item.trim();
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * 主人 QQ（优先读本插件自己的设置；留空再回退「主人识别」与「权限分级」两处配置）。
 * 私聊主人是管理通道，一律放行。
 *
 * 为什么要自己的设置：owner-identity / access-level 两个技能在本机都没安装，
 * 写在 skills['owner-identity'].ids 里的配置会被技能页的"清理残留配置"直接删掉。
 * 放进本插件的命名空间（config.skills['chatter-guard'].ownerIds）才不会被误清，
 * 同时旧路径继续兼容（两个键都读，取并集）。
 */
export function ownerIds() {
  try {
    const c = getConfig() || {};
    // 新设置存在 config.skills['chatter-guard'].ownerIds（与 enabled 同一个命名空间），
    // 也就是 api.config()（本文件的 settings()）返回的那个对象。
    const own = String(settings()?.ownerIds ?? '').trim();
    const raw = own
      ? own
      : `${c.skills?.['owner-identity']?.ids ?? ''},${c.skills?.['access-level']?.level1Ids ?? ''}`;
    return new Set(splitWords(raw));
  } catch { return new Set(); }
}

/** 只有表情/图片/卡片，没有一个字。 */
export function isMediaOnly(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  // 存档里的渲染形式：[图片:xxx] [表情:xxx] [卡片：xxx] [视频:xxx] …
  const stripped = t.replace(/\[[^\]]{0,60}\]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length === 0;
}

/** 纯水话：内置/自定义水词、同字重复、全标点。 */
export function isFiller(text, cfg = {}) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  const compacted = t.replace(/\s+/g, '');
  const words = [...DEFAULT_FILLERS, ...splitWords(cfg.fillerWords)];
  if (words.some((w) => compacted === w || (w.length >= 2 && compacted === w.repeat(2)))) return true;
  if (!/[\p{L}\p{N}]/u.test(compacted)) return true;          // 全是标点/符号
  if (compacted.length <= 12 && /^(.)\1{2,}$/u.test(compacted)) return true;   // 同一字重复 3 次以上
  return false;
}

/**
 * 把渲染进正文的 @ 片段（@昵称 / @昵称(QQ:123) / @全体成员）从文本里剔掉。
 * atNames 是 ingest 时记录的原文片段（store.js 的 atNames），只做精确替换、不用正则。
 * 手打的 "@昵称"（没有 @ 段，atNames 为空）不会剔 —— 那种消息本身也不是纯表情。
 *
 * 注意命名：主进程 src/prompt.js 已有一个 stripMentions(entry)（还会剔除引用块），
 * 这里叫 stripAtSegments 以免签名不同的同名函数被误用。
 */
export function stripAtSegments(text, entry) {
  let t = String(text ?? '');
  // 按长度倒序替换：先剔「@张三丰」再剔「@张三」，否则前者会被拆成「@张三」+「丰」，
  // 留下半截昵称，导致「@张三 @张三丰 [图片]」不算纯媒体。
  const names = (Array.isArray(entry?.atNames) ? entry.atNames : [])
    .map((n) => String(n ?? ''))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const s of names) t = t.split(s).join(' ');
  return t.trim();
}

/** 这条消息算不算"水"。返回原因字符串，正常消息返回 null。 */
export function waterReason(entry, cfg = {}) {
  // 拍一拍条目的 text 是「[拍一拍] 甲 拍了拍 我」，按文本判永远不是水；
  // 这里按 isPoke 标记识别，和表情/水话共用同一个连续计数。
  if (cfg.skipPoke !== false && entry?.isPoke === true) return '戳一戳';
  // 先剔掉 @：不剔的话「@机器人 [图片]」永远不是纯媒体，
  // alwaysReplyWhenAtMe 关着也照样响应（该设置形同虚设）。
  const text = stripAtSegments(entry?.text, entry);
  // 只有 @ 的召唤（@机器人 / @全体成员）不算水，否则连点两下 @ 会被当成刷屏。
  if (!text) return null;
  if (cfg.skipMedia !== false && isMediaOnly(text)) return '只有表情/图片';
  if (cfg.skipFiller !== false && isFiller(text, cfg)) return '纯水话';
  return null;
}

/**
 * 连续计数。返回"连着第几条水"。
 * 超过时间窗、或者来了一句正常话 → 重新计数 ✓
 */
export function bumpStreak(chatKey, senderId, isWater, cfg = {}) {
  const key = `${chatKey}|${senderId}`;
  const windowMs = Math.max(10, Number(cfg.windowSec) || 180) * 1000;
  const now = Date.now();
  const rec = streaks.get(key);
  if (!isWater) { streaks.delete(key); return 0; }
  if (!rec || now - rec.at > windowMs) {
    streaks.set(key, { count: 1, at: now });
  } else {
    rec.count += 1; rec.at = now;
  }
  while (streaks.size > MAX_STREAK_KEYS) streaks.delete(streaks.keys().next().value);
  return streaks.get(key)?.count || 1;
}

/**
 * 事前否决判定。返回 { reason, count } = 免回；返回 null = 放行。
 * 任何异常都吞掉并放行 —— 过滤器坏掉不该让机器人整体不响应。
 */
function veto(orch, chatKey, entry) {
  const cfg = settings();
  if (cfg.enabled === false) return null;
  if (!entry) return null;                                  // 没有具体条目（peekUnread 路径）不否决
  if (entry.self === true) return null;                     // 机器人自己的消息
  const senderId = String(entry.senderId ?? '');
  if (!senderId || senderId === 'self') return null;
  const selfId = String(orch?.onebot?.selfId ?? '');
  if (selfId && senderId === selfId) return null;           // 自己发的不算

  // ★ 主人私聊是管理通道，一律放行
  if (String(chatKey).startsWith('private:') && ownerIds().has(senderId)) return null;

  // @ 它时是否仍然回（默认不回）
  // atAll 没有单独持久化，从 atNames 的渲染片段推导；老存档没有 atNames 时按 false。
  const atAll = entry.atAll === true
    || (Array.isArray(entry.atNames) && entry.atNames.some((n) => String(n).startsWith('@全体成员')));
  if (cfg.alwaysReplyWhenAtMe === true && (entry.atMe === true || atAll)) {
    streaks.delete(`${chatKey}|${senderId}`);
    return null;
  }

  const reason = waterReason(entry, cfg);
  const count = bumpStreak(chatKey, senderId, Boolean(reason), cfg);
  if (!reason) return null;
  const threshold = Math.max(2, Number(cfg.threshold) || 3);
  if (count < threshold) return null;
  return { reason, count };
}

export function setup(skillApi) { api = skillApi; }

export function available() { return { ok: true }; }

export function activate() {
  const ok = install();
  if (ok) logger.info(PLUGIN_ID, `水聊免回已挂载：onIncoming 前置否决（今日已免回 ${todayCount()} 条）`);
}

export function deactivate() { uninstall(); }
export function dispose() { uninstall(); }

/**
 * 装上钩子。幂等：同一个 prototype 上只包一次，热重载只换 handle（与 nsfw-guard 同款）。
 */
function install() {
  const proto = Orchestrator?.prototype;
  if (!proto || typeof proto.onIncoming !== 'function') {
    logger.warn(PLUGIN_ID, '拿不到 Orchestrator.prototype.onIncoming，水聊免回未挂载（应用版本可能变了）');
    return false;
  }
  let rec = proto[PATCH_KEY];
  if (!rec) {
    const original = proto.onIncoming;
    const wrapped = function onIncoming(chatKey, entry = null) {
      const cur = proto[PATCH_KEY];
      if (cur && typeof cur.veto === 'function') {
        let hit = null;
        try { hit = cur.veto(this, chatKey, entry); }
        catch (error) { logger.warn(PLUGIN_ID, `判定失败（本次放行）：${error?.message ?? error}`); }
        if (hit) {
          // 复刻核心"未触发"路径：标已读 + 通知界面，然后**不调用原方法**。
          try {
            if (typeof this?.store?.markEntryRead === 'function') this.store.markEntryRead(chatKey, entry.id);
            if (typeof this?.emit === 'function') this.emit('chat-update', chatKey);
          } catch (error) {
            logger.warn(PLUGIN_ID, `免回后标已读失败：${error?.message ?? error}`);
          }
          noteSuppressed(hit, chatKey);
          logger.info(PLUGIN_ID, `${chatKey} 免回：${stats.lastReason} —— 未触发会话`);
          return;
        }
      }
      return original.call(this, chatKey, entry);
    };
    rec = { original, wrapped, veto: null };
    proto[PATCH_KEY] = rec;
    proto.onIncoming = wrapped;
  }
  rec.veto = veto;
  return true;
}

function uninstall() {
  const proto = Orchestrator?.prototype;
  const rec = proto?.[PATCH_KEY];
  if (!rec) return;
  rec.veto = null;
  if (proto.onIncoming === rec.wrapped) proto.onIncoming = rec.original;
  delete proto[PATCH_KEY];
}

export const internals = { DEFAULT_FILLERS, isMediaOnly, isFiller, stripAtSegments, waterReason, bumpStreak, streaks, stats, install, uninstall, veto };
