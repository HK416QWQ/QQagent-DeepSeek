// 语音占位符三态 + read_voice 工具注册（2026-11-11）
//
// 背景：19 条语音里 18 条转写失败，原来一律退回纯 `[语音]`，
//   模型不知道是"没读"还是"没人说话"，人也无法排查。改成分三态：
//   · null                    插件没参与 → [语音]（与接入前一字不差）
//   · {ok:true, text}         成功 → [语音转文字] xxx
//   · {ok:true, text:''}      成功但没人声 → [语音·没有检测到人声]
//   · {ok:false, code}        失败 → [语音·转写失败:原因]
//
// 本测试锁住：三态分流、error 里的方括号被剥离（防污染上下文）、
//   以及 read_voice 工具已注册且字段正确（它是"失败后重读"的唯一入口）。
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(pathToFileURL(import.meta.url).pathname), '..');
process.env.QQ_AGENT_DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');

const { voicePlaceholder } = await import('../src/onebot.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ── 三态：没参与 ──
assert.equal(voicePlaceholder(null), '[语音]', 'null = 插件没参与，退回纯 [语音]');
assert.equal(voicePlaceholder(undefined), '[语音]', 'undefined 同 null');
ok('没参与（null/undefined）→ 纯 [语音]，与接入前一字不差');

// ── 三态：成功 ──
assert.equal(voicePlaceholder({ ok: true, text: '超生开播了，真的假的？' }), '[语音转文字] 超生开播了，真的假的？');
assert.equal(voicePlaceholder({ ok: true, text: '' }), '[语音·没有检测到人声]');
ok('成功：有文本出文本，空文本出「没有检测到人声」');

// ── 三态：失败 ──
assert.equal(voicePlaceholder({ ok: false, code: 'no_source' }), '[语音·转写失败:取不到音频文件]');
assert.equal(voicePlaceholder({ ok: false, code: 'no_provider' }), '[语音·转写失败:识别插件未启用]');
assert.equal(voicePlaceholder({ ok: false, code: '' }), '[语音·转写失败:原因不明]', '无 code 无 error 回落「原因不明」');
ok('失败：按 code 映射短语，无 code 回落「原因不明」');

// ── 失败：error 里的方括号必须被剥掉（防污染上下文 / 防被误当占位符）──
assert.equal(
  voicePlaceholder({ ok: false, code: '', error: '未知 [错误] 情况' }),
  '[语音·转写失败:未知 错误 情况]',
  'error 里的 [ ] 要剥掉'
);
assert.ok(
  !voicePlaceholder({ ok: false, code: '', error: '[图片] [语音] 混进来了' }).includes('[图片]'),
  'error 里不能残留任何占位符'
);
ok('失败：error 里的方括号被剥离，不残留占位符');

// ── read_voice 工具注册 ──
const tools = await import('../src/tools.js');
const registry = await import('../src/tool-registry.js');
tools.buildToolDefs();   // 触发 registerAllTools（幂等）
const def = registry.getTool('read_voice');
assert.ok(def, 'read_voice 工具应已注册');
assert.equal(def.category, 'query', '归类 query');
assert.equal(def.requiresVision, false, '语音转写不需要视觉模型');
assert.deepEqual(def.parameters.required, ['messageId'], '必填 messageId');
ok('read_voice 工具已注册，字段正确');

console.log(`\n── voice-placeholder：${passed} 项通过 ✅`);
