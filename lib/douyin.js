'use strict';
/**
 * 抖音创作者中心（creator.douyin.com）自动填入流程。
 * 选择器依据 social-auto-upload 项目 2026-06 实测，多处兜底：
 *   上传页 input → 跳转发布页(v1: /content/publish, v2: /content/post/video) →
 *   标题 input[placeholder*=填写作品标题] → 描述 div.zone-container(contenteditable) →
 *   #话题(键入+空格确认) → 等上传完成(重新上传出现) → 定时发布 → 截图。
 * 只填表，不点「发布」。
 */
const path = require('path');
const fs = require('fs');
const { clickBlankArea, silenceVideos, createTimer } = require('./common');
const { NOOP_UI } = require('./ui-lock');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

/** 找到上传文件入口；期间若被要求登录/验证，提示用户在浏览器窗口手动处理并等待 */
async function findUploadInput(page, log, ui = NOOP_UI, waitSec = 240) {
  const selectors = [
    'input.upload-btn-input',
    "div[class^='container'] input[accept]",
    "div[class^='container'] input[type='file']",
    "div[class^='container'] input",
  ];
  const deadline = Date.now() + waitSec * 1000;
  let announced = false;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count()) return el;
      } catch {}
    }
    const url = page.url();
    const needLogin = !url.includes('/creator-micro') || url.includes('login');
    if (needLogin && !announced) {
      announced = true;
      log('⏳ 抖音要求登录/验证：请在打开的 Chrome 窗口中扫码或完成验证（脚本会自动等待）…');
      await ui.run(page, async () => {}); // 并行时把这个标签页切到前台，方便你扫码（等待本身不占前台锁，别的平台继续在后台跑）
    }
    await sleep(2000);
  }
  await shot(page, 'douyin-no-upload-input');
  const err = new Error('未找到抖音上传入口（可能未登录/需要验证/页面改版），截图见 logs/douyin-no-upload-input.png');
  err.code = 'NO_FILE_INPUT';
  throw err;
}

async function waitPublishPage(page, log) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('/content/publish') || url.includes('/content/post/video')) {
      log(`已进入发布表单页（${url.includes('/content/post/video') ? '新版' : '旧版'}）`);
      return;
    }
    await sleep(500);
  }
  log('⚠️ 未能确认跳转到发布表单页，仍尝试继续填写');
}

async function waitUploadComplete(page, log, timeoutSec = 1800) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastReport = 0;
  while (Date.now() < deadline) {
    try {
      if ((await page.locator('[class^="long-card"] div:has-text("重新上传")').count()) > 0) {
        log('视频上传完成');
        return;
      }
      if ((await page.locator('div.progress-div > div:has-text("上传失败")').count()) > 0) {
        await shot(page, 'douyin-upload-error');
        throw new Error('抖音检测到上传失败，请查看截图 logs/douyin-upload-error.png 后重试');
      }
    } catch (e) {
      if (e.message && e.message.includes('上传失败')) throw e;
    }
    const now = Date.now();
    if (now - lastReport > 30000) {
      log(`视频上传中…（已等 ${Math.round((timeoutSec * 1000 - (deadline - now)) / 1000)} 秒）`);
      lastReport = now;
    }
    await sleep(2000);
  }
  await shot(page, 'douyin-upload-timeout');
  throw new Error(`抖音上传超过 ${timeoutSec} 秒仍未完成`);
}

async function fillTitleDescTags(page, fields, log) {
  // 标题（等待时间放宽：新版页面上传完成后才渲染表单）
  const titleInput = page.locator('input[placeholder*="填写作品标题"]').first();
  await titleInput.waitFor({ state: 'visible', timeout: 600000 });
  await titleInput.fill(fields.title);
  log(`已填写标题（${fields.title.length} 字）`);

  const editor = page.locator('div.zone-container[contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 60000 });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');

  if (fields.desc) {
    await page.keyboard.type(fields.desc);
    log(`已填写描述（${fields.desc.length} 字）`);
  }
  for (const tag of fields.tags || []) {
    await page.keyboard.type(' #' + tag);
    await sleep(400);
    await page.keyboard.press('Space'); // 确认话题
    await sleep(300);
  }
  log(`已添加话题 ${((fields.tags && fields.tags.length) || 0)} 个`);
  await page.keyboard.press('Escape'); // 收起话题下拉
}

/** 抖音定时现在是不是已经设成想要的：日期时间框里是目标时间。读不到就当没设。 */
async function scheduleStill(page, when) {
  try {
    const dt = page.locator('.semi-input[placeholder="日期和时间"]').first();
    if (!(await dt.count()) || !(await dt.isVisible().catch(() => false))) return false;
    const want = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    return (await dt.inputValue({ timeout: 2000 }).catch(() => '')).trim() === want;
  } catch {
    return false;
  }
}

async function setScheduleTime(page, when, log) {
  try {
    const radio = page.locator("[class^='radio']:has-text('定时发布')").first();
    if (!(await radio.count())) {
      log('⚠️ 未找到「定时发布」选项，保持默认立即发布，请手动调整');
      return false;
    }
    await radio.click();
    await sleep(1000);

    const dt = page.locator('.semi-input[placeholder="日期和时间"]').first();
    await dt.click();
    await page.keyboard.press('ControlOrMeta+A');
    const text = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await sleep(1000);
    // 点旁边空白处收起时间选择浮层，让定时生效（点不到再按 Esc 兜底）
    if (!(await clickBlankArea(page))) {
      await page.keyboard.press('Escape').catch(() => {});
    }
    await sleep(600);
    log(`定时发布已填写：${text}`);
    return true;
  } catch (e) {
    await shot(page, 'douyin-schedule-fail');
    log(`⚠️ 定时发布填写失败（${e.message.split('\n')[0]}），保持默认，请手动调整`);
    return false;
  }
}

/** 在封面弹窗当前 tab 里定位「上传封面」槽位。
 *  必须命中「点击上传文件或拖拽」那个槽（.semi-upload-drag-area-main-text），
 *  .first 会误选 AI 参考图槽（参考项目实测踩坑）。切换 tab 后需重新定位。 */
async function findCoverUploadSlot(modal) {
  let input = modal
    .locator('.semi-upload:has(.semi-upload-drag-area-main-text) input.semi-upload-hidden-input')
    .first();
  if (!(await input.count())) {
    input = modal.locator('input.semi-upload-hidden-input').last();
  }
  return input;
}

/**
 * 上传自定义封面（抖音需要两张）：竖封面 3:4（「设置竖封面」tab）+ 横封面 4:3（「设置横封面」tab）。
 * cover: { portrait: {path}|null, landscape: {path}|null }；失败只告警不中断。
 */
async function setCover(page, cover, log) {
  if (!cover || (!cover.portrait && !cover.landscape)) return false;
  try {
    // 0) 清掉新手引导浮层，否则会拦截封面点击
    await page.evaluate(
      "() => document.querySelectorAll('.shepherd-element,.shepherd-modal-overlay-container').forEach(e=>e.remove())",
    );

    // 1) 找封面区域并打开封面弹窗
    let coverArea = page.locator('[class*="cover-"]').filter({ has: page.locator('img') }).first();
    if (!(await coverArea.count())) {
      coverArea = page.locator('[class*="cover"]').first();
    }
    if (!(await coverArea.count())) {
      log('⚠️ 页面上没有封面区域，跳过封面上传');
      return false;
    }

    const modal = page.locator('div.dy-creator-content-modal').first();
    let opened = false;
    try {
      await coverArea.waitFor({ state: 'visible', timeout: 8000 });
    } catch {}
    await sleep(1500);
    for (let attempt = 0; attempt < 4 && !opened; attempt++) {
      // hover 让「编辑封面/选择封面」入口浮现
      let trigger = null;
      for (let h = 0; h < 3 && !trigger; h++) {
        await coverArea.hover({ force: true }).catch(() => {});
        await sleep(600);
        for (const txt of ['编辑封面', '选择封面', '设置封面']) {
          const t = page.getByText(txt, { exact: true }).first();
          if ((await t.count()) && (await t.isVisible().catch(() => false))) {
            trigger = t;
            break;
          }
        }
      }
      try {
        if (trigger) await trigger.click({ timeout: 4000 });
        else await coverArea.click({ force: true, timeout: 4000 });
      } catch {}
      await sleep(1200);
      if (await modal.count()) opened = true;
    }
    if (!opened) {
      await shot(page, 'douyin-cover-dialog-miss');
      log('⚠️ 封面弹窗打不开，跳过封面上传（用平台推荐封面）');
      return false;
    }
    await sleep(1000);

    // 2) 竖封面（弹窗默认就在竖封面页，防御性点一下 tab）
    if (cover.portrait) {
      const tab = modal.getByText('设置竖封面', { exact: true }).first();
      if (await tab.count()) {
        await tab.click({ timeout: 3000 }).catch(() => {});
        await sleep(800);
      }
      const input = await findCoverUploadSlot(modal);
      if (!(await input.count())) {
        await shot(page, 'douyin-cover-input-miss');
        log('⚠️ 未找到竖封面上传槽位，跳过竖封面');
      } else {
        await input.setInputFiles(cover.portrait.path);
        await sleep(3000);
        log(`已上传竖版封面（3:4）：${path.basename(cover.portrait.path)}`);
      }
    }

    // 3) 横封面：切「设置横封面」tab 后重新定位上传槽
    if (cover.landscape) {
      const tab = modal.getByText('设置横封面', { exact: true }).first();
      if (await tab.count()) {
        await tab.click({ timeout: 3000 }).catch(() => {});
        await sleep(1000);
      }
      const input = await findCoverUploadSlot(modal);
      if (!(await input.count())) {
        log('⚠️ 未找到横封面上传槽位，跳过横封面');
      } else {
        await input.setInputFiles(cover.landscape.path);
        await sleep(3000);
        log(`已上传横版封面（4:3）：${path.basename(cover.landscape.path)}`);
      }
    }

    // 4) 等「完成」按钮解禁（图片处理中为 semi-button-disabled）
    const finishBtn = modal.getByRole('button', { name: '完成', exact: true }).first();
    for (let i = 0; i < 30; i++) {
      try {
        if ((await finishBtn.count()) && (await finishBtn.isVisible())) {
          const cls = (await finishBtn.getAttribute('class')) || '';
          if (!cls.includes('semi-button-disabled')) break;
        }
      } catch {}
      await sleep(500);
    }

    // 5) 点「完成」并确认弹窗真正关闭（抖音自定义组件 click 可能静默失效）
    for (let attempt = 0; attempt < 4; attempt++) {
      let btn = finishBtn;
      if (!(await btn.count())) {
        btn = modal.locator('button.semi-button').filter({ hasText: '完成' }).first();
      }
      if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
        try {
          await btn.click({ timeout: 4000 });
        } catch {}
        await sleep(1500);
        if (!(await modal.count())) break;
        try {
          await btn.dispatchEvent('click');
        } catch {}
        await sleep(1500);
        if (!(await modal.count())) break;
      }
      // 二次确认弹窗
      for (const cname of ['确定', '确认', '仍然完成', '仍要完成', '继续']) {
        const confirm = page
          .locator('.semi-modal-content')
          .getByRole('button', { name: cname, exact: true })
          .first();
        if ((await confirm.count()) && (await confirm.isVisible().catch(() => false))) {
          try {
            await confirm.dispatchEvent('click');
          } catch {}
          await sleep(1500);
          break;
        }
      }
      if (!(await modal.count())) break;
      await page.keyboard.press('Escape');
      await sleep(1000);
      if (!(await modal.count())) break;
    }

    if (!(await modal.count())) {
      log('✅ 封面设置完成（竖+横），弹窗已关闭');
      return true;
    }
    await shot(page, 'douyin-cover-stuck');
    log('⚠️ 封面弹窗未能关闭，请发布前手动检查');
    return false;
  } catch (e) {
    await shot(page, 'douyin-cover-fail');
    log(`⚠️ 封面上传失败（${e.message.split('\n')[0]}），跳过，可发布前手动设置`);
    return false;
  }
}

/**
 * 主流程：在给定 page（新标签页）中完成抖音填表。
 * fields: {title, desc, tags}; opts: {schedule, when, cover, ui}
 * opts.ui（并行模式下由调用方给）：点击/打字这类要前台的动作用 ui.run 包起来，一次只让一个标签页做；
 * 打开页面、等人登录、等表单渲染、等上传这些“只是等”的时间不占前台。
 */
async function fillDouyin(page, topic, fields, opts, log) {
  const ui = opts.ui || NOOP_UI;
  const T = createTimer();
  log('打开抖音创作者中心上传页…');
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(2000);

  const uploadInput = await findUploadInput(page, log, ui); // 可能要人工登录/验证，等多久都不占前台锁
  log(`开始上传成片：${topic.videoName}（大文件需要等待）`);
  await uploadInput.setInputFiles(topic.video);

  await waitPublishPage(page, log);

  // 表单渲染（新版要等上传完才出现；给足时间，期间有上传进度日志）
  const titleProbe = page.locator('input[placeholder*="填写作品标题"]').first();
  const formDeadline = Date.now() + 600000;
  let announced = false;
  while (Date.now() < formDeadline) {
    if (await titleProbe.count()) break;
    if (!announced) {
      announced = true;
      log('等待发布表单渲染…');
    }
    await sleep(2000);
  }
  await titleProbe.waitFor({ state: 'visible', timeout: 600000 }); // 先在锁外等到可见，进了锁就只管打字
  T.lap('打开并开始上传');

  const when = opts.schedule && opts.when ? opts.when : null;
  await ui.run(page, () => fillTitleDescTags(page, fields, log));
  T.lap('填标题/描述/话题');
  // 定时和封面不用等上传：实测（2026-10-10 真实页面）上传还在进行时就能设，设好的值上传完成后仍在。
  // 定时先设（用户检查表单时它得已经在了），封面最慢（十几秒）放在后面，和上传的时间重叠。
  let scheduled = false;
  if (when) {
    scheduled = await ui.run(page, () => setScheduleTime(page, when, log));
    T.lap('定时');
  }
  if (opts.cover && (opts.cover.portrait || opts.cover.landscape)) {
    await ui.run(page, () => setCover(page, opts.cover, log));
    T.lap('封面');
  }
  await waitUploadComplete(page, log);
  T.lap('等上传完成');
  const vids = await silenceVideos(page, 40000); // 上传完成后预览会自动播放（有声音）：暂停它，并盯一阵子（期间静音）
  if (vids) log(`已暂停预览视频（${vids} 个）`);

  // 核对：上传完成时页面可能把定时重置了；上传期间没设成的这里再设一次
  if (when && !(scheduled && (await scheduleStill(page, when)))) {
    if (scheduled) log('ⓘ 上传完成后定时设置不在了（页面重置了表单），重新设置');
    scheduled = await ui.run(page, () => setScheduleTime(page, when, log));
    T.lap('补设定时');
  }

  await silenceVideos(page, 3000);
  const s = await shot(page, `douyin-done-${topic.id}-${Date.now()}`);
  log(scheduled ? '✅ 抖音填写完成（已设定时），请人工检查后点击「发布」' : '✅ 抖音填写完成，请人工检查后点击「发布」');
  log(`⏱ 用时 ${T.total().toFixed(0)} 秒：${T.summary()}`);
  return { screenshot: s, scheduled };
}

module.exports = { fillDouyin, setScheduleTime, scheduleStill, setCover, fillTitleDescTags, waitUploadComplete };
