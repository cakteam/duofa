'use strict';
/**
 * 汇总 Excel 导出（V2.0 数据下载）。
 * 输入：{ channels, douyin, bili } 各平台 {works, overview, followers} + dateLabel
 * 输出：单个 .xlsx，三个工作表：作品数据 / 账号总览 / 趋势数据
 * 任一平台缺维度时跳过对应行，不阻塞整体。
 */
const ExcelJS = require('exceljs');

const PLATFORM_LABEL = { channels: '视频号', douyin: '抖音', kuaishou: '快手', bili: 'B站' };

const WORK_HEADERS = ['平台', '标题', '发布时间', '播放', '点赞', '评论', '转发/分享', '收藏', '弹幕', '投币', '完播率', '2s跳出率', '链接'];
const WORK_KEYS = ['title', 'publishTime', 'play', 'like', 'comment', 'share', 'favorite', 'danmaku', 'coin', 'completion', 'bounce', 'link'];

function setHeader(sheet, headers, widths) {
  const row = sheet.getRow(1);
  row.values = headers;
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  row.height = 22;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });
}

function styleCell(v) {
  if (v === null || v === undefined || v === '') return '';
  return v;
}

function fillWorksSheet(wb, data) {
  const sheet = wb.addWorksheet('作品数据');
  setHeader(sheet, WORK_HEADERS, [10, 52, 19, 10, 8, 8, 10, 8, 8, 8, 10, 10, 34]);
  let n = 0;
  for (const [pk, platform] of Object.entries(data)) {
    for (const w of platform.works || []) {
      const vals = [PLATFORM_LABEL[pk] || pk];
      for (const k of WORK_KEYS) vals.push(styleCell(w[k]));
      const row = sheet.addRow(vals);
      // 完播率/跳出率按百分比显示（三平台都已归一成 0~1 小数；B站在抓取时已从万分比换算）
      for (const col of [11, 12]) {
        const v = row.getCell(col).value;
        if (typeof v === 'number' && v > 0 && v <= 1) row.getCell(col).numFmt = '0.0%';
      }
      n++;
    }
  }
  if (!n) sheet.addRow(['（未抓到作品数据）']);
  return sheet;
}

function fillOverviewSheet(wb, data) {
  const sheet = wb.addWorksheet('账号总览');
  setHeader(sheet, ['平台', '指标', '数值', '备注'], [10, 24, 16, 30]);
  let n = 0;
  for (const [pk, platform] of Object.entries(data)) {
    for (const o of platform.overview || []) {
      sheet.addRow([PLATFORM_LABEL[pk] || pk, o.指标 ?? o.label ?? '', styleCell(o.值 ?? o.value), o.备注 ?? o.note ?? '']);
      n++;
    }
  }
  if (!n) sheet.addRow(['（未抓到总览数据）']);
  return sheet;
}

function fillTrendSheet(wb, data) {
  const sheet = wb.addWorksheet('趋势数据');
  // 列 = 各平台趋势行字段的并集（视频号：日期/新增关注/取关/净增/粉丝总数；抖音：日期/粉丝数/累计点赞…；B站：日期/播放增量…）
  const keySet = new Set(['日期']);
  for (const platform of Object.values(data)) {
    for (const r of platform.followers || []) {
      Object.keys(r).forEach((k) => keySet.add(k));
    }
  }
  const keys = [...keySet];
  setHeader(sheet, ['平台', ...keys], [10, 13, ...keys.slice(1).map(() => 12)]);
  let n = 0;
  for (const [pk, platform] of Object.entries(data)) {
    for (const r of platform.followers || []) {
      sheet.addRow([PLATFORM_LABEL[pk] || pk, ...keys.map((k) => styleCell(r[k]))]);
      n++;
    }
  }
  if (!n) sheet.addRow(['（未抓到趋势数据）']);
  return sheet;
}

/** 生成 xlsx 文件；返回写入路径 */
async function exportXlsx(data, outFile) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '账号发布器 V2.0';
  fillWorksSheet(wb, data);
  fillOverviewSheet(wb, data);
  fillTrendSheet(wb, data);
  await wb.xlsx.writeFile(outFile);
  return outFile;
}

module.exports = { exportXlsx };
