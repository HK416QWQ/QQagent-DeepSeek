// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');

// 与发送侧 localStickerPath() 对齐：只认受控目录 data/sticker-images 内的 file:///。
// “存在”不等于“可发”——目录外文件会被发送闸拒绝，不能拿它覆盖可用的 QQ 地址。
const STICKER_IMAGES_DIR = path.resolve(path.join(DATA_DIR, 'sticker-images')) + path.sep;

// 本地转存文件是否真的还在且可发。
// 防止同步时把可用的本地文件覆盖成会过期的 QQ 直链。
function readableLocalUrl(entry) {
  for (const candidate of [entry?.localFile, entry?.url]) {
    const value = String(candidate || '').trim();
    if (!value.toLowerCase().startsWith('file:///')) continue;
    try {
      const file = path.resolve(fileURLToPath(value));
      if (!file.toLowerCase().startsWith(STICKER_IMAGES_DIR.toLowerCase())) continue;
      if (fs.statSync(file).isFile()) return value;
    } catch { /* 非法 file URL / 不存在 / 不是文件，均视为不可用 */ }
  }
  return '';
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    // QQ 原生收藏身份（add_custom_face 的 emoji_id）：入了 QQ 收藏的条目靠它
    // 做幂等补录、备注回写（modify_custom_face）与长效地址回查。
    emojiId: String(entry.emojiId || '').trim(),
    // 消息里的协议端缓存文件 id：转存失败后的重试线索（get_image 认它）。
    qqFile: String(entry.qqFile || '').trim(),
    // 本地转存产物（file:///）。搬家自愈后由 healLocalPaths 重写。
    localFile: String(entry.localFile || '').trim(),
    // 本地转存失败标记：提示这条目当前靠 url 存活（QQ 图床 rkey ~1h，僵尸预警）。
    persistFailed: entry.persistFailed === true,
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const fetchedList = Array.isArray(fetched) ? fetched : [];
  const fetchedIds = new Set();
  for (const item of fetchedList) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of fetchedList) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    // QQ 的 emoji_id 可能和旧条目的 id/resId 不同（旧库常把 resId 当 id）。
    // 三种身份都参与匹配，命中后原地替换；否则 id 一旦从 resId 换成 emoji_id，
    // 旧条目会被当成“已删除”丢掉，localFile/localNote/useCount 全丢。
    const keys = [item.emoji_id, item.resId, item.id]
      .map((v) => String(v || '').trim()).filter(Boolean);
    const old = out.find((e) =>
      keys.includes(e.id) || keys.includes(e.resId) || (e.emojiId && keys.includes(e.emojiId))
    ) || null;
    const localUrl = readableLocalUrl(old);
    const emojiId = String(item.emoji_id || old?.emojiId || '').trim();
    const oldUrl = String(old?.url || '').trim();
    // 本地不可读时，先取本次 QQ 地址；QQ 没给才退回旧 http 地址。
    // 旧的 file:/// 已确认不可读，不能再拿来当兜底（否则会指向死文件）。
    const fallbackUrl = String(item.url || '').trim()
      || (oldUrl.toLowerCase().startsWith('file:///') ? '' : oldUrl);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: localUrl || fallbackUrl,
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      emojiId,
      persistFailed: !localUrl && !emojiId,
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (old) {
      const idx = out.indexOf(old);
      if (idx >= 0) out[idx] = merged;
      else out.push(merged);
    } else {
      out.push(merged);
    }
  }
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const md5 = raw.toUpperCase();
  // 精确命中优先：完整 id / resId / emojiId / md5 原样返回，旧调用完全不变。
  const exact = list.find((e) =>
    e.id === raw || e.resId === raw || e.emojiId === raw
      || (e.md5 && String(e.md5).toUpperCase() === md5)
  );
  if (exact) return exact;
  // 短 id：提示词只印 md5 的唯一前缀（最少 8 位），模型回传的也是它。
  // 多条命中说明前缀有歧义 —— 宁可返回 null 让调用方换完整 id，也不能猜错表情。
  if (/^[0-9A-F]{6,32}$/.test(md5)) {
    const hits = list.filter((e) => {
      const value = String(e.md5 || '').toUpperCase();
      return /^[0-9A-F]{32}$/.test(value) && value.startsWith(md5);
    });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return list.find((e) => {
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

/**
 * 提示词里的短 id：md5 的唯一前缀（最少 8 位，撞车时自动加长）。
 * 唯一性按整个表情库计算，避免“只对当前展示的几条唯一、新条目一来就串台”。
 * md5 缺失或完全重复时退回完整 id，发送/备注路径仍可精确命中。
 */
function buildShortIdMap(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const md5s = list.map((e) => String(e?.md5 || '').toUpperCase())
    .filter((value) => /^[0-9A-F]{32}$/.test(value));
  const map = new Map();
  for (const entry of list) {
    const md5 = String(entry?.md5 || '').toUpperCase();
    if (!/^[0-9A-F]{32}$/.test(md5)) {
      map.set(entry.id, entry.id);
      continue;
    }
    let len = 8;
    while (len < 32 && md5s.filter((m) => m.startsWith(md5.slice(0, len))).length > 1) len += 1;
    const prefix = md5.slice(0, len);
    const unique = md5s.filter((m) => m.startsWith(prefix)).length === 1;
    map.set(entry.id, unique ? prefix.toLowerCase() : entry.id);
  }
  return map;
}

export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    useCount: e.useCount || 0
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/**
 * 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。
 *
 * 2026-11-02 起取消按时间轮换：
 *   · 配置了 selectedIds → 按 selectedIds 的顺序固定输出（去重、忽略已不存在的 id、最多 max 条）
 *   · 没配置 / 全部失效 → 按 useCount 排序自动挑
 *   · withId 未显式设置时，实际条数 <= 20 才附带 id
 */
export function buildStickerContext(entries, max = 10, { selectedIds = [], withId = null } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!list.length) return '';

  const total = Math.max(1, Math.min(30, Number(max) || 10));
  const byId = new Map(list.map((e) => [e.id, e]));
  const picked = [];
  const seen = new Set();
  for (const raw of Array.isArray(selectedIds) ? selectedIds : []) {
    const id = String(raw ?? '').trim();
    if (!id || seen.has(id)) continue;
    const entry = byId.get(id);
    if (!entry) continue;
    seen.add(id);
    picked.push(entry);
    if (picked.length >= total) break;
  }

  const fixed = picked.length > 0;
  const auto = [...list].sort((a, b) =>
    (b.useCount || 0) - (a.useCount || 0)
    || ((b.localNote || b.desc) ? 1 : 0) - ((a.localNote || a.desc) ? 1 : 0)
    || String(a.id).localeCompare(String(b.id))
  );
  const selected = fixed ? picked : auto.slice(0, total);
  // 门槛看实际输出条数，不是 max：固定选 2 个 + max=30 时仍应带 id。
  const showId = withId === null ? selected.length <= 20 : Boolean(withId);
  // 完整 id 53 位，20 条约 1060 字符；提示词只印 md5 唯一前缀（通常 8 位）。
  const shortIds = buildShortIdMap(list);

  const lines = selected.map((e) => {
    // 本地笔记是识图脚本/模型写的，信息量比 QQ 备注大，优先展示；都没有时提示先看图。
    const label = String(e.localNote || e.desc || '（无备注，可先看图）').slice(0, 40);
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    return `- ${label}${extra}${showId ? ` id=${shortIds.get(e.id) || e.id}` : ''}`;
  });

  const how = fixed
    ? `你固定的 ${selected.length} 个`
    : `按使用频率自动挑的 ${selected.length} 个`;
  return `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个表情（以下为${how}，完整列表可用 list_stickers 查询）：\n${lines.join('\n')}`;
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint(level = 1) {
  // 活跃度引导放在系统提示的策略段里（而不是"本次输入"的【表情包用法】）——
  // 同一主题两处引导会左右脑互搏（Kondius 2026-09-07）：策略讲时机、档位讲频率，
  // 合并成一处由档位直接改写频率行。
  // ⚠️ 索引严格对应 0~4 档，与 ui 的 STICKER_LEVELS 一致。
  const freqByLevel = [
    '表情包是备选项，不勉强；纯文字回应完全没问题。',
    '频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '频率：回应、吐槽、接梗时优先考虑配一个贴切的表情，让对话更有活人感；别每次都用同一张。',
    '频率：你是表情包爱好者——能配表情的地方尽量配，接梗/调侃/附和时几乎都会带一张，聊天要有表情包的烟火气；注意换着用，不要连发同一张。',
    '频率：你是重度表情包玩家——几乎每次回应都配一张贴切的表情，每次回应最多一张，严肃/敏感话题仍要收住。'
  ][Math.min(4, Math.max(0, Number(level) || 0))];
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    `- ${freqByLevel}`,
    '- 选择：优先用你的本地笔记（localNote）和 QQ 备注（desc）能准确对上语境的；没有备注/不确定的表情，先 get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 send_sticker；一张表情单独占一个 QQ 气泡，不能在同一气泡里附带文字。要让文字和表情分成两个气泡，就在同一次回复里依次调用 send_message、send_sticker（连续调用只算一轮），不要分两轮先后发。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    desc: patch.desc !== undefined ? String(patch.desc ?? '').trim().slice(0, 20) : target.desc,
    emojiId: patch.emojiId !== undefined ? String(patch.emojiId ?? '').trim() : target.emojiId,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
