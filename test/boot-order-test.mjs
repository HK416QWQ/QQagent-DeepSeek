// 启动时序的源码结构断言（2026-11-11）。
//
// 为什么是"读源码找结构"而不是"跑起来量时间"：
// `start()` 的真实时序要起一个 server + 8 秒 Skill 加载 + SnowLuma 端口等待才能
// 观察，离线跑不了、跑一次几十秒。而这一单要防的回归非常具体 ——
// 有人把 `await Promise.all([skillsReady, snowlumaReady])` 挪回 `return port` 之前。
// 那是一条纯结构问题，源码断言是最合适的工具。
//
// ⚠️ 必须按**函数体切片**再找索引，不能全文件 indexOf：
//    注释里写着同一串代码（本文件为解释原因大量引用了它们），全文件搜会命中注释。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

/**
 * 取一个函数声明的**函数体原文**。
 *
 * 为什么不用大括号配对：`createApp` 内部大量 `if (...) throw ...;` 这种无花括号的
 * 单语句块，加上注释/字符串/模板串里的花括号，纯计数非常容易数错（第一版就是这么
 * 切错的：`start()` 只切出 181 字符，正好停在端口顺延那个 for 循环上）。
 *
 * 改用缩进契约 —— 这里的目标函数全部是 `createApp` 的直接子函数，缩进固定 2 空格，
 * 函数体的闭合行必然是行首恰好两个空格的 `}`。内部嵌套块的 `}` 缩进更深，不会误命中。
 *
 * 代价：若函数体内出现「多行模板串里恰好有一行是 `  }`」会切短。所以下面每个
 * 切片都断言了长度，切错会立刻红，而不是悄悄放行。
 */
function bodyOf(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  const rest = src.slice(at);
  const m = /\n {2}\}\n/.exec(rest);
  if (!m) return '';
  return rest.slice(0, m.index);
}

/** 去掉注释后逐行返回，用来找"第一条有效语句"，也用来避免注释里的示例代码误命中。 */
function codeLines(body) {
  return String(body)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    // bodyOf 是从签名开始切的，第一行是 `async function xxx(...) {`，不算语句
    .filter((l) => !/^(async\s+)?function\s/.test(l));
}

const startBody = bodyOf(SRC, 'async function start(');
const bgBody = bodyOf(SRC, 'async function runBackgroundBoot(');
const stopBody = bodyOf(SRC, 'async function stop(');

assert.ok(startBody.length > 100, 'start() 函数体切片失败 —— 下面的断言会全部失真');
assert.ok(bgBody.length > 100, 'runBackgroundBoot() 函数体切片失败');
assert.ok(stopBody.length > 50, 'stop() 函数体切片失败');

// ⚠️ 断言一律基于**剥离注释后的代码行**，不是原文。
//    这一单为解释原因在注释里大量引用了被删掉的代码（比如「原先这里是一个
//    await Promise.all([...])」），直接搜原文会命中自己写的注释，测试永远红。
const startCode = codeLines(startBody);
const bgCode = codeLines(bgBody);
const startCodeText = startCode.join('\n');
const bgCodeText = bgCode.join('\n');

// ── 1. start() 里不许再等那两个 IIFE，且必须提前 return port ──
{
  assert.ok(!startCodeText.includes('await Promise.all([skillsReady, snowlumaReady])'),
    'start() 体内不允许出现 await Promise.all([skillsReady, snowlumaReady]) —— '
    + '它是本单唯一的阻塞点（SnowLuma 冷启动十几到二十几秒），挪回来窗口就会被堵住');
  assert.ok(startCodeText.includes('return port;'), 'start() 必须自己 return port');
  assert.ok(bgCodeText.includes('await Promise.all([skillsReady, snowlumaReady])'),
    '那段等待必须搬进 runBackgroundBoot()，不能删掉了事');

  // ⚠️ 上面那条是字面匹配，换成 `[snowlumaReady, skillsReady]`（换序）或
  //    `Promise.allSettled` 就能绕过，测试仍绿。这里补一条**按位置**的断言：
  //    return port 之前，不许出现任何对后台 Promise 的 await。
  //    （`await listenOn(p)` 是允许的 —— HTTP 监听是"页面能不能打开"的必要条件。）
  const idxReturn = startCode.findIndex((l) => l.includes('return port;'));
  assert.ok(idxReturn >= 0, 'start() 体内找不到 return port;');
  const blockedAwait = startCode.slice(0, idxReturn).filter((l) => l.includes('await')
    && (l.includes('skillsReady') || l.includes('snowlumaReady') || l.includes('bootReady')));
  assert.equal(blockedAwait.length, 0,
    'return port 之前不允许 await 后台 Promise（换序/allSettled 都算回退）。命中行：\n  '
    + blockedAwait.join('\n  '));
  ok('start() 不再等 Skill/SnowLuma，且 return port 仍在体内');
}

// ── 2. onebot.connect 只在后台任务里 ──
{
  assert.ok(!startCodeText.includes('await onebot.connect()'),
    'start() 体内不允许 await onebot.connect()（它属于后台收尾）');
  assert.ok(bgCodeText.includes('await onebot.connect()'),
    'runBackgroundBoot() 必须负责 await onebot.connect()');
  ok('onebot.connect() 只在 runBackgroundBoot 体内');
}

// ── 3. bootReady = runBackgroundBoot(...) 且紧接着 .catch ──
{
  const idxAssign = startCode.findIndex((l) => l.includes('bootReady = runBackgroundBoot('));
  const idxCatch = startCode.findIndex((l) => l.includes('bootReady.catch('));
  assert.ok(idxAssign >= 0, 'start() 必须写 bootReady = runBackgroundBoot(...)');
  assert.ok(idxCatch > idxAssign, 'bootReady.catch(...) 必须跟在赋值之后');
  assert.ok(idxCatch - idxAssign <= 2,
    `catch 必须紧跟在赋值后面（实际隔 ${idxCatch - idxAssign} 行）—— 中间插了别的语句就说明真兜底被移走了`);
  ok('bootReady = runBackgroundBoot(...) 后面紧跟 bootReady.catch(...)');
}

// ── 4. stop() 第一处有效语句是 stopping = true ──
{
  const lines = codeLines(stopBody);
  assert.ok(lines.length > 0, 'stop() 体内应有有效语句');
  assert.ok(/^stopping = true;?$/.test(lines[0]),
    `stop() 的第一条有效语句必须是 "stopping = true"，实际是 ${JSON.stringify(lines[0])}`
    + ' —— 晚于任何 await 都会留出竞态窗口');
  // 2026-11-11 补：退出中要让 /api/status 说实话，否则轮询中的 UI 一直显示「正在启动」
  assert.ok(/bootPhase = 'stopped'/.test(stopBody),
    "stop() 必须把 bootPhase 置成 'stopped'：不改的话退出期 /api/status 仍返回 "
    + "'starting'，UI 会一直显示「⏳ 正在启动」直到窗口关闭");
  ok("stop() 第一条有效语句是 stopping = true，并置 bootPhase = 'stopped'");
}

// ── 5. 返回对象暴露 whenReady ──
{
  assert.ok(/whenReady:\s*\(\)\s*=>\s*bootReady/.test(SRC),
    'createApp 的返回对象必须暴露 whenReady: () => bootReady（electron/server 靠它打第二条 diag）');
  assert.ok(/getBootPhase:\s*\(\)\s*=>\s*bootPhase/.test(SRC),
    '返回对象必须暴露 getBootPhase（/api/status 的 bootPhase 来源）');
  ok('返回对象同时暴露 whenReady 与 getBootPhase');
}

// ── 6. initRunHistory 必须在 onebot.connect 之前 ──
{
  const idxInit = bgCodeText.indexOf('initRunHistory(');
  const idxConn = bgCodeText.indexOf('await onebot.connect()');
  assert.ok(idxInit >= 0, 'runBackgroundBoot 体内必须有 initRunHistory(DATA_DIR)');
  assert.ok(idxConn >= 0, 'runBackgroundBoot 体内必须有 await onebot.connect()');
  assert.ok(idxInit < idxConn,
    'initRunHistory 必须在 onebot.connect 之前 —— 它要把上次未结算的运行记录判成 '
    + 'interrupted，顺序反了会把上次的记录一直挂着');
  ok('runBackgroundBoot：initRunHistory 在 onebot.connect 之前');
}

// ── 7. catch 回调里必须置 bootPhase = 'failed' ──
{
  assert.ok(/bootPhase = 'failed'/.test(startCodeText),
    "bootReady.catch 回调必须置 bootPhase = 'failed' —— 只记日志不置位会让 UI "
    + '永远停在「⏳ 正在启动」，比原来的红色告警更难查');
  ok("失败态置位：start() 体内有 bootPhase = 'failed'");
}

// ── 8. ready 态也必须置位（否则 UI 永远停在启动中）──
{
  assert.ok(/bootPhase = 'ready'/.test(bgCodeText),
    "runBackgroundBoot 末尾必须置 bootPhase = 'ready' 并广播 boot-phase");
  assert.ok(/emit\('boot-phase'/.test(bgCodeText),
    'bgBody 必须 emit boot-phase，UI 才能及时更新横幅');
  ok("就绪态置位：bootPhase = 'ready' + emit('boot-phase')");
}

// ── 9. 「中止」必须能与「就绪」区分开（2026-11-11 补）──
{
  const guards = bgCode.filter((l) => /if \(stopping\) return\b/.test(l));
  assert.ok(guards.length >= 1,
    'runBackgroundBoot 里应有 `if (stopping) return ...` 守卫 —— 后台任务要能在退出时让路');
  const bare = guards.filter((l) => !l.includes('aborted: true'));
  assert.equal(bare.length, 0,
    'stopping 时的 return 必须带 { ok: false, aborted: true }，不能是无值 return。\n'
    + '    无值 return 会让 whenReady() 正常 resolve，electron/main.js 与 src/server.js 于是\n'
    + '    打出一条「后台就绪（Skill / SnowLuma / OneBot）」，而实际一样都没就绪。\n'
    + '    bootDiag 用 appendFileSync 实时落盘 → 这条假记录会污染改前/改后的就绪时间统计。\n'
    + '    命中行：\n  ' + bare.join('\n  '));
  assert.ok(/return \{ ok: true \}/.test(bgCodeText),
    '后台跑完必须 return { ok: true } —— 调用方靠 ok === true 判定「真就绪」，'
    + '没这个值就只能把 undefined 当成成功');
  ok('中止可区分：stopping 的 return 带 aborted，跑完 return ok:true');
}

console.log(`  ── boot-order：${passed} 项通过`);
