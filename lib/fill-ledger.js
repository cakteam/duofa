'use strict';
/**
 * 填表结果账本：发布器每填好一个「条目 × 平台」就记一笔，存到数据目录。
 * 发布页的“一键标记”靠它知道这一批到底填过哪些——不能只看内存里最近一次任务
 * （先填 视频号/抖音/快手、再单独填 B站合集时，后一次任务会把前一次的结果顶掉；刷新/重启发布器也会丢）。
 * 键 = 条目目录 + 平台；同一键后一次覆盖前一次。
 */
const fs = require('fs');
const path = require('path');

function create({ file }) {
  let rows = null;
  const load = () => {
    if (rows) return rows;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      rows = Array.isArray(d.rows) ? d.rows : [];
    } catch {
      rows = [];
    }
    return rows;
  };
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ rows: load() }, null, 1));
      fs.renameSync(tmp, file);
    } catch { /* 账本写不进去不能影响填表本身 */ }
  };
  /** entry: {dir, kind, platform, scheduled, scheduledAt(ISO|null), at(ISO)} */
  function note(entry) {
    if (!entry || !entry.dir || !entry.platform) return;
    const list = load();
    const i = list.findIndex((r) => r.dir === entry.dir && r.platform === entry.platform);
    const row = { dir: entry.dir, kind: entry.kind || 'std', platform: entry.platform, scheduled: !!entry.scheduled, scheduledAt: entry.scheduledAt || null, at: entry.at || new Date().toISOString() };
    if (i >= 0) list[i] = row; else list.push(row);
    // 只留最近 400 笔，免得文件无限长
    if (list.length > 400) list.splice(0, list.length - 400);
    save();
  }
  const list = () => load().slice();
  return { note, list };
}

module.exports = { create };
