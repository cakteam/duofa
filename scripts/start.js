'use strict';
/**
 * 启动器（Mac 的「启动多发.command」和 Windows 的「启动多发.bat」都只是调用它）：
 *   1. 检查 Node.js 版本  2. 第一次运行时安装依赖  3. 已经在运行就把界面切到前面  4. 否则启动服务
 * 出错时退出码非 0，外层脚本会停住让人看清提示。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const say = (s) => console.log(s);

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    say(`当前 Node.js 版本是 ${process.version}，多发需要 22 或更新版本：https://nodejs.org/zh-cn/download`);
    process.exit(1);
  }
}

function installDeps() {
  if (fs.existsSync(path.join(APP, 'node_modules', 'express'))) return;
  say('首次启动，安装依赖中（需要一两分钟）…');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: APP, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    say('依赖安装失败。请检查网络后重试；国内网络可以先运行：npm config set registry https://registry.npmmirror.com');
    process.exit(1);
  }
}

/** 端口上是不是已经有一个多发在运行：是就让它把界面带到前面 */
async function alreadyRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
  } catch {
    return false;
  }
  say('多发已在运行，切到它的窗口…');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/app/open-ui`, { method: 'POST', signal: AbortSignal.timeout(10000) });
    if (r.ok) return true;
  } catch { /* 下面退回用默认浏览器打开 */ }
  require('../lib/os-shell').openUrl(`http://127.0.0.1:${port}/`);
  return true;
}

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
  });
}

(async () => {
  checkNode();
  installDeps();
  const { port } = require('../lib/config').load();
  if (await alreadyRunning(port)) {
    require('../lib/term').closeWindow(process.env.DUOFA_TTY);
    process.exit(0);
  }
  if (await portBusy(port)) {
    say(`端口 ${port} 被别的程序占用了。可以在 config.json 里把 port 改成别的数字（如 8687）再启动。`);
    process.exit(1);
  }
  process.env.DUOFA_AUTO_QUIT = '1'; // 关掉独立 Chrome 窗口就自动退出服务
  say('多发启动中… 界面会开在独立 Chrome 里；退出请点界面左上角的电源图标，或直接关掉那个 Chrome 窗口。');
  require('../server');
})();
