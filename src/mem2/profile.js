// L1 收敛 · 派生画像视图（A 方案）。
//
// active 是唯一事实来源；profile.json 只是注入用的 8 条压缩视图。
// 删 profile 文件只会让注入退回确定性兜底，不影响任何 L1 条目。
//
// 本模块职责：
//   · 压缩模板（PROFILE_PROMPT）
//   · 解析器（parseProfileOutput）
//   · digest（computeDigest）
//   · 读写（readProfile / writeProfile）
//   · 确定性兜底（fallbackItems）
//   · 提炼用 existing 转换（profileToExisting）
//   · 队列管理（buildProfileQueue）

import crypto from 'node:crypto';
import fs from 'node:fs';
import * as P from './paths.js';
import { readPerson, activePerson, listPersonIds } from './store.js';

/** 注入维序（唯一来源；inject.js 直接复用，不再另立 GROUP_PRIORITY）。 */
export const PROFILE_DIMS = Object.freeze(['说话风格', '关系态度', '性格特质', '兴趣身份']);

/** 每维度最多 2 条，4 维 × 2 = 8 槽。 */
export const PROFILE_MAX_SLOTS = 8;
export const PROFILE_PER_DIM = 2;

/** 压缩输入上限（按 updatedAt 降序截断）。 */
export const PROFILE_INPUT_CAP = 200;

/** 每轮最多压缩人数。 */
export const PROFILE_MAX_PER_TICK = 12;

/** 压缩 kind（独立配额）。 */
export const PROFILE_KIND = 'l1-profile';

/** 单条字数目标带（模板与解析器共用这一套口径，改这里就是改全部）。
 *  下限取实测分布下沿：2026-11-17 重压 38 槽落在 24–40，27 是「一句话说完一个侧面」的下限；
 *  24–26 仍会被计数（可见），不为了好看把下限继续往下调。 */
export const PROFILE_CHARS_MIN = 27;
export const PROFILE_CHARS_MAX = 50;
/** 绝对上限：超过就截断并计 violation（不静默丢内容）。 */
export const PROFILE_CHARS_HARD_MAX = 60;

/** QQ 号只可能是纯数字；`u1` / `group:1` 这类是测试或非人 id。 */
export function isQqUid(uid) {
  return /^\d+$/.test(String(uid ?? '').trim());
}

/**
 * 题材/性癖类词表（2026-11-17 首轮复核）。
 *
 * 为什么需要它：模型会遵守「不写具体内容」，但会写成「反感某类题材」——
 * 题材名本身就是具体内容。上一版用「刻板印象/本子/政治/色情/幼」自查零命中，
 * 367 的画像里却有「反感凌辱恶堕类」，说明**词表口径**不等于模板口径。
 *
 * ★ 2026-11-17 四轮裁决（用户）：**只统计、不拦截**。
 *   词表只用于计数（日扫日志 / UI / stats），槽位、pinned、兜底一律照常注入。
 *   原因：词表本来就不闭合（换说法就漏），拦截只能挡一半，却会误删真信息、
 *   并让「模型有没有乱写」失去唯一指标。风险改由提示词 + L1_HEADER 表达层承担。
 *
 * 匹配是确定性（归一化后）子串命中，不判上下文、不做语义。词表仍不闭合，这是已知边界。
 */
export const PROFILE_SENSITIVE_TERMS = Object.freeze([
  '凌辱', '恶堕', '调教', '轮奸', '迷奸', '恋童', '幼交', '兽交', '乱伦',
  // 与上面同类的性犯罪/性交易词
  '强暴', '强奸', '性侵', '猥亵', '嫖娼', '卖淫', '援交', '炮友', '约炮', '裸聊', '幼女'
]);

/**
 * 扫描时忽略的字符：空白、零宽、间隔号。
 * 模型/人工可能写成「凌 辱」「凌·辱」——不归一化就漏。
 */
const SENSITIVE_SKIP = /[\s\u200B-\u200D\uFEFF\u00B7\u2022\u30FB]/;

/** 归一化视图：跳过干扰字符（只用于匹配，不改原文）。 */
function scanView(text) {
  const s = String(text ?? '');
  let normalized = '';
  for (let i = 0; i < s.length; i += 1) {
    if (SENSITIVE_SKIP.test(s[i])) continue;
    normalized += s[i];
  }
  return { normalized };
}

/** 返回命中的词（空数组 = 干净）。 */
export function scanSensitive(text) {
  const { normalized } = scanView(text);
  return PROFILE_SENSITIVE_TERMS.filter((w) => normalized.includes(w));
}

/**
 * 「补位」失败后允许的重压次数（每个 digest 只重试 1 次）。
 *
 * 不带上限会出事：模型连续两次漏同一维（367 就是），队列每 tick 都判脏、
 * 每 tick 烧一次 `l1-profile`，永远修不好还一直在花配额。
 */
export const PROFILE_RETRY_MAX = 1;

// ── 压缩模板（§4.2 定稿）──────────────────────────────────────────────────

export const PROFILE_PROMPT = `【任务】把给出的「原始印象」压成用于注入的画像。只维护这 8 条，不要扩写细节。

【约束】
- 只写能改变"怎么看他、怎么跟他说话"的稳定特征；不写具体事件、日期、一次性的事、群内八卦。
- 不出现昵称、QQ、群名、具体作品名/角色名/圈内黑话；统一用"他/对方""某款手游""某类同人"泛指。
- 涉及性、身体、私密关系，只写"有没有这类玩笑习惯/尺度"，不写具体内容。
- 每条一句话、可独立截断；单条 27–50 字（目标带，硬上限 60，绝不超）；条与条不重复。
  宁可写短、写准，不要为凑字数加形容词或把一句拆成两句。
- 同一维度两条必须写不同侧面，不写同一件事的两种说法。
- 只根据给定条目归纳，不脑补；材料不足的维度可以不写满 2 条，宁缺毋滥。
- 每条必须标出来源序号（输入列表编号），多个用逗号。
- 【钉住条目】只作约束：不得被改写、不得作为来源序号；与它冲突时以钉住条目为准。

【维度与落点】（每个维度最多 2 条，不得跨维度借名额）
说话风格
1. 句式长短/分条习惯 + 常用口头禅/语气词 + 情绪外露程度 + 粗口与性暗示习惯
2. 玩梗/复制粘贴/改编习惯 + 表情与符号使用 + 刷屏、连发倾向
关系态度
1. 对熟人：称呼与玩笑尺度 + 主动程度（搭话/追问/索取）+ 是否热心帮忙
2. 对圈外或看不顺眼的人：评价姿态 + 贬词习惯 + 对哪类行为看不惯（只写态度：不写身份歧视或刻板印象、不写政治立场与敏感事件、不复述具体段子、不做心理诊断）
性格特质
1. 嘴硬程度与情绪恢复速度 + 自嘲方式 + 被劝/被怼时的反应
2. 底线与反感项 + 自我约束与分寸感 + 最在意什么
兴趣身份
1. 长期投入的领域 + 熟悉程度（外号/黑话/渊源）+ 是否替其说话、抱什么立场
2. 创作或产出的身份 + 偏好类型 + 是否公开发布/存档 + 其他涉猎领域

【输出】每行一条，最多 8 行，不要解释、不要 markdown：
说话风格｜1,4,9｜正文
说话风格｜2,7｜正文
关系态度｜3,11｜正文
...`;

// ── digest（§4.1）─────────────────────────────────────────────────────────

/**
 * 计算 active 条目的摘要。
 * 覆盖：status==='active' 的全部条目（含 pinned），按 entryId 排序后
 * 对 entryId|content|groups(排序后拼接)|pinned(Boolean) 求 sha1。
 * ★ 不含 updatedAt：setPersonStatus/setPersonDeduped/markConflict 空写也 bump，
 *   放进去会造成无意义的「脏画像」和配额消耗。
 */
export function computeDigest(entries) {
  const active = (Array.isArray(entries) ? entries : [])
    .filter((e) => e?.status === 'active')
    .sort((a, b) => String(a.entryId).localeCompare(String(b.entryId)));
  const lines = active.map((e) => {
    const groups = [...(e.groups || [])].sort().join(',');
    const pinned = e.pinnedByUser === true ? '1' : '0';
    return `${e.entryId}|${e.content}|${groups}|${pinned}`;
  });
  const hash = crypto.createHash('sha1').update(lines.join('\n'), 'utf8').digest('hex');
  return `sha1:${hash}`;
}

// ── 解析器（§4.3）─────────────────────────────────────────────────────────

/**
 * 解析压缩输出。
 * 行格式：维度｜序号列表｜正文（容忍全角｜与 ||）
 *
 * @param {string} text 模型输出
 * @param {Array} inputEntries 输入列表（用于序号→entryId 映射）
 * @returns {{slots: Array, stats: object}}
 */
export function parseProfileOutput(text, inputEntries = []) {
  const stats = { badDim: 0, badRefs: 0, noRef: 0, overflow: 0, duplicates: 0, lengthViolations: 0, truncated: 0 };
  const slots = [];
  const dimCount = {};
  const seenContent = new Set();

  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // 分隔符：全角｜或 ||
    const parts = line.split(/｜|\|\|/).map((s) => s.trim());
    if (parts.length < 3) { stats.badDim++; continue; }

    const dim = parts[0];
    if (!PROFILE_DIMS.includes(dim)) { stats.badDim++; continue; }

    const refsRaw = parts[1];
    const content = parts.slice(2).join('｜').trim();
    if (!content) { stats.noRef++; continue; }

    // 序号解析
    const refs = String(refsRaw).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const validIds = [];
    for (const r of refs) {
      const idx = parseInt(r, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > inputEntries.length) {
        stats.badRefs++;
        continue;
      }
      const entry = inputEntries[idx - 1];
      if (entry?.entryId) validIds.push(entry.entryId);
    }
    // 0 有效来源 → 整行丢弃
    if (validIds.length === 0) { stats.noRef++; continue; }

    // 每维度最多 2 条
    dimCount[dim] = (dimCount[dim] || 0) + 1;
    if (dimCount[dim] > PROFILE_PER_DIM) { stats.overflow++; continue; }

    // 重复正文
    if (seenContent.has(content)) { stats.duplicates++; continue; }
    seenContent.add(content);

    // 字数：目标带 30–50（与模板同一口径），偏离即计 violation；
    // >60 是绝对上限，截到 59 字 + …（共 60）。**截断必须可见**，不许静默。
    const chars = [...content].length;
    let finalContent = content;
    if (chars < PROFILE_CHARS_MIN || chars > PROFILE_CHARS_MAX) stats.lengthViolations++;
    if (chars > PROFILE_CHARS_HARD_MAX) {
      finalContent = [...content].slice(0, PROFILE_CHARS_HARD_MAX - 1).join('') + '…';
      stats.truncated++;
      stats.lengthViolations++;
    }

    slots.push({ dim, content: finalContent, sourceEntryIds: validIds, chars: [...finalContent].length });
  }

  return { slots, stats };
}

// ── 读写（§4.1）───────────────────────────────────────────────────────────

/** 读 profile；缺失/坏文件返回 null。 */
export function readProfile(uid) {
  try {
    const j = JSON.parse(fs.readFileSync(P.profileFile(uid), 'utf8'));
    if (j && typeof j === 'object' && Array.isArray(j.slots)) return j;
  } catch { /* 缺失或坏 */ }
  return null;
}

/** 原子写 profile（tmp + rename）。 */
export function writeProfile(uid, profile) {
  P.writeJsonAtomic(P.profileFile(uid), profile);
}

// ── 确定性兜底（§3.1-5）──────────────────────────────────────────────────

/**
 * 从 active 条目里按 2/2/2/2 确定性选条（排除 pinned）。
 * 排序：风格 createdAt 升、兴趣 updatedAt 降、其余 updatedAt 降，并列 entryId 升。
 */
export function fallbackItems(activeEntries) {
  const nonPinned = (activeEntries || []).filter((e) => e?.status === 'active' && !e.pinnedByUser);
  const byDim = {};
  for (const dim of PROFILE_DIMS) byDim[dim] = [];

  for (const e of nonPinned) {
    // 归到第一个命中的维度（与 GROUP_PRIORITY 同逻辑）
    const dim = (e.groups || []).find((g) => PROFILE_DIMS.includes(g));
    if (dim) byDim[dim].push(e);
  }

  const result = [];
  for (const dim of PROFILE_DIMS) {
    const arr = byDim[dim];
    // 排序
    if (dim === '说话风格') {
      arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.entryId).localeCompare(String(b.entryId)));
    } else if (dim === '兴趣身份') {
      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.entryId).localeCompare(String(b.entryId)));
    } else {
      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.entryId).localeCompare(String(b.entryId)));
    }
    for (const e of arr.slice(0, PROFILE_PER_DIM)) {
      result.push({ dim, content: e.content, sourceEntryIds: [e.entryId], chars: [...e.content].length });
    }
  }
  return result;
}

// ── 空维度确定性补位（§4.3 补，2026-11-17 复核）──────────────────────────

/**
 * 某一维在 profile 里 0 条、而 active 里该维有材料 → 按确定性规则补 top-2。
 *
 * 为什么必须在 build 阶段补：注入端只在**槽全空**时才走 `fallbackItems`，
 * 没有按维兜底。所以「模型漏写兴趣身份」不会被发现、不会告警，而且
 * `sourceDigest` 只看 active —— active 没变 → 永不重压 → 那一维**永久缺席**。
 * 367 就是这样：6 槽（风格 2 / 关系 2 / 性格 2）、兴趣身份 0 条，
 * 而他 84 条 active 里兴趣身份有 49 条（五个人里材料最厚）。
 *
 * 规则（纯排序 + 截断，不做语义判断）：
 *   · 候选 = active 里非 pinned、按首个命中维度归到该维（与 fallbackItems 同逻辑）；
 *   · 排序 updatedAt 降序 → entryId 升序，取前 2；
 *   · 内容裁到 50 字（超长加 …），来源写真实 entryId；
 *   · 不按题材词过滤（2026-11-17 裁决：只统计、不拦截）。
 *
 * @returns {{slots:Array, filledDims:string[]}}
 */
export function fillMissingDims(slots, activeEntries, {
  perDim = PROFILE_PER_DIM, maxChars = PROFILE_CHARS_MAX
} = {}) {
  const next = Array.isArray(slots) ? [...slots] : [];
  const have = new Set(next.map((s) => s?.dim));
  const active = (activeEntries || []).filter((e) => e?.status === 'active' && !e.pinnedByUser);

  const byDim = {};
  for (const dim of PROFILE_DIMS) byDim[dim] = [];
  for (const e of active) {
    const dim = (e.groups || []).find((g) => PROFILE_DIMS.includes(g));
    if (dim) byDim[dim].push(e);
  }

  const filledDims = [];
  for (const dim of PROFILE_DIMS) {
    if (have.has(dim)) continue;
    const arr = byDim[dim];
    if (!arr.length) continue;
    arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.entryId).localeCompare(String(b.entryId)));
    let taken = 0;
    for (const e of arr) {
      if (taken >= perDim) break;
      const raw = String(e.content ?? '').trim();
      if (!raw) continue;
      const chars = [...raw];
      const content = chars.length > maxChars ? chars.slice(0, maxChars - 1).join('') + '…' : raw;
      next.push({ dim, content, sourceEntryIds: [e.entryId], chars: [...content].length, filled: true });
      taken += 1;
    }
    if (taken) filledDims.push(dim);
  }
  return { slots: next, filledDims };
}

/**
 * 槽位覆盖了几条 active（去重后按 entryId 计）。 */
function coveredOf(slots, activeEntries) {
  const alive = new Set((activeEntries || []).map((e) => String(e.entryId)));
  const hit = new Set();
  for (const s of (Array.isArray(slots) ? slots : [])) {
    for (const id of (s?.sourceEntryIds || [])) if (alive.has(String(id))) hit.add(String(id));
  }
  return hit.size;
}

/** 只比较「修复会改到」的那几个字段；`repairedAt` 不进比较，保证幂等。 */
function statsCore(s) {
  return JSON.stringify([
    s?.missingDims || [], s?.sensitiveHits || 0, s?.retry || 0,
    s?.covered ?? null, s?.active ?? null, s?.filledDims || []
  ]);
}

/**
 * 零调用修复：给已落盘画像补空维（`fillMissingDims`），顺带重算覆盖口径与题材词计数。
 * 不调模型、不改 digest、不删任何槽。
 *
 * 用途：补位规则改了、旧画像缺维且 digest 不会再变时，靠日扫等不到重建；
 * 运维脚本 `--repair` 走这里，一次补完。题材词命中只统计（2026-11-17 裁决），不拦截。
 *
 * @returns {{ok:boolean, changed:boolean, profile:object|null, filledDims:string[], sensitiveHits:number}}
 */
export function repairProfileSlots(uid, { activeEntries = null, now = Date.now(), apply = true } = {}) {
  const raw = readProfile(uid);
  if (!raw) return { ok: false, changed: false, profile: null, filledDims: [], sensitiveHits: 0 };

  const active = Array.isArray(activeEntries)
    ? activeEntries.filter((e) => e?.status === 'active')
    : activePerson(uid);

  const fix = fillMissingDims(raw.slots, active);
  const slots = fix.slots;
  const filledDims = fix.filledDims;
  const sensitiveHits = slots.filter((s) => scanSensitive(s?.content).length > 0).length;

  const changed = filledDims.length > 0
    || statsCore(raw.stats) !== statsCore({
      ...(raw.stats || {}),
      missingDims: missingDimsOf(slots, active),
      sensitiveHits, covered: coveredOf(slots, active), active: active.length,
      filledDims: [...new Set(slots.filter((x) => x?.filled).map((x) => x.dim))]
    });
  const stats = {
    ...(raw.stats || {}),
    repairedAt: now,
    repairedFilledDims: filledDims,
    missingDims: missingDimsOf(slots, active),
    sensitiveHits,
    // ★ 槽位变了，覆盖口径必须跟着重算（否则 stats 会一直显示修复前的 covered/active）
    covered: coveredOf(slots, active),
    active: active.length,
    // 按槽位实况重算（不是「这次补了哪些」）：审计要看的是「这 8 条里有几条是补位来的」
    filledDims: [...new Set(slots.filter((x) => x?.filled).map((x) => x.dim))]
  };
  const out = { ...raw, slots, stats };
  if (changed && apply) writeProfile(uid, out);
  return { ok: true, changed, profile: out, filledDims, sensitiveHits };
}

/** 有材料却没写进画像的维度（队列判脏/日志用）。只数「active 该维非空」的维度。 */
export function missingDimsOf(slots, activeEntries) {
  const have = new Set((Array.isArray(slots) ? slots : []).map((s) => s?.dim));
  const material = new Set();
  for (const e of (Array.isArray(activeEntries) ? activeEntries : [])) {
    if (e?.status !== 'active' || e.pinnedByUser) continue;
    const dim = (e.groups || []).find((g) => PROFILE_DIMS.includes(g));
    if (dim) material.add(dim);
  }
  return PROFILE_DIMS.filter((d) => material.has(d) && !have.has(d));
}

// ── 提炼用 existing 转换（§5.3）──────────────────────────────────────────

/**
 * 把 profile 槽位转成 refine 的 existing 格式。
 * 槽位按 1..M 编号，其后接 pinned 只读条目（M+1..N，带 readOnly:true）。
 */
export function profileToExisting(profile, activeEntries = []) {
  // 不再按题材词过滤：命中只计数（2026-11-17 裁决），槽位照常进提炼 prompt 与注入
  const slots = Array.isArray(profile?.slots) ? profile.slots : [];
  const existing = [];

  // 槽位 1..M
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    // 找来源条目的 sourceChatKeys 并集
    const sourceIds = new Set(s.sourceEntryIds || []);
    const chatKeys = new Set();
    for (const e of activeEntries) {
      if (sourceIds.has(e.entryId)) {
        for (const k of (e.sourceChatKeys || [])) chatKeys.add(k);
      }
    }
    existing.push({
      index: i + 1,
      content: s.content,
      groups: [s.dim],
      sourceEntryIds: s.sourceEntryIds || [],
      sourceChatKeys: [...chatKeys].sort(),
      readOnly: false
    });
  }

  // pinned 只读区 M+1..N
  const pinned = (activeEntries || []).filter((e) => e?.status === 'active' && e.pinnedByUser);
  pinned.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.entryId).localeCompare(String(b.entryId)));
  for (let i = 0; i < pinned.length; i++) {
    const e = pinned[i];
    existing.push({
      index: slots.length + i + 1,
      content: e.content,
      groups: e.groups || [],
      sourceEntryIds: [e.entryId],
      sourceChatKeys: e.sourceChatKeys || [],
      readOnly: true
    });
  }

  return existing;
}

// ── 压缩输入构建（§4.2）──────────────────────────────────────────────────

/**
 * 构建压缩输入列表。
 * 顺序：updatedAt 降序 → entryId 升序。上限 200 条。
 * pinned 单独列在只读块，不作为来源序号。
 */
export function buildProfileInput(activeEntries) {
  const active = (activeEntries || []).filter((e) => e?.status === 'active');
  const nonPinned = active.filter((e) => !e.pinnedByUser);
  const pinned = active.filter((e) => e.pinnedByUser);

  // 排序
  nonPinned.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.entryId).localeCompare(String(b.entryId)));

  const inputTotal = nonPinned.length;
  const used = nonPinned.slice(0, PROFILE_INPUT_CAP);
  const inputUsed = used.length;

  // 输入列表（带序号）
  const lines = used.map((e, i) => `${i + 1}. [${(e.groups || []).join(',')}] ${e.content}`);

  // pinned 只读块
  const pinnedLines = pinned.map((e) => `- ${e.content}`);

  let text = lines.join('\n');
  if (pinnedLines.length) {
    text += '\n\n【钉住条目（只读，不得作为来源）】\n' + pinnedLines.join('\n');
  }

  return { text, inputEntries: used, inputTotal, inputUsed, truncated: inputTotal > inputUsed };
}

// ── 队列管理（§4.4）──────────────────────────────────────────────────────

/**
 * 建压缩队列：遍历全部 person，算 digest，把「无 profile / 脏」的人排队。
 *
 * 两条排除/排序规则（2026-11-17 复核补）：
 *   · **非 QQ 号不排队**：`u1` / `group:1` 这类是测试或脏文件名。排进来会真花一次
 *     `l1-profile` 调用、写出 `u1.profile.json`，把「覆盖人数」这个指标做假。
 *   · **active=0 排最后**：他们没有可压缩的事实，压缩只是写空画像（0 次调用），
 *     但会占掉本 tick 12 个名额。放到队尾，让真正需要重建的画像先上。
 *
 * 排序：需要 LLM 的（active>0）在前，按 builtAt 升序（无 profile 记 0，最先）；
 * 其后是 active=0 的空画像清理，同样 builtAt 升序；并列 uid 升序。
 *
 * 判脏两条（2026-11-17 复核、四轮裁决后）：
 *   1. 没有 profile / `sourceDigest` 与现算不一致；
 *   2. 有材料却没写进画像的维度（**读时用 `missingDimsOf(slots, active)` 现算**，不读 stats，
 *      否则旧画像没有这个字段就永远发现不了）——只重试 `PROFILE_RETRY_MAX` 次，
 *      避免模型反复漏同一维时每 tick 烧一次配额。
 *   题材词命中（`stats.sensitiveHits`）**不再判脏**：只统计、不拦截，没有重建的必要。
 *   注意：判脏只决定「要不要再调一次模型」，注入不等它 —— 槽位在 build 阶段
 *   已做确定性补位，漏维不会让注入少一维。
 *
 * @param {Function} [readPersonFn] 可注入的读人函数（测试用）
 * @param {Function} [readProfileFn] 可注入的读 profile 函数（测试用）
 * @returns {Array<{uid, builtAt, dirty, activeCount, reason}>}
 */
export function buildProfileQueue({ readPersonFn = readPerson, readProfileFn = readProfile } = {}) {
  const ids = listPersonIds();
  const queue = [];
  let skippedNonQq = 0;

  for (const uid of ids) {
    if (!isQqUid(uid)) { skippedNonQq += 1; continue; }
    const person = readPersonFn(uid);
    const active = (person.list || []).filter((e) => e.status === 'active');
    const digest = computeDigest(active);
    const profile = readProfileFn(uid);

    const st = profile?.stats || {};
    const retried = Number(st.retry) || 0;
    // ★ 缺维**读时现算**，不信任 stats.missingDims：166/185/257/386 四份是这轮之前建的，
    //   根本没有这个字段（undefined 当 0），信任 stats 会让「旧画像缺维」永远发现不了。
    //   missingDimsOf 是纯函数，成本可忽略。
    const missing = missingDimsOf(profile?.slots, active).length;
    // 只有同一批事实（digest 相同）才认上次的重试计数；事实变了重新给一次机会
    const sameFacts = Boolean(profile) && profile.sourceDigest === digest;

    let reason = '';
    if (!profile) reason = 'no-profile';
    else if (!sameFacts) reason = 'digest';
    else if (missing > 0 && retried < PROFILE_RETRY_MAX) reason = 'missing-dims';

    if (reason) {
      queue.push({ uid, builtAt: profile?.builtAt || 0, dirty: true, activeCount: active.length, reason });
    }
  }

  // active=0 的排最后：它们只写空画像、不调模型，不该挤掉真正要重建的人
  queue.sort((a, b) => (a.activeCount > 0 ? 0 : 1) - (b.activeCount > 0 ? 0 : 1)
    || a.builtAt - b.builtAt
    || String(a.uid).localeCompare(String(b.uid)));
  if (skippedNonQq) queue.skippedNonQq = skippedNonQq;
  return queue;
}

// ── 覆盖率观测（§4.4 日扫日志「覆盖C」）──────────────────────────────────

/**
 * 数一遍「有画像的人 / 有 active 的人」（只数真实 QQ 号）。
 *
 * 口径提醒：这里的 total 是**有 person 文件的人数**，不是覆盖率分母。
 * 「113 个合格发言人」是另一个统计（近 30 天 ≥30 条），不要混着写。
 * 非 QQ 号的 people 文件（测试残留）不计入，避免把 total 撑大。
 */
export function profileCoverage({ readPersonFn = readPerson, readProfileFn = readProfile } = {}) {
  const out = { total: 0, withProfile: 0, withActive: 0, skippedNonQq: 0 };
  for (const uid of listPersonIds()) {
    if (!isQqUid(uid)) { out.skippedNonQq += 1; continue; }
    out.total += 1;
    const person = readPersonFn(uid);
    if ((person.list || []).some((e) => e.status === 'active')) out.withActive += 1;
    if (readProfileFn(uid)) out.withProfile += 1;
  }
  return out;
}

// ── 空画像（active 为空时）───────────────────────────────────────────────

/** active 为空 → 写空 profile，不调 LLM。 */
export function emptyProfile(uid) {
  return {
    v: 1,
    uid: String(uid),
    builtAt: Date.now(),
    sourceDigest: computeDigest([]),
    model: '',
    slots: [],
    stats: {
      active: 0, covered: 0, calls: 0, inputTotal: 0, inputUsed: 0, lengthViolations: 0,
      badRefs: 0, noRef: 0, overflow: 0, duplicates: 0,
      missingDims: [], filledDims: [], sensitiveHits: 0, retry: 0
    }
  };
}