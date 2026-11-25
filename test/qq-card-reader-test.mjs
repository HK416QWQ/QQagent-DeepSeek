// 卡片链接阅读（qq-card-reader）回归测试：全部离线，不连 QQ、不连外网。
// 所有网络请求都由 fetchImpl 假实现驱动；DNS 固定到公网地址，仅用于通过内网校验。
//
// 覆盖：
//   1. 卡片解析：内容键优先、纯小程序卡片判定、转义链接还原
//   2. 正文提取：未截断时 truncated=false、复读噪声不当作摘要
//   3. 抓取防护：内网/环回/文件地址/带凭据一律拒绝；钉扎 lookup 两种回调形态；重定向到内网被拦
//   4. 总超时预算：整条链共用，不会被每跳重置
//   5. 工具主流程：卡片链路成功 + 写回存档；纯小程序卡片给出明确原因
//   5b. 引用回复：卡片在被引用消息上时顺着 reply 段取回；取不到/不是卡片时如实降级
//   6. B 站分支：直链解析、元数据、封面多模态、cover=false、接口失败回退、b23 短链
//   7. 封面范围：非 B 站网页有 og:image 也不下载、不附封面
import assert from 'node:assert/strict';
import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MOD = path.join(ROOT, 'skills', 'qq-card-reader', 'index.js');
const m = await import(pathToFileURL(MOD).href);

// 测试不连外网：请求全部由 fetchImpl 假实现；这里只把 DNS 固定成公网地址，
// 让 assertPublicUrl 的内网校验能通过，避免测试依赖真实解析。
dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

const mkRes = (status, headers, body = '') => new Response(body, { status, headers });
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.error('  ✗', name, '\n    ', e?.message ?? e); }
}

// 1. 卡片解析
await test('内容键优先，缩略图不当作正文', () => {
  const card = JSON.stringify({ app: 'com.tencent.structmsg', meta: { news: { title: 't', preview: 'https://cdn.example.com/a.jpg', jumpUrl: 'https://mp.weixin.qq.com/s/abc?x=1&y=2' } } });
  assert.equal(m.extractCardLink(card)?.url, 'https://mp.weixin.qq.com/s/abc?x=1&y=2');
});
await test('纯小程序卡片判定为没有网页地址', () => {
  assert.equal(m.extractCardLink(JSON.stringify({ meta: { detail_1: { title: 'mini', icon: 'https://x.com/i.png' } } })), null);
});
await test('双层转义 / \\u0026 链接能还原', () => {
  const raw = '{"meta":{"detail_1":{"qqdocurl":"https:\\\\/\\\\/b23.tv\\\\/AbCdEf?x=1\\\\u0026y=2"}}}';
  assert.equal(m.extractCardLink(raw)?.url, 'https://b23.tv/AbCdEf?x=1&y=2');
});

// 2. 正文提取
await test('未截断时 truncated=false', () => {
  const html = '<html><head><title>T</title></head><body><article><p>' + '正'.repeat(50) + '</p></article></body></html>';
  assert.equal(m.extractArticle(html).truncated, false);
});
await test('复读噪声不会被当成摘要', () => {
  assert.equal(m.cleanDescription('简介：' + '哈'.repeat(120)), '');
  const mixed = '简介：一段正常的产品介绍文字，长度足够长足够长；' + '哈'.repeat(120);
  const out = m.cleanDescription(mixed);
  assert.ok(out.includes('产品介绍') && !out.includes('哈哈哈哈'));
});

// 3. 抓取防护
await test('内网 / 环回 / file:// / 带凭据一律拒绝', async () => {
  for (const u of ['http://127.0.0.1/x', 'http://localhost/x', 'http://[::1]/x', 'http://10.0.0.5/', 'file:///c:/x', 'http://user:pass@example.com/']) {
    await assert.rejects(m.assertPublicUrl(u), undefined, u);
  }
});
await test('钉扎 lookup：all 分支回全部已校验地址，单地址分支回三元组', async () => {
  const parsed = await m.assertPublicUrl('http://93.184.216.34/x');
  assert.deepEqual(parsed.ips, ['93.184.216.34']);
  const lookup = m.pinnedLookup(['93.184.216.34', '2606:4700::6810:84e5']);
  let allAddrs;
  lookup('example.com', { all: true }, (err, addrs) => { assert.equal(err, null); allAddrs = addrs; });
  assert.deepEqual(allAddrs, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700::6810:84e5', family: 6 }
  ]);
  let single;
  lookup('example.com', { all: false }, (err, address, family) => { assert.equal(err, null); single = { address, family }; });
  assert.deepEqual(single, { address: '93.184.216.34', family: 4 });
});
await test('重定向逐跳校验：302 到内网被拦', async () => {
  const redir = async () => mkRes(302, { location: 'http://127.0.0.1/secret' });
  await assert.rejects(m.fetchWithGuard('http://93.184.216.34/', { fetchImpl: redir, timeoutMs: 5000 }), /内网|本机/);
});
await test('正常重定向能跟到落地页', async () => {
  const fake = async (url) => String(url).includes('/page')
    ? mkRes(200, { 'content-type': 'text/html; charset=utf-8' }, '<html><head><title>标题A</title></head><body><article><p>正文</p></article></body></html>')
    : mkRes(302, { location: 'http://93.184.216.34/page' });
  const r = await m.fetchWithGuard('http://93.184.216.34/start', { fetchImpl: fake, timeoutMs: 5000 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.finalUrl, 'http://93.184.216.34/page');
});

// 4. 总超时
await test('超时预算按整条链生效（不会被每跳重置）', async () => {
  const slow = (url, init) => new Promise((_, reject) => {
    // 用 ref 住的定时器保持事件循环；否则 AbortSignal.timeout 的 unref 定时器
    // 会让 Node 在超时前直接退出（表现为 unsettled top-level await）。
    const guard = setTimeout(() => reject(new Error('slow-fetch-not-aborted')), 5000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(guard);
      reject(new Error('aborted-by-timeout'));
    });
  });
  const t0 = Date.now();
  await assert.rejects(m.fetchWithGuard('http://93.184.216.34/', { fetchImpl: slow, timeoutMs: 300 }), /aborted|超时/);
  assert.ok(Date.now() - t0 < 3000);
});

// 5. 工具主流程
function cardCtx(payload) {
  let written = null;
  const ctx = {
    chatKey: 'test-chat',
    store: {
      findByMid: () => ({ mid: '318', text: '[卡片消息]' }),
      updateByMid: (k, mid, patch) => { written = patch.text; }
    },
    onebot: { call: async () => ({ message: [{ type: 'json', data: { data: payload } }] }) }
  };
  return { ctx, written: () => written };
}

const HTML = '<html><head><meta property="og:title" content="卡片标题"></head><body><article><p>卡片正文</p></article></body></html>';
const canResolve = await dns.promises.lookup('example.com').then(() => true).catch(() => false);

if (canResolve) {
  await test('卡片链路：解析 → 抓取 → 写回，并标注外部内容', async () => {
    const { ctx, written } = cardCtx(JSON.stringify({ meta: { news: { jumpUrl: 'https://example.com/article' } } }));
    const res = await m.runReadCard(ctx, { messageId: '#318' }, { fetchImpl: async () => mkRes(200, { 'content-type': 'text/html' }, HTML) });
    const body = JSON.parse(res.content);
    assert.equal(res.isError, false);
    assert.equal(body.source, 'card');
    assert.equal(body.title, '卡片标题');
    assert.equal(body.untrusted, true);
    assert.ok(String(body.contentNote).includes('title'));
    assert.ok(written()?.includes('https://example.com/article'));
  });
} else {
  console.log('  - 跳过卡片链路用例：example.com 无法解析（离线环境）');
}

await test('纯小程序卡片：明确说"没有可访问的网页地址"', async () => {
  const { ctx } = cardCtx('{"meta":{"detail_1":{"title":"mini"}}}');
  const res = await m.runReadCard(ctx, { messageId: 318 });
  assert.equal(res.isError, true);
  assert.ok(JSON.parse(res.content).reason.includes('没有可访问的网页地址'));
});

// ── 5b. 引用回复里的卡片：卡片在被引用那条消息上 ─────────────────────────
const QUOTED_JUMP = 'https://example.com/quoted';

function replyCtx({ current, quoted, onCall = null }) {
  let written = null;
  const ctx = {
    chatKey: 'test-chat',
    store: {
      findByMid: () => ({ mid: '318', text: '[引用 群友(QQ:1)：[json]]现在呢' }),
      updateByMid: (k, mid, patch) => { written = patch.text; }
    },
    onebot: {
      call: async (action, params) => {
        onCall?.(action, params);
        if (action !== 'get_msg') throw new Error(`意外调用 ${action}`);
        const id = Number(params?.message_id);
        if (id === 318) return current;
        if (quoted && id === 317) return quoted;
        throw new Error('payload is empty');
      }
    }
  };
  return { ctx, written: () => written };
}

const REPLY_ONLY = {
  message: [
    { type: 'reply', data: { id: '317' } },
    { type: 'text', data: { text: '现在呢' } }
  ]
};

await test('引用回复里的卡片：当前消息只有 reply 段，顺着引用读取成功', async () => {
  const calls = [];
  const { ctx, written } = replyCtx({
    current: REPLY_ONLY,
    quoted: { message: [{ type: 'json', data: { data: JSON.stringify({ meta: { news: { jumpUrl: QUOTED_JUMP } } }) } }] },
    onCall: (action, params) => calls.push(Number(params?.message_id))
  });
  const res = await m.runReadCard(ctx, { messageId: '#318' }, { fetchImpl: async () => mkRes(200, { 'content-type': 'text/html' }, HTML) });
  const body = JSON.parse(res.content);
  assert.equal(res.isError, false);
  assert.equal(body.source, 'card');
  assert.equal(body.cardUrl, QUOTED_JUMP);
  assert.deepEqual(calls, [318, 317], '应先查当前消息，再查被引用的消息');
  assert.ok(written()?.includes(QUOTED_JUMP), '应把解析出的地址写回当前消息');
});

await test('引用目标取不到：降级说清"引用回复也不是卡片"，不乱猜', async () => {
  const { ctx } = replyCtx({ current: REPLY_ONLY, quoted: null });
  const res = await m.runReadCard(ctx, { messageId: 318 });
  const body = JSON.parse(res.content);
  assert.equal(res.isError, true);
  assert.equal(body.stage, 'no-card-segment');
  assert.ok(body.reason.includes('引用'));
});

await test('引用目标也不是卡片：文案明确说明两边都没有卡片数据', async () => {
  const { ctx } = replyCtx({
    current: REPLY_ONLY,
    quoted: { message: [{ type: 'text', data: { text: '原消息' } }] }
  });
  const res = await m.runReadCard(ctx, { messageId: 318 });
  const body = JSON.parse(res.content);
  assert.equal(res.isError, true);
  assert.equal(body.stage, 'no-card-segment');
  assert.ok(body.reason.includes('被引用的消息'));
});

await test('reply 指向自己：不重复请求同一条消息', async () => {
  const calls = [];
  const { ctx } = replyCtx({
    current: { message: [{ type: 'reply', data: { id: '318' } }] },
    quoted: null,
    onCall: (action, params) => calls.push(Number(params?.message_id))
  });
  const res = await m.runReadCard(ctx, { messageId: 318 });
  assert.equal(res.isError, true);
  assert.deepEqual(calls, [318]);
});

// ── 6. B 站分支 + 封面范围（全部走 fetchImpl 假实现，不连外网）────────────
const BILI_VIEW = (bvid, title = '测试视频标题') => ({
  code: 0,
  data: {
    bvid,
    aid: 170001,
    title,
    desc: '这是视频简介，够长一点，方便断言。',
    pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg',
    duration: 754,
    owner: { mid: 1, name: '测试UP' },
    stat: { view: 12345, danmaku: 67, like: 890, coin: 12, favorite: 34, share: 5, reply: 6 },
    pages: [
      { cid: 1, page: 1, part: 'P1 开头', duration: 300 },
      { cid: 2, page: 2, part: 'P2 正片', duration: 454 }
    ]
  }
});
// 1×1 PNG，够 detectImageType 认出魔数
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const BILI_HTML = '<html><head><meta property="og:title" content="网页标题">'
  + '<meta property="og:description" content="网页简介"></head><body><article><p>'
  + '网'.repeat(40) + '</p></article></body></html>';
// 普通网页（非 B 站）也带 og:image：用来确认封面逻辑不会越界。
const ARTICLE_HTML = '<html><head><meta property="og:title" content="普通文章">'
  + '<meta property="og:description" content="普通文章简介">'
  + '<meta property="og:image" content="https://cdn.example.com/og.jpg"></head><body><article><p>'
  + '正文'.repeat(40) + '</p></article></body></html>';
const bodyOf = (res) => JSON.parse(Array.isArray(res.content) ? res.content[0].text : res.content);

await test('B 站直链解析：BV / av / 分P；短链和非 B 站不算', () => {
  assert.deepEqual(m.parseBilibiliVideoId('https://www.bilibili.com/video/BV1aa411c7mA/?p=3&spm=x'), { bvid: 'BV1aa411c7mA', aid: null, page: 3 });
  assert.deepEqual(m.parseBilibiliVideoId('https://m.bilibili.com/video/av170001'), { bvid: null, aid: 170001, page: 1 });
  assert.equal(m.parseBilibiliVideoId('https://b23.tv/abc'), null);
  assert.equal(m.parseBilibiliVideoId('https://example.com/video/BV1aa411c7mA'), null);
});

await test('B 站封面地址归一：http → https，协议相对也能补全', () => {
  assert.equal(m.normalizeBiliPic('http://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(m.normalizeBiliPic('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(m.normalizeBiliPic(''), '');
});

await test('抓取层能按字节返回，并带上自定义请求头', async () => {
  let seen = null;
  const fake = async (url, init) => {
    seen = init.headers;
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
  const r = await m.fetchWithGuard('https://api.bilibili.com/x/test', {
    fetchImpl: fake, timeoutMs: 3000, asBytes: true,
    headers: { referer: 'https://www.bilibili.com/' }
  });
  assert.deepEqual([...r.bytes], [1, 2, 3, 4]);
  assert.equal(r.body, undefined);
  assert.equal(seen.referer, 'https://www.bilibili.com/');
});

await test('B 站直链：接口一次拿到标题/UP主/播放量/时长，不抓 HTML', async () => {
  const BV = 'BV1bb411c7mB';
  const calls = [];
  const fake = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return mkRes(200, { 'content-type': 'application/json' }, JSON.stringify(BILI_VIEW(BV)));
    }
    return mkRes(404, {}, 'no');
  };
  const { ctx } = cardCtx('{}');
  const res = await m.runReadCard(ctx, { url: `https://www.bilibili.com/video/${BV}?p=2` }, { fetchImpl: fake, visionEnabled: false });
  const body = bodyOf(res);
  assert.equal(res.isError, false);
  assert.equal(body.platform, 'bilibili');
  assert.equal(body.bvid, BV);
  assert.equal(body.author, '测试UP');
  assert.equal(body.duration, '12:34');
  assert.equal(body.stats.view, 12345);
  assert.equal(body.pageCount, 2);
  assert.equal(body.coverIncluded, false);
  assert.ok(body.coverNote.includes('图片输入'));
  assert.ok(!calls.some((u) => u.includes('/video/')));
  assert.ok(!calls.some((u) => u.includes('i0.hdslb.com')));
});

await test('B 站直链 + 视觉可用：封面作为 image_url 交给模型', async () => {
  const BV = 'BV1cc411c7mC';
  const calls = [];
  const fake = async (url) => {
    const s = String(url);
    calls.push(s);
    if (s.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return mkRes(200, { 'content-type': 'application/json' }, JSON.stringify(BILI_VIEW(BV)));
    }
    if (s.includes('i0.hdslb.com')) {
      return new Response(PNG_1PX, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return mkRes(404, {}, 'no');
  };
  const { ctx } = cardCtx('{}');
  const res = await m.runReadCard(ctx, { url: `https://www.bilibili.com/video/${BV}` }, { fetchImpl: fake, visionEnabled: true });
  assert.ok(Array.isArray(res.content), '应返回多模态 parts');
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.coverIncluded, true);
  assert.equal(body.coverUrl, 'https://i0.hdslb.com/bfs/archive/cover.jpg');
  assert.equal(res.content[1].type, 'image_url');
  assert.match(res.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.ok(calls.some((u) => u.includes('i0.hdslb.com')));
});

await test('cover=false：视觉可用也不下载封面', async () => {
  const BV = 'BV1dd411c7mD';
  const calls = [];
  const fake = async (url) => {
    const s = String(url);
    calls.push(s);
    if (s.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return mkRes(200, { 'content-type': 'application/json' }, JSON.stringify(BILI_VIEW(BV)));
    }
    return mkRes(404, {}, 'no');
  };
  const { ctx } = cardCtx('{}');
  const res = await m.runReadCard(ctx, { url: `https://www.bilibili.com/video/${BV}`, cover: false }, { fetchImpl: fake, visionEnabled: true });
  const body = bodyOf(res);
  assert.equal(typeof res.content, 'string');
  assert.equal(body.coverIncluded, false);
  assert.ok(!calls.some((u) => u.includes('i0.hdslb.com')));
});

await test('B 站接口失败：退回网页正文，不报错', async () => {
  const BV = 'BV1ee411c7mE';
  let apiCalls = 0;
  const fake = async (url) => {
    const s = String(url);
    if (s.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      apiCalls += 1;
      return mkRes(200, { 'content-type': 'application/json' }, JSON.stringify({ code: -412, message: '请求被拦截' }));
    }
    if (s.includes('/video/')) return mkRes(200, { 'content-type': 'text/html' }, BILI_HTML);
    return mkRes(404, {}, 'no');
  };
  const { ctx } = cardCtx('{}');
  const res = await m.runReadCard(ctx, { url: `https://www.bilibili.com/video/${BV}` }, { fetchImpl: fake, visionEnabled: false });
  const body = bodyOf(res);
  assert.equal(res.isError, false);
  assert.equal(body.title, '网页标题');
  assert.equal(body.platform, undefined);
  assert.equal(apiCalls, 1, '直链接口失败后不应原地重试接口');
});

await test('非 B 站网页：有 og:image 也不下载、不附封面', async () => {
  const calls = [];
  const fake = async (url) => {
    const s = String(url);
    calls.push(s);
    if (s === 'https://mp.weixin.qq.com/s/abc') {
      return mkRes(200, { 'content-type': 'text/html' }, ARTICLE_HTML);
    }
    if (s.includes('cdn.example.com')) {
      return new Response(PNG_1PX, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return mkRes(404, {}, 'no');
  };
  const { ctx } = cardCtx('{}');
  const res = await m.runReadCard(ctx, { url: 'https://mp.weixin.qq.com/s/abc' }, { fetchImpl: fake, visionEnabled: true });
  const body = bodyOf(res);
  assert.equal(res.isError, false);
  assert.equal(typeof res.content, 'string');
  assert.equal(body.platform, undefined);
  assert.equal(body.coverIncluded, undefined);
  assert.equal(body.coverUrl, undefined);
  assert.ok(!calls.some((u) => u.includes('cdn.example.com')));
});

await test('b23 短链：跟随跳转后用接口补全标题/封面', async () => {
  const BV = 'BV1ff411c7mF';
  const fake = async (url) => {
    const s = String(url);
    if (s === 'https://b23.tv/bili-test') {
      return mkRes(302, { location: `https://www.bilibili.com/video/${BV}` });
    }
    if (s.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return mkRes(200, { 'content-type': 'application/json' }, JSON.stringify(BILI_VIEW(BV, '接口标题')));
    }
    if (s.includes('/video/')) return mkRes(200, { 'content-type': 'text/html' }, BILI_HTML);
    if (s.includes('i0.hdslb.com')) {
      return new Response(PNG_1PX, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return mkRes(404, {}, 'no');
  };
  const { ctx } = cardCtx('{}');
  const res = await m.runReadCard(ctx, { url: 'https://b23.tv/bili-test' }, { fetchImpl: fake, visionEnabled: true });
  const body = bodyOf(res);
  assert.equal(body.platform, 'bilibili');
  assert.equal(body.title, '接口标题');
  assert.equal(body.shortLink, true);
  assert.equal(body.coverIncluded, true);
});

if (failed) {
  console.error(`\n❌ 卡片链接阅读测试失败 ${failed} 项（通过 ${passed}）`);
  process.exit(1);
}
console.log(`\n✅ 卡片链接阅读测试通过 ${passed} 项`);
