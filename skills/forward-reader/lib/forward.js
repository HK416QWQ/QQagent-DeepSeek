// 合并转发（聊天记录）的展开核心。
//
// ── 内置能力做到哪、这个技能补什么 ──
// 程序内置在收到消息时已经会调一次 get_forward_msg 展开转发（src/app.js）。
// 但它有三个实测出来的缺口，正是用户吐槽的三个现象：
//   1. 「机器人说看不了」：展开失败时存档里只剩 [合并转发聊天记录] 占位符，
//      模型就只能说看不到。retcode 100 并不都等于"内容被 QQ 丢弃" ——
//      2026-11-01 实测：负的 message_id 经常解不出，改用消息段里的 64 位转发 id
//      就能读到（8 小时前的老转发也行）；index.js 里已做这个回落。
//   2. 「套娃看不到」：内置刻意只展一层（见 onebot.js expandForwardNodes 的注释），
//      转发里的转发会变成 [合并转发聊天记录] 占位符。
//      实测：嵌套段里的 data.id 是**能**直接再调 get_forward_msg 的（成功拿到子节点），
//      所以这一层完全可以展开；
//   3. 「长记录只看得到开头」：内置 30 条 / 每行 200 字 / 共 3000 字截断。
//
// ── 另一个实测坑：转发里的 QQ 号不可信 ──
// 内置展开会拼「昵称(QQ:123)」，但实测发现同一层转发里所有节点的 sender.user_id
// 都是**同一个号**（转发消息发起人），昵称却是各人各的 —— 也就是说那个 QQ 号是错的。
// 模型照着它 @ 人或记印象会指错人。本技能一律只输出昵称，并在提示词里写明原因。

/** 段类型 → 可读占位文本（图片单独收集，见 collectMedia）。 */
function segToText(seg) {
  const d = seg?.data ?? {};
  switch (seg?.type) {
    case 'text': return String(d.text ?? '');
    case 'image': return '[图片]';
    case 'face': return '[表情]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': return `[文件${d.name ? ` ${d.name}` : ''}]`;
    case 'json': return '[卡片消息]';
    case 'markdown': return '[图文消息]';
    case 'at': return d.qq === 'all' ? '@全体成员' : `@${d.qq ?? '某人'}`;
    case 'reply': return '[引用]';
    case 'forward': return '';
    default: return seg?.type ? `[${seg.type}]` : '';
  }
}

/** 从 get_forward_msg 的响应里取节点数组（不同协议端包法不一样）。 */
export function extractNodes(resp) {
  if (Array.isArray(resp?.messages)) return resp.messages;
  if (Array.isArray(resp?.data?.messages)) return resp.data.messages;
  if (Array.isArray(resp?.data)) return resp.data;
  return [];
}

/** 嵌套转发段的定位 id。优先 64 位 id（2026-11-01 实测：它比 message_id 可靠，也不会过期）。 */
export function forwardIdOf(seg) {
  const d = seg?.data ?? {};
  const raw = d.id ?? d.res_id ?? d.forward_id ?? d.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/** 节点发言人：只信昵称/群名片，**不拼 QQ 号**（协议端给的 id 是错的，见文件头）。 */
function senderName(node) {
  const s = node?.sender ?? {};
  return String(s.card || s.nickname || node?.nickname || node?.user_id || '（未知）');
}

/** 节点正文段。字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 只留文字。 */
function nodeSegments(node) {
  const raw = node?.message ?? node?.content;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const text = raw.replace(/\[CQ:[^\]]*\]/g, '').trim();
    return text ? [{ type: 'text', data: { text } }] : [];
  }
  return [];
}

/** 技能输出是编号行（`1. 昵称: …`），核心输出没有编号；不再依赖 (QQ:) 判断 */
function isSkillExpanded(t) {
  return t.startsWith('[合并转发 共') && /(^|\n)\d+\. /.test(t);
}

/** 一条消息文本是否还需要（重新）展开。 */
export function needsExpand(text) {
  const t = String(text ?? '');
  if (!t) return false;
  if (t.includes('[合并转发聊天记录]')) return true;        // 没展开，或套娃占位
  if (t.includes('[转发消息')) return true;                  // 旧版/核心嵌套占位
  if (t.includes('未展开（当前上限')) return true;            // 深度到顶：仍值得提示
  if (t.includes('嵌套转发打不开')) return true;              // 传输/协议失败：下次可能成功
  if (/^\[合并转发 共\d+条\]\s*$/.test(t.trim())) return true; // 只有头、没有正文
  if (/（还有 \d+ 条未展开）/.test(t)) return !isSkillExpanded(t); // 技能节点截断：别再展
  if (/内容太长，后面还有约 \d+ 条没展开/.test(t)) return false;   // 同样设置重试无收益
  return false;
}

/** 这条消息是不是一条（或包含）合并转发。 */
export function looksLikeForward(text) {
  const t = String(text ?? '');
  return t.includes('[合并转发') || t.includes('[转发消息');
}

function pushLine(state, opts, line) {
  if (state.chars >= opts.maxChars) {
    state.truncated += 1;
    state.truncatedReason = 'chars';
    return false;
  }
  const max = opts.perLineChars;
  const text = line.length > max + 60 ? `${line.slice(0, max + 60)}…` : line;
  state.lines.push(text);
  state.chars += text.length + 1;
  return true;
}

async function walkNodes(nodes, opts, state, depth, prefix) {
  let idx = 0;
  for (const node of nodes) {
    if (state.count >= opts.maxNodes) {
      state.truncated += nodes.length - idx;
      state.truncatedReason = state.truncatedReason || 'nodes';
      return;
    }
    idx += 1;
    state.count += 1;

    const no = prefix ? `${prefix}.${idx}` : String(idx);
    const name = senderName(node);
    const segs = nodeSegments(node);

    // 图片：URL 收集起来给调用方下载/挂存档（协议端此时给的直链是新鲜的）
    for (const s of segs) {
      if (s?.type !== 'image') continue;
      const url = String(s.data?.url ?? '');
      const file = String(s.data?.file ?? '');
      if (url || file) {
        state.media.push({
          kind: 'image',
          url,
          file,
          summary: String(s.data?.summary ?? '')
        });
      }
    }

    const textBody = segs
      .filter((s) => s?.type !== 'forward')
      .map(segToText)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (textBody) pushLine(state, opts, `${no}. ${name}: ${textBody}`);

    // 嵌套转发：往下钻（深度到顶就注明，不静默丢掉）
    for (const ns of segs.filter((s) => s?.type === 'forward')) {
      const childId = forwardIdOf(ns);
      if (!childId) {
        pushLine(state, opts, `${no}. ${name}: ⟪嵌套转发（没有可用的定位 id）⟫`);
        continue;
      }
      if (depth + 1 >= opts.maxDepth) {
        pushLine(state, opts, `${no}. ${name}: ⟪里面还有一层转发，未展开（当前上限 ${opts.maxDepth} 层）⟫`);
        continue;
      }
      try {
        const childNodes = extractNodes(await opts.getNodes(childId));
        if (!childNodes.length) {
          pushLine(state, opts, `${no}. ${name}: ⟪嵌套转发内容为空或已被 QQ 丢弃⟫`);
          continue;
        }
        state.nested += 1;
        pushLine(state, opts, `${no}. ${name}: ⟪转发 共${childNodes.length}条⟫`);
        await walkNodes(childNodes, opts, state, depth + 1, no);
      } catch (error) {
        // 预算用尽不代表"这条打不开"，必须冒到钩子层，避免把半截文本写回存档
        if (error?.budgetExhausted) throw error;
        pushLine(state, opts, `${no}. ${name}: ⟪嵌套转发打不开：${String(error?.message ?? error).slice(0, 60)}⟫`);
      }
    }
  }
}

/**
 * 展开一条合并转发。
 *
 * @param {object} p
 * @param {string|number} p.mid          转发消息的 message_id
 * @param {(id) => Promise<any>} p.getNodes  取节点（顶层传 message_id，嵌套传 forward id）
 * @param {number} [p.maxDepth]          往下钻几层（1 = 只展最外层）
 * @param {number} [p.maxNodes]          全部层级的节点总数上限
 * @param {number} [p.maxChars]          文本总字数上限
 * @param {number} [p.perLineChars]      单条正文截断长度
 * @returns {Promise<{ok:boolean, error?:string, text?:string, media?:Array, ...}>}
 */
export async function expandForward(mid, {
  getNodes,
  maxDepth = 2,
  maxNodes = 60,
  maxChars = 9000,
  perLineChars = 400
} = {}) {
  if (typeof getNodes !== 'function') throw new Error('expandForward 缺少 getNodes');
  const opts = {
    // getNodes 必须放进 opts：嵌套层要复用它继续往下钻（递归 walkNodes 只拿得到 opts）
    getNodes,
    maxDepth: Math.min(3, Math.max(1, Number(maxDepth) || 2)),
    maxNodes: Math.min(500, Math.max(1, Number(maxNodes) || 60)),
    maxChars: Math.min(60000, Math.max(200, Number(maxChars) || 9000)),
    perLineChars: Math.min(2000, Math.max(60, Number(perLineChars) || 400))
  };

  const top = extractNodes(await getNodes(mid));
  const state = { lines: [], media: [], count: 0, chars: 0, nested: 0, truncated: 0, truncatedReason: '' };
  if (!top.length) {
    return { ok: false, error: '协议端没有返回这条转发的内容', totalNodes: 0, media: [] };
  }

  await walkNodes(top, opts, state, 0);

  if (!state.lines.length) {
    return { ok: false, error: '这条转发里没有任何可读的文字内容（可能只有图片）', totalNodes: state.count, media: state.media };
  }

  const head = `[合并转发 共${top.length}条]`;
  const meta = state.nested ? `（已展开${opts.maxDepth > 1 ? '，含嵌套转发' : ''}）` : '';
  let text = `${head}${meta}\n${state.lines.join('\n')}`;
  if (state.truncated > 0) {
    text += state.truncatedReason === 'chars'
      ? `\n…（内容太长，后面还有约 ${state.truncated} 条没展开；可以让机器人再读一次或调大上限）`
      : `\n…（还有 ${state.truncated} 条未展开）`;
  }

  const images = state.media.filter((m) => m.url);
  return {
    ok: true,
    text,
    media: state.media,
    images,
    imageCount: images.length,
    totalNodes: state.count,
    nestedForwards: state.nested,
    truncated: state.truncated
  };
}

/** 转发消息的定位 id 看起来是不是可用的 message_id（数字，可能为负）。 */
export function isMessageId(v) {
  return v != null && /^-?\d+$/.test(String(v).trim());
}
