'use strict';
// 整个服务进程的启动/退出测试：真的起 `node server.js`（无界面 Chrome + 临时目录），验证
//   界面开在独立 Chrome 里 → 再次“打开界面”不会多开 → 退出按钮的接口会关掉 Chrome 并让进程退出 → 关掉浏览器会自动退出。
// 运行：node --test test/launch.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const { HAVE_CHROME } = require('./helpers/chrome');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000, what = '条件') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* 再等 */ }
    await sleep(100);
  }
  throw new Error(`等待超时：${what}`);
};
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function start(extraEnv = {}) {
  return freePort().then((port) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-launch-root-'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-launch-data-'));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-launch-profile-'));
    // 假的 open：记录调用而不真的打开系统浏览器（服务里“Chrome 起不来时改用默认浏览器”的退路也会走它）
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-launch-bin-'));
    const openLog = path.join(fakeBin, 'open.log');
    fs.writeFileSync(path.join(fakeBin, 'open'), `#!/bin/sh\necho "$@" >> "${openLog}"\n`, { mode: 0o755 });
    const env = {
      ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PORT: String(port), DUOFA_CONTENT_DIR: root, DUOFA_STATE_DIR: data, CHROME_PROFILE_DIR: profile, DUOFA_BROWSER_HEADLESS: '1',
      DUOFA_AUTO_QUIT: '1', DUOFA_AUTO_QUIT_GRACE_MS: '800',
      DUOFA_TTY: '', ...extraEnv,
    };
    delete env.NO_OPEN;
    delete env.AUTO_BROWSER;
    delete env.UI_BROWSER;
    const child = spawn(process.execPath, ['server.js'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    const base = `http://127.0.0.1:${port}`;
    const call = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json() };
    };
    const cleanup = () => {
      try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
      try { execFileSync('pkill', ['-f', `user-data-dir=${profile}`], { stdio: 'ignore' }); } catch (_) { /* 没有残留 */ }
      for (const d of [root, data, profile, fakeBin]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (_) { /* Windows 上浏览器可能还占着，留给系统清理 */ } };
    };
    const opened = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').trim() : '');
    return { child, base, port, profile, out: () => out, exited, call, cleanup, opened };
  });
}
const uiLoaded = (s) => until(async () => { const r = await s.call('GET', '/api/app/status'); return r.json.browser.pages.some((p) => p.ui && p.url === `${s.base}/`) ? r.json : null; }, 40000, '界面在独立 Chrome 里加载完');
const chromeAlive = (profile) => { try { execFileSync('pgrep', ['-f', `user-data-dir=${profile}`], { stdio: 'ignore' }); return true; } catch (_) { return false; } };

test('启动：界面开在独立 Chrome 里（第一个标签页）；再次“打开界面”不多开；退出接口让进程和 Chrome 一起退出', { skip: !HAVE_CHROME && '没有安装 Google Chrome', timeout: 120000 }, async () => {
  const s = await start();
  try {
    await until(async () => (await fetch(`${s.base}/api/state`)).ok, 20000, '服务起来');
    const st = await uiLoaded(s);
    assert.strictEqual(st.autoQuit, true);
    assert.deepStrictEqual(st.browser.pages.map((p) => [p.ui, p.url]), [[true, `${s.base}/`]], '只有界面这一个标签页（没有多余的空白页）');
    assert.strictEqual(st.terminal, false);
    assert.strictEqual(s.opened(), '', '界面开在独立 Chrome 里，没有再去开系统默认浏览器');
    const state = await (await fetch(`${s.base}/api/state`)).json();
    assert.strictEqual(state.browser.connected, true);

    // 启动脚本在“已经在运行”时调用：切到已有界面，不新开标签页
    const again = await fetch(`${s.base}/api/app/open-ui`, { method: 'POST' });
    assert.strictEqual(again.status, 200);
    assert.deepStrictEqual(await again.json(), { ok: true, mode: 'chrome' });
    assert.strictEqual((await s.call('GET', '/api/app/status')).json.browser.pages.length, 1);
    // 这个接口也受 Host/Origin 校验：跨站来源被拒
    const cross = await fetch(`${s.base}/api/app/open-ui`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(cross.status, 403);

    // 没带 force 且开着别的标签页/任务时不退出；force 才退出
    const quit = await s.call('POST', '/api/app/quit', { force: true });
    assert.strictEqual(quit.status, 200);
    const code = await Promise.race([s.exited, sleep(15000).then(() => 'timeout')]);
    assert.strictEqual(code, 0, `服务应正常退出，实际：${code}\n${s.out()}`);
    await until(() => !chromeAlive(s.profile), 10000, '独立 Chrome 一起退出');
  } finally { s.cleanup(); }
});

test('自动退出：把独立 Chrome 关掉（用户关窗口 / 退出 Chrome）→ 宽限后服务自己退出', { skip: !HAVE_CHROME && '没有安装 Google Chrome', timeout: 120000 }, async () => {
  const s = await start();
  try {
    await uiLoaded(s);
    // 既有接口：关闭自动化 Chrome（等同用户把整个 Chrome 关了）
    const t0 = Date.now();
    // 机器慢时，服务可能在回这次请求之前就因为“浏览器关了”自己退出了——那正是要测的结果，请求本身失败不算错
    await fetch(`${s.base}/api/browser/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    const code = await Promise.race([s.exited, sleep(20000).then(() => 'timeout')]);
    assert.strictEqual(code, 0, `应自动退出，实际：${code}\n${s.out()}`);
    assert.ok(Date.now() - t0 >= 700, '有宽限时间，不是立刻退出');
    assert.match(s.out(), /浏览器窗口已关闭，自动退出服务/);
    assert.strictEqual(s.opened(), '', '关掉 Chrome 不能触发“改用默认浏览器”');
  } finally { s.cleanup(); }
});

test('不启用自动退出（没有 DUOFA_AUTO_QUIT）时，关掉 Chrome 服务照常运行', { skip: !HAVE_CHROME && '没有安装 Google Chrome', timeout: 120000 }, async () => {
  const s = await start({ DUOFA_AUTO_QUIT: '0' });
  try {
    await uiLoaded(s);
    await fetch(`${s.base}/api/browser/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await sleep(2500);
    assert.strictEqual((await fetch(`${s.base}/api/state`)).ok, true, '服务还在');
    assert.strictEqual((await s.call('GET', '/api/app/status')).json.autoQuit, false);
  } finally { s.cleanup(); }
});

test('Chrome 在打开界面的过程中被关掉：不会退回去开系统默认浏览器，自动退出照常生效', { skip: !HAVE_CHROME && '没有安装 Google Chrome', timeout: 120000 }, async () => {
  const s = await start();
  try {
    // 界面标签页一确定（页面还没加载完）就把 Chrome 关掉，复现“打开到一半被关”的竞态
    await until(async () => (await s.call('GET', '/api/app/status')).json.browser.uiOpen, 40000, '界面标签页确定');
    // 机器慢时，服务可能在回这次请求之前就因为“浏览器关了”自己退出了——那正是要测的结果，请求本身失败不算错
    await fetch(`${s.base}/api/browser/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    const code = await Promise.race([s.exited, sleep(20000).then(() => 'timeout')]);
    assert.strictEqual(code, 0, `应自动退出，实际：${code}\n${s.out()}`);
    assert.strictEqual(s.opened(), '', '没有去开系统默认浏览器');
  } finally { s.cleanup(); }
});
