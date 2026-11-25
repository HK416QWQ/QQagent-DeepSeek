// P0-02：session-start / session-end 自带列表摘要（施工单 v2.15 §4.5 sse-summary-test）
//
// 真起一套 mock 环境 + 真 SSE 连接，断言事件里的摘要字段与回退行为。
import assert from 'node:assert/strict';
import { bootApp, sleep, createChecker } from './_harness.mjs';

const { check, finish } = createChecker('SSE 起止事件摘要');

const env = await bootApp({ config: { allow: { groups: ['456'], private: [] } } });
const { app, base, request, pushGroupMsg, llm } = env;
void llm;

// ── SSE 客户端：把事件按块切开存起来 ──────────────────────────────────────
const events = [];
const ctrl = new AbortController();
const sseReady = (async () => {
  const res = await fetch(`${base}/api/events`, { headers: { accept: 'text/event-stream' }, signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = '';
          const datas = [];
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7).trim();
            else if (line.startsWith('data: ')) datas.push(line.slice(6));
          }
          if (type) events.push({ type, data: datas.join('\n') });
        }
      }
    } catch { /* abort 正常结束 */ }
  })();
})();
await sseReady;

const waitEvent = async (type, pred, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = events.find((e) => e.type === type && (!pred || pred(e)));
    if (hit) return hit;
    await sleep(30);
  }
  throw new Error(`等待 ${type} 超时；已收到：${events.map((e) => e.type).join(', ')}`);
};
const json = (e) => JSON.parse(e.data);

try {
  let sessionId = '';
  await check('1. session-start 带摘要且含 trigger、不带 messages', async () => {
    pushGroupMsg(111, '张三', '@覆盖Bot 摘要用例', 43001);
    const ev = await waitEvent('session-start', (e) => {
      try { return json(e).sessionId; } catch { return false; }
    });
    const d = json(ev);
    sessionId = d.sessionId;
    assert.ok(sessionId, '应有 sessionId');
    assert.ok(String(d.trigger || '').includes('摘要用例'), `trigger 应为列表可用文本，实际 ${d.trigger}`);
    assert.equal(d.triggerSummary, d.trigger, 'triggerSummary 保留给旧读取方');
    assert.ok(!('messages' in d), 'session-start 不应带 messages');
    assert.equal(d.outcome, null);
    return sessionId.slice(0, 10);
  });

  await check('2. session-end 带最终 usage/sent/status/error/finishReason', async () => {
    const ev = await waitEvent('session-end', (e) => {
      try { const d = json(e); return d.sessionId === sessionId && d.status && d.status !== 'deleted'; } catch { return false; }
    });
    const d = json(ev);
    assert.ok(['done', 'noreply', 'error', 'aborted'].includes(d.status), `status=${d.status}`);
    assert.ok(Number(d.usage?.totalTokens) > 0, `usage.totalTokens 应 >0，实际 ${d.usage?.totalTokens}`);
    assert.ok(Array.isArray(d.sent), 'sent 应是数组');
    assert.ok('finishReason' in d, '应保留 finishReason 字段');
    assert.equal(d.error, null);
    assert.ok(d.endedAt, '应有 endedAt');
    assert.ok(!('messages' in d), 'session-end 不应带 messages');
    return `status=${d.status} tokens=${d.usage.totalTokens}`;
  });

  await check('3. deleted：peek 为 null 时回退原 payload 且不抛错', async () => {
    const r = await request('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`);
    assert.equal(r.status, 200, `DELETE 应 200，实际 ${r.status}`);
    const ev = await waitEvent('session-end', (e) => {
      try { return json(e).status === 'deleted'; } catch { return false; }
    });
    const d = json(ev);
    assert.equal(d.sessionId, sessionId);
    assert.equal(d.status, 'deleted');
    return '回退 payload';
  });

  await check('4. clear-finished：无 sessionId 不抛错', async () => {
    const r = await request('POST', '/api/sessions/clear-finished', { body: {} });
    assert.equal(r.status, 200);
    const ev = await waitEvent('session-end', (e) => {
      try { return json(e).status === 'cleared'; } catch { return false; }
    });
    const d = json(ev);
    assert.equal(d.status, 'cleared');
    assert.equal(typeof d.removed, 'number');
    return `removed=${d.removed}`;
  });

  await check('5. 运行中续推 session-update 仍带 messages（本单不改）', async () => {
    // 触发一次会调用工具的会话，确保有 session-update
    pushGroupMsg(111, '张三', '@覆盖Bot 更新用例', 43002);
    const ev = await waitEvent('session-update', (e) => {
      try { return json(e).sessionId; } catch { return false; }
    }, 20000);
    const d = json(ev);
    assert.ok(Array.isArray(d.messages), 'session-update 应继续带 messages');
    return `messages=${d.messages.length}`;
  });
} finally {
  ctrl.abort();
  await env.teardown();
}

const code = finish();
process.exit(code ? 0 : 1);
