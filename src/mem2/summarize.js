// 第 1 期第 5 步：L4 摘要的提示词、输入格式化、行式解析、切片合并、两个零容忍检测器。
//
// 这一层只把「一段 conv」变成「一条结构化摘要」，**不碰任何落盘**。T4 的写入顺序
// （L4 → coverage）在 index.js 的 runConv 里。
//
// 三条硬约束（都来自施工单，写错会把假信息固化进长期记忆）：
//   1. 机器人发言作为**背景**进输入（否则归因伪造），但它的内容一个字不许进摘要
//      —— 输入层标记 + 提示词三条禁令 + 两个检测器，三层缺一层就会漏（§3.2.0 / §4.1）
//   2. 行式输出而不是 JSON：中文 JSON 转义容易错，而行式解析失败只丢那一行
//   3. `selfLeak` / `phantomSilence` 必须为 0，不是「越低越好」—— 它们写进去就清不掉，
//      因为摘要没有「重新生成」的天然触发点（§8.2）

import { extractReasoning } from '../thinking.js';

/** 超过这么多条就切片，各片摘要后再合并（§3.2「长会话切片」）。 */
export const MAX_MSGS_PER_SLICE = 300;
/** 单次输出预算（实测输出约 250 token，留余量但不放到道 1 的预估里） */
export const SUMMARY_MAX_TOKENS = 600;

const pad2 = (n) => String(n).padStart(2, '0');

/** 压平：昵称与正文里的换行会把「一条一层」的输入搅成假的多条记录。 */
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 正文里出现 `[群友]` / `[机器人` 会让模型看到的标记体系失效（一条消息冒充两条，
 * 或者凭空造出一个说话人）。换成全角方括号：语义还在，标记不再成立。
 */
const defuse = (s) => s.replace(/\[群友\]/g, '［群友］').replace(/\[机器人/g, '［机器人');

/**
 * 系统提示词。§4.1 那三条禁令**逐字**在这里，不是「注意一下」——
 * 缺任何一条，`selfLeak` 或 `phantomSilence` 就会 > 0。
 */
export const SYSTEM_PROMPT = `你是群聊记录的整理员。给你一段群聊，用 1~3 句群聊口吻的话概括它。

严格按下面的行式格式输出，不要任何解释、不要 markdown、不要代码块围栏：

SUMMARY: <1~3 句>
SPARSE: <0 或 1>
TOPIC: <一个话题词，没有就写 null>
ENTITY: <实体1> | <实体2>，没有就写 null

规则：
- SUMMARY 要像群聊里的人在转述，不要写成会议纪要或报告腔。
- 允许写「没聊什么，就几个人在刷图」，不要逼自己编出一个话题。
- 判断有没有实质讨论，不看条数，看有没有人在交换信息。以下一律 SPARSE: 1：
  - 以发图 / 发表情包 / 复读 / 斗嘴 / 互拍为主的会话；
  - 几个人只是打招呼、道晚安、开玩笑、互相称呼；
  - 群友没提出也没回答任何具体的事。
  SPARSE: 1 时 SUMMARY 照样如实写（「就几个人在刷图斗嘴」），不要为了有内容去编话题。
- ENTITY 只收能拿去检索的实体（作品名、人名、地名、型号、事件名）。不要收「大家」「今天」这类。

【关于标了「机器人·仅供理解上下文」的消息】
1. 这些消息只用来帮你判断对话走向。它们的观点、结论、数字、事实、
   以及提到的任何具体信息，一个字都不许写进 SUMMARY/TOPIC/ENTITY。
2. 不许把它们的内容当成某位群友说的。群友只说过群友标记下的话。
3. 如果某位群友的提问或说法没有得到【群友】的回应，而中间有机器人消息，
   你可以写「（机器人回应）」，但不要写回应了什么。
   也不要写「没人回答」「无人回应」——你看到的是不完整的对话，
   这样写等于断言一件你不知道的事。
4. 机器人**看图 / 识图 / 转述图片内容**得到的描述，也算机器人内容：
   图里是什么东西、什么型号、图上的字写了什么、画面里发生了什么，
   一个字都不许写进 SUMMARY / TOPIC / ENTITY。
   群友只发了图、没打字说明的，就写「发了张图」，不要写图里有什么。
   只有当那句话是【群友】自己打字说出来的，才可以写。`;

/** 长会话切片后的合并提示词：只读各片的结论，不重读原文（§3.2）。 */
export const MERGE_PROMPT = `你拿到的是同一段长群聊被切成若干片后各自的摘要。请把它们合并成一份，仍然用同样的行式格式输出。

规则：
- SUMMARY 合并成 1~3 句，不要简单拼接，也不要引入下面没有的信息。
- TOPIC / ENTITY 去重合并；ENTITY 最多 8 个。
- SPARSE：各片都标 1 才写 1。`;

/**
 * 把一段 conv 格式化成「一条一层」的输入文本。
 *
 * 每个时刻只在跨天时补一次日期（`MM-DD HH:MM`），其余只写 `HH:MM` ——
 * 元数据实测已占单次 token 的 32%，全量写日期会再涨一截（§7.1）。
 */
export function formatConvMessages(messages, { selfNickname = '' } = {}) {
  const lines = [];
  let lastDay = '';
  for (const m of Array.isArray(messages) ? messages : []) {
    const ts = Number(m?.ts) || 0;
    const d = new Date(ts);
    const day = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const stamp = day !== lastDay ? `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    lastDay = day;
    const who = flat(m?.senderName) || (m?.self ? (selfNickname || '机器人') : '群友');
    const body = defuse(flat(m?.text) || '（无文字）');
    lines.push(`${m?.self ? '[机器人·仅供理解上下文]' : '[群友]'} ${stamp} ${who}：${body}`);
  }
  return lines.join('\n');
}

/** 按 300 条一片切开；不超过就整段一次。 */
export function splitSlices(messages, maxPerSlice = MAX_MSGS_PER_SLICE) {
  const list = Array.isArray(messages) ? messages : [];
  const n = Math.max(1, Number(maxPerSlice) || MAX_MSGS_PER_SLICE);
  if (list.length <= n) return [list];
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// ── 行式解析 ───────────────────────────────────────────────────────────────
// 只认行首字段名。认不出的行若紧跟在 SUMMARY 后面，就当 SUMMARY 的续行
// （模型偶尔把三句话写成三行，直接丢掉会得到一句残缺摘要）。
const KEY_RE = /^(SUMMARY|SPARSE|TOPIC|ENTITY)\s*[:：]\s*(.*)$/i;
const isNull = (v) => !v || /^null$/i.test(String(v).trim());

/** `a | b 、c` → ['a','b','c']（去空、去重、去 null） */
function pushTokens(arr, val) {
  if (isNull(val)) return;
  for (const seg of String(val).split(/[|、]/)) {
    const s = seg.trim();
    if (!s || isNull(s)) continue;
    if (!arr.includes(s)) arr.push(s);
  }
}

/**
 * 行式输出 → 结构。**不做判定**（是否为 failed 由调用方看 `summary` 是否为空）。
 *
 * @returns {{summary:string, sparse:number, topics:string[], entities:string[],
 *            errors:{topic:number}}}
 */
export function parseSummaryOutput(text) {
  const out = { summary: '', sparse: 0, topics: [], entities: [], errors: { topic: 0 } };
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return out;

  let lastKey = '';
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || /^```/.test(t)) continue;              // 空行 / 代码块围栏
    const m = KEY_RE.exec(t);
    if (!m) {
      if (lastKey === 'SUMMARY') out.summary += (out.summary ? ' ' : '') + t;
      continue;
    }
    const key = m[1].toUpperCase();
    const val = m[2].trim();
    lastKey = key;
    if (key === 'SUMMARY') {
      out.summary += (out.summary ? ' ' : '') + val;
    } else if (key === 'SPARSE') {
      out.sparse = /^(1|true|yes|是)/i.test(val) ? 1 : 0;
    } else if (key === 'TOPIC') {
      pushTokens(out.topics, val);
      // TOPIC 行存在但一个词都没抽出来（又不是 null）→ 记一笔，模型可能写了整句
      if (!out.topics.length && !isNull(val)) out.errors.topic += 1;
    } else if (key === 'ENTITY') {
      pushTokens(out.entities, val);
    }
  }
  out.summary = flat(out.summary);
  return out;
}

// ── 两个零容忍检测器（§8.2 给了口径，别自己发挥）──────────────────────────
// `（机器人回应）` 是**唯一允许**提到机器人的写法（§3.2.0），必须先摘掉它，
// 否则检测 ②「机器人作主语」会把合法摘要判死。
const ALLOWED_RE = /[（(]\s*机器人\s*(?:回应|答复|回答|回复)?\s*[)）]/g;

// 中文「虚词/结构字」。4 字滑窗跨过这些字时，切出来的就是伪片段：
//   「的聊天记录」→ 滑窗出「的聊天记」，但「聊天记录」才是真词（的 = 结构助词）
//   「基本就是」  → 滑窗出「基本就是」，但「基本」「就是」是两个词（就 = 副词）
const STOP_CHARS = new Set('的了着呢吗吧啊哦呀哈哟是就有都又还和与在把被从对向这那我你他她它们个说很太更最也再才就但而或却若则之其所以因为'.split(''));

/**
 * 把一段中文切成「实词段」：连续 CJK 字符段，遇到停用字就断开。
 * 这是 5b 把「4 字滑窗」换成「按词匹配」的地基。
 *
 * 为什么要切：滑窗的根因不是「窗口」，而是它**跨词边界**切出人为唯一的伪片段。
 * 停用字是最可靠的词边界信号之一（不需要分词库，也不引入不稳定的 Intl.Segmenter
 * 那种把「大肥鱼」切成「大肥」「鱼」的过度切分）。
 *
 * ⚠️ 这是「修准」不是「放宽」：真泄漏的特征是「只有机器人说过的**实词内容**」，
 * 停用字切分只剥离「的/了/就/是」这类无实义的粘连，不碰实词本身。
 */
export function tokenizeCJK(text) {
  const src = String(text ?? '');
  const out = [];
  // CJK 段按停用字断开；ASCII（数字/字母）段单独成 token —— 「11月20号」「OTS-14」
  // 这类数字/英文片段是复述/泄漏的常见载体，丢不得（#19 归因伪造就靠「11 月 20 号」）。
  const re = /[\u3400-\u4dbf\u4e00-\u9fff]+|[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tok = m[0];
    if (/^[A-Za-z0-9]+$/.test(tok)) {
      // ASCII token：≥3 才有判别力（「20」太短，「OTS」够）
      if (tok.length >= 3) out.push(tok);
      continue;
    }
    let cur = '';
    for (const ch of tok) {
      if (STOP_CHARS.has(ch)) { if (cur.length >= 2) out.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.length >= 2) out.push(cur);
  }
  return out;
}

/**
 * 机器人消息里「数字 + 中文单位」混合片段（如「11 月 20 号」）的兜底提取。
 * 停用字切分会把「11 月 20 号」切成「11」「月」「20」「号」四个短 token，全被丢弃，
 * 但这类片段恰恰是「复述机器人某句具体的话」的强信号（#19 归因伪造）。
 * 所以对「含数字/字母的连续片段」单独走一条滑窗通道：压掉空白后滑 3~8 字，
 * 只保留含数字或字母的窗口（纯中文走 tokenizeCJK 那条，别在这里重复）。
 */
function numericFragments(text) {
  // ★ 不压空格：机器人消息经过 flat 后是单空格分隔（「11 月 20 号」），摘要也是同一
  //   口径。压掉空格会让片段「11月20号」对不上摘要里的「11 月 20 号」，永远 hit 不到。
  const src = String(text ?? '');
  const out = new Set();
  for (let len = 10; len >= 3; len -= 1) {
    for (let i = 0; i + len <= src.length; i += 1) {
      const frag = src.slice(i, i + len);
      if (!/[0-9]/.test(frag)) continue;                // 只关心含数字的片段
      // 去首尾空白，避免「 11 月」「号 」这种带边界空格的伪片段
      const trimmed = frag.trim();
      if (trimmed.length < 3) continue;
      out.add(trimmed);
    }
  }
  return [...out];
}

// 片段的最小长度：2 字太泛（「活动」「结束」这种通用词在摘要里到处撞），
// 3 字起才有「复述了机器人某句具体的话」的判别力。真泄漏样例（服务器炸 / 查好感度 /
// 皮皮丘）都 ≥3 字，不受影响。
const MIN_FRAG_LEN = 3;

/**
 * 一个实词段里的所有「≥2 字连续子片段」+ 段本身。保留捕捉力：
 * 「聊天记录整理」要能抽出「聊天记录」这个真词；「服务器炸」要能整段命中。
 */
function subSegments(seg) {
  const out = new Set();
  const n = seg.length;
  for (let len = n; len >= MIN_FRAG_LEN; len -= 1) {
    for (let i = 0; i + len <= n; i += 1) out.add(seg.slice(i, i + len));
  }
  return out;
}

/**
 * 摘要里是否出现作主语的「机器人|bot|我」/ 机器人原话的片段。
 *
 * ★ `humanTexts` 是第 5 期补上的（补丁 v1.6）：fragment 这一道必须能区分
 *   「机器人原创」与「机器人复读群友」，否则群聊里机器人话越多、摘要越容易
 *   和它撞词 —— 实测 157 次命中里 143 次（91%）是人类先说过的话。
 *
 * ★ 5b：fragment 从「4 字滑窗」改为「按词匹配」（tokenizeCJK + 子片段）。
 *   匹配单位从「任意 4 字」变成「实词段」，跨词边界的伪片段（的聊天记/基本就是）
 *   不再产生。豁免判据仍是「人类也说过这个实词内容」—— 口径没变，只是粒度变准。
 *
 *   ⚠️ 不是放松：把人类消息抽掉后，真泄漏照样报（#18 反证断言盯着）。
 */
export function detectSelfLeak(summary, { botTexts = [], humanTexts = [] } = {}) {
  const hits = [];
  const src = String(summary ?? '');
  if (!src) return hits;
  const s = src.replace(ALLOWED_RE, '');

  // 「说了什么」的限定词不能少：只出现「机器人」三个字本身是允许的（摘掉允许写法之后
  // 还留着，说明模型在拿它当主语陈述内容）
  const SUBJ = [
    /机器人(?:说|答|回|讲|提到|表示|认为|告诉|给出|解释|回复)/,
    /(?<![A-Za-z])(?:bot|BOT|Bot)(?:说|答|回|said|says)/i,
    /(?:^|[^们我])我(?:说|答|回|觉得|认为|记得)/       // 「我们」不算
  ];
  for (const re of SUBJ) {
    const m = re.exec(s);
    if (m) hits.push(`subject:${m[0]}`);
  }

  // ③ fragment：机器人的话一旦被复述，必然留下片段。
  //    人类池也切成同样的实词段，用「实词集合」比对（不是整段全文 includes ——
  //    那样会把「大肥鱼视」这类跨词残片漏判成复读，也会把真泄漏的整句漏判）。
  const humanSegs = new Set();
  for (const raw of Array.isArray(humanTexts) ? humanTexts : []) {
    for (const seg of tokenizeCJK(flat(raw))) {
      for (const sub of subSegments(seg)) humanSegs.add(sub);
    }
    for (const nf of numericFragments(flat(raw))) humanSegs.add(nf);
  }

  for (const raw of Array.isArray(botTexts) ? botTexts : []) {
    const t = flat(raw);
    if (t.length < 4) continue;                        // 太短没有判别力（「哈哈」）
    if (/^\[.*\]$/.test(t)) continue;                   // [表情包:xxx] 这类占位符
    // 两条通道：CJK 实词（按词，消除虚词粘连）+ 数字混合（兜底，保留「11月20号」）
    const candidates = [];
    for (const seg of tokenizeCJK(t)) for (const sub of subSegments(seg)) candidates.push(sub);
    for (const nf of numericFragments(t)) candidates.push(nf);
    // 从长到短扫：更长的片段才是「复述」，短的是残片
    candidates.sort((a, b) => b.length - a.length);
    for (const w of candidates) {
      if (w.length < MIN_FRAG_LEN) continue;
      if (!s.includes(w)) continue;
      if (humanSegs.has(w)) continue;                   // ★ 复读豁免：人类也说过这个实词
      hits.push(`fragment:${w}`);
      break;
    }
  }
  return [...new Set(hits)];
}

/**
 * 摘要里是否编造了「没人回答」——实际可能有机器人回复，只是被标记隔离了。
 *
 * 前五条都是多字词，直接 `includes` 就够。只有 `没回` 是两字词，直接匹配会把
 * 「他没回家」「还没回来」也算成编造沉默（那是在讲事实，不是断言没人回应），
 * 所以它额外要求**后面不是汉字**（句末/标点/空白才算这个短语用完了）。
 */
const PHANTOM = ['没人回答', '无人回应', '没有人理', '未回应', '没人接'];

export function detectPhantomSilence(summary) {
  const src = String(summary ?? '');
  if (!src) return [];
  const s = src.replace(ALLOWED_RE, '');
  const hits = PHANTOM.filter((k) => s.includes(k));
  if (/没回(?=$|[^\u4e00-\u9fa5])/.test(s)) hits.push('没回');
  return hits;
}

// ── 摘要主流程（T3）──────────────────────────────────────────────────────

function buildMessages(system, userText) {
  return [{ role: 'system', content: system }, { role: 'user', content: userText }];
}

/**
 * 调 LLM 把一段 conv 变成摘要结构。失败一律返回 `{ok:false, reason}`，不抛。
 *
 * @param {object} p
 * @param {object} p.conv        {messages, startTs, endTs}
 * @param {Function} p.llm       memLlm（测试注入 fake）
 * @returns {Promise<{ok:true,summary,sparse,topics,entities,parseErrors,slices}
 *                  |{ok:false,reason,hadReasoning?}>}
 */
export async function summarizeConv({
  chatKey = '', conv = null, llm, now = Date.now(), persona = null,
  maxPerSlice = MAX_MSGS_PER_SLICE, maxTokens = SUMMARY_MAX_TOKENS,
  // ★ 第 5 期：kind 由 runConv 穿下来（回填 = 'backfill-l4'）。
  //   两处 llm(...) 都必须用它 —— 只改一处的话，切片会话的合并片仍记在 summary 上，
  //   回填就会"大部分独立记账、少数几片撞日配额"，是最难查的一种半对。
  kind = 'summary'
} = {}) {
  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  const selfNickname = flat(persona?.selfNickname);
  const slices = splitSlices(msgs, maxPerSlice);
  const parts = [];

  for (let i = 0; i < slices.length; i += 1) {
    const body = formatConvMessages(slices[i], { selfNickname });
    const head = slices.length > 1
      ? `以下是群聊记录第 ${i + 1}/${slices.length} 片（${slices[i].length} 条）。`
      : `以下是群聊记录（${slices[i].length} 条）。`;
    const r = await llm(kind, { messages: buildMessages(SYSTEM_PROMPT, `${head}\n\n${body}`), maxTokens, now });
    if (!r?.ok) return { ok: false, reason: r?.reason || 'call-error' };
    const content = String(r.result?.message?.content ?? '').trim();
    if (!content) {
      // 兜底口径（§1 第 3 项）：思考过程是给模型的草稿，不是给群友看的话。
      // 取到也不当摘要用，一律 failed —— 否则等于把草稿写进长期记忆。
      const hadReasoning = Boolean(extractReasoning(r.result?.message));
      return { ok: false, reason: 'empty-content', hadReasoning };
    }
    parts.push(parseSummaryOutput(content));
  }

  // 单片的 summary 是空的 → 缺 SUMMARY 行，判 failed（§8.1 #5）
  if (!parts.length || !parts[0].summary) return { ok: false, reason: 'parse-failed' };
  let fin = parts[0];

  if (parts.length > 1) {
    const recap = parts.map((p, i) => `【第 ${i + 1} 片】\n`
      + `SUMMARY: ${p.summary}\n`
      + `TOPIC: ${p.topics.length ? p.topics.join(' | ') : 'null'}\n`
      + `ENTITY: ${p.entities.length ? p.entities.join(' | ') : 'null'}`)
      .join('\n\n');
    const r = await llm(kind, {
      messages: buildMessages(MERGE_PROMPT, `各片摘要如下：\n\n${recap}`), maxTokens, now
    });
    if (!r?.ok) return { ok: false, reason: r?.reason || 'call-error' };
    const content = String(r.result?.message?.content ?? '').trim();
    if (!content) {
      return { ok: false, reason: 'empty-content', hadReasoning: Boolean(extractReasoning(r.result?.message)) };
    }
    fin = parseSummaryOutput(content);
    if (!fin.summary) return { ok: false, reason: 'parse-failed' };
  }

  // 两个零容忍检测：命中即 failed。这里不做「降级成只删那半句」的处理 ——
  // 模型编出来的东西删一半还是错的，而 failed 会留下覆盖表记录，看得见。
  const botTexts = msgs.filter((m) => m?.self).map((m) => m.text);
  const humanTexts = msgs.filter((m) => !m?.self).map((m) => m.text);   // ★ 复读豁免要用
  const leaks = detectSelfLeak(fin.summary, { botTexts, humanTexts });
  if (leaks.length) return { ok: false, reason: 'self-leak', hits: leaks, summary: fin.summary };
  const silence = detectPhantomSilence(fin.summary);
  if (silence.length) return { ok: false, reason: 'phantom-silence', hits: silence, summary: fin.summary };

  return {
    ok: true,
    summary: fin.summary,
    sparse: fin.sparse,
    topics: fin.topics,
    entities: fin.entities,
    parseErrors: fin.errors,
    slices: slices.length
  };
}
