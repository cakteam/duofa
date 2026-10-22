'use strict';
/**
 * 视频号助手（channels.weixin.qq.com）自动填入流程。
 * 依据 social-auto-upload 项目 2026 年实测选择器，多处兜底；2026-10-10 起对着真实页面逐项实测过（见各函数注释里的“实测”）。
 *
 * 流程（时间都花在“上传”上，其它事和上传同时做）：
 *   首页「发表视频」→ 表单里的 input[type=file] → 开始上传 →
 *   **上传的同时**填 短标题 / 描述+#话题 / **定时** / 位置「不显示位置」/ 声明原创 →
 *   等上传完成（只是等，不占前台）→ 暂停预览视频 → 核对前面填的还在不在、没成功的补填 → 封面（上传完成后才能点，最慢，放最后）→ 收尾再核对 → 截图。
 * 只填表，不点「发表」。
 *
 * 为什么这么排（真实运行日志 logs/server.log 与 2026-10-10 的真实页面实测）：
 *   · 点「发表视频」之后不再等“网络空闲”（这个页面一直在轮询，等不到，白等 5–20 秒）；
 *   · 旧版封面一步固定 33–34 秒：旧代码在隐藏的「裁剪封面图」弹窗里等它的「确定」按钮，那个弹窗根本不出现，吃满 30 秒默认超时；
 *   · 上一版封面步骤的「确认」点不到：「编辑封面」弹窗里嵌着隐藏的裁剪弹窗，它的主按钮排在前面，被当成了「确认」——已改成只认可见的；
 *   · 定时在上传期间就能设（实测设好的值上传完成后仍在），所以紧跟描述之后设，不等上传、不等封面；封面在上传期间点不开，只能等上传完成。
 */
const path = require('path');
const fs = require('fs');
const { clickBlankArea, silenceVideos, createTimer, waitClickable, waitGone } = require('./common');
const { NOOP_UI } = require('./ui-lock');

const HOME_URL = 'https://channels.weixin.qq.com/platform';
const LOG_DIR = path.join(__dirname, '..', 'logs');

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

/** 关闭上传后偶发的「切换视频号」弹窗 */
async function dismissSwitchAccountDialog(page) {
  const candidates = [
    page.locator('.changeAccount-dialog button:has-text("取消")').first(),
    page.locator('.changeAccount-dialog .weui-desktop-dialog__close-btn').first(),
  ];
  for (const c of candidates) {
    try {
      if ((await c.count()) && (await c.isVisible())) {
        await c.click({ timeout: 2000 });
        await sleep(600);
        return;
      }
    } catch {}
  }
  // 兜底：常见强制弹窗关闭按钮
  const close = page.locator('.common-dialog .weui-desktop-dialog__close-btn').first();
  try {
    if ((await close.count()) && (await close.isVisible())) {
      await close.click({ timeout: 2000 });
      await sleep(600);
    }
  } catch {}
}

async function findFileInput(page) {
  for (const fr of page.frames()) {
    try {
      const fi = fr.locator('input[type="file"]');
      if (await fi.count()) return fi.first();
    } catch {}
  }
  return null;
}

async function gotoUploadForm(page, log, ui = NOOP_UI) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2000);

  // 未登录检测：跳到登录页 / 出现扫码框
  const url = page.url();
  if (!url.includes('/platform')) {
    await shot(page, 'channels-need-login');
    const err = new Error('视频号助手未登录：请在打开的 Chrome 窗口中扫码登录后重试');
    err.code = 'NEED_LOGIN';
    throw err;
  }

  // 新版需先点首页可见的「发表视频」按钮，表单 iframe 才会真正挂载
  let clicked = false;
  try {
    const btn = page.locator('button.weui-desktop-btn', { hasText: '发表视频' }).first();
    await btn.waitFor({ state: 'visible', timeout: 20000 }); // 只是等按钮出来，不占前台
    await ui.run(page, () => btn.click());
    clicked = true;
    log('已点击「发表视频」');
  } catch {}
  if (!clicked) {
    log('未找到首页入口按钮，尝试直接打开发布页');
    await page.goto('https://channels.weixin.qq.com/platform/post/create', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    }).catch(() => {});
  }
  try {
    await page.waitForURL('**/platform/post/create', { timeout: 60000 });
  } catch {}
  // 不再等“网络空闲”：这个页面一直在轮询，几乎等不到空闲，实测每次白等 5–20 秒。
  // 页面是否就绪，由后面找上传框的循环（最多 60 秒）来判断。
}

/** 视频上传完了没有：「发表」按钮可用就是完了。 */
async function isUploadDone(page) {
  try {
    const btn = page.locator('div.form-btns button:has-text("发表"):visible').first();
    if (!(await btn.count())) return false;
    const cls = (await btn.getAttribute('class', { timeout: 2000 })) || '';
    const disabled = await btn.isDisabled({ timeout: 2000 }).catch(() => true);
    return !disabled && !cls.includes('weui-desktop-btn_disabled');
  } catch {
    return false;
  }
}

/** 等待视频上传完成（「发表」按钮变为可用） */
async function waitUploadDone(page, log, timeoutSec = 1800) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastReport = 0;
  while (Date.now() < deadline) {
    if (await isUploadDone(page)) {
      log('视频上传完成，表单已就绪');
      return;
    }
    if ((await page.locator('div.status-msg.error').count()) > 0) {
      await shot(page, 'channels-upload-error');
      throw new Error('视频号检测到上传失败（页面出现错误提示），请查看截图 logs/channels-upload-error.png');
    }
    const now = Date.now();
    if (now - lastReport > 30000) {
      log(`视频上传中…（已等 ${Math.round((timeoutSec * 1000 - (deadline - now)) / 1000)} 秒）`);
      lastReport = now;
    }
    await sleep(2000);
  }
  await shot(page, 'channels-upload-timeout');
  throw new Error(`视频号上传超过 ${timeoutSec} 秒仍未完成`);
}

function shortTitleField(page) {
  const direct = page.locator('input[placeholder="填写短标题有机会获得更多流量"]').first();
  return direct;
}

async function findShortTitleField(page) {
  let field = shortTitleField(page);
  if (!(await field.count())) {
    field = page
      .getByText('短标题', { exact: true })
      .locator('..')
      .locator('xpath=following-sibling::div')
      .locator('span input[type="text"]');
  }
  return (await field.count()) ? field : null;
}

/** 填短标题。返回是否填上了；quiet=true（上传期间的试探性填写）时找不到就静默返回 false，等上传完成后再试一次。 */
async function setShortTitle(page, shortTitle, log, { quiet = false } = {}) {
  const field = await findShortTitleField(page);
  if (!field) {
    if (!quiet) log('⚠️ 未找到短标题输入框，跳过（不影响其余填写）');
    return false;
  }
  try {
    await field.fill(shortTitle, { timeout: quiet ? 3000 : 8000 });
  } catch (e) {
    if (quiet) return false; // 上传期间的试探：填不进去就等上传完成后再填
    throw e;
  }
  log(`已填写短标题（${shortTitle.length} 字）：${shortTitle}`);
  return true;
}

/** 短标题现在填的是不是期望的内容（上传完成后页面可能重置表单，要核对）。读不到就当不对。 */
async function shortTitleStill(page, expected) {
  const field = await findShortTitleField(page);
  if (!field) return false;
  const v = await field.inputValue({ timeout: 3000 }).catch(() => '');
  return String(v).trim() === String(expected || '').trim();
}

/** 填描述与话题。可重复执行（先清空编辑器再填）。返回是否填上；quiet=true 时找不到/点不到编辑器就返回 false。 */
async function fillDescription(page, desc, tags, log, { quiet = false } = {}) {
  const editor = page.locator('div.input-editor').first();
  let clicked = false;
  // 偶发弹窗遮挡：重试并关弹窗
  for (let i = 0; i < 4 && !clicked; i++) {
    try {
      await editor.click({ timeout: quiet ? 2500 : 5000 });
      clicked = true;
    } catch {
      await dismissSwitchAccountDialog(page);
      await sleep(500);
    }
  }
  if (!clicked) {
    if (quiet) return false;
    await editor.click({ timeout: 8000 });
  }
  // 编辑器里已经有内容（上传期间填过一遍、页面又改了它，要重填）就先清空，不能叠在旧内容后面；本来是空的就不动它
  const existing = String((await editor.innerText({ timeout: 2000 }).catch(() => '')) || '').trim();
  if (existing) {
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
  }

  if (desc) {
    await page.keyboard.type(desc);
    await page.keyboard.press('Enter');
    log(`已填写描述（${desc.length} 字）`);
  }
  for (const tag of tags || []) {
    await page.keyboard.type('#' + tag);
    await page.keyboard.press('Space');
    await sleep(300);
  }
  // 最后一个话题要等“下一个字符”才会定型：不处理的话它有时是纯文字、有时把结尾空格包在话题里面（实测）。
  // 敲一个字再退格，它就定型成「#话题」+ 话题外的一个空格，和前面几个一致。
  if (tags && tags.length) {
    for (let i = 0; i < 3; i++) {
      await page.keyboard.type('x');
      await sleep(150);
      await page.keyboard.press('Backspace');
      await sleep(150);
      if (await topicsSettled(editor, tags)) break;
    }
  }
  log(`已添加话题 ${((tags && tags.length) || 0)} 个`);
  await page.keyboard.press('Escape');
  return true;
}

/** 每个 #话题 都已定型成话题标记，且话题标记里没有夹着空格。 */
async function topicsSettled(editor, tags) {
  try {
    const texts = await editor.evaluate((e) => [...e.querySelectorAll('[data-type="topic"]')].map((x) => x.textContent));
    return (tags || []).every((t) => texts.includes(`#${t}`));
  } catch {
    return true; // 读不到就不重复折腾
  }
}

/** 描述与话题现在还在不在（开头一段文字 + 每个 #话题）。 */
async function descriptionStill(page, desc, tags) {
  const editor = page.locator('div.input-editor').first();
  if (!(await editor.count())) return false;
  const text = String((await editor.innerText({ timeout: 3000 }).catch(() => '')) || '');
  const head = String(desc || '').replace(/\s+/g, '').slice(0, 10);
  if (head && !text.replace(/\s+/g, '').includes(head)) return false;
  return (tags || []).every((t) => text.includes(`#${t}`));
}

/** 定时现在是不是已经设成想要的：「定时」单选选中、日期框是目标日期、时间框是目标时间。读不到就当没设。 */
async function scheduleStill(page, when) {
  try {
    const radio = page.locator('label', { hasText: /^\s*定时\s*$/ }).first(); // 注意不是「不定时」
    if (!(await radio.count())) return false;
    if (!(await radio.locator('input[type="radio"]').first().isChecked({ timeout: 2000 }).catch(() => false))) return false;
    const wantDate = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
    const wantTime = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    const date = await page.locator('input[placeholder="请选择发表时间"]').first().inputValue({ timeout: 2000 }).catch(() => '');
    const time = await page.locator('input[placeholder="请选择时间"]').first().inputValue({ timeout: 2000 }).catch(() => '');
    return date.includes(wantDate) && time.trim() === wantTime;
  } catch {
    return false;
  }
}

/**
 * 定时发表。可重复执行（已经设对了就跳过）；所有会等元素的调用都带显式超时；
 * 出错不抛异常，返回 false 并明说“没设上”——这时页面保持默认“不定时”，必须手动改，否则点发表就会立刻发出去。
 * quiet=true（上传期间的试探性设置）：没成功就静默返回 false，等上传完成后核对时再设一次。
 * 实测（2026-10-10）：视频还在上传时就能设定时，设好的值在上传完成后仍在，所以这一步放在表单一出来就做，不等上传、不等封面。
 */
async function setScheduleTime(page, when, log, { quiet = false } = {}) {
  try {
    return await setScheduleTimeInner(page, when, log, quiet);
  } catch (e) {
    if (!quiet) {
      await shot(page, 'channels-schedule-fail');
      log(`⚠️ 定时没有设置成功（${e.message.split('\n')[0]}）。页面保持“不定时”，请手动设置定时，否则点发表会立刻发出`);
    }
    return false;
  }
}

async function setScheduleTimeInner(page, when, log, quiet) {
  if (await scheduleStill(page, when)) {
    log('「定时发表」已经设好，跳过');
    return true;
  }
  const warn = (m) => { if (!quiet) log(m); };
  // 1) 选「定时」（单选框的标签文字正好是“定时”；“不定时”那个不能点）
  const label = page.locator('label', { hasText: /^\s*定时\s*$/ }).first();
  let picked = false;
  if (await label.count()) {
    try {
      await label.click({ timeout: 3000 });
      await sleep(500);
      picked = await page.locator('input[placeholder="请选择发表时间"]').first().isVisible().catch(() => false);
    } catch { /* 被什么挡住了，下面当作没找到 */ }
  }
  if (!picked) {
    if (!quiet) await shot(page, 'channels-schedule-label-miss');
    warn('⚠️ 没能选上「定时发表」，页面保持“不定时”，请手动调整');
    return false;
  }
  log('已勾选定时发表');

  // 2) 选择日期
  await page.locator('input[placeholder="请选择发表时间"]').first().click({ timeout: 5000 });
  await sleep(600);
  const targetMonth = `${when.getMonth() + 1}月`;
  for (let i = 0; i < 13; i++) {
    let panelText = '';
    try {
      panelText = await page.locator('span.weui-desktop-picker__panel__label:has-text("月")').first().innerText({ timeout: 2000 });
    } catch {}
    if (panelText.includes(targetMonth)) break;
    try {
      await page.locator('button.weui-desktop-btn__icon__right').first().click({ timeout: 2000 });
      await sleep(400);
    } catch {
      break;
    }
  }

  const dayStr = String(when.getDate());
  const links = page.locator('table.weui-desktop-picker__table a');
  const total = await links.count();
  const wantISO = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${dayStr.padStart(2, '0')}`;
  let dateOk = false;
  for (let i = 0; i < total; i++) {
    const el = links.nth(i);
    const cls = (await el.getAttribute('class', { timeout: 2000 }).catch(() => '')) || '';
    if (cls.includes('disabled')) continue;
    const text = (await el.innerText({ timeout: 2000 }).catch(() => '')).trim();
    if (text !== dayStr) continue;
    await el.click({ timeout: 3000 }).catch(() => {});
    await sleep(500);
    // 校验输入框日期；不对则继续尝试下一个同号日期（上/下月尾巴）
    let val = '';
    try {
      val = await page.locator('input[placeholder="请选择发表时间"]').first().inputValue({ timeout: 2000 });
    } catch {}
    if (val.includes(wantISO)) {
      dateOk = true;
      break;
    }
  }
  if (!dateOk) warn(`⚠️ 日期选择未能确认（目标 ${wantISO}），请手动核对`);

  // 3) 选择时间 HH:mm
  const wantTime = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  const timeInput = page.locator('input[placeholder="请选择时间"]').first();
  await timeInput.click({ timeout: 5000 });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(wantTime);
  await page.keyboard.press('Enter');
  await sleep(500);
  let timeVal = '';
  try {
    timeVal = await timeInput.inputValue({ timeout: 2000 });
  } catch {}
  log(`定时时间已填写：${wantISO} ${timeVal || ''}`.trim());
  // 点旁边空白处收起时间选择浮层，让定时生效（点不到再按 Esc 兜底）
  await sleep(200);
  if (!(await clickBlankArea(page))) {
    try {
      await page.keyboard.press('Escape');
    } catch {}
  }
  await sleep(400);
  return dateOk && String(timeVal).trim() === wantTime;
}

/**
 * 当前打开着的弹窗里，标题（h3）匹配 titleRe 的那一个。
 * 视频号页面里有几十个 div.weui-desktop-dialog（绝大多数是隐藏的），而且「编辑封面」弹窗里还嵌着一个隐藏的「裁剪封面图」弹窗，
 * 它的主按钮「确定」排在可见的「确认」前面——所以不能用“第一个含某段文字的 dialog”或“第一个主按钮”，会选到隐藏的那个
 * （2026-10-10 实测：封面选完图后工具一直点不到「确认」，弹窗停在那里，后面的定时也被它挡住，就是这个原因）。
 * 这里认的是：标题元素本身看得见，再取它最近的那一层 dialog。
 */
function openDialog(page, titleRe) {
  return page
    .locator('h3.weui-desktop-dialog__title:visible', { hasText: titleRe })
    .first()
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' weui-desktop-dialog ')][1]");
}

/**
 * 点「确认」之后：封面弹窗关掉就算处理完；若接着弹出「裁剪封面图」（图片比例不合时才有），就点它可见的主按钮。
 * 实测 3:4 的封面图点「确认」后弹窗约 2 秒自己关闭、不会有裁剪框。
 * 返回 'none'（没有裁剪框，弹窗关了）| 'clicked'（点了裁剪框的确定）| 'timeout'（等了 maxMs 弹窗还开着）。
 */
async function handleCropDialog(page, coverDialog, maxMs = 15000) {
  const crop = openDialog(page, /裁剪封面图/);
  const t0 = Date.now();
  let clicked = false;
  let goneSince = 0;
  for (;;) {
    if (await crop.isVisible().catch(() => false)) {
      goneSince = 0;
      const btn = crop.locator('div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:visible').first();
      if (await waitClickable(btn, 300)) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        clicked = true;
        await sleep(600);
        continue;
      }
    } else if (!(await coverDialog.isVisible().catch(() => false))) {
      // 封面弹窗关了、裁剪框也没有：再给 600 毫秒看有没有裁剪框接着冒出来
      goneSince = goneSince || Date.now();
      if (Date.now() - goneSince >= 600) return clicked ? 'clicked' : 'none';
    } else goneSince = 0;
    if (Date.now() - t0 > maxMs) return 'timeout';
    await sleep(200);
  }
}

/**
 * 封面入口现在点得动吗：入口中心点上最上层的元素就是封面图本身，而不是遮罩层。
 * 实测（2026-10-10 真实页面）：视频上传（含平台自己的后处理）期间，封面缩略图上盖着一层 vertical-mask-layer，点它没有任何反应；
 * 遮罩什么时候消失不固定——有时发表按钮可用时它已经没了，有时还要再等 10 多秒（并行上传时更久）。所以不能“上传完成就点”，要等遮罩消失。
 */
async function coverEntryClickable(entry, scrolled) {
  try {
    if (!scrolled.done) { await entry.scrollIntoViewIfNeeded({ timeout: 1500 }); scrolled.done = true; }
    const state = await entry.evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return 'hidden';
      const root = el.getRootNode();
      const top = (root.elementFromPoint ? root : document).elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!top) return 'offscreen';
      if (/mask-layer|loading/.test(String(top.className))) return 'masked';
      return el === top || el.contains(top) ? 'ok' : 'covered';
    });
    if (state === 'offscreen') scrolled.done = false; // 页面布局变了，入口滚出了视口：下次再滚回来
    return state === 'ok';
  } catch {
    return false;
  }
}

/**
 * 上传自定义封面。视频号表单里的封面入口：
 *  - 竖版 3:4「个人主页和分享卡片」（div.vertical-cover-wrap）
 *  - 4:3 横版（div.horizontal-cover-wrap，目前页面上没有，保留兼容）
 * cover: { path, orientation: 'landscape'|'portrait' }
 * 失败只告警不中断（发布可依赖平台自动选帧兜底）。
 *
 * 实测（2026-10-10，真实页面）：
 *  · 视频还在上传时点封面入口没有反应，所以这一步必须等上传完成；
 *  · 选完图片后弹窗立刻载入图片，「确认」马上可点，点后约 2 秒弹窗自己关闭、封面缩略图换成新图；没有裁剪框；
 *  · 弹窗里有隐藏的「裁剪封面图」及它的「确定」按钮——所有按钮/弹窗的定位都必须带“可见”条件（见 openDialog）。
 * 每一步都带“已用 N 秒”的日志；最后用封面缩略图是否换了图来确认真的生效了。
 */
async function coverThumbSrc(page, orientation = 'portrait') {
  const sel = orientation === 'landscape' ? 'div.horizontal-cover-wrap img' : 'div.vertical-cover-wrap img';
  return (await page.locator(sel).first().getAttribute('src', { timeout: 1500 }).catch(() => null)) || null;
}

/**
 * 封面缩略图的“内容”是不是我们上传的那张：把缩略图（元素截图）和封面文件都缩成 24×22 灰度小图（只取上 70%，下面有“编辑”浮层），比平均亮度差。
 * 实测（1020-3 / 1020-4）：对的 0.02，被平台换成视频第一帧的 0.14；阈值 0.07。
 * 返回 { ok, diff }；读不到缩略图 / 页面不让解码时返回 null（没法核对，不当作失败）。
 * 以前的“复核”只比缩略图地址有没有变，设好那一刻就已经是视频帧也会判通过（1020-3 视频号封面没对上，日志却写“封面还在”）。
 */
async function coverContentMatch(page, orientation, coverPath) {
  try {
    const sel = orientation === 'landscape' ? 'div.horizontal-cover-wrap img' : 'div.vertical-cover-wrap img';
    const shotBuf = await page.locator(sel).first().screenshot({ timeout: 3000 });
    const refBuf = fs.readFileSync(coverPath);
    const mime = /\.jpe?g$/i.test(coverPath) ? 'image/jpeg' : 'image/png';
    const r = await page.evaluate(async ({ a, b }) => {
      const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
      const sig = async (u) => {
        const im = await load(u);
        const c = document.createElement('canvas'); c.width = 24; c.height = 22;
        const x = c.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, 24, 22);          // 带透明的图先铺白底再比（元素截图是铺在白页面上的）
        x.drawImage(im, 0, 0, im.naturalWidth, im.naturalHeight * 0.7, 0, 0, 24, 22);
        const d = x.getImageData(0, 0, 24, 22).data;
        const out = [];
        for (let i = 0; i < d.length; i += 4) out.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        return out;
      };
      const [sa, sb] = [await sig(a), await sig(b)];
      let sum = 0;
      for (let i = 0; i < sa.length; i++) sum += Math.abs(sa[i] - sb[i]);
      return sum / sa.length / 255;
    }, { a: `data:image/png;base64,${shotBuf.toString('base64')}`, b: `data:${mime};base64,${refBuf.toString('base64')}` });
    return typeof r === 'number' && Number.isFinite(r) ? { ok: r < 0.07, diff: r } : null;
  } catch (_) {
    return null;
  }
}

async function setCover(page, cover, log, ui = NOOP_UI, { waitMs = 90000 } = {}) {
  const isLandscape = cover.orientation === 'landscape';
  const kind = isLandscape ? '4:3 横版' : '3:4 竖版';
  const t0 = Date.now();
  const lap = (m) => log(`封面（${kind}）：${m}（已用 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  const entrySelectors = isLandscape
    ? ['div.horizontal-cover-wrap:has-text("4:3")', 'div.horizontal-cover-wrap', 'div[class*="cover-wrap"]:has-text("4:3")']
    : ['div.vertical-cover-wrap:has-text("3:4")', 'div.vertical-cover-wrap:has-text("个人主页")', 'div.vertical-cover-wrap'];
  const titleRe = isLandscape ? /编辑.{0,6}封面|编辑.{0,6}动态/ : /编辑.{0,6}封面|编辑个人主页/;
  const thumb = page.locator(isLandscape ? 'div.horizontal-cover-wrap img' : 'div.vertical-cover-wrap img').first();
  const thumbSrc = async () => ((await thumb.getAttribute('src', { timeout: 1500 }).catch(() => null)) || null);

  try {
    const before = await thumbSrc();
    // 1) 等封面入口可点（遮罩消失；等待不占前台锁），再点开；点了没打开就再点
    const wrapSel = isLandscape ? 'div.horizontal-cover-wrap' : 'div.vertical-cover-wrap';
    const wrap = page.locator(wrapSel).first();
    const scrolled = { done: false };
    const waitStart = Date.now();
    const clickable = await ui.idle(async () => {
      for (;;) {
        if (await coverEntryClickable(wrap, scrolled)) return true;
        const waited = Date.now() - waitStart;
        if (waited > waitMs) return false;
        if (waited > 3000 && !scrolled.said) { scrolled.said = true; log(`封面（${kind}）：平台还在处理视频，封面暂时点不了，等它处理完…`); }
        await sleep(400);
      }
    });
    if (!clickable) {
      await shot(page, 'channels-cover-masked');
      log(`⚠️ 封面一直处于“处理中”（${Math.round(waitMs / 1000)} 秒），没能设置封面，请发布前手动设置`);
      return false;
    }
    if (scrolled.said) lap('平台处理完了，封面可以点了');
    let dialog = null;
    for (let attempt = 0; attempt < 4 && !dialog; attempt++) {
      let clicked = false;
      for (const sel of entrySelectors) {
        const entry = page.locator(sel).first();
        if (!(await entry.count())) continue;
        if (!(await entry.isVisible().catch(() => false))) continue;
        await entry.click({ timeout: 3000 });
        clicked = true;
        break;
      }
      if (!clicked) {
        // 兜底：直接找「编辑」文字按钮
        for (const txt of ['编辑封面', '更换封面', '编辑']) {
          const t = page.getByText(txt, { exact: true }).first();
          if ((await t.count()) && (await t.isVisible().catch(() => false))) {
            await t.click({ timeout: 3000 }).catch(() => {});
            clicked = true;
            break;
          }
        }
      }
      const d = openDialog(page, titleRe);
      if (await d.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) dialog = d;
      else if (!clicked) break;
    }
    if (!dialog) {
      await shot(page, 'channels-cover-dialog-miss');
      log(`⚠️ 未找到${kind}封面入口或编辑弹窗没有打开，跳过封面上传`);
      return false;
    }
    lap('编辑弹窗已打开');

    // 2) 上传图片，等图片载入弹窗
    let fileInput = dialog.locator('.single-cover-uploader-wrap input[type="file"]').first();
    if (!(await fileInput.count())) fileInput = dialog.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 10000 });
    await fileInput.setInputFiles(cover.path, { timeout: 15000 });
    for (let i = 0; i < 40; i++) {
      const loaded = await dialog.locator('.single-cover-uploader-wrap img.img-wrap').first()
        .evaluate((im) => im.naturalWidth > 0).catch(() => false);
      if (loaded) break;
      await sleep(200);
    }
    lap('图片已选择');

    // 3) 点「确认」（只认可见的主按钮；等待可点不占前台锁）
    const confirmBtn = dialog.locator('div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:visible').first();
    const ready = await ui.idle(() => waitClickable(confirmBtn, 30000));
    if (!ready) throw new Error('封面弹窗里的「确认」按钮 30 秒内一直不可点');
    await confirmBtn.click({ timeout: 5000 });
    lap('已点「确认」');

    // 4) 弹窗关闭（若有裁剪框就处理它）
    const crop = await handleCropDialog(page, dialog);
    if (crop === 'timeout') {
      await shot(page, 'channels-cover-dialog-stuck');
      log('⚠️ 封面弹窗点了「确认」后一直没有关闭，请发布前检查封面');
      return false;
    }

    // 5) 用封面缩略图是否换了图来确认真的生效
    let changed = before === null; // 读不到缩略图就没法确认，按成功算
    for (let i = 0; i < 20 && !changed; i++) {
      const now = await thumbSrc();
      if (now && now !== before) changed = true;
      else await sleep(300);
    }
    if (!changed) {
      log('⚠️ 封面弹窗已关闭，但缩略图没有变化，请发布前检查封面');
      return false;
    }
    log(`✅ 已上传${kind}封面：${path.basename(cover.path)}（共 ${((Date.now() - t0) / 1000).toFixed(1)} 秒${crop === 'none' ? '' : `，裁剪确认：${crop}`}）`);
    return true;
  } catch (e) {
    await shot(page, 'channels-cover-fail');
    log(`⚠️ 封面上传失败（${e.message.split('\n')[0]}），跳过，可发布前手动设置`);
    return false;
  }
}

/** 在所有 frame 中找到含目标元素的 frame（优先可见匹配，主 frame 优先） */
async function findFormFrame(page, selector) {
  const frames = [page.mainFrame(), ...page.frames()];
  for (const wantVisible of [true, false]) {
    for (const fr of frames) {
      try {
        const loc = fr.locator(wantVisible ? `${selector}:visible` : selector).first();
        if (await loc.count()) return fr;
      } catch {}
    }
  }
  return null;
}

/** 点击当前可见 weui 弹窗里的可用主按钮（先勾弹窗内未选的协议勾选框，最多 3 个弹窗连点） */
async function confirmVisibleDialogs(frame, log) {
  for (let i = 0; i < 3; i++) {
    const dlg = frame.locator('div.weui-desktop-dialog:visible').first();
    if (!(await dlg.count())) break;
    // 弹窗内可能有「同意规范」类勾选框，未勾会导致主按钮禁用
    const agree = dlg.locator('input[type="checkbox"]:not(:checked)').first();
    if (await agree.count()) {
      await agree
        .locator('xpath=ancestor::label[1]')
        .first()
        .click({ timeout: 2000 })
        .catch(() => agree.click({ force: true, timeout: 2000 }).catch(() => {}));
      await sleep(700);
    }
    const btn = dlg
      .locator('button.weui-desktop-btn_primary:visible:not(.weui-desktop-btn_disabled)')
      .first();
    if (!(await btn.count())) break;
    const txt = (await btn.innerText().catch(() => '')).trim();
    await btn.click({ timeout: 4000 }).catch(() => {});
    await sleep(1000);
    log(`已点击确认弹窗「${txt}」`);
  }
}

/** 位置现在是不是「不显示位置」。读不到（页面还没渲染、结构变了）返回 null。 */
async function locationIsNone(page) {
  try {
    const fr = await findFormFrame(page, "div.label:text-is('位置')");
    if (!fr) return null;
    const disp = fr.locator('.post-position-wrap .position-display').first();
    if (!(await disp.count())) return null;
    const t = String((await disp.innerText({ timeout: 2000 }).catch(() => '')) || '');
    return t.includes('不显示位置');
  } catch {
    return null;
  }
}

/**
 * 固定操作1：点击「位置」，选择「不显示位置」。可重复执行（已经是「不显示位置」就跳过）。
 * quiet=true（上传期间的试探性填写）：找不到就静默返回 false，不截图、不报警，等上传完成后再来一次。
 */
async function setLocationNone(page, log, { quiet = false } = {}) {
  const warn = (m) => { if (!quiet) log(m); };
  try {
    if ((await locationIsNone(page)) === true) {
      log('「位置」已经是「不显示位置」，跳过');
      return true;
    }
    const fr = await findFormFrame(page, "div.label:text-is('位置')");
    if (!fr) {
      warn('⚠️ 未找到「位置」行，跳过该设置');
      return false;
    }
    // 点开位置选择器
    const trigger = fr.locator('.post-position-wrap .position-display').first();
    if (await trigger.count()) {
      await trigger.click({ timeout: 5000 });
    } else {
      await fr.locator("div.label:text-is('位置')").first().click({ timeout: 5000 });
    }
    await sleep(1200);

    // 在下拉里点「不显示位置」
    const opt = fr
      .locator('.location-item', { has: fr.locator(".name:text-is('不显示位置')") })
      .first();
    if (await opt.count()) {
      await opt.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      await opt.click({ timeout: 5000 });
    } else {
      const alt = fr.getByText('不显示位置', { exact: true }).first();
      if (!(await alt.count())) {
        warn('⚠️ 位置下拉里没有「不显示位置」选项，请发布前手动检查');
        return false;
      }
      await alt.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      await alt.click({ timeout: 5000 });
    }
    await sleep(600);
    await confirmVisibleDialogs(fr, log);
    log('已设置位置为「不显示位置」');
    return true;
  } catch (e) {
    if (!quiet) await shot(page, 'channels-location-fail');
    warn(`⚠️ 设置「不显示位置」失败（${e.message.split('\n')[0]}），请发布前手动检查`);
    return false;
  }
}

/**
 * 固定操作2：勾选「声明原创」（勾选后可能弹「原创权益」确认弹窗，自动确认）。可重复执行（已勾选就跳过）。
 * quiet=true：上传期间的试探性填写，找不到入口就静默返回 false。
 */
async function declareOriginal(page, log, { quiet = false } = {}) {
  const warn = (m) => { if (!quiet) log(m); };
  try {
    const fr = await findFormFrame(page, 'span:text-is("声明原创")');
    if (!fr) {
      warn('⚠️ 未找到「声明原创」入口，跳过（请发布前手动勾选）');
      return false;
    }
    // 标准复选框：直接勾
    const cb = fr.locator('.declare-original-checkbox input[type="checkbox"]').first();
    if (await cb.count()) {
      if (await cb.isChecked().catch(() => false)) {
        log('「声明原创」已勾选，跳过');
        return true;
      }
      const wrapper = fr.locator('.declare-original-checkbox label.ant-checkbox-wrapper').first();
      if (await wrapper.count()) {
        await wrapper.click({ timeout: 5000 });
      } else {
        await cb.click({ force: true, timeout: 5000 }).catch(() => {});
      }
    } else {
      // 兜底：点可见的文字
      await fr.locator('span:text-is("声明原创"):visible').first().click({ timeout: 5000 });
    }
    await sleep(1200);

    // 处理确认弹窗（原创权益 / 分成计划拦截等）
    for (let i = 0; i < 3; i++) {
      if (await fr.locator('div.weui-desktop-dialog:visible').first().count()) {
        await confirmVisibleDialogs(fr, log);
      }
      // 分成计划拦截条（非 weui-dialog 结构）
      const interceptor = fr.locator('.original-interceptor-footer:visible').first();
      if (await interceptor.count()) {
        const btn = interceptor.locator('button.weui-desktop-btn_primary:visible').first();
        if (await btn.count()) {
          await btn.click({ timeout: 4000 }).catch(() => {});
          await sleep(1000);
          log('已点击「声明原创」确认');
          continue;
        }
      }
      break;
    }
    log('已勾选「声明原创」');
    return true;
  } catch (e) {
    if (!quiet) await shot(page, 'channels-original-fail');
    warn(`⚠️ 勾选「声明原创」失败（${e.message.split('\n')[0]}），请发布前手动勾选`);
    return false;
  }
}

/** 找到上传框（必要时再点一次「发表视频」）；找不到抛 NO_FILE_INPUT。 */
async function locateFileInput(page, ui = NOOP_UI) {
  let fi = await findFileInput(page);
  let clickedAgain = false;
  for (let i = 0; i < 60 && !fi; i++) {
    if (!clickedAgain) {
      try {
        const btns = await page.getByRole('button').all();
        for (const b of btns) {
          const t = (await b.innerText().catch(() => '')).trim();
          if (t.includes('发表视频') && (await b.isVisible())) {
            await ui.run(page, () => b.click({ force: true }));
            clickedAgain = true;
            break;
          }
        }
      } catch {}
    }
    fi = await findFileInput(page);
    if (!fi) await sleep(1000);
  }
  if (!fi) {
    await shot(page, 'channels-no-file-input');
    const err = new Error('未找到视频号上传框（可能未登录或页面改版），截图见 logs/channels-no-file-input.png');
    err.code = 'NO_FILE_INPUT';
    throw err;
  }
  return fi;
}

/**
 * 填表单里不依赖视频的几项：短标题、描述+话题、定时（有就设）、位置、声明原创。每一项都可重复执行，done 记录哪些已经填上。
 * quiet=true：上传期间的试探——页面还没渲染好的项静默跳过，等上传完成后再补。
 * verify=true：上传完成后的核对——页面可能在上传完成时重置表单，已经填过的项要确认还在，不在就重填。
 * when：要设定时的时间（不设定时就不传）。定时放在位置、声明原创之前，因为它最要紧：用户检查表单时它得已经设好了。
 */
async function fillForm(page, fields, log, done, { quiet = false, verify = false, when = null } = {}) {
  if (verify) {
    if (done.title && !(await shortTitleStill(page, fields.shortTitle))) {
      done.title = false;
      log('ⓘ 上传完成后短标题不在了（页面重置了表单），重新填写');
    }
    if (done.desc && !(await descriptionStill(page, fields.desc, fields.tags))) {
      done.desc = false;
      log('ⓘ 上传完成后描述/话题不完整（页面重置了表单），重新填写');
    }
    if (when && done.schedule && !(await scheduleStill(page, when))) {
      done.schedule = false;
      log('ⓘ 上传完成后定时设置不在了（页面重置了表单），重新设置');
    }
  }
  if (!done.title) done.title = await setShortTitle(page, fields.shortTitle, log, { quiet });
  if (!done.desc) done.desc = await fillDescription(page, fields.desc, fields.tags, log, { quiet });
  if (when && !done.schedule && !done.scheduleGaveUp) {
    done.schedule = await setScheduleTime(page, when, log, { quiet });
    if (!done.schedule && !quiet) done.scheduleGaveUp = true; // 上传完成后正式试过仍不行：已经明说过原因了，后面的核对不再重复试、重复报
  }
  // 位置与声明原创本身可重复执行（已设好就跳过），核对时直接再走一遍；两项都可在 config.json 的 channels 里关掉
  const cc = require('./config').load().channels;
  if (!cc.hideLocation) done.location = true;
  else if (!done.location || verify) done.location = await setLocationNone(page, log, { quiet });
  if (!cc.declareOriginal) done.original = true;
  else if (!done.original || verify) done.original = await declareOriginal(page, log, { quiet });
  return done;
}

/**
 * 主流程：在给定 page（新标签页）中完成视频号填表。
 * topic: parse.js 输出；fields: {shortTitle, desc, tags}; opts: {schedule, when, cover, ui}
 * opts.ui（并行模式下由调用方给）：点击/打字这类要前台的动作用 ui.run 包起来，一次只让一个标签页做；等上传的时间不占。
 */
async function fillChannels(page, topic, fields, opts, log) {
  const ui = opts.ui || NOOP_UI;
  const T = createTimer();
  const when = opts.schedule && opts.when ? opts.when : null;

  // ① 进入发表表单、找到上传框、开始上传。页面加载、等按钮、等上传框都只是等，不占前台；只有点击和选文件那一下才占
  log('打开视频号助手…');
  await gotoUploadForm(page, log, ui);
  log('寻找上传入口…');
  const fi = await locateFileInput(page, ui);
  await ui.run(page, async () => {
    log(`开始上传成片：${topic.videoName}（大文件需要等待）`);
    await fi.setInputFiles(topic.video);
    await dismissSwitchAccountDialog(page);
  });
  T.lap('打开并开始上传');

  // ② 上传的同时把表单填了：短标题、描述+话题、定时、位置、声明原创（表单一出来就填；定时不用等上传——实测上传中就能设，设好的值上传完成后仍在）
  const done = { title: false, desc: false, schedule: false, location: false, original: false };
  // 表单一出来就填；一直没出来、上传先完成了，就交给上传完成后的核对一并补填（等待不占前台）
  const editor = page.locator('div.input-editor').first();
  const waitEnd = Date.now() + 5 * 60 * 1000;
  let formUp = false;
  while (Date.now() < waitEnd) {
    if (await editor.isVisible().catch(() => false)) { formUp = true; break; }
    if (await isUploadDone(page)) break;
    await sleep(400);
  }
  if (formUp) await ui.run(page, () => fillForm(page, fields, log, done, { quiet: true, when }));
  else log('ⓘ 上传完成时表单还没出来，稍后补填');
  const keys = ['title', 'desc', 'location', 'original'].concat(when ? ['schedule'] : []);
  T.lap(`上传中填表（${keys.filter((k) => done[k]).length}/${keys.length} 项）`);

  // ③ 等上传完成（只是等，不占前台）
  await waitUploadDone(page, log);
  T.lap('等上传完成');
  // 上传完成后预览会自动播放（有声音）：暂停它，并在接下来 40 秒里盯着（期间静音），再播就再停
  const vids = await silenceVideos(page, 40000);
  if (vids) log(`已暂停预览视频（${vids} 个）`);

  // ④ 核对前面填的还在不在、没填上的补上（含定时），然后封面（上传完成后才能点；最慢，放最后），收尾再核对一遍
  if (!formUp) await editor.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {}); // 表单还没出来就先等它（等待不占前台）
  let coverOk = false;
  let coverSrc = null;
  await ui.run(page, async () => {
    await fillForm(page, fields, log, done, { verify: true, when });
    T.lap('核对与补填');

    if (opts.cover && fs.existsSync(opts.cover.path)) {
      coverOk = await setCover(page, opts.cover, log, ui, { waitMs: opts.coverWaitMs || 90000 });
      if (coverOk) { await sleep(2500); coverSrc = await coverThumbSrc(page, opts.cover.orientation); }
      T.lap('封面');
    }

    // 收尾前再核对一遍：有的页面在封面之后才重置某些项（都设好了就只是几次读取，不耗时间）
    await fillForm(page, fields, log, done, { verify: true, when });
  });

  // 再隔几秒复核一次：平台后处理有时在填完之后才把封面重置回视频第一帧；对不上就重设一次，并把结论写进日志留证
  if (opts.cover && coverOk && coverSrc) {
    await sleep(6000);
    const last = await coverThumbSrc(page, opts.cover.orientation);
    if (last && last === coverSrc) {
      log('封面复核：缩略图与刚设好时一致，封面还在');
    } else {
      log(`⚠️ 封面复核：缩略图变了（${String(coverSrc).slice(0, 60)} → ${String(last).slice(0, 60)}），重新设置一次`);
      const again = await ui.run(page, () => setCover(page, opts.cover, log, ui, { waitMs: 30000 }));
      if (again) { await sleep(2500); coverSrc = await coverThumbSrc(page, opts.cover.orientation); log('封面复核：已重新设置'); }
      else log('⚠️ 封面重新设置没成功，发布前请手动检查封面（平台可能自动取了视频第一帧）');
    }
  }
  // 最后按内容核对封面：缩略图必须和上传的 3:4 封面长得一样；对不上（平台把它换回视频第一帧）就重设，最多 3 次，仍不行明说让你手动换
  if (opts.cover && coverOk && fs.existsSync(opts.cover.path)) {
    let verdict = null;
    let prevDiff = null;
    for (let k = 0; k < 3; k++) {
      if (k > 0) await sleep(3000);                   // 前面的复核已经等过 8 秒；重设之后再留 3 秒给平台后处理
      verdict = await coverContentMatch(page, opts.cover.orientation, opts.cover.path);
      if (!verdict) { log('封面内容核对：读不到缩略图，没法自动核对，发布前请肉眼看一下封面'); break; }
      if (verdict.ok) { log(`封面内容核对：缩略图和上传的封面一致（差异 ${verdict.diff.toFixed(3)}）`); break; }
      // 重新上传同一张封面后缩略图纹丝不动：显示的就是我们传的那张，差异来自平台的压缩和缩放，不是换成了第一帧
      // （2026-10-21 实测：差异 0.076–0.083 时封面其实是对的，原来会白白重设 3 次再报“对不上”）
      if (prevDiff !== null && Math.abs(verdict.diff - prevDiff) < 0.01) {
        log(`封面内容核对：重设后缩略图没有变化（差异 ${verdict.diff.toFixed(3)}），就是上传的封面`);
        verdict = { ok: true, diff: verdict.diff };
        break;
      }
      prevDiff = verdict.diff;
      log(`⚠️ 封面内容核对：缩略图和上传的封面对不上（差异 ${verdict.diff.toFixed(3)}，像是被平台换成了视频第一帧），重新设置（第 ${k + 1} 次）`);
      const again = await ui.run(page, () => setCover(page, opts.cover, log, ui, { waitMs: 30000 }));
      if (!again) { verdict = { ok: false, diff: verdict.diff }; break; }
      await sleep(2500);
      coverSrc = await coverThumbSrc(page, opts.cover.orientation);
      verdict = null;
    }
    if (verdict === null) {
      verdict = await coverContentMatch(page, opts.cover.orientation, opts.cover.path);
      if (verdict && !verdict.ok) log('⚠️ 视频号封面重设后仍和上传的封面对不上，发布前请手动点“编辑”换成 3:4 封面');
    } else if (!verdict.ok) {
      log('⚠️ 视频号封面和上传的封面对不上，发布前请手动点“编辑”换成 3:4 封面');
    }
  }
  await silenceVideos(page, 3000); // 收尾再停一次；之后你想看预览可以正常播放
  // 封面设好后平台偶尔会在后台处理完视频时把封面重置回视频第一帧（1019-1 实测）：收尾时对一下缩略图，变了就重设，最多 2 次
  if (opts.cover && coverOk && coverSrc) {
    for (let k = 0; k < 2; k++) {
      const now = await coverThumbSrc(page, opts.cover.orientation);
      if (!now || now === coverSrc) break;
      log(`⚠️ 封面被平台重置了（缩略图变了），重新设置（第 ${k + 1} 次）`);
      const again = await ui.run(page, () => setCover(page, opts.cover, log, ui, { waitMs: 30000 }));
      if (!again) break;
      await sleep(2500);
      coverSrc = await coverThumbSrc(page, opts.cover.orientation);
    }
  }
  const scheduled = !!(when && done.schedule);
  const s = await shot(page, `channels-done-${topic.id}-${Date.now()}`);
  log(scheduled ? '✅ 视频号填写完成（已设定时），请人工检查后点击「发表」' : '✅ 视频号填写完成，请人工检查后点击「发表」');
  log(`⏱ 用时 ${T.total().toFixed(0)} 秒：${T.summary()}`);
  return { screenshot: s, scheduled };
}

module.exports = { coverContentMatch, fillChannels, setLocationNone, declareOriginal, setScheduleTime, scheduleStill, setCover, handleCropDialog, openDialog, fillForm, isUploadDone, waitUploadDone };
