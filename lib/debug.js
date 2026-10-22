'use strict';
/**
 * 诊断工具：打开视频号发布表单（需上传成片让表单完整渲染），
 * 导出包含关键词的元素结构，用于修选择器。诊断标签页用完即关，不会发布。
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const HOME_URL = 'https://channels.weixin.qq.com/platform';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findFileInput(page) {
  for (const fr of page.frames()) {
    try {
      const fi = fr.locator('input[type="file"]');
      if (await fi.count()) return fi.first();
    } catch {}
  }
  return null;
}

/** 打开发布表单并上传视频，等表单完全就绪 */
async function openForm(page, video, log) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2000);
  const btn = page.locator('button.weui-desktop-btn', { hasText: '发表视频' }).first();
  await btn.click({ timeout: 20000 }).catch(() => {});
  await page.waitForURL('**/platform/post/create', { timeout: 60000 }).catch(() => {});
  try {
    await page.waitForLoadState('networkidle', { timeout: 20000 });
  } catch {}

  let fi = null;
  for (let i = 0; i < 60 && !fi; i++) {
    fi = await findFileInput(page);
    if (!fi) await sleep(1000);
  }
  if (!fi) throw new Error('未找到上传框');
  log(`上传 ${path.basename(video)} …`);
  await fi.setInputFiles(video);

  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const pub = page.locator('div.form-btns button:has-text("发表"):visible').first();
    if (await pub.count()) {
      const cls = (await pub.getAttribute('class')) || '';
      if (!(await pub.isDisabled().catch(() => true)) && !cls.includes('weui-desktop-btn_disabled')) break;
    }
    await sleep(2000);
  }
  log('表单已就绪');
}

/** 导出所有 frame 中文本包含关键词的最内层元素（含 3 级父链，便于分析点击目标） */
async function dumpCandidates(page) {
  const KEYWORDS = ['位置', '原创', '声明'];
  const out = [];
  for (const fr of page.frames()) {
    const items = await fr
      .evaluate((kws) => {
        const chain = (el) => {
          const arr = [];
          let p = el.parentElement;
          for (let i = 0; i < 3 && p; i++) {
            arr.push({ tag: p.tagName, cls: String(p.className).slice(0, 120), html: p.outerHTML.slice(0, 400) });
            p = p.parentElement;
          }
          return arr;
        };
        const res = [];
        for (const el of document.querySelectorAll('*')) {
          const txt = (el.textContent || '').trim();
          if (!txt || txt.length > 40) continue;
          if (!kws.some((k) => txt.includes(k))) continue;
          // 只保留最内层节点（子节点已覆盖同一文本的父节点跳过）
          if ([...el.children].some((c) => kws.some((k) => (c.textContent || '').includes(k)))) continue;
          const rect = el.getBoundingClientRect();
          res.push({
            tag: el.tagName,
            cls: String(el.className).slice(0, 120),
            text: txt.slice(0, 40),
            visible: rect.width > 0 && rect.height > 0,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            html: el.outerHTML.slice(0, 600),
            parents: chain(el),
          });
          if (res.length > 80) break;
        }
        return res;
      }, KEYWORDS)
      .catch((e) => [{ error: e.message }]);
    out.push({ frame: fr.url().slice(0, 120), items });
  }
  const file = path.join(LOG_DIR, `dom-dump-${Date.now()}.json`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  await page.screenshot({ path: file.replace('.json', '.png'), fullPage: true }).catch(() => {});
  return file;
}

module.exports = { openForm, dumpCandidates };
