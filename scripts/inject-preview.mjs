// 第 3 期 step 7 辅助：【记忆】一段在真实数据上长什么样（只读）。
//
// 只打印，不写盘、不调 LLM。用来人工读「像不像『他记得这些人』」。
import { ChatStore } from '../src/store.js';
import { getConfig } from '../src/config.js';
import { createInjectAdapter } from '../src/mem2/inject.js';

const cfg = getConfig().memory?.inject || {};
const store = new ChatStore(0);
const adapter = createInjectAdapter({ peopleStore: store, cfg });
const now = Date.now();
const SHOW = Number(process.env.SHOW_LINES || 8);

for (const chatKey of store.listChats()) {
  const all = store.rangeByTs(chatKey, { fromTs: 0, toTs: now }) || [];
  if (!all.length) continue;
  const trig = all.slice(-30);
  // 真实运行里 userIds 是「本轮已读发送者 ∪ 触发条目发送者」，这里用最近 30 条的发送者近似
  const userIds = [...new Set(trig.filter((m) => !m.self && m.senderId).map((m) => String(m.senderId)))];
  const snap = adapter.promptSnapshot(chatKey, { userIds });
  if (!snap.text) continue;

  console.log(`\n══════ ${chatKey}（候选人 ${userIds.length}，命中画像 ${Object.keys(snap.members).length}）══════`);
  if (snap.text) {
    const lines = snap.text.split('\n');
    console.log(`【记忆】共 ${lines.length - 1} 行 / ${[...snap.text].length} 字`
      + `${snap.trimmed?.stage !== 'none'
        ? `（已裁：${snap.trimmed.stage}，剔人 ${snap.trimmed.droppedUsers}／剔钉住 ${snap.trimmed.droppedPinned}`
          + `${snap.trimmed.overCap ? '／受保护超员' : ''}）`
        : ''}`);
    for (const line of lines.slice(0, SHOW + 1)) console.log(`  ${line}`);
    if (lines.length - 1 > SHOW) console.log(`  …（其余 ${lines.length - 1 - SHOW} 行略）`);
  } else {
    console.log('【记忆】（本轮无人有画像 → 整段不出现）');
  }
}
