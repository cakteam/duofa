'use strict';
// 退出按钮、自动退出与终端窗口收尾的测试。运行：node --test test/lifecycle.test.js
const test = require('node:test');
const assert = require('node:assert');

const lifecycle = require('../lib/lifecycle');
const term = require('../lib/term');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakes({ jobs = [], pages = [], publishing = false, env = {} } = {}) {
  const calls = [];
  const st = { jobs, pages, publishing };
  const engine = { list: () => st.jobs, shutdown: () => calls.push('engine.shutdown') };
  const browser = {
    summary: () => ({ connected: st.pages.length > 0, uiOpen: st.pages.some((p) => p.ui), pages: st.pages }),
    disconnect: async () => { calls.push('browser.disconnect'); },
  };
  const lc = lifecycle.create({
    engine, browser, isPublishing: () => st.publishing, env: { DUOFA_AUTO_QUIT: '1', DUOFA_TTY: '/dev/ttys009', ...env },
    log: () => {}, exit: (c) => calls.push(`exit(${c})`), closeTerminal: () => calls.push('closeTerminal'), graceMs: 40, quitDelayMs: 5,
  });
  return { lc, st, calls };
}
const ui = { ui: true, url: 'http://127.0.0.1:8787/' };
const other = { ui: false, url: 'https://channels.weixin.qq.com/' };

test('退出：有任务在跑 / 发布没处理完 / 还开着平台标签页时先不退出，把原因交给页面；force 才真退出，顺序是 任务→浏览器→终端→进程', async () => {
  const f = fakes({ jobs: [{ id: 'j1', label: '配音 + 字幕', status: 'running' }], pages: [ui, other], publishing: true });
  const r = f.lc.quit();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual([r.busy.jobs.length, r.busy.publishing, r.busy.otherTabs], [1, true, 1]);
  await sleep(30);
  assert.deepStrictEqual(f.calls, [], '没有确认前什么都不动');
  assert.deepStrictEqual(f.lc.status().jobs.map((j) => j.label), ['配音 + 字幕']);
  assert.strictEqual(f.lc.quit({ force: true }).ok, true);
  assert.strictEqual(f.lc.quit({ force: true }).already, true, '重复点不会重复退出');
  await sleep(60);
  assert.deepStrictEqual(f.calls, ['engine.shutdown', 'browser.disconnect', 'closeTerminal', 'exit(0)']);
  // 什么都没在做时，不带 force 也能直接退出
  const idle = fakes({ pages: [ui] });
  assert.strictEqual(idle.lc.quit().ok, true);
  await sleep(40);
  assert.ok(idle.calls.includes('exit(0)'));
});

test('自动退出：界面开在独立 Chrome 里之后，浏览器标签页全关 → 宽限后退出；宽限内重新开窗口则取消；有任务在跑就等做完', async () => {
  const f = fakes({ pages: [ui] });
  f.lc.onPages({ pages: 1, uiOpen: true });
  f.st.pages = [];
  f.lc.onPages({ pages: 0, uiOpen: false });
  assert.strictEqual(f.lc._state().armed, true);
  await sleep(15);
  f.st.pages = [ui];
  f.lc.onPages({ pages: 1, uiOpen: true });                  // 宽限内重新开了窗口
  assert.strictEqual(f.lc._state().armed, false);
  await sleep(70);
  assert.deepStrictEqual(f.calls, [], '取消了，没有退出');

  // 又关光了，但这时还有任务在跑：不退出，等做完
  f.st.pages = [];
  f.st.jobs = [{ id: 'j', label: 'x', status: 'running' }];
  f.lc.onPages({ pages: 0, uiOpen: false });
  await sleep(70);
  assert.deepStrictEqual(f.calls, [], '有任务在跑，不退出');
  f.st.jobs = [];
  await sleep(80);
  assert.deepStrictEqual(f.calls, ['engine.shutdown', 'browser.disconnect', 'closeTerminal', 'exit(0)'], '任务做完后退出');
});

test('自动退出不会误触发：没启用 / 从来没把界面开在独立 Chrome 里 / 已经在退出', async () => {
  const off = fakes({ env: { DUOFA_AUTO_QUIT: '0' } });
  off.lc.onPages({ pages: 1, uiOpen: true });
  off.lc.onPages({ pages: 0, uiOpen: false });
  await sleep(80);
  assert.deepStrictEqual(off.calls, []);
  const never = fakes();
  never.lc.onPages({ pages: 0, uiOpen: false });          // 界面从没开在这个浏览器里（比如开在默认浏览器），不管它
  await sleep(80);
  assert.deepStrictEqual(never.calls, []);
  assert.strictEqual(never.lc._state().armed, false);
});

test('终端窗口收尾：只处理 /dev/ttysN；不是 macOS 或 tty 不对什么都不做；用分离进程执行', () => {
  const sent = [];
  const fakeSpawn = (cmd, args, opts) => { sent.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  assert.strictEqual(term.run('/dev/ttys004', 'close', { spawnFn: fakeSpawn, platform: 'darwin' }), true);
  assert.strictEqual(sent[0].cmd, 'osascript');
  assert.strictEqual(sent[0].opts.detached, true, '要在新会话里跑，终端才不会把它算成窗口里还在运行的程序');
  assert.ok(sent[0].args.filter((a) => a !== '-e').join('\n').includes('"/dev/ttys004"'));
  for (const bad of [undefined, '', '/dev/null', '/dev/ttys1; rm -rf /', '$(whoami)']) {
    assert.strictEqual(term.run(bad, 'close', { spawnFn: fakeSpawn, platform: 'darwin' }), false, `拒绝：${bad}`);
  }
  assert.strictEqual(term.run('/dev/ttys004', 'close', { spawnFn: fakeSpawn, platform: 'linux' }), false);
  assert.strictEqual(sent.length, 1);
  assert.throws(() => term.script('/dev/ttys004', '乱来'), /未知动作/);
});
