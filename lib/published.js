'use strict';
/**
 * 看板「发布内容」表的数据来源：直接扫描内容目录（不需要任何数据库）。
 * 每个日期目录里有成片、且发布日期不晚于今天的常规条目算一行；各平台播放由 lib/match.js 从下载快照里匹配补上。
 * 返回结构与 match.attachSnapshotPerf 约定的一致：{ available, total, last7, rows, biliEpisodes }。
 */
const path = require('path');
const { listDateFolders, scanDateFolder, inferDateFromFolderName, yearOf } = require('./parse');

const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

function listPublished(contentDir, { limit = 30, now = new Date() } = {}) {
  let folders;
  try {
    folders = listDateFolders(contentDir);
  } catch (e) {
    return { available: false, reason: `读不到内容目录：${contentDir}（${e.message}）` };
  }
  const today = ymd(now);
  const weekAgo = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const all = [];
  const biliEpisodes = {};
  for (const name of folders) {
    const md = inferDateFromFolderName(name);
    if (!md) continue;
    const folderDate = `${yearOf(md)}-${p2(md.month)}-${p2(md.day)}`;
    let topics = [];
    try {
      topics = scanDateFolder(path.join(contentDir, name));
    } catch {
      continue;
    }
    for (const t of topics) {
      if (!t.video) continue;
      const at = t.scheduledAt ? new Date(t.scheduledAt) : null;
      const pubDate = at ? ymd(at) : folderDate;
      if (pubDate > today) continue;
      const title = (t.titleLines || []).join('');
      const hhmm = at ? `${p2(at.getHours())}:${p2(at.getMinutes())}` : '';
      if (t.kind === 'bili') {
        if (!biliEpisodes[pubDate]) biliEpisodes[pubDate] = title;
        continue;
      }
      all.push({
        itemId: path.basename(t.dir),
        pubDate,
        plannedTime: hhmm,
        slotType: hhmm, // 看板「档期」列显示它
        title: title || t.name,
        hookWord: t.highlight || '',
        status: '',
        platforms: {},
      });
    }
  }
  all.sort((a, b) => b.pubDate.localeCompare(a.pubDate) || a.plannedTime.localeCompare(b.plannedTime));
  return {
    available: true,
    total: all.length,
    last7: all.filter((r) => r.pubDate >= weekAgo).length,
    rows: all.slice(0, limit),
    biliEpisodes,
  };
}

module.exports = { listPublished };
