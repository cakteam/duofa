'use strict';
/**
 * 浏览器管理：由本服务用「专用用户数据目录」直接拉起本机 Google Chrome
 * （Playwright 管道模式，登录态保存在 chrome-profile/ 长期复用，与日常 Chrome 互不影响）。
 * 没装 Chrome 的 Windows 电脑退而用系统自带的 Microsoft Edge（同样是 Chromium 内核）。
 * 服务启动即自动打开该 Chrome，无需在界面里单独"启动浏览器"。
 */
const { chromium } = require('playwright-core');
const { killByCommandLine } = require('./os-shell');
const guides = require('./guides');
const fs = require('fs');
const path = require('path');

// 专用用户数据目录；测试/预览可用 CHROME_PROFILE_DIR 换到别处，免得动到保存着平台登录态的那份
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR ? path.resolve(process.env.CHROME_PROFILE_DIR) : path.join(__dirname, '..', 'chrome-profile');

const state = { ctx: null, browserObj: null, uiPage: null };
const listeners = new Set();
const BLANK = /^(about:blank|chrome(-untrusted)?:\/\/(newtab|new-tab-page)\/?.*)$/;

const livePages = () => (state.ctx ? state.ctx.pages().filter((p) => !p.isClosed()) : []);
const uiAlive = () => !!(state.uiPage && !state.uiPage.isClosed());

/** 页面集合变了（开/关标签页、整个 Chrome 退出）就通知订阅者：{ pages: 现在还有几个标签页, uiOpen: 工具界面标签页是否还在 } */
function notify() {
  const info = { pages: livePages().length, uiOpen: uiAlive() };
  for (const f of listeners) {
    try { f(info); } catch (_) { /* 订阅者出错不能影响浏览器管理 */ }
  }
}

function onPagesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function watchContext(ctx) {
  const watch = (p) => p.on('close', () => setImmediate(notify));
  ctx.pages().forEach(watch);
  ctx.on('page', (p) => { watch(p); notify(); });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 请退可能残留的旧独立 Chrome（只匹配本工具的 profile 路径，不碰日常 Chrome） */
function killProfileChrome() {
  return new Promise((resolve) => {
    killByCommandLine(`user-data-dir=${PROFILE_DIR}`, () => resolve());
  });
}

async function ensureBrowser(log = () => {}) {
  if (state.ctx) {
    try {
      if (state.browserObj) await state.browserObj.version();
      return state.ctx;
    } catch {
      state.ctx = null;
      state.browserObj = null;
    }
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // 残留的同 profile Chrome 会锁住用户数据目录，先请退再启动
  await killProfileChrome();
  await sleep(1500);

  log('正在打开独立 Chrome（已保存登录态）…');
  let ctx;
  try {
    ctx = await launchContext();
  } catch (e) {
    // profile 锁未释放等偶发情况：再请退一次后重试
    await killProfileChrome();
    await sleep(2500);
    ctx = await launchContext();
  }

  state.ctx = ctx;
  state.browserObj = ctx.browser ? ctx.browser() : null;
  await guides.installHideStyles(ctx).catch(() => {}); // 平台新手引导的遮罩直接隐藏（见 lib/guides.js）
  watchContext(ctx);
  ctx.on('close', () => {
    state.ctx = null;
    state.browserObj = null;
    state.uiPage = null;
    notify();
  });
  log('独立 Chrome 已打开');
  return ctx;
}

// 浏览器：默认 Chrome；DUOFA_BROWSER=msedge 可指定 Edge。Chrome 没装时（Windows 上常见）自动改用 Edge
const CHANNELS = process.env.DUOFA_BROWSER ? [process.env.DUOFA_BROWSER] : process.platform === 'win32' ? ['chrome', 'msedge'] : ['chrome'];

async function launchContext() {
  let lastErr;
  for (const channel of CHANNELS) {
    try {
      return await launchWith(channel);
    } catch (e) {
      lastErr = e;
      if (!/not found|is not installed|executable doesn't exist/i.test(e.message)) throw e;
    }
  }
  throw new Error(`没有找到 Google Chrome，请先安装：https://www.google.com/chrome/（${lastErr && lastErr.message.split('\n')[0]}）`);
}

function launchWith(channel) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel,
    headless: process.env.DUOFA_BROWSER_HEADLESS === '1', // 仅测试用：不弹出窗口
    viewport: null, // 跟随窗口大小
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1560,1000',
      '--disable-blink-features=AutomationControlled',
      // 网站的「显示通知」等权限询问一律拒绝：这类浏览器弹框会挡住第一次上传（2026-10-21 Windows 实测）
      '--deny-permission-prompts',
      '--disable-notifications',
      '--disable-features=Translate',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    timeout: 90000,
  });
}

function getStatus() {
  return { connected: !!state.ctx };
}

/** 现在开着哪些标签页（只给出地址的“来源 + 路径”，不带查询参数，里面可能有令牌）。 */
function summary() {
  const short = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch (_) { return u; } };
  return { connected: !!state.ctx, uiOpen: uiAlive(), pages: livePages().map((p) => ({ ui: p === state.uiPage, url: short(p.url()) })) };
}

/**
 * 把工具界面开在这个独立 Chrome 里：已经开着就切到前台，否则用第一个空白页（没有就新开一个标签页）。
 * 之后“发布/抓数据”打开的平台页都是同一个窗口里的新标签页，不再是两个浏览器。
 */
async function openUi(url, log = () => {}) {
  const ctx = await ensureBrowser(log);
  if (uiAlive()) {
    await state.uiPage.bringToFront().catch(() => {});
    return state.uiPage;
  }
  const page = livePages().find((p) => BLANK.test(p.url())) || (await ctx.newPage());
  state.uiPage = page;
  page.on('close', () => { if (state.uiPage === page) state.uiPage = null; });
  notify(); // 界面标签页已经确定了：订阅者（自动退出）从这一刻起就知道“界面开在这个浏览器里”，不必等页面加载完
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.bringToFront().catch(() => {});
  notify();
  return page;
}

async function disconnect() {
  if (state.ctx) {
    try {
      await state.ctx.close();
    } catch {}
  }
  state.ctx = null;
  state.browserObj = null;
  state.uiPage = null;
}

/** 新开一个标签页 */
async function openTab(url, log = () => {}) {
  const ctx = await ensureBrowser(log);
  const page = await ctx.newPage();
  await guides.installDismissHandler(page, log);
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  return page;
}

/** 打开各平台的登录页（检查/补登录用） */
async function openLoginTabs(log = () => {}) {
  const ctx = await ensureBrowser(log);
  const urls = [
    'https://channels.weixin.qq.com/',
    'https://creator.douyin.com/',
    'https://cp.kuaishou.com/',
    'https://member.bilibili.com/platform/upload/video/frame',
  ];
  for (const url of urls) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  }
  return urls;
}

module.exports = { ensureBrowser, getStatus, disconnect, openTab, openLoginTabs, openUi, summary, onPagesChange, PROFILE_DIR };
