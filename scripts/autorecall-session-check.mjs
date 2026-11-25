// autoRecall 实测结果汇总
//
// 扫最近的 session，把「触发句 / 是否注入 / 注入条数 / 模型有没有自己检索 / 回答」拉成一张表。
//
// 判据（v3，2026-11-14）：
//   ⬜ 未注入       没有【回溯命中】段
//   🟥 自命中       注入的原文与提问本身高度重合（等于把问题当答案塞回去）
//   🟨 冗余         有注入，但模型自己又调了 search_messages
//   🆕 自我复述     注入首条是**机器人自己说过的话**，且回答与它高度重合
//                   → 答案会固化：每次问同一件事都复述自己上次的回答，即使原始事实有更新
//   🟩 起效         有注入、没自己检索、回答里能找到注入内容的词面，且注入是原始消息
//   ⬛ 回答未体现   有注入、没自己检索，但回答与注入零词面重叠
//                   ⚠️ 这一档**不等于功能坏了**，要人工分两种：
//                      (a) 注入内容与问题无关 → 抽词跑偏，去跑 autorecall-replay.mjs
//                      (b) 注入内容相关但模型靠上下文就答了 → 只是冗余，不是故障
//
// ★ v1 只判「有注入 + 没自己检索 + 回答非空」就记 🟩，在**闲聊型提问**上系统性失效：
//   「你说过的最温柔的话是什么」这类模型本来就能即兴答、永不需要检索，
//   注入一堆无关消息也照样被判「起效」。2026-11-14 凌晨连撞三次（最骚/最温柔/最可爱）。
// ★ 词面重叠是启发式，3 字窗口对「同义转述」会漏判 —— 所以 ⬛ 只作提示，不下结论。
//
// 用法：
//   node scripts/autorecall-session-check.mjs        # 最近 10 轮
//   node scripts/autorecall-session-check.mjs 30     # 最近 30 轮

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const SESS_DIR = path.join(ROOT, 'data/sessions');
const LOG_DIR = path.join(ROOT, 'data/logs');
const N = Math.max(1, Number(process.argv[2]) || 10);
const RECALL_RE = /还记[得着]|你(?:上次|之前|刚才|刚刚)说|你不是说|上次|上回|那次|说过|讲过|提过|前面说|刚才说|我跟你说|那天|那会儿/;

// 日志里的 [autoRecall] 行，按时间索引（用来补 words / hits）
const logRows = [];
if (fs.existsSync(LOG_DIR)) {
  for (const f of fs.readdirSync(LOG_DIR).filter((x) => /^qq-agent-\d{4}-\d{2}-\d{2}\.log$/.test(x)).sort().slice(-3)) {
    const day = f.replace(/^qq-agent-|\.log$/g, '');
    for (const line of fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n')) {
      const m = /^(\d{2}:\d{2}:\d{2}).*\[autoRecall\]\s+chat=(\S+)\s+words=(.*?)\s+hits=(\d+)\s+ms=(\d+)/.exec(line);
      if (m) logRows.push({ day, time: m[1], chat: m[2], words: m[3], hits: Number(m[4]) });
    }
  }
}

const files = fs.existsSync(SESS_DIR)
  ? fs.readdirSync(SESS_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(SESS_DIR, f);
      try {
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        return { f, j, t: Number(j.startedAt) || fs.statSync(full).mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.t - a.t)
    .slice(0, N)
  : [];

if (!files.length) { console.error('没有可读的 session'); process.exit(1); }

const pickBlock = (p) => {
  const i = p.indexOf('【回溯命中】');
  if (i < 0) return '';
  const rest = p.slice(i);
  const end = rest.indexOf('\n\n');
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 400);
};

// 注入行 → 纯正文（去掉 "- MM-DD HH:MM 发送者："）
const bodyOf = (l) => l.replace(/^- \S+ \S+ \S+：/, '');

/** 注入内容与回答的词面重叠检测。
 *
 *  取注入正文里所有 3 字窗口（中文/英文数字），看回答是否包含其中任一。
 *  **先把提问自身的窗口剔掉** —— 否则「回答复述提问」会被误算成「用了注入」。
 *
 *  v2（2026-11-14 04:00）：**把发送者名也算进来**。
 *  实测 A2 那轮：注入正文是「我昨天一天就开了个巴音布鲁克出来」，
 *  回答是「巴音布鲁克？山有扶苏那天说开出来的那个？」——
 *  正确信息「山有扶苏」在注入行的**发送者位**，被 bodyOf 剥掉了，
 *  于是判成「零重叠」。同一问题在 A5 也出现（回答里的「麦麦」）。
 *  发送者名是注入带来的信息，必须计入。
 *
 *  @returns 命中的片段，或 null
 */
function overlapWithAnswer(block, answer, trigger) {
  const rows = block.split('\n').filter((l) => l.trim().startsWith('- '));
  const wins = new Set();
  let senderHit = null;
  for (const l of rows) {
    const body = bodyOf(l);
    for (let i = 0; i + 3 <= body.length; i += 1) {
      const w = body.slice(i, i + 3);
      if (/^[\u4e00-\u9fa5A-Za-z0-9]{3}$/.test(w)) wins.add(w);
    }
    // 发送者名（去掉「（QQ:xxx）」这类后缀）：长度 ≥2、不是提问里已有的、出现在回答里
    const m = l.match(/^-\s+\S+\s+\S+\s+(.+?)：/);
    if (m) {
      const sender = String(m[1]).replace(/[（(][^）)]*[）)]/g, '').trim();
      if (sender.length >= 2 && !trigger.includes(sender) && answer.includes(sender)) senderHit = sender;
    }
  }
  // 提问本身也含的窗口不算「注入带来」的信息
  for (let i = 0; i + 3 <= trigger.length; i += 1) wins.delete(trigger.slice(i, i + 3));
  for (const w of wins) if (answer.includes(w)) return w;
  return senderHit;
}

// ── 禁搜态识别（2026-11-14 03:35）────────────────────────────────────────────
//
// 起因：要判断「注入有没有净价值」，必须做一次禁搜对照实验——把 search_messages
// 和 get_recent_messages 关掉，只留注入，看还答不答得出。否则模型每次都自己搜，
// 注入和自搜的结果混在一起，**归因不可分离**（03:00 三轮全是这样，全是 🟨）。
//
// 关键点：禁搜态和正常态的 🟩 含义完全不同，绝对不能加在一起算。
//   正常态 🟩 = 「模型本来可以自己搜，但它用了注入」→ 只说明没冗余
//   禁搜态 🟩 = 「模型只剩注入可用，还答对了」      → **这才是净价值**
//
// 判定集严格等于这两个，不含 read_forward —— 它现网就是关着的，而且是故意的
// （内置工具，功能已由 skill 侧承接）。把它算进来会让每次重启都告警。
const RETRIEVAL_TOOLS = new Set(['search_messages', 'get_recent_messages']);

const mkStat = () => ({ rounds: 0, injected: 0, used: 0, echo: 0, selfHit: 0, wasted: 0, leak: 0 });
const statNormal = mkStat();
const statBlocked = mkStat();

let injected = 0, used = 0, selfHit = 0, wasted = 0, echo = 0;   // 全量（保持旧输出不变）
console.log(`最近 ${files.length} 轮（按时间倒序）\n`);

for (const { f, j, t } of files) {
  const time = new Date(t).toLocaleString('zh-CN', { hour12: false });
  const trig = String(j.triggerSummary || '').replace(/\s+/g, ' ').trim();
  const block = pickBlock(String(j.userPrompt || ''));
  const lines = block.split('\n').filter((l) => l.trim().startsWith('- '));
  const tools = (j.messages || []).flatMap((m) => (m.tool_calls || []).map((tc) => tc.function?.name)).filter(Boolean);
  // ⚠️ 只统计**成功执行**的 search_messages（2026-11-14 04:00 修正）
  //
  // 原写法 `tools.filter(n => n === 'search_messages').length` 把"尝试调用"也算进去了。
  // 禁搜实验里 6 轮都出现过这个序列：
  //   [调] search_messages  →  [结果] 错误：未知工具 search_messages, isError=true
  // 工具明明已经被关掉、执行层也拦住了，模型只是习惯性试了一下，结果被计成"模型自己搜了"，
  // 于是整组样本被判"禁搜失效"，真实成绩（A 组 5/5 答对）全被埋掉。
  //
  // 判据：isError === true 的执行一律不算成功自搜。参数错误、超时同理 —— 没搜到就是没搜到。
  const toolRuns = (j.messages || []).map((m) => m.toolCall).filter(Boolean);
  const selfSearch = toolRuns.filter((t) => t.name === 'search_messages' && t.isError !== true).length;
  // 被拦下的尝试（禁搜生效的证据，不是失效）
  const blockedAttempts = toolRuns.filter((t) => t.name === 'search_messages' && t.isError === true).length;
  // 本轮是否处于禁搜态（检索工具被设置页关掉，见文件上方 RETRIEVAL_TOOLS）
  const searchBlocked = (j.excludedTools || []).some((e) => RETRIEVAL_TOOLS.has(e.id));
  // 禁搜真失效：工具号称被关，模型却**成功**调到了它 —— 那才是开关没生效
  const blockedLeak = searchBlocked && selfSearch > 0;
  const answerFull = (j.sent || []).map((s) => String(s.text || '')).join(' / ').replace(/\s+/g, ' ');
  const answer = answerFull.slice(0, 46);

  // 对应日志行：同 chatKey、时间差最小、且一条日志只配一次（±90 秒内可能有多条，取第一条会串行）
  const hhmmss = new Date(t).toTimeString().slice(0, 8);
  const toSec = (s) => { const [a, b, c] = s.split(':').map(Number); return a * 3600 + b * 60 + c; };
  let logHit = null;
  let bestDiff = Infinity;
  for (const r of logRows) {
    if (r.used || r.chat !== j.chatKey) continue;
    const diff = Math.abs(toSec(r.time) - toSec(hhmmss));
    if (diff <= 5 && diff < bestDiff) { bestDiff = diff; logHit = r; }
  }
  if (logHit) logHit.used = true;
  if (logHit) console.log(`   ↳ 对齐日志 ${logHit.time}（差 ${bestDiff}s）`);

  const hasBlock = Boolean(block);
  // 自命中：注入段里的原文和提问高度重合
  const selfHitFlag = hasBlock && lines.some((l) => {
    const body = bodyOf(l);
    return body.length > 8 && trig.includes(body.slice(0, 12));
  });
  // 注入无效：回答里找不到任何来自注入的 3 字片段
  const ov = hasBlock && !selfHitFlag ? overlapWithAnswer(block, answerFull, trig) : null;
  // 注入首条是机器人自己说过的话（格式：- MM-DD HH:MM 我：…）
  const selfFirst = hasBlock && lines.length > 0 && /^\s*-\s+\S+\s+\S+\s+我：/.test(lines[0]);
  const echoFlag = Boolean(ov) && selfFirst;   // 复述自己的旧回答

  if (hasBlock) injected++;
  if (selfHitFlag) selfHit++;
  else if (hasBlock && selfSearch === 0 && echoFlag) echo++;
  else if (hasBlock && selfSearch === 0 && ov) used++;
  else if (hasBlock && selfSearch === 0 && !ov) wasted++;

  // 分组计数：正常态 / 禁搜态各算一套，绝不合并（🟩 在这两态里含义不同）
  // 禁搜失效的轮次只记 leak、不进 rounds —— 那轮的"没自搜"是假的
  const bucket = searchBlocked ? statBlocked : statNormal;
  if (blockedLeak) {
    bucket.leak++;
  } else {
    bucket.rounds++;
    if (hasBlock) bucket.injected++;
    if (selfHitFlag) bucket.selfHit++;
    else if (hasBlock && selfSearch === 0 && echoFlag) bucket.echo++;
    else if (hasBlock && selfSearch === 0 && ov) bucket.used++;
    else if (hasBlock && selfSearch === 0 && !ov) bucket.wasted++;
  }

  const mark = hasBlock
    ? (selfHitFlag ? '🟥 自命中'
      : selfSearch ? '🟨 冗余(模型自己搜了)'
        : echoFlag ? '🆕 自我复述(注入首条是自己的旧回答)'
          : ov ? '🟩 注入起效'
            : '⬛ 回答未体现注入')
    : '⬜ 未注入';
  console.log(`${searchBlocked ? '🔒' : ''}${mark}  ${time}  ${j.chatKey}`);
  if (searchBlocked && blockedAttempts) {
    console.log(`   🚫 模型想搜，调 search_messages ${blockedAttempts} 次全被拦（未知工具）—— 禁搜生效，被迫用注入`);
  }
  if (blockedLeak) {
    console.log(`   ⚠️ 禁搜失效：处于禁搜态，却**成功**调用了 search_messages ${selfSearch} 次`);
    console.log('      说明开关没生效（配置未写入 / 未热加载）。本轮不计入禁搜态统计。');
  }
  console.log(`   触发: ${trig.slice(0, 56) || '(空)'}`);
  if (logHit) console.log(`   日志: words=${logHit.words} hits=${logHit.hits}`);
  if (hasBlock) {
    console.log(`   注入: ${lines.length} 条${selfFirst ? '（首条是「我：」自己的发言）' : ''}`);
    lines.slice(0, 2).forEach((l) => console.log(`        ${l.replace(/\s+/g, ' ').slice(0, 70)}`));
    if (!selfHitFlag) console.log(`   重叠: ${ov ? `「${ov}」出现在回答里` : '无'}`);
  }
  console.log(`   检索: search_messages 成功 ${selfSearch} 次 / 被拦 ${blockedAttempts} 次 | 回答: ${answer || '(无)'}`);
  console.log('');
}

console.log('──── 汇总 ────');
console.log(`注入 ${injected} 轮 | 🟩起效 ${used} / 🆕自我复述 ${echo} / 🟥自命中 ${selfHit} / 🟨冗余 ${injected - used - selfHit - wasted - echo} / ⬛未体现 ${wasted}`);

// 分组：禁搜态的 🟩 才是注入净价值，正常态的 🟩 只说明"没冗余"。两者不可相加。
const groupLine = (name, s) => `  ${name}  ${String(s.rounds).padStart(2)} 轮 | 注入 ${s.injected} | `
  + `🟩 ${s.used} / 🆕 ${s.echo} / 🟥 ${s.selfHit} / ⬛ ${s.wasted}`;
console.log('\n按检索状态分组（🟩 在两态里含义不同，不可合并）：');
console.log(groupLine('正常态', statNormal));
console.log(`${groupLine('禁搜态', statBlocked)}   ← 这一组才是注入的净价值`);
const leaks = statNormal.leak + statBlocked.leak;
if (leaks) console.log(`  ⚠️ 禁搜失效 ${leaks} 轮（工具被关却仍被调用），已排除在统计外`);
if (statBlocked.rounds === 0) {
  console.log('  （还没有禁搜样本。做禁搜对照实验见「施工单_搜索开关与禁搜实验」）');
}

if (injected === 0) {
  console.log('本轮没有任何注入。若你刚测了 A 组，说明判定/抽词有问题，跑 --check 对照。');
} else if (used === 0 && wasted > 0) {
  console.log(`⚠️ ${wasted}/${injected} 轮答非所注。跑 autorecall-replay.mjs 看是抽词跑偏，`);
  console.log('   还是问的「你说过的最X的」这类泛指句（v1.30 已排除）。');
} else if (used === 0) {
  console.log('⚠️ 没有任何一轮是「注入起效」。');
} else {
  console.log(`有效 ${used}/${injected}。注意 🆕：注入首条若是机器人自己的旧回答，答案会固化。`);
}
