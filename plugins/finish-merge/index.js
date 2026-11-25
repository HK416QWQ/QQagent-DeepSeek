// 提示词补丁：合并发送 + 发完即止（可开关）
//
// ── 它做什么 ────────────────────────────────────────────────────────────────
// 只往系统提示词里加一段 NOTE（priority 60），让模型：
//   · 整轮话全部放进同一次 send_message 的 messages 数组；
//   · 确认发完不再补时，在这次 send_message 上带 end:true；
//   · 不再为了收尾单独调 finish。
// 本文件没有任何运行时代码；promptSections() 返回 NOTE，setup() 只打日志。
//
// ── 机制边界（别再把省调用记在它头上）──────────────────────────────────────
// end:true 本身不结束循环。必须有 reply-auto-end 提供 reply.local-policy，
// orchestrator 才会在整批发送成功后本地收尾（src/orchestrator.js:1248）。
// 没有这个提供者时，模型下一轮返回空（没有工具调用），循环在
// src/orchestrator.js:1098 才 break —— 仍然多花一次模型调用。
//
// ── 实测（2026-11-01 复核，会话文件按天聚合）────────────────────────────────
//   · 当前版 NOTE 从 10-28 起铺开、10-29 起有回复会话 100% 覆盖。
//   · 覆盖后“第二轮只为 finish”从 10-26 的 157 次降到 10-29 的 1 次；
//     但 10-28/29 有回复会话仍然 100% 打两轮，只是第二轮从 finish 变成空转，
//     API 调用没有减少。单开本插件不省调用。
//   · 真正的台阶是 10-30 01:18 reply-auto-end（A2）启用：
//     本地收尾 0→15/小时，平均调用 2.23→1.50，两轮占比 100%→42%。
//   · 10-26/27 的 2.59/2.45 不是“无插件基线”：那两天 100% 的有回复会话
//     已经带旧版 NOTE（当时让模型在同一轮里调 send_message + finish）。
//
// ── 代价 ───────────────────────────────────────────────────────────────────
// 不调 finish 后，管理端的“收尾理由”大多会被本地策略写成统一文案
// “本地收尾策略判定：本批已交付完毕”（2026-10-31：313/369 个有回复会话），
// 少数为空。模型的个性化理由会丢失；换来的不是本插件省调用，而是 A2 能接上。
//
// ── 与活跃期（chatActive）的关系 ───────────────────────────────────────────
// 活跃期只能靠 finish 带回 activeTopic 开启（src/orchestrator.js:1211）。
// 当前 NOTE 让模型别调 finish，两者天然别扭。实测 activeTopic 全库只填过 3 次
// （10-25 两次、10-26 一次，之后 0）；chatActive.enabled=true 但实际是死配置。
// 如果以后要用活跃期，需要单独加例外，不要靠本插件。
//
// ── 怎么开关 / 怎么回退 ──────────────────────────────────────────────────────
//   开关：QQ Agent →「插件」页 →「省token·合并收尾」→ 启用/禁用
//   回退：禁用或删掉 plugins/finish-merge/ 目录，行为立刻恢复原样（不碰配置）
//   ⚠️ promptSections 只在 Skill 激活时才会被收集（manager.getPromptSections
//      先判 isActive），禁用不会残留提示词。

// api.log 只走 console（本应用由 electron.exe start 启动、无控制台窗口），
// 不会进 data/logs 与日志面板；这里走 logger 才能被看见。
import { logger } from '../../src/logger.js';

const NOTE = [
  '【收尾：该做的在同一次回复里做完，发完就可以结束】',
  '- 不管几句，全部放进同一次 send_message 调用的 messages 数组；不要连续调用多次 send_message，更不要发一条、下一轮再补一条。',
  '- 一次回复里可以同时调用多个工具，系统按你列出的顺序执行：send_message 发文字、send_sticker 发表情、send_poke 戳一戳。',
  '- 要戳一戳就把它和 send_message 放进同一次回复；不要先发文字、下一轮再戳，下一轮会晚到。',
  '- 文字和表情仍然是两个 QQ 气泡（不能混在同一个气泡里），但"两个气泡"只要求两次工具调用，不要求两轮模型调用：在同一次回复里先 send_message、再 send_sticker 即可（更省事的做法是 send_message 直接带 stickerId，一次发完）。',
  '- 发之前先想好整轮要说几条，全部放进同一次调用；确认这就是这次回复的全部、发完不再补时，在这次 send_message 上带 end:true。还想补就不要带，不要先带 end:true 发一条、下一轮再补。',
  '- 如果这次聊到了值得长期记住的人或事，把记忆工具（memory_append）也放在同一次回复里、排在收尾之前；收尾之后本次处理就结束了，下一轮不会回来补记。',
  '- 当这一轮是你最后的动作（话说完、表情也配好），**直接结束即可**，不需要再调 finish 来专门收尾。',
  '- 只有还需要看工具结果才能决定下一步时（get_message_images、web_search、发送失败要补救），才进入下一轮；单纯为了收尾不要多开一轮。',
  '- 决定不说话时，直接结束。'
].join('\n');

export function setup() {
  logger.info('skill:finish-merge', '省token·合并收尾已加载：提示词补丁，仅在启用时注入');
}

/**
 * 动态提示词片段：只在插件激活时被收集（manager.getPromptSections 会先判 isActive）。
 * 返回空数组即"不加任何东西"，便于将来做配置开关（当前不需要）。
 *
 * 表情包总开关关闭时去掉 send_sticker / stickerId 两处子句：工具列表里已经没有
 * 发送表情的工具，提示词再提会自相矛盾。缺省（没传 context）按开启处理（fail-open）。
 */
export function promptSections(context = {}) {
  const stickerOn = context?.stickerEnabled !== false;
  const lines = [
    '【收尾：该做的在同一次回复里做完，发完就可以结束】',
    '- 不管几句，全部放进同一次 send_message 调用的 messages 数组；不要连续调用多次 send_message，更不要发一条、下一轮再补一条。',
    stickerOn
      ? '- 一次回复里可以同时调用多个工具，系统按你列出的顺序执行：send_message 发文字、send_sticker 发表情、send_poke 戳一戳。'
      : '- 一次回复里可以同时调用多个工具，系统按你列出的顺序执行：send_message 发文字、send_poke 戳一戳。',
    '- 要戳一戳就把它和 send_message 放进同一次回复；不要先发文字、下一轮再戳，下一轮会晚到。',
    ...(stickerOn ? [
      '- 文字和表情仍然是两个 QQ 气泡（不能混在同一个气泡里），但"两个气泡"只要求两次工具调用，不要求两轮模型调用：在同一次回复里先 send_message、再 send_sticker 即可（更省事的做法是 send_message 直接带 stickerId，一次发完）。'
    ] : []),
    '- 发之前先想好整轮要说几条，全部放进同一次调用；确认这就是这次回复的全部、发完不再补时，在这次 send_message 上带 end:true。还想补就不要带，不要先带 end:true 发一条、下一轮再补。',
    '- 如果这次聊到了值得长期记住的人或事，把记忆工具（memory_append）也放在同一次回复里、排在收尾之前；收尾之后本次处理就结束了，下一轮不会回来补记。',
    '- 当这一轮是你最后的动作（话说完、表情也配好），**直接结束即可**，不需要再调 finish 来专门收尾。',
    '- 只有还需要看工具结果才能决定下一步时（get_message_images、web_search、发送失败要补救），才进入下一轮；单纯为了收尾不要多开一轮。',
    '- 决定不说话时，直接结束。'
  ];
  return [{ id: 'finish-merge-note', title: '收尾省一轮', priority: 60, content: lines.join('\n') }];
}

/** 可用性：无外部依赖。 */
export function available() {
  return { ok: true };
}
