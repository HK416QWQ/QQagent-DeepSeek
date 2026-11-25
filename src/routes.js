// API 路由表：把 handleHttp 的巨型 if-else 链拆成声明式路由。
//
// 每个路由：{ method, pattern, handler }
//   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'（'*' 匹配任意方法）
//   - pattern: 字符串（精确匹配）或 RegExp（exec 捕获组传给 handler）
//   - handler: async (ctx) => 任意值
//       ctx = { req, res, url, pathname, method, match, body?, ...deps }
//       handler 必须自行写响应（json(res, code, data) 或 res.end/SSE）；
//       返回值不会被框架序列化——直接 return 对象等于让请求挂到客户端超时。
//
// 依赖（store/sessions/onebot/orchestrator/…）通过 createRoutes(deps) 注入，
// 路由 handler 通过闭包取用，避免在 app.js 里反复传参。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, updateConfig, deepMerge as deepMergeConfig, DATA_DIR } from './config.js';
import { customSearch } from './web-search.js';
import { listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices } from './model-prices.js';
import { refreshPriceFeed, priceFeedStatus, initPriceFeed } from './price-feed.js';
import {
  currentProviders, setProviderKey, testAllProviders, testOneProvider,
  testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, removeProvider
} from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { todayKey } from './util.js';
import { logger } from './logger.js';
import { skillManager } from './skills/manager.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
import { safeFetchBinary, browseLockState } from './safe-fetch.js';
import { getGlobalBlocklist, updateGlobalBlocklist, FIXED_PRICE_FEED_URL } from './community.js';
import { listAccounts, removeAccount, loginAccount, publishModule, verifyInstallCodes, installByCode } from './market.js';
import { detectDialect as detectThinkingDialect } from './thinking.js';
import { getStatusRuntime, getRuntimeSnapshot } from './run-history.js';
import { getDeepSeekBalance } from './deepseek-balance.js';
import * as mem2Ui from './mem2/ui-api.js';

/**
 * 构建路由表。
 * @param {object} deps 依赖注入
 */
export function createRoutes(deps) {
  const {
    store, sessions, onebot, orchestrator,
    emit, log,
    // app.js 内部的过程/状态
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    snowlumaDir, snowlumaWsPort, snowlumaWebuiUrl, snowlumaStatus, snowlumaLogs,
    launchSnowluma, stopSnowluma,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    buildBehaviorStats,
    reloadSkills
  } = deps;

  // 小工具：读请求体（容错：没 body 当空对象）。
  // 但 readBody 明确标记的可暴露错误（400 非法 JSON / 413 过大）必须透传，
  // 否则会从"应返回 400"退化成静默当成空 patch。
  const bodyOf = (req) => readBody(req).catch((e) => { if (e?.expose) throw e; return {}; });

  /**
   * Skill 可用性判断的运行期上下文。
   * 必须和 orchestrator 用同一份输入，否则会出现
   * "设置页说可用、运行时空工具列表"的口径分裂。
   */
  const skillRuntimeContext = () => {
    const cfg = getConfig();
    return {
      skills: skillManager,
      toolsCfg: cfg.tools || {},
      // 与 orchestrator 同款判定：vision 开关开着，且当前模型没有被
      // 视觉扫描判定为 no-vision（曾经只看前半项，模型不支持时
      // 设置页仍显示视觉工具可用，运行时却剔除）
      visionEnabled: cfg.api?.vision !== false
        && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision',
      searchEnabled: cfg.webSearch?.enabled !== false,
      stickerEnabled: cfg.sticker?.enabled !== false,
      stickerCollectEnabled: cfg.sticker?.collectEnabled !== false,
      runtimeContext: {
        model: cfg.api?.model || '',
        provider: cfg.api?.provider || '',
        source: 'api'
      }
    };
  };

  // /api/status 今天用量缓存：buildUsageStats({range:'today'}) 要扫当天全部会话文件
  // （实测 90 个文件约 200ms），而 /api/status 被 15 秒轮询 + 每条 chat-update 触发。
  // 10 秒 TTL + 单飞：并发请求共用同一次计算，避免把主进程 CPU 打满。
  const TODAY_STATS_TTL_MS = 10_000;
  // pendingDayKey 必须和 pending 同时写：只等成功回调再赋 dayKey 的话，首次/跨天后的
  // 并发请求会看到「有 pending 但 dayKey 不符」，各自再开一次全量扫描。
  const todayStatsCache = { dayKey: '', pendingDayKey: '', at: 0, value: null, pending: null };
  async function getTodayStatsCached() {
    const dayKey = todayKey();
    const now = Date.now();
    if (todayStatsCache.dayKey === dayKey && todayStatsCache.value
        && now - todayStatsCache.at < TODAY_STATS_TTL_MS) {
      return todayStatsCache.value;
    }
    if (todayStatsCache.pending && todayStatsCache.pendingDayKey === dayKey) return todayStatsCache.pending;
    const pending = buildUsageStats({ range: 'today' })
      .then((value) => {
        // 跨天时这次结果属于旧的一天，不回写缓存，避免把昨天的数字贴到今天
        if (todayKey() !== dayKey) return value;
        todayStatsCache.dayKey = dayKey;
        todayStatsCache.at = Date.now();
        todayStatsCache.value = value;
        return value;
      })
      .finally(() => {
        if (todayStatsCache.pending === pending) {
          todayStatsCache.pending = null;
          todayStatsCache.pendingDayKey = '';
        }
      });
    todayStatsCache.pending = pending;
    todayStatsCache.pendingDayKey = dayKey;
    return pending;
  }

  /**
   * /api/mem2/* 的统一出口。
   *
   * 把业务层抛的 BadRequest / NotFound 映射成 400 / 404 —— 不这么做的话，
   * 前端只能看到"500"，分不清「字段传错了」和「服务端炸了」。
   * 这两者的区别在本期很关键：PATCH 改 status 必须是 400（这是接口契约，不是故障）。
   */
  const mem2Send = async (res, json, fn) => {
    try {
      return json(res, 200, { ok: true, ...(await fn()) });
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) log(`[mem2-ui] ${error?.message ?? error}`);
      return json(res, status, { ok: false, error: String(error?.message ?? error) });
    }
  };

  return [
    // ── 状态 / 数据目录 / 重置 ─────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/status',
      handler: async ({ res, json }) => {
        const dayKey = todayKey();
        // 顶栏必须与「用量与成本」同源：
        // 旧实现是「会话数 + 当前模型统一估价」，与用量页「逐次调用 + 各自模型/峰谷价」
        // 口径不同 —— 峰时会分叉，用户对账时会以为数据错了。
        // 这里直接复用用量页的今天统计（10 秒 TTL + 单飞，见上方 getTodayStatsCached），失败才回落旧口径。
        let usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        let cost = estimateCost(usage, { model: cfgNow.api?.model });
        let cacheRate = cacheHitRate(usage);
        let webSearchCount = usage.webSearchCount || 0;
        try {
          const todayStats = await getTodayStatsCached();
          const tt = todayStats?.totals;
          if (tt) {
            usage = {
              dayKey,
              // 用量页「API 调用次数」显示的也是 totals.runs（每次 LLM 调用一行）
              calls: Number(tt.runs) || 0,
              runs: Number(tt.runs) || 0,
              promptTokens: Number(tt.promptTokens) || 0,
              completionTokens: Number(tt.completionTokens) || 0,
              totalTokens: Number(tt.totalTokens) || 0,
              cachedTokens: Number(tt.cachedTokens) || 0,
              webSearchCount: Number(todayStats.searchCount) || 0
            };
            cost = { ...cost, cost: Number(tt.cost) || 0 };
            cacheRate = Number(tt.cacheHitRate) || 0;
            webSearchCount = Number(todayStats.searchCount) || 0;
          }
        } catch { /* 用量统计失败：顶栏退回会话聚合口径，不能让状态接口失败 */ }
        // ┚ SnowLuma 运行判定用 WebUI 端口（进程即起即听）。
        // WS 3001 要等账号登录后才监听，用它判"运行中"会把"起了但未登录"
        // 误报成"未运行"（进而触发二次拉起 → 双实例管道冲突）。
        const webuiPort = deps.snowlumaWebuiPort();
        // 两个端口探测并行：串行时最坏 1.6s（各 800ms 超时），/api/status 每次都卡这么久
        const [slRunning, obPortOpen] = await Promise.all([
          deps.isPortOpen('127.0.0.1', webuiPort),
          deps.isPortOpen('127.0.0.1', snowlumaWsPort())
        ]);
        // 诊断：把"连不上"拆成三种用户能看懂的原因（给 UI 就绪度体检用）。
        let onebotDiagnosis = '';
        if (!onebot.connected) {
          if (!slRunning) onebotDiagnosis = 'SnowLuma 未运行：请到「内核与日志」页签启动';
          else if (!obPortOpen) onebotDiagnosis = 'SnowLuma 已运行但无账号登录：请在 QQ 里完成登录（登录后数秒内会自动连上）';
          else if (String(onebot.lastConnectError || '').includes('401')) onebotDiagnosis = '访问令牌不匹配：正在自动轮换重试，若持续出现请在设置里核对 OneBot 令牌';
          else onebotDiagnosis = onebot.lastConnectError ? `连接失败：${String(onebot.lastConnectError).slice(0, 120)}` : '连接中…';
        }
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            // 启动阶段（2026-11-11）：start() 提前返回后，窗口在 OneBot 连上之前就
            // 已创建，UI 需要一个信号区分「正在启动」和「真的没连上」。
            // `?? 'ready'` 是刻意的向后兼容：拿不到 deps 时退回旧行为（首屏弹 🔌
            // 告警），而不是永远卡在「启动中」——后者更难查。
            bootPhase: deps.getBootPhase?.() ?? 'ready',
            error: onebot.lastConnectError,
            diagnosis: onebotDiagnosis,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          snowluma: {
            dir: snowlumaDir(),
            running: slRunning,
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          qqPortable: await qqPortableStatus(),
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheRate,
          webSearchCount,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          runtime: getStatusRuntime(),
          dataDir: DATA_DIR
        });
      }
    },
    {
      // DeepSeek 账户余额：只在后端持有 Key 并请求官方接口；
      // 响应只有金额/状态，不含 Key、baseUrl。
      method: 'GET', pattern: '/api/deepseek-balance',
      handler: async ({ res, json, url }) => {
        const force = url.searchParams.get('force') === '1';
        return json(res, 200, await getDeepSeekBalance({ force }));
      }
    },
    {
      // 运行记录：一次进程启动一条，只读查询，不触发落盘
      method: 'GET', pattern: '/api/runtime',
      handler: async ({ res, json, url }) => {
        const rawStr = url.searchParams.get('limit');
        const raw = rawStr == null || rawStr === '' ? NaN : Number(rawStr);
        const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.trunc(raw))) : 50;
        return json(res, 200, { ok: true, ...getRuntimeSnapshot(limit) });
      }
    },
    {
      method: 'POST', pattern: '/api/open-data-dir',
      handler: async ({ res, json }) => {
        try {
          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir: DATA_DIR });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/reset-data',
      handler: async ({ res, json }) => {
        try {
          // 安全闸：只允许重置"看起来确实是数据目录"的路径。
          // QQ_AGENT_DATA_DIR 被误设成 C:\ 或用户目录时，无闸直接 rmSync 就是删盘。
          const resolved = path.resolve(DATA_DIR);
          const looksLikeDataDir = path.basename(resolved).toLowerCase().startsWith('data')
            || fs.existsSync(path.join(resolved, 'config.json'));
          if (!looksLikeDataDir || resolved === path.parse(resolved).root) {
            return json(res, 400, { ok: false, error: `数据目录不像 QQ Agent 数据目录，已拒绝重置：${resolved}` });
          }

          await orchestrator.abortAll();
          onebot.close();

          // 删前先备份：同级带时间戳的副本，出问题还能捞回来；备份失败则中止重置。
          let backupDir = '';
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backupDir = `${resolved}.backup-${stamp}`;
            fs.cpSync(resolved, backupDir, { recursive: true, force: true });
          } catch (error) {
            return json(res, 500, { ok: false, error: `备份失败，已中止重置：${String(error?.message ?? error)}` });
          }

          // 只清内容，不删目录本身（目录可能被占用/是挂载点）；
          // 跳过 qq-agent.lock —— 那是本进程活着的凭证，删了会让第二个实例误判无锁启动。
          for (const name of fs.readdirSync(resolved)) {
            if (name === 'qq-agent.lock') continue;
            fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
          }
          const { loadConfig } = await import('./config.js');
          updateConfig(loadConfig());
          return json(res, 200, { ok: true, backupDir, message: `已重置为初始形态（原数据已备份到 ${backupDir}），请重启应用` });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 成本看板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/usage/stats',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = await buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/breakdown',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 行为统计：发送条数/字数/表情包/识图/思考/API 请求/缓存，及按天/会话聚合
      method: 'GET', pattern: '/api/usage/behavior',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const stats = buildBehaviorStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 单次会话消耗明细（token/缓存耗时/工具调用），供「查看单条信息消耗量」
      method: 'GET', pattern: '/api/usage/sessions',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const stats = buildBehaviorStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, sessions: (stats && stats.sessions) || [] });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 价格表 ───────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/model-prices',
      handler: async ({ res, json, url }) => json(res, 200, {
        prices: listOfficialPrices(),
        current: resolveOfficialPrice(String(url.searchParams.get('model') || getConfig().api?.model || '')),
        remote: { ...priceFeedStatus(), url: FIXED_PRICE_FEED_URL }
      })
    },
    {
      method: 'POST', pattern: '/api/model-prices/refresh',
      handler: async ({ res, json }) => {
        const st = await refreshPriceFeed(FIXED_PRICE_FEED_URL);
        return json(res, 200, {
          ok: st.ok, remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }
    },

    // ── SnowLuma 进程管理 ────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/snowluma/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/snowluma/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: snowlumaLogs.slice(-200) })
    },
    {
      method: 'POST', pattern: '/api/snowluma/stop',
      handler: async ({ res, json }) => {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-folder',
      handler: async ({ res, json }) => {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-webui',
      handler: async ({ res, json }) => {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }
    },

    // ── 便携 QQ 进程管理 ─────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/qq-portable/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/qq-portable/stop',
      handler: async ({ res, json }) => {
        try {
          const result = await stopPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/qq-portable/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: qqPortableLogs.slice(-200) })
    },
    {
      method: 'GET', pattern: '/api/qq-portable/status',
      handler: async ({ res, json }) => json(res, 200, await qqPortableStatus())
    },

    // ── 体检 / 引导 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/onebot/groups',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/onebot/friends',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },

    // ── 人设模板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-templates',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-templates\/(custom_\d+)$/,
      handler: async ({ res, json, match }) => {
        const idx = Number(match[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }
    },

    // ── 多提供商模型目录 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/providers',
      handler: async ({ res, json }) => {
        const providers = currentProviders().map((p) => ({
          id: p.id, displayName: p.displayName, baseURL: p.baseURL,
          apiKey: '', apiKeyFrom: p.apiKeyFrom || '', needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey, anthropicOrigin: p.anthropicOrigin === true,
          models: p.models, modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }
    },
    {
      method: 'GET', pattern: '/api/providers/key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }
    },
    {
      method: 'GET', pattern: '/api/api-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }
    },
    {
      method: 'GET', pattern: '/api/search-key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const field = String(url.searchParams.get('field') || '');
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        // 各家对应的环境变量名：Key 没存进配置但环境里有时，也算"有 Key"
        //（web-search.js 的取值优先级就是 cfg.apiKey > env），UI 的掩码/显示
        // 口径必须与之一致，否则会出现"明明能搜，Key 框却显示空"的错觉。
        const ENV_OF = {
          deepseek: 'DEEPSEEK_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          bocha: 'BOCHA_API_KEY',
          baidu: 'BAIDU_SEARCH_API_KEY',
          metaso: 'METASO_API_KEY'
        };
        if (allowed.includes(field)) {
          const fromCfg = String(getConfig().webSearch?.[field]?.apiKey || '');
          return json(res, 200, { apiKey: fromCfg, hasApiKey: Boolean(fromCfg || (ENV_OF[field] && process.env[ENV_OF[field]])) });
        }
        // 自定义搜索服务：field 形如 custom:<id>，按 id 在 providers 数组里找
        if (field.startsWith('custom:')) {
          const id = field.slice('custom:'.length);
          const entry = (getConfig().webSearch?.providers || []).find((p) => String(p.id) === id);
          const k = String(entry?.apiKey || '');
          return json(res, 200, { apiKey: k, hasApiKey: Boolean(k) });
        }
        return json(res, 400, { error: `未知搜索服务：${field}` });
      }
    },
    {
      // OneBot 令牌明文读取：控制台「显示」按钮专用（与 /api/search-key 同一套来源校验）。
      // 必须有这个端点：配置经 sanitizeConfig 脱敏后前端只拿得到掩码，
      // 用户想"看一眼现有令牌"只能走这里。
      method: 'GET', pattern: '/api/onebot-token',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const which = String(url.searchParams.get('which') || '');
        const snow = getConfig().snowluma || {};
        if (which === 'ws') return json(res, 200, { token: String(snow.accessToken || '') });
        if (which === 'http') return json(res, 200, { token: String(snow.httpAccessToken || snow.accessToken || '') });
        return json(res, 400, { error: `未知令牌类型：${which}` });
      }
    },
    {
      method: 'POST', pattern: '/api/providers/fetch-models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          // Key 解析顺序（2026-09-20 修 401 高发）：显式明文 > 按 providerId 查该提供商
          // 保存的 Key（dshProviderKeys / providers[].apiKey）> 顶层 api.apiKey。
          // 旧实现只看顶层 Key —— 多提供商场景下顶层只存"当前选中那个"的 Key，
          // 从其它提供商拉列表就会拿错 Key，全部 401。
          let apiKey = '';
          if (body.apiKey !== undefined && String(body.apiKey ?? '').trim() && body.apiKey !== '******') {
            apiKey = String(body.apiKey).trim();
          } else {
            const pid = String(body.providerId ?? '').trim();
            const p = pid ? currentProviders().find((x) => x.id === pid) : null;
            apiKey = String(p?.apiKey ?? '').trim();
            if (!apiKey) apiKey = String(cfgNow.api.apiKey || '').trim();
            if (apiKey === '******') apiKey = '';
          }
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-one',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-chat',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const submitted = String(body.apiKey ?? '').trim();
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const baseUrl = String(body.baseUrl ?? '');
          const model = String(body.model ?? '');
          const result = await testModelChat({ baseUrl, apiKey, model });
          // 「思考方言」由内置方言表识别（原 thinking-adapters 插件收编进核心）。
          // 接在这里是为了让用户在"测试连通性"时就能看到这个模型会走哪套思考参数，
          // 而不是开了思考模式后默默不生效、只能去翻日志。
          let thinking = null;
          try {
            thinking = detectThinkingDialect({ baseUrl, model }) || null;
          } catch { /* 识别失败不影响连通性测试结论 */ }
          return json(res, 200, { ok: true, result: { ...result, thinking } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/set-key',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }
    },
    {
      // 删除整个提供商（含 Key 与模型目录；当前选中它时一并清空选中态）
      method: 'DELETE', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const removed = removeProvider(String(body.providerId ?? ''));
          if (!removed) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-all',
      handler: async ({ res, json }) => {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }
    },

    // ── 视觉能力 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/vision/results',
      handler: async ({ res, json }) => json(res, 200, {
        results: { ...builtinVisionResults(currentProviders()), ...visionResults() },
        scanning: visionScan.running
      })
    },
    {
      method: 'POST', pattern: '/api/vision/scan',
      handler: async ({ req, res, json }) => {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await bodyOf(req);
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({ providers: currentProviders(), emit, onlyProviderIds, timeoutMs: 25000, limit: 3 })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }
    },

    // ── 自定义搜索提供商 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/search-providers',
      handler: async ({ res, json }) => {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
          count: p.count, timeoutMs: p.timeoutMs, hasApiKey: Boolean(String(p.apiKey || '').trim())
        }));
        return json(res, 200, { providers: list });
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // apiKey 语义（与「清除密钥」按钮配套）：
            //   undefined / '******' → 不动（保持原 Key）
            //   非空字符串           → 覆盖为新 Key
            //   ''（显式空串）        → 清除
            if (body.apiKey === undefined) {
              /* 未提交：保持原值 */
            } else if (String(body.apiKey) === '******') {
              /* 掩码回传：保持原值 */
            } else {
              existing.apiKey = String(body.apiKey).trim();
            }
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type, baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, { ok: true, provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) updateConfig({ webSearch: { provider: 'bing' } });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers/test',
      handler: async ({ req, res, json }) => {
        const startedAt = Date.now();
        try {
          const body = await bodyOf(req);
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, { ok: true, result: { ok: true, count: r.results.length, sample: r.results[0]?.title || '', latencyMs: Date.now() - startedAt } });
        } catch (error) {
          return json(res, 200, { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt } });
        }
      }
    },

    // ── 连通性测试 ───────────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/test/api',
      handler: async ({ res, json }) => {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({ messages: [{ role: 'user', content: '请只回复两个字符：pong' }], tools: null, temperature: 0 });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }
    },

    // ── 配置 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/config',
      handler: async ({ res, json }) => json(res, 200, sanitizeConfig(getConfig()))
    },
    {
      // 完整系统提示词预览：按**当前**插件/技能/工具启用状态组装（没开的不出现），
      // 供设置-工具与技能页和技能页右侧预览共用。走后端而不是前端拼：组装逻辑
      // 就是运行时的 buildSystemPrompt + getToolAvailability，前端另写一份迟早漂移。
      // 注意 skillContext 与 orchestrator 同构（visionEnabled/searchEnabled/toolsCfg），
      // 否则预览和实际运行的口径会分裂。
      //
      // POST + 可选 overrides：前端自动保存有 600ms 防抖，用户刚点的开关还没落盘；
      // 调用方把"当前工具面板状态"随请求发来，这里先 deepMerge 到临时副本上组装
      // （绝不写回 currentConfig），预览就能立即反映未保存的开关。
      method: '*', pattern: '/api/prompt-preview',
      handler: async ({ req, res, json }) => {
        const cfg = getConfig();
        let overrides = {};
        try {
          if (req.method === 'POST') overrides = (await bodyOf(req)) || {};
        } catch { overrides = {}; }
        const effective = Object.keys(overrides).length
          ? deepMergeConfig(structuredClone(cfg), structuredClone(overrides))
          : cfg;
        const skillContext = {
          skills: skillManager,
          toolsCfg: effective.tools || {},
          visionEnabled: effective.api?.vision !== false
            && modelImageVerdict(effective.api?.provider, effective.api?.model) !== 'no-vision',
          searchEnabled: effective.webSearch?.enabled !== false,
          stickerEnabled: effective.sticker?.enabled !== false,
          stickerCollectEnabled: effective.sticker?.collectEnabled !== false,
          runtimeContext: { model: effective.api?.model || '', provider: effective.api?.provider || '', source: 'api' }
        };
        const { buildSystemPrompt } = await import('./prompt.js');
        const { buildToolDefs } = await import('./tools.js');
        const { getToolAvailability } = await import('./tool-registry.js');
        // 可用工具清单与 orchestrator 同一口径（tools.js 的 def → OpenAI 函数名）
        const tools = buildToolDefs()
          .filter((d) => getToolAvailability(d.id, skillContext).enabled)
          .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category }));
        return json(res, 200, {
          systemPrompt: buildSystemPrompt({ skillContext }),
          tools
        });
      }
    },
    {
      method: 'GET', pattern: '/api/community/blocklist',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ids: getGlobalBlocklist() })
    },
    {
      method: 'POST', pattern: '/api/community/blocklist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        try {
          const { ids: actual, warning } = await updateGlobalBlocklist(ids, { mode: String(body?.mode || 'replace') });
          emit('status', { communityBlocklistUpdated: true });
          return json(res, 200, { ok: true, ids: actual, warning: warning || '' });
        } catch (error) {
          return json(res, 502, { ok: false, error: `云端屏蔽名单更新失败：${String(error?.message ?? error)}` });
        }
      }
    },

    // ── 社区市场：账号 + 发布 + 口令安装（全部代理官网，浏览器不直连）──────
    // 凭据存 data/account.json（不走 config：GET /api/config 会脱敏回传整个配置，
    // 塞进 config 等于自造泄露面）。所有端点失败都返回 502 + 服务器原始文案。
    {
      method: 'GET', pattern: '/api/market/accounts',
      handler: async ({ res, json }) => {
        const accounts = listAccounts().map((a) => ({ username: a.username, savedAt: a.savedAt }));
        return json(res, 200, { ok: true, accounts });
      }
    },
    {
      // 登录 / 注册。mode: login | register。注册三要素：登录 ID + 展示用户名 + 密码。
      // 成功后凭据自动落盘。
      method: 'POST', pattern: '/api/market/login',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const r = await loginAccount({
            loginId: String(body?.loginId || ''),
            displayName: String(body?.displayName || ''),
            password: String(body?.password || ''),
            mode: body?.mode === 'register' ? 'register' : 'login'
          });
          return json(res, 200, { ok: true, account: r.account, accounts: r.accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 登出（删本地凭据 + 吊销远端 token）
      method: 'POST', pattern: '/api/market/logout',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const username = String(body?.username || '');
        if (!username) return json(res, 400, { ok: false, error: '缺少 username' });
        const accounts = await removeAccount(username);
        return json(res, 200, { ok: true, accounts: accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
      }
    },
    {
      // 发布一个已安装的 skill/plugin 到市场（待审核）。
      // body: { kind: 'skill'|'plugin', id, displayName, description, accountUsername }
      method: 'POST', pattern: '/api/market/publish',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const id = String(body?.id || '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
          return json(res, 400, { ok: false, error: `无效的 ${kind} id：${id}` });
        }
        const acc = listAccounts().find((a) => a.username === String(body?.accountUsername || ''));
        if (!acc) return json(res, 401, { ok: false, error: '请先选择一个已登录的账号' });
        try {
          const r = await publishModule({
            kind, id,
            displayName: String(body?.displayName || ''),
            description: String(body?.description || ''),
            token: acc.token,
            // 阿里云验证码验签参数：远端市场对发布强制要求（一次性，前端弹出验证后拿到）
            captchaVerifyParam: String(body?.captchaVerifyParam || '')
          });
          return json(res, 200, {
            ok: true, item: r.item || null,
            renamedTo: r.renamedTo || null,
            note: r.note || ''
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令批量校验：body { codes: [...] } → 每个口令的条目摘要
      method: 'POST', pattern: '/api/market/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code])
          .map((c) => String(c ?? '').trim().toUpperCase())
          .filter((c) => /^[A-Z0-9]{1,32}$/.test(c))
          .slice(0, 30);
        if (!codes.length) return json(res, 400, { ok: false, error: '没有有效的口令' });
        try {
          const results = await verifyInstallCodes(codes);
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令安装：body { code, entry }（entry = verify 阶段拿到的条目，含服务器判定的 type）。
      // 类型路由由服务器 entry.type 决定：技能页输插件口令也会装进 plugins/。
      method: 'POST', pattern: '/api/market/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const code = String(body?.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(res, 400, { ok: false, error: '口令格式无效' });
        try {
          const r = await installByCode({ code, verified: body?.entry || null });
          // 安装完立即重扫，让新模块马上出现在页签里（热重载 watcher 也行，
          // 但目录删除重建的场景 watcher 会丢事件 —— reload 是唯一可靠路径）
          try { await reloadSkills({ reason: 'market-install' }); } catch { /* 重扫失败不影响安装结果 */ }
          return json(res, 200, { ok: true, kind: r.kind, id: r.id, dir: r.dir });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── Skill 管理 ─────────────────────────────────────────────────────
    // 统一开关入口：前端只改这里，模块内部一律读 skillManager。
    {
      method: 'GET', pattern: '/api/skills',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
        // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
        const installedIds = new Set(skillManager.list(context).map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installedIds.has(id))
          .map((id) => {
            const c = getConfig()?.skills?.[id] || {};
            return {
              id,
              enabled: c.enabled !== false,
              hasSettings: Object.keys(c).some((k) => k !== 'enabled')
            };
          });
        return json(res, 200, {
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          uninstalled
        });
      }
    },
    {
      // 手动重扫磁盘：UI「刷新」按钮的后端动作。
      // 之前刷新只读内存注册表，watcher 丢事件（目录删除重建 / 网络盘 / 杀软）
      // 时新插件永远进不来。这里走 app.reloadSkills()：重扫 + 激活 + 刷工具 + 重建 watcher。
      method: 'POST', pattern: '/api/skills/reload',
      handler: async ({ res, json }) => {
        if (typeof reloadSkills !== 'function') {
          return json(res, 500, { ok: false, error: '核心未提供 reloadSkills（请升级或检查启动方式）' });
        }
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned,
            skills: skillManager.list(context),
            summary: skillManager.summary(context),
            capabilities: skillManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 清理"已配置但未安装"的残留配置段：删掉 config.skills.<id>。
      // body: { ids: [id...] }，只删传入的 id，且要求该 id 当前确实不在注册表里
      //（防止把正在运行的 Skill 配置误删）。
      method: 'POST', pattern: '/api/skills/cleanup',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少 ids' });
        const installed = new Set(skillManager.list().map((s) => s.id));
        const removable = ids.filter((id) => !installed.has(id));
        if (!removable.length) {
          return json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        }
        const skillsCfg = getConfig()?.skills || {};
        const next = { ...skillsCfg };
        for (const id of removable) delete next[id];
        // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
        updateConfig({ skills: { __replace__: next } });
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          removed: removable,
          skipped: ids.filter((id) => installed.has(id)),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 单个 Skill：切开关 / 改设置。两个动作分开处理，避免"改了设置顺手把我开着的关了"。
      method: 'POST', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await bodyOf(req);
        const context = skillRuntimeContext();
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `Skill 不存在：${id}` });

        // 1) 开关（先写配置，再跑生命周期；顺序不能反 ——
        //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
        if (body.enabled !== undefined) {
          setSkillEnabled(id, !!body.enabled);
          if (body.enabled) skillManager.activate(id, context);
          else skillManager.deactivate(id, context);
        }

        // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
        if (body.settings && typeof body.settings === 'object') {
          const allowed = new Set([
            ...Object.keys(skill.manifest.settings || {}),
            ...Object.keys(skill.manifest.configSchema || {})
          ]);
          const schema = skill.manifest.configSchema || {};
          const current = getSkillConfig(id, skill.manifest.settings || {});
          const patch = {};
          // ⚠️ 与 settingsView 同一套口径（2026-09-26 审查二轮）：
          //    ① secret 标记；② 字段名命中 /key|token|secret|password|cookie/i 的
          //    字符串字段（web-fetch 的 cookie 没有 secret 标记也属密文）。
          //    收到掩码 '******' 或空串 = "不修改" —— 否则用户只是打开表单点了
          //    保存，Cookie/Key 就被覆盖成六个星号。
          const SECRET_NAME_RE = /key|token|secret|password|cookie/i;
          const isSecretField = (k) => Boolean(schema[k]?.secret)
            || (SECRET_NAME_RE.test(k) && typeof current[k] === 'string');
          for (const [k, v] of Object.entries(body.settings)) {
            if (!allowed.has(k)) continue;
            if (isSecretField(k) && (v === '******' || String(v ?? '').trim() === '')) continue;
            patch[k] = v;
          }
          if (Object.keys(patch).length) setSkillConfig(id, patch);
        }

        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          skill: skillManager.status(id, context),
          // ⚠️ 响应里的 settings 必须用脱敏视图（settingsView）：
          //    曾经直接回 getSkillConfig（明文），保存一次设置就把
          //    apiKey / Cookie 原文发回浏览器，与 GET 列表的脱敏口径相反。
          settings: skillManager.settingsView(id),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 开关配置总览：给设置页渲染"技能"区块
      method: 'GET', pattern: '/api/skills/capabilities',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const caps = skillManager.capabilities.list().sort();
        return json(res, 200, {
          capabilities: caps.map((c) => ({
            name: c,
            ...skillManager.explainCapability(c, context)
          }))
        });
      }
    },
    {
      // 工具可用性总览：明确告诉 UI "这个工具为什么没生效"
      method: 'GET', pattern: '/api/tools/availability',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const availability = availabilityOf(context);
        const defs = new Map(listTools().map((t) => [t.id, t]));
        return json(res, 200, {
          categories: CATEGORY_META,
          tools: availability.map((a) => ({
            id: a.id,
            category: defs.get(a.id)?.category || 'system',
            skillId: a.skillId,
            enabled: a.enabled,
            code: a.code,
            reason: a.reason
          }))
        });
      }
    },


    {
      method: 'POST', pattern: '/api/config',
      handler: async ({ req, res, json }) => {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        sessions?.setKeepFiles?.(next.store?.keepSessionFiles ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        initPriceFeed(FIXED_PRICE_FEED_URL);
        emit('status', { configUpdated: true });
        // ⚠️ 必须脱敏：updateConfig 返回的是内存里的活配置对象，含明文 apiKey /
        //    accessToken / dshProviderKeys。GET /api/config 一直是脱敏的，
        //    这里漏掉会让"任何一次保存设置"把全部明文密钥回传给浏览器。
        return json(res, 200, { ok: true, config: sanitizeConfig(next) });
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('./tool-registry.js');
        const tools = listTools().map((t) => ({
          id: t.id, name: t.name, description: t.description, category: t.category,
          icon: t.icon, defaultEnabled: t.defaultEnabled, requiresVision: t.requiresVision, requiresSearch: t.requiresSearch,
          // 来源标记：属于哪个 Skill（内置工具为 null）—— UI 据此打「skill」标识，
          // 并在所属技能失活时把工具整组隐藏（与提示词口径一致）。
          skillId: t.skillId ?? null
        }));
        return json(res, 200, { tools });
      }
    },
    {
      // 设置页“表情包选取”用：只读本地认知层，不触发 QQ 同步、不回传 URL。
      method: 'GET', pattern: '/api/stickers',
      handler: async ({ res, json }) => {
        const entries = orchestrator.stickers?.entries || [];
        return json(res, 200, {
          total: entries.length,
          stickers: entries.map((e) => ({
            id: e.id,
            desc: e.desc || '',
            localNote: e.localNote || '',
            tags: Array.isArray(e.tags) ? e.tags : [],
            useCount: Number(e.useCount) || 0
          }))
        });
      }
    },
    {
      // 识图脚本写完本地库后调用：不重启也能让运行时看到新 localNote。
      method: 'POST', pattern: '/api/stickers/reload',
      handler: async ({ res, json }) => {
        const total = await orchestrator.stickers?.reload?.();
        return json(res, 200, { ok: true, total: Number(total) || 0 });
      }
    },

    // ── 模型 / 会话 / 存档 ───────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/models',
      handler: async ({ res, json }) => {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const q = url.searchParams;
        const rawLimit = q.get('limit');
        // 默认 200（原 1048576 = 全量），与 P0-03 前端同版本发布；
        // 响应保留 sessions 字段，追加 active/total/totalFinished/hasMore/nextCursor。
        const page = sessions.listPage({
          limit: rawLimit == null ? 200 : Number(rawLimit),
          beforeTs: q.get('beforeTs'),
          beforeId: q.get('beforeId')
        });
        return json(res, 200, page);
      }
    },
    {
      method: 'GET', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const s = sessions.get(match[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }
    },
    {
      // 主动删除一条会话记录（正在运行的不能删）
      method: 'DELETE', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const removed = sessions.remove(match[1]);
        if (!removed) return json(res, 409, { ok: false, error: '会话不存在或正在运行（运行中的会话不能删除）' });
        emit('session-end', { sessionId: match[1], status: 'deleted' });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 清空全部已结束的会话记录（保留运行中/等待中的）
      method: 'POST', pattern: '/api/sessions/clear-finished',
      handler: async ({ res, json }) => {
        const removed = sessions.clearFinished();
        emit('session-end', { status: 'cleared', removed });
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 手动重试一条失败的会话：把触发批翻回未读并立即唤醒（会话页「重试」按钮）。
      // 只有 error 状态且未发出过消息的会话允许重试（已发言的重试 = 群里看到两遍）。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/retry$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.retrySession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true, restored: r.restored });
      }
    },
    {
      // 中止一个运行中/等待中的会话（会话页「中止」按钮）。
      // 运行中的会话在下一轮 LLM 请求前安全收尾（不截断途中的请求/发送）；
      // 等待中的会话直接干净消失。不在两种状态之一（如已结束）则拒绝。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/abort$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.abortSession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'GET', pattern: '/api/chats',
      handler: async ({ res, json }) => {
        // P1-01b：不再 `listChats()` 把每个 chat 的消息全读进内存。
        // `listChatKeys()` 只 readdir；每个 key 的 meta 走「内存 → 缓存 → 单次加载」。
        const chats = store.listChatKeys().map((key) => ({ key, ...store.chatMetaForList(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }
    },

    // ── 存档消息 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/chats\/(group|private)_(\d+)\/messages$/,
      handler: async ({ res, json, url, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply, media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }
    },
    {
      method: 'POST', pattern: '/api/media-data',
      handler: async ({ req, res, json }) => {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          const fileToDataUrl = (fp) => {
            const st = fs.statSync(fp);
            if (st.size > 15 * 1024 * 1024) return null;
            return `data:${mimeOf(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
          };
          // 下载一律走 safe-fetch：这里的 url 来自请求体（前端/任何本机进程都能构造），
          // 直接 fetch 等于给了一个"让本机去抓内网"的 SSRF 入口。
          const safeToDataUrl = async (rawUrl) => {
            const { buffer, contentType } = await safeFetchBinary(String(rawUrl), 15 * 1024 * 1024, { browseLocked: browseLockState().enabled });
            if (!buffer?.length || buffer.length > 15 * 1024 * 1024) return null;
            const type = String(contentType || 'image/jpeg').split(';')[0].trim();
            if (!/^image\//i.test(type)) return null;
            return `data:${type};base64,${buffer.toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            try {
              const ret = await onebot.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
              if (!dataUrl && ret?.url) dataUrl = await safeToDataUrl(ret.url);
            } catch { /* 缓存没有 / 地址不可信就走下一条 */ }
            if (!dataUrl && it?.url) {
              try { dataUrl = await safeToDataUrl(it.url); } catch { /* 过期或不可信就放弃 */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }
    },

    // ── 群成员 / 会话控制 ────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/groups\/(\d+)\/members$/,
      handler: async ({ res, json, match }) => {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(match[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/wake$/,
      handler: async ({ res, json }) => json(res, 410, { error: '已移除：不触发的消息现在会立即标为已读，无需手动唤醒' })
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/test-send$/,
      handler: async ({ req, res, json, match }) => {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        // ⚠️ 白名单闸（2026-09-26 审查二轮）：本端点曾接受任意 group/private id ——
        //   任何通过来源校验的本地进程都能借它向**白名单外**的群/私聊发消息
        //   （绕过 send_to 工具的硬校验，等于给管理端开了一条无白名单的发送通道）。
        //   现在与 app.allowed() 同口径：deny 优先；allow 非空时必须在名单内；
        //   全空时必须显式开 allowAllWhenEmpty。
        const kind = match[1];
        const id = match[2];
        const cfgNow = getConfig();
        const denyList = cfgNow.deny?.[kind] ?? cfgNow.deny?.[`${kind}s`] ?? [];
        if (denyList.map(String).includes(String(id))) {
          return json(res, 403, { error: '该会话在黑名单内，不能发送' });
        }
        const allowList = cfgNow.allow?.[kind] ?? cfgNow.allow?.[`${kind}s`] ?? [];
        const allowed = allowList.length > 0
          ? allowList.map(String).includes(String(id))
          : cfgNow.allowAllWhenEmpty === true;
        if (!allowed) {
          return json(res, 403, { error: '该会话不在白名单内，不能发送（先在设置里加白名单，或开启空白名单放行）' });
        }
        try {
          const chatKey = `${kind}:${id}`;
          const data = await onebot.sendText(kind, id, text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/,
      handler: async ({ res, json, match }) => json(res, 200, { ok: true, marked: store.drainUnread(`${match[1]}:${match[2]}`).length })
    },
    {
      // 清空某会话的全部消息（整体清除存档）
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/clear$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const removed = store.clearChat(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 仅屏蔽（不删除）：把某会话全部未读标记为已读，不再触发回复
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mute$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const marked = store.muteUnread(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, marked });
      }
    },
    {
      // 部分清除：删除指定本地 id 的消息
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/delete-messages$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少要删除的消息 id 列表（ids）' });
        const removed = store.removeByLocalIds(chatKey, ids);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      method: 'POST', pattern: '/api/pause',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) orchestrator.drainBacklogAfterResume();
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }
    },
    {
      method: 'DELETE', pattern: '/api/pause',
      handler: async ({ res, json }) => {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }
    },

    // ── 日志系统 ─────────────────────────────────────────────────────
    {
      // 最近的日志（UI 日志页签首次加载）
      method: 'GET', pattern: '/api/logs',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { logs: logger.recent(limit), level: logger.getLevel() });
      }
    },
    {
      // 调整最低落盘级别（debug/info/warn/error）
      method: 'POST', pattern: '/api/logs/level',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const level = String(body.level || 'info');
        logger.setLevel(level);
        return json(res, 200, { ok: true, level: logger.getLevel() });
      }
    },

    // ── 验证码请求转发（2026-09-26）────────────────────────────────
    // 部分用户机器上 Chromium 渲染层对 *.aliyuncs.com / *.alicdn.com 的请求被
    // 本机安全软件按进程+域名压制（同机 Node 层、系统 curl 均正常），SDK 走不通。
    // 由主进程 Node 层（undici，网络栈独立且实测可达）代为转发。
    // 安全边界（防 SSRF）：目标仅允许 https + aliyuncs/alicdn 两族域名后缀；
    // 不跟随重定向；body 上限 8MB；响应上限 16MB；超时 15s。
    {
      method: '*', pattern: /^\/api\/captcha-forward\/?$/,
      handler: async ({ req, res, json, url }) => {
        const target = String((url && url.searchParams.get('u')) || '');
        let parsed;
        try { parsed = new URL(target); } catch {
          return json(res, 400, { ok: false, error: '缺少或非法的 u 参数' });
        }
        if (parsed.protocol !== 'https:' ||
            !/^[a-zA-Z0-9.-]+\.(aliyuncs\.com|alicdn\.com)$/.test(parsed.hostname)) {
          return json(res, 403, { ok: false, error: `目标不在转发白名单（仅 https 的 aliyuncs/alicdn 域）：${parsed.hostname}` });
        }
        // 读原始 body（POST 等需要；上限 8MB）
        const chunks = [];
        let size = 0;
        try {
          await new Promise((resolve, reject) => {
            req.on('data', (c) => {
              size += c.length;
              if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
              chunks.push(c);
            });
            req.on('end', resolve);
            req.on('error', reject);
          });
        } catch { /* 读失败按空 body 处理 */ }
        const reqBody = Buffer.concat(chunks);

        // 复制请求头（剥掉 hop-by-hop 与本机信息头）
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const kl = k.toLowerCase();
          if (['host', 'cookie', 'connection', 'content-length', 'origin', 'referer',
               'accept-encoding', 'transfer-encoding', 'upgrade', 'expect'].includes(kl)) continue;
          fwdHeaders[k] = v;
        }
        if (reqBody.length && !fwdHeaders['content-type']) fwdHeaders['content-type'] = 'application/octet-stream';

        try {
          const up = await fetch(parsed.href, {
            method: req.method,
            headers: fwdHeaders,
            body: (req.method === 'GET' || req.method === 'HEAD' || reqBody.length === 0) ? undefined : reqBody,
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
          });
          const buf = Buffer.from(await up.arrayBuffer());
          if (buf.length > 16 * 1024 * 1024) {
            return json(res, 502, { ok: false, error: '转发响应过大（>16MB）' });
          }
          const resHeaders = {};
          up.headers.forEach((v, k) => {
            const kl = k.toLowerCase();
            if (['transfer-encoding', 'content-encoding', 'content-length', 'connection', 'keep-alive'].includes(kl)) return;
            resHeaders[k] = v;
          });
          resHeaders['access-control-allow-origin'] = '*';   // 同源请求用不到，留作兜底
          res.writeHead(up.status, resHeaders);
          res.end(buf);
        } catch (e) {
          return json(res, 502, { ok: false, error: `转发失败：${String(e?.cause?.code || e?.message || e).slice(0, 120)}` });
        }
        return undefined;   // 已自行写响应
      }
    },
    // ── 第 5 期 · 记忆浏览器 5a（/api/mem2/*）───────────────────────────
    //
    // 第 5 期 · 记忆浏览器接口（/api/mem2/*）。旧记忆文件读写接口已于 2026-11-23 摘除。
    {
      method: 'GET', pattern: '/api/mem2/people',
      handler: async ({ res, json, url }) => mem2Send(res, json, () => ({
        people: mem2Ui.listPeople({
          chat: url.searchParams.get('chat') || '',
          q: url.searchParams.get('q') || ''
        }),
        overview: mem2Ui.overview()
      }))
    },
    {
      method: 'GET', pattern: /^\/api\/mem2\/people\/([^/]+)$/,
      handler: async ({ res, json, url, match }) => mem2Send(res, json, () => (
        mem2Ui.getPerson(decodeURIComponent(match[1]), {
          includeSuperseded: url.searchParams.get('all') === '1'
        })
      ))
    },
    {
      method: 'GET', pattern: '/api/mem2/graph',
      handler: async ({ res, json }) => mem2Send(res, json, () => mem2Ui.graphData())
    },
    {
      // ★ 只接受 content。改 status/groups/entryId 一律 400（契约，不是故障）。
      method: 'PATCH', pattern: /^\/api\/mem2\/entries\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => mem2Send(res, json, async () => {
        const body = await bodyOf(req);
        return mem2Ui.editEntry(decodeURIComponent(match[1]), body || {});
      })
    },
    {
      // 软删 / 撤销。彻底删除要二次确认参数，留给 5b，不混进这个口子。
      method: 'POST', pattern: /^\/api\/mem2\/entries\/([^/]+)\/void$/,
      handler: async ({ req, res, json, match }) => mem2Send(res, json, async () => {
        const body = await bodyOf(req);
        return mem2Ui.setEntryStatus(decodeURIComponent(match[1]), body?.undo === true ? 'undo' : 'void');
      })
    },
    {
      method: 'GET', pattern: '/api/mem2/l4',
      handler: async ({ res, json, url }) => mem2Send(res, json, () => mem2Ui.listL4({
        chat: url.searchParams.get('chat') || '',
        ym: url.searchParams.get('ym') || ''
      }))
    },
    {
      method: 'GET', pattern: '/api/mem2/coverage',
      handler: async ({ res, json, url }) => mem2Send(res, json, () => mem2Ui.listCoverage({
        chat: url.searchParams.get('chat') || ''
      }))
    },
    {
      method: 'GET', pattern: '/api/mem2/backfill',
      handler: async ({ res, json, url }) => mem2Send(res, json, () => mem2Ui.backfillStatus({
        runId: url.searchParams.get('run') || ''
      }))
    },

    // ── 第 5 期 · 5b 治理闭环 ─────────────────────────────────────────
    // 候选池：逐条查看/删除（硬约束 17：这里只给人看，绝不进注入/检索）
    {
      method: 'GET', pattern: '/api/mem2/candidates',
      handler: async ({ res, json, url }) => mem2Send(res, json, () => mem2Ui.listCandidates({
        chat: url.searchParams.get('chat') || '',
        status: url.searchParams.get('status') || 'pending'
      }))
    },
    {
      method: 'POST', pattern: /^\/api\/mem2\/candidates\/([^/]+)\/delete$/,
      handler: async ({ req, res, json, match, url }) => mem2Send(res, json, async () => {
        const body = await bodyOf(req);
        return mem2Ui.deleteCandidateById({
          chatKey: url.searchParams.get('chat') || body?.chatKey || '',
          entryId: decodeURIComponent(match[1]),
          reason: body?.reason || ''
        });
      })
    },
    // 冲突裁决：pinned 旧条 vs 新提炼，人工选保留哪条
    {
      method: 'GET', pattern: '/api/mem2/conflicts',
      handler: async ({ res, json, url }) => mem2Send(res, json, () => mem2Ui.listConflictPairs({
        uid: url.searchParams.get('uid') || ''
      }))
    },
    {
      method: 'POST', pattern: '/api/mem2/conflicts/resolve',
      handler: async ({ req, res, json }) => mem2Send(res, json, async () => {
        const body = await bodyOf(req);
        return mem2Ui.resolveConflictPair({
          userId: body?.userId || '', entryId: body?.entryId || '', keep: body?.keep || 'new'
        });
      })
    },
    // L3 知识：空态 + 来源说明（不从摘要/提炼提取）
    {
      method: 'GET', pattern: '/api/mem2/knowledge',
      handler: async ({ res, json }) => mem2Send(res, json, () => mem2Ui.listKnowledge())
    },
    // 彻底删除：后端强制二次确认（confirm 必须恰好 'DELETE'），物理删全部版本行 + 审计留痕
    {
      method: 'DELETE', pattern: /^\/api\/mem2\/entries\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => mem2Send(res, json, async () => {
        const body = await bodyOf(req);
        return mem2Ui.purgeEntry({
          entryId: decodeURIComponent(match[1]),
          confirm: body?.confirm || '',
          reason: body?.reason || ''
        });
      })
    },
    // 删除审计条数（UI 顶部展示「已彻底删除 N 条」）
    {
      method: 'GET', pattern: '/api/mem2/deletions',
      handler: async ({ res, json }) => mem2Send(res, json, () => ({ count: mem2Ui.deletionCount() }))
    },
  ];
}
