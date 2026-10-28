// 动作命令封装（§5.4）：点位换算 / 区域名 / keyevent 映射（注入假 adb 记录命令）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Adb } from '../src/device/adb.js';
import { centerOf, regionPoint, pickPoint, resolvePoint, tap, longPress, swipe, key, KEYCODES } from '../src/device/action.js';

const SIZE = { w: 720, h: 1280 };

function recordingAdb() {
  const cmds = [];
  const adb = new Adb({
    serial: 'test',
    exec: async (args) => {
      if (args.includes('shell')) cmds.push(args.at(-1));
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  return { adb, cmds };
}

test('centerOf / regionPoint / pickPoint（§5.4.1 中心优先）', () => {
  assert.deepEqual(centerOf([16, 140, 704, 300]), [360, 220]);
  assert.deepEqual(regionPoint('bottom', SIZE), [360, 1024]);
  assert.deepEqual(regionPoint('top', SIZE), [360, 256]);
  assert.deepEqual(regionPoint('left', SIZE), [144, 640]);
  assert.deepEqual(regionPoint('right', SIZE), [576, 640]);
  assert.throws(() => regionPoint('middle', SIZE), /未知区域/);
  assert.deepEqual(pickPoint([16, 140, 704, 300], SIZE), [360, 220], '中心优先');
  assert.deepEqual(pickPoint([-100, -100, 50, 50], SIZE), [-25, -25], '全出屏退化为中心');
});

test('resolvePoint：bounds / [x,y] / 区域名 三态', () => {
  assert.deepEqual(resolvePoint([16, 140, 704, 300], SIZE), [360, 220]);
  assert.deepEqual(resolvePoint([10, 20], SIZE), [10, 20]);
  assert.deepEqual(resolvePoint('top', SIZE), [360, 256]);
  assert.throws(() => resolvePoint(42, SIZE), /无法解析点位/);
});

test('命令拼装：tap / longPress / swipe / key', async () => {
  const { adb, cmds } = recordingAdb();
  await tap(adb, [360, 220]);
  await longPress(adb, [360, 220], 800);
  await swipe(adb, [360, 1024], [360, 256], 300);
  await key(adb, 'back');
  await key(adb, 'home');
  await key(adb, 'enter');
  await key(adb, 'recent');
  assert.deepEqual(cmds, ['input tap 360 220', 'input swipe 360 220 360 220 800', 'input swipe 360 1024 360 256 300', 'input keyevent 4', 'input keyevent 3', 'input keyevent 66', 'input keyevent 187']);
  assert.equal(KEYCODES.recent, 187);
});

test('key：未知按键抛错', async () => {
  const { adb } = recordingAdb();
  await assert.rejects(key(adb, 'bogus'), /不支持的按键/);
});

test('scrollDistancePoints：距离换算 + 方向 + 避开通知栏安全区（真机回归）', async () => {
  const { scrollDistancePoints } = await import('../src/device/action.js');
  const size = { w: 1000, h: 2000 };
  const [from, to] = scrollDistancePoints('down', size, 50);
  assert.equal(from[0], 500, '水平居中');
  assert.ok(to[1] > from[1], 'down：终点 y 大于起点 y（手指向下滑，看下方内容）');
  // ★ 安全区回归：起点不能贴近顶部（y<0.10h 会触发下拉通知栏，真机实测把 App 顶出前台）
  assert.ok(from[1] >= Math.round(size.h * 0.12), `起点 y=${from[1]} 应 ≥ 0.12h（避开通知栏），否则会下拉出系统面板`);
  const [uf, ut] = scrollDistancePoints('up', size, 50);
  assert.ok(ut[1] < uf[1], 'up：终点 y 小于起点 y');
  assert.ok(uf[1] <= Math.round(size.h * 0.88), `up 起点 y=${uf[1]} 应 ≤ 0.88h（避开底部手势区）`);
  // 各比例都在安全区内
  for (const pct of [25, 50, 75, 100]) {
    const [f, t] = scrollDistancePoints('down', size, pct);
    assert.ok(f[1] >= Math.round(size.h * 0.12) && t[1] <= Math.round(size.h * 0.88),
      `${pct}%：起止点应在 [0.12h, 0.88h] 内（f=${f[1]} t=${t[1]}）`);
  }
});

test('scrollDistancePoints：down 100% 位移不超出安全区', async () => {
  const { scrollDistancePoints } = await import('../src/device/action.js');
  const size = { w: 1080, h: 2400 };
  const [f, t] = scrollDistancePoints('down', size, 100);
  assert.ok(t[1] - f[1] <= Math.round(size.h * 0.88) - Math.round(size.h * 0.12), '位移不超过安全区跨度');
  assert.ok(t[1] <= Math.round(size.h * 0.90), `终点 ${t[1]} 不越界`);
});

