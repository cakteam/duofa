'use strict';
/**
 * 平台的新手引导 / 功能介绍弹框：新账号或新浏览器第一次打开发布页时会弹出来，盖住表单，点击被拦下直到超时
 * （2026-10-21 Windows 实测：快手发布页的 react-joyride 引导挡住「作品描述」，30 秒超时失败）。两层处理：
 *  1. 常见引导库（react-joyride / driver.js / intro.js / shepherd）的遮罩和气泡直接用样式隐藏，所有页面、所有 frame 都生效；
 *  2. 别的引导弹框：要点击时如果看到「我知道了 / 跳过」这类按钮，先替你点掉再继续（Playwright 的 locator handler）。
 */

const HIDE_CSS = [
  '#react-joyride-portal', '.react-joyride__overlay', '.react-joyride__spotlight', '.__floater',
  '.driver-overlay', '.driver-popover', '#driver-page-overlay', '#driver-highlighted-element-stage', '#driver-popover-item',
  '.introjs-overlay', '.introjs-helperLayer', '.introjs-tooltipReferenceLayer', '.introjs-tooltip',
  '.shepherd-modal-overlay-container', '.shepherd-element',
].join(',') + '{display:none!important;pointer-events:none!important}';

// 只认“关掉提示”的说法，不认「确定 / 好的」这类可能是正经确认的按钮
const DISMISS_TEXT = /^\s*(我知道了|知道了|跳过|跳过引导|下次再说|以后再说|稍后再说|暂不需要|关闭引导)\s*$/;

/** 浏览器上下文级：每个页面、每个 frame 一加载就插入隐藏样式 */
async function installHideStyles(ctx) {
  await ctx.addInitScript((css) => {
    const add = () => {
      if (document.getElementById('__duofa_hide_guides')) return;
      const st = document.createElement('style');
      st.id = '__duofa_hide_guides';
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.documentElement) add();
    document.addEventListener('DOMContentLoaded', add);
    window.addEventListener('load', add); // 页面脚本重写过 <head> 时补回来
  }, HIDE_CSS);
}

/** 页面级：点击被引导弹框挡住前，先点掉它的「我知道了 / 跳过」 */
async function installDismissHandler(page, log = () => {}) {
  if (typeof page.addLocatorHandler !== 'function') return;
  const btn = page.getByRole('button', { name: DISMISS_TEXT }).or(page.locator('button, [role="button"], a, span').filter({ hasText: DISMISS_TEXT })).first();
  await page.addLocatorHandler(btn, async (el) => {
    const text = ((await el.textContent().catch(() => '')) || '').trim();
    await el.click({ timeout: 3000 }).catch(() => {});
    log(`已关掉平台的引导弹框（${text || '提示'}）`);
  }, { noWaitAfter: true, times: 10 }).catch(() => {});
}

module.exports = { installHideStyles, installDismissHandler, HIDE_CSS, DISMISS_TEXT };
