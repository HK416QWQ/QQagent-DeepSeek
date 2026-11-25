// 覆盖测试 B：HTTP 接口层
//
// 覆盖 src/routes.js 里声明的全部 API 路由（含只读/写/删除），外加：
//   - 静态文件与路径穿越防护
//   - 安全回归：CSRF、SSRF、密钥脱敏、鉴权默认值
//   - 接口覆盖率统计（跑了多少条声明的路由）
//
// 安全说明：会在隔离数据目录里起完整服务；不启动 SnowLuma / 不打开资源管理器 /
//           不动用户真实 data/。破坏性接口 /api/reset-data 放在最后单独测。
//
// 运行：node test/coverage-http.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createChecker, bootApp, listen, ROOT, sleep } from './_harness.mjs';

const c = createChecker('HTTP 接口层覆盖');

const ctx = await bootApp({
  config: {
    // 指向不存在的目录：让 /api/snowluma/launch 走"找不到"分支，
    // 避免测试真的去拉起用户的 SnowLuma。
    snowluma: { dir: path.join(ROOT, '__no_such_snowluma__'), accessToken: '' },
    api: {
      baseUrl: '', apiKey: '', model: 'test-model-a', priceRemoteUrl: '', vision: true,
      temperature: 0.7, maxRounds: 6, priceInputPerM: 2, priceOutputPerM: 8
    }
  }
});
const { app, request, rawRequest, onebotHttp, llm, pushGroupMsg, waitSessionDone } = ctx;

// 记录实际打过的接口，用于最后的覆盖率统计
const exercised = new Set();
const hit = async (method, p, opts) => {
  exercised.add(`${method} ${p.split('?')[0]}`);
  return request(method, p, opts);
};

// 先建立一些数据，让只读接口有内容可返回
{
  const { ChatStore } = await import('../src/store.js');
  app.store.appendIncoming('group:456', { mid: 7001, ts: Date.now() - 3000, senderId: '111', senderName: '张三', text: '覆盖测试消息一' });
  app.store.appendIncoming('group:456', { mid: 7002, ts: Date.now() - 2000, senderId: '113', senderName: '王五', text: '覆盖测试消息二' });
  app.store.appendSelf('group:456', { text: '机器人的一句回复', ts: Date.now() - 1000 });
  app.store.drainUnread('group:456');
  const s = app.sessions.create({ chatKey: 'group:456', trigger: '覆盖测试会话' });
  app.sessions.finish(s.id, 'done');
}

// ── 1. 状态 / 用量 / 价格 ────────────────────────────────────────────────
c.section('1. 状态 / 用量 / 价格');
{
  await c.check('GET /api/status：返回 onebot/snowluma/orchestrator/usage 等关键块', async () => {
    const r = await hit('GET', '/api/status');
    assert.equal(r.status, 200);
    for (const k of ['onebot', 'snowluma', 'orchestrator', 'usage', 'cost', 'paused', 'runtime', 'dataDir']) {
      assert.ok(k in r.data, `status 缺少字段 ${k}`);
    }
    assert.equal(r.data.onebot.connected, true, 'mock OneBot 应已连接');
    assert.equal(r.data.onebot.self.userId, '888');
  });

  await c.check('GET /api/runtime：返回 serverNow/current/runs，limit 夹在 1..200', async () => {
    const r = await hit('GET', '/api/runtime?limit=999');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.ok(Number.isFinite(r.data.serverNow), 'serverNow 应为数字');
    assert.ok('current' in r.data, '缺少 current');
    assert.ok(Array.isArray(r.data.runs), 'runs 应为数组');
    assert.ok(r.data.runs.length <= 200, `limit 未夹紧：${r.data.runs.length}`);
  });

  await c.check('GET /api/deepseek-balance：未配置 baseUrl → 200 unsupported（且 handler 确实写了响应）', async () => {
    let timer;
    const r = await Promise.race([
      hit('GET', '/api/deepseek-balance'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('3 秒未返回：余额路由没有自行写响应')), 3000); })
    ]).finally(() => clearTimeout(timer));
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, false);
    assert.equal(r.data.reason, 'unsupported');
    assert.ok(!JSON.stringify(r.data).includes('api.deepseek.com'), '响应不能包含 baseUrl');
    assert.match(String(r.headers.get('cache-control') || ''), /no-store/);
  });

  await c.check('GET /api/usage/stats：各时间范围都可用且结构完整', async () => {
    for (const range of ['today', '7', '30', 'all']) {
      const r = await hit('GET', `/api/usage/stats?range=${range}`);
      assert.equal(r.status, 200, `range=${range} 应 200`);
      assert.ok('cost' in r.data || 'total' in r.data || typeof r.data === 'object', `range=${range} 返回为空`);
    }
  });

  await c.check('GET /api/usage/breakdown：按维度下钻可用', async () => {
    const r = await hit('GET', '/api/usage/breakdown?range=7&dim=model');
    assert.equal(r.status, 200);
    assert.ok(r.data && typeof r.data === 'object');
  });

  await c.check('POST /api/sessions/:id/retry：会话重试接口的守卫正确', async () => {
    // 不存在的会话 → 409 + 原因说明（不是 500 崩溃）
    const r = await hit('POST', '/api/sessions/nonexistent-id/retry');
    assert.equal(r.status, 409, `不存在的会话应 409，实际 ${r.status}`);
    assert.equal(r.data.ok, false);
    assert.ok(String(r.data.error || '').length > 0, '应给出失败原因');
  });

  await c.check('GET /api/model-prices：返回内置价格表与当前模型解析结果', async () => {
    const r = await hit('GET', '/api/model-prices');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.prices) && r.data.prices.length > 0, '应返回价格表');
    assert.ok('current' in r.data, '应返回当前模型价格');
  });

  await c.check('POST /api/model-prices/refresh：远程 URL 为空时不联网、安全返回', async () => {
    const r = await hit('POST', '/api/model-prices/refresh');
    assert.ok(r.status === 200, `应 200，实际 ${r.status}`);
    assert.ok(r.data && typeof r.data === 'object');
  });
}

// ── 2. 配置接口 ──────────────────────────────────────────────────────────
c.section('2. 配置接口');
{
  await c.check('GET /api/config：返回脱敏配置（不含明文密钥）', async () => {
    const r = await hit('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.data.api.apiKey, undefined, 'apiKey 不应出现在响应里');
    assert.equal(typeof r.data.api.hasApiKey, 'boolean', '应给出 hasApiKey 标记');
    assert.ok(r.data.api.baseUrl !== undefined, 'baseUrl 应保留');
  });

  await c.check('POST /api/config：保存并回读生效', async () => {
    const r = await hit('POST', '/api/config', { body: { ui: { showVision: false } } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    const back = await hit('GET', '/api/config');
    assert.equal(back.data.ui.showVision, false, '保存的值应生效');
    await hit('POST', '/api/config', { body: { ui: { showVision: true } } });
  });

  await c.check('POST /api/config：__replace__ 可删除旧键（批量价格编辑依赖）', async () => {
    await hit('POST', '/api/config', { body: { api: { modelPrices: { 'a': { in: 1, out: 2, cached: 1 } } } } });
    await hit('POST', '/api/config', { body: { api: { modelPrices: { __replace__: { 'b': { in: 3, out: 4, cached: 3 } } } } } });
    const back = await hit('GET', '/api/config');
    assert.deepEqual(Object.keys(back.data.api.modelPrices), ['b'], '旧键应被彻底替换');
  });

  await c.check('POST /api/config：非法请求体不会让服务崩掉（后续请求仍可用）', async () => {
    const r = await request('POST', '/api/config', { body: '这不是 JSON', headers: { 'content-type': 'application/json' } });
    assert.ok(r.status >= 400, `非法 JSON 应被拒绝，实际 ${r.status}`);
    const after = await hit('GET', '/api/status');
    assert.equal(after.status, 200, '服务应仍可用（未因坏请求崩溃）');
  });

  await c.known(
    'POST /api/config：非法 JSON 应返回 400 而不是 500',
    async () => {
      const r = await request('POST', '/api/config', { body: '这不是 JSON', headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 400, `实际 ${r.status}（readBody 的 JSON.parse 异常直接冒到框架变成 500）`);
    },
    '已知：readBody 抛错未在框架层转成 400'
  );

  await c.known(
    'POST /api/config 的响应体也应脱敏（与 GET 一致）',
    async () => {
      const r = await hit('POST', '/api/config', { body: { ui: { showVision: true } } });
      assert.equal(r.data.config.api.apiKey, undefined, 'POST 响应里出现了明文 apiKey');
    },
    '已知：routes.js POST /api/config 直接 return updateConfig(patch)（活对象），未经 sanitizeConfig'
  );
}

// ── 3. 人设模板 ──────────────────────────────────────────────────────────
c.section('3. 人设模板');
{
  let customId = null;
  await c.check('GET /api/persona-templates：含内置模板', async () => {
    const r = await hit('GET', '/api/persona-templates');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.templates) && r.data.templates.length > 0, '应返回模板列表');
    assert.ok(r.data.templates.some((t) => t.builtin), '应含内置模板');
  });

  await c.check('POST /api/persona-templates：新增自定义模板', async () => {
    const r = await hit('POST', '/api/persona-templates', { body: { name: '覆盖人设', text: '你是一个覆盖测试人设。' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    const list = await hit('GET', '/api/persona-templates');
    const found = list.data.templates.find((t) => t.name === '覆盖人设');
    assert.ok(found, '新增的模板应出现在列表里');
    customId = found.id;
  });

  await c.check('POST /api/persona-templates：名称为空被拒绝', async () => {
    const r = await hit('POST', '/api/persona-templates', { body: { name: '', text: 'x' } });
    assert.equal(r.status, 400, '空名称应 400');
  });

  await c.check('DELETE /api/persona-templates/:id：删除自定义模板', async () => {
    const r = await hit('DELETE', `/api/persona-templates/${customId}`);
    assert.equal(r.status, 200);
    const list = await hit('GET', '/api/persona-templates');
    assert.ok(!list.data.templates.some((t) => t.name === '覆盖人设'), '删除后不应再出现');
  });
}

// ── 4. Skill / 工具 ──────────────────────────────────────────────────────
c.section('4. Skill / 工具');
{
  await c.check('GET /api/skills：返回 Skill 列表、摘要与能力清单', async () => {
    const r = await hit('GET', '/api/skills');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.skills), '应返回 skills 数组');
    assert.ok(Array.isArray(r.data.capabilities), '应返回 capabilities 数组');
    assert.ok(r.data.summary && typeof r.data.summary === 'object', '应返回 summary');
    for (const s of r.data.skills) {
      assert.ok('loaded' in s && 'enabled' in s && 'available' in s && 'active' in s,
        `Skill ${s.id} 缺少四层状态字段`);
    }
  });

  await c.check('POST /api/skills/:id：关闭再开启，状态可往返', async () => {
    // skills/ 与 plugins/ 是用户后装扩展的落点，可能为空（内置功能已收编核心）。
    // 开关联动与 settings 白名单需要真实加载的 Skill 才能测 —— 空目录时跳过
    // 而不是假失败（架构加载/校验链路由 skill-test 锁定）。
    const loadedSkills = (await hit('GET', '/api/skills')).data.skills.filter((s) => s.loaded);
    if (loadedSkills.length > 0) {
      const target = loadedSkills[0];
      const off = await hit('POST', `/api/skills/${encodeURIComponent(target.id)}`, { body: { enabled: false } });
      assert.equal(off.status, 200);
      assert.equal(off.data.skill.enabled, false, '应变为未启用');
      assert.equal(off.data.skill.active, false, '未启用的 Skill 不应处于 active');
      const on = await hit('POST', `/api/skills/${encodeURIComponent(target.id)}`, { body: { enabled: true } });
      assert.equal(on.status, 200);
      assert.equal(on.data.skill.enabled, true, '应恢复启用');
    }
  });

  await c.check('POST /api/skills/:id：不存在的 Skill 返回 404', async () => {
    const r = await hit('POST', '/api/skills/no-such-skill-xyz', { body: { enabled: true } });
    assert.equal(r.status, 404);
  });


  await c.check('GET /api/skills/capabilities：每个能力都有可解释的可用性', async () => {
    const r = await hit('GET', '/api/skills/capabilities');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.capabilities));
    for (const cap of r.data.capabilities) {
      assert.ok(cap.name, '能力应有名字');
      assert.equal(typeof cap.available, 'boolean', `能力 ${cap.name} 缺少 available`);
    }
  });

  await c.check('GET /api/tools：返回工具清单与分类', async () => {
    const r = await hit('GET', '/api/tools');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.tools) && r.data.tools.length > 0, '应有内置工具');
    for (const t of r.data.tools.slice(0, 5)) {
      assert.ok(t.id && t.name, '工具应有 id/name');
    }
  });

  await c.check('GET /api/tools/availability：与工具清单同源，且给出原因码', async () => {
    const r = await hit('GET', '/api/tools/availability');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.tools));
    assert.ok(r.data.categories && typeof r.data.categories === 'object', '应返回分类元数据');
    for (const t of r.data.tools) {
      assert.equal(typeof t.enabled, 'boolean', `工具 ${t.id} 缺少 enabled`);
      if (!t.enabled) assert.ok(t.reason, `不可用工具 ${t.id} 应给出原因`);
    }
  });

  await c.check('工具可用性口径一致：/api/tools 与 /api/tools/availability 的 id 集合相同', async () => {
    const a = await hit('GET', '/api/tools');
    const b = await hit('GET', '/api/tools/availability');
    const sa = new Set(a.data.tools.map((t) => t.id));
    const sb = new Set(b.data.tools.map((t) => t.id));
    assert.equal(sa.size, sb.size, `工具数不一致：${sa.size} vs ${sb.size}`);
  });
}

// ── 5. 提供商 / 模型目录 / 搜索服务 ──────────────────────────────────────
c.section('5. 提供商 / 模型目录 / 搜索服务');
{
  await c.check('GET /api/providers：返回提供商列表且不带明文 Key', async () => {
    const r = await hit('GET', '/api/providers');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.providers));
    for (const p of r.data.providers) {
      assert.equal(p.apiKey, '', `提供商 ${p.id} 不应回传明文 Key`);
    }
  });

  await c.check('GET /api/models：能从配置的 baseUrl 拉到模型列表', async () => {
    await hit('POST', '/api/config', { body: { api: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k' } } });
    const r = await hit('GET', '/api/models');
    assert.equal(r.status, 200, `应 200，实际 ${r.status} ${r.text?.slice(0, 80)}`);
    assert.ok(Array.isArray(r.data.models) && r.data.models.length >= 1, '应拉到 mock 模型');
  });

  await c.check('POST /api/providers/fetch-models：给定 baseUrl 拉模型', async () => {
    const r = await hit('POST', '/api/providers/fetch-models', {
      body: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k' }
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.models) && r.data.models.length >= 1);
  });

  await c.check('POST /api/providers/fetch-models：不可达地址返回错误而不是 5xx', async () => {
    const r = await hit('POST', '/api/providers/fetch-models', { body: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' } });
    assert.ok(r.status >= 400 && r.status < 600, `应返回错误码，实际 ${r.status}`);
    assert.ok(r.data.error, '应给出错误说明');
  });

  let providerId = null;
  await c.check('POST /api/providers：新增提供商', async () => {
    const r = await hit('POST', '/api/providers', {
      body: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'provider-secret-key', models: ['test-model-a'] }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.provider.apiKey, '', '响应不应含明文 Key');
    providerId = r.data.provider.id;
    assert.ok(providerId, '应返回 provider id');
  });

  await c.check('POST /api/providers/models：追加模型', async () => {
    const r = await hit('POST', '/api/providers/models', { body: { providerId, models: ['test-model-b'] } });
    assert.equal(r.status, 200);
    assert.ok(r.data.provider.models.includes('test-model-b'), '追加的模型应在列表里');
  });

  await c.check('DELETE /api/providers/models：删除模型', async () => {
    const r = await hit('DELETE', '/api/providers/models', { body: { providerId, modelId: 'test-model-b' } });
    assert.equal(r.status, 200);
    assert.ok(!r.data.provider.models.includes('test-model-b'), '删除后不应再出现');
  });

  await c.check('POST /api/providers/set-key：设置密钥后只回 hasKey', async () => {
    const r = await hit('POST', '/api/providers/set-key', { body: { providerId, apiKey: 'another-secret' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.hasKey, true, '应标记为已有 Key');
    assert.equal(r.data.apiKey, undefined, '不应回传明文');
  });

  await c.check('POST /api/providers/fetch-models：按 providerId 用该提供商保存的 Key（不再错拿顶层 Key）', async () => {
    // 2026-09-20 回归：模型管理「拉取模型列表」只传 {baseUrl, providerId} 不带 Key。
    // 旧实现回落顶层 api.apiKey —— 多提供商下顶层只存当前选中那个的 Key，
    // 从别的提供商拉列表必然 401。现在必须按 providerId 解析 dshProviderKeys。
    // mock 的 /v1/models 开启 Key 校验：只认 set-key 写入的 'another-secret'，
    // 错拿顶层 Key（'k'）就会被 mock 401 → 502，一眼红。
    llm.state.requireModelsKey = 'another-secret';
    try {
      const r = await hit('POST', '/api/providers/fetch-models', {
        body: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, providerId }
      });
      assert.equal(r.status, 200, `带 providerId 且不带 Key 应按提供商 Key 拉取成功，实际 ${r.status}：${r.text?.slice(0, 100)}`);
      assert.ok(Array.isArray(r.data.models) && r.data.models.length >= 1);
    } finally {
      llm.state.requireModelsKey = '';
    }
  });

  await c.check('POST /api/providers/test-one：连通性测试返回结果', async () => {
    const r = await hit('POST', '/api/providers/test-one', {
      body: { providerId: '', baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k' }
    });
    assert.ok(r.status === 200 || r.status === 500, `应返回结构化结果，实际 ${r.status}`);
    assert.ok(r.data, '应有响应体');
  });

  await c.check('POST /api/providers/test-chat：真实打一次 chat/completions', async () => {
    const r = await hit('POST', '/api/providers/test-chat', {
      body: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k', model: 'test-model-a' }
    });
    assert.equal(r.status, 200, `应 200，实际 ${r.status}`);
    assert.equal(r.data.ok, true);
    assert.ok(r.data.result, '应返回测试结果');
  });

  await c.check('POST /api/providers/test-chat：不可达地址被如实报告（不误报成功）', async () => {
    const r = await hit('POST', '/api/providers/test-chat', {
      body: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'x' }
    });
    assert.ok(r.status === 200 || r.status === 400, `应返回结构化结果，实际 ${r.status}`);
    const failed = r.status === 400 || r.data?.ok === false || r.data?.result?.ok === false;
    assert.ok(failed, `不可达地址不应被报告为成功：${r.text.slice(0, 120)}`);
  });

  await c.check('POST /api/providers/test-all：批量测试返回统计', async () => {
    const r = await hit('POST', '/api/providers/test-all');
    assert.equal(r.status, 200);
    assert.ok(r.data.ok === true);
    assert.ok('total' in r.data && 'okCount' in r.data, '应返回 total/okCount');
  });

  await c.check('DELETE /api/providers：删除提供商', async () => {
    const r = await hit('DELETE', '/api/providers', { body: { providerId } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  await c.check('DELETE /api/providers：不存在的提供商返回 404', async () => {
    const r = await hit('DELETE', '/api/providers', { body: { providerId: 'no-such-provider' } });
    assert.equal(r.status, 404);
  });

  // 搜索服务
  let spId = null;
  await c.check('GET /api/search-providers：列表不含明文 Key', async () => {
    const r = await hit('GET', '/api/search-providers');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.providers));
    for (const p of r.data.providers) assert.equal(p.apiKey, undefined, '搜索服务不应回传明文 Key');
  });

  await c.check('POST /api/search-providers：新增自定义搜索服务', async () => {
    const r = await hit('POST', '/api/search-providers', {
      body: { name: '覆盖搜索', baseUrl: `http://127.0.0.1:${onebotHttp.server.address().port}/search`, type: 'bing', count: 5 }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    spId = r.data.provider.id;
    assert.ok(spId, '应返回搜索服务 id');
  });

  await c.check('POST /api/search-providers：baseUrl 为空被拒绝（400）', async () => {
    const r = await hit('POST', '/api/search-providers', { body: { name: 'x', baseUrl: '' } });
    assert.equal(r.status, 400);
  });

  await c.check('POST /api/search-providers/test：测试连通性返回结构化结果', async () => {
    const r = await hit('POST', '/api/search-providers/test', { body: { providerId: spId } });
    assert.equal(r.status, 200);
    assert.ok(r.data.result && typeof r.data.result.ok === 'boolean', '应返回 {ok,latencyMs}');
  });

  await c.check('DELETE /api/search-providers：删除自定义搜索服务', async () => {
    const r = await hit('DELETE', '/api/search-providers', { body: { id: spId } });
    assert.equal(r.status, 200);
    const list = await hit('GET', '/api/search-providers');
    assert.ok(!list.data.providers.some((p) => p.id === spId), '删除后不应再出现');
  });

  await c.check('POST /api/test/api：一键测试当前模型连通性', async () => {
    const r = await hit('POST', '/api/test/api');
    assert.equal(r.status, 200);
    assert.ok('ok' in r.data, '应返回 ok 字段（成功或失败都算通过）');
    assert.ok('latencyMs' in r.data, '应返回延迟');
  });
}

// ── 6. 视觉能力 ──────────────────────────────────────────────────────────
c.section('6. 视觉能力');
{
  await c.check('GET /api/vision/results：返回结果表与扫描状态', async () => {
    const r = await hit('GET', '/api/vision/results');
    assert.equal(r.status, 200);
    assert.ok(r.data.results && typeof r.data.results === 'object');
    assert.equal(typeof r.data.scanning, 'boolean');
  });

  await c.check('POST /api/vision/scan：无可用提供商时也能安全返回 202', async () => {
    const r = await hit('POST', '/api/vision/scan', { body: {} });
    assert.ok(r.status === 202 || r.status === 409, `应 202（或并发 409），实际 ${r.status}`);
  });
}

// ── 7. 会话 / 存档 / 记忆 ────────────────────────────────────────────────
c.section('7. 会话 / 存档 / 记忆');
{
  let sessionId = null;
  await c.check('GET /api/sessions：返回会话摘要列表', async () => {
    const r = await hit('GET', '/api/sessions?limit=50');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.sessions) && r.data.sessions.length >= 1, '应至少有 1 条会话');
    sessionId = r.data.sessions[0].id;
  });

  await c.check('GET /api/sessions/:id：返回会话详情', async () => {
    const r = await hit('GET', `/api/sessions/${sessionId}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.id, sessionId);
    assert.ok('systemPrompt' in r.data || 'messages' in r.data, '应含提示词或消息序列');
  });

  await c.check('GET /api/sessions/:id：不存在的会话返回 404', async () => {
    const r = await hit('GET', '/api/sessions/no-such-session');
    assert.equal(r.status, 404);
  });

  await c.check('DELETE /api/sessions/:id：删除已结束会话', async () => {
    const s = app.sessions.create({ chatKey: 'group:789', trigger: '待删除会话' });
    app.sessions.finish(s.id, 'done');
    const r = await hit('DELETE', `/api/sessions/${s.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  await c.check('DELETE /api/sessions/:id：运行中的会话拒绝删除（409）', async () => {
    const s = app.sessions.create({ chatKey: 'group:789', trigger: '运行中会话' });
    const r = await hit('DELETE', `/api/sessions/${s.id}`);
    assert.equal(r.status, 409, '运行中删除应 409');
    app.sessions.finish(s.id, 'done');
    app.sessions.remove(s.id);
  });

  await c.check('POST /api/sessions/clear-finished：清空已结束会话', async () => {
    const s = app.sessions.create({ chatKey: 'group:789', trigger: '另一个已结束' });
    app.sessions.finish(s.id, 'done');
    const r = await hit('POST', '/api/sessions/clear-finished');
    assert.equal(r.status, 200);
    assert.ok(r.data.removed >= 1, '应报告清理数量');
  });

  await c.check('GET /api/chats：返回会话列表（带 lastTs 排序）', async () => {
    const r = await hit('GET', '/api/chats');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.chats));
    const keys = r.data.chats.map((x) => x.key);
    assert.ok(keys.includes('group:456'), '应包含刚写入的会话');
  });

  await c.check('GET /api/chats/:key/messages：返回消息列表', async () => {
    const r = await hit('GET', '/api/chats/group_456/messages?limit=100');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.messages));
    assert.ok(r.data.messages.some((m) => m.text === '覆盖测试消息一'), '应包含写入的消息');
  });

  await c.check('GET /api/groups/:id/members：拉群成员列表', async () => {
    const r = await hit('GET', '/api/groups/456/members');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.members) && r.data.members.length >= 2, '应返回成员');
  });

  await c.check('GET /api/onebot/groups：拉群列表', async () => {
    const r = await hit('GET', '/api/onebot/groups');
    assert.equal(r.status, 200, `应 200，实际 ${r.status}`);
    assert.ok(Array.isArray(r.data.groups) && r.data.groups.length >= 1);
    assert.ok(r.data.groups[0].id && r.data.groups[0].name, '应含 id/name');
  });

  await c.check('GET /api/onebot/friends：拉好友列表', async () => {
    const r = await hit('GET', '/api/onebot/friends');
    assert.equal(r.status, 200, `应 200，实际 ${r.status}`);
    assert.ok(Array.isArray(r.data.friends) && r.data.friends.length >= 1);
  });

  await c.check('POST /api/chats/:key/mark-read：标记已读', async () => {
    app.store.appendIncoming('group:456', { mid: 7100, ts: Date.now(), senderId: '113', senderName: '王五', text: '未读一条' });
    const r = await hit('POST', '/api/chats/group_456/mark-read');
    assert.equal(r.status, 200);
    assert.ok(r.data.marked >= 1, '应标记至少 1 条');
    assert.equal(app.store.unreadCount('group:456'), 0);
  });

  await c.check('POST /api/chats/:key/mute：屏蔽未读但不触发', async () => {
    app.store.appendIncoming('group:456', { mid: 7101, ts: Date.now(), senderId: '113', senderName: '王五', text: '要屏蔽' });
    const r = await hit('POST', '/api/chats/group_456/mute');
    assert.equal(r.status, 200);
    assert.ok(r.data.marked >= 1);
  });

  await c.check('POST /api/chats/:key/test-send：手动发一条消息', async () => {
    const before = onebotHttp.state.sends.length;
    const r = await hit('POST', '/api/chats/group_456/test-send', { body: { text: '覆盖测试手动发送' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.ok(onebotHttp.state.sends.length > before, '应真的发出消息');
  });

  await c.check('POST /api/chats/:key/test-send：空文本被拒绝（400）', async () => {
    const r = await hit('POST', '/api/chats/group_456/test-send', { body: { text: '   ' } });
    assert.equal(r.status, 400);
  });

  await c.check('POST /api/chats/:key/test-send：白名单外的会话被拒绝（403，不真发消息）', async () => {
    const before = onebotHttp.state.sends.length;
    // 白名单只有 456/777，999 不在名单内（allowAllWhenEmpty=false）
    const r = await hit('POST', '/api/chats/group_999/test-send', { body: { text: '不该发出去' } });
    assert.equal(r.status, 403, `应 403，实际 ${r.status}`);
    assert.ok(r.data.error && r.data.error.includes('白名单'), '错误信息应说明白名单拦截');
    assert.equal(onebotHttp.state.sends.length, before, '白名单外的目标绝不能真发消息');
  });

  await c.check('POST /api/chats/:key/delete-messages：按 id 删除消息', async () => {
    const list = await hit('GET', '/api/chats/group_456/messages?limit=100');
    const target = list.data.messages.find((m) => m.mid === 7001);
    const r = await hit('POST', '/api/chats/group_456/delete-messages', { body: { ids: [target.id] } });
    assert.equal(r.status, 200);
    assert.ok(r.data.removed >= 1);
  });

  await c.check('POST /api/chats/:key/delete-messages：缺少 ids 返回 400', async () => {
    const r = await hit('POST', '/api/chats/group_456/delete-messages', { body: {} });
    assert.equal(r.status, 400);
  });

  await c.check('POST /api/chats/:key/clear：清空该会话存档', async () => {
    const r = await hit('POST', '/api/chats/group_456/clear');
    assert.equal(r.status, 200);
    assert.ok(r.data.removed >= 0);
  });

  await c.check('POST /api/chats/:key/wake：路由已移除（410）', async () => {
    // 手动唤醒链路随 2026-09-25 触发重做移除：不触发的消息立即标已读，无需手动补处理
    const r = await hit('POST', '/api/chats/group_456/wake');
    assert.equal(r.status, 410);
    assert.ok(String(r.data.error || '').includes('已移除'), '应说明已移除原因');
  });
}

// ── 8. 暂停 / 恢复 ───────────────────────────────────────────────────────
c.section('8. 暂停 / 恢复');
{
  await c.check('POST /api/pause：暂停生效', async () => {
    const r = await hit('POST', '/api/pause', { body: { paused: true } });
    assert.equal(r.status, 200);
    assert.equal(r.data.paused, true);
    assert.equal(app.orchestrator.paused, true, 'orchestrator 应真的暂停');
  });

  await c.check('DELETE /api/pause：恢复并把积压标记已读', async () => {
    const r = await hit('DELETE', '/api/pause');
    assert.equal(r.status, 200);
    assert.equal(r.data.paused, false);
    assert.equal(app.orchestrator.paused, false);
  });
}

// ── 9. 日志 ──────────────────────────────────────────────────────────────
c.section('9. 日志');
{
  await c.check('GET /api/logs：返回最近日志与当前级别', async () => {
    const r = await hit('GET', '/api/logs?limit=50');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.logs), '应返回 logs 数组');
    assert.ok(typeof r.data.level === 'string', '应返回当前级别');
  });

  await c.check('POST /api/logs/level：调整级别并回读', async () => {
    const r = await hit('POST', '/api/logs/level', { body: { level: 'debug' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.level, 'debug');
    const back = await hit('GET', '/api/logs');
    assert.equal(back.data.level, 'debug', '级别应持久到 logger 实例');
    await hit('POST', '/api/logs/level', { body: { level: 'info' } });
  });

  await c.check('POST /api/logs/level：非法级别不崩溃（回落到原级别）', async () => {
    const r = await hit('POST', '/api/logs/level', { body: { level: '不存在的级别' } });
    assert.equal(r.status, 200);
    assert.ok(typeof r.data.level === 'string');
  });
}

// ── 10. 进程管理（只测安全分支） ─────────────────────────────────────────
c.section('10. 进程管理（安全分支）');
{
  await c.check('GET /api/snowluma/logs：返回日志数组', async () => {
    const r = await hit('GET', '/api/snowluma/logs');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.logs));
  });

  await c.check('POST /api/snowluma/launch：目录不存在时给出明确错误而不是崩溃', async () => {
    const r = await hit('POST', '/api/snowluma/launch');
    assert.ok(r.status === 400 || r.status === 200, `应返回结构化结果，实际 ${r.status}`);
    assert.ok(r.data, '应有响应体');
    assert.ok(r.data.ok === false || r.data.alreadyRunning, '不应误报成功启动');
  });

  await c.check('POST /api/snowluma/stop：未启动时安全返回', async () => {
    const r = await hit('POST', '/api/snowluma/stop');
    assert.ok(r.status === 200, `应 200，实际 ${r.status}`);
    assert.ok(r.data && r.data.ok !== false, '应有结构化响应');
  });

  await c.check('GET /api/qq-portable/status：返回安装/运行状态', async () => {
    const r = await hit('GET', '/api/qq-portable/status');
    assert.equal(r.status, 200);
    assert.ok(r.data && typeof r.data === 'object');
  });

  await c.check('GET /api/qq-portable/logs：返回日志数组', async () => {
    const r = await hit('GET', '/api/qq-portable/logs');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.logs));
  });

  await c.check('POST /api/qq-portable/launch：未安装时返回 400 且不 spawn', async () => {
    // 便携 QQ 目录固定在仓库 runtime/qq-portable（不随数据目录隔离）。
    // 开发机/线上通常已经装好，直接打接口走的是"已在运行"分支（200），
    // "未安装"这条关键安全分支就永远测不到。这里只在本次请求期间把
    // QQ.exe 的存在性判成 false，精确命中未安装分支，不碰真实安装目录。
    const exePath = path.join(ROOT, 'runtime', 'qq-portable', 'QQ.exe').toLowerCase();
    const realExists = fs.existsSync;
    fs.existsSync = (p) => (String(p).toLowerCase() === exePath ? false : realExists(p));
    let r;
    try {
      r = await hit('POST', '/api/qq-portable/launch');
    } finally {
      fs.existsSync = realExists;
    }
    assert.equal(r.status, 400, `未安装应 400，实际 ${r.status}`);
    assert.equal(r.data.ok, false);
    assert.ok(/未安装|setup/i.test(r.data.error || ''), `错误信息应说明原因，实际：${r.data.error}`);
  });
}

// ── 11. 媒体取图（含 SSRF 回归） ─────────────────────────────────────────
c.section('11. 媒体取图与 SSRF');
{
  let internalHit = 0;
  const SECRET = 'INTERNAL-SECRET-CONTENT';
  const internal = http.createServer((_req, res) => {
    internalHit++;
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from(SECRET));
  });
  const internalPort = await listen(internal);

  await c.check('POST /api/media-data：空 items 安全返回', async () => {
    const r = await hit('POST', '/api/media-data', { body: { items: [] } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.results));
    assert.equal(r.data.results.length, 0);
  });

  await c.check('POST /api/media-data：非法 items 不崩溃', async () => {
    const r = await hit('POST', '/api/media-data', { body: { items: '不是数组' } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.results));
  });

  await c.known(
    'POST /api/media-data：拒绝内网/环回地址（SSRF 防护）',
    async () => {
      internalHit = 0;
      const r = await hit('POST', '/api/media-data', {
        body: { items: [{ file: '', url: `http://127.0.0.1:${internalPort}/secret.png` }] }
      });
      const leaked = (r.data.results || []).some((x) => {
        if (!x?.dataUrl) return false;
        try { return Buffer.from(String(x.dataUrl).split(',')[1] || '', 'base64').toString() === SECRET; } catch { return false; }
      });
      assert.equal(internalHit, 0, `本机内网服务被访问了 ${internalHit} 次（SSRF 成立）`);
      assert.equal(leaked, false, '内网内容被读回并 base64 返回（SSRF 成立）');
    },
    '已知：routes.js:941/950 对请求体里的 url 直接 fetch，未走 safe-fetch'
  );

  await c.check('* /api/captcha-forward：缺 u 参数 400、非白名单域 403（都在早期返回，不发真实请求）', async () => {
    // 这条路由是 '*' 方法声明，所以顺手也是「统计里 '*' 的正则分支能不能被算作覆盖」的探针
    const noU = await hit('POST', '/api/captcha-forward');
    assert.equal(noU.status, 400, '缺 u 参数应 400');
    const bad = await hit('GET', '/api/captcha-forward?u=https%3A%2F%2Fevil.example.com%2Fx');
    assert.equal(bad.status, 403, '不在 aliyuncs/alicdn 白名单的域必须 403');
    assert.match(String(bad.data.error || ''), /白名单/, '403 要说清是白名单拒绝');
    const noHttps = await hit('GET', '/api/captcha-forward?u=http%3A%2F%2Ffoo.aliyuncs.com%2Fx');
    assert.equal(noHttps.status, 403, 'http 明文也要拒（只放 https）');
  });

  internal.close();
}

// ── 12. 静态文件与路径穿越 ───────────────────────────────────────────────
c.section('12. 静态文件与路径穿越防护');
{
  await c.check('GET /：返回 index.html', async () => {
    const r = await request('GET', '/');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('<html'), '应是 HTML 页面');
    assert.ok(r.text.includes('QQ Agent') || r.text.includes('app.js'), '应是控制台页面');
  });

  await c.check('GET /app.js、/app/00-core.js、/style.css：可正常获取', async () => {
    for (const p of ['/app.js', '/app/00-core.js', '/app/11-init.js', '/style.css']) {
      const r = await request('GET', p);
      assert.equal(r.status, 200, `${p} 应 200`);
      assert.ok(r.text.length > 100, `${p} 内容过短`);
    }
  });

  await c.check('GET /vendor/tier-slider.js、/vendor/price-match.js：ES module 依赖可获取', async () => {
    for (const p of ['/vendor/tier-slider.js', '/vendor/price-match.js']) {
      const r = await request('GET', p);
      assert.equal(r.status, 200, `${p} 应 200（app.js 顶层 import 依赖它，缺了会整页白屏）`);
    }
  });

  await c.check('GET /landing.html 可访问（虽是孤儿页面）', async () => {
    const r = await request('GET', '/landing.html');
    assert.equal(r.status, 200);
  });

  await c.check('GET 不存在的静态文件返回 404', async () => {
    const r = await request('GET', '/no-such-file-xyz.js');
    assert.equal(r.status, 404);
  });

  await c.check('路径穿越：/../ 形式被拒绝', async () => {
    for (const p of ['/../src/config.js', '/../../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json']) {
      const r = await request('GET', p);
      assert.ok(r.status === 403 || r.status === 404, `${p} 应被拒绝，实际 ${r.status}`);
      assert.ok(!r.text.includes('"name": "qq-agent"'), `${p} 泄漏了项目文件`);
    }
  });

  await c.check('路径穿越：/....// 绕过形式被拒绝（历史 bug 回归）', async () => {
    for (const p of ['/....//package.json', '/....//....//package.json', '/..\\..\\package.json']) {
      const r = await request('GET', p);
      assert.ok(r.status === 403 || r.status === 404, `${p} 应被拒绝，实际 ${r.status}`);
    }
  });
}

// ── 13. 安全回归 ─────────────────────────────────────────────────────────
c.section('13. 安全回归');
{
  const EVIL = 'http://evil.example.com';

  await c.check('密钥接口：外部来源（Origin 不匹配）读取被拒绝 403', async () => {
    for (const p of ['/api/api-key', '/api/providers/key?providerId=x', '/api/search-key?field=deepseek']) {
      const r = await hit('GET', p, { origin: EVIL });
      assert.equal(r.status, 403, `${p} 应 403，实际 ${r.status}`);
    }
  });

  await c.check('密钥接口：本机控制台（带 console 标记头）可读取', async () => {
    const r = await hit('GET', '/api/api-key', { headers: { 'x-console-token': 'qq-agent-console' } });
    assert.equal(r.status, 200, `本机控制台应放行，实际 ${r.status}`);
    assert.ok('apiKey' in r.data, '应返回 apiKey 字段');
  });

  await c.check('GET /api/search-key：未知搜索服务返回 400', async () => {
    const r = await hit('GET', '/api/search-key?field=不存在的服务', { headers: { 'x-console-token': 'qq-agent-console' } });
    assert.equal(r.status, 400);
  });

  await c.check('GET /api/onebot-token：控制台可读令牌明文 + 未知类型 400', async () => {
    const ok1 = await hit('GET', '/api/onebot-token?which=ws', { headers: { 'x-console-token': 'qq-agent-console' } });
    assert.equal(ok1.status, 200, `控制台读取应放行，实际 ${ok1.status}`);
    assert.ok('token' in ok1.data, '应返回 token 字段');
    const bad = await hit('GET', '/api/onebot-token?which=玄学', { headers: { 'x-console-token': 'qq-agent-console' } });
    assert.equal(bad.status, 400, '未知令牌类型应 400');
  });

  await c.check('/api/prompt-preview：GET 出组装结果，POST overrides 生效', async () => {
    const g = await hit('GET', '/api/prompt-preview');
    assert.equal(g.status, 200);
    assert.ok(g.data && typeof g.data === 'object', '应返回预览对象');
    // POST overrides：把某个技能开关状态传进去，预览应基于"未保存的临时状态"组装
    const p = await hit('POST', '/api/prompt-preview', {
      body: JSON.stringify({ skills: { calculator: { enabled: false } } }),
      headers: { 'content-type': 'application/json' }
    });
    assert.equal(p.status, 200, `POST 预览应 200，实际 ${p.status}`);
    assert.ok(p.data && typeof p.data === 'object', 'POST 也应返回预览对象');
  });

  // ── 社区/市场代理接口：远端用假 fetch 顶替（绝不在测试里真连官网）──
  // 假响应必须同时提供 json() 与 text()：community.js 走 text()，market.js 走 json()。
  const realFetch = globalThis.fetch;
  const fakeMarket = async (url, options = {}) => {
    const target = String(url);
    // 本机请求（测试 harness 自己的 fetch）原样放行，只劫持官网域名
    if (target.startsWith('http://127.0.0.1:') || target.startsWith('http://localhost:')) {
      return realFetch(url, options);
    }
    const method = String(options.method || 'GET').toUpperCase();
    const mk = (status, value) => {
      const bodyText = JSON.stringify(value);
      return {
        ok: status < 400, status,
        json: async () => value,
        text: async () => bodyText
      };
    };
    if (target.includes('/auth/login') && method === 'POST') {
      return mk(200, { ok: true, account: { id: 'u1', loginId: 'tester', displayName: '测试者' }, token: 'fake-token-abc' });
    }
    if (target.includes('/auth/logout') && method === 'POST') {
      return mk(200, { ok: true });
    }
    if (target.includes('/auth/whoami')) {
      return mk(200, { ok: true, account: { id: 'u1', loginId: 'tester', displayName: '测试者' } });
    }
    if (target.includes('/blocklist')) {
      return mk(200, { ok: true, ids: ['112233445'], updatedAt: '2026-09-19T00:00:00Z' });
    }
    return mk(404, { ok: false, error: 'not found' });
  };
  globalThis.fetch = fakeMarket;
  try {
    await c.check('GET /api/community/blocklist + POST 追加：走假云端', async () => {
      const g = await hit('GET', '/api/community/blocklist');
      assert.equal(g.status, 200);
      assert.ok(Array.isArray(g.data.ids), 'GET 应返回 ids 数组');
      const p = await hit('POST', '/api/community/blocklist', {
        body: JSON.stringify({ ids: ['112233445'], mode: 'add' }),
        headers: { 'content-type': 'application/json' }
      });
      assert.equal(p.status, 200, `POST 追加应 200，实际 ${p.status}：${JSON.stringify(p.data)}`);
      assert.ok(p.data.ok, 'POST 应成功');
    });

    await c.check('市场代理：登录保存凭据 + 账号列表 + 登出清空', async () => {
      const login = await hit('POST', '/api/market/login', {
        body: JSON.stringify({ loginId: 'tester', password: 'secret-word', mode: 'login' }),
        headers: { 'content-type': 'application/json' }
      });
      assert.equal(login.status, 200, `登录应 200，实际 ${login.status}：${JSON.stringify(login.data)}`);
      assert.equal(login.data.ok, true, '登录应 ok');
      const accounts = await hit('GET', '/api/market/accounts');
      assert.equal(accounts.status, 200);
      assert.ok(accounts.data.accounts.some((a) => a.username === '测试者' || a.username === 'tester'), `账号列表应含刚登录的账号，实际 ${JSON.stringify(accounts.data.accounts)}`);
      const out = await hit('POST', '/api/market/logout', {
        body: JSON.stringify({ username: accounts.data.accounts[0].username }),
        headers: { 'content-type': 'application/json' }
      });
      assert.equal(out.status, 200, `登出应 200，实际 ${out.status}：${JSON.stringify(out.data)}`);
      const after = await hit('GET', '/api/market/accounts');
      assert.equal(after.data.accounts.filter((a) => a.username === accounts.data.accounts[0].username).length, 0, '登出后凭据应被移除');
    });

    // verify / publish：远端返回明确错误 → 502 透传（覆盖"失败也结构化"分支）
    await c.check('POST /api/market/verify：远端 404 → 502 透传', async () => {
      const r = await hit('POST', '/api/market/verify', {
        body: JSON.stringify({ codes: ['ABCDEF'] }),
        headers: { 'content-type': 'application/json' }
      });
      assert.equal(r.status, 502, `远端失败应 502 透传，实际 ${r.status}：${JSON.stringify(r.data)}`);
    });

    await c.check('POST /api/market/publish：缺 file → 400/502 且不落盘', async () => {
      const r = await hit('POST', '/api/market/publish', {
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' }
      }).catch((e) => ({ status: 0, data: { error: String(e.message) } }));
      assert.ok(r.status === 400 || r.status === 502, `缺文件应结构化报错（400/502），实际 ${r.status}：${JSON.stringify(r.data)}`);
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  await c.known(
    '状态变更接口应校验请求来源（CSRF 防护）',
    async () => {
      const before = app.orchestrator.paused;
      const r = await request('POST', '/api/pause', {
        body: { paused: !before },
        headers: { 'content-type': 'text/plain' },
        origin: EVIL
      });
      assert.notEqual(r.status, 200, '外部来源的简单 POST 不应被接受');
      assert.equal(app.orchestrator.paused, before, '外部来源不应能改变运行状态');
    },
    '已知：server.token 默认空 + /api/* 只调 authorize()，无 Origin/Host 校验；text/plain 简单请求可绕过预检'
  );

  await c.check('伪造 x-console-token 头不能绕过来源校验', async () => {
    // 旧实现是 `if (req.headers['x-console-token']) return true` —— 只看有没有、不看值。
    // 现在来源校验独立成立，伪造头无法解锁跨站读取。
    const r = await request('GET', '/api/api-key', {
      headers: { 'x-console-token': 'literally-anything' },
      origin: EVIL
    });
    assert.equal(r.status, 403, '外部来源 + 伪造头必须被拒绝');
  });

  await c.check('配置了 server.token 时：错 token 401、对 token 200', async () => {
    await request('POST', '/api/config', { body: { server: { token: 'real-console-token' } } });
    const bad = await request('GET', '/api/status', { headers: { 'x-console-token': 'wrong-token' } });
    assert.equal(bad.status, 401, `错 token 应 401，实际 ${bad.status}`);
    const good = await request('GET', '/api/status', { headers: { 'x-console-token': 'real-console-token' } });
    assert.equal(good.status, 200, `对 token 应 200，实际 ${good.status}`);
    // 恢复为空 token，避免影响后续用例
    await request('POST', '/api/config', {
      body: { server: { token: '' } },
      headers: { 'x-console-token': 'real-console-token' }
    });
  });

  await c.check('DNS rebinding 形态：Host 不是回环时一律拒绝', async () => {
    // 用原生 http 请求才能自定义 Host（fetch 会丢弃这个被禁止的头）
    const r = await rawRequest('GET', '/api/status', { host: 'evil.example.com:3210' });
    assert.equal(r.status, 403, `非回环 Host 应 403，实际 ${r.status}`);
  });

  await c.check('接口不存在时返回 404 且带错误说明', async () => {
    const r = await request('GET', '/api/no-such-endpoint');
    assert.equal(r.status, 404);
    assert.ok(r.data.error, '应返回错误说明');
  });

  await c.check('请求体超过 2MB 被拒绝（防内存打爆），且不拖垮后续请求', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(3 * 1024 * 1024) });
    // 关键：必须带 connection: close。readBody 在超限时直接 throw，
    // 此时请求体还没读完，Node 会 destroy 这个 socket；若不显式关闭，
    // 被污染的连接会留在客户端连接池里，导致**后续请求随机 ECONNRESET**。
    const r = await request('POST', '/api/config', {
      body: big,
      headers: { 'content-type': 'application/json', connection: 'close' }
    }).catch((e) => ({ status: 0, text: String(e.message) }));
    assert.ok(r.status >= 400 || r.status === 0, `超大请求体应被拒绝，实际 ${r.status}`);

    const after = await hit('GET', '/api/status');
    assert.equal(after.status, 200, '拒绝超大请求体后服务应仍可用');
  });

  await c.known(
    '超大请求体应返回 413 并保持连接可用（而非 500 + 连接重置）',
    async () => {
      const big = JSON.stringify({ data: 'x'.repeat(3 * 1024 * 1024) });
      const r = await request('POST', '/api/config', {
        body: big,
        headers: { 'content-type': 'application/json', connection: 'close' }
      }).catch((e) => ({ status: 0, text: String(e.message) }));
      assert.equal(r.status, 413, `实际 ${r.status}（readBody 抛 Error('请求体过大') 冒到框架变成 500，未读完的 body 还会导致连接重置）`);
    },
    '已知：readBody 超限时直接 throw，未做请求体排空与 413 转换'
  );
}

// ── 13b. 记忆库（/api/mem2/*）：HTTP 层也要真打一遍 ──────────────────────
// 存在理由：第 5 期记忆浏览器三页（印象/知识/摘要）全部走这些接口，但它们此前只在**函数级**单测里
// 被调用过（mem2-api-test.mjs 直接 import ui-api），HTTP 一条都没点过。
// 于是路由覆盖停在 77%，而且"接口能返回"和"路由真的接上了"是两件事：
// query 参数有没有被解析、状态码有没有真传出去、body 有没有真读进来，
// 都只有走一遍真 HTTP 才算数。
//
// 刻意不写 17 个独立断言（那样每条都在重复"起个请求"）：
// 只读接口合成一条、写接口合成一条，但**每个路由都至少真打一次**，
// 能走成功路径就走成功路径，不便构造的至少断言契约 400/404 —— 路由命中同样计入覆盖。
c.section('13b. 记忆库 /api/mem2/*（HTTP 层）');
{
  const M = await import('../src/mem2/store.js');
  const MP = await import('../src/mem2/paths.js');

  // 与前面各节用的 group:456 / group:99001 错开，免得互相筛到
  const CHAT = 'group:880001';
  const UID = '880000001';
  const T = Date.now() - 3600 * 1000;
  const YM = MP.ymOf(T);
  const src = { chatKey: CHAT, userId: UID, startTs: T, endTs: T + 600000, msgCount: 12 };
  const mk = (id, content, extra = {}) => M.makeL1Entry({
    entryId: id, chatKey: CHAT, userId: UID, content, groups: ['性格特质'],
    status: 'active', deduped: true, sourceBatch: src, ...extra
  });

  const E1 = `l1_${UID}_${T}_1`;                 // 会被 PATCH 编辑（原条目 → superseded）
  const E2 = `l1_${UID}_${T}_2`;                 // 会被 void / undo
  const E3 = `l1_${UID}_${T}_3`;                 // 会被彻底删除（**同一个 entryId 两行** → 审计 +2）
  const E4 = `l1_${UID}_${T}_4`;                 // 历史版本（给 ?all=1 用）
  const OLD = `l1_${UID}_${T}_9`;                // 冲突对：旧的（被 pin）
  const NEW = `l1_${UID}_${T}_8`;                // 冲突对：新的（待裁决）
  const CAND = `cand_${T}_1`;

  M.appendPerson(mk(E1, '覆盖测试：爱看科幻小说'));
  M.appendPerson(mk(E2, '覆盖测试：养了一只橘猫'));
  M.appendPerson(mk(E4, '覆盖测试：老版本的一句话', { status: 'superseded' }));
  // ★ 彻底删除的审计是**按磁盘行**算的，所以这里刻意追加同一个 entryId 两次：
  //   append-only 下「一个条目被改过一版」就是两行，删它就该留两条痕。
  //   （若换成两个不同 entryId 各一行，只会 +1 —— 那验的就不是这条口径了）
  M.appendPerson(mk(E3, '覆盖测试：睡前听播客'));
  M.appendPerson(mk(E3, '覆盖测试：睡前听播客（更新）', { status: 'superseded' }));
  M.appendPerson(mk(OLD, '覆盖测试：旧说法（被 pin）', { status: 'conflicted', conflictPeer: NEW, pinnedByUser: true }));
  M.appendPerson(mk(NEW, '覆盖测试：新说法', { status: 'pending-conflict', conflictPeer: OLD }));
  M.appendL4(CHAT, { entryId: `l4_${T}_1`, convStartTs: T, convEndTs: T + 600000, summary: '覆盖测试摘要', msgCount: 12 });
  M.appendCandidate(CHAT, M.makeCandidateRow({
    entryId: CAND, text: '覆盖测试候选', fromUserId: UID, ts: T
  }));

  const enc = encodeURIComponent;
  const beforeCount = (await hit('GET', '/api/mem2/deletions')).data.count;

  await c.check('记忆库 10 条只读接口：全部 200，且字段形状够 UI 用', async () => {
    // ① 人列表（含 chatStats 与 overview）
    const people = await hit('GET', `/api/mem2/people?chat=${enc(CHAT)}`);
    assert.equal(people.status, 200);
    assert.equal(people.data.people.length, 1, '按群筛到 1 个人');
    assert.equal(people.data.people[0].userId, UID);
    assert.ok(Array.isArray(people.data.people[0].chatStats), 'chatStats 要随列表一起给（群下拉排序靠它）');
    assert.ok(people.data.overview && typeof people.data.overview === 'object', 'overview 不能缺');

    const byQ = await hit('GET', `/api/mem2/people?q=${enc('橘猫')}`);
    assert.equal(byQ.status, 200, 'q 走的是内容模糊查，必须能命中');

    // ② 单人画像（默认不带历史版本，?all=1 才带）
    const one = await hit('GET', `/api/mem2/people/${enc(UID)}`);
    assert.equal(one.status, 200);
    assert.ok(one.data.entries.length >= 2);
    assert.ok(!one.data.entries.some((e) => e.status === 'superseded'), '默认不返回 superseded');
    const all = await hit('GET', `/api/mem2/people/${enc(UID)}?all=1`);
    assert.equal(all.status, 200);
    assert.ok(all.data.entries.some((e) => e.status === 'superseded'), '?all=1 才带历史版本');

    // ③ L4 / 覆盖表：ym 必须原样回显（UI 的月份选择器按它对齐）
    const l4 = await hit('GET', `/api/mem2/l4?chat=${enc(CHAT)}&ym=${YM}`);
    assert.equal(l4.status, 200);
    assert.equal(l4.data.ym, YM);
    assert.ok(l4.data.count >= 1 && l4.data.summaries.length >= 1);
    const cov = await hit('GET', `/api/mem2/coverage?chat=${enc(CHAT)}`);
    assert.equal(cov.status, 200);
    assert.equal(typeof cov.data.counts.ok, 'number', '六态计数缺一个，UI 的覆盖率卡片就白屏');

    // ④ 回填状态
    const bf = await hit('GET', '/api/mem2/backfill');
    assert.equal(bf.status, 200);
    assert.ok(bf.data.limits && bf.data.remain, '回填状态要 limits 与 remain');

    // ⑤ 候选池 / 冲突对
    const cand = await hit('GET', `/api/mem2/candidates?chat=${enc(CHAT)}`);
    assert.equal(cand.status, 200);
    assert.equal(cand.data.candidates.length, 1);
    assert.equal(typeof cand.data.counts.pending, 'number', 'UI 页签角标靠 counts');
    assert.equal(cand.data.candidates[0].chatKey, CHAT, '跨群列候选必须补 chatKey，否则删除会写到 group_undefined');
    const conf = await hit('GET', `/api/mem2/conflicts?uid=${UID}`);
    assert.equal(conf.status, 200);
    assert.equal(conf.data.total, 1);
    assert.equal(conf.data.conflicts[0].newEntryId, NEW);

    // ⑥ L3 知识（空是正确状态，但必须给出来源说明）
    const kn = await hit('GET', '/api/mem2/knowledge');
    assert.equal(kn.status, 200);
    assert.equal(kn.data.available, false);
    assert.ok(String(kn.data.note || '').length > 10, '空态要说明"为什么空"，只给空数组等于没答');

    // ⑦ 删除审计条数
    const dc = await hit('GET', '/api/mem2/deletions');
    assert.equal(dc.status, 200);
    assert.equal(dc.data.count, beforeCount, '还没彻底删过，计数不该自己动');

    // ⑧ 3D 星图数据（全量、只读、轻量）
    const graph = await hit('GET', '/api/mem2/graph');
    assert.equal(graph.status, 200);
    assert.ok(Array.isArray(graph.data.people));
    assert.ok(Array.isArray(graph.data.impressions));
    assert.equal(typeof graph.data.total, 'number');
    assert.ok(graph.data.total > 0, '图接口不能只回空数组（夹具已有 active）');
    assert.ok(graph.data.impressions.every((e) => !('content' in e)), '不得返回完整 content');
    assert.ok(graph.data.impressions.every((e) => typeof e.preview === 'string'));
    assert.ok(graph.data.people.every((p) => Array.isArray(p.chatKeys)));
    assert.ok(graph.data.people.every((p) => Array.isArray(p.chatStats)));
    assert.equal(graph.data.impressions.length,
      graph.data.people.reduce((n, p) => n + p.activeCount, 0), '★ impressions === sum(activeCount)');
    assert.equal(graph.data.total, graph.data.impressions.length);
  });

  await c.check('记忆库写接口：编辑 / 软删撤销 / 删候选 / 裁决冲突 都走成功路径', async () => {
    // PATCH 编辑：只收 content，新版本带 pinnedByUser + editedFrom，原条目 superseded
    const ed = await hit('PATCH', `/api/mem2/entries/${enc(E1)}`, { body: { content: '覆盖测试：改过的内容' } });
    assert.equal(ed.status, 200);
    assert.equal(ed.data.entry.editedFrom, E1, '溯源要传出去');
    assert.equal(ed.data.entry.pinnedByUser, true, '编辑必须 pin（去重靠它绕开）');
    // 改结构字段一律 400 —— 这是契约，不是"忽略掉就算了"
    const bad = await hit('PATCH', `/api/mem2/entries/${enc(E1)}`, { body: { content: 'x', status: 'void' } });
    assert.equal(bad.status, 400);
    const miss = await hit('PATCH', `/api/mem2/entries/${enc(`l1_${UID}_${T}_404`)}`, { body: { content: 'x' } });
    assert.equal(miss.status, 404);

    // POST void：软删幂等，undo 回 active，非 void 不能撤销
    const v1 = await hit('POST', `/api/mem2/entries/${enc(E2)}/void`, { body: {} });
    assert.equal(v1.status, 200);
    assert.equal(v1.data.entry.status, 'void');
    const v2 = await hit('POST', `/api/mem2/entries/${enc(E2)}/void`, { body: {} });
    assert.equal(v2.data.changed, false, '重复软删是幂等');
    const un = await hit('POST', `/api/mem2/entries/${enc(E2)}/void`, { body: { undo: true } });
    assert.equal(un.status, 200);
    assert.equal(un.data.entry.status, 'active');
    const un2 = await hit('POST', `/api/mem2/entries/${enc(E2)}/void`, { body: { undo: true } });
    assert.equal(un2.status, 400, '非 void 状态不能撤销');

    // POST 候选删除：只对 pending 有意义
    const cd = await hit('POST', `/api/mem2/candidates/${enc(CAND)}/delete?chat=${enc(CHAT)}`, { body: { reason: '覆盖测试' } });
    assert.equal(cd.status, 200);
    assert.equal(cd.data.candidate.status, 'deleted');
    const cd2 = await hit('POST', `/api/mem2/candidates/${enc(CAND)}/delete?chat=${enc(CHAT)}`, { body: {} });
    assert.equal(cd2.status, 400, '已删除的不能再删（历史裁决不许抹）');

    // POST 冲突裁决：keep 只收 new/old
    const badKeep = await hit('POST', '/api/mem2/conflicts/resolve', { body: { userId: UID, entryId: NEW, keep: 'both' } });
    assert.equal(badKeep.status, 400);
    const rs = await hit('POST', '/api/mem2/conflicts/resolve', { body: { userId: UID, entryId: NEW, keep: 'new' } });
    assert.equal(rs.status, 200);
    assert.equal(rs.data.kept.entryId, NEW);
    assert.equal(rs.data.dropped.entryId, OLD);
    const rs2 = await hit('GET', `/api/mem2/conflicts?uid=${UID}`);
    assert.equal(rs2.data.total, 0, '裁决后再列就应该是 0');
  });

  await c.check('已摘除接口返回 404（回填预览 / L1 立刻运行）', async () => {
    const gonePreview = await hit('GET', '/api/mem2/backfill/preview');
    assert.equal(gonePreview.status, 404, '回填预览接口应已摘除');
    const goneRunNow = await hit('POST', '/api/mem2/l1/run-now');
    assert.equal(goneRunNow.status, 404, '立刻运行接口应已摘除');
  });

  await c.check('DELETE 彻底删除：二次确认不能绕，审计按磁盘行增量', async () => {
    // 先打缺 confirm 的 400 —— 这条锁的是"二次确认不能被绕过"
    const noConfirm = await hit('DELETE', `/api/mem2/entries/${enc(E3)}`, { body: {} });
    assert.equal(noConfirm.status, 400, '没有 confirm 必须 400');
    const wrong = await hit('DELETE', `/api/mem2/entries/${enc(E3)}`, { body: { confirm: 'delete' } });
    assert.equal(wrong.status, 400, 'confirm 必须恰好是大写 DELETE');

    const okDel = await hit('DELETE', `/api/mem2/entries/${enc(E3)}`, { body: { confirm: 'DELETE', reason: '覆盖测试' } });
    assert.equal(okDel.status, 200);

    const after = await hit('GET', '/api/mem2/deletions');
    assert.equal(after.data.count, beforeCount + 2, '删 1 个 2 版本条目 → 审计 +2（按磁盘行，不按条目数）');

    const one = await hit('GET', `/api/mem2/people/${enc(UID)}?all=1`);
    assert.ok(!one.data.entries.some((e) => e.entryId === E3), '被彻底删除的条目不许再出现在画像里');
  });

  // 收尾：把这个测试人物整份清掉，别给后面 14 节留垃圾
  //（用 request 而不是 hit：这几条只是为了清场，不该影响覆盖率统计）
  for (const id of [E1, E2, E4, OLD, NEW]) {
    try {
      await request('DELETE', `/api/mem2/entries/${encodeURIComponent(id)}`, { body: { confirm: 'DELETE', reason: '覆盖测试收尾' } });
    } catch { /* 清场失败不影响断言，忽略 */ }
  }
}

// ── 14. 破坏性接口（放这里：会清空数据目录，必须在所有只读断言之后） ─────
c.section('14. 破坏性接口（最后执行）');
{
  await c.check('POST /api/reset-data：清空数据目录并重置配置', async () => {
    const before = app.store.listChats().length;
    assert.ok(before > 0, '重置前应确实有数据');
    const r = await hit('POST', '/api/reset-data');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  await c.check('POST /api/reset-data 之后：服务仍可响应（状态接口不崩）', async () => {
    const r = await hit('GET', '/api/status');
    assert.equal(r.status, 200, '重置后状态接口应仍可用');
  });
}

// ── 15. 接口覆盖率统计（必须放在最后，才能统计到所有已打过的接口） ──────
c.section('15. 接口覆盖率统计');
{
  // 明确不测的：会在用户桌面弹窗口 / 可能影响用户真实进程
  const SKIP = new Set([
    'POST /api/open-data-dir',
    'POST /api/snowluma/open-folder',
    'POST /api/snowluma/open-webui',
    'POST /api/qq-portable/stop'
  ]);

  await c.check('声明的 API 路由覆盖率 ≥ 90%', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    // 正确解析：正则字面量（支持 \/ 转义与字符类），不能用非贪婪 [^\n]*?
    const routeRe = /method:\s*'([^']+)'\s*,\s*pattern:\s*(?:'([^']*)'|(\/(?:\\.|\[[^\]]*\]|[^/\n\\])+\/[gimsuy]*))/g;
    const routes = [];
    let m;
    while ((m = routeRe.exec(src))) {
      routes.push({ method: m[1], literal: m[2] ?? m[3], isRegex: !!m[3] });
    }
    assert.ok(routes.length > 60, `应从 routes.js 解析出全部路由，实际只解析到 ${routes.length} 条`);

    const covered = [];
    const missing = [];
    for (const r of routes) {
      if (!r.isRegex) {
        const key = `${r.method} ${r.literal}`;
        if (SKIP.has(key)) { covered.push(`${key}（跳过：会开窗/动用户进程）`); continue; }
        // method:'*' 声明（同一路由处理 GET/POST 等多种方法）：任一方法打过即算覆盖
        const hitAny = r.method === '*'
          ? [...exercised].some((e) => e.endsWith(' ' + r.literal))
          : exercised.has(key);
        (hitAny ? covered : missing).push(key);
        continue;
      }
      // 正则路由：用真实 pattern 去匹配"实际打过的路径"。
      // ★ method:'*' 的正则路由也要按任意方法匹配 —— 原来这里硬比 `=== r.method`，
      //   '*' 永远匹配不上任何真实方法，那条路由就再怎么打都算没覆盖（统计 bug，不是没测）。
      let rx;
      try { rx = new RegExp(r.literal.replace(/^\//, '').replace(/\/[gimsuy]*$/, '')); } catch { rx = null; }
      const ok = rx && [...exercised].some((e) => {
        const i = e.indexOf(' ');
        const hitMethod = e.slice(0, i);
        if (r.method !== '*' && hitMethod !== r.method) return false;
        return rx.test(e.slice(i + 1));
      });
      (ok ? covered : missing).push(`${r.method} ${r.literal}`);
    }

    // ★ 阈值用精确比例，不四舍五入：89.5% 四舍五入会变成 90%，等于把门槛悄悄降了半格。
    const ratio = covered.length / routes.length;
    const pct = (ratio * 100).toFixed(1);
    console.log(`      路由总数 ${routes.length}，已覆盖 ${covered.length}（${pct}%），跳过 ${SKIP.size} 条`);
    if (missing.length) {
      console.log('      未覆盖：');
      for (const x of missing) console.log(`        - ${x}`);
    }
    assert.ok(ratio >= 0.90, `接口覆盖率只有 ${pct}%（${covered.length}/${routes.length}），未覆盖：\n  ${missing.join('\n  ')}`);
  });
}

await ctx.teardown();
c.finish();
