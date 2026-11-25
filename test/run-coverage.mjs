// 覆盖测试的聚合 runner。
//
// 为什么不用 `a && b && c` 串（原来 test:coverage 就是这么写的）：
// `&&` 一红就停，后面的套件根本不跑。后果是每次只看得见第一个红，
// 修完再看才发现后面还红着 —— 而且"本次输出里只有 1 个 FAIL"会让人
// 误判整体状态（实际上还有两套没跑）。覆盖测试本来就是一整套体检，
// 应该全跑完再汇总。
//
// 用法：
//   node test/run-coverage.mjs            # 跑全部
//   node test/run-coverage.mjs wiring     # 只跑名字里带 wiring 的（调试用）
//
// 退出码：全部通过 0，任意一套失败 1。子套件的退出码原样汇总，不改判。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 顺序有依赖：http 会占用端口并做破坏性重置，放前面；wiring 最慢，放最后。 */
const SUITES = [
  'coverage-offline.mjs',
  'coverage-http.mjs',
  'coverage-e2e.mjs',
  'coverage-ui.mjs',
  'mem4-pages-test.mjs',
  'coverage-wiring.mjs'
];

const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = filter.length ? SUITES.filter((s) => filter.some((f) => s.includes(f))) : SUITES;
if (!list.length) {
  console.error(`没有匹配的套件：${filter.join(' ')}`);
  process.exit(1);
}

/** 跑一个套件，原样把输出透到当前终端，返回退出码。 */
function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      stdio: 'inherit',
      env: process.env
    });
    child.on('error', (e) => {
      console.error(`\n[runner] ${file} 起不来：${e.message}`);
      resolve({ code: 1, signal: null });
    });
    child.on('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

const results = [];
const startedAll = Date.now();
for (const file of list) {
  const t0 = Date.now();
  console.log(`\n${'='.repeat(64)}\n[runner] 开始：${file}\n${'='.repeat(64)}`);
  const { code, signal } = await runOne(file);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ file, code, signal, sec });
  console.log(`\n[runner] 结束：${file} → ${code === 0 ? '通过' : `失败（${signal || `exit ${code}`}）`}，用时 ${sec}s`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${'='.repeat(64)}\n覆盖测试汇总\n${'='.repeat(64)}`);
for (const r of results) {
  console.log(`  ${r.code === 0 ? '✅' : '❌'} ${r.file.padEnd(24)} ${r.code === 0 ? '通过' : `失败 exit=${r.code}`}  ${r.sec}s`);
}
console.log(`\n  ${results.length - failed.length}/${results.length} 套件通过，总用时 ${((Date.now() - startedAll) / 1000).toFixed(1)}s`);
if (failed.length) {
  console.log(`\n  未通过：${failed.map((r) => r.file).join(', ')}`);
  process.exit(1);
}
process.exit(0);
