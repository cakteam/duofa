'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { UiLock, createUi, NOOP_UI, PARALLEL_UI } = require('../lib/ui-lock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakePage = (id, front) => ({ id, bringToFront: async () => { front.id = id; } });

test('前台锁：先到先得，一次只放一个进去，放锁后按排队顺序交给下一位', async () => {
  const lock = new UiLock();
  const order = [];
  const uis = [createUi(lock), createUi(lock), createUi(lock)];
  let inside = 0, maxInside = 0;
  await Promise.all(uis.map((ui, i) => ui.run(null, async () => {
    inside++; maxInside = Math.max(maxInside, inside);
    order.push(i);
    await sleep(15);
    inside--;
  })));
  assert.deepStrictEqual(order, [0, 1, 2]);
  assert.strictEqual(maxInside, 1);
  assert.strictEqual(lock.held, false);
  assert.strictEqual(lock.queue.length, 0);
});

test('前台锁：拿到锁就把自己的标签页切到前台，别人拿锁期间不会被抢', async () => {
  const lock = new UiLock();
  const front = { id: null };
  const a = createUi(lock), b = createUi(lock);
  const pa = fakePage('A', front), pb = fakePage('B', front);
  const seen = [];
  await Promise.all([
    a.run(pa, async () => { for (let i = 0; i < 4; i++) { seen.push(['A', front.id]); await sleep(5); } }),
    b.run(pb, async () => { for (let i = 0; i < 4; i++) { seen.push(['B', front.id]); await sleep(5); } }),
  ]);
  for (const [who, f] of seen) assert.strictEqual(f, who, '持锁期间前台一直是自己的标签页');
});

test('前台锁：run 里抛异常也会放锁，不会让别的平台一直等', async () => {
  const lock = new UiLock();
  const a = createUi(lock), b = createUi(lock);
  await assert.rejects(a.run(null, async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(lock.held, false);
  let got = false;
  await b.run(null, async () => { got = true; });
  assert.ok(got);
});

test('前台锁：run 可以嵌套，里层结束不会把外层持有的锁放掉', async () => {
  const lock = new UiLock();
  const a = createUi(lock), b = createUi(lock);
  let bGot = false;
  let pb;
  await a.run(null, async () => {
    pb = b.run(null, async () => { bGot = true; });
    await a.run(null, async () => { await sleep(10); });
    assert.strictEqual(lock.held, true, '里层 run 结束后外层仍持有锁');
    await sleep(15);
    assert.strictEqual(bGot, false, '外层没放锁之前别人进不来');
  });
  await pb;
  assert.ok(bGot, '外层放锁后别人才进来');
});

test('前台锁：idle 先放锁去做纯等待，别人可以趁这时进来，回来再排队拿锁', async () => {
  const lock = new UiLock();
  const a = createUi(lock), b = createUi(lock);
  const events = [];
  const pa = a.run(null, async () => {
    events.push('A-in');
    await a.idle(async () => { events.push('A-wait-start'); await sleep(40); events.push('A-wait-end'); });
    events.push('A-back');
  });
  await sleep(5);
  const pb = b.run(null, async () => { events.push('B-in'); await sleep(10); events.push('B-out'); });
  await Promise.all([pa, pb]);
  assert.deepStrictEqual(events, ['A-in', 'A-wait-start', 'B-in', 'B-out', 'A-wait-end', 'A-back']);
  assert.strictEqual(lock.held, false);
});

test('前台锁：没持有锁时 idle 就是直接执行；leave 重复调用无害', async () => {
  const lock = new UiLock();
  const a = createUi(lock);
  assert.strictEqual(await a.idle(async () => 7), 7);
  a.leave(); a.leave();
  assert.strictEqual(lock.held, false);
  await a.enter();
  a.leave(); a.leave();
  assert.strictEqual(lock.held, false);
});

test('串行模式的 NOOP_UI：所有方法都是空操作，行为与旧版一致', async () => {
  assert.strictEqual(NOOP_UI.parallel, false);
  let ran = 0;
  assert.strictEqual(await NOOP_UI.run({}, async () => { ran++; return 'x'; }), 'x');
  assert.strictEqual(await NOOP_UI.idle(async () => 'y'), 'y');
  await NOOP_UI.enter();
  NOOP_UI.leave();
  assert.strictEqual(ran, 1);
});

test('并行但不排队的 PARALLEL_UI：标记 parallel，run/idle 直接执行，不互斥、不碰标签页', async () => {
  assert.strictEqual(PARALLEL_UI.parallel, true);
  let inside = 0, maxInside = 0;
  const front = { id: null };
  const page = { bringToFront: async () => { front.id = 'touched'; } };
  await Promise.all([1, 2, 3].map(() => PARALLEL_UI.run(page, async () => { inside++; maxInside = Math.max(maxInside, inside); await sleep(15); inside--; })));
  assert.strictEqual(maxInside, 3, '同时进入');
  assert.strictEqual(front.id, null, '不去切标签页');
  assert.strictEqual(await PARALLEL_UI.idle(async () => 'z'), 'z');
  await PARALLEL_UI.enter(page);
  PARALLEL_UI.leave();
});
