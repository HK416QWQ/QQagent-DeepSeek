// 第 3 期 · 注入（L1 画像装配）。
//
// 三条红线（施工单 §10）：
//   1. 【记忆】段必须是**稳定字节**：同一批人无论触发顺序如何，输出一致 ——
//      任何随数据变化的内容都会让快照判定「不可用」→ 每轮重建 → 前缀缓存归零。
//   2. 注入路径**零写入**：只读 people/ 与派生画像视图，不落任何盘。
//   3. 画像槽位/兜底必须**确定性**：裁剪只做纯排序/计数，同一输入同一输出；
//      槽位来源全失效时走确定性兜底，不按语义「猜」。

import { activePerson } from './store.js';
import { contentDigest } from './digest.js';
import {
  PROFILE_DIMS, PROFILE_PER_DIM, readProfile as readProfileFile, fallbackItems, scanSensitive
} from './profile.js';

export { PROFILE_DIMS };

/** 各段配额（施工单 §4）。两段各按自己的配额裁，不互相影响 —— 理由见 §3.1 末尾。 */
export const L1_BUDGET = 3250;
export const L3_BUDGET = 50;

/**
 * 【记忆】段的固定首行。
 *
 * 必须是**固定字节**、且是第一行：它是稳定段，任何随数据变化的开头都会破坏
 * `prevMemory.text` 的复用。
 *
 * 两句护栏都在这个括号里，且都是**表达层**约束（不改数据）：
 *   · 「涉及性、身体、私密关系的内容只用于理解这个人，不主动提及、不据此调侃对方」
 *     —— 第 3 期 §16.7 裁决。画像里写这类内容是**对的**（它解释了这个人为什么这么说话），
 *     要管的是「机器人别拿它开玩笑」。所以不删数据、不做关键词黑名单（黑名单脆弱且
 *     违反「裁剪必须确定性」），只在固定引导语里加一句。
 *   · 「具体事件和计划不要主动提」—— L1 按人存后不再按群隔离，某人在 B 群说的事
 *     会进他的画像、在 A 群也被注入；这条把约束从数据层搬到表达层。
 */
export const L1_HEADER = '【对群友的印象】（长期观察到的特点；涉及性、身体、私密关系的内容只用于理解这个人，不主动提及、不据此调侃对方；具体事件和计划不要主动提，除非当前话题正好涉及）';

/** 注入人数上限（只限注入；提炼的 MAX_PEOPLE_PER_TICK=15 是另一个名额）。 */
export const MAX_INJECT_PEOPLE = 5;

/** 预算裁剪档 3 的砍维度顺序：先砍「知不知道」，最后才动「像不像」。 */
const DIM_TRIM_ORDER = Object.freeze(['兴趣身份', '性格特质', '关系态度', '说话风格']);

const charLen = (s) => [...String(s ?? '')].length;

// ── L1：【记忆】（稳定段，数据源 = 派生画像视图）──────────────────────────

/**
 * 解析一个人的注入条：profile 槽位（校验来源仍 active）+ pinned。
 *
 * 槽位失效判定：`sourceEntryIds` 至少一个仍在 active 里，否则该槽不注入
 * —— 防止条目被彻底删除/作废后，旧画像在重压缩前「复活」。
 *
 * 没有 profile / 坏文件 / 所有槽都失效但 active 非空 → 确定性兜底（排除 pinned）。
 * active 只有 pinned 时兜底为空，pinned 仍单独注入。
 *
 * 题材词只统计、不拦截（2026-11-17 裁决）：槽位、pinned、兜底一律照常注入。
 *
 * @returns {{slots:Array<{dim,content,sourceEntryIds}>, pinned:Array, usedFallback:boolean,
 *            sensitiveSlots:number, sensitivePinned:number, sensitiveFallback:number}}
 */
export function resolvePersonItems(uid, activeEntries, profile, {
  fallback = fallbackItems, log = null
} = {}) {
  const active = (Array.isArray(activeEntries) ? activeEntries : []).filter((e) => e?.status === 'active');
  const activeIds = new Set(active.map((e) => String(e.entryId)));
  const pinned = [];
  let sensitivePinned = 0;
  for (const e of active.filter((e) => e.pinnedByUser === true)
    .sort((a, b) => ((Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      || String(a.entryId).localeCompare(String(b.entryId)))) {
    if (scanSensitive(e?.content).length) sensitivePinned += 1;
    pinned.push(e);
  }

  const rawSlots = Array.isArray(profile?.slots) ? profile.slots : [];
  const slots = [];
  let sensitiveSlots = 0;
  for (const s of rawSlots) {
    if (!PROFILE_DIMS.includes(s?.dim)) continue;
    const content = String(s?.content ?? '').trim();
    if (!content) continue;
    if (scanSensitive(content).length) sensitiveSlots += 1;
    const ids = (Array.isArray(s.sourceEntryIds) ? s.sourceEntryIds : []).map(String);
    if (!ids.some((id) => activeIds.has(id))) continue;      // 来源全死 → 槽不注入
    slots.push({ dim: s.dim, content, sourceEntryIds: ids });
  }
  if (sensitiveSlots || sensitivePinned) {
    try {
      log?.(`[inject] 画像含题材词 槽=${sensitiveSlots} 钉住=${sensitivePinned}（仅统计，不拦截；${uid}）`);
    } catch { /* ignore */ }
  }

  let usedFallback = false;
  let sensitiveFallback = 0;
  if (!slots.length && active.some((e) => !e.pinnedByUser)) {
    usedFallback = true;
    for (const s of fallback(active) || []) {
      const content = String(s.content ?? '').trim();
      if (scanSensitive(content).length) sensitiveFallback += 1;
      slots.push({ dim: s.dim, content, sourceEntryIds: s.sourceEntryIds || [] });
    }
    try { log?.(`[inject] 画像视图不可用/已空，临时按 active 选条（${uid}）`); } catch { /* ignore */ }
  }
  return { slots, pinned, usedFallback, sensitiveSlots, sensitivePinned, sensitiveFallback };
}

/**
 * 选人 + 选条 + 预算裁剪，产出【记忆】段。
 *
 * 两种顺序分开写死（§3.2）：
 *   · **选人**按 `lastTs` 降序 → uid 升序，取前 `maxPeople`；`protectedIds` 无条件保留；
 *   · **渲染**按 uid 升序 —— 同一批人无论触发顺序如何，输出字节稳定（前缀缓存）。
 *
 * 裁剪档位（§3.5，全部纯排序/计数，不做语义判断）：
 *   1. 整人剔除：非受保护、**无 pinned**、lastTs 最早者先剔；
 *   2. 剔 pinned 额外条：updatedAt 最老先剔（并列 entryId 升序）；
 *   3. 按 兴趣身份 → 性格特质 → 关系态度 → 说话风格，把该维 2 → 1 → 0；
 *   4. 地板：每人只留 1 条说话风格；仍超预算则继续剔非受保护的人。
 *
 * @param {Array<{uid,name,slots,pinned}>} persons
 * @returns {{text:string, perPerson:Array, trimmed:object, selected:string[]}}
 */
export function fitProfileText(persons, {
  budget = L1_BUDGET, maxPeople = MAX_INJECT_PEOPLE,
  protectedIds = null, lastTsByUid = null, log = null
} = {}) {
  const list = (Array.isArray(persons) ? persons : []).filter((p) => p && (p.slots?.length || p.pinned?.length));
  const prot = protectedIds instanceof Set ? protectedIds : new Set([...(protectedIds || [])].map(String));
  const lastTsOf = (uid) => {
    const v = lastTsByUid instanceof Map ? lastTsByUid.get(String(uid)) : lastTsByUid?.[String(uid)];
    return Number(v) || 0;
  };
  const isProt = (p) => prot.has(String(p.uid));

  // ── 选人：lastTs 降序 → uid 升序；受保护无条件保留 ──
  const byRecency = [...list].sort((a, b) => (lastTsOf(b.uid) - lastTsOf(a.uid))
    || String(a.uid).localeCompare(String(b.uid)));
  const protectedPersons = byRecency.filter(isProt);
  const others = byRecency.filter((p) => !isProt(p));
  const room = Math.max(0, maxPeople - protectedPersons.length);
  let selected = [...protectedPersons, ...others.slice(0, room)];
  const trimmed = {
    stage: 'none', droppedUsers: 0, droppedPinned: 0, overCap: false,
    perDim: Object.fromEntries(PROFILE_DIMS.map((d) => [d, PROFILE_PER_DIM]))
  };
  if (selected.length > maxPeople) {
    trimmed.overCap = true;
    try { log?.(`[inject] 受保护人数 ${protectedPersons.length} > ${maxPeople}，按保护优先`); } catch { /* ignore */ }
  }

  // ── 渲染：uid 升序；槽位按维序，pinned 接在后面（与槽内容重复则跳过）──
  // 裁剪只记「被剔的 entryId」，**不改入参对象** —— 同一份 persons 调两次必须同结果。
  const droppedPinned = new Set();
  const render = (cur, { perDim = trimmed.perDim, floor = false } = {}) => {
    const ordered = [...cur].sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
    const perPerson = [];
    const lines = [];
    for (const p of ordered) {
      const contents = [];
      const seen = new Set();
      const styleFirst = (p.slots || []).filter((s) => s.dim === '说话风格');
      const slots = floor
        ? (styleFirst.length ? styleFirst : (p.slots || [])).slice(0, 1)
        : (p.slots || []).filter((s) => (perDim[s.dim] ?? PROFILE_PER_DIM) > 0);
      const dimUsed = {};
      for (const s of slots) {
        const cap = floor ? 1 : (perDim[s.dim] ?? PROFILE_PER_DIM);
        dimUsed[s.dim] = (dimUsed[s.dim] || 0) + 1;
        if (dimUsed[s.dim] > cap) continue;
        if (seen.has(s.content)) continue;
        seen.add(s.content);
        contents.push(s.content);
      }
      let pinnedTaken = 0;
      for (const e of (floor ? [] : (p.pinned || []))) {
        if (droppedPinned.has(String(e.entryId))) continue;
        const c = String(e.content ?? '').trim();
        if (!c || seen.has(c)) continue;        // 与已选槽内容相同 → 不重复注入
        seen.add(c);
        contents.push(c);
        pinnedTaken += 1;
      }
      if (!contents.length) continue;
      perPerson.push({ uid: p.uid, name: p.name, contents, pinnedCount: pinnedTaken });
      for (const c of contents) lines.push(`- ${p.name}：${c}`);
    }
    const text = lines.length ? `${L1_HEADER}\n${lines.join('\n')}` : '';
    return { text, perPerson };
  };

  const fits = (t) => charLen(t) <= budget;
  const finish = (r, stage) => {
    if (stage !== 'none') trimmed.stage = stage;
    return { ...r, trimmed, selected: selected.map((p) => String(p.uid)) };
  };

  let r = render(selected);
  if (fits(r.text) || !r.text) return finish(r, 'none');

  // 档 1：整人剔除（非受保护、无 pinned、lastTs 最早）。
  // ★ 不许剔到「一个人都不剩」：空文本不是「塞下了」，是把记忆整段弄丢。
  const droppable = () => selected
    .filter((p) => !isProt(p) && !(p.pinned?.length))
    .sort((a, b) => (lastTsOf(a.uid) - lastTsOf(b.uid)) || String(a.uid).localeCompare(String(b.uid)));
  while (selected.length > 1) {
    const cand = droppable();
    if (!cand.length) break;
    selected = selected.filter((p) => p !== cand[0]);
    trimmed.droppedUsers += 1;
    r = render(selected);
    if (r.text && fits(r.text)) return finish(r, 'users');
  }

  // 档 2：剔 pinned 额外条（全局最老先剔）
  while (true) {
    const all = [];
    for (const p of selected) {
      for (const e of p.pinned || []) {
        if (!droppedPinned.has(String(e.entryId))) all.push({ p, e });
      }
    }
    if (!all.length) break;
    all.sort((a, b) => ((Number(a.e.updatedAt) || 0) - (Number(b.e.updatedAt) || 0))
      || String(a.e.entryId).localeCompare(String(b.e.entryId)));
    droppedPinned.add(String(all[0].e.entryId));
    trimmed.droppedPinned += 1;
    r = render(selected);
    if (r.text && fits(r.text)) return finish(r, 'pinned');
  }

  // 档 3：按维序把 2 → 1 → 0
  for (const dim of DIM_TRIM_ORDER) {
    for (let cap = PROFILE_PER_DIM - 1; cap >= 0; cap -= 1) {
      trimmed.perDim[dim] = cap;
      r = render(selected);
      if (r.text && fits(r.text)) return finish(r, 'dims');
    }
  }

  // 档 4：地板 —— 每人 1 条说话风格；仍超则继续剔非受保护的人
  r = render(selected, { floor: true });
  if (fits(r.text)) return finish(r, 'floor');
  while (selected.length > 1) {
    const cand = selected.filter((p) => !isProt(p))
      .sort((a, b) => (lastTsOf(a.uid) - lastTsOf(b.uid)) || String(a.uid).localeCompare(String(b.uid)));
    const victim = cand[0] || selected[selected.length - 1];
    selected = selected.filter((p) => p !== victim);
    trimmed.droppedUsers += 1;
    r = render(selected, { floor: true });
    if (fits(r.text)) break;
  }
  return finish(r, 'floor');
}

// ── 注入器（prompt.js 的 ctx.memory）──────────────────────────────────────

const emptySnap = () => ({ text: '', members: {}, userIds: [] });
const warnedDeprecated = new Set();

/**
 * 造一个注入器。返回的对象就是 `ctx.memory`：
 *   `promptSnapshot(chatKey, { userIds, lastTsByUid, protectedIds })`
 *   `formatForPrompt(chatKey, opts)` = `promptSnapshot(chatKey, opts).text`
 *
 * `members` 的形状必须保持 `u:<uid>` + `digests`；`digests` 由 `digest.js` 生成，
 * 否则 `memorySnapshotUsable()` 每轮判「不可用」→ 每轮重建 → 前缀缓存归零。
 * `digests` 由最终注入的正文算（**含 pinned 行**），所以钉住/取消钉住会让快照失效。
 *
 * @param {object} deps
 * @param {object} [deps.peopleStore]  取昵称/发言人/最后发言时间（ChatStore）；缺省用 userId 兜底
 * @param {object} [deps.cfg]          memory.inject 配置块
 * @param {Function} [deps.readL1]     (uid) => entry[]（测试注入）
 * @param {Function} [deps.readProfile] (uid) => profile|null（测试注入）
 * @param {Function} [deps.fallback]   (active) => 兜底槽位（测试注入）
 */
export function createInjectAdapter({
  peopleStore = null, cfg = {}, now = Date.now, readL1 = activePerson,
  readProfile = readProfileFile, fallback = fallbackItems, log = null
} = {}) {
  const budget = Number.isFinite(Number(cfg.l1Budget)) ? Number(cfg.l1Budget) : L1_BUDGET;
  // 废弃键：读到时 warn 一次，不删键（旧配置里还有它们，删了会让 deepMerge 行为变样）
  for (const k of ['interestTopN', 'tailBudget']) {
    if (cfg[k] !== undefined && !warnedDeprecated.has(k)) {
      warnedDeprecated.add(k);
      try { log?.(`[inject] memory.inject.${k} 已废弃（画像固定 2/2/2/2、尾部额度不再使用），忽略`); } catch { /* ignore */ }
    }
  }

  // 昵称缓存：一轮里同一 chatKey 会被问多次（主【记忆】+【新加入成员】）。
  const nameCache = new Map();      // chatKey -> { at, map }
  const NAME_TTL = 60_000;
  // ★ 名字截断到 12 字（与 auto-recall 的渲染口径一致）：一条印象挂一次名字，
  //   8 条就是 8 次；长名片会把 3,250 的预算吃掉一大块。
  const clipName = (s) => [...String(s ?? '')].slice(0, 12).join('');
  const namesOf = (chatKey) => {
    const hit = nameCache.get(chatKey);
    const at = now();
    if (hit && at - hit.at < NAME_TTL) return hit.map;
    const map = new Map();
    try {
      for (const m of peopleStore?.activeMembers?.(chatKey, 500) || []) {
        if (m?.userId) map.set(String(m.userId), clipName(m.name) || String(m.userId));
      }
    } catch { /* 取不到昵称就退回 QQ 号，绝不能因为取名失败拖崩提示词 */ }
    nameCache.set(chatKey, { at, map });
    return map;
  };

  const recentRows = (chatKey, limit) => {
    try { return peopleStore?.recent?.(chatKey, { limit, includeSelf: false }) || []; } catch { return []; }
  };
  // 调用方没给 protectedIds 时的兜底：最近 5 条非本人发言的人（prompt.js 接线后以它给的为准）
  const speakersOf = (chatKey) => new Set(recentRows(chatKey, 5).map((m) => String(m?.senderId || '')).filter(Boolean));
  // 调用方没给 lastTsByUid 时的兜底：最近 50 条里每人最后一次发言
  const lastTsOfChat = (chatKey) => {
    const map = new Map();
    for (const m of recentRows(chatKey, 50)) {
      const uid = String(m?.senderId || '');
      if (!uid) continue;
      const ts = Number(m?.ts) || 0;
      if (ts > (map.get(uid) || 0)) map.set(uid, ts);
    }
    return map;
  };

  const promptSnapshot = (chatKey, { userIds = [], lastTsByUid = null, protectedIds = null } = {}) => {
    // ★ 整段兜底：prompt.js 调这个方法时**没有 try/catch**，而这里要读盘；
    //   一个坏 jsonl / 权限问题就能让整轮回复失败。
    //   记忆再烂也只是「少一段背景」，绝不能拖垮回复 —— 出错就退化成空记忆。
    try {
      const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map((x) => String(x ?? '').trim()).filter(Boolean))];
      if (!ids.length) return emptySnap();

      const names = namesOf(chatKey);
      const prot = protectedIds == null ? speakersOf(chatKey) : new Set([...protectedIds].map(String));
      const lastTs = lastTsByUid == null ? lastTsOfChat(chatKey) : lastTsByUid;

      const persons = [];
      for (const uid of ids) {
        const active = (readL1(uid) || []).filter((e) => e?.status === 'active');
        if (!active.length) continue;                    // 没画像的人不进 members（空 digests 会让快照每轮重建）
        const { slots, pinned } = resolvePersonItems(uid, active, readProfile(uid), { fallback, log });
        if (!slots.length && !pinned.length) continue;
        persons.push({ uid, name: names.get(uid) || uid, slots, pinned });
      }
      if (!persons.length) return emptySnap();

      const fit = fitProfileText(persons, {
        budget, maxPeople: MAX_INJECT_PEOPLE, protectedIds: prot, lastTsByUid: lastTs, log
      });
      if (!fit.text) return emptySnap();

      const members = {};
      const covered = [];
      for (const p of fit.perPerson) {
        members[`u:${p.uid}`] = {
          name: p.name,
          digests: p.contents.map(contentDigest),          // 必须与 digest.js 同源（算法冻结）
          impressions: p.contents
        };
        covered.push(p.uid);
      }
      return { text: fit.text, members, userIds: covered, trimmed: fit.trimmed };
    } catch (error) {
      // ★ 降级必须留痕（§16.7 裁决三）：否则「静默没记忆」会被误判成「这个人没画像」，
      //   排查时会去翻 people/ 而不是看这条日志。日志本身也不能抛。
      try { log?.(`[inject] 渲染失败，退化为空记忆：${error?.message ?? error}`); } catch { /* ignore */ }
      return emptySnap();
    }
  };

  return {
    promptSnapshot,
    formatForPrompt: (chatKey, opts = {}) => promptSnapshot(chatKey, opts).text,
    clearCache: () => nameCache.clear()
  };
}
