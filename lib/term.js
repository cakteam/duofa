'use strict';
/**
 * 启动器那个 Terminal 窗口的收尾：服务退出后把窗口关掉；启动成功后可以先把它最小化（省得挡着）。
 *
 * 用 AppleScript 按 tty 找到那个窗口（启动脚本把 `tty` 的结果放在环境变量 DUOFA_TTY 里），
 * 在“新会话里的分离进程”里延迟执行：服务进程与启动脚本都退出后窗口里才没有在运行的程序，Terminal 就不会弹“要终止进程吗”。
 * 不是 macOS、没有 DUOFA_TTY、tty 格式不对时什么都不做；执行失败也不影响服务本身（最坏就是窗口还留着）。
 */
const { spawn } = require('child_process');

const TTY_RE = /^\/dev\/ttys\d+$/;

/** 生成 AppleScript（每行一个元素）。action：close | minimize。 */
function script(tty, action, delaySec = 1.2) {
  if (!TTY_RE.test(tty)) throw new Error(`tty 格式不对：${tty}`);
  const find = (body) => [
    'tell application "Terminal"',
    'repeat with w in windows',
    'try',
    'repeat with t in tabs of w',
    `if (tty of t) is "${tty}" then`,
    ...body,
    'return',
    'end if',
    'end repeat',
    'end try',
    'end repeat',
    'end tell',
  ];
  if (action === 'minimize') return find(['set miniaturized of w to true']);
  if (action === 'close') {
    return [`delay ${delaySec}`, ...find(['if (count of tabs of w) is 1 then', 'close w saving no', 'else', 'close t saving no', 'end if'])];
  }
  throw new Error(`未知动作：${action}`);
}

/** 在分离进程里执行。返回是否已经发出（不代表一定成功）。 */
function run(tty, action, { delaySec = 1.2, platform = process.platform, spawnFn = spawn } = {}) {
  if (platform !== 'darwin' || !TTY_RE.test(String(tty || ''))) return false;
  try {
    const args = script(tty, action, delaySec).flatMap((l) => ['-e', l]);
    const child = spawnFn('osascript', args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { script, run, closeWindow: (tty, opts) => run(tty, 'close', opts), minimizeWindow: (tty, opts) => run(tty, 'minimize', opts), TTY_RE };

// 命令行：node lib/term.js close|minimize [tty]（tty 缺省取 DUOFA_TTY）——启动脚本在“已经在运行，只是切到它的窗口”时用来关掉自己这个终端窗口
if (require.main === module) {
  const [action, tty] = process.argv.slice(2);
  const ok = run(tty || process.env.DUOFA_TTY, action || 'close');
  process.exit(ok ? 0 : 1);
}
