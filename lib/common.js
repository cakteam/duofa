'use strict';
/**
 * 平台无关的小工具。
 */

/**
 * 点击页面空白处（收起时间选择等浮层并让选择生效）。
 * 自动在视口左右两侧寻找「安全空白点」：该处元素不是链接/按钮/输入框等
 * 交互控件、不在弹层/对话框/选择器面板内、鼠标样式不是手型/文本型。
 * 找不到安全点时返回 false，由调用方兜底（如按 Esc）。
 */
async function clickBlankArea(page) {
  try {
    const spot = await page.evaluate(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const bad = (el) => {
        if (!el) return true;
        if (
          el.closest(
            '.bcc-dialog, .weui-desktop-dialog, .semi-portal, [class*="picker"], [class*="popover"], [class*="popper"], [class*="dropdown"], [class*="overlay"], [class*="modal"], [class*="dialog"]'
          )
        )
          return true;
        if (/^(A|BUTTON|INPUT|TEXTAREA|SELECT|LABEL|IMG|VIDEO|CANVAS|SVG|IFRAME)$/.test(el.tagName)) return true;
        const cs = getComputedStyle(el);
        if (cs.cursor === 'pointer' || cs.cursor === 'text') return true;
        return false;
      };
      // 左右两侧由外向内探测（避开最外圈滚动条区域），竖直方向取页面中带
      const cols = [20, 45, 70, w - 80, w - 50];
      const rows = [Math.round(h * 0.5), Math.round(h * 0.4), Math.round(h * 0.6), Math.round(h * 0.3), Math.round(h * 0.7)];
      for (const y of rows) {
        for (const x of cols) {
          const el = document.elementFromPoint(x, y);
          if (!bad(el)) return { x, y };
        }
      }
      return null;
    });
    if (spot) {
      await page.mouse.click(spot.x, spot.y);
      return true;
    }
  } catch {}
  return false;
}

/**
 * 把页面里（含 shadow DOM 与各 iframe）所有 <video> / <audio> 暂停。平台页在视频上传完成后常常自动开始播放预览，而且有声音。
 * 直接 pause()，比“点一下视频”可靠：点一下是切换，已经暂停时再点反而会开始播放。
 * 盯守期间（ms > 0）还会把它们静音，并在页面里开一个定时器：预览只要又开始播放就再暂停；盯守结束时把静音状态恢复成原来的——
 * 这样视频保持暂停，之后你想点播放看看，是有声音的（不会因为被我们静音而以为视频坏了）。
 * 返回处理了几个媒体元素。
 */
const IN_PAGE_SILENCE = (ms) => {
  const each = (fn) => {
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') { try { fn(el); } catch (e) { /* 跨域或已销毁 */ } }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
  };
  const silence = () => {
    let n = 0;
    each((el) => {
      if (el.__wfWasMuted === undefined) el.__wfWasMuted = el.muted;
      el.muted = true;
      if (!el.paused) el.pause();
      n++;
    });
    return n;
  };
  const restore = () => each((el) => {
    if (el.__wfWasMuted !== undefined) {
      if (el.paused) el.muted = el.__wfWasMuted;
      el.__wfWasMuted = undefined;
    }
  });
  const n = silence();
  if (ms > 0) {
    if (window.__wfVideoGuard) clearInterval(window.__wfVideoGuard);
    const until = Date.now() + ms;
    window.__wfVideoGuard = setInterval(() => {
      if (Date.now() > until) { clearInterval(window.__wfVideoGuard); window.__wfVideoGuard = null; restore(); } else silence();
    }, 400);
  }
  return n;
};

async function silenceVideos(page, guardMs = 0) {
  let total = 0;
  for (const fr of page.frames()) {
    try { total += await fr.evaluate(IN_PAGE_SILENCE, guardMs); } catch { /* 这个 frame 已经销毁或不能执行脚本 */ }
  }
  return total;
}

/** 分段计时：每个阶段记一笔，最后给出“阶段 用时｜阶段 用时”的一行说明，方便看时间花在哪。 */
function createTimer() {
  const t0 = Date.now();
  let last = t0;
  const laps = [];
  return {
    lap(label) { const now = Date.now(); laps.push([label, (now - last) / 1000]); last = now; },
    total: () => (Date.now() - t0) / 1000,
    summary: () => laps.map(([l, s]) => `${l} ${s.toFixed(1)}s`).join('｜'),
  };
}

/** 轮询等一个元素“可见且可点击”，最多 ms 毫秒；返回是否等到。比 Playwright 默认 30 秒的自动等待更可控：到点就走，不会悄悄卡半分钟。 */
async function waitClickable(locator, ms, pollMs = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if ((await locator.count()) && (await locator.isVisible()) && (await locator.isEnabled())) {
        const cls = (await locator.getAttribute('class', { timeout: 1000 }).catch(() => '')) || '';
        if (!/disabled/.test(cls)) return true;
      }
    } catch { /* 页面在变化，下一轮再看 */ }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** 轮询等一个元素消失（不可见），最多 ms 毫秒。 */
async function waitGone(locator, ms, pollMs = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (!(await locator.count()) || !(await locator.isVisible())) return true;
    } catch { return true; }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

module.exports = { clickBlankArea, silenceVideos, createTimer, waitClickable, waitGone, IN_PAGE_SILENCE };
