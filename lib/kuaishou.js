'use strict';
/**
 * 快手创作者服务平台（cp.kuaishou.com）自动填入流程（2026-10-14 在真实页面逐步实测，并真实定时发布过 1015-1）。
 *   上传页 input[type=file]（视频）→ 等表单（#work-description-edit）→ 作品描述（contenteditable，纯文字；话题就是文字里的 #话题，发布时由平台解析）
 *   → 封面（点封面缩略图 → 「上传封面」tab → 传图 → 确认）→ 等视频上传完成（出现「重新上传」）→ 定时发布（antd 日期时间框）→ 截图。
 * 只填表，不点「发布」（和视频号、抖音一样，发布永远由人点）。
 *
 * 快手和别的平台不同的几点（都是实测）：
 *   - 没有单独的标题栏，只有一个“作品描述”：简介 + #话题 写在同一个框里；
 *   - 话题必须是真正的“话题标记”（<span is-tag><span class=at-tag-item>），纯文字 #xxx 发布后不算话题（2026-10-15 实测）：
 *     编辑器要先“唤醒”（点一下下面的推荐话题再删掉），之后敲 # + 话题名会弹出搜索列表，点中同名那一行（或回车/空格）才会变成话题标记；
 *   - 「重新上传」按钮从 0% 就一直在，不能当“上传完成”的信号；要看「上传中」字样消失；
 *   - 话题最多 4 个，超了点发布会报“话题标签数量超过上限：4”（调用方 publish-runner 按 4 个截）；
 *   - 封面只有一张：在封面弹窗的「上传封面」里传图，裁剪比例选默认的“原始比例”就是整张图（用 3:4 竖封面；没有竖封面才用 4:3 横封面）；
 *   - 「发布」按钮是个 div（class 含 button-primary），不是 <button>；发布成功会跳到作品管理页（待发布 / 审核中）。
 */
const path = require('path');
const fs = require('fs');
const { silenceVideos, createTimer } = require('./common');
const { NOOP_UI } = require('./ui-lock');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const UPLOAD_URL = 'https://cp.kuaishou.com/article/publish/video';
const MAX_TAGS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
/** antd 日期时间框里的格式：2026-10-15 08:30:00 */
const fmtWhen = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

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

/** 作品描述 = 简介（不带 #话题）+ 空格分隔的 #话题（最多 4 个）。返回 {text, tags, dropped}。 */
function composeDescription(desc, tags, max = MAX_TAGS) {
  const all = [...new Set((tags || []).map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean))];
  const use = all.slice(0, max);
  return { text: `${(desc || '').trim()}${use.map((t) => ` #${t}`).join('')}`, tags: use, dropped: all.slice(max) };
}

/** 找到视频上传入口；被要求登录时提示人在 Chrome 里登录并一直等（不占前台锁）。 */
async function findUploadInput(page, log, ui = NOOP_UI, waitSec = 240) {
  const deadline = Date.now() + waitSec * 1000;
  let announced = false;
  let loginSince = 0;                                   // 已登录时也会先经过一下 passport 的跳转页，持续停在登录页超过 8 秒才算“要登录”
  while (Date.now() < deadline) {
    const el = page.locator('input[type="file"][accept*="video"]').first();
    try { if (await el.count()) return el; } catch { /* 页面还在跳转 */ }
    if (/passport\.kuaishou\.com|login/i.test(page.url())) {
      loginSince = loginSince || Date.now();
      if (!announced && Date.now() - loginSince > 8000) {
        announced = true;
        log('⏳ 快手要求登录：请在打开的 Chrome 窗口里登录快手创作者中心（脚本会自动等待）…');
        await ui.run(page, async () => {});
      }
    } else {
      loginSince = 0;
    }
    await sleep(1000);
  }
  await shot(page, 'kuaishou-no-upload-input');
  const err = new Error('未找到快手上传入口（可能未登录/需要验证/页面改版），截图见 logs/kuaishou-no-upload-input.png');
  err.code = 'NO_FILE_INPUT';
  throw err;
}

const editorOf = (page) => page.locator('#work-description-edit').first();
const tagNames = (editor) => editor.evaluate((e) => [...e.querySelectorAll('.at-tag-item')].map((x) => x.getAttribute('data-tag-name') || x.textContent.replace(/^#/, '')));

async function clearEditor(page, editor) {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  for (let i = 0; i < 12; i++) {
    if (!String((await editor.innerText().catch(() => '')) || '').trim()) break;
    await page.keyboard.press('Backspace');
  }
}

/**
 * “唤醒”话题搜索：编辑器刚打开时敲 # 不会弹搜索列表，点一下下面的推荐话题（再删掉）之后才会。
 * 先把简介敲进去再唤醒：这样简介是普通黑字（先唤醒再敲，简介会继承话题的蓝色）。返回是否唤醒了。
 */
async function primeTopics(page, editor, desc) {
  await clearEditor(page, editor);
  if (desc) await page.keyboard.type(`${desc} `, { delay: 2 });
  const chip = page.getByText(/^#[^\s#]+$/).first();
  try {
    await chip.click({ timeout: 6000 });
  } catch {
    return false;
  }
  await sleep(600);
  for (let i = 0; i < 6 && (await tagNames(editor)).length; i++) {   // 把刚点出来的推荐话题退掉
    await page.keyboard.press('Backspace');
    await sleep(150);
  }
  if ((await tagNames(editor)).length) return false;
  const left = String((await editor.innerText().catch(() => '')) || '').replace(/\s+/g, '');
  if (left !== String(desc || '').replace(/\s+/g, '')) {              // 退多了/退少了：整段重敲
    await clearEditor(page, editor);
    if (desc) await page.keyboard.type(`${desc} `, { delay: 2 });
  }
  const tail = String((await editor.innerText().catch(() => '')) || '');
  if (desc && /\s\s$/.test(tail)) await page.keyboard.press('Backspace');   // 简介后面只留一个空格
  return true;
}

/** 搜索列表里和 tag 同名的那一行（"# 人工智能 104.7亿次播放"）的中心坐标；没有返回 null。 */
function findTopicRow(page, tag) {
  return page.evaluate((t) => {
    const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
    const rows = [...document.querySelectorAll('*')].filter((e) => e.children.length <= 4 && /播放$/.test(norm(e.innerText)) && norm(e.innerText).length < 80 && norm(e.innerText).startsWith('#'));
    const hit = rows.find((e) => norm(e.innerText).replace(/^#\s*/, '').split(' ')[0] === t);
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 } : null;
  }, tag);
}

/** 把一个话题加成真正的话题标记。返回 'picked'（点中了同名话题）| 'typed'（没有同名话题，按原文加成话题）| false。 */
async function addTopic(page, editor, tag) {
  const before = (await tagNames(editor)).length;
  await page.keyboard.type('#');
  await sleep(500);
  await page.keyboard.type(tag, { delay: 120 });
  let row = null;
  for (let i = 0; i < 6 && !row; i++) {            // 搜索结果是异步出来的，最多等 ~3 秒
    await sleep(500);
    row = await findTopicRow(page, tag);
  }
  let how = 'picked';
  if (row) {
    await page.mouse.click(row.x, row.y);
  } else {
    await page.keyboard.press('Space');            // 平台上没有同名话题：空格也会把敲的字变成话题标记
    how = 'typed';
  }
  await sleep(600);
  const names = await tagNames(editor);
  if (names.length > before && names[names.length - 1] === tag) return how;
  return false;
}

async function fillDescription(page, desc, tags, log) {
  const editor = editorOf(page);
  await editor.waitFor({ state: 'visible', timeout: 600000 });
  let primed = false;
  if (tags.length) primed = await primeTopics(page, editor, desc);
  if (!primed) {
    await clearEditor(page, editor);
    if (desc) await page.keyboard.type(`${desc} `, { delay: 2 });
  }
  const got = [];
  const failed = [];
  const notFound = [];
  if (tags.length && !primed) {
    // 唤醒不成功（页面没有推荐话题）：退回纯文字，并明说
    await page.keyboard.type(tags.map((t) => `#${t}`).join(' '), { delay: 2 });
    log('⚠️ 没能唤醒话题搜索，话题只是写成了文字（不会变成话题），请发布前手动在描述里点一下话题');
  } else {
    for (const tag of tags) {
      let how = false;
      for (let attempt = 0; attempt < 2 && !how; attempt++) how = await addTopic(page, editor, tag);
      if (how) {
        got.push(tag);
        if (how === 'typed') notFound.push(tag);
      } else {
        failed.push(tag);
        // 这个话题没加上：把敲进去的残留文字退掉，别留一截 "#xxx"
        for (let i = 0; i < tag.length + 1; i++) await page.keyboard.press('Backspace');
      }
    }
  }
  await page.keyboard.press('Escape');
  await sleep(300);
  const text = String((await editor.innerText().catch(() => '')) || '').trim();
  log(`已填写作品描述（${text.length} 字）${tags.length ? `，话题 ${got.length}/${tags.length} 个已变成话题标记` : ''}`);
  if (notFound.length) log(`ⓘ 快手上没有现成的话题「${notFound.join('、')}」，已按原文建成话题`);
  if (failed.length) log(`⚠️ 话题「${failed.join('、')}」没能加成话题，请发布前在描述里手动添加`);
  return { got, failed };
}

/** 把还开着的弹窗关掉：先点右上角 ×，再按 Esc，最多试几轮；返回是否已全部关闭。 */
async function closeModals(page) {
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator('.ant-modal:visible').count())) return true;
    try { await page.locator('.ant-modal:visible .ant-modal-close').first().click({ timeout: 2000 }); } catch { /* ignore */ }
    try { await page.keyboard.press('Escape'); } catch { /* ignore */ }
    await sleep(600);
  }
  return !(await page.locator('.ant-modal:visible').count());
}

/** 上传封面：点封面缩略图 → 「上传封面」tab → 传图 → 选好裁剪比例（3:4 竖封面选 3:4，4:3 选 4:3）→ 确认；失败只告警不中断（用平台自动截的封面）。 */
async function setCover(page, cover, log) {
  const portrait = cover && cover.portrait && cover.portrait.path;
  const file = portrait || (cover && cover.landscape && cover.landscape.path);
  if (!file) return false;
  const ratio = portrait ? '3:4' : '4:3';
  try {
    await page.locator('[class*="cover-full-editor"]').first().click({ timeout: 15000 });
    const modal = page.locator('.ant-modal:visible').first();
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    // 弹窗默认在「封面截取」，要切到「上传封面」并确认切过去了（弹窗刚开时点击偶尔被吞）
    // 多个平台同时在填、机器忙的时候，切 tab 后文件框可能 2~3 秒才出来：每次点完等它出现（或图已经传好了）再判断
    const uploaded = modal.getByText('清空上传', { exact: true }).first();
    let onUpload = false;
    for (let i = 0; i < 4 && !onUpload; i++) {
      await modal.getByText('上传封面', { exact: true }).first().click();
      for (let j = 0; j < 8 && !onUpload; j++) {
        await sleep(500);
        onUpload = (await modal.locator('input[type="file"]').count()) > 0 || (await uploaded.isVisible().catch(() => false));
      }
    }
    if (!onUpload) throw new Error('没能切到「上传封面」');
    if (!(await uploaded.isVisible().catch(() => false))) {
      await modal.locator('input[type="file"]').first().setInputFiles(file);
    }
    await uploaded.waitFor({ state: 'visible', timeout: 20000 });
    await sleep(500);
    // 选裁剪比例：默认是「原始比例」，要明确点 3:4（否则最后记成原始比例）
    const opt = modal.getByText(ratio, { exact: true }).first();
    if (await opt.count()) await opt.click();
    else log(`⚠️ 封面弹窗里没找到 ${ratio} 选项，用默认的原始比例`);
    await sleep(500);
    await modal.getByRole('button', { name: '确认' }).first().click();
    for (let i = 0; i < 20; i++) {
      if (!(await page.locator('.ant-modal:visible').count())) break;
      await sleep(500);
    }
    if (await page.locator('.ant-modal:visible').count()) {
      await shot(page, 'kuaishou-cover-stuck');
      log('⚠️ 封面弹窗没能关闭，请发布前手动检查封面');
      return false;
    }
    log(`已上传封面：${path.basename(file)}（${ratio}）`);
    return true;
  } catch (e) {
    await shot(page, 'kuaishou-cover-fail');
    log(`⚠️ 封面上传失败（${e.message.split('\n')[0]}），用平台自动截的封面，可发布前手动设置`);
    // 弹窗还开着的话关掉，别挡住后面的定时（1021 就是弹窗没关，定时那一步 30 秒点不到「定时发布」）
    await closeModals(page);
    return false;
  }
}

/**
 * 等视频传完。信号是「上传中」字样消失（页面上进度环旁边写着「上传中」+ 百分比）；
 * 「重新上传」按钮从 0% 起就在，不能用它判断（旧版就是这样把封面/话题抢在上传中去做，卡住了）。
 */
async function waitUploadComplete(page, log, timeoutSec = 1800) {
  const t0 = Date.now();
  const deadline = t0 + timeoutSec * 1000;
  let lastReport = 0;
  let seenUploading = false;
  let quiet = 0;
  while (Date.now() < deadline) {
    try {
      if (await page.getByText('上传失败', { exact: false }).first().isVisible().catch(() => false)) {
        await shot(page, 'kuaishou-upload-error');
        throw new Error('快手检测到上传失败，请查看截图 logs/kuaishou-upload-error.png 后重试');
      }
      const uploading = await page.getByText('上传中', { exact: false }).first().isVisible().catch(() => false);
      if (uploading) { seenUploading = true; quiet = 0; } else quiet++;
      // 看到过「上传中」之后连续两次没有了 = 传完；一直没看到（传得极快）就等 12 秒再认
      if (quiet >= 2 && (seenUploading || Date.now() - t0 > 12000)) {
        log('视频上传完成');
        return;
      }
    } catch (e) {
      if (e.message && e.message.includes('上传失败')) throw e;
    }
    const now = Date.now();
    if (now - lastReport > 30000) {
      log(`视频上传中…（已等 ${Math.round((now - t0) / 1000)} 秒）`);
      lastReport = now;
    }
    await sleep(1000);
  }
  await shot(page, 'kuaishou-upload-timeout');
  throw new Error(`快手上传超过 ${timeoutSec} 秒仍未完成`);
}

/** 快手定时现在是不是已经设成想要的（日期时间框里就是目标时间）。读不到就当没设。 */
async function scheduleStill(page, when) {
  try {
    const dt = page.locator('input[placeholder="选择日期时间"]').first();
    if (!(await dt.count()) || !(await dt.isVisible().catch(() => false))) return false;
    return (await dt.inputValue({ timeout: 2000 }).catch(() => '')).trim() === fmtWhen(when);
  } catch {
    return false;
  }
}

async function setScheduleTime(page, when, log) {
  try {
    await closeModals(page); // 封面弹窗没关会盖住「定时发布」，点击会一直等到 30 秒超时
    const radio = page.getByText('定时发布', { exact: true }).first();
    if (!(await radio.count())) {
      log('⚠️ 未找到「定时发布」选项，保持默认立即发布，请手动调整');
      return false;
    }
    await radio.scrollIntoViewIfNeeded().catch(() => {});
    await radio.click();
    await sleep(1000);
    const dt = page.locator('input[placeholder="选择日期时间"]').first();
    await dt.waitFor({ state: 'visible', timeout: 10000 });
    await dt.click();
    await page.keyboard.press('ControlOrMeta+A');
    const text = fmtWhen(when);
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await sleep(800);
    // 「确定」偶尔被页面上的提示条挡住，点不到也没关系：Enter 已经把时间填进去了，下面按输入框里的值核对
    // （2026-10-22 Windows 实测：时间其实设好了，却因为这里 30 秒超时被报成失败）
    const ok = page.locator('.ant-picker-dropdown').getByRole('button', { name: '确定' }).first();
    if ((await ok.count()) && (await ok.isVisible().catch(() => false))) await ok.click({ timeout: 5000 }).catch(() => page.keyboard.press('Escape').catch(() => {}));
    await sleep(800);
    if ((await dt.inputValue().catch(() => '')).trim() !== text) {
      await shot(page, 'kuaishou-schedule-mismatch');
      log(`⚠️ 定时时间没有设成 ${text}（页面里是 ${await dt.inputValue().catch(() => '?')}），请手动调整`);
      return false;
    }
    log(`定时发布已填写：${text}`);
    return true;
  } catch (e) {
    await shot(page, 'kuaishou-schedule-fail');
    log(`⚠️ 定时发布填写失败（${e.message.split('\n')[0]}），保持默认，请手动调整`);
    return false;
  }
}

/**
 * 主流程：在给定 page（新标签页）里完成快手填表。
 * fields: {desc, tags}（tags 调用方已按 4 个截）; opts: {schedule, when, cover, ui}
 */
async function fillKuaishou(page, topic, fields, opts, log) {
  const ui = opts.ui || NOOP_UI;
  const T = createTimer();
  log('打开快手创作者中心发布页…');
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(2000);

  const input = await findUploadInput(page, log, ui);
  log(`开始上传成片：${topic.videoName}（大文件需要等待）`);
  await input.setInputFiles(topic.video);
  T.lap('打开并开始上传');

  await page.locator('#work-description-edit').first().waitFor({ state: 'visible', timeout: 600000 });
  const { tags, dropped } = composeDescription(fields.desc, fields.tags);
  if (dropped.length) log(`⚠️ 话题超过 ${MAX_TAGS} 个（快手上限），只用前 ${MAX_TAGS} 个：${tags.join(' ')}（没用：${dropped.join(' ')}）`);

  // 先等视频传完：传完前话题搜索、封面入口都不可用（实测会提示“请耐心等待视频上传完成”）；定时最后设
  await waitUploadComplete(page, log);
  T.lap('等上传完成');
  const vids = await silenceVideos(page, 20000);
  if (vids) log(`已暂停预览视频（${vids} 个）`);

  await ui.run(page, () => fillDescription(page, (fields.desc || '').trim(), tags, log));
  T.lap('填描述和话题');

  if (opts.cover && (opts.cover.portrait || opts.cover.landscape)) {
    await ui.run(page, () => setCover(page, opts.cover, log));
    T.lap('封面');
  }
  const when = opts.schedule && opts.when ? opts.when : null;
  let scheduled = false;
  if (when) {
    scheduled = await ui.run(page, () => setScheduleTime(page, when, log));
    T.lap('定时');
  }
  await silenceVideos(page, 3000);
  const s = await shot(page, `kuaishou-done-${topic.id}-${Date.now()}`);
  log(scheduled ? '✅ 快手填写完成（已设定时），请人工检查后点击「发布」' : '✅ 快手填写完成，请人工检查后点击「发布」');
  log(`⏱ 用时 ${T.total().toFixed(0)} 秒：${T.summary()}`);
  return { screenshot: s, scheduled };
}

module.exports = { fillKuaishou, composeDescription, fmtWhen, setScheduleTime, scheduleStill, setCover, waitUploadComplete, MAX_TAGS, UPLOAD_URL };
