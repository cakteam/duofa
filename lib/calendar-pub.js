'use strict';
// 日历用：从填表账本（lib/fill-ledger.js）里找出每一条内容在各平台的填表记录，
// 让日历的状态点在重启之后也能反映“哪些平台已经填好 / 已设定时”，而不只看内存里最近一次任务的结果。

const LABEL = { channels: '视频号', douyin: '抖音', kuaishou: '快手', bili: 'B站' };
const STD_PLATFORMS = ['视频号', '抖音', '快手']; // 常规条目预期要发的平台（日历上每条画这几个小点）
const BILI_PLATFORMS = ['B站'];

/** 账本 → Map(条目目录 → [{platform, state, at}])；state：scheduled（填好并设了定时）| filled（填好，没设定时） */
function indexLedger(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r || !r.dir || !LABEL[r.platform]) continue;
    const list = out.get(r.dir) || [];
    list.push({ platform: LABEL[r.platform], state: r.scheduled ? 'scheduled' : 'filled', at: String(r.scheduledAt || r.at || '') });
    out.set(r.dir, list);
  }
  return out;
}

/** 同一平台只取最后一条（后写的覆盖先写的）。 */
function latestByPlatform(list) {
  const m = new Map();
  for (const p of list || []) m.set(p.platform, p);
  return [...m.values()];
}

module.exports = { indexLedger, latestByPlatform, STD_PLATFORMS, BILI_PLATFORMS, LABEL };
