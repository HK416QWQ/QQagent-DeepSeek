// 第 0 期 2a：B 触发自动检索 —— 只在「有人明确要求回忆某件具体的事」时检索一次，
// 把检索到的原文作为背景塞进上下文。
//
// 2026-11-04 做过一版「静默召回」（每轮无条件抽 2–3 字 n-gram），上线当天整体删除：
// 136 轮注入 29 次只有 8 次相关（27.6%），prompt.js 为此涨了 316 行。所以这里只保留那
// 27.6% 里对的部分，边界按**特征清单**（施工单 §2.8）划，不按行数划：没有 n-gram 滑窗、
// 不是每轮触发（双条件 AND，实测约 1–3 条/天）、没有冷却文件、没有第二个检索模式开关、
// config 只多一个键、抽不出内容词就放弃（宁可漏不可噪）。
// 除 store.search 外零 IO；任何异常静默降级 —— 记忆检索绝不允许拖垮回复主线。

import { isAtMe } from './prompt.js';
import { readCoverage, findConvRow, readSummaryForConv } from './mem2/store.js';

// 精确标记词（13 个，一个不多一个不少）。
// 剔除「之前/以前/当时」：纯口语时间状语，占旧实测触发的 72.9%，相关率仅 ~10%。
// 剔除「答应」：样本里全是梗（「我叫你一声你敢答应吗」），零真回溯。
const MARKERS = ['上次', '上回', '还记得', '记得我', '那次', '说过', '讲过', '提过',
  '前面说', '刚才说', '我跟你说', '那天', '那会儿'];

// 第二人称回溯句式。刻意不含 `你.*答应`（同上，全是梗）。
// 这两支同时满足「回溯语义(A)」和「面向机器人(B)」——见 isRecallIntent 里的注释。
const YOU = /你记[得着]|你(?:上次|之前|刚才|刚刚)说|你不是说/;
// 省主语的疑问「…还记得吗」。**必须带疑问语气**，否则「我还记得捞第一关」
// 「没想到阿宇还记得蝴蝶行动」这类第一/第三人称陈述会被误判成「在问机器人」。
// 间隔放宽到 16 字：「你还记得昨天阿猫阿狗问的那个北约问题吗」中间有 15 字。
const ASK = /还记[得着][^。！!\n]{0,40}[?？吗嘛么呢]/;

// 停用表。必须含标记词，否则「记得」「上次」会被当成内容词拿去检索。
// v1.28 补 `的话`：结构助词，回放实测「你讲过最骚的话是什么？」抽出的「你讲」「过最骚」
// 在库里 hits=0，只剩「的话」可用（hits=33）→ 注入 3 条「打不开的话…」类无关消息。
// 这是第 0 期第一例**自然发生**的误报（@我 + MARKERS 含「讲过」，判定本身没错）。
const STOP = new Set(('你 我 他 她 它 我们 你们 他们 的 了 吗 呢 吧 啊 是 在 和 与 把 被 '
  + '什么 怎么 那个 这个 还 说 问 要 有 没 会 能 就 都 也 '
  + '上次 上回 还记得 记得 记得我 那次 说过 讲过 提过 前面说 刚才说 我跟你说 那天 那会儿 '
  + '我是 谁 '
  + '的话 时候 所以 肯定 过的 好的 '
  // v1.29 全库词频普查（46,463 条）：下列词的 df 在 400–10,255 之间，抽出必然注入大量无关消息。
  // 分两类加，都不指向实体：
  //   ① 元数据：图片/QQ/引用/QWQ/at/reply/image/转发/合并/表情/视频/消息
  //   ② 纯虚词/代词：自己/不是/就是/一个/没有/还是/现在/可以/还有/这么/一下/这样/我的/你的
  // 刻意**不加**实义动词（看到/完成/感觉/看看/喜欢）：它们可能承载语义，且 df 不够高，
  // 靠 searchFor「挑 hits 最少」本来也不会选中。若日后发现被选中，再加不迟。
  + '图片 QQ 引用 QWQ at reply image 转发 合并 表情 视频 消息 '
  + '自己 不是 就是 一个 没有 还是 现在 可以 还有 这么 一下 这样 我的 你的').split(' '));

const SEG = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const HEAD = '【回溯命中】以下是检索到的原始消息（仅作背景，不是你记得的事；没找到就说想不起来）';
// 分词会把「我+还」「我+吗」粘成一个 2 字词，逐个查停用表查不出来（表里只有单字）。
// 这类词由停用单字组成，纯噪音（真实样本里抽到过「我还」「我吗」），整体丢掉。
const STOP1 = new Set([...STOP].filter((w) => w.length === 1));
const noise = (w) => [...w].every((c) => STOP1.has(c));

// 时间词 / 虚指词：出现频率极高、不指向具体实体。拿它们检索只会把「谁都在说时间」捞回来。
// 实测：「你今天跟我说过啥」原来抽出 ["今天","过啥"] → hits=2，命中的是提问自己 +
// 上一次同样的提问。加上这张表后抽词为空 → 不触发（这类问句本来就没有可检索的锚点）。
// v1.28 补 7 个（历史回放实测漏网）：昨晚/前晚/之前/以前/当时 属时间词；
// 有人/什么东西 属虚指（「有人还记得惊喜嘛」抽出「有人」→ 注入「有人给他token」）。
// 注意「之前」当初被 MARKERS 刻意剔除（占旧触发 72.9%、相关率仅 10%），
// 但 VAGUE 实现时漏了它 —— 两张表口径必须一致，否则被剔除的词会从抽词口进来。
const VAGUE = new Set(('今天 昨天 前天 今晚 今早 早上 上午 中午 下午 晚上 凌晨 最近 前几天 刚才 刚刚 '
  + '上次 上回 那天 那会儿 啥 过啥 说啥 什么 哪些 哪个 多久 多少 来着 事情 那些 这些 东西 '
  + '说 说过 聊 聊过 提 提过 讲 讲过 '
  + '昨晚 前晚 之前 以前 当时 有人 什么东西 '
  + '最多 最少 最好 最差 最厉害 '
  // v1.33 · 泛义动词。实证：「你还记得昨天发生什么了吗」分词出 记得|昨天|发生|什么，
  // 前三个全被 STOP/VAGUE 拦掉，只剩「发生」→ hits=2 → 注入两条**以前类似的提问**
  // （「那这个视频里发生了什么」「想一想前天发生了了什么」），模型发现没用，自己又搜了一次。
  // 这类词不指向任何实体，只表示「某事存在」，命中集必然是一堆同句型的话。
  + '发生 觉得 知道 认为 发现 感觉 看到').split(' '));

/** 泛指型提问：「你说过的最X的Y」。
 *
 *  问的是「你（AI）自己说过什么」，不是「我们之间发生过什么」——没有时间锚点、
 *  没有事件锚点，抽词只能抽到「最X的Y」里那个形容词。
 *
 *  3 次自然样本 3 次失败（2026-11-14 凌晨，同一个句式换槽位）：
 *    `你讲过最骚的话是什么`   → 抽 `的话`  → 3 条无关
 *    `你说过的最温柔的话是什么` → 抽 `过的`  → 2 条无关
 *    `你说过的最可爱的话是什么` → 抽 `可爱`  → hits=64，照样注入（词表拦不住实义词）
 *
 *  与「你说过的那句话」区分：特指用「那/这」，泛指用「最」。
 *  与「你上次说的最重要的事」区分：带时间锚点时是真回溯，不排除。 */
const GENERIC = /你(?:说|讲|提)过的?最[^。！？\n]{0,15}的/;
const ANCHOR = /(?:上次|上回|那次|那天|那会儿|之前|以前)/;

/** 双条件 AND：有回溯语义（A）∧ 面向机器人（B）。
 *
 *  ⚠️ 不能用 `(A词 || 你句式) && (at || 你句式)` ——「你句式」同时在两侧时，
 *  它一真整个表达式就恒真，双条件会退化成单条件（实测「我还记得捞第一关」会误触发）。
 *  所以把带疑问约束的省主语问句单独拆成 ASK，且 you / ask 只能整支地同时充当 A 和 B：
 *  它们的语义本身就是「回溯 ∧ 在问你」。 */
export function isRecallIntent(text, { selfNickname = '', botName = '', selfId = '' } = {}) {
  const t = String(text ?? '');
  if (!t) return false;
  const marker = MARKERS.some((k) => t.includes(k));        // A：精确标记词
  const at = isAtMe(t, { selfNickname, botName, selfId });  // B-1：@机器人
  const you = YOU.test(t);                                  // A ∧ B：第二人称
  const ask = ASK.test(t);                                  // A ∧ B：省主语的疑问
  // 泛指型提问直接否掉：它过得了双条件（「说过」在 MARKERS 里、也确实 @ 了我），
  // 但语义上问的是 AI 自身，检索过去只能捞回一堆同形容词的闲聊。
  if (GENERIC.test(t) && !ANCHOR.test(t)) return false;
  // 「你之前说的那个游戏叫什么」不含 13 词表里任何一个，但它本身就是回溯语义，记作 A。
  // 「之前」单独仍在词表外（占旧触发 72.9%、相关率仅 ~10%），只有跟「你…说」同现才算
  // —— 这是词表与句式两把尺子分工，不是把「之前」放回来了。
  return (marker || you || ask) && (at || you || ask);
}

/** 抽内容词：清洗 → 分词 → 连续单字合并（保住专名）→ 停用表 → 前 3 个。
 *  不用 n-gram：「今天」「什么」这类词到处都有，滑窗枚举必然扫进大量噪音。 */
export function pickWords(text, names = []) {
  let t = String(text ?? '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')        // CQ 码
    .replace(/\[引用[^\]]*\]/g, ' ');      // 引用前缀 [引用 某人：...]
  for (const n of names) if (n) t = t.split(`@${n}`).join(' ');
  t = t.replace(/(^|\s)@[^\s]+(?=\s|$)/g, ' ');   // 空白包夹的 @昵称
  const out = [];
  let run = '';                            // 连续单字累积段：这就是专名/生造词
  const flush = () => {
    if (run.length >= 2 && !STOP.has(run) && !noise(run) && !out.includes(run)) out.push(run);
    run = '';
  };
  for (const s of SEG.segment(t)) {
    const w = s.segment.trim();
    if (!w || !s.isWordLike) { flush(); continue; }      // 标点/空白断句
    if (STOP.has(w)) { flush(); continue; }              // 停用词断句：别把「阿杰+是」并成一段
    if (w.length === 1) { run += w; continue; }          // 单字：先攒着
    flush();
    if (!noise(w) && !out.includes(w)) out.push(w);
  }
  flush();
  // 时间词/虚指词不指向任何可检索实体，留着只会匹配到「谁都在说时间」的噪音。
  // 「你今天跟我说过啥」抽完只剩这些 → 返回空 → 整条不触发（这是想要的）。
  return out.filter((w) => !isVague(w)).slice(0, 3);
}

/** 时间词、虚指词、以及「…那事/…的事」这类只指不说的尾缀。 */
function isVague(w) {
  if (VAGUE.has(w)) return true;
  return /(?:那|这|的)?事$/.test(w) && w.length <= 5;   // 「某人那事」「这个事」
}

/** 单词检索：按候选顺序逐个试（最多 2 个），命中即用。
 *
 *  ★ 为什么不用多词 AND：抽出的词全部来自同一句提问，而「所有词同时出现」的消息，
 *  第一条必然是提问自己 —— 实测 [A, B, C] 走 all 只命中 1 条（就是那句提问），
 *  单独用「A」命中上百条。多词 all 是个自我闭环，永远查不到真正的旧事。
 *
 *  @param before 时间上界 = 本轮首条消息的 ts − 1（排除本轮自身，否则每次都注入提问自己）
 */
function searchFor(store, chatKey, words, before) {
  const base = { from: Date.now() - 30 * 864e5, to: before, limit: 5, context: 0, includeSelf: true };
  // 候选按「聚焦度」挑：命中数最少的词最可能是专名/主题词，结果也最集中。
  // 反例：`昨天阿芳问你那个北约的问题` 按分词顺序会先试「阿芳」（群友昵称，11 条），
  // 真正的锚点是「北约」（6 条）。
  // 但 hits=1 要排除 —— 那只剩「提问自己」一种可能（实测某些词只出现在那句提问里）。
  const cand = [];
  for (const w of words.slice(0, 3)) {
    const r = store.search(chatKey, { words: [w], mode: 'any', ...base });
    const n = r?.totalHits || 0;
    if (n > 0) cand.push({ found: r, used: w, n });
  }
  if (!cand.length) return { found: null, used: null };
  const focused = cand.filter((c) => c.n >= 2);
  const pick = (focused.length ? focused : cand).sort((a, b) => a.n - b.n)[0];
  // 命中结果里「本身也是一句回溯提问」的不要 —— 那是别人（或自己之前）在问，不是事实。
  // 实测：不滤的话「某人打某游戏打崩」会注入上一次同样的测试提问。
  // v1.32 再加一层：**合并转发不能当群内证据**。
  // 实测：某群里一条回溯提问抽出的词只命中了别处的合并转发，
  // 既不是本群发生的事，也没有上下文。这类消息充当证据等于凭空捏造一段对话。
  const kept = (pick.found.messages || []).filter((m) => {
    const t = String(m.text ?? '');
    if (/^\s*\[合并转发/.test(t) || /^\s*\[聊天记录\]/.test(t)) return false;
    return !isRecallIntent(t, {});
  });
  return { found: { ...pick.found, messages: kept }, used: pick.used };
}

const pad2 = (n) => String(n).padStart(2, '0');

// ── 第 4 期 · 会话摘要头（2b）────────────────────────────────────────────
//
// 只在「这次回溯问的是某一场对话」时，把那一场的 L4 摘要作为上下文头塞进来。
// 判据用**命中分布**，不做文本分类：同一会话里命中 ≥2 条且占比 ≥50% → 会话级。
//
// 为什么不用「问句里有没有『那天』」这类词法判据：那是第二套判定，会和检索结果
// 打架（问句说会话级、命中却散在三个会话）。命中分布是检索自己给出的证据。
//
// ★ 关闭时必须**逐字节**退回旧口径（200 字），所以下面把 headLine 为空的情况
//   走同一条计算路径（overhead=0），不另写一份渲染。
const HEAD_BUDGET = 200;            // 旧口径（第 0 期 2a 定的硬上限）

const fmtConvLabel = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * 判定这轮能不能带摘要头，并渲染那一行。
 *
 * @param {string} chatKey
 * @param {Array<number>} hitTsList 命中消息的 ts（与渲染同源，不重算 top-4）
 * @param {object} cfg `memory.autoRecallSummaryHead`
 * @param {object} deps 读盘依赖（测试注入）
 * @returns {{line:string, stat:object}}
 */
export function buildSummaryHead(chatKey, hitTsList, cfg = {}, deps = {}) {
  const started = Date.now();
  const stat = { attached: false, reason: 'disabled', chars: 0, ms: 0 };
  if (cfg?.enabled !== true) return { line: '', stat };

  const readCov = deps.readCoverage || readCoverage;
  const readSum = deps.readSummaryForConv || readSummaryForConv;

  // 命中不足 2 条无从判断「会话级」——只有一条命中时任何会话都只占 1/n
  if (!Array.isArray(hitTsList) || hitTsList.length < 2) {
    return { line: '', stat: { ...stat, reason: 'event-level', ms: Date.now() - started } };
  }

  try {
    // ★ 一次 readCoverage 拿 .list，4 个 ts 共用（别每查一次都 filter+sort 全表）
    const covList = readCov(chatKey)?.list || [];
    const perConv = new Map();          // convStartTs -> { n, row }
    for (const ts of hitTsList) {
      const row = findConvRow(covList, ts);
      if (!row) continue;
      const key = Number(row.convStartTs);
      const cur = perConv.get(key) || { n: 0, row };
      cur.n += 1;
      perConv.set(key, cur);
    }
    // 取命中数最多的会话；同票取先出现的（hitTsList 是相关性降序，先出现=更相关）
    let best = null;
    for (const v of perConv.values()) if (!best || v.n > best.n) best = v;

    if (!best) {
      return { line: '', stat: { ...stat, reason: 'no-coverage', ms: Date.now() - started } };
    }
    const minHits = Math.max(1, Number(cfg.minHitsInSameConv) || 2);
    const ratio = Number.isFinite(Number(cfg.sameConvRatio)) ? Number(cfg.sameConvRatio) : 0.5;
    if (best.n < minHits || best.n / hitTsList.length < ratio) {
      return { line: '', stat: { ...stat, reason: 'event-level', ms: Date.now() - started } };
    }
    // 会话不是 ok（short/pending/failed）→ 没有 L4 可带
    if (best.row.state !== 'ok') {
      return { line: '', stat: { ...stat, reason: 'no-l4', convStartTs: Number(best.row.convStartTs), ms: Date.now() - started } };
    }

    const sum = readSum(chatKey, best.row.convStartTs);
    if (!sum) {
      return { line: '', stat: { ...stat, reason: 'no-l4', convStartTs: Number(best.row.convStartTs), ms: Date.now() - started } };
    }

    const maxChars = Math.max(10, Number(cfg.maxChars) || 100);
    const chars = [...String(sum.summary)];
    const body = chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : sum.summary;
    const line = `[会话 ${fmtConvLabel(best.row.convStartTs)}] ${body}`;
    return {
      line,
      stat: {
        attached: true,
        reason: 'ok',
        convStartTs: Number(best.row.convStartTs),
        hitsInSameConv: best.n,
        chars: [...line].length,
        sparse: sum.sparse === true,
        ms: Date.now() - started
      }
    };
  } catch (error) {
    // 摘要头是**装饰**：失败就当没有，原文照常注入
    return { line: '', stat: { ...stat, reason: 'error', error: String(error?.message || error), ms: Date.now() - started } };
  }
}

/** 判定 + 检索 + 格式化。text 为空字符串 = 不注入。
 *  @param entries 触发批消息（跳过 m.self：机器人自己说的不算「有人问我」） */
export function buildAutoRecall(store, chatKey, entries, opts = {}) {
  const started = Date.now();
  try {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const asked = list.filter((m) => !m.self && isRecallIntent(String(m.text ?? ''), opts));
    // 多条命中只取最近一条做抽词：同批里两句不同的回溯混在一起会抽错词
    const words = asked.length
      ? pickWords(asked[asked.length - 1].text, [opts.selfNickname, opts.botName])
      : [];
    if (!words.length) return { text: '', stats: { hit: false, words: [], hits: 0, ms: Date.now() - started } };
    // 时间上界卡在本轮最早一条之前：消息先入库再组装，不卡的话第一条命中永远是提问自己
    const tsList = list.map((m) => Number(m.ts)).filter((n) => Number.isFinite(n) && n > 0);
    const before = tsList.length ? Math.min(...tsList) - 1 : Date.now() - 60_000;
    const { found, used } = searchFor(store, chatKey, words, before);
    // v1.31 · 一手证据优先：原始消息排在自己的转述前面。
    //
    // 起因（实测）：问「某群友上次打某游戏打崩那事」，注入首条是机器人 20 分钟前
    // 自己的回答。因为 includeSelf 且 TF-IDF+时间衰减把它排在第一，
    // 于是这次回答**一字不差重复了它**。后果：问同一件事就复述自己上次的答案，
    // 事实正确时只是复读，事实有误时错误被固化、越问越错。
    //
    // 处理：稳定排序把 m.self 的行沉底，组内顺序不变（仍是相关性降序）。
    // 不直接删掉自身发言 —— 有些信息只有机器人自己提过，删了会漏；沉底后既保留兜底，
    // 又让模型先看到一手证据。
    const ordered = [...(found?.messages || [])]
      .sort((a, b) => Number(Boolean(a.self)) - Number(Boolean(b.self)));
    // 命中的消息 ts（供摘要头 `buildSummaryHead` 使用）：只带出去，不改检索结果本身。
    // 取与渲染同样的前 4 条 —— 「注入了几条就记几条」，口径与提示词一致。
    const hitTsList = ordered.slice(0, 4).map((m) => Number(m.ts)).filter((n) => Number.isFinite(n) && n > 0);
    const rows = ordered.slice(0, 4).map((m) => {
      const d = new Date(Number(m.ts) || 0);
      const who = String(m.senderName || m.senderId || '某人').slice(0, 12);
      const line = String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return `- ${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} ${who}：${line}`;
    });
    // 总字数 ≤200：先丢行（保新弃旧），仍超就收窄原文
    //
    // 第 4 期：会话级回溯时多带一行摘要头（[会话 MM-DD HH:MM] …），预算 200 → 320。
    // ★ 摘要行放在正文**之前**：末尾硬截只会切消息行，不会把摘要头切掉半句。
    // ★ 关闭时 headLine 为空 → overhead=0、budget=200，走的还是旧算式，
    //   所以「enabled:false 时提示词逐字节不变」是**算出来**的，不是靠肉眼看。
    const sumCfg = opts.summaryHead && typeof opts.summaryHead === 'object' ? opts.summaryHead : {};
    const { line: headLine, stat: headStat } = buildSummaryHead(
      chatKey, hitTsList, sumCfg, opts.summaryHeadDeps || {}
    );
    const extra = headLine
      ? (Number.isFinite(Number(sumCfg.extraBudget)) ? Number(sumCfg.extraBudget) : 120)
      : 0;
    const budget = HEAD_BUDGET + Math.max(0, extra);
    const overhead = headLine ? headLine.length + 1 : 0;

    let body = rows.join('\n');
    while (rows.length > 1 && HEAD.length + overhead + body.length > budget) { rows.pop(); body = rows.join('\n'); }
    let text = rows.length ? [HEAD, headLine, body].filter(Boolean).join('\n') : '';
    if (text.length > budget) text = text.slice(0, budget);
    return { text, stats: { hit: Boolean(text), words: used ? [used] : [], hits: found?.totalHits || rows.length, hitTsList, summaryHead: headStat, ms: Date.now() - started } };
  } catch (error) {
    // 记忆不能拖垮主链路：检索炸了就当作没命中
    return { text: '', stats: { hit: false, words: [], hits: 0, ms: Date.now() - started, error: String(error?.message || error) } };
  }
}
