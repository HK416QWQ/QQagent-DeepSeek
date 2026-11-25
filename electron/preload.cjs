// 焦点回收通道（2026-09-26）。
//
// 背景（electron/electron#41602「Confirm/Alert popups break focus」，Windows）：
// Electron 把 alert/confirm/prompt 渲染成**系统同步对话框**，关闭后窗口不认领
// 回键盘焦点 —— 表现就是"弹过任意弹窗后所有输入框打不了字，连点输入框都
// 抢不回焦点"，必须点标题栏 / alt-tab 才恢复。这是 Chromium 侧的 bug，
// 渲染层自己 focus() 救不回来，可靠解是主进程做 BrowserWindow.focus()（OS 级激活）。
//
// 只暴露一个 refocus()：给 ui/app/00-core.js 的对话框包装层调用。
// 用 CommonJS：preload 在各 Electron 版本下都稳，不冒险用 ESM preload。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqAgentShell', {
  refocus: () => {
    try { ipcRenderer.send('app-refocus'); } catch { /* ignore */ }
  },
  // 主进程（Node 网络栈）连通性探测：与渲染层 fetch 结果对照，
  // 定位"Chromium 网络栈被本机软件压制"还是"机器出口对目标域整体异常"
  captchaNetProbe: () => ipcRenderer.invoke('qqa-captcha-net-probe'),
  // session 层阿里域重定向拦截器的注册状态（判断新代码是否真的在跑）
  captchaInterceptorStatus: () => ipcRenderer.invoke('qqa-captcha-interceptor-status'),
  // SnowLuma 控制台自动登录：密码存主进程（safeStorage 加密），渲染层只拿到解密后的字符串。
  // 只在「令牌失效」时兜底用；正常登录态靠 webview 的 persist: partition。
  snowlumaCred: {
    save: (password) => ipcRenderer.invoke('qqa-snowluma-cred-save', password),
    // ⚠️ 只返回 { ok }（存没存过），不返回明文密码 —— 密码只在主进程里用来换 token。
    load: () => ipcRenderer.invoke('qqa-snowluma-cred-load'),
    clear: () => ipcRenderer.invoke('qqa-snowluma-cred-clear'),
    // 用存好的密码换 token（主进程 POST /api/login）。opts.force=true 表示用户手动触发，绕过冷却。
    login: (opts) => ipcRenderer.invoke('qqa-snowluma-login', opts || {})
  }
});
