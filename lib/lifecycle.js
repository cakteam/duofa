'use strict';
/**
 * 服务的生命周期：退出按钮、以及“浏览器窗口关了就自动退出”。
 *
 *  - quit()：有任务在跑、发布还没处理完、还开着别的平台标签页时，先不退出，把这些情况交给页面去问用户；用户确认后 force 退出：
 *            中止任务 → 关掉独立 Chrome → 关掉启动用的终端窗口 → 进程退出。
 *  - 自动退出（环境变量 DUOFA_AUTO_QUIT=1，只有启动脚本会设）：工具界面开在独立 Chrome 里之后，如果那个浏览器的标签页全部关了，
 *    宽限几秒（期间重新开窗口就取消）后自动退出；有任务在跑或发布没处理完就等它们结束。这样关掉浏览器就等于关掉了整个工具，不会忘了关终端。
 *    在默认浏览器里打开的界面不受影响（服务看不到那个浏览器的开关）。
 */
const term = require('./term');

function create({ engine = { list: () => [], shutdown: () => {} }, browser, isPublishing = () => false, env = process.env, log = () => {}, exit = (c) => process.exit(c), closeTerminal = () => term.closeWindow(env.DUOFA_TTY), graceMs, quitDelayMs = 400 }) {
  const autoQuit = env.DUOFA_AUTO_QUIT === '1';
  const grace = graceMs != null ? graceMs : Number(env.DUOFA_AUTO_QUIT_GRACE_MS) || 15000;
  let timer = null;
  let sawUi = false;
  let quitting = false;

  const activeJobs = () => engine.list({ limit: 200 }).filter((j) => j.status === 'running' || j.status === 'queued').map((j) => ({ id: j.id, label: j.label, status: j.status }));

  function status() {
    const b = browser.summary();
    return {
      autoQuit, quitting,
      jobs: activeJobs(),
      publishing: !!isPublishing(),
      browser: { connected: b.connected, uiOpen: b.uiOpen, otherTabs: b.pages.filter((p) => !p.ui).length, pages: b.pages },
      terminal: !!env.DUOFA_TTY,
    };
  }

  /** force=false：有事在做就不退出，返回原因；force=true：照做。 */
  function quit({ force = false } = {}) {
    if (quitting) return { ok: true, already: true };
    const st = status();
    const busy = st.jobs.length > 0 || st.publishing || st.browser.otherTabs > 0;
    if (!force && busy) return { ok: false, busy: { jobs: st.jobs, publishing: st.publishing, otherTabs: st.browser.otherTabs } };
    quitting = true;
    clearTimeout(timer);
    log('info', '收到退出请求，正在关闭服务…');
    // 先让这次请求的响应发出去，再收尾
    setTimeout(async () => {
      try { engine.shutdown(); } catch (_) { /* 尽力而为 */ }
      try { await browser.disconnect(); } catch (_) { /* 尽力而为 */ }
      try { closeTerminal(); } catch (_) { /* 窗口关不掉也要退出 */ }
      exit(0);
    }, quitDelayMs);
    return { ok: true };
  }

  function check() {
    timer = null;
    if (quitting) return;
    if (browser.summary().pages.length > 0) return; // 又有标签页了
    if (activeJobs().length || isPublishing()) { timer = setTimeout(check, Math.min(grace, 10000)); return; } // 还有事在做：等做完
    log('info', '浏览器窗口已关闭，自动退出服务');
    quit({ force: true });
  }

  /** 订阅 browser.onPagesChange。 */
  function onPages({ pages, uiOpen }) {
    if (uiOpen) sawUi = true;
    if (!autoQuit || !sawUi || quitting) return;
    if (pages > 0) { clearTimeout(timer); timer = null; return; }
    if (!timer) timer = setTimeout(check, grace);
  }

  return { status, quit, onPages, autoQuit, _state: () => ({ sawUi, quitting, armed: !!timer }) };
}

module.exports = { create };
