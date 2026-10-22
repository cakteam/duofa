'use strict';
// 测试专用：用 NODE_OPTIONS=--require 预加载进“真正的服务进程”，把 lib/browser.js 的 开浏览器 / 开标签页
// 换成一个装着假平台页面的 headless Chrome 上下文——服务其余部分（/api/publish、runner、真实的三个填表函数）原样运行，
// 不会碰真实平台，也不会动保存着登录态的 chrome-profile。假页面的行为用环境变量 DUOFA_TEST_MOCKS（JSON）调。
const browser = require('../../lib/browser');
const { chromium } = require('playwright-core');
const { installMocks } = require('./mock-platforms');

const cfg = JSON.parse(process.env.DUOFA_TEST_MOCKS || '{}');
let ctxP = null;
const getCtx = () => {
  if (!ctxP) {
    ctxP = (async () => {
      // 用 CHROME_PROFILE_DIR（测试给的临时目录）当用户数据目录：这样测试收尾时能按这个目录把无界面 Chrome 一起清掉
      const ctx = await chromium.launchPersistentContext(process.env.CHROME_PROFILE_DIR, {
        channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 },
        args: ['--autoplay-policy=no-user-gesture-required'], ignoreDefaultArgs: ['--enable-automation'],
      });
      await installMocks(ctx, cfg);
      return ctx;
    })();
  }
  return ctxP;
};
browser.ensureBrowser = async () => getCtx();
browser.openTab = async () => {
  const page = await (await getCtx()).newPage();
  page.screenshot = async () => Buffer.alloc(0); // 不往 logs/ 里写截图
  return page;
};
browser.getStatus = () => ({ connected: true });
