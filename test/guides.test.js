'use strict';
// 平台新手引导：常见引导库的遮罩被样式隐藏、点不到的表单变得能点；「我知道了」类弹框在点击前被自动关掉。
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright-core');
const { HAVE_CHROME } = require('./helpers/chrome');
const guides = require('../lib/guides');

test('引导遮罩被隐藏、「我知道了」弹框被点掉，后面的填写照常进行', { skip: !HAVE_CHROME && '没有安装 Google Chrome', timeout: 60000 }, async (t) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  await guides.installHideStyles(ctx);
  const page = await ctx.newPage();
  const logs = [];
  await guides.installDismissHandler(page, (m) => logs.push(m));
  // 用真正的页面加载（不是 setContent）：初始化脚本在每次文档加载时才插入样式，和真实平台页面一样
  await page.route('http://duofa.test/', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <div id="desc" contenteditable="true" style="width:300px;height:60px;border:1px solid">x</div>
    <div id="react-joyride-portal"><div class="react-joyride__overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div></div>
    <div id="tip" style="position:fixed;left:0;top:0;width:400px;height:200px;background:#fff">新功能介绍<button onclick="document.getElementById('tip').remove()">我知道了</button></div>` }));
  await page.goto('http://duofa.test/');
  await page.locator('#desc').click({ timeout: 5000 });
  await page.keyboard.type('hello');
  assert.match(await page.locator('#desc').textContent(), /hello/);
  assert.strictEqual(await page.locator('#tip').count(), 0, '提示弹框已被点掉');
  assert.ok(logs.some((m) => m.includes('我知道了')));
});

test('关掉提示的按钮只认「我知道了 / 跳过」这类说法，不认「确定 / 发表」', () => {
  for (const s of ['我知道了', '知道了', ' 跳过 ', '下次再说']) assert.ok(guides.DISMISS_TEXT.test(s), s);
  for (const s of ['确定', '发表', '好的', '我知道了，继续发表']) assert.ok(!guides.DISMISS_TEXT.test(s), s);
});
