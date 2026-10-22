'use strict';
/**
 * 跟操作系统打交道的几件小事，按 macOS / Windows / Linux 分别处理：
 *  - openUrl：用系统默认浏览器打开网址
 *  - reveal：在 Finder / 资源管理器里显示一个文件或文件夹
 *  - killByCommandLine：结束命令行里带某段文字的进程（只用来请退本工具自己那个独立 Chrome）
 * 失败只回调错误，不抛出。
 */
const { execFile, spawn } = require('child_process');
const path = require('path');

const done = (cb) => (err) => { if (cb) cb(err || null); };

function openUrl(url, cb, platform = process.platform) {
  if (platform === 'darwin') return execFile('open', [url], done(cb));
  if (platform === 'win32') return execFile('rundll32', ['url.dll,FileProtocolHandler', url], done(cb));
  return execFile('xdg-open', [url], done(cb));
}

function reveal(p, cb, platform = process.platform) {
  if (platform === 'darwin') return execFile('open', ['-R', p], done(cb));
  if (platform === 'win32') {
    // explorer 要的是 /select,"路径" 这种写法，不能让 Node 再给整段加引号；它成功时退出码也是 1，所以不看退出码
    const child = spawn('explorer.exe', [`/select,"${p}"`], { windowsVerbatimArguments: true, stdio: 'ignore' });
    child.on('error', (e) => done(cb)(e));
    child.on('exit', () => done(cb)());
    return child;
  }
  return execFile('xdg-open', [path.dirname(p)], done(cb));
}

function killByCommandLine(fragment, cb, platform = process.platform) {
  if (platform === 'win32') {
    const lit = String(fragment).replace(/'/g, "''");
    const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${lit}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    return execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, done(cb));
  }
  return execFile('pkill', ['-f', fragment], done(cb));
}

/** 界面上「在 Finder 中显示」这类按钮用的叫法 */
const FILE_MANAGER = { darwin: 'Finder', win32: '资源管理器' }[process.platform] || '文件管理器';

module.exports = { openUrl, reveal, killByCommandLine, FILE_MANAGER };
