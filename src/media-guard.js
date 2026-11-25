// 媒体守卫：解析上游对图片/视频部件的 400/413/422 拒绝，并把被点名的部件替换为文本占位。
//
// 只做"识别 + 就地摘除"，不发请求、不碰 session、不写文件。
// 修复重试的循环在 orchestrator 的 #chatWithMediaRepair 里，本模块只提供纯函数。

export const MEDIA_REPAIR_MAX = 2;

const PLACEHOLDER = '【系统：本张图片已被上游拒绝，未发送；请勿猜测其内容。】';
const NOTE_SUFFIX = '（本消息中的图片被上游拒绝，已省略）';

/** 从错误文本/响应片段解析 `.messages[6].content[1]`。 */
export function parseRejectedContentIndex(text) {
  const m = /messages\[(\d+)\]\.content\[(\d+)\]/i.exec(String(text || ''));
  if (!m) return null;
  return { messageIndex: Number(m[1]), contentIndex: Number(m[2]) };
}

function statusOf(error) {
  const direct = Number(error?.httpStatus);
  if (direct) return direct;
  const m = /HTTP\s*(\d{3})/i.exec(String(error?.message || ''));
  return m ? Number(m[1]) : 0;
}

/** 当前 messages 里是否仍有图片/视频部件（413 修复的前提）。 */
function hasMediaParts(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => Array.isArray(m?.content)
    && m.content.some((p) => p?.type === 'image_url' || p?.type === 'video_url'));
}

// 模型级拒绝：逐张摘没用，必须一次摘全部。必须先于通用图片文本判断。
const DROP_ALL_TEXT = /image\s+inputs?\s+(?:is|are)?\s*not\s+support(?:ed)?|image\s+input\s+is\s+not\s+supported\s+for\s+this\s+model/i;

// 逐图/总量类拒绝：命中即可进入修复（有索引就摘被点名那张，没索引就摘全部）。
const IMAGE_TEXT = /unsupported\s+image|invalid\s+image|image[\s\S]{0,40}not\s+support(?:ed)?|image\s+too\s+large|image\s+size|failed\s+to\s+decode\s+image|image[\s\S]{0,30}decod|图片[\s\S]{0,20}(?:不支持|无效|过大|解码)/i;

/**
 * @returns {null | { reason: string, hit: { messageIndex: number, contentIndex: number } | null, dropAll: boolean }}
 */
export function classifyMediaError(error, messages) {
  const status = statusOf(error);
  if (status !== 400 && status !== 413 && status !== 422) return null;

  // 优先用 bodyExcerpt（最多 4000 字符），没有才回落 message（截断 500）。
  // 只读 message 会在响应片段较长时丢掉 .messages[N].content[M] 索引。
  const text = String(error?.bodyExcerpt || error?.message || '');
  if (!text) return null;

  // 413：只有当前 messages 里确实还有媒体部件时才允许修复。
  if (status === 413) {
    if (!hasMediaParts(messages)) return null;
    return { reason: 'payload_too_large', hit: parseRejectedContentIndex(text), dropAll: true };
  }

  // 模型级拒绝：先判，不能被通用 image...not supported 抢成逐图命中。
  if (DROP_ALL_TEXT.test(text)) {
    return { reason: 'model_image_unsupported', hit: null, dropAll: true };
  }

  // 400/422 必须命中图片相关文本，否则是普通客户端错误（invalid API key / model not found 等）。
  if (!IMAGE_TEXT.test(text)) return null;
  return { reason: 'image_rejected', hit: parseRejectedContentIndex(text), dropAll: false };
}

/**
 * 把指定图片/视频部件替换为文本占位，并在该消息第一个 text part 追加说明。
 * @returns {Array<{ messageIndex: number, contentIndex: number, kind: 'image' | 'video' }>}
 */
export function replaceMediaPartWithPlaceholder(messages, hit, note) {
  if (!hit || !Number.isInteger(hit.messageIndex) || !Number.isInteger(hit.contentIndex)) return [];
  const msg = messages?.[hit.messageIndex];
  if (!msg || !Array.isArray(msg.content)) return [];
  const part = msg.content[hit.contentIndex];
  if (!part || (part.type !== 'image_url' && part.type !== 'video_url')) return [];

  const kind = part.type === 'image_url' ? 'image' : 'video';
  msg.content[hit.contentIndex] = { type: 'text', text: PLACEHOLDER };
  const firstText = msg.content.find((p) => p?.type === 'text');
  if (firstText) firstText.text += NOTE_SUFFIX;
  return [{ messageIndex: hit.messageIndex, contentIndex: hit.contentIndex, kind }];
}

/**
 * 把全部 image_url / video_url 替换为文本占位，保留 tool/system 消息。
 * 只遍历 role === 'user' 的数组型 content；不改变数组长度。
 * @returns {Array<{ messageIndex: number, contentIndex: number, kind: 'image' | 'video' }>}
 */
export function replaceAllMediaWithPlaceholders(messages, note) {
  const replaced = [];
  if (!Array.isArray(messages)) return replaced;
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
    let count = 0;
    for (let ci = 0; ci < msg.content.length; ci++) {
      const part = msg.content[ci];
      if (!part || (part.type !== 'image_url' && part.type !== 'video_url')) continue;
      msg.content[ci] = { type: 'text', text: PLACEHOLDER };
      replaced.push({ messageIndex: mi, contentIndex: ci, kind: part.type === 'image_url' ? 'image' : 'video' });
      count += 1;
    }
    if (count) {
      const firstText = msg.content.find((p) => p?.type === 'text');
      if (firstText) firstText.text += NOTE_SUFFIX;
    }
  }
  return replaced;
}
