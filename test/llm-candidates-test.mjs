// 补丁 1 / C1 回归：完全重复候选去重 + C2 反例矩阵 + 候选形状 + 端到端 fetch stub。
//
// C1 前提边界（必须保留）：keyOf(main) 是**配置级**去重；main = effectiveApi() 取 config.api。
// chatCompletion() 主路径还可能被 llm.endpoint-pick 和 visionModel 改写（src/llm.js:273-297）。
// 当前 visionModel=""、无 endpoint-pick 改写，C1 与运行时一致；将来设置专用视觉模型或启用
// 端点选择后，C1 可能删掉与"配置主模型"重复、但实际主模型已不同的 fallback，届时要重新评估，
// 不能把本单的 C1 当成通用保证。
//
// 配置注入：走内存态（setRuntimeConfig，config.js:715，纯内存不落盘），不用 env + 动态 import。
// 唯一约定：本文件不许调 updateConfig()（它会写盘）。
import assert from 'node:assert';
import { getConfig, setRuntimeConfig } from '../src/config.js';
import { buildCandidateApis, chatCompletionWithRetry } from '../src/llm.js';

const base = structuredClone(getConfig());

function makeCfg({ baseUrl, model, provider, fallbacks, providers }) {
  return {
    ...base,
    api: { ...base.api, baseUrl, model, provider, apiKey: 'test-key', fallbackModels: fallbacks },
    providers,
    dshProviderKeys: {}
  };
}

async function runWith(cfg, fn) {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  try {
    setRuntimeConfig(cfg);
    return { result: await fn(), warns };
  } finally {
    console.warn = origWarn;
    setRuntimeConfig(structuredClone(base));
  }
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  // 1. 完全重复：主模型与 fallback 同 model/provider/baseUrl → 候选数 1，且捕获跳过警告
  {
    const cfg = makeCfg({
      baseUrl: 'https://api.example.com', model: 'm1', provider: 'p1',
      fallbacks: [{ model: 'm1', provider: 'p1' }],
      providers: [{ id: 'p1', baseURL: 'https://api.example.com' }]
    });
    const { result: cs, warns } = await runWith(cfg, () => buildCandidateApis());
    assert.equal(cs.length, 1, '完全重复应只剩 1 个候选');
    assert.ok(warns.some((w) => w.includes('[llm] 跳过')), '应捕获 [llm] 跳过 警告');
    ok('完全重复 → 候选数 1，且捕获 [llm] 跳过');
  }

  // 2. 尾斜杠归一：provider 的 baseURL 比 api.baseUrl 多一个 / → 候选数 1
  {
    const cfg = makeCfg({
      baseUrl: 'https://api.example.com', model: 'm1', provider: 'p1',
      fallbacks: [{ model: 'm1', provider: 'p1' }],
      providers: [{ id: 'p1', baseURL: 'https://api.example.com/' }]
    });
    const { result: cs, warns } = await runWith(cfg, () => buildCandidateApis());
    assert.equal(cs.length, 1, '尾斜杠归一后应只剩 1 个候选');
    assert.ok(warns.some((w) => w.includes('[llm] 跳过')));
    ok('尾斜杠归一 → 候选数 1');
  }

  // 3. 不同 provider：同 model、同 baseUrl、两个 provider id → 候选数 2（守 keyOf 没漏 provider）
  {
    const cfg = makeCfg({
      baseUrl: 'https://a.example.com', model: 'm1', provider: 'p1',
      fallbacks: [{ model: 'm1', provider: 'p2' }],
      providers: [
        { id: 'p1', baseURL: 'https://a.example.com' },
        { id: 'p2', baseURL: 'https://a.example.com' }
      ]
    });
    const { result: cs } = await runWith(cfg, () => buildCandidateApis());
    assert.equal(cs.length, 2, '不同 provider 必须保留');
    ok('不同 provider → 候选数 2');
  }

  // 4. 不同 baseUrl：同 model、同 provider，端点 baseURL 与 api.baseUrl 不同 → 候选数 2
  {
    const cfg = makeCfg({
      baseUrl: 'https://a.example.com', model: 'm1', provider: 'p1',
      fallbacks: [{ model: 'm1', provider: 'p1' }],
      providers: [{ id: 'p1', baseURL: 'https://b.example.com' }]
    });
    const { result: cs } = await runWith(cfg, () => buildCandidateApis());
    assert.equal(cs.length, 2, '不同 baseUrl 必须保留');
    ok('不同 baseUrl → 候选数 2');
  }

  // 5. 不同 model → 候选数 2
  {
    const cfg = makeCfg({
      baseUrl: 'https://a.example.com', model: 'm1', provider: 'p1',
      fallbacks: [{ model: 'm2', provider: 'p1' }],
      providers: [{ id: 'p1', baseURL: 'https://a.example.com' }]
    });
    const { result: cs } = await runWith(cfg, () => buildCandidateApis());
    assert.equal(cs.length, 2, '不同 model 必须保留');
    ok('不同 model → 候选数 2');
  }

  // 6. 空 model 的 fallback 仍被跳过
  {
    const cfg = makeCfg({
      baseUrl: 'https://a.example.com', model: 'm1', provider: 'p1',
      fallbacks: [{ model: '' }, { model: 'm2', provider: 'p1' }],
      providers: [{ id: 'p1', baseURL: 'https://a.example.com' }]
    });
    const { result: cs } = await runWith(cfg, () => buildCandidateApis());
    assert.equal(cs.length, 2, '空 model 应被跳过，只保留 m2');
    ok('空 model fallback 被跳过');
  }

  // 7. 顺序：两个不同 fallback → 候选数 3，label 顺序与配置一致
  {
    const cfg = makeCfg({
      baseUrl: 'https://a.example.com', model: 'm1', provider: 'p1',
      fallbacks: [{ model: 'm2', provider: 'p1' }, { model: 'm3', provider: 'p1' }],
      providers: [{ id: 'p1', baseURL: 'https://a.example.com' }]
    });
    const { result: cs } = await runWith(cfg, () => buildCandidateApis());
    assert.equal(cs.length, 3, '两个不同 fallback 应产生 3 个候选');
    assert.deepEqual(cs.map((c) => c.label), ['m1', 'm2 @ p1', 'm3 @ p1'], '候选顺序必须与配置一致');
    ok('两个 fallback 顺序不变');
  }

  // 8. 候选形状（守 P0）：['label','overrides']，主候选 overrides=null，备选是扁平 api
  {
    const cfg = makeCfg({
      baseUrl: 'https://a.example.com', model: 'm1', provider: 'p1',
      fallbacks: [{ model: 'm2', provider: 'p1' }],
      providers: [{ id: 'p1', baseURL: 'https://a.example.com' }]
    });
    const { result: cs } = await runWith(cfg, () => buildCandidateApis());
    assert.deepEqual(Object.keys(cs[0]).sort(), ['label', 'overrides']);
    assert.equal(cs[0].overrides, null);
    for (const c of cs.slice(1)) {
      assert.ok(c.overrides && typeof c.overrides === 'object');
      assert.ok(c.overrides.baseUrl);
      assert.ok(!('overrides' in c.overrides));
    }
    ok('候选形状为 [label, overrides]');
  }

  // 9. 端到端（守 P0）：不同 model 的 fallback，主候选 400、fallback 200。
  //    不能 mock chatCompletion（同模块本地绑定），用 globalThis.fetch stub。
  {
    const cfg = makeCfg({
      baseUrl: 'https://a.example.com', model: 'm1', provider: 'p1',
      fallbacks: [{ model: 'm2', provider: 'p2' }],
      providers: [
        { id: 'p1', baseURL: 'https://a.example.com' },
        { id: 'p2', baseURL: 'https://b.example.com' }
      ]
    });
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url: String(url), body });
      if (calls.length === 1) {
        return {
          ok: false, status: 400,
          text: async () => JSON.stringify({ error: { message: 'unsupported image' } }),
          headers: { get: () => 'application/json' }
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        headers: { get: () => 'application/json' }
      };
    };
    try {
      const { result } = await runWith(cfg, () => chatCompletionWithRetry({ messages: [{ role: 'user', content: 'hi' }] }));
      assert.equal(calls.length, 2, '主候选 400 后应切到 fallback，共 2 次 HTTP');
      assert.equal(calls[0].body.model, 'm1', '第一次用主模型');
      assert.equal(calls[1].body.model, 'm2', '第二次用 fallback model（不能退化成主模型）');
      assert.ok(calls[1].url.includes('b.example.com'), 'fallback 使用自己 provider 的 baseUrl');
      assert.ok(result && result.message, 'fallback 成功返回正常结果');
    } finally {
      globalThis.fetch = realFetch;
    }
    ok('端到端：主 400 → fallback 200，未退化成主模型');
  }

  console.log(`\nllm-candidates-test：${passed} 项通过 ✅`);
  process.exit(0);
}

main().catch((error) => {
  console.error('\n❌ llm-candidates-test 失败：', error);
  process.exit(1);
});
