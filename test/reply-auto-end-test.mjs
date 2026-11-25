// 自动收尾判定（reply.local-policy）：纯函数逐条验证（不拉起 app / HTTP / OneBot）
//
// 覆盖施工单 A3 的 17 条基础用例 + T0 的 6 条 end:true 用例：正常形态、配置开关、
// 失败/部分失败、坏 JSON、旧存档缺 messageId、预告式结尾……重点在"畸形入参不抛错"和"绝不误放行"。
//
// 运行：node test/reply-auto-end-test.mjs
import assert from 'node:assert/strict';
import { canEndReplyBatch, providers, internals } from '../plugins/reply-auto-end/index.js';
import { createChecker } from './_harness.mjs';

const c = createChecker('发送后自动收尾（reply.local-policy）');

const call = (name, args) => ({ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const okResult = (name) => ({ role: 'tool', name, content: '{"sent":1,"failed":0}', isError: false });
const sentText = (messageId = 123) => ({ type: 'text', text: '你好', messageId, at: '12:00:00' });

/** 一整个"正常批"：给 calls，其余按成功合成。 */
const batchOf = (calls, extra = {}) => ({
  calls,
  results: calls.map((x) => okResult(x.function.name)),
  newSent: [sentText()],
  text: '',
  ...extra
});

await c.check('1 单条发送 + end:true + 成功 + 无预告 → 结束', () => {
  const r = canEndReplyBatch({ batch: batchOf([call('send_message', { messages: '你好', end: true })]) });
  assert.equal(r.shouldEnd, true);
  assert.equal(typeof r.reason, 'string');
});

await c.check('2 数组分条（2 条）+ end:true + 成功 → 结束（规则 5 默认开）', () => {
  const r = canEndReplyBatch({ batch: batchOf([call('send_message', { messages: ['一', '二'], end: true })]) });
  assert.equal(r.shouldEnd, true);
});

await c.check('3 数组分条 + allowArrayMessages=false → 不结束', () => {
  const r = canEndReplyBatch({
    batch: batchOf([call('send_message', { messages: ['一', '二'], end: true })]),
    config: { allowArrayMessages: false }
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('4 批里还有 get_message_images → 不结束（规则 2）', () => {
  const r = canEndReplyBatch({
    batch: batchOf([call('send_message', { messages: '你好', end: true }), call('get_message_images', {})])
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('5 send_message + send_sticker → 结束（规则 3：文字+表情同一条回复）', () => {
  const r = canEndReplyBatch({
    batch: batchOf([
      call('send_message', { messages: '你好', end: true }),
      call('send_sticker', { stickerId: 's1' })
    ])
  });
  assert.equal(r.shouldEnd, true);
});

await c.check('6 三次 send_message → 不结束（规则 3 的次数上限）', () => {
  const r = canEndReplyBatch({
    batch: batchOf([
      call('send_message', { messages: 'a', end: true }),
      call('send_message', { messages: 'b' }),
      call('send_message', { messages: 'c' })
    ])
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('7 send_message 结果 isError:true（全败）→ 不结束（规则 4）', () => {
  const r = canEndReplyBatch({
    batch: {
      calls: [call('send_message', { messages: '你好', end: true })],
      results: [{ role: 'tool', name: 'send_message', content: '错误：连接失败', isError: true }],
      newSent: [],
      text: ''
    }
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('7b 部分失败（sent:1, failed:1，isError 为 false）→ 不结束（靠 A1-c 的 failed）', () => {
  const r = canEndReplyBatch({
    batch: {
      calls: [call('send_message', { messages: ['一', '二'], end: true })],
      results: [{ role: 'tool', name: 'send_message', content: '{"sent":1,"failed":1}', isError: false }],
      newSent: [sentText()],
      text: ''
    }
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('7c 结果的 content 不是 JSON（错误：…）→ 不结束（保守拒绝）', () => {
  const r = canEndReplyBatch({
    batch: {
      calls: [call('send_message', { messages: '你好', end: true })],
      results: [{ role: 'tool', name: 'send_message', content: '错误：连接失败', isError: false }],
      newSent: [sentText()],
      text: ''
    }
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('8 正文结尾"等我查一下"→ 不结束（规则 7）', () => {
  const r = canEndReplyBatch({
    batch: batchOf([call('send_message', { messages: '你好', end: true })], { text: '我去查一下，等我' })
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('9 数组里第二条结尾"稍等"→ 不结束（规则 7 要逐条查）', () => {
  const r = canEndReplyBatch({
    batch: batchOf([call('send_message', { messages: ['先说一句', '我看看哈，稍等'], end: true })])
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('10 newSent 只有去重条目（messageId:null）→ 不结束（规则 6）', () => {
  const r = canEndReplyBatch({
    batch: {
      calls: [call('send_message', { messages: '你好', end: true })],
      results: [okResult('send_message')],
      newSent: [{ type: 'text', text: '你好', messageId: null, deduped: true }],
      text: ''
    }
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('11 newSent 文本条目根本没有 messageId 字段（旧存档）→ 不结束，reason 指向规则 6', () => {
  const r = canEndReplyBatch({
    batch: {
      calls: [call('send_message', { messages: '你好', end: true })],
      results: [okResult('send_message')],
      newSent: [{ type: 'text', text: '你好', at: '12:00' }],
      text: ''
    }
  });
  assert.equal(r.shouldEnd, false);
  assert.match(String(r.reason), /messageId/);
});

await c.check('12 只 send_poke、没有 send_message → 不结束（规则 1）', () => {
  const r = canEndReplyBatch({ batch: batchOf([call('send_poke', {})]) });
  assert.equal(r.shouldEnd, false);
});

await c.check('13 空 calls / 空 results / 坏 JSON arguments → 不结束且不抛错', () => {
  const empty = canEndReplyBatch({ batch: { calls: [], results: [], newSent: [] } });
  assert.equal(empty.shouldEnd, false);

  const noResults = canEndReplyBatch({
    batch: {
      calls: [call('send_message', { messages: '你好', end: true })],
      results: [],
      newSent: [sentText()],
      text: ''
    }
  });
  assert.equal(noResults.shouldEnd, false);

  const badJson = canEndReplyBatch({
    batch: {
      calls: [{ id: 'x', type: 'function', function: { name: 'send_message', arguments: '{bad' } }],
      results: [{ role: 'tool', name: 'send_message', content: '{"sent":1,"failed":0}', isError: false }],
      newSent: [sentText()],
      text: ''
    }
  });
  assert.equal(badJson.shouldEnd, false);

  // 更畸形：完全空的输入也不许抛
  for (const input of [undefined, {}, { batch: null }, { batch: { calls: 'x' } }]) {
    const r = canEndReplyBatch(input);
    assert.equal(r.shouldEnd, false);
  }
});

await c.check('14 send_message + finish 同批 → 结束（实际不会走到钩子：orchestrator 在同批内已置 finish）', () => {
  const r = canEndReplyBatch({
    batch: batchOf([call('send_message', { messages: '你好', end: true }), call('finish', { summary: 'x' })])
  });
  assert.equal(r.shouldEnd, true);
});

await c.check('15 checkTrailer:false 时，预告式结尾也放行', () => {
  const r = canEndReplyBatch({
    batch: batchOf([call('send_message', { messages: '等我', end: true })], { text: '等我' }),
    config: { checkTrailer: false }
  });
  assert.equal(r.shouldEnd, true);
});

// ── T0：显式 end:true 才允许本地收尾 ─────────────────────────────────────
await c.check('16 end:true + 单条发送成功 → 结束', () => {
  const r = canEndReplyBatch({ batch: batchOf([call('send_message', { messages: '你好', end: true })]) });
  assert.equal(r.shouldEnd, true);
});

await c.check('17 没有 end / end:false → 不结束（规则 0：不猜模型是否说完）', () => {
  const missing = canEndReplyBatch({ batch: batchOf([call('send_message', { messages: '你好' })]) });
  assert.equal(missing.shouldEnd, false);
  assert.match(String(missing.reason), /end/);
  const explicitFalse = canEndReplyBatch({ batch: batchOf([call('send_message', { messages: '你好', end: false })]) });
  assert.equal(explicitFalse.shouldEnd, false);
});

await c.check('18 end:true + failed>0 → 不结束', () => {
  const r = canEndReplyBatch({
    batch: {
      calls: [call('send_message', { messages: ['一', '二'], end: true })],
      results: [{ role: 'tool', name: 'send_message', content: '{"sent":1,"failed":1}', isError: false }],
      newSent: [sentText()],
      text: ''
    }
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('19 end:true + 批里还有 get_message_images → 不结束', () => {
  const r = canEndReplyBatch({
    batch: batchOf([call('send_message', { messages: '你好', end: true }), call('get_message_images', {})])
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('20 end:true + 结尾“等我查一下” → 不结束', () => {
  const r = canEndReplyBatch({
    batch: batchOf([call('send_message', { messages: '等我查一下', end: true })], { text: '等我查一下' })
  });
  assert.equal(r.shouldEnd, false);
});

await c.check('21 end:true + messageId 为空 → 不结束', () => {
  const r = canEndReplyBatch({
    batch: {
      calls: [call('send_message', { messages: '你好', end: true })],
      results: [okResult('send_message')],
      newSent: [{ type: 'text', text: '你好', messageId: null, deduped: true }],
      text: ''
    }
  });
  assert.equal(r.shouldEnd, false);
});


// ── 观测计数（只统计，不改变判定）─────────────────────────────────────────

await c.check('22 已交付但没写 end:true → 判定仍是 false，计数 +1', () => {
  const before = internals.stats.deliveredNoEnd;
  const r = providers['reply.local-policy']({ batch: batchOf([call('send_message', { messages: '你好' })]) });
  assert.equal(r.shouldEnd, false);
  assert.equal(internals.stats.deliveredNoEnd, before + 1);
});

await c.check('23 带了 end:true（被预告规则拒绝）→ 不计入 deliveredNoEnd', () => {
  const before = internals.stats.deliveredNoEnd;
  providers['reply.local-policy']({
    batch: batchOf([call('send_message', { messages: '等我查一下', end: true })], { text: '等我查一下' })
  });
  assert.equal(internals.stats.deliveredNoEnd, before);
});

await c.check('24 发送失败（没写 end）→ 不计入 deliveredNoEnd', () => {
  const before = internals.stats.deliveredNoEnd;
  providers['reply.local-policy']({
    batch: {
      calls: [call('send_message', { messages: '你好' })],
      results: [{ role: 'tool', name: 'send_message', content: '错误：连接失败', isError: true }],
      newSent: [],
      text: ''
    }
  });
  assert.equal(internals.stats.deliveredNoEnd, before);
});

process.exit(c.finish() ? 0 : 1);
