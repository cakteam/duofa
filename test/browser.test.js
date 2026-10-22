'use strict';
// 独立 Chrome 管理的测试：界面作为第一个标签页，发布/抓数据的页面是同一个窗口里的新标签页。
// 用无界面（headless）Chrome 与临时用户数据目录跑，不会弹窗，也不会碰保存着平台登录态的 chrome-profile。运行：node --test test/browser.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-chrome-profile-'));
process.env.CHROME_PROFILE_DIR = profile;
process.env.DUOFA_BROWSER_HEADLESS = '1';
const browser = require('../lib/browser');

const { HAVE_CHROME } = require('./helpers/chrome');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pageServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><title>${req.url === '/ui' ? '工具界面' : '平台页'}</title><body>${req.url}</body>`);
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('PROFILE_DIR 可由环境变量换到别处（测试/预览不动真正的登录态目录）', () => {
  assert.strictEqual(browser.PROFILE_DIR, profile);
});

test('界面开在独立 Chrome 里：第一个标签页是界面，发布页是同窗口的新标签页；关光所有标签页会通知', { skip: !HAVE_CHROME && '没有安装 Google Chrome', timeout: 120000 }, async () => {
  const srv = await pageServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const events = [];
  const off = browser.onPagesChange((i) => events.push(i));
  try {
    const ui = await browser.openUi(`${base}/ui`);
    assert.strictEqual(await ui.title(), '工具界面');
    let s = browser.summary();
    assert.strictEqual(s.connected, true);
    assert.strictEqual(s.uiOpen, true);
    assert.deepStrictEqual(s.pages.map((p) => [p.ui, p.url]), [[true, `${base}/ui`]], '复用了启动时的空白页，没有多出一个空白标签页');

    // 再开一次界面：已经开着就切到前台，不会再多一个标签页
    const again = await browser.openUi(`${base}/ui`);
    assert.strictEqual(again, ui);
    assert.strictEqual(browser.summary().pages.length, 1);

    // 发布：openTab 在同一个浏览器里开新标签页
    const pub = await browser.openTab(`${base}/platform?token=SECRET`);
    assert.strictEqual(await pub.title(), '平台页');
    s = browser.summary();
    assert.strictEqual(s.pages.length, 2);
    assert.ok(s.pages.every((p) => !p.url.includes('SECRET')), '地址里的查询参数（可能有令牌）不会出现在摘要里');

    // 两个页面在同一个浏览器窗口里（而不是各开一个窗口）
    const win = async (page) => {
      const cdp = await page.context().newCDPSession(page);
      try { return (await cdp.send('Browser.getWindowForTarget')).windowId; } finally { await cdp.detach().catch(() => {}); }
    };
    assert.strictEqual(await win(ui), await win(pub), '发布页是界面所在窗口里的新标签页');

    // 关掉发布页：还剩界面；再关界面：通知 pages=0、uiOpen=false
    events.length = 0;
    await pub.close();
    await sleep(200);
    assert.ok(events.some((e) => e.pages === 1 && e.uiOpen), JSON.stringify(events));
    await ui.close();
    await sleep(300);
    const last = events[events.length - 1];
    assert.deepStrictEqual(last, { pages: 0, uiOpen: false });

    // 全关之后再 openUi：重新开一个标签页放界面
    const re = await browser.openUi(`${base}/ui`);
    assert.strictEqual(await re.title(), '工具界面');
    assert.strictEqual(browser.summary().uiOpen, true);
  } finally {
    off();
    await browser.disconnect();
    srv.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  assert.strictEqual(browser.getStatus().connected, false);
});
