// CSP 一致性守护：meta 与响应头必须放行同一个内联主题脚本哈希，
// 且两份策略的其它指令口径一致。否则浏览器按多份策略分别强制执行，
// 内联主题预置会被响应头拒绝（首屏主题失效、控制台报 CSP 错误）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { bootApp } from './_harness.mjs';

const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const headEnd = html.indexOf('</head>');
assert.ok(headEnd > 0, 'ui/index.html 未找到 </head>');
const headHtml = html.slice(0, headEnd);
const inlineScripts = [...headHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const scriptBody = inlineScripts.find((s) => s.includes("localStorage.getItem('qqa-theme')") && s.includes('data-theme'));
assert.ok(scriptBody, 'ui/index.html 未找到内联主题脚本');
const hash = 'sha256-' + crypto.createHash('sha256').update(scriptBody, 'utf8').digest('base64');
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i)?.[1];
assert.ok(meta, 'ui/index.html 未找到 CSP meta');

const directiveOf = (csp, name) => {
  const part = String(csp).split(';').map((s) => s.trim()).find((s) => s === name || s.startsWith(name + ' '));
  return part ? part.replace(/\s+/g, ' ') : '';
};

const ctx = await bootApp({});
try {
  const res = await ctx.request('GET', '/');
  assert.equal(res.status, 200);
  const header = res.headers.get('content-security-policy') || '';
  assert.ok(header, 'GET / 缺少 content-security-policy 响应头');

  assert.ok(directiveOf(header, 'script-src').includes(`'${hash}'`),
    `响应头 script-src 未放行当前内联脚本哈希 ${hash}（内联主题脚本会被拦）`);
  assert.ok(directiveOf(meta, 'script-src').includes(`'${hash}'`),
    `meta script-src 未放行当前内联脚本哈希 ${hash}`);

  const names = ['default-src', 'script-src', 'style-src', 'img-src', 'media-src', 'connect-src',
    'frame-src', 'worker-src', 'font-src', 'object-src', 'base-uri', 'form-action'];
  for (const name of names) {
    assert.equal(directiveOf(header, name), directiveOf(meta, name), `${name} 在 meta 与响应头中口径不一致`);
  }

  const frameSrc = directiveOf(header, 'frame-src');
  assert.ok(!/127\.0\.0\.1|localhost/.test(frameSrc), 'frame-src 不应包含本地来源（SnowLuma 走 webview）');
  assert.match(directiveOf(header, 'frame-ancestors'), /'none'/, '响应头缺少 frame-ancestors \'none\'');

  console.log(`CSP 一致性：通过（内联脚本哈希 ${hash}）`);
} finally {
  await ctx.teardown();
}