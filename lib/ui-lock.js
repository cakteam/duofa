'use strict';
/**
 * 平台并行填表时的“前台锁”（可选，默认不用——见下面的 PARALLEL_UI）。
 *
 * 视频号、抖音、B站各开一个标签页同时在跑。开了前台锁（PUBLISH_UI_LOCK=1）时：
 *   - 点击/打字/开弹窗这些“要前台”的动作，一次只允许一个标签页做（拿锁 → 把自己的标签页切到前台 → 做完放锁）；
 *   - 上传视频这类“只是等”的时间不占锁，各平台同时进行。
 * 为什么默认不用：2026-10-10 真实页面实测，后台标签页在 Playwright 驱动的 Chrome 里照常渲染、键鼠事件按标签页各自派发、
 * 没有共用的剪贴板，所以并不需要排队；而排队的代价很实在——一个平台的封面/定时步骤要十几秒，别的平台的点击全在等它
 * （三平台真实运行：不排队 48 秒、各平台定时 12–15 秒内设好；排队 64 秒、定时拖到 38–42 秒才设）。
 * 串行模式下用 NOOP_UI，所有方法都是空操作，行为与原来完全一致。
 */
class UiLock {
  constructor() {
    this.held = false;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      if (!this.held) { this.held = true; resolve(); } else this.queue.push(resolve);
    });
  }

  release() {
    if (!this.held) return;
    const next = this.queue.shift();
    if (next) next(); // 锁直接交给下一位，held 保持 true
    else this.held = false;
  }
}

/** 每个执行单元（条目 × 平台）一个句柄。可重入：已经持有时再 enter 只是把标签页切到前台。 */
function createUi(lock) {
  let held = false;
  const ui = {
    parallel: true,
    page: null,
    async enter(page) {
      if (page) ui.page = page;
      if (!held) { await lock.acquire(); held = true; }
      if (ui.page) await ui.page.bringToFront().catch(() => {});
    },
    leave() {
      if (held) { held = false; lock.release(); }
    },
    /** 临时放开锁去做一段纯等待（比如等按钮变可用），回来再拿；没持有锁时就是直接执行。 */
    async idle(fn) {
      const was = held;
      if (was) ui.leave();
      try { return await fn(); } finally { if (was) await ui.enter(); }
    },
    /** 拿锁、切前台、执行、放锁。可嵌套：里层的 run 不会把外层持有的锁放掉。 */
    async run(page, fn) {
      const outer = !held;
      await ui.enter(page);
      try { return await fn(); } finally { if (outer) ui.leave(); }
    },
  };
  return ui;
}

const NOOP_UI = {
  parallel: false,
  async enter() {},
  leave() {},
  async idle(fn) { return fn(); },
  async run(_page, fn) { return fn(); },
};

/**
 * 并行但不排队：各平台同时填，点击/打字不互斥、也不去抢前台（默认用这个）。
 * 依据：Playwright 驱动的 Chrome 里，后台标签页照常渲染（visibilityState 为 visible、动画帧正常），键鼠事件按标签页各自派发，
 * 不依赖操作系统焦点，也没有共用的剪贴板——所以多个标签页同时点击、打字互不干扰；
 * 而排队反而拖慢：2026-10-10 真实运行里视频号有一条“打开并开始上传”等了 24.7 秒，就是在排队等抖音的封面步骤（14–20 秒）。
 * 想恢复“一次只让一个标签页做、做时切到前台”：环境变量 PUBLISH_UI_LOCK=1。
 */
const PARALLEL_UI = {
  parallel: true,
  async enter() {},
  leave() {},
  async idle(fn) { return fn(); },
  async run(_page, fn) { return fn(); },
};

module.exports = { UiLock, createUi, NOOP_UI, PARALLEL_UI };
