// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
// 未捕获异常后进程处于未定义状态（定时器丢失/连接悬空），记录后退出，
// 交给外层（systemd/脚本守护）重启 —— 只打印不退出会"半死不活"地挂着
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

const app = createApp();
// 2026-11-11：start() 现在只等到「HTTP 可访问」就返回（窗口/CLI 都不再被
// Skill 加载和 SnowLuma 冷启动堵住）。所以这里必须说清两件事，否则
// 「启动成功」就是一句谎话 —— 用户会以为工具已就绪，实际还在后台加载。
app.start().then((port) => {
  console.log(`[就绪] HTTP 已监听：http://127.0.0.1:${port}`);
  console.log('[就绪] Skill / SnowLuma / OneBot 仍在后台加载，完成后会自动连上，无需重启');
  console.log('[就绪] 此刻 /api/status 可用，其中 onebot.bootPhase 表示后台进度');
  const bg = app.whenReady?.();
  if (bg && typeof bg.then === 'function') {
    // 三态：ready / aborted（SIGINT 中途退出，不是失败）/ failed。
    // 不分的话 Ctrl+C 时会打出一条"后台全部就绪"，与事实相反。
    bg.then(
      (r) => {
        if (r?.aborted) console.log('[就绪] 后台启动中止（退出中，未就绪）');
        else if (r?.ok === true) console.log('[就绪] 后台全部就绪（Skill / SnowLuma / OneBot）');
        else console.log('[就绪] 后台启动未完成：' + String(r?.reason || 'unknown'));
      },
      (error) => console.error('[就绪] 后台启动失败：', error?.message ?? error)
    );
  }
}).catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('退出中…');
  await app.stop();
  process.exit(0);
});
