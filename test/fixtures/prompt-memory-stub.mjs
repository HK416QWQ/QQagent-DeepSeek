import { contentDigest } from '../../src/mem2/digest.js';

// prompt.js 只依赖 promptSnapshot/formatForPrompt 两个方法；
// 真实 mem2 注入器由 test/mem2-inject-test.mjs 覆盖，这里只提供可控夹具。
export function makePromptMemory() {
  const chats = new Map(); // chatKey -> Map(uid -> { name, impressions: [] })
  function ensure(chatKey, uid) {
    if (!chats.has(chatKey)) chats.set(chatKey, new Map());
    const m = chats.get(chatKey);
    if (!m.has(uid)) m.set(uid, { name: '', impressions: [] });
    return m.get(uid);
  }
  const api = {
    append(chatKey, category, content, { userId, target } = {}) {
      if (category !== 'memberImpression' || !userId) return null;
      const m = ensure(chatKey, String(userId));
      if (target) m.name = String(target);
      m.impressions.push(String(content));
      return { ok: true };
    },
    promptSnapshot(chatKey, { userIds = null } = {}) {
      const map = chats.get(chatKey) || new Map();
      const ids = (userIds ? userIds.map(String) : [...map.keys()]).filter((uid) => map.has(uid));
      const members = {};
      const lines = [];
      for (const uid of ids) {
        const m = map.get(uid);
        if (!m.impressions.length) continue;
        members[`u:${uid}`] = {
          impressions: m.impressions.slice(),
          digests: m.impressions.map(contentDigest)
        };
        lines.push(`- ${m.name || uid}：${m.impressions.join('；')}`);
      }
      return { text: lines.join('\n'), members, userIds: ids };
    },
    formatForPrompt(chatKey, opts = {}) {
      return api.promptSnapshot(chatKey, opts).text;
    },
    removeMember(chatKey, uid) {
      chats.get(chatKey)?.delete(String(uid));
    }
  };
  return api;
}