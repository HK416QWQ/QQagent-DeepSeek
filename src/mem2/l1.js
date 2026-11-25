// 第 2 期第 3 步：L1 人物档案的提炼编排（分批 → 四维度组 → 时间序覆盖 → 独立语义去重）。
//
// ── 这一层做「编排 + 解析 + 落盘」──────────────────────────────────────────
// 2026-11-15 夜起 refine 逐批落盘（批成功即 appendPerson + 随批 supersede），熔断仍在
// llm.js。落盘入口只有 store.js 的 appendPerson / setPersonStatus（单层单写不变）。
//
// ── 三条不可动的约定（违反任何一条，产物就是错的）─────────────────────────
//   1. **素材只喂原始消息 + 候选池**（§5.1.3）。绝不喂 L4 摘要：
//      说话风格占 36%，靠的就是用词、句长、标点 —— 摘要把这些全丢了。
//      这也是 `refine()` 形参里没有 l4Summary 的原因（§8.1 #9）。
//   2. **语义去重是独立的一次 LLM 调用**（§3.2 ④）。实测 prompt 里写「请归并同义项」
//      几乎无效（14→12、15→13），必须把全部条目单独喂一遍。
//   3. **增量不为增量另造流程**：增量 = 带「已有画像」的分批提炼 + 去重覆盖。
//
// ── 晚期覆盖早期怎么落地（§5.3）──────────────────────────────────────────
// 对照物是**派生画像的 8 个槽位**（不是几十条 active）：每批把槽位放进 system，
// 模型用 `R<k>`（推翻）/ `M<k>`（合并改写）指明要取代第 k 槽，`-` 是补充（每批 ≤3）。
// 写回时把槽 k 的**全部** sourceEntryIds 逐条 superseded，新条目带 op / replaces。
// 覆盖不是靠文本相似度猜的 —— 猜测会把「常聊手游」和「退坑了」判成两条并存。

import fs from 'node:fs';
import { memLlm, tokenBudgetSnapshot } from './llm.js';
import {
  L1_GROUPS, makeL1Entry, makeL1EntryId, makeIndexEntry,
  appendPerson, appendGlobalIndex, setPersonStatus, setPersonDeduped, readPerson, activePerson,
  readCandidates, setCandidateStatus, sweepConflicts
} from './store.js';
import * as P from './paths.js';
import {
  PROFILE_KIND, PROFILE_PROMPT, PROFILE_MAX_SLOTS, PROFILE_MAX_PER_TICK, PROFILE_RETRY_MAX,
  computeDigest, parseProfileOutput, scanSensitive, fillMissingDims, missingDimsOf,
  readProfile, writeProfile, buildProfileInput, emptyProfile, profileToExisting, fallbackItems,
  buildProfileQueue, profileCoverage
} from './profile.js';

/** 一批最多多少条消息（§3.2 ①）。 */
export const BATCH_SIZE = 100;
/** 发言少于这个数不做 L1 提炼（§5.1.3 的边界）。 */
export const MIN_MSGS_FOR_L1 = 30;
/** 熔断 kind：必须和 kindQuota 里登记的一模一样，拼错会走兜底配额。 */
export const L1_KIND = 'l1-refine';

// ── 触发条件（§3.3）────────────────────────────────────────────────────────
/** ① 未提炼消息累积到这么多条就提炼。 */
export const TRIGGER_MSG_THRESHOLD = 80;
/** ② 距上次提炼超过这么多天… */
export const TRIGGER_STALE_DAYS = 7;
/** ② …且新增消息不少于这么多条（双保险：只按时间会在活跃者身上白跑）。 */
export const TRIGGER_NEW_MSG_MIN = 25;
/** 候选池兜底：最老 pending 超过这么多天就单独跑一次小调用。 */
export const CANDIDATE_MAX_AGE_DAYS = 7;
/** 单轮最多处理几个人（40 次配额 ÷ 每人约 2 次 = 20，留余量取 15）。 */
export const MAX_PEOPLE_PER_TICK = 15;

const DAY_MS = 86400000;

const REFINE_MAX_TOKENS = 1500;
const DEDUP_MAX_TOKENS = 4000;      // 2026-11-16 事故修正：60 行 × ~40 token ≈ 2400，留余量（原 1500 只够 20 行）
/** 去重单次喂多少条（实测：60 条 → 模型回 18 组、覆盖 60/60；386 条 → 只回 4 组）。 */
const DEDUP_CHUNK = 60;
/** 单次输入的字数预算：60 条短条目 ≈ 9.1K 字是实测能吃下的量；第二轮起条目变长，按字数切才能保住覆盖率。 */
const DEDUP_CHUNK_CHARS = 9000;
/** 坍缩阀覆盖率下限：一片里被输出序号覆盖到的输入低于这个比例 = 模型没穷举 → 放弃写回。 */
const DEDUP_MIN_COVERAGE = 0.8;
/** 分片归并最多几轮（386 → 126 → ~100 → ~35 需 3~4 轮；上限只防死循环）。 */
const DEDUP_MAX_ROUNDS = 5;
/** 单次提炼最多产出几条（防止模型把每句话都摘成一条）。 */
const MAX_ITEMS_PER_BATCH = 12;
/** 每批「-」补充条上限（L1 收敛 §5.2）：目标是维护 8 条画像，不是无限追加。 */
export const MAX_SUPPLEMENT_PER_BATCH = 3;
/** 候选兜底每片最多几条提议（L1 收敛 §7.3：按群分组后再切片）。 */
export const CANDIDATE_CHUNK = 10;
/** ⑤ 【本次已产出】展示截断：最近多少条给全文（更早的只保留编号）。 */
const RUN_SECTION_FULL = 60;
/** ⑤ 单条 content 展示上限（字），超出截断加省略号。 */
const RUN_SECTION_CONTENT_MAX = 40;

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** 只清名字里的 C0/DEL；正文可能含换行/制表，不能走这里。 */
const stripCtrl = (s) => String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, '');

const pad2 = (n) => String(n).padStart(2, '0');

/** 只取 MM-DD，给批次内的天分隔行用。 */
function dayOf(ts) {
  const d = new Date(Number(ts) || 0);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 提炼提示词。
 *
 * §4 的四个要点逐条写在这里：允许跨组、归纳而非摘录、允许「先不记」、增量给对照。
 * 输出用行式而不是 JSON —— 中文 JSON 转义最容易出错，而行式解析坏一行只丢一条。
 */
export const REFINE_PROMPT = `你是群聊观察者。下面是这个人的 **最多 8 条注入画像**，你的任务是维护它，不是把印象写到几十条。

输出格式（每条一行，四段，不要解释、不要 markdown）：
<op> || <印象内容> || <维度组，1~3 个用英文逗号分隔> || <支撑这条印象的行首编号，英文逗号分隔，如 3,7；归纳性印象写 ->
- 槽位编号和消息行号是两套编号，不要混用：第 4 段是消息行号，不是槽位编号。

op 只有三种：
- \`-\`：补充一条新印象。**每批最多 3 条**。
- \`R<k>\`：新证据**推翻或矛盾**了【已有画像】第 k 条 —— 用新内容取代它。
- \`M<k>\`：第 k 条仍然成立，但需要合并新信息并改写 —— 用改写后的内容取代它。
- 没有新信息 → 整批**只输出 SKIP 四个字母**，不要输出任何别的行。

编号范围（写死，不许越界）：
- 【已有画像】里 1..M 是实际槽位（M ≤ 8），**R/M 只允许引用这些槽位编号**。
- M+1..N 是「钉住条目（只读）」，由用户手工维护：**只读，不得引用、不得改写**。
- 引用了不存在的编号，整行会被丢弃。
- 【已有画像】为空（M=0）时，禁止输出 R<k>/M<k>；只能输出 \`-\` 补充或 SKIP。
  R/M 只允许引用 1..M 的真实槽位，引用不存在/钉住条目整行丢弃。
- 补充条数硬上限 3 条。超过 3 条时请自行合并、取舍，**不要输出第 4 条 supplement**；
  超出的行会被解析器丢弃，等于白写。

四个维度组（必须用这几个词，不许自造）：
- 说话风格：用词习惯、句长、标点、口头禅、语气（例：爱用波浪号拖长音，几乎不打句号）
- 兴趣身份：玩什么、看什么、做什么、身份角色（例：玩坦克世界，自称德系玩家）
- 关系态度：跟谁熟、怎么称呼谁、对谁什么态度（例：和群主互怼但关系好）
- 性格特质：稳定的人格倾向（例：嘴上嫌弃但愿意帮忙）

规则：
- **归纳，不是摘录**。要写「他是什么样的人」，不要复述他说过的话。
- 每条只挂 1~3 个维度组；跨维度是常见的，不要为了单标签硬塞。
- 每批总行数最多 ${MAX_ITEMS_PER_BATCH} 行（含 R/M），其中补充最多 3 条；超出的行会被丢弃。
- **允许一条都不写**：这段没什么信息就只输出 SKIP。宁缺毋滥 ——
  「他好像话不多」「今天聊了几句」这类废话一律不要写。
- 涉及具体事情时，只写**能反映稳定特点**的部分。
  **一次性的计划和日程不要写**：下周要去哪、明天要做什么、这周末约了谁 —— 这类事过几天就失效，
  写进画像会让机器人在别的群提起不相干的事。
  生日、纪念日、固定作息、长期习惯这类**有周期性或长期有效**的可以写，但只写日期或规律本身
  （写「11-20 生日」，不要写「他提到下周三要过生日」——后者把一次性的聊天场景也捆进去了）。
- 政治敏感话题只写**中性的社交表现**（例：「爱讲苏联笑话调侃，会自我说"我说的是勃列日涅夫"来打掩护」），
  不写具体立场、具体段子、对具体人物的评价。这条和角色卡里「绝对不参与鉴证/见政」是两层：
  角色卡管它怎么说，这里管我们记什么——记忆里不该存着「谁的政治立场是什么」。
- 支撑消息用**行首的编号**（#3 就是第 3 条），英文逗号分隔；归纳性印象写 - 。
- 不要为了用 R 而硬找冲突：语气变了、程度变了都算补充（-），不算推翻。
- 已有画像里已经写过的意思，不要再用 - 重复产出；要更新就用 M<k>。`;

/** 去重（归并）提示词。单独一次调用，不重读原文。
 *
 * 2026-11-16 事故修正（§16.5）：
 *   ① 「最多 20 行」是按「一人二三十条」的老规模定的，386 条输入被硬压到 3 条 → 改 60；
 *   ② 输出必须回显**输入序号**，代码按序号精确 supersede —— 只标被列出的，不搞一刀切；
 *   ③ 明确要求「每一条输入都要出现在输出里」（合并成一行时列出全部源序号），
 *      漏掉 = 那条内容会消失（外加代码侧的坍缩阀兜底）。
 */
export const DEDUP_PROMPT = `下面是一组对同一个人的印象条目，可能有多条在说同一件事。请合并语义重复的条目。

输出格式（每条一行，最多 60 行，不要解释、不要 markdown）：
- <这一组在输入里的序号，英文逗号分隔，如 2,7,15> || <合并后的印象内容> || <维度组，1~3 个，英文逗号分隔> || <消息 id，用英文逗号分隔，没有写 ->

规则：
- **每一条输入都必须出现在输出里**：要么在这一组的序号列表里被合并，要么单独成一行。绝不允许丢弃任何输入。
- 说的是同一件事就合成一条，措辞取信息量更大的那版，不要简单拼接。
- **保留最新的说法**：如果两条互相矛盾（以前常聊手游 / 已经退坑了），只留新的那条，但旧的那条序号仍要列进这一组。
- 不同维度的事即使沾边也不要合并（「爱用波浪号」和「爱玩手游」是两件事）。
- 合并后仍要保留维度组标签；被合并的条目若挂了不同组，取并集但不超过 3 个。
- 序号必须来自输入里的编号，不许自造；不要新增下面没有的信息。
- 条目多的时候（几十条）也照此办理：**输出行数 ≈ 合并后的组数，不是输入条数**，但每个输入序号都要有归属。`;

/**
 * 候选池兜底（T6）用的小提示词 —— **不是** REFINE_PROMPT 的变体。
 *
 * 为什么单独开一个：正常提炼要求「未提炼 ≥30 条消息」才跑（`MIN_MSGS_FOR_L1`），
 * 而兜底场景恰恰是「这个人不再发言、永远凑不够条数」。硬套 refine 会先去撞
 * too-few-messages，再改阈值就等于把提炼门槛偷偷调低 —— 那是两件不同的事。
 *
 * 口径（§5.1.7）：候选池的价值在**带回上下文**。所以这里喂的不是「提议本身」，
 * 而是「提议 + 它出现时的原话前后若干条」，让模型能看出当时是玩笑还是认真。
 */
export const CANDIDATE_PROMPT = `你是群聊观察者。下面是群友点名要求记下（或你自己当时觉得该记）的几条「提议」，以及它们出现时的原话上下文。请判断每一条是否真的该进这个人的档案。

输出格式（每行一条，四段，不要解释、不要 markdown）：
- || <印象内容> || <维度组，1~3 个，英文逗号分隔> || -

规则：
- **只允许 \`-\`（补充）**：候选兜底没有槽位上下文，**不要输出 R/M**（输出了整行会被丢弃）。
- 第四段固定写 \`-\`：候选的出处由候选池留痕，不需要你再抄消息编号。
- 维度组只能是：说话风格、兴趣身份、关系态度、性格特质。
- **玩笑、反讽、玩梗、斗嘴都不算事实**——原话上下文能看出来，看不出来说明证据不足，丢弃。
- 「以后叫我 X」这类改口：只有上下文里确实开始这么用了才记，否则丢弃。
- 一条提议最多产出 1 条印象。可以改写得更准确，但**不要扩写**成没说过的事。
- 全部都不该记时，只输出 SKIP。`;

/**
 * 按时间切批（§3.2 ①）。每批 ≤maxPerBatch 条。
 * 返回的每批自带 startTs/endTs —— 它们是 sourceBatch 的来源，也是覆盖判断的时间依据。
 */
export function buildBatches(messages, maxPerBatch = BATCH_SIZE) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.ts || m.mid))
    .slice()
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  const n = Math.max(1, Number(maxPerBatch) || BATCH_SIZE);
  const out = [];
  for (let i = 0; i < list.length; i += n) {
    const slice = list.slice(i, i + n);
    out.push({
      messages: slice,
      startTs: Number(slice[0]?.ts) || 0,
      endTs: Number(slice[slice.length - 1]?.ts) || 0
    });
  }
  return out;
}

/**
 * 把一批消息渲染成模型可读的文本。
 *
 * 2026-11-15：去掉逐条时间戳（每条省 12 字符，实测占输入的 30%），mid 换成批次内序号。
 * 时间序由数组顺序表达，跨天只打一行 `--- MM-DD ---`；溯源靠返回的 idMap（序号→mid），
 * 比原来的「模型抄 10 位 mid 字符串」更可靠（不会有碰撞、也不会抄错一位）。
 *
 * @returns {string|{text:string,idMap:Map<string,string>}} 默认返回 string；withIdMap=true 时返回对象
 */
export function formatBatchMessages(messages, { withIdMap = false } = {}) {
  const lines = [];
  const idMap = new Map();      // 序号(字符串) → 真实 mid
  let day = '';
  let seq = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const dd = dayOf(m?.ts);
    if (dd !== day) { day = dd; lines.push(`--- ${dd} ---`); }
    seq += 1;
    if (m?.mid) idMap.set(String(seq), String(m.mid));
    const body = flat(m?.text) || '（无文字）';
    lines.push(`#${seq} ${body}`);
  }
  const text = lines.join('\n');
  return withIdMap ? { text, idMap } : text;
}

/** 已有画像 → 带编号的对照列表。槽位 1..M 可被 R/M 引用；其后的钉住条目只读。 */
export function formatExisting(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '（这是第一次提炼，没有已有画像）';
  const slots = list.filter((e) => !e?.readOnly);
  const pinned = list.filter((e) => e?.readOnly);
  const lines = slots.map((e, i) => `${Number(e.index) || i + 1}. [${(e.groups || []).join(',')}] ${e.content}`);
  if (pinned.length) {
    lines.push('', `钉住条目（只读，编号 ${slots.length + 1}..${list.length}，不得引用、不得改写）：`);
    pinned.forEach((e, i) => {
      lines.push(`${Number(e.index) || slots.length + i + 1}. [只读][${(e.groups || []).join(',')}] ${e.content}`);
    });
  }
  return lines.join('\n');
}

/** 候选池条目 → 提示区（群友点名要求记的东西，优先级不等于特权）。 */
export function formatCandidates(candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c?.text);
  if (!list.length) return '';
  return `\n\n群友在这段时间里点名提过、希望你记住的事（只是线索，不一定成立，也允许判断为玩笑）：\n${list
    .map((c) => `- ${flat(c.text)}`)
    .join('\n')}`;
}

// ── 行式解析 ───────────────────────────────────────────────────────────────

/** 把 `a,b` / `a、b` 拆成数组，过滤空与占位。 */
function splitList(val) {
  return String(val ?? '')
    .split(/[,，、|]/)
    .map((x) => x.trim())
    .filter((x) => x && x !== '-' && x !== '—');
}

/**
 * 解析提炼输出（L1 收敛 §5.2：四段 `<op> || <content> || <groups> || <msgIds>`）。
 *
 * op ∈ { '-', 'R<k>', 'M<k>' }。旧三段格式（首段是正文）**不再接受** —— 提示词已换，
 * 再兼容就等于让两种语义同时落盘。未知 op / R0 / M0 / 非数字 → 整行丢弃计 badOp。
 *
 * 两道硬上限（超出进 overflow，不静默丢）：总行数 MAX_ITEMS_PER_BATCH(12)、补充 3 条。
 * R/M 不占补充名额。k 的**范围**不在这里猜（解析器只收正整数），写回时按 existing 校验。
 *
 * SKIP 判定收紧：只有整段 trim 后恰好等于 SKIP（不区分大小写）才算跳过；
 * 正文中间出现 SKIP 行只当普通无效行忽略，不影响其余条目。
 *
 * @param {object} [opts] onlySupplement=true 用于候选兜底（没有槽位上下文，R/M 必然指错）
 * @returns {{items:Array, skip:boolean, overflow:number, badOp:number, raw:string,
 *            overflowLines:Array<{reason:string, rawLine:string}>}}
 */
export function parseRefineOutput(text, { onlySupplement = false } = {}) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  const items = [];
  const overflowLines = [];
  let overflow = 0;
  let badOp = 0;
  let supplements = 0;
  const drop = (reason, line) => { overflowLines.push({ reason, rawLine: line }); };

  if (/^SKIP$/i.test(raw.trim())) {
    return { items: [], skip: true, overflow: 0, badOp: 0, raw, overflowLines: [] };
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^SKIP$/i.test(t)) continue;                 // 正文里的 SKIP 行：普通无效行
    const parts = t.split(/\s*(?:\|\||‖)\s*/).map((x) => x.trim());
    if (parts.length < 3) { badOp += 1; drop('badOp', line); continue; }

    const opText = parts[0];
    let op = '';
    let replace = 0;
    if (opText === '-' || opText === '—' || opText === '*') {
      op = 'supplement';
    } else {
      const m = /^([RM])\s*(\d+)$/i.exec(opText);
      if (m && Number(m[2]) > 0) {
        op = m[1].toUpperCase() === 'R' ? 'replace' : 'merge';
        replace = Number(m[2]);
      }
    }
    if (!op || (onlySupplement && op !== 'supplement')) {
      badOp += 1; drop('badOp', line); continue;
    }
    const content = flat(parts[1]);
    const groups = splitList(parts[2]).filter((g) => L1_GROUPS.includes(g));
    if (!content || !groups.length) { badOp += 1; drop('badOp', line); continue; }

    if (items.length >= MAX_ITEMS_PER_BATCH) { overflow += 1; drop('overflow-total', line); continue; }
    if (op === 'supplement') {
      if (supplements >= MAX_SUPPLEMENT_PER_BATCH) { overflow += 1; drop('overflow-supplement', line); continue; }
      supplements += 1;
    }
    items.push({
      op,
      replace,
      content,
      groups: [...new Set(groups)].slice(0, 3),
      msgIds: splitList(parts[3]),
      rawLine: line
    });
  }
  return { items, skip: false, overflow, badOp, raw, overflowLines };
}

/**
 * 解析去重输出（四段：输入序号 / 内容 / 组 / 消息 id）。
 *
 * 2026-11-16：格式从三段改成四段 —— 首段是**输入序号列表**，代码据此精确 supersede
 * 被列出的原条目（旧格式没有归属信息，只能一刀切，是 386→3 事故的直接成因之一）。
 * 序号越界的行整行丢弃并计入 bad（与 badMsgIds 同范式）。
 *
 * @returns {{items:Array<{idxs:number[], content:string, groups:string[], msgIds:string[]}>, bad:number}}
 */
export function parseDedupOutput(text) {
  const items = [];
  let bad = 0;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.replace(/^\s*[-*·]\s*/, '').trim();
    if (!t || /^SKIP$/i.test(t)) continue;
    const parts = t.split(/\s*(?:\|\||‖)\s*/).map((x) => x.trim());
    if (parts.length < 2) continue;
    const idxs = splitList(parts[0])
      .map((s) => Number(String(s).replace(/^#/, '')))
      .filter((n) => Number.isInteger(n) && n > 0);
    const content = flat(parts[1]);
    if (!content) continue;
    if (!idxs.length) { bad += 1; continue; }   // 没有归属序号 = 无法回写状态，整行丢
    const groups = splitList(parts[2] || '').filter((g) => L1_GROUPS.includes(g));
    items.push({
      idxs: [...new Set(idxs)],
      content,
      groups,
      msgIds: splitList(parts[3] || '')
    });
  }
  return { items, bad };
}

// ── 扫描游标（L1 收敛 §7.1）──────────────────────────────────────────────
//
// 为什么需要它：SKIP / 空输出是「模型看过了，判定没东西可记」，但旧实现不落任何痕迹，
// 同一批消息下一个槽原样重发 —— 每天 4 次白烧配额。游标把「已扫到这儿」记下来，
// 与条目水位（sourceBatch.endTs）取最大值作为有效水位。
// ★ 只在「成功返回且整段 SKIP」或「成功返回且原文为空」时推进；
//   调用失败 / 非空但解析 0 条 / aborted / 异常一律不动（后者要重发，不能悄悄丢消息）。

/** 读游标（坏文件按空处理，不抛）。 */
export function readScanCursor() {
  try {
    const j = JSON.parse(fs.readFileSync(P.l1ScanFile(), 'utf8'));
    if (j && typeof j === 'object' && j.cursor && typeof j.cursor === 'object') return j.cursor;
  } catch { /* 缺失或损坏 → 空游标 */ }
  return {};
}

/** 原子写游标（只由 l1.js 写）。 */
export function writeScanCursor(cursor) {
  P.writeJsonAtomic(P.l1ScanFile(), { v: 1, cursor: cursor || {} });
}

/** 把某人在某群的游标推进到 endTs（只前进不后退）。 */
function advanceScanCursor(userId, chatKey, endTs, log = () => {}) {
  const uid = String(userId || '').trim();
  const key = String(chatKey || '').trim();
  const ts = Number(endTs) || 0;
  if (!uid || !key || ts <= 0) return false;
  const cursor = readScanCursor();
  const mine = cursor[uid] || (cursor[uid] = {});
  if ((Number(mine[key]) || 0) >= ts) return false;
  mine[key] = ts;
  writeScanCursor(cursor);
  log(`[l1] ${uid} 群=${key} SKIP → 扫描游标推进到 ${clockOf(ts)}`);
  return true;
}

/** 溢出 / 坏行审计（append-only，永不注入）。 */
function appendOverflowAudit({ uid, batch, reason, rawLine, at }) {
  try {
    P.appendLine(P.l1OverflowFile(), {
      at: Number(at) || Date.now(),
      uid: String(uid || ''),
      batch: {
        chatKey: String(batch?.chatKey || ''),
        startTs: Number(batch?.startTs) || 0,
        endTs: Number(batch?.endTs) || 0
      },
      reason: String(reason || ''),
      rawLine: String(rawLine ?? '')
    });
  } catch { /* 审计写失败不该影响提炼主链路 */ }
}

/**
 * 取「已有画像」的槽位视图（refine / refineCandidates 共用）。
 * 有 profile 就用它；没有就用确定性兜底槽位，并告诉调用方画像该重建了。
 * ★ 绝不把几十条 active 整份喂进去：那正是 token 与注意力双双撑不住的形态。
 */
function existingSlotsFor(userId, activeEntries) {
  const active = Array.isArray(activeEntries) ? activeEntries : [];
  const profile = readProfile(userId);
  if (profile && Array.isArray(profile.slots) && profile.slots.length) {
    return { existing: profileToExisting(profile, active), profileFallback: false };
  }
  return {
    existing: profileToExisting({ slots: fallbackItems(active) }, active),
    profileFallback: active.length > 0
  };
}

/**
 * 提炼一个人（§3.2 四步全流程）。
 *
 * 2026-11-15：改成**按人**提炼 —— `person` 里没有 chatKey，只有 `userIds` 级别的身份
 * 和他出现过的群列表。批次自带群（`buildBatchesByChat`），`sourceBatch.chatKey` 取批次的那个。
 *
 * 2026-11-15 夜（第 3 期前置 §16.2）：改成**逐批落盘** ——
 * 每批 LLM 成功 → 本批条目立即 appendPerson（落盘即水位推进，sourceBatch.endTs 天然按群）；
 * 失败/配额拒 → 本批止步，已落盘的保留，下 tick 续跑。R/M 的 supersede 也随批写盘。
 * 语义去重定在 **run 末尾**，写回顺序：
 * 先 append 合并条（deduped:true）再 supersede 原条目 —— 中途崩溃下轮自愈。
 *
 * @param {object} person { userId, nickname?, chatKeys?[] }
 * @param {object} opts
 * @param {Array}  opts.rawMessages 该人未提炼的原始消息（**只传这个，不传摘要**）
 * @param {Array}  [opts.candidates] 指向他的候选池 pending 条目
 * @param {Array}  [opts.existing]   槽位视图（不传则从 profile / 兜底槽位现读）
 * @param {Function} [opts.memLlmImpl] 测试注入（默认就是真熔断出口）
 * @returns {Promise<{ok:boolean, reason?:string, stats?:object}>}
 *   stats.added = 落盘条数（含合并条）；stats.superseded = 写盘的覆盖数；stats.produced = 最终 active 条数。
 */
export async function refine(person, {
  rawMessages = [], candidates = [], existing = null,
  memLlmImpl = memLlm, now = Date.now(),
  callsLeft = Number.POSITIVE_INFINITY, log = () => {}
} = {}) {
  const userId = String(person?.userId || '').trim();
  if (!userId) return { ok: false, reason: 'bad-person' };

  let exactSuperseded = 0;
  let exactGroups = 0;
  let supersededCount = 0;
  // ★ A2：确定性去重不花调用，必须放在预算闸门前；放在这里还能在
  //   “本轮一条都不炼”（too-few / callsLeft=0）时收掉历史遗留的完全重复。
  const exactCleanup = (label = '') => {
    const x = collapseExactDuplicates(userId, { now });
    if (x.superseded) {
      exactSuperseded += x.superseded;
      exactGroups += x.groups;
      supersededCount += x.superseded;
      log(`[l1] 确定性去重${label ? `（${label}）` : ''}：${x.groups} 组内容完全相同，`
        + `留最新、supersede ${x.superseded} 条（零调用）`);
    }
    return x;
  };
  exactCleanup('提炼前');

  const msgs = (Array.isArray(rawMessages) ? rawMessages : []).filter((m) => !m?.self);
  if (msgs.length < MIN_MSGS_FOR_L1) {
    return {
      ok: false, reason: 'too-few-messages', msgCount: msgs.length,
      stats: {
        calls: 0, added: 0, superseded: exactSuperseded,
        exactSuperseded, exactGroups, produced: activePerson(userId).length
      }
    };
  }

  // 按群分组切批：一批只来自一个群 → sourceBatch.chatKey 唯一准确，水位天然按群推进
  const batches = buildBatchesByChat(msgs);
  const call = (messages, maxTokens) => memLlmImpl(L1_KIND, { messages, maxTokens, now });

  // ★ existing = 派生画像的 8 个槽位（A 方案）。active 全量留在盘上做审计，
  //   但**不再整份喂给模型**。无 profile（首轮 / 文件被删）→ 确定性兜底槽位，
  //   画像标脏，本轮结束的压缩会重建。
  const personNow = readPerson(userId);
  const activeAll = personNow.list.filter((e) => e.status === 'active');
  const byId = personNow.byId || new Map(personNow.list.map((e) => [e.entryId, e]));
  let existingList;
  let profileFallback = false;
  if (Array.isArray(existing)) {
    existingList = existing;
  } else {
    const got = existingSlotsFor(userId, activeAll);
    existingList = got.existing;
    profileFallback = got.profileFallback;
  }
  // 槽位编号 1..M 是实际槽位，M+1..N 是 pinned 只读区（formatExisting 已标注）。
  const entries = [];             // 本轮产出（**已逐批落盘**，deduped:false）
  const runPool = [];             // 【本次已产出】展示用（只进 user，不进 system）
  const supersededSet = new Set(); // 已随批写盘 superseded 的旧条目 id（防同一目标写两行）
  let addedCount = 0;             // 落盘条数（批内条目 + 末尾合并条）

  // ★ system 只放磁盘上的已有画像，绝不放本批产出。
  //   一旦放进去，system 每批都不同，前缀缓存一次都命中不了 —— 而代码看起来完全正确。
  const slotCount = existingList.filter((e) => e.readOnly !== true).length;
  const totalCount = existingList.length;
  const slotRule = slotCount === 0
    ? '【槽位编号】M=0：没有可引用槽位，禁止输出 R/M；只能输出 - 补充或 SKIP。第 4 段是消息行号，不是槽位编号。'
    : `【槽位编号】M=${slotCount}，编号 1..${slotCount} 为可引用槽位（来源含用户钉住的仍会被忽略）；`
      + (totalCount > slotCount ? `钉住只读区 ${slotCount + 1}..${totalCount} 不得引用；` : '')
      + '第 4 段是消息行号，不是槽位编号。';
  const systemText = `${REFINE_PROMPT}\n\n${slotRule}\n\n【已有画像】（R/M 的编号就是这里的序号）\n${formatExisting(existingList)}`;

  let seq = 0;
  let callCount = 0;
  let skippedBatches = 0;
  let overflowCount = 0;
  let badOpCount = 0;
  let badRefCount = 0;          // R/M 指到不存在的序号
  let pinnedRefIgnored = 0;     // R/M 指到钉住条目 → 整条忽略（不冲突、不覆盖）
  let zeroParsed = 0;           // 原文非空却解析出 0 条 → 游标不动，下槽重发
  let cancelledInBatch = 0;     // 同批内被后来的 R/M 取消的未落盘条目（防同一槽双活）
  // 模型引用了不存在的消息编号的次数。>0 说明提示词没教明白或批次太长。
  let badMsgIds = 0;

  const failStats = () => ({
    batches: batches.length, calls: callCount, added: addedCount,
    superseded: supersededCount, skippedBatches, badMsgIds, msgCount: msgs.length,
    overflow: overflowCount, badOp: badOpCount, badRef: badRefCount,
    pinnedRefIgnored, zeroParsed, profileFallback,
    exactSuperseded, exactGroups,
    produced: readPerson(userId).list.filter((e) => e.status === 'active').length
  });

  for (let bi = 0; bi < batches.length; bi += 1) {
    // ★ ⑥ 预算放在**批边界**（2026-11-16 事故修正）：原先只在 sweepPeople 的人边界检查，
    //   一个人 42 批就能烧穿 maxCallsPerTick。aborted 不是失败：已落盘批次保留、水位已推进，
    //   下 tick 从断点续跑（与逐批落盘语义一致）。
    if (callCount >= callsLeft) {
      exactCleanup('预算中断');
      return { ok: true, aborted: true, stats: failStats() };
    }
    const batch = batches[bi];
    const batchChatKey = String(batch.chatKey || '');
    const head = batches.length > 1
      ? `以下是第 ${bi + 1}/${batches.length} 批原话（${batch.messages.length} 条）。`
      : `以下是这位群友的原话记录（${batch.messages.length} 条）。`;
    const fmt = formatBatchMessages(batch.messages, { withIdMap: true });
    // ⑤ 【本次已产出】展示截断（2026-11-16 事故修正）：42 批的人，第 42 批要背前面全部产出，
    //    实测单次 7,953 token（估 2,262 的 3.5 倍）、峰值 25,159 —— token 就是这么涨上去的。
    //    规则：最近 60 条给全文，更早的只报条数；单条 content 超 40 字截断展示。
    //    ★ 这里**不给编号**：R/M 的编号只属于 system 里的 1..M 槽位，
    //      给本次产出编号就等于默许模型引用它们（越界 → badRef，白丢一行）。
    const runSection = () => {
      if (!runPool.length) return '';
      const n = runPool.length;
      const from = Math.max(0, n - RUN_SECTION_FULL);
      const lines = [];
      if (from > 0) lines.push(`（另有 ${from} 条较早产出，内容已略）`);
      for (let i = from; i < n; i += 1) {
        const e = runPool[i];
        const text = e.content.length > RUN_SECTION_CONTENT_MAX
          ? `${e.content.slice(0, RUN_SECTION_CONTENT_MAX)}…`
          : e.content;
        lines.push(`· [${e.groups.join(',')}] ${text}`);
      }
      return `\n\n【本次已产出】（只读参考，避免重复写同一个意思；不可用 R/M 引用）\n${lines.join('\n')}`;
    };
    const user = `${head}${formatCandidates(candidates)}${runSection()}\n\n原话记录：\n${fmt.text}`;
    const r = await call(
      [{ role: 'system', content: systemText }, { role: 'user', content: user }],
      REFINE_MAX_TOKENS
    );
    callCount += 1;
    if (!r?.ok) {
      // ★ 逐批落盘：本批止步。已落盘的批次保留（水位已推进），下 tick 从水位续跑。
      exactCleanup('调用失败');
      return { ok: false, reason: r?.reason || 'call-error', stats: failStats() };
    }

    const parsed = parseRefineOutput(r?.result?.message?.content);
    const batchRef = { chatKey: batchChatKey, startTs: batch.startTs, endTs: batch.endTs };
    const auditDrop = (reason, rawLine) => appendOverflowAudit({ uid: userId, batch: batchRef, reason, rawLine, at: now });

    // 整段 SKIP：本批确实没有新信息 → 推进扫描游标，否则同一批每个槽都重发（§7.1）
    if (parsed.skip) {
      skippedBatches += 1;
      advanceScanCursor(userId, batchChatKey, batch.endTs, log);
      continue;
    }

    // 不允许静默丢：溢出 / 坏 op 一律日志 + 审计行 + stats（§5.2）
    if (parsed.overflow || parsed.badOp) {
      overflowCount += parsed.overflow;
      badOpCount += parsed.badOp;
      const n = parsed.overflow + parsed.badOp;
      log(`[l1] 解析溢出：uid=${userId} 丢弃 ${n} 行（overflow=${parsed.overflow} badOp=${parsed.badOp}）`);
      for (const d of parsed.overflowLines) auditDrop(d.reason, d.rawLine);
    }

    if (!parsed.items.length) {
      if (!String(parsed.raw || '').trim()) {
        skippedBatches += 1;
        advanceScanCursor(userId, batchChatKey, batch.endTs, log);
      } else {
        // 非空却一条都没解析出来：游标不动，下槽原样重发（有配额代价，必须可见）
        zeroParsed += 1;
        log(`[l1] 解析 0 条但原文非空，游标不动（下槽重发）${userId} 群=${batchChatKey}`);
      }
      continue;
    }

    // 批成功才统一落盘 —— 半批产出不会出现。
    const pending = [];
    const pendingById = new Map();   // 同批刚产出、尚未落盘的条目（可被同批后面的 R/M 取消）
    for (const item of parsed.items) {
      // R/M 只认 system 里的槽位编号 1..M；越界 / 钉住 → 整条不落盘
      let target = null;
      let replaces = [];
      let slotIdx = 0;             // 命中的槽位序号（1..M），用于批内回写
      if (item.op !== 'supplement') {
        const k = item.replace;
        if (k < 1 || k > existingList.length) {
          badRefCount += 1;
          log(`[l1] 忽略越界的 R/M（${userId}, ${k}）：槽位只有 ${existingList.length} 条`);
          auditDrop('badRef', item.rawLine);
          continue;
        }
        slotIdx = k;
        target = existingList[k - 1];
        const sources = (target.sourceEntryIds || []).map((id) => byId.get(id)).filter(Boolean);
        // ★ pinned 保护（红线 8）：槽位来源含 pinned，或编号落在只读区 → **忽略**。
        //   不能 markConflict：那会把 pinned 改成 conflicted，activePerson 只取 active，
        //   等于用户钉住的条目被一次提炼直接停注入。
        if (target.readOnly === true || sources.some((e) => e.pinnedByUser === true)) {
          pinnedRefIgnored += 1;
          log(`[l1] 忽略指向钉住条目的 R/M（${userId}, ${k}）`);
          continue;
        }
        // 目标是槽 k 的**全部**来源条目（一个槽可能压了多条 active）
        for (const id of (target.sourceEntryIds || [])) {
          replaces.push(id);
          if (supersededSet.has(id)) continue;
          // ★ 同批双 R（2026-11-17 复核补）：同一条回复里两条 `R1`，第一条把槽指向
          //   刚产出但**还没落盘**的条目，第二条再指向它时 setPersonStatus 写不到（文件里没有），
          //   结果两条都 active、同一槽双活。这里直接作废未落盘的那条：
          //   不写盘就不存在，不需要 superseded 行，也不进 entries/runPool。
          const pend = pendingById.get(id);
          if (pend && pend.status === 'active') {
            pend.status = 'superseded';
            cancelledInBatch += 1;
            // 血统接回：本条的 replaces 里那条「被取消的 A」不存在，换成 A 自己取代的前驱，
            // 否则 replaces 会指向一个永远查不到的 entryId（溯源断链）。
            const at = replaces.indexOf(id);
            if (at >= 0) replaces.splice(at, 1);
            for (const pid of (pend.replaces || [])) if (!replaces.includes(pid)) replaces.push(pid);
            log(`[l1] 同批第 ${k} 槽被再次改写：取消刚产出未落盘的条目 ${id}`);
            continue;
          }
          const wrote = setPersonStatus(userId, id, 'superseded', { nowTs: now });
          if (wrote) {
            supersededSet.add(id);
            supersededCount += 1;
          }
        }
      }

      // ★ 序号 → 真实 mid。模型可能写 #3 或 3，两种都要容错；对不上的直接丢，
      //   绝不让 "3" 这种序号混进 sourceMsgIds（那等于存了废数据）。
      //   存**裸 mid**（不带 #）：# 是渲染层装饰，存进去会让 sourceMsgIds.includes(mid) 永假。
      const sourceMsgIds = [];
      for (const s of item.msgIds) {
        const k = String(s).replace(/^#/, '').trim();
        const mid = fmt.idMap.get(k);
        if (mid) sourceMsgIds.push(mid);
        else badMsgIds += 1;
      }

      // 来源群 = 本批的群 ∪ 被它取代的槽位的来源群。只写「有原话支撑的群」——
      // 写成「他待过的所有群」会让溯源失真（A 群说的变成 A/B/C 群都说）。
      const batchChatKeys = [...new Set(batch.messages.map((m) => m._chatKey).filter(Boolean))];
      const sourceChatKeys = [...new Set([...batchChatKeys, ...(target?.sourceChatKeys || [])])];

      seq += 1;
      const entry = makeL1Entry({
        entryId: makeL1EntryId({ userId, at: batch.endTs || now, seq }),
        chatKey: batchChatKey, userId,
        sourceBatch: {
          chatKey: batchChatKey, userId, startTs: batch.startTs, endTs: batch.endTs, msgCount: batch.messages.length
        },
        sourceMsgIds,
        sourceChatKeys,
        content: item.content,
        groups: item.groups,
        op: item.op,
        replaces,
        status: 'active',
        deduped: false,
        createdAt: batch.endTs || now
      });
      pending.push(entry);
      pendingById.set(entry.entryId, entry);
      runPool.push(entry);
      // ★ 多批 run 的槽位漂移（2026-11-17 复核补）：system 里的 1..M 是 run 开始时的槽位。
      //   第 1 批写了 R3 之后，第 2 批再写 R3 若还指向**旧**来源，就会把同一槽写成两条新条目
      //   （旧来源已 superseded，setPersonStatus 返回 false，但新条照落）。这里把槽位就地
      //   指向刚写出的条目，语义变成「后一批覆盖前一批」——last wins，且不留双活。
      //   system 文本保持 run 开始时的快照不动：每批都改 system 会让前缀缓存一次都命中不了。
      if (slotIdx) {
        existingList[slotIdx - 1] = {
          index: slotIdx,
          content: entry.content,
          groups: entry.groups,
          sourceEntryIds: [entry.entryId],
          sourceChatKeys: entry.sourceChatKeys,
          readOnly: false
        };
      }
    }

    // ★ 批成功 → 本批立即落盘（appendPerson 即水位推进：sourceBatch.endTs 落进画像）
    //   被同批后续 R/M 取消的条目不落盘（status 已改 superseded），也不进【本次已产出】。
    for (let i = runPool.length - 1; i >= 0; i -= 1) {
      if (runPool[i].status !== 'active') runPool.splice(i, 1);
    }
    for (const e of pending) {
      if (e.status !== 'active') continue;
      appendPerson(e);
      entries.push(e);
      addedCount += 1;
    }
  }

  // ④ 语义去重：**定在 run 末尾**（批内去重会让同批后面的行指错目标）。
  // 范围 = 本轮产出 ∪ 磁盘上 active 且 deduped===false 的旧条目（含上次掐断轮留下的）。
  // 缺省 deduped 视为 true —— 迁移的旧画像没有这个字段，自动排除、零改动。
  // 条目 ≤1 条时没有可归并的东西，省掉这次调用。
  //
  // ★ 第 5 期硬约束 13：`pinnedByUser` 的条目**不进 scope**。
  //   用户在 UI 里改过一句 → 标 pinned → 这里若还把它算进来，下一轮就会按语义
  //   把它并进另一条、或把它当被并条目 supersede 掉 —— 编辑变成一次性，且是静默的
  //   （没人会在日志里看到"用户的修改被吞了"）。
  exactCleanup('去重前');
  // ★ A2：第二次 exact collapse 后必须重建 scope。entries 里可能已经有条目
  //   被零调用合并 supersede，送进模型会让它看到死条目并产出脏引用。
  const activeNow = activePerson(userId);
  const runIdSet = new Set(entries.map((e) => e.entryId));
  const eligible = activeNow.filter((e) => e.status === 'active'
    && e.deduped === false && e.pinnedByUser !== true);
  const scope = eligible.filter((e) => runIdSet.has(e.entryId))
    .concat(eligible.filter((e) => !runIdSet.has(e.entryId)));

  // ⑥ 去重也是一次调用：没额度就不发（条目保持 deduped:false，下 tick 补账）。
  if (scope.length > 1 && callCount >= callsLeft) {
    return { ok: true, aborted: true, stats: { ...failStats(), produced: scope.length } };
  }

  const dd = await runDedup({ userId, scope, now, memLlmImpl, log });
  callCount += dd.calls;
  addedCount += dd.added;
  supersededCount += dd.superseded;
  // dd.superseded 已含它末尾的 exact；这里只补“精确组”观测字段，不能重复加 superseded。
  exactSuperseded += Number(dd.exactSuperseded) || 0;
  exactGroups += Number(dd.exactGroups) || 0;

  return {
    ok: dd.ok,
    ...(dd.ok ? { collapsed: dd.collapsed } : { reason: dd.reason }),
    stats: {
      batches: batches.length,
      calls: callCount,
      dedupCalls: dd.dedupCalls,
      skippedBatches,
      badMsgIds,
      badDedupIds: dd.badDedupIds,
      added: addedCount,
      superseded: supersededCount,
      overflow: overflowCount,
      badOp: badOpCount,
      badRef: badRefCount,
      pinnedRefIgnored,
      zeroParsed,
      profileFallback,
      exactSuperseded, exactGroups,
      batchSuperseded: cancelledInBatch,
      markedDeduped: dd.markedDeduped,
      singleRewritten: dd.singleRewritten,
      scope: scope.length,
      produced: dd.ok ? dd.produced : readPerson(userId).list.filter((e) => e.status === 'active').length,
      msgCount: msgs.length
    }
  };
}

/**
 * 对一组条目做语义去重并写回（refine 的 run 末步骤；也供一次性修复脚本调用）。
 *
 * 2026-11-16 事故后的第二轮修正（实测驱动）：
 *   - 单次喂 386 条，模型只回 4 组（输入约 5.8 万字，远超前缀注意力范围）；
 *   - 单次喂 60 条，模型能回 18 组、**覆盖 60/60**（实测）。
 * 所以去重改**分片归并**：每片 ≤ DEDUP_CHUNK 条，片内归并成新一层条目，
 * 层数递减直到 ≤ DEDUP_CHUNK 即收工（386 条：7 片 → 约 126 条 → 3 片 → 约 50 条，共 10 次调用）。
 *
 * 坍缩阀改成**覆盖率**判据（§16.5 ③ 的「输出 < 输入一半」与验收目标「386→30~60」互斥：
 * 30-60 必然小于 193，按条数判会永远拒绝正确结果）。真实故障形态是「模型没把输入穷举出来」，
 * 所以判据是：本片被输出序号覆盖到的输入 < 80% → 整次放弃写回（零写入，下轮重试）。
 *
 * @returns {Promise<{ok:boolean, reason?:string, calls:number, dedupCalls:number, collapsed:boolean,
 *   added:number, superseded:number, markedDeduped:number, badDedupIds:number, produced:number, rounds:number}>}
 */
export async function runDedup({ userId, scope, now = Date.now(), memLlmImpl = memLlm, log = () => {} } = {}) {
  const list = Array.isArray(scope) ? scope : [];
  const out = {
    ok: true, calls: 0, dedupCalls: 0, collapsed: false, rounds: 0,
    added: 0, superseded: 0, markedDeduped: 0, badDedupIds: 0, singleRewritten: 0, produced: list.length
  };
  if (list.length <= 1) return out;

  // origins：当前层条目 → 它代表哪些**原始条目**（多轮归并后要能把 supersede 落到原始条目上）
  const originsOf = new Map();
  for (const e of list) originsOf.set(e.entryId, new Set([e.entryId]));

  const callOnce = async (chunk) => {
    const listing = chunk
      .map((e, i) => `${i + 1}. [${e.groups.join(',')}] ${e.content} || ${e.sourceMsgIds.join(',') || '-'}`)
      .join('\n');
    out.calls += 1;
    out.dedupCalls += 1;
    const r = await memLlmImpl(L1_KIND, {
      messages: [
        { role: 'system', content: DEDUP_PROMPT },
        { role: 'user', content: `对这个人的印象条目（共 ${chunk.length} 条）：\n\n${listing}` }
      ],
      maxTokens: DEDUP_MAX_TOKENS,
      now
    });
    if (!r?.ok) return { ok: false, reason: r?.reason || 'call-error' };
    const parsed = parseDedupOutput(r?.result?.message?.content);
    out.badDedupIds += parsed.bad;

    const groups = [];
    const coveredHere = new Set();
    for (const m of parsed.items) {
      const members = m.idxs.filter((i) => i >= 1 && i <= chunk.length).map((i) => chunk[i - 1]).filter(Boolean);
      if (!members.length) { out.badDedupIds += 1; continue; }
      for (const e of members) coveredHere.add(e.entryId);
      groups.push({ ...m, members });
    }
    return { ok: true, groups, coverage: coveredHere.size / chunk.length };
  };

  // 层内归并：一层 → 下一层（每条都带 origin 集合）
  const mergeLayer = async (layer, round) => {
    const next = [];
    const coveredOrigins = new Set();
    const rewritten = new Set();   // 单条组里被模型改写、但仍用原 entryId 的条目
    // 双预算切片：条数 ≤60 且字数 ≤9K —— 只按条数切，合并一轮后条目变长就会撑爆（实测覆盖率掉到 33%）
    const chunks = [];
    let cur = [];
    let chars = 0;
    for (const e of layer) {
      const sz = String(e.content).length + (e.sourceMsgIds?.length || 0) * 12 + 30;
      if (cur.length && (cur.length >= DEDUP_CHUNK || chars + sz > DEDUP_CHUNK_CHARS)) {
        chunks.push(cur); cur = []; chars = 0;
      }
      cur.push(e); chars += sz;
    }
    if (cur.length) chunks.push(cur);

    for (let ci = 0; ci < chunks.length; ci += 1) {
      const chunk = chunks[ci];
      const r = await callOnce(chunk);
      if (!r.ok) return { ok: false, reason: r.reason };
      // ③ 坍缩阀（覆盖率口径）：模型没把这一片的输入穷举出来 → 整次放弃，零写入
      if (r.coverage < DEDUP_MIN_COVERAGE) {
        log(`[l1] ⚠️ 去重坍缩疑似：第 ${round} 轮第 ${ci + 1}/${chunks.length} 片 输入=${chunk.length}`
          + ` 输出=${r.groups.length} 覆盖=${(r.coverage * 100).toFixed(0)}%，已放弃写回（全部保持 active，下轮重试）`);
        return { ok: false, collapsed: true };
      }
      for (const g of r.groups) {
        const latest = g.members.reduce((a, b) => ((Number(b.sourceBatch?.endTs) || 0) > (Number(a.sourceBatch?.endTs) || 0) ? b : a));
        const origins = new Set(g.members.flatMap((m) => [...(originsOf.get(m.entryId) || [m.entryId])]));
        const msgIds = [...new Set([...g.msgIds, ...g.members.flatMap((e) => e.sourceMsgIds || [])])];
        const chatKeys = [...new Set(g.members.flatMap((e) => e.sourceChatKeys || [e.sourceBatch?.chatKey]))].filter(Boolean).sort();
        // 维度组：优先用模型给的；没给就取成员并集；再不行退回最新那条的组。
        // ★ 必须有兜底：makeL1Entry 对空组会抛，一条脏输出不该让整轮去重崩掉（恢复路径尤其不能）。
        let mergedGroups = (g.groups.length ? g.groups : [...new Set(g.members.flatMap((e) => e.groups || []))]).slice(0, 3);
        if (!mergedGroups.length) mergedGroups = (latest.groups || []).slice(0, 3);
        if (!mergedGroups.length) { out.badDedupIds += 1; continue; }

        // ★ 单条组（§7.4）：**不生成新 entryId**。它没有可合并的对象，
        //   造一条新 id 再 supersede 旧的，等于每轮去重都把全库条目换一遍身份 ——
        //   UI 的编辑留痕、冲突对端、画像来源序号全都指到死 id 上。
        if (g.members.length === 1) {
          const member = g.members[0];
          const sameText = String(g.content).trim() === String(member.content).trim();
          const sameGroups = [...(member.groups || [])].sort().join(',') === [...mergedGroups].sort().join(',');
          if (sameText && sameGroups) {
            // 原样保留：不进 next（写回时只标 deduped，不新增内容行）
            continue;
          }
          let rewrittenEntry = null;
          try {
            rewrittenEntry = makeL1Entry({
              ...member,
              entryId: member.entryId,
              content: g.content,
              groups: mergedGroups,
              deduped: true,
              updatedAt: now
            });
          } catch (error) {
            out.badDedupIds += 1;
            continue;
          }
          rewritten.add(member.entryId);
          next.push(rewrittenEntry);
          // ★ 不进 coveredOrigins：那会把它自己 supersede 掉（append 的新行随即作废）
          continue;
        }

        let entry = null;
        try {
          entry = makeL1Entry({
            // entryId 用本轮运行时刻（seq 900+ 是固定段，取旧时间会与既有合并条撞 id）
            entryId: makeL1EntryId({ userId, at: now, seq: 900 + next.length }),
            chatKey: latest.sourceBatch?.chatKey, userId,
            sourceBatch: latest.sourceBatch,
            sourceMsgIds: msgIds,
            sourceChatKeys: chatKeys,
            groups: mergedGroups,
            content: g.content,
            status: 'active',
            deduped: true,
            createdAt: latest.createdAt || now,
            updatedAt: now
          });
        } catch (error) {
          out.badDedupIds += 1;                       // 脏组：跳过，成员保持未处理（下轮重试）
          continue;
        }
        for (const o of origins) coveredOrigins.add(o);   // 只登记真正建成的组
        originsOf.set(entry.entryId, origins);
        next.push(entry);
      }
    }
    return { ok: true, next, coveredOrigins, rewritten };
  };

  let layer = list;
  let finalCovered = null;
  let finalRewritten = new Set();
  for (let round = 1; round <= DEDUP_MAX_ROUNDS; round += 1) {
    out.rounds = round;
    const m = await mergeLayer(layer, round);
    if (!m.ok) {
      if (m.collapsed) { out.collapsed = true; out.produced = list.length; return out; }
      return { ...out, ok: false, reason: m.reason };
    }
    finalCovered = m.coveredOrigins;
    finalRewritten = m.rewritten;
    // 收敛条件：这一层已经 ≤ 一片的容量（再合并就会过度归并）；或者没有进一步减少
    if (m.next.length <= DEDUP_CHUNK || m.next.length >= layer.length) { layer = m.next; break; }
    layer = m.next;
  }

  // ★ 写回顺序（§16.2）：先 append 合并条（deduped:true），再 supersede 原条目。
  //   反过来崩在中间会「原条目没了、合并条没来」——画像净损失；这个顺序崩了最多是短暂重复，
  //   下 tick 的去重范围会把 deduped:false 的原条目捞回来重新裁决（自愈），绝不丢条。
  for (const e of layer) {
    appendPerson(e);
    // 单条改写用的是原 entryId：它是「同一条的新版本」，不是新增印象，别计进 added
    if (finalRewritten.has(e.entryId)) out.singleRewritten += 1;
    else out.added += 1;
  }
  // ★ ② 只 supersede **被覆盖到**的原始条目（旧代码一刀切整个 scope，是 383 条被误废的直接成因）
  const coveredOrigins = finalCovered || new Set();
  for (const e of list) {
    if (!coveredOrigins.has(e.entryId)) continue;
    if (setPersonStatus(userId, e.entryId, 'superseded', { nowTs: now })) out.superseded += 1;
  }
  // ★ ④ 没被覆盖到的原始条目 = 已评估、无需合并 → 标 deduped:true（用 setPersonDeduped，保持 active），
  //   否则每轮都被 deduped≠true 捞回来重跑，白烧调用。
  //   单条改写过的除外：它的新行已经带 deduped:true，再标一次就是多 append 一行。
  for (const e of list) {
    if (coveredOrigins.has(e.entryId) || finalRewritten.has(e.entryId)) continue;
    if (setPersonDeduped(userId, e.entryId, true, { nowTs: now })) out.markedDeduped += 1;
  }
  out.produced = layer.length + list.filter((e) => !coveredOrigins.has(e.entryId)).length;

  // ★ ⑨ 确定性兜底：分片边界会留下 content 完全相同的条目，字符串相等不需要模型判断。
  //   放在所有写回之后（此时 active 集合已稳定），零调用、幂等。
  const exact = collapseExactDuplicates(userId, { now });
  out.exactSuperseded = exact.superseded;
  out.exactGroups = exact.groups;
  if (exact.superseded) {
    out.superseded += exact.superseded;
    log(`[l1] 确定性去重：${exact.groups} 组内容完全相同，留最新、supersede ${exact.superseded} 条（零调用）`);
  }
  // 终态以盘上 active 为准（含历史遗留的重复被本次一并收掉）
  out.produced = activePerson(userId).length;
  return out;
}

/**
 * ⑨ 确定性去重（§16.6）：content 字符串完全相同 = 同一句话，不需要模型判断。
 *
 * 分片归并的边界会留下完全重复的条目（跨片看不到彼此），靠再烧一轮调用去并它们
 * 是浪费 —— 字符串相等本身就是判据。零调用、纯本地、幂等。
 *
 * 规则：
 *   - 按 content（trim 后）精确分组，组内留**最新**那条（createdAt 最大，同刻比 entryId）；
 *   - 其余 supersede（留痕不删）；
 *   - 留下那条若缺出处，把被并条目的 sourceMsgIds / sourceChatKeys 并进来（append 新版本，
 *     走 append-only，不原地改行）—— 并掉重复不能顺手把溯源也丢了。
 *
 * @returns {{superseded:number, mergedOrigin:number, groups:number}}
 */
export function collapseExactDuplicates(userId, { now = Date.now() } = {}) {
  const at = Number(now) || Date.now();
  // ★ 第 5 期硬约束 13：pinned 不参与分组，也不当被并对象。
  //   这一处比 runDedup 更危险：⑨ 是**零调用**的确定性去重，它按 content 完全相同
  //   直接合并 —— 用户刚把两条改成一样的措辞，或者改完的内容恰好和另一条重复，
  //   下一轮就被无声吃掉。语义去重至少还过一次模型。
  const actives = activePerson(userId).filter((e) => e.status === 'active' && e.pinnedByUser !== true);
  const byContent = new Map();
  for (const e of actives) {
    const key = String(e?.content ?? '').trim();
    if (!key) continue;                       // 空内容不参与分组（也不能互相吞掉）
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(e);
  }

  let superseded = 0;
  let mergedOrigin = 0;
  let groups = 0;
  for (const group of byContent.values()) {
    if (group.length <= 1) continue;
    groups += 1;
    // 留最新：createdAt 大者胜；同一时刻用 entryId 兜底定序（避免每次运行留的不一样）
    const sorted = group.slice().sort((a, b) => (
      (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)
      || String(b.entryId).localeCompare(String(a.entryId))
    ));
    const keep = sorted[0];
    const rest = sorted.slice(1);

    const msgIds = [...new Set([
      ...(keep.sourceMsgIds || []), ...rest.flatMap((e) => e.sourceMsgIds || [])
    ])];
    const chatKeys = [...new Set([
      ...(keep.sourceChatKeys || []), ...rest.flatMap((e) => e.sourceChatKeys || [])
    ])].filter(Boolean).sort();
    const needUnion = msgIds.length !== (keep.sourceMsgIds || []).length
      || chatKeys.length !== (keep.sourceChatKeys || []).length;

    // 先补出处（append 新版本），再 supersede 重复条 —— 与前面同一条纪律：先有后无
    if (needUnion) {
      appendPerson({ ...keep, sourceMsgIds: msgIds, sourceChatKeys: chatKeys, updatedAt: at });
      mergedOrigin += 1;
    }
    for (const e of rest) {
      if (setPersonStatus(userId, e.entryId, 'superseded', { nowTs: at })) superseded += 1;
    }
  }
  return { superseded, mergedOrigin, groups };
}

// ── 触发调度（§3.3）──────────────────────────────────────────────────────
//
// 「上次提炼到哪」不另存水位：已有画像里最晚的 sourceBatch.endTs 就是水位。
// 另存一份就会有两份真相（画像被回滚/手工删掉后水位还在），而这层数据量很小，
// 每次现算一次最晚时间戳是毫秒级。

/** 已有画像里最晚的批次结束时间（= 上次提炼到哪）。没有画像返回 0。 */
export function lastRefinedEnd(entries) {
  let max = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const t = Number(e?.sourceBatch?.endTs) || 0;
    if (t > max) max = t;
  }
  return max;
}

/**
 * 每个人在各群的提炼水位（该群最后一批的 endTs）。
 *
 * 2026-11-15：跨群合并后必须按群分开算 —— 用单一 lastEnd 会让「刚提炼过 A 群」
 * 把 B 群尚未提炼的历史消息整体判成已处理，**而且日志上看不出任何异常**：
 * 画像照常产出，只是 B 群那部分内容永远缺席。
 *
 * 因为切批是「按群分组」（`buildBatchesByChat`，一批只来自一个群），
 * `sourceBatch.chatKey` 是**唯一且准确**的，直接读它即可 —— 不需要 ends 数组，
 * 也不需要「有 ends / 无 ends」的兼容分支。
 *
 * @returns {Map<string, number>} chatKey → endTs
 */
export function lastRefinedEndByChat(existing) {
  const map = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    const k = String(e?.sourceBatch?.chatKey || '');
    if (!k) continue;
    const end = Number(e?.sourceBatch?.endTs) || 0;
    if (end > (map.get(k) || 0)) map.set(k, end);
  }
  return map;
}

/**
 * 合并水位（§7.1）：条目水位 ∪ 扫描游标，逐群取最大值。
 *
 * 游标只由「整段 SKIP / 空输出」推进 —— 那些批次没有落盘条目，
 * 不合并进来的话同一批每个槽都会被当成「从未提炼」原样重发。
 */
export function effectiveWatermarks(entries, cursor = {}) {
  const map = lastRefinedEndByChat(entries);
  for (const [k, v] of Object.entries(cursor || {})) {
    const ts = Number(v) || 0;
    if (ts > (map.get(k) || 0)) map.set(k, ts);
  }
  return map;
}

/**
 * 「最老水位」：7 天判断用哪个时间。
 *
 * 有缺水的群就直接取 0 —— 只统计已有水印的群会漏掉「这个群从没提炼过」：
 * A 群昨天炼过、B 群从没炼过且只有 40 条 → 既不到 80 条阈值、又不算 stale，
 * B 群那 40 条素材永远进不了画像。
 */
export function oldestWatermark(chatKeys, wm) {
  const keys = [...new Set((Array.isArray(chatKeys) ? chatKeys : []).map(String).filter(Boolean))];
  if (!keys.length) return 0;
  if (keys.some((k) => !wm || !wm.has(k))) return 0;
  return Math.min(...keys.map((k) => Number(wm.get(k)) || 0));
}

/**
 * 按群分组切批。
 *
 * 跨群合并后，一批**只来自一个群**：这样 sourceBatch.chatKey 唯一准确，水位天然按群推进。
 * 代价是批次数 +1.7%（小群不会和别的群拼成一批）—— 换掉三个必须同时做对的耦合点。
 * 正向副作用：模型看到的是某个群的连续对话，不会把 A 群和 B 群的话误当成同一场景。
 *
 * @returns {Array<{messages:Array, startTs:number, endTs:number, chatKey:string}>}
 */
export function buildBatchesByChat(messages, maxPerBatch = BATCH_SIZE) {
  const byChat = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    const k = String(m?._chatKey || '');
    if (!byChat.has(k)) byChat.set(k, []);
    byChat.get(k).push(m);
  }
  const out = [];
  for (const [chatKey, list] of byChat) {
    for (const b of buildBatches(list, maxPerBatch)) out.push({ ...b, chatKey });
  }
  // 批次顺序仍按时间：R 覆盖靠「后来的批能看到前面的产出」，
  // 顺序乱了会把「以前爱玩手游 → 现在退坑了」这类覆盖判反。
  return out.sort((a, b) => (Number(a.startTs) || 0) - (Number(b.startTs) || 0));
}

/**
 * 跨群聚合发言人：把多个群的消息按 uid 合并成一个人。
 *
 * 只保留提炼真正要用的五个字段（mid/ts/text/senderName/_chatKey）：
 * 全量消息一次性驻留内存，原样拷贝每条会让峰值再涨一截。
 *
 * @param {Array<{chatKey:string, messages:Array}>} sources
 */
export function collectPeopleAcrossChats(sources) {
  const byUser = new Map();
  for (const { chatKey, messages } of Array.isArray(sources) ? sources : []) {
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || m.self) continue;
      const uid = String(m.senderId || m.uid || '').trim();
      if (!uid) continue;
      if (!byUser.has(uid)) {
        byUser.set(uid, { userId: uid, nickname: '', count: 0, chatKeys: new Set(), messages: [] });
      }
      const p = byUser.get(uid);
      const name = stripCtrl(m.senderName);
      p.count += 1;
      p.chatKeys.add(String(chatKey || ''));
      if (!p.nickname && name) p.nickname = name;
      p.messages.push({ mid: m.mid, ts: m.ts, text: m.text, senderName: name, _chatKey: chatKey });
    }
  }
  return [...byUser.values()]
    .filter((p) => p.count >= MIN_MSGS_FOR_L1)
    .sort((a, b) => b.count - a.count);
}

/**
 * 该不该给这个人提炼（两条条件任一成立即可）。
 *
 * ① 未提炼消息 ≥ 80 条 —— 活跃者的主路径。
 * ② 距上次 > 7 天 且 新增 ≥ 25 条 —— 冷清者的兜底：只按时间不看条数，
 *    会在「7 天里只说了两句话」的人身上白烧一次调用。
 *
 * `refinedSomewhere` 是给「这个人炼过、但某个群从没炼过」准备的：
 * 那种群的整段历史都是未提炼的，等 80 条等不到、等 7 天也没意义（lastRefinedAt 被
 * `oldestWatermark` 置 0），所以只要新增够 25 条就该跑。**从没炼过的人不适用**
 * —— 否则首次提炼的门槛等于从 80 掉到 25。
 */
export function shouldRefine({
  unrefinedCount = 0, lastRefinedAt = 0, newMsgCount = null, now = Date.now(), refinedSomewhere = false
} = {}) {
  const n = Math.max(0, Math.round(Number(unrefinedCount) || 0));
  const fresh = Math.max(0, Math.round(Number(newMsgCount ?? n) || 0));
  const last = Number(lastRefinedAt) || 0;
  if (n >= TRIGGER_MSG_THRESHOLD) {
    return { ok: true, reason: 'msg-threshold', unrefinedCount: n, threshold: TRIGGER_MSG_THRESHOLD };
  }
  const idleMs = last > 0 ? (Number(now) || 0) - last : 0;
  const staleByIdle = last > 0 && idleMs >= TRIGGER_STALE_DAYS * DAY_MS;
  // 缺水群：炼过别处、但这个群一条画像都没有 → 整段历史都是未提炼的
  const staleByMissingChat = refinedSomewhere === true && last <= 0;
  if (fresh >= TRIGGER_NEW_MSG_MIN && (staleByIdle || staleByMissingChat)) {
    return {
      ok: true,
      reason: 'stale-and-new',
      idleDays: staleByIdle ? Math.floor(idleMs / DAY_MS) : null,
      newMsgCount: fresh,
      missingChatWatermark: staleByMissingChat
    };
  }
  return { ok: false, reason: 'not-yet', unrefinedCount: n, newMsgCount: fresh };
}

/**
 * 候选池兜底：挑出「最老 pending 已经超过 7 天」的条目。
 *
 * 判据只看**条目年龄**，不看人的活跃度（§5.1.7 v1.5）—— 否则一个退群的人
 * 留下的 pending 会永远悬着：他不再发言，就永远凑不够触发条件。
 */
export function pickStaleCandidates(candidates, { now = Date.now(), maxAgeDays = CANDIDATE_MAX_AGE_DAYS } = {}) {
  const cut = (Number(now) || 0) - maxAgeDays * DAY_MS;
  return (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c?.status === 'pending' && (Number(c.ts) || 0) < cut);
}

/** 兜底调用的 kind。必须与 kindQuota 里登记的一致（llm.js 的 LIMIT_DEFAULTS）。 */
export const CANDIDATE_FALLBACK_KIND = 'candidate-fallback';
/** 每条候选回看多少条上下文（前后各这么多条）。 */
export const CANDIDATE_CONTEXT_RADIUS = 20;

const clockOf = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 取 msgId 前后各 radius 条（找不到 msgId 就返回空 —— 编不出上下文就别编）。 */
export function contextAround(messages, msgId, radius = CANDIDATE_CONTEXT_RADIUS) {
  const list = Array.isArray(messages) ? messages : [];
  const key = String(msgId ?? '').trim();
  if (!key) return [];
  const idx = list.findIndex((m) => String(m?.mid ?? m?.id ?? '') === key);
  if (idx < 0) return [];
  return list.slice(Math.max(0, idx - radius), idx + radius + 1);
}

/**
 * T6 候选池兜底：**只针对候选池的小调用**（大纲 §5.1.7 / T6）。
 *
 * 与 `refine()` 的分工 —— 这是「接线」不是「改提炼算法」：
 *   · refine 走正常触发（≥80 条未提炼 / 7 天 + 25 条），有 R/M 槽位与语义去重；
 *   · 这里只回答一个问题：「这几条提议该不该记」，产出的条目**直接 active**，
 *     不参与 R/M 覆盖、不触发去重（下一轮正常提炼会顺手把它们纳入去重范围）。
 *
 * 为什么会存在这条路径：那个人不说话了 → 永远攒不到 80 条 → 也永远命中不了
 * 「>7 天且有新消息」→ 候选池永久悬空。「你让我记的那事」就这么烂在池子里。
 *
 * 两条归因红线（§7.2 / §7.3）：
 *   · 按 `_chatKey` 分组、每片一次调用 —— 混群喂会把 B 群的提议记到 A 群头上；
 *   · `endTs = max(候选 ts)`，**绝不用 now、也不用上下文最大值**：上下文向后取 20 条，
 *     用它的最大值等于把「候选之后、还没提炼的消息」记成已炼，水位直接越过它们。
 *
 * @returns {Promise<{ok:boolean, aborted?:boolean, reason?:string,
 *                    stats:{calls:number, added:number, produced:number, badOp:number, overflow:number}}>}
 */
export async function refineCandidates(person, {
  candidates = [], contextByCandidate = new Map(), existing = null,
  memLlmImpl = memLlm, now = Date.now(), log = () => {},
  callsLeft = Number.POSITIVE_INFINITY
} = {}) {
  const userId = String(person?.userId || '').trim();
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c?.text);
  if (!userId || !list.length) {
    return { ok: false, reason: 'no-candidates', stats: { calls: 0, added: 0, produced: 0, badOp: 0, overflow: 0 } };
  }

  const slots = Array.isArray(existing) ? existing : existingSlotsFor(userId, activePerson(userId)).existing;
  const systemText = `${CANDIDATE_PROMPT}\n\n【已有画像】（仅供参考，别重复产出）\n${formatExisting(slots)}`;

  const ctxOf = (c) => {
    const ctx = (contextByCandidate?.get?.(c.entryId) ?? contextByCandidate?.[c.entryId]) || [];
    return Array.isArray(ctx) ? ctx : [];
  };

  // 候选行上**没有 chatKey 字段**，_chatKey 是 sweepPeople 打的；缺它就只能落到 '' 群。
  const byChat = new Map();
  for (const c of list) {
    const k = String(c._chatKey || '').trim();
    if (!byChat.has(k)) byChat.set(k, []);
    byChat.get(k).push(c);
  }

  let calls = 0;
  let seq = 0;
  let badOp = 0;
  let overflow = 0;
  let judged = 0;
  const added = [];
  const stats = () => ({ calls, added: added.length, produced: added.length, badOp, overflow });

  for (const [chatKey, group] of byChat) {
    group.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    for (let i = 0; i < group.length; i += CANDIDATE_CHUNK) {
      if (calls >= callsLeft) {
        log(`[l1] ${userId} 候选兜底预算用尽 → 剩 ${list.length - judged} 条保持 pending，下轮再试`);
        return { ok: true, aborted: true, stats: stats() };
      }
      const chunk = group.slice(i, i + CANDIDATE_CHUNK);
      const blocks = chunk.map((c, j) => {
        const who = c.kind === 'user_request' ? '群友点名要求记住' : '你自己当时觉得该记';
        const ctxLines = ctxOf(c).map((m) => {
          const speaker = m?.self ? '你' : (stripCtrl(m?.senderName) || m?.senderId || '某人');
          return `${clockOf(m?.ts)} ${speaker}：${flat(m?.text) || '（无文字）'}`;
        }).join('\n');
        return `【提议 ${j + 1}】（${who}）${flat(c.text)}\n`
          + (ctxLines ? `上下文：\n${ctxLines}` : '上下文：（找不到原始消息，只有这一句）');
      }).join('\n\n');

      const r = await memLlmImpl(CANDIDATE_FALLBACK_KIND, {
        messages: [{ role: 'system', content: systemText }, { role: 'user', content: blocks }],
        maxTokens: 800,
        now
      });
      calls += 1;
      if (!r?.ok) {
        log(`[l1] ${userId} 候选池兜底失败：${r?.reason || 'call-error'}（本片候选保留 pending，下次再试）`);
        return { ok: false, reason: r?.reason || 'call-error', stats: stats() };
      }

      // 候选没有槽位上下文：R/M 一律整行丢弃（onlySupplement）
      const parsed = parseRefineOutput(r?.result?.message?.content, { onlySupplement: true });
      badOp += parsed.badOp;
      overflow += parsed.overflow;

      const endTs = Math.max(0, ...chunk.map((c) => Number(c.ts) || 0));
      let startTs = endTs;
      for (const c of chunk) {
        startTs = Math.min(startTs, Number(c.ts) || 0);
        for (const m of ctxOf(c)) startTs = Math.min(startTs, Number(m?.ts) || 0);
      }
      if (parsed.overflow || parsed.badOp) {
        log(`[l1] 解析溢出：uid=${userId} 丢弃 ${parsed.overflow + parsed.badOp} 行（overflow=${parsed.overflow} badOp=${parsed.badOp}）`);
        for (const d of parsed.overflowLines) {
          appendOverflowAudit({ uid: userId, batch: { chatKey, startTs, endTs }, reason: d.reason, rawLine: d.rawLine, at: now });
        }
      }

      if (!parsed.skip) {
        for (const item of parsed.items) {
          seq += 1;
          const entry = makeL1Entry({
            entryId: makeL1EntryId({ userId, at: now, seq: 900 + seq }),
            chatKey,
            userId,
            sourceBatch: { chatKey, userId, startTs, endTs, msgCount: chunk.length },
            // 候选是「一句话提议」，不是「一段会话」：这里不写 sourceMsgIds（那要求单句支撑，
            // 而提议本身已经被候选池行留痕了，UI 从那边能跳回原文）。
            sourceMsgIds: [],
            sourceChatKeys: chatKey ? [chatKey] : [],
            content: item.content,
            groups: item.groups,
            op: 'supplement',
            replaces: [],
            status: 'active',
            deduped: false,
            createdAt: now
          });
          appendPerson(entry);
          added.push(entry);
        }
      }

      // 裁决回写：本片有产出记 adopted，没有记 dropped（留痕不删，§5.1.7 约束 2）。
      // ★ 用 c._chatKey（候选池按群存），不是人的 chatKeys[0]。
      const outcome = parsed.items.length ? 'adopted' : 'dropped';
      for (const c of chunk) {
        judged += 1;
        if (c._chatKey) setCandidateStatus(c._chatKey, c.entryId, outcome, { nowTs: now });
      }
      log(`[l1] ${userId} 候选池兜底 群=${chatKey || '?'}（${chunk.length} 条提议，${CANDIDATE_FALLBACK_KIND}）→ ${outcome} +${parsed.items.length} 条`);
    }
  }

  return { ok: true, stats: stats() };
}

/** 提炼结果落盘已并入 refine（逐批落盘 + run 末去重写回）。此函数于 2026-11-15 夜移除。 */

// ── 画像压缩（L1 收敛 §4.4）───────────────────────────────────────────────

/** 8 行 × 50 字 + 来源序号；800 偏紧，实测顶满再调模板。 */
export const PROFILE_MAX_TOKENS = 1200;

/**
 * 给一个人建/刷新派生画像视图。**每人每轮最多 1 次调用。**
 *
 * active 是唯一事实来源：本函数只读 active、只写 `<uid>.profile.json`，
 * 不改任何条目 status、不动水位（红线 1）。
 *
 * @param {string} userId
 * @param {object} opts
 * @param {Array}  [opts.activeEntries] 已读好的 active（省一次读盘；sweepPeople 复用）
 * @param {object} [opts.profile]       已读好的旧 profile（同上）
 * @param {number} [opts.callsLeft]     本轮剩余调用额度（压缩已预留，这里只兜底）
 * @returns {{ok:boolean, built:boolean, calls:number, skipped?:boolean,
 *            reason?:string, stats?:object, profile?:object}}
 *   `skipped` = 配额类原因（含额度用尽），调用方计 profileSkipped，**不算失败**。
 */
export async function compressProfile(userId, {
  now = Date.now(), memLlmImpl = memLlm, log = () => {},
  activeEntries = null, profile = undefined, callsLeft = Number.POSITIVE_INFINITY,
  force = false
} = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, built: false, calls: 0, reason: 'bad-person' };

  const active = Array.isArray(activeEntries)
    ? activeEntries.filter((e) => e?.status === 'active')
    : activePerson(uid);
  const digest = computeDigest(active);
  const old = profile === undefined ? readProfile(uid) : profile;
  // 同一批事实的续修次数：digest 变了就重新计（新事实该有新的机会）
  const retrySame = old && old.sourceDigest === digest ? (Number(old?.stats?.retry) || 0) : 0;
  // ★ 缺维读时现算：旧画像没有 stats.missingDims，信任 stats 会让它漏判。
  //   题材词命中不判脏（2026-11-17 裁决：只统计、不拦截）。
  const needFix = retrySame < PROFILE_RETRY_MAX
    && missingDimsOf(old?.slots, active).length > 0;
  // force：模板/口径改了要重压时用（只给运维脚本，日扫永远走 digest 判据）
  if (!force && !needFix && old && old.sourceDigest === digest) {
    return { ok: true, built: false, calls: 0, reason: 'clean', profile: old };
  }

  // active 为空 → 不调模型，写空画像（注入为空，兜底也不会凭空造条）
  if (!active.length) {
    const empty = { ...emptyProfile(uid), builtAt: now, sourceDigest: digest };
    writeProfile(uid, empty);
    log(`[profile] ${uid} active=0 → 写空画像（0 次调用）`);
    return { ok: true, built: true, calls: 0, reason: 'empty-active', stats: empty.stats, profile: empty };
  }

  if (callsLeft <= 0) {
    log(`[profile] 待压缩（本轮额度用尽）：${uid}`);
    return { ok: false, built: false, calls: 0, skipped: true, reason: 'no-budget' };
  }

  const input = buildProfileInput(active);
  if (input.truncated) log(`[profile] 输入截断 ${input.inputTotal}→${input.inputUsed}（${uid}）`);

  const r = await memLlmImpl(PROFILE_KIND, {
    messages: [
      { role: 'system', content: PROFILE_PROMPT },
      { role: 'user', content: `【原始印象】（共 ${input.inputUsed} 条，序号即来源编号）\n${input.text}` }
    ],
    maxTokens: PROFILE_MAX_TOKENS,
    now
  });
  if (!r?.ok) {
    const reason = r?.reason || 'call-error';
    const skipped = QUOTA_FAIL_REASONS.includes(reason);
    log(`[profile] ${skipped ? '待压缩（配额不足）' : '压缩失败，保留旧画像'}：${uid} ${reason}`
      + `${reason === 'single-call-aborted' ? '（aborted=1，未覆盖）' : ''}`);
    return { ok: false, built: false, calls: 1, skipped, reason };
  }

  const { slots: rawSlots, stats: ps } = parseProfileOutput(r?.result?.message?.content, input.inputEntries);
  if (!rawSlots.length) {
    // 解析出 0 槽：不写空视图覆盖旧画像（注入会退回确定性兜底，不会空白）
    log(`[profile] ${uid} 输出 0 有效槽，保留旧画像`
      + ` 丢=badDim${ps.badDim}/noRef${ps.noRef}/overflow${ps.overflow}/dup${ps.duplicates}`);
    return { ok: false, built: false, calls: 1, reason: 'empty-output' };
  }

  // ★ 题材词只统计、不拦截（2026-11-17 裁决）：槽照常保留、照常注入，命中只进 stats 与日志。
  const sensitiveHits = rawSlots.filter((s) => scanSensitive(s.content).length > 0).length;
  if (sensitiveHits) {
    log(`[profile] ${uid} 敏感命中 ${sensitiveHits} 条（仅统计，不拦截）`);
  }

  // ★ 空维度确定性补位：模型漏了、但 active 该维有材料（367 的兴趣身份 49 条 →
  //   输出 0 条，注入端只在「槽全空」时兜底，所以那维会**永久缺席**）。补 top-2，零调用。
  const missDims = missingDimsOf(rawSlots, active);
  const { slots, filledDims } = fillMissingDims(rawSlots, active);
  if (filledDims.length) {
    log(`[profile] ${uid} 补位维度：${filledDims.join('/')}（按 updatedAt 取 top-2，来源写真实 entryId）`);
  }

  const activeIds = new Set(active.map((e) => e.entryId));
  const covered = new Set();
  for (const s of slots) for (const id of s.sourceEntryIds) if (activeIds.has(id)) covered.add(id);

  // 这次仍需重试吗：模型漏维算「没一次做干净」；同一 digest 最多 PROFILE_RETRY_MAX 次
  const stillIncomplete = missDims.length > 0;
  const nextRetry = stillIncomplete ? retrySame + 1 : 0;

  const out = {
    v: 1,
    uid,
    builtAt: now,
    sourceDigest: digest,
    model: r?.result?.model || '',
    slots,
    stats: {
      active: active.length,
      covered: covered.size,
      calls: 1,
      inputTotal: input.inputTotal,
      inputUsed: input.inputUsed,
      lengthViolations: ps.lengthViolations,
      badRefs: ps.badRefs,
      noRef: ps.noRef,
      overflow: ps.overflow,
      duplicates: ps.duplicates,
      badDim: ps.badDim,
      truncated: ps.truncated,
      missingDims: missDims,          // 模型漏掉、但有材料的维度（补位前）
      filledDims,                     // 其中已由确定性补位填上的
      sensitiveHits,                  // 题材词命中条数（仅统计，不拦截）
      retry: nextRetry
    }
  };
  writeProfile(uid, out);
  log(`[profile] ${uid} 建=1 槽=${slots.length}/${PROFILE_MAX_SLOTS}`
    + ` 丢=badDim${ps.badDim}/noRef${ps.noRef}/overflow${ps.overflow}/dup${ps.duplicates}/len${ps.lengthViolations}`
    + ` 截断=${ps.truncated} 覆盖=${covered.size}/${active.length}`
    + `${filledDims.length ? ` 补位=${filledDims.join('/')}` : ''}`
    + `${sensitiveHits ? ` 敏感命中${sensitiveHits}（不拦截）` : ''}`
    + ` 重试=${nextRetry}/${PROFILE_RETRY_MAX}`
    + ` out=${r?.usage?.completionTokens ?? '?'}tok`);
  return { ok: true, built: true, calls: 1, stats: out.stats, profile: out };
}

/**
 * 把一段消息按发言人分组（只要群友，自己的话不算）。
 * 返回按发言条数降序 —— 先处理活跃者：他们的画像最影响对话质量。
 */
export function collectPeople(messages, { minMsgs = MIN_MSGS_FOR_L1 } = {}) {
  const byUser = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.self) continue;
    const uid = String(m.senderId || m.uid || '').trim();
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, { userId: uid, nickname: '', count: 0, messages: [] });
    const p = byUser.get(uid);
    const name = stripCtrl(m.senderName);
    p.count += 1;
    if (!p.nickname && name) p.nickname = name;
    p.messages.push({ ...m, senderName: name });
  }
  return [...byUser.values()]
    .filter((p) => p.count >= minMsgs)
    .sort((a, b) => b.count - a.count);
}

/**
 * 扫一轮人（跨群）：给每个够资格的人判断要不要提炼，要就提炼并落盘。
 *
 * 为什么不再按群扫：按群扫 + 按人存 = 同一个人的画像被 6 个群各写一次，
 * sourceChatKeys 永远只剩一个群，而且互相覆盖。
 *
 * 预算按**尝试**计（不是成功）：否则失败的人可以无限挤占名额，
 * 每轮都在同几个人身上反复失败，别人永远轮不到。
 * 调用预算 `maxCalls`（memory.l1.maxCallsPerTick）：达到即 break。逐批落盘后
 * break 没有作废代价 —— 已落盘的批次水位已推进，下 tick 从断点续跑。
 *
 * @returns {Promise<object>} refined/skipped/added/callsUsed/superseded/produced/failed/budgetHit
 *   + 解析可见性（overflow/badOp/badRef/pinnedRefIgnored/zeroParsed）
 *   + 画像压缩（profilesBuilt/profileCalls/profileDirty/profileSkipped/profilePending/profileCovered）
 */
export async function sweepPeople({
  sources, now = Date.now(), log = () => {}, memLlmImpl = memLlm,
  maxPeople = MAX_PEOPLE_PER_TICK, maxCalls = Number.POSITIVE_INFINITY
} = {}) {
  const stat = {
    refined: 0, skipped: 0, added: 0, callsUsed: 0, superseded: 0, produced: 0, failed: 0,
    candidateFallback: 0, failReasons: {}, budgetHit: false,
    abortedPeople: 0, abortedAdded: 0, abortedCalls: 0,
    overflow: 0, badOp: 0, badRef: 0, pinnedRefIgnored: 0, zeroParsed: 0,
    profilesBuilt: 0, profileCalls: 0, profileDirty: 0, profileSkipped: 0, profilePending: 0,
    profileCovered: { withProfile: 0, withActive: 0 }
  };
  const people = collectPeopleAcrossChats(sources);

  // ── 画像压缩队列（§4.4）：tick 开始就遍历全部 person 算 digest，结果缓存复用 ──
  // 额度**先预留**再提炼：先到先得会让后面的人永远排不上
  // （实测 120 人有资格、目前只有 5 份画像）。
  const queueAll = buildProfileQueue();
  const queue = queueAll.slice(0, PROFILE_MAX_PER_TICK);
  const inQueue = new Set(queue.map((q) => q.uid));
  const profileBudget = Math.min(PROFILE_MAX_PER_TICK, queueAll.length);
  const refineBudget = Math.max(0, maxCalls - profileBudget);
  stat.profileDirty = queueAll.length;

  const cursorAll = readScanCursor();
  const compressed = new Set();
  let refineCalls = 0;          // 只数提炼/兜底/去重，压缩走预留额度，两者不互相挤

  // 每人先提炼/兜底、再压缩（同一轮就能看到新条目）。
  // ★ 所有提前 continue 的分支都必须先过这里，否则「没有新消息但画像脏了」永远修不好。
  const compressOne = async (uid) => {
    if (compressed.has(uid)) return;
    compressed.add(uid);
    const active = activePerson(uid);
    const profile = readProfile(uid);
    if (profile && profile.sourceDigest === computeDigest(active)) return;
    if (!inQueue.has(uid)) {
      // 队列以外新变脏的：留给下一槽，不临时扩额（扩额就是挤掉提炼）
      stat.profilePending += 1;
      log(`[profile] ${uid} 队列外新变脏 → 留下一槽压缩`);
      return;
    }
    if (stat.profileCalls >= profileBudget) {
      stat.profileSkipped += 1;
      log(`[profile] 待压缩（本轮画像额度用尽）：${uid}`);
      return;
    }
    const r = await compressProfile(uid, {
      now, memLlmImpl, log, activeEntries: active, profile,
      callsLeft: maxCalls - stat.callsUsed
    });
    stat.callsUsed += r.calls || 0;
    stat.profileCalls += r.calls || 0;
    if (r.built) stat.profilesBuilt += 1;
    if (r.skipped) stat.profileSkipped += 1;
  };

  // 候选池兜底要「带回上下文」，所以按群留一份完整消息（不复制，只存引用）
  const msgByChat = new Map();
  for (const s of Array.isArray(sources) ? sources : []) msgByChat.set(s.chatKey, s.messages);

  // 候选池仍是每群一份。★ 候选行上**没有 chatKey 字段**（只有 entryId/kind/fromUserId/
  // msgId/text/ts/status），必须自己打 _chatKey：直接读 c.chatKey 会得到 undefined
  // → safeKey 得 'undefined' → 写进 group_undefined/，而原群的 pending 永远消解不掉，
  //   每轮重复喂进提炼（不报错、不告警）。
  const allCands = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    for (const c of readCandidates(s.chatKey).pending) allCands.push({ ...c, _chatKey: s.chatKey });
  }
  let attempts = 0;

  for (const p of people) {
    if (attempts >= maxPeople) { stat.budgetHit = true; break; }
    // ★ 水位必须读**全状态**（含 superseded），不能只看 active：
    //   某群唯一的画像被覆盖掉之后，active 视图会丢掉那个群的水位，
    //   整段历史会被当成「从未提炼」重新炼一遍 —— 不报错，纯白烧配额。
    //   再并上扫描游标：整段 SKIP 的批次没有落盘条目，只有游标记得它炼过了。
    const personAll = readPerson(p.userId);
    const wm = effectiveWatermarks(personAll.list, cursorAll[p.userId]);
    const unrefined = p.messages.filter((m) => (Number(m.ts) || 0) > (wm.get(m._chatKey) || 0));
    const pChatKeys = [...new Set(p.messages.map((m) => m._chatKey).filter(Boolean))];
    const cands = allCands.filter((c) => String(c.fromUserId) === p.userId);
    const verdict = shouldRefine({
      unrefinedCount: unrefined.length,
      lastRefinedAt: oldestWatermark(pChatKeys, wm),
      now,
      refinedSomewhere: wm.size > 0
    });
    if (!verdict.ok) {
      // ── T6 候选池兜底（§5.1.7 的「最老 pending > 7 天」）────────────────────
      // 只挂在**这条已有的日级路径**上，不另起定时器（硬约束 ⑦）。
      // 判据只看条目年龄，不看这个人最近有没有说话 —— 正因为他不说话了才需要兜底。
      const stale = pickStaleCandidates(cands, { now });
      if (!stale.length) { stat.skipped += 1; await compressOne(p.userId); continue; }
      if (refineCalls >= refineBudget) { stat.budgetHit = true; break; }
      attempts += 1;
      const ctx = new Map();
      for (const c of stale) ctx.set(c.entryId, contextAround(msgByChat.get(c._chatKey), c.msgId));
      const fb = await refineCandidates(
        { userId: p.userId, nickname: p.nickname, chatKeys: pChatKeys },
        { candidates: stale, contextByCandidate: ctx, memLlmImpl, now, log, callsLeft: refineBudget - refineCalls }
      );
      refineCalls += fb?.stats?.calls || 0;
      stat.callsUsed += fb?.stats?.calls || 0;
      stat.added += fb?.stats?.added || 0;
      stat.produced += fb?.stats?.produced || 0;
      stat.overflow += fb?.stats?.overflow || 0;
      stat.badOp += fb?.stats?.badOp || 0;
      if (fb?.ok) stat.candidateFallback += 1;
      else {
        stat.failed += 1;
        const reason = fb?.reason || 'unknown';
        stat.failReasons[reason] = (stat.failReasons[reason] || 0) + 1;
      }
      await compressOne(p.userId);
      if (refineCalls >= refineBudget) { stat.budgetHit = true; break; }
      continue;                       // 兜底跑完这个人就收工，不同一轮再走正常提炼
    }

    attempts += 1;
    const r = await refine(
      { userId: p.userId, nickname: p.nickname, chatKeys: pChatKeys },
      {
        rawMessages: unrefined, candidates: cands, memLlmImpl, now, log,
        callsLeft: refineBudget - refineCalls      // ★ ⑥ 预算进 refine：批边界检查，不再靠人边界兜
      }
    );
    refineCalls += r?.stats?.calls || 0;
    stat.callsUsed += r?.stats?.calls || 0;
    stat.added += r?.stats?.added || 0;          // 失败的 run 也可能有已落盘的批次
    stat.superseded += r?.stats?.superseded || 0;
    stat.produced += r?.stats?.produced || 0;    // ⑦ 最终 active 条数（坍缩时这里会明显小于 added）
    stat.overflow += r?.stats?.overflow || 0;
    stat.badOp += r?.stats?.badOp || 0;
    stat.badRef += r?.stats?.badRef || 0;
    stat.pinnedRefIgnored += r?.stats?.pinnedRefIgnored || 0;
    stat.zeroParsed += r?.stats?.zeroParsed || 0;
    await compressOne(p.userId);
    if (!r?.ok) {
      stat.failed += 1;
      const reason = r?.reason || 'unknown';
      stat.failReasons[reason] = (stat.failReasons[reason] || 0) + 1;   // ⑧ 供失败重试判定配额类/网络类
      log(`[l1] ${p.userId}(${p.nickname || '?'}) 提炼失败：${reason}`
        + `${r?.stats?.added ? `（已落盘 ${r.stats.added} 条，下 tick 续跑）` : ''}`);
      if (refineCalls >= refineBudget) { stat.budgetHit = true; break; }
      continue;
    }
    // ★ ⑥ 预算内断（aborted）：不是失败。已落盘批次保留、水位已推进，下 tick 从断点续跑。
    if (r.aborted) {
      stat.budgetHit = true;
      stat.abortedPeople += 1;
      stat.abortedAdded += Number(r.stats?.added) || 0;
      stat.abortedCalls += Number(r.stats?.calls) || 0;
      log(`[l1] ${p.userId}(${p.nickname || '?'}) 本 tick 调用预算用尽 → 停在第 ${r.stats?.calls || 0} 次，下 tick 续跑`);
      break;
    }
    stat.refined += 1;

    // 候选池收尾：提炼跑过就算裁决完毕 —— 有产出记 adopted，判为空记 dropped。
    // 留痕而不删除（§2.3），所以 UI 以后能回答「这条为什么没进画像」。
    // ★ 回写用 c._chatKey（候选池按群存），不是人的 chatKeys。
    const outcome = (r.stats?.added || 0) > 0 ? 'adopted' : 'dropped';
    for (const c of cands) setCandidateStatus(c._chatKey, c.entryId, outcome, { nowTs: now });
    log(`[l1] ${p.userId}(${p.nickname || '?'}) 群=${p.chatKeys.size} → ${outcome} +${r.stats?.added || 0} 条`
      + ` / 终态 ${r.stats?.produced ?? '?'} 条`
      + `${r.stats?.superseded ? ` / 覆盖 ${r.stats.superseded}` : ''}`
      + `${r.stats?.markedDeduped ? ` / 标记去重 ${r.stats.markedDeduped}` : ''}`
      + `${r.collapsed ? ' / ⚠️ 坍缩放弃写回' : ''}`
      + `${r.stats?.badMsgIds ? ` / 坏序号 ${r.stats.badMsgIds}` : ''}`
      + `${r.stats?.badDedupIds ? ` / 坏组号 ${r.stats.badDedupIds}` : ''}`
      + `${r.stats?.overflow ? ` / 溢出 ${r.stats.overflow}` : ''}`
      + `${r.stats?.pinnedRefIgnored ? ` / 忽略钉住引用 ${r.stats.pinnedRefIgnored}` : ''}`);

    // ★ 调用预算：达到即收工。逐批落盘后这里 break 不作废任何东西。
    if (refineCalls >= refineBudget) { stat.budgetHit = true; break; }
  }

  // 队列里没被上面覆盖到的人（<30 条消息、但画像脏）：只压缩，不提炼。
  for (const q of queue) {
    if (compressed.has(q.uid)) continue;
    await compressOne(q.uid);
  }
  stat.profileCovered = profileCoverage();
  return stat;
}

/**
 * 日级任务：全量读入 → 按人聚合 → 扫一轮。候选池兜底的「最老 > 7 天」也在这一轮里被覆盖。
 *
 * ★ 一条新消息都没有也要跑：画像压缩队列与冲突逾期都不依赖「今天有人说话」。
 *   安静的一天恰恰是补脏画像的时候（sweepPeople 的人循环为空，只走队列补压缩）。
 */
export async function runDailySweep({
  store, chatKeys = null, now = Date.now(), log = () => {}, memLlmImpl = memLlm,
  maxPeople = MAX_PEOPLE_PER_TICK, maxCalls = Number.POSITIVE_INFINITY
} = {}) {
  const keys = Array.isArray(chatKeys) ? chatKeys : (store?.listChats?.() || []);
  const sources = [];
  for (const chatKey of keys) {
    const messages = store?.rangeByTs?.(chatKey, { fromTs: 0, toTs: now }) || [];
    if (messages.length) sources.push({ chatKey, messages });
  }
  const total = {
    chats: sources.length, refined: 0, skipped: 0, added: 0, produced: 0,
    calls: 0, callsUsed: 0, failed: 0, failReasons: {}, budgetHit: false,
    abortedPeople: 0, abortedAdded: 0, abortedCalls: 0,
    candidateFallback: 0, conflictsResolved: 0,
    overflow: 0, badOp: 0, badRef: 0, pinnedRefIgnored: 0, zeroParsed: 0,
    profilesBuilt: 0, profileCalls: 0, profileDirty: 0, profileSkipped: 0, profilePending: 0,
    profileCovered: { withProfile: 0, withActive: 0 }
  };
  const s = await sweepPeople({ sources, now, log, memLlmImpl, maxPeople, maxCalls });
  Object.assign(total, {
    refined: s.refined, skipped: s.skipped, added: s.added, produced: s.produced,
    calls: s.callsUsed, callsUsed: s.callsUsed, failed: s.failed,
    candidateFallback: s.candidateFallback || 0,
    failReasons: s.failReasons || {}, budgetHit: s.budgetHit === true,
    abortedPeople: s.abortedPeople || 0, abortedAdded: s.abortedAdded || 0,
    abortedCalls: s.abortedCalls || 0,
    overflow: s.overflow || 0, badOp: s.badOp || 0, badRef: s.badRef || 0,
    pinnedRefIgnored: s.pinnedRefIgnored || 0, zeroParsed: s.zeroParsed || 0,
    profilesBuilt: s.profilesBuilt || 0, profileCalls: s.profileCalls || 0,
    profileDirty: s.profileDirty || 0, profileSkipped: s.profileSkipped || 0,
    profilePending: s.profilePending || 0, profileCovered: s.profileCovered || total.profileCovered
  });
  // 冲突 7 天默认放行也挂在这一轮（§7-③）。不另起定时器，也不需要 LLM —— 纯状态流转。
  // 判据只看「立起来多久了」，跟有没有人说话无关：群里安静不该让冲突继续挂着。
  const cf = sweepConflicts({ now, log });
  total.conflictsResolved = cf.resolved;
  // 预算中断时 refined=0，但 calls/added 已经发生 —— 不打印会让整轮看起来没跑
  if (total.refined || total.failed || total.profilesBuilt || total.profileSkipped || total.zeroParsed
    || total.added > 0 || total.calls > 0) {
    const tb = tokenBudgetSnapshot({ now });
    const cov = total.profileCovered || { withProfile: 0, withActive: 0 };
    log(`[l1] 日扫完成：群=${total.chats} 提炼=${total.refined} 跳过=${total.skipped}`
      + ` 新增=${total.added} 终态=${total.produced} 调用=${total.calls}`
      + ` 溢出=${total.overflow} 坏op=${total.badOp} 解析0条=${total.zeroParsed}`
      + `${total.abortedPeople ? ` 中断=${total.abortedPeople}/新增${total.abortedAdded}/调用${total.abortedCalls}` : ''}`
      + ` 画像=建${total.profilesBuilt}/脏${total.profileDirty}/省${total.profileSkipped}`
      + `/待${total.profilePending}/覆盖${cov.withProfile}/${cov.withActive}`
      + `${cov.skippedNonQq ? ` 非QQ文件=${cov.skippedNonQq}` : ''}`
      + ` token余=${tb.remaining}/${tb.limit}`
      + `${total.badRef ? ` 越界引用=${total.badRef}` : ''}`
      + `${total.pinnedRefIgnored ? ` 忽略钉住引用=${total.pinnedRefIgnored}` : ''}`
      + `${total.candidateFallback ? ` 候选兜底=${total.candidateFallback}` : ''}`
      + `${total.conflictsResolved ? ` 冲突逾期了结=${total.conflictsResolved}` : ''}`
      + `${total.failed ? ` 失败=${total.failed}` : ''}`);
  }
  return total;
}

// ── 跨群索引聚合（§5.7）──────────────────────────────────────────────────
//
// 索引只回答「这个人在哪几个群、各群叫什么」三个字段。**不存关注点**：
// 关注点现读各群 L1 —— 存一份就是第二份真相，改一处忘一处，而且违反单层单写。
// 昵称按 chatKey 分开存（同一个人在不同群叫法不同，合并成一个数组就丢了"哪群的叫法"）。

/**
 * 把多群的发言人聚合成交叉索引条目。
 *
 * @param {Array} sources [{ chatKey, messages }]
 * @returns {Array<{qq, groups, nicknames}>}
 */
/**
 * @deprecated 2026-11-15：L1 改成按人存后，`sourceChatKeys` 已包含同样的信息
 * （一个人出现在哪些群 = activePerson(uid) 里所有 sourceChatKeys 的并集）。
 * 第 3 期要「这人在哪些群」时直接读画像，不要再生成一份索引文件 —— 两份真相必然不一致。
 * 保留函数仅为兼容既有测试，**不要接线**。
 */
export function aggregateIndex(sources) {
  const byQq = new Map();
  for (const src of Array.isArray(sources) ? sources : []) {
    const chatKey = String(src?.chatKey || '');
    if (!chatKey) continue;
    for (const m of Array.isArray(src?.messages) ? src.messages : []) {
      if (!m || m.self) continue;
      const qq = String(m.senderId || m.uid || '').trim();
      if (!qq) continue;
      if (!byQq.has(qq)) byQq.set(qq, { qq, groups: [], nicknames: {} });
      const rec = byQq.get(qq);
      if (!rec.groups.includes(chatKey)) rec.groups.push(chatKey);
      const nick = flat(m.senderName);
      if (nick) {
        const arr = rec.nicknames[chatKey] || (rec.nicknames[chatKey] = []);
        if (!arr.includes(nick)) arr.push(nick);
      }
    }
  }
  return [...byQq.values()].sort((a, b) => String(a.qq).localeCompare(String(b.qq)));
}

/** 聚合后落盘（每次一行快照，读时按 qq 取最后一行）。 */
export function refreshCrossGroupIndex(sources) {
  const entries = aggregateIndex(sources);
  for (const e of entries) appendGlobalIndex(makeIndexEntry(e));
  return entries.length;
}

/** 失败重试参数（§16.5 ⑧）：10 分钟一次、最多 6 次，之后放弃本窗口等下一固定槽。 */
export const RETRY_DELAY_MS = 10 * 60 * 1000;
export const MAX_RETRIES = 6;
/** 这些失败原因是「当日预算用完」，重试没有意义（只烧日志）。 */
export const QUOTA_FAIL_REASONS = Object.freeze(['quota', 'budget-exceeded', 'single-call-aborted']);
/** 固定槽默认值（本地时间整点）与槽后宽限期。 */
export const DEFAULT_SLOTS = Object.freeze([0, 6, 12, 18]);
export const DEFAULT_GRACE_MS = 10 * 60 * 1000;
/** 补跑 / 重试恢复的抖动上限（防多实例同时启动撞车）。 */
export const CATCHUP_JITTER_MS = 30 * 1000;

/** slots 非法（空 / 非整数 / 越界）→ 回落默认值并 warn。 */
export function normalizeSlots(raw, log = () => {}) {
  const arr = Array.isArray(raw) ? raw : [];
  const valid = arr.length > 0 && arr.every((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  if (!valid) {
    if (raw !== undefined && raw !== null) log(`[l1] slots 非法（${JSON.stringify(raw)}），回落 ${DEFAULT_SLOTS.join('/')}`);
    return [...DEFAULT_SLOTS];
  }
  return [...new Set(arr)].sort((a, b) => a - b);
}

const localMidnight = (ts) => {
  const d = new Date(Number(ts));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const atHour = (midnight, h) => {
  const d = new Date(midnight);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
};
const shiftDay = (midnight, days, h) => {
  const d = new Date(midnight);
  d.setDate(d.getDate() + days);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
};

/** 当天最近的已开始槽；早于当天第一个槽时返回前一天最后一个槽。 */
export function slotAtOrBefore(ts, slots = DEFAULT_SLOTS) {
  const list = normalizeSlots(slots);
  const t = Number(ts);
  const mid = localMidnight(t);
  for (let i = list.length - 1; i >= 0; i--) {
    const s = atHour(mid, list[i]);
    if (s <= t) return s;
  }
  return shiftDay(mid, -1, list[list.length - 1]);
}

/** 严格晚于 ts 的下一槽。 */
export function nextSlotAfter(ts, slots = DEFAULT_SLOTS) {
  const list = normalizeSlots(slots);
  const t = Number(ts);
  const mid = localMidnight(t);
  for (const h of list) {
    const s = atHour(mid, h);
    if (s > t) return s;
  }
  return shiftDay(mid, 1, list[0]);
}

const EMPTY_STATE = () => ({
  v: 2, lastAttemptAt: 0, lastSuccessAt: 0, lastSlotTs: 0, retryAt: 0, retryCount: 0, retrySlotTs: 0
});

/**
 * 读 L1 调度状态（v2）。坏文件/缺字段按「无状态」处理，不抛。
 * v1 → v2：保留 lastAttemptAt/lastSuccessAt，retries 映射 retryCount，nextRegularAt 直接丢弃。
 */
function readL1State(statePath, log = () => {}) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') log(`[l1] 状态文件不可读，按无状态处理：${e?.message ?? e}`);
    return EMPTY_STATE();
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    log(`[l1] 状态文件损坏，按无状态处理：${e?.message ?? e}`);
    return EMPTY_STATE();
  }
  if (!j || typeof j !== 'object') {
    log('[l1] 状态文件缺字段，按无状态处理');
    return EMPTY_STATE();
  }
  const v = Number(j.v) || 0;
  if (v < 2 && j.nextRegularAt) log('[l1] 旧状态已升级：nextRegularAt 不再作为锚点');
  return {
    v: 2,
    lastAttemptAt: Number(j.lastAttemptAt) || 0,
    lastSuccessAt: Number(j.lastSuccessAt) || 0,
    lastSlotTs: Number(j.lastSlotTs) || 0,
    retryAt: Number(j.retryAt) || 0,
    retryCount: Number(v < 2 ? (j.retryCount ?? j.retries) : j.retryCount) || 0,
    retrySlotTs: Number(j.retrySlotTs) || 0
  };
}

/** 原子写状态（tmp + rename，与 schema.json 同口径）。 */
function writeL1State(statePath, obj) {
  P.writeJsonAtomic(statePath, { ...obj, v: 2 });
}

let warnedTickMs = false;

/**
 * 挂固定槽日扫定时器（和 startL4 同层）。
 * `enabled` 默认 false：它每天会花掉真实配额，必须显式打开。
 *
 * 2026-11-16（L1 收敛 §2）：tickMs 周期锚点 → **固定槽 00/06/12/18（本地时间）**。
 * - 槽是绝对时刻，重启不漂移；槽后 graceMs 内重启且本槽未扫 → 补跑一次。
 * - 重试状态（retryAt/retryCount/retrySlotTs）跨重启保留；重试点撞上固定槽就并入槽。
 * - 仍是自调度 setTimeout 链，**不新增定时器、不用 setInterval**。
 * - `runNow()` 手动跑一轮：不动固定槽定时器、不建立重试。
 *
 * @param {object} [opts.timerApi] 可注入的 { setTimeout, clearTimeout }（测试用假定时器）
 * @param {string} [opts.statePath] 状态文件路径（测试用临时路径隔离）；默认 mem2Dir/l1-state.json
 */
export function startL1Daily({
  store, l1cfg = {}, log = () => {}, now = Date.now, memLlmImpl = memLlm, timerApi = null,
  statePath = null
} = {}) {
  if (l1cfg?.enabled !== true) return null;
  if (l1cfg.tickMs !== undefined && !warnedTickMs) {
    warnedTickMs = true;
    log('[l1] tickMs 已废弃，调度改为固定槽 00/06/12/18');
  }
  const slots = normalizeSlots(l1cfg.slots, log);
  const graceMs = Number.isFinite(Number(l1cfg.graceMs))
    ? Math.max(0, Number(l1cfg.graceMs)) : DEFAULT_GRACE_MS;
  const maxCalls = Number(l1cfg.maxCallsPerTick) || Number.POSITIVE_INFINITY;
  const timers = timerApi || { setTimeout, clearTimeout };
  const stateFile = statePath || P.l1StateFile();
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (ts) => {
    const d = new Date(Number(ts) || 0);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const fmtHM = (ts) => {
    const d = new Date(Number(ts) || 0);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  let running = false;
  let timer = null;
  let catchupSlotTs = 0;      // 定时器撞上「正在跑」时被跳过的槽，本轮结束后补跑
  let nextRegularAt = 0;
  let pendingSource = 'scheduled';
  let pendingSlotTs = 0;
  const st = readL1State(stateFile, log);

  /** 每次调度、每次尝试前、每次结束后各落一次。 */
  const persist = () => {
    try {
      writeL1State(stateFile, st);
    } catch (e) {
      log(`[l1] 状态落盘失败（已忽略）：${e?.message ?? e}`);
    }
  };

  const schedule = (ts, source = 'scheduled', slotTs = 0) => {
    if (timer) timers.clearTimeout?.(timer);
    nextRegularAt = Number(ts);
    pendingSource = source;
    pendingSlotTs = Number(slotTs) || 0;
    timer = timers.setTimeout(() => {
      runTick({ source: pendingSource, slotTs: pendingSlotTs });
    }, Math.max(0, Number(ts) - Number(now())));
    timer?.unref?.();
    persist();
  };

  const scheduleNextSlot = (fromTs, note = '') => {
    const next = nextSlotAfter(Number(fromTs), slots);
    if (note) log(note);
    log(`[l1] 下一轮：${fmtTime(next)}`);
    schedule(next, 'scheduled', next);
    return next;
  };

  const clearRetry = () => { st.retryAt = 0; st.retryCount = 0; st.retrySlotTs = 0; };

  /** 真正跑一轮（不含忙锁判定；runNow 已同步置锁后直接调它）。 */
  const execTick = async ({ source = 'scheduled', slotTs = 0 } = {}) => {
    running = true;
    const attemptAt = Number(now());
    st.lastAttemptAt = attemptAt;
    if (source === 'scheduled') st.lastSlotTs = Number(slotTs) || attemptAt;
    if (source === 'retry') {
      log(`[l1] 重试轮开始 retriedFrom=${fmtHM(Number(slotTs) || st.retrySlotTs)}（第 ${st.retryCount}/${MAX_RETRIES} 次）`);
    }
    persist();

    let total = null;
    let threw = false;
    try {
      total = await runDailySweep({ store, now: attemptAt, log, memLlmImpl, maxCalls });
    } catch (error) {
      threw = true;
      log(`[l1] 日扫异常（已忽略，不影响主链路）：${error?.message ?? error}`);
    } finally {
      running = false;
    }

    // 失败判定：抛异常，或「有失败 / 零提炼 / 零落盘 / 全部非配额类」
    let failure = threw;
    if (!threw && total) {
      const reasons = Object.keys(total.failReasons || {});
      const allNonQuota = reasons.length > 0 && reasons.every((r) => !QUOTA_FAIL_REASONS.includes(r));
      failure = total.failed > 0 && total.refined === 0 && total.added === 0 && allNonQuota;
    }
    const success = !threw && !failure;
    const endAt = Number(now());

    // ★ 忙时被跳过的槽：本轮结束后补跑（2026-11-17 复核补）。
    //   原实现只把定时器重排到下一槽，当前槽就这么丢了 —— 手动轮跑 10 分钟、
    //   正好压住 12:00，那一槽的提炼永远不会发生，也不报错。补跑仍在 grace 内才做。
    const catchup = catchupSlotTs;
    catchupSlotTs = 0;
    if (catchup && st.lastSlotTs < catchup) {
      if (endAt - catchup <= graceMs) {
        log(`[l1] 补跑被跳过的 ${fmtHM(catchup)} 槽（上一轮占用期间触发）`);
        // ★ 注意语义（2026-11-17 复核指出）：这里是**在失败判定之后、重试分支之前**返回，
        //   所以被补跑顶掉的那一轮不递增 retryCount。可接受——补跑本身失败会走重试；
        //   别误以为「原失败轮也被记了一次重试」。
        return execTick({ source: 'scheduled', slotTs: catchup });
      }
      log(`[l1] 被跳过的 ${fmtHM(catchup)} 槽已超宽限 ${Math.round(graceMs / 60000)} 分钟，放弃`);
    }

    if (success) {
      st.lastSuccessAt = endAt;
      clearRetry();
      persist();
      // 重试成功也要把定时器拉回固定槽；手动轮不动定时器
      if (source !== 'manual') scheduleNextSlot(endAt);
      return { ok: true, source, total };
    }

    if (source === 'manual') {
      persist();
      log(`[l1] 手动轮失败（不重试，等下一槽或再点「立刻运行」）`);
      return { ok: false, source, total };
    }

    st.retryCount += 1;
    const next = nextSlotAfter(endAt, slots);
    if (st.retryCount <= MAX_RETRIES) {
      const retryAt = Math.min(endAt + RETRY_DELAY_MS, next);
      if (retryAt >= next) {
        clearRetry();
        persist();
        log(`[l1] 重试点与固定槽重叠，并入 ${fmtHM(next)} 槽`);
        schedule(next, 'scheduled', next);
        return { ok: false, source, retried: false, total };
      }
      st.retryAt = retryAt;
      st.retrySlotTs = Number(slotTs) || slotAtOrBefore(endAt, slots);
      persist();
      log(`[l1] 本 tick 疑似网络故障（${total?.failed ?? 0} 次失败 / 0 产出），`
        + `${fmtTime(retryAt)} 重试（第 ${st.retryCount}/${MAX_RETRIES} 次）retriedFrom=${fmtHM(st.retrySlotTs)}`);
      schedule(retryAt, 'retry', st.retrySlotTs);
      return { ok: false, source, retried: true, total };
    }
    log(`[l1] 连续 ${MAX_RETRIES} 次重试仍失败，放弃本窗口，等下一槽`);
    clearRetry();
    persist();
    schedule(next, 'scheduled', next);
    return { ok: false, source, retried: false, total };
  };

  const runTick = async (opts = {}) => {
    const source = opts?.source || 'scheduled';
    if (running) {
      // 定时器触发时若忙 → 重排下一槽，不能让 setTimeout 链断掉；
      // 同时把这一槽记进 catchupSlotTs，等当前轮结束后补跑（见 execTick 尾部）。
      if (source !== 'manual') {
        const slotTs = Number(opts?.slotTs) || 0;
        const skipped = slotTs || nextSlotAfter(Number(now()), slots);
        if (slotTs) catchupSlotTs = Math.max(catchupSlotTs, slotTs);
        log(`[l1] 上一轮未结束，跳过 ${fmtHM(skipped)} 槽`);
        scheduleNextSlot(Number(now()));
      }
      return { busy: true };
    }
    return execTick({ source, slotTs: Number(opts?.slotTs) || 0 });
  };

  // ── 启动恢复（§2.3）──
  const curNow = Number(now());
  const nextSlot = nextSlotAfter(curNow, slots);
  const jitter = () => Math.floor(Math.random() * CATCHUP_JITTER_MS);
  if (st.retryAt) {
    if (st.retryAt >= nextSlot || nextSlot - curNow <= graceMs) {
      log(`[l1] 重试点与固定槽重叠，并入 ${fmtHM(nextSlot)} 槽`);
      clearRetry();
      schedule(nextSlot, 'scheduled', nextSlot);
    } else if (st.retryAt <= curNow) {
      const slotTs = st.retrySlotTs || slotAtOrBefore(st.retryAt, slots);
      log(`[l1] 发现重试状态（上次 ${fmtTime(st.lastAttemptAt)}，第 ${st.retryCount}/${MAX_RETRIES} 次），`
        + `retryAt 已过 → 立即恢复 retriedFrom=${fmtHM(slotTs)}`);
      schedule(curNow + jitter(), 'retry', slotTs);   // ★ 不改 lastSlotTs
    } else {
      const slotTs = st.retrySlotTs || slotAtOrBefore(st.retryAt, slots);
      log(`[l1] 发现重试状态（上次 ${fmtTime(st.lastAttemptAt)}，第 ${st.retryCount}/${MAX_RETRIES} 次），`
        + `距下一槽 > ${Math.round(graceMs / 60000)} 分钟 → ${fmtTime(st.retryAt)} 恢复 retriedFrom=${fmtHM(slotTs)}`);
      schedule(Math.min(st.retryAt, nextSlot), 'retry', slotTs);
    }
  } else {
    const curSlot = slotAtOrBefore(curNow, slots);
    if (curNow - curSlot <= graceMs && st.lastAttemptAt < curSlot && st.lastSlotTs < curSlot) {
      log(`[l1] 当前槽内补跑（${fmtHM(curSlot)}）`);
      schedule(curNow + jitter(), 'scheduled', curSlot);
    } else {
      schedule(nextSlot, 'scheduled', nextSlot);
    }
  }
  log(`[l1] 已启用：固定槽 ${slots.map(pad2).join('/')}，下一轮 ${fmtTime(nextRegularAt)}`);

  return {
    stop: () => { if (timer) timers.clearTimeout?.(timer); timer = null; },
    tick: runTick,
    runNow: () => {
      if (running) return { started: false, busy: true };
      running = true;                       // ★ 同步置锁，防并发点两下双跑
      queueMicrotask(() => { execTick({ source: 'manual' }).catch(() => {}); });
      return { started: true, nextRegularAt };
    },
    state: () => ({
      v: 2, slots: [...slots], graceMs, maxCalls, nextRegularAt, running,
      lastAttemptAt: st.lastAttemptAt, lastSuccessAt: st.lastSuccessAt, lastSlotTs: st.lastSlotTs,
      retryAt: st.retryAt, retryCount: st.retryCount, retrySlotTs: st.retrySlotTs
    })
  };
}
