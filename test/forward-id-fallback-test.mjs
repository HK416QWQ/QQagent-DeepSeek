// 转发读取回落：负数 message_id 解不出时，用转发段的 64 位 id 重取；
// 目标根本不是转发时改读最近一条转发；两条路都失败才照实说取不到。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-id-'));

const ROOT = 'D:/DeepSeek/QQ-agent-main';
const FID = 'x4bh' + 'A'.repeat(56) + 'VD6S';
const payloadEmpty = () => Object.assign(new Error('OneBot get_forward_msg 失败: retcode=100 download forward message payload is empty'), { retcode: 100 });
const nodes = [
  { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '第一行内容' } }] },
  { sender: { nickname: '乙' }, message: [{ type: 'text', data: { text: '第二行内容' } }] }
];
const forwardSeg = { type: 'forward', data: { id: FID } };
const replySegs = [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '普通回复' } }];

// ── 1. 内置 helper：message_id 失败 → 段 id 成功 ─────────────────────────
const { getForwardNodes, forwardIdFromData } = await import(pathToFileURL(path.join(ROOT, 'src/onebot.js')).href);

assert.equal(forwardIdFromData(forwardSeg.data), FID);
{
  const calls = [];
  const client = { call: async (action, params) => {
    calls.push({ action, params });
    if (params.message_id != null) throw payloadEmpty();
    return { messages: nodes };
  } };
  const r = await getForwardNodes(client, -1801457880, FID);
  assert.equal(r.messages.length, 2);
  assert.deepEqual(calls.map((c) => c.action), ['get_forward_msg', 'get_forward_msg']);
  assert.equal(calls[1].params.id, FID);
  console.log('PASS 1a | 负 id 失败后改用段 id 取到 2 条');
}
{
  let n = 0;
  const client = { call: async (_a, params) => {
    n += 1;
    if (n === 1) throw new Error('OneBot get_forward_msg 超时（15 秒未完成）：timeout');
    return { messages: nodes };
  } };
  await assert.rejects(() => getForwardNodes(client, 123, FID), /超时/);
  assert.equal(n, 1, '非 payload empty 的故障不应重试');
  console.log('PASS 1b | 超时不重试');
}
{
  let n = 0;
  const client = { call: async () => { n += 1; throw payloadEmpty(); } };
  await assert.rejects(() => getForwardNodes(client, -1, ''), /payload is empty/);
  assert.equal(n, 1, '没有段 id 时不重试');
  console.log('PASS 1c | 没有段 id 时保持原错误');
}

// ── 2. 工具路径（ctx.onebot）─────────────────────────────────────────────
const mod = await import(pathToFileURL(path.join(ROOT, 'skills/forward-reader/index.js')).href);
let tool = null;
await mod.setup({ config: () => ({}), log: () => {}, fetch: null, registerTool: (d) => { tool = d; } });
assert.ok(tool, '没注册 forward_read');

function fakeOnebot(behavior) {
  const calls = [];
  return {
    calls,
    async call(action, params) {
      calls.push({ action, params });
      return behavior(action, params);
    }
  };
}

// 2a：正常回落
{
  const ob = fakeOnebot((action, params) => {
    if (action === 'get_forward_msg') {
      if (params.message_id != null) throw payloadEmpty();
      assert.equal(params.id, FID);
      return { messages: nodes };
    }
    if (action === 'get_msg') return { message: [forwardSeg] };
    throw new Error('unexpected ' + action);
  });
  const ctx = { chatKey: 'c', onebot: ob, store: { recent: () => [], updateByMid() {} } };
  const r = await tool.execute(ctx, { messageId: -1801457880 });
  const text = JSON.stringify(r.content);
  assert.ok(!r.isError, '不应报错');
  assert.ok(text.includes('转发记录 #-1801457880'), '应返回转发内容');
  assert.ok(text.includes('第一行内容') && text.includes('第二行内容'), '应包含节点文字');
  console.log('PASS 2a | 工具路径用段 id 回落成功');
}

// 2b：给错 #数字（引用消息）→ 改读最近一条转发并说明
{
  const ob = fakeOnebot((action, params) => {
    if (action === 'get_msg') return { message: params.message_id === -221569063 ? replySegs : [forwardSeg] };
    if (action === 'get_forward_msg') {
      if (params.message_id === -221569063) throw payloadEmpty();
      if (params.message_id === -1801457880) throw payloadEmpty();
      if (params.id === FID) return { messages: nodes };
    }
    throw new Error('unexpected ' + action);
  });
  const ctx = {
    chatKey: 'c',
    onebot: ob,
    store: {
      // 被问的引用消息前后各有一条转发：应改读它前面那条，而不是最新的
      recent: () => [
        { mid: -1801457880, text: '[合并转发聊天记录]' },
        { mid: -221569063, text: '[引用 甲：转发]' },
        { mid: -1000000001, text: '[合并转发聊天记录]' }
      ],
      updateByMid(_k, mid) { ctx.written = mid; }
    }
  };
  const r = await tool.execute(ctx, { messageId: -221569063 });
  const text = JSON.stringify(r.content);
  assert.ok(!r.isError, '改读成功不应报错');
  assert.ok(text.includes('不是合并转发，已自动改读它前面最近的一条转发 #-1801457880'), '应说明改读了哪条');
  assert.ok(text.includes('第一行内容'), '应返回最近转发的文字');
  assert.equal(String(ctx.written), '-1801457880', '写回应落到实际读到的那条');
  console.log('PASS 2b | 误传引用消息后改读最近转发并说明');
}

// 2c：两条路都失败 → 准确措辞，不再说"发送太久已被清理"
{
  const ob = fakeOnebot((action, params) => {
    if (action === 'get_msg') return { message: [forwardSeg] };
    if (action === 'get_forward_msg' && params.message_id != null) throw payloadEmpty();
    if (action === 'get_forward_msg') throw payloadEmpty();
    throw new Error('unexpected ' + action);
  });
  const ctx = { chatKey: 'c', onebot: ob, store: { recent: () => [], updateByMid() {} } };
  const r = await tool.execute(ctx, { messageId: -1801457880 });
  const text = JSON.stringify(r.content);
  assert.ok(r.isError, '两条路都失败应报错');
  assert.ok(text.includes('都试过了'), '应说明两条路都试过');
  assert.ok(text.includes('麻烦把文字直接贴一下'), '应保留如实说明要求');
  assert.ok(!text.includes('发送太久'), '不得再断言发送太久被清理');
  console.log('PASS 2c | 真失败时措辞准确');
}

// 2d：不是转发，也没有别的转发可读
{
  const ob = fakeOnebot((action) => {
    if (action === 'get_msg') return { message: replySegs };
    throw payloadEmpty();
  });
  const ctx = { chatKey: 'c', onebot: ob, store: { recent: () => [], updateByMid() {} } };
  const r = await tool.execute(ctx, { messageId: -221569063 });
  assert.ok(r.isError && JSON.stringify(r.content).includes('不是合并转发'));
  console.log('PASS 2d | 无转发可改读时提示不是转发');
}

// ── 3. 自动展开钩子（本机 HTTP 路径）────────────────────────────────────
const hookMod = await import(pathToFileURL(path.join(ROOT, 'skills/forward-reader/index.js')).href + '?hook');
let hookTool = null;
const fetchCalls = [];
const fakeFetch = async (url, opts) => {
  const action = String(url).split('/').pop();
  const body = JSON.parse(String(opts?.body || '{}'));
  fetchCalls.push({ action, body });
  if (action === 'get_forward_msg' && body.message_id != null) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'failed', retcode: 100, message: 'download forward message payload is empty' }) };
  }
  if (action === 'get_forward_msg') {
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: nodes } }) };
  }
  if (action === 'get_msg') {
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message: [forwardSeg] } }) };
  }
  throw new Error('unexpected ' + action);
};
await hookMod.setup({
  config: () => ({ onebotHttpUrl: 'http://127.0.0.1:9', onebotAccessToken: 'test-token' }),
  log: () => {},
  fetch: fakeFetch,
  registerTool: (d) => { hookTool = d; }
});
{
  const store = { last: null, updateByMid(_k, _m, patch) { store.last = patch; } };
  const ctx = {
    chatKey: 'c', sessionId: 's1', visionEnabled: false,
    triggerEntries: [{ mid: -1801457880, text: '[合并转发聊天记录]' }],
    store
  };
  await hookMod.hooks['before-context'](ctx);
  assert.ok(store.last, '钩子应写回存档');
  assert.ok(String(store.last.text).startsWith('[合并转发 共2条]'), '写回应是展开后的文本');
  assert.ok(String(store.last.text).includes('第一行内容'));
  const actions = fetchCalls.map((c) => c.action);
  assert.deepEqual(actions.slice(0, 3), ['get_forward_msg', 'get_msg', 'get_forward_msg'], '应按 message_id → get_msg → 段 id 顺序回落');
  assert.equal(fetchCalls[2].body.id, FID);

  const msgs = [{ role: 'user', content: '原始消息' }];
  await hookMod.hooks['before-llm-messages']({ sessionId: 's1', messages: msgs });
  assert.ok(String(msgs[0].content).includes('已经自动展开'), '应注入"已展开"提示');
  assert.ok(!String(msgs[0].content).includes('没能展开'), '成功时不应注入失败提示');
  console.log('PASS 3 | 自动展开钩子走回落并写回存档');
}

console.log('全部 8 项通过');
