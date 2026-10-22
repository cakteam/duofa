'use strict';
/**
 * 解析「内容目录/日期目录/条目文件夹」的内容结构（格式说明见 docs/内容格式.md）：
 *  - 日期目录：MMDD（1021）或 YYYY-MM-DD / YYYYMMDD（2026-10-21）
 *  - 条目文件夹里：成片.mp4（或任意视频，取最大的）、发布文案*.txt、3x4封面*.png、4x3封面*.png
 *  - 文件夹名带「B站」的是 B站条目：B站.mp4、B站发布文案*.txt、B站封面*.png
 */
const fs = require('fs');
const path = require('path');

function listDateFolders(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

function findVideoFile(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (/^成片\.(mov|mp4|m4v|mpg)$/i.test(name)) return path.join(dir, name);
  }
  // 兜底：任何视频扩展名且体积最大的文件
  const vids = fs
    .readdirSync(dir)
    .filter((n) => /\.(mov|mp4|m4v)$/i.test(n))
    .map((n) => ({ n, s: fs.statSync(path.join(dir, n)).size }))
    .sort((a, b) => b.s - a.s);
  return vids.length ? path.join(dir, vids[0].n) : null;
}

function findCovers(dir) {
  const out = { landscape: null, portrait: null, any: null, all: [] };
  for (const name of fs.readdirSync(dir)) {
    let orientation = null;
    if (/^3x4封面.*\.png$/i.test(name)) {
      orientation = 'portrait';
      out.portrait = path.join(dir, name);
    } else if (/^4x3封面.*\.png$/i.test(name)) {
      orientation = 'landscape';
      out.landscape = path.join(dir, name);
    } else {
          continue;
    }
    out.all.push({ path: path.join(dir, name), label: name, orientation });
  }
  if (!out.any) out.any = out.landscape || out.portrait || (out.all[0] && out.all[0].path) || null;
  return out;
}

/** 解析「9月28日 08:15（...）」「2026-09-28 08:15」→ {year?, month, day, hh, mm}；只写「08:15」→ {hh, mm}（日期取目录日期） */
function parseSuggestTimeText(text) {
  let m = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*(\d{1,2})[:：](\d{2})/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3], hh: +m[4], mm: +m[5] };
  m = text.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:：](\d{2})/);
  if (m) return { month: +m[1], day: +m[2], hh: +m[3], mm: +m[4] };
  m = text.match(/^\s*(\d{1,2})[:：](\d{2})/);
  if (m) return { hh: +m[1], mm: +m[2] };
  return null;
}

function inferYear(month, day) {
  const now = new Date();
  for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
    const t = new Date(y, month - 1, day);
    const diff = (t - now) / 86400000;
    if (diff > -60 && diff < 365) return y;
  }
  return now.getFullYear();
}

/** 从日期目录名推断日期：2026-09-28 / 20260928 → {year, month, day}；0928（或 0928-1-xxx）→ {month, day} */
function inferDateFromFolderName(name) {
  let m = name.match(/^(\d{4})-?(\d{2})-?(\d{2})(?!\d)/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return { year: +m[1], month: +m[2], day: +m[3] };
  m = name.match(/^(\d{2})(\d{2})/);
  if (!m) return null;
  return { month: +m[1], day: +m[2] };
}

/** 日期对象的年份：写了年份就用它，否则按 inferYear 推断（今年；已过去 60 天以上算明年） */
function yearOf(d) {
  return d.year || inferYear(d.month, d.day);
}

/** 读文案文本：去掉 BOM；不是合法 UTF-8 时按 GBK 读（Windows 记事本「ANSI」存的中文） */
function readText(file) {
  const buf = fs.readFileSync(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      text = buf.toString('utf8');
    }
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** 解析 发布文案与素材源地址.txt */
function parseCopyTxt(txtPath) {
  const raw = readText(txtPath);
  const out = { suggestTimeRaw: null, titleLines: [], highlight: null, body: '', intro: '', tags: [] };

  const suggest = raw.match(/【建议发布时间】\s*\n?\s*([^\n]+)/);
  if (suggest) {
    out.suggestTimeRaw = parseSuggestTimeText(suggest[1]);
  }

  const section = (startRe, endRe) => {
    const s = raw.match(startRe);
    if (!s) return '';
    const from = s.index + s[0].length;
    let to = raw.length;
    if (endRe) {
      const e = raw.slice(from).match(endRe);
      if (e) to = from + e.index;
    }
    return raw.slice(from, to).trim();
  };

  const titleBlock = section(/【标题】\s*\n?/, /【标红钩子词】|【/);
  out.titleLines = titleBlock
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const sp = section(/【视频号短标题】\s*\n?/, /【|={5,}/);
  if (sp) out.shortTitle = sp.split('\n')[0].trim();

  const hl = raw.match(/【标红钩子词】[:：]\s*([^\n]+)/);
  if (hl) out.highlight = hl[1].trim();

  out.body = section(/【正文】\s*\n?/, /【视频简介】|【|={5,}/);
  out.intro = section(/【(?:视频)?简介】\s*\n?/, /={5,}|【素材源地址】|【/);

  // 话题标签：取视频简介块 + 全文里独立的 #开头 词
  const tagSource = out.intro + '\n' + raw;
  const seen = new Set();
  for (const t of tagSource.matchAll(/#[^\s#，。；、！！？?~]+/g)) {
    const tag = t[0].slice(1).trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.tags.push(tag);
    }
    if (out.tags.length >= 6) break;
  }
  return out;
}

/** 旧版 B站文案格式（「候选 1」标题 + 【视频简介】+ 🏷️标签系统）；新格式与普通文案相同，见 parseBiliCopy */
function parseBiliTxt(txtPath) {
  const raw = readText(txtPath);
  const out = { title: '', intro: '', tags: [], suggestTimeRaw: null };

  // 建议公开时间：12:00
  const t = raw.match(/建议公开时间[：:]\s*(\d{1,2})[:：](\d{2})/);
  if (t) out.suggestTimeRaw = { hh: +t[1], mm: +t[2] };

  // 标题候选 1（推荐）
  const c1 = raw.match(/候选\s*1[^\n：]*：\s*\n\s*([^\n]+)/);
  if (c1) out.title = c1[1].trim();

  // 视频简介：从【视频简介…】之后（跳过分隔线）直到 🏷️ 标签系统（简介内容自身含【】小节，不能以【为界）
  const s = raw.match(/【视频简介[^\n]*】\s*\n=+\s*\n?/);
  if (s) {
    const from = s.index + s[0].length;
    let to = raw.length;
    const e = raw.slice(from).match(/🏷️|={5,}/);
    if (e) to = from + e.index;
    out.intro = raw.slice(from, to).replace(/\n{3,}/g, '\n\n').trim();
  }

  // 标签：🏷️【标签系统…】附近一行里的 #词（B站上限 10 个）
  const tagBlock = raw.slice(Math.max(0, raw.indexOf('标签系统')));
  const seen = new Set();
  for (const m of tagBlock.matchAll(/#[^\s#，。；、！！？?~]+/g)) {
    const tag = m[0].slice(1).trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.tags.push(tag);
    }
    if (out.tags.length >= 10) break;
  }
  return out;
}

/** B站文案：普通文案格式（【标题】【简介】#话题【建议发布时间】）优先，认出旧格式时按旧格式解析 */
function parseBiliCopy(txtPath) {
  const raw = readText(txtPath);
  if (/候选\s*1/.test(raw) && /标签系统/.test(raw)) return parseBiliTxt(txtPath);
  const c = parseCopyTxt(txtPath);
  return { title: c.titleLines.join(''), intro: c.intro || c.body, tags: c.tags.slice(0, 10), suggestTimeRaw: c.suggestTimeRaw };
}

/** 扫描一个日期目录，返回主题列表（已解析全部字段） */
function scanDateFolder(dateDir) {
  const dateFolderName = path.basename(dateDir);
  const entries = fs.readdirSync(dateDir, { withFileTypes: true });
  const inferred = inferDateFromFolderName(dateFolderName);

  const topics = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (/素材$|^数据下载$|^[._]/.test(e.name)) continue; // 非发布内容

    const dir = path.join(dateDir, e.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }

    // —— B站合集目录：一条内容 = MMDD-B站.mp4/mov 合集成片 ——
    if (/B站/.test(e.name)) {
      const candidates = files
        .filter((n) => /^(\d{4}-)?B站\.(mp4|mov|m4v)$/i.test(n))
        .map((n) => ({ n, s: fs.statSync(path.join(dir, n)).size }))
        .sort((a, b) => b.s - a.s);
      const video = candidates.length ? path.join(dir, candidates[0].n) : null;
      const txtPath = files.find((n) => /发布文案.*\.txt$/.test(n));
      if (!video && !txtPath) continue;
      const parsed = txtPath ? parseBiliCopy(path.join(dir, txtPath)) : { title: '', intro: '', tags: [], suggestTimeRaw: null };

      let scheduledAt = null;
      const dateBase = parsed.suggestTimeRaw && parsed.suggestTimeRaw.month ? parsed.suggestTimeRaw : inferred;
      if (dateBase && parsed.suggestTimeRaw) {
        const y = yearOf(dateBase);
        const d = new Date(y, dateBase.month - 1, dateBase.day, parsed.suggestTimeRaw.hh, parsed.suggestTimeRaw.mm);
        scheduledAt = d.toISOString();
      }
      const covers = findCovers(dir);
      const biliCover = files.find((n) => /B站封面.*\.png$/i.test(n));
      covers.any = covers.any || (biliCover ? path.join(dir, biliCover) : null);
      topics.push({
        id: e.name,
        kind: 'bili',
        dir,
        name: e.name,
        video,
        videoName: video ? path.basename(video) : null,
        covers,
        coverOptions: biliCover ? [{ path: path.join(dir, biliCover), label: biliCover, orientation: 'landscape', ratioLabel: '16:9' }] : [],
        txtPath: txtPath ? path.join(dir, txtPath) : null,
        titleLines: parsed.title ? [parsed.title] : [],
        highlight: null,
        body: parsed.intro,
        intro: parsed.intro,
        tags: parsed.tags,
        suggestTimeRaw: parsed.suggestTimeRaw,
        scheduledAt,
      });
      continue;
    }

    // —— 常规主题目录（视频号 + 抖音） ——
    const video = findVideoFile(dir);
    const txtPath = files.find((n) => /发布文案.*\.txt$/.test(n));
    if (!video && !txtPath) continue; // 跳过素材目录、B站部分等

    const parsed = txtPath ? parseCopyTxt(path.join(dir, txtPath)) : { titleLines: [], body: '', intro: '', tags: [], suggestTimeRaw: null };

    // 发布时间：文案里的【建议发布时间】（只写了时刻就用目录日期）> 无
    let scheduledAt = null;
    const dateBase = parsed.suggestTimeRaw && parsed.suggestTimeRaw.month ? parsed.suggestTimeRaw : inferred;
    const hhmm = parsed.suggestTimeRaw ? `${String(parsed.suggestTimeRaw.hh).padStart(2, '0')}:${String(parsed.suggestTimeRaw.mm).padStart(2, '0')}` : null;
    if (dateBase && hhmm) {
      const [hh, mm] = hhmm.split(':').map(Number);
      const y = yearOf(dateBase);
      const d = new Date(y, dateBase.month - 1, dateBase.day, hh, mm);
      // 已过期的解析结果也保留：UI 会预填，执行时若仍已过期则只提示、不强设定时
      scheduledAt = d.toISOString();
    }

    const covers = findCovers(dir);
    topics.push({
      id: e.name,
      dir,
      name: e.name,
      video,
      videoName: video ? path.basename(video) : null,
      covers,
      coverOptions: covers.all,
      txtPath: txtPath ? path.join(dir, txtPath) : null,
      titleLines: parsed.titleLines,
      highlight: parsed.highlight,
      shortTitle: parsed.shortTitle || '',
      body: parsed.body,
      intro: parsed.intro,
      tags: parsed.tags,
      suggestTimeRaw: parsed.suggestTimeRaw,
      scheduledAt,
    });
  }
  topics.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  return topics;
}

/** 去掉文案里内联的 #话题（话题由各平台的“话题字段”单独添加，避免重复） */
function stripHashtags(s) {
  return (s || '')
    .split('\n')
    .map((l) => l.replace(/#[^\s#，。；、！！？?~]+/g, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 生成两个平台的默认填写字段（UI 可再编辑） */
function deriveFields(t) {
  // B站内容：标题=候选1，描述=视频简介，标签≤10
  if (t.kind === 'bili') {
    const biliCover = ((t.coverOptions || [])[0] || {}).path || '';
    return {
      douyinTitle: '',
      douyinDesc: '',
      channelsShortTitle: '',
      channelsDesc: '',
      tags: (t.tags || []).slice(0, 10),
      channelsCover: '',
      douyinCoverPortrait: '',
      douyinCoverLandscape: '',
      biliTitle: t.titleLines ? t.titleLines.join('') : '',
      biliDesc: t.intro || '',
      biliCover,
    };
  }

  const joined = (t.titleLines || []).join('');
  const firstLine = (t.titleLines || [])[0] || joined;

  // 抖音标题 ≤30 字
  let dyTitle = joined.slice(0, 30);

  // 视频号短标题 6~16 字（实测页面 16 字能填满，没有 15 字的限制）。
  // 优先用文案里单独写的【视频号短标题】；否则用整条标题（两行合起来，封面上每行 ≤8 字，正好 ≤16）；
  // 实在超长就整行取（宁可只取一整行，也不在句子中间截断）。
  const SP_MAX = 16;
  const SP_MIN = 6;
  const lines = (t.titleLines || []).map((l) => l.trim()).filter(Boolean);
  let spShort = (t.shortTitle || '').trim();
  if (!spShort || spShort.length > SP_MAX) spShort = joined;
  if (spShort.length > SP_MAX) {
    const whole = lines.filter((l) => l.length <= SP_MAX && l.length >= SP_MIN);
    spShort = whole.length ? whole[whole.length - 1] : firstLine.slice(0, SP_MAX);
  }
  if (spShort.length < SP_MIN) spShort = (spShort + '，精彩内容分享').slice(0, SP_MIN + 1);

  // 封面默认（V4.0.2）：视频号单张，默认选候选里第一张（3x4 竖版优先，其次 4x3 横版）；
  // 抖音两张：竖封面 3:4（3x4封面）+ 横封面 4:3（4x3封面）
  const all = (t.covers && t.covers.all) || [];
  const landscape = all.find((c) => c.orientation === 'landscape');
  const portrait = all.find((c) => c.orientation === 'portrait');

  return {
    douyinTitle: dyTitle,
    douyinDesc: stripHashtags(t.intro || t.body || ''),
    channelsShortTitle: spShort,
    channelsDesc: stripHashtags(t.intro || t.body || ''),
    tags: t.tags || [],
    channelsCover: (portrait || landscape || all[0] || {}).path || '',
    douyinCoverPortrait: (portrait || {}).path || '',
    douyinCoverLandscape: (landscape || {}).path || '',
  };
}

module.exports = {
  listDateFolders,
  scanDateFolder,
  deriveFields,
  parseCopyTxt,
  parseBiliTxt,
  parseBiliCopy,
  readText,
  stripHashtags,
  inferDateFromFolderName,
  inferYear,
  yearOf,
};
