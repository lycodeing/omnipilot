import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { layoutScripts, DUR } from '../src/utils/playback-math.js';
import { buildReplayScripts } from '../src/utils/buildReplayScripts.js';
import { deriveFrameState } from '../src/utils/derive-frame-state.js';

// 合成布局：A 整屏 [0..26] → B insight [27..50] → C 换图动作 [51..65] → End [66..71]
function makeLayout() {
  const scripts = [
    { taskId: '1', end: false, kind: 'img', screenshotId: 'S1', title: '点击', subTitle: 'a', errorMessage: null, durationMs: 900 },
    { taskId: '1', end: false, kind: 'insight', screenshotId: 'S1', bounds: [100, 200, 300, 400], title: '点击', subTitle: 'a', errorMessage: null, durationMs: 800 },
    { taskId: '2', end: false, kind: 'img', screenshotId: 'S2', pointer: { x: 608, y: 820 }, title: '输入', subTitle: 'b', errorMessage: null, durationMs: 500 },
    { taskId: null, end: true, kind: 'img', screenshotId: 'S2', title: '结束', subTitle: 'run', errorMessage: null, durationMs: DUR.lastFrame },
  ];
  return layoutScripts(scripts);
}

const close = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expect ~${expected}, got ${actual}`);

test('首段：命中、无淡入、无高亮无指针', () => {
  const s = deriveFrameState(0, makeLayout());
  assert.equal(s.empty, false);
  assert.equal(s.frame, 0);
  assert.equal(s.segmentIndex, 0);
  assert.equal(s.taskId, '1');
  assert.equal(s.kind, 'img');
  assert.equal(s.playing, true);
  assert.equal(s.screenshotId, 'S1');
  assert.equal(s.prevScreenshotId, null);
  assert.equal(s.opacity, 1);
  assert.deepEqual(s.camera, { zoom: 1, cx: 0, cy: 0 });
  assert.equal(s.highlight, null);
  assert.equal(s.highlightOpacity, 0);
  assert.equal(s.pointer, null);
  assert.deepEqual(s.subtitle, { title: '点击', subTitle: 'a', errorMessage: null });
});

test('insight 相位：高亮前 1/4 淡入，p>=0.5 easeInOut 运镜，中心恒定', () => {
  // B 段 [27..50]，frameCount 24；bounds [100,200,300,400] → 中心 (200,300)
  const at = (f) => deriveFrameState(f, makeLayout());

  let s = at(27); // p=0
  assert.equal(s.kind, 'insight');
  assert.deepEqual(s.highlight, { x: 100, y: 200, w: 200, h: 200 });
  assert.equal(s.highlightOpacity, 0);
  assert.equal(s.opacity, 1); // 与前段同图，无交叉淡入
  assert.equal(s.prevScreenshotId, null);
  assert.deepEqual(s.camera, { zoom: 1, cx: 200, cy: 300 }); // zoom=1 但中心已定

  s = at(30); // p=0.125
  close(s.highlightOpacity, 0.5);
  assert.equal(s.camera.zoom, 1);

  s = at(33); // p=0.25 → 淡入完成
  assert.equal(s.highlightOpacity, 1);

  s = at(38); // p≈0.458 < 0.5
  assert.equal(s.camera.zoom, 1);
  assert.deepEqual(s.camera, { zoom: 1, cx: 200, cy: 300 });

  s = at(39); // p=0.5 → zoom 起点
  close(s.camera.zoom, 1);

  s = at(45); // p=0.75 → easeInOut(0.5)=0.5
  close(s.camera.zoom, 1 + (2.2 - 1) * 0.5);
  assert.deepEqual([s.camera.cx, s.camera.cy], [200, 300]);

  s = at(50); // p=23/24 → 接近满缩放
  close(s.camera.zoom, 2.1833333, 1e-4);
  assert.ok(s.camera.zoom < 2.2);
});

test('换图段：前 min(10, frameCount) 帧线性 0→1，prevScreenshotId 为旧图', () => {
  // C 段 [51..65]，S1→S2，fadeFrames = min(10,15) = 10
  const at = (f) => deriveFrameState(f, makeLayout());
  let s = at(51);
  assert.equal(s.opacity, 0);
  assert.equal(s.prevScreenshotId, 'S1');
  assert.equal(s.screenshotId, 'S2');
  s = at(55);
  close(s.opacity, 0.4);
  s = at(60);
  close(s.opacity, 0.9);
  s = at(61); // local=10 → 1
  assert.equal(s.opacity, 1);
  s = at(65); // 封顶 1，旧图引用仍在
  assert.equal(s.opacity, 1);
  assert.equal(s.prevScreenshotId, 'S1');
});

test('动作 img 的指针：坐标 + spinning:false；spinning-pointer 段仅转圈', () => {
  const s = deriveFrameState(55, makeLayout());
  assert.deepEqual(s.pointer, { x: 608, y: 820, spinning: false });

  const layout = layoutScripts([
    { taskId: '1', kind: 'img', screenshotId: 'S1', title: 't', subTitle: '', durationMs: 300 },
    { taskId: '1', kind: 'spinning-pointer', screenshotId: 'S1', title: 't', subTitle: '', durationMs: 300 },
  ]);
  const sp = deriveFrameState(10, layout);
  assert.equal(sp.kind, 'spinning-pointer');
  assert.deepEqual(sp.pointer, { spinning: true });
  assert.ok(!('x' in sp.pointer));
  assert.equal(sp.playing, true);
});

test('同 startFrame 取后者（游标布局中 0 帧段不遮蔽后随段），0 帧换图不淡入', () => {
  const layout = layoutScripts([
    { taskId: '1', kind: 'img', screenshotId: 'S1', title: 't', subTitle: '', durationMs: 300 },   // [0..8]
    { taskId: '1', kind: 'spinning-pointer', screenshotId: 'S3', title: 't', subTitle: '', durationMs: 0 }, // start 9
    { taskId: '2', kind: 'img', screenshotId: 'S2', pointer: { x: 5, y: 6 }, title: 't', subTitle: '', durationMs: 500 }, // start 9
  ]);
  // 同 startFrame=9：最后一段（img S2）生效
  const s = deriveFrameState(9, layout);
  assert.equal(s.segmentIndex, 2);
  assert.equal(s.screenshotId, 'S2');
  assert.deepEqual(s.pointer, { x: 5, y: 6, spinning: false });
  assert.equal(deriveFrameState(8, layout).segmentIndex, 0);
});

test('End 段：taskId=null、playing:false、opacity 恒 1、无高亮无指针', () => {
  const at = (f) => deriveFrameState(f, makeLayout());
  for (const f of [66, 68, 71]) {
    const s = at(f);
    assert.equal(s.taskId, null);
    assert.equal(s.playing, false);
    assert.equal(s.opacity, 1);
    assert.equal(s.prevScreenshotId, null);
    assert.equal(s.highlight, null);
    assert.equal(s.pointer, null);
    assert.deepEqual(s.camera, { zoom: 1, cx: 0, cy: 0 });
    assert.deepEqual(s.subtitle, { title: '结束', subTitle: 'run', errorMessage: null });
  }
  // 即使 End 图与前段不同也不淡入
  const layout = layoutScripts([
    { taskId: '1', kind: 'img', screenshotId: 'S1', title: 't', subTitle: '', durationMs: 300 },
    { taskId: null, end: true, kind: 'img', screenshotId: 'S9', title: '结束', subTitle: '', durationMs: 200 },
  ]);
  const s = deriveFrameState(9, layout);
  assert.equal(s.opacity, 1);
  assert.equal(s.prevScreenshotId, null);
});

test('failed 副标题透传', () => {
  const layout = layoutScripts([
    { taskId: '3', kind: 'img', screenshotId: 'S1', title: '点击', subTitle: 'x', errorMessage: 'boom', durationMs: 300 },
  ]);
  const s = deriveFrameState(2, layout);
  assert.deepEqual(s.subtitle, { title: '点击', subTitle: 'x', errorMessage: 'boom' });
});

test('越界钳制到 [0, totalFrames-1]，非整数帧向下取整', () => {
  const layout = makeLayout(); // totalFrames 72
  assert.equal(deriveFrameState(-5, layout).frame, 0);
  assert.equal(deriveFrameState(-5, layout).segmentIndex, 0);
  assert.equal(deriveFrameState(999, layout).frame, 71);
  assert.equal(deriveFrameState(999, layout).playing, false);
  assert.equal(deriveFrameState(55.9, layout).frame, 55);
});

test('空布局：totalFrames=0 → empty 状态', () => {
  for (const layout of [layoutScripts([]), null, undefined, { segments: [], totalFrames: 0 }]) {
    const s = deriveFrameState(10, layout);
    assert.equal(s.empty, true);
    assert.equal(s.segmentIndex, -1);
    assert.equal(s.taskId, null);
    assert.equal(s.playing, false);
    assert.equal(s.screenshotId, null);
    assert.equal(s.opacity, 1);
    assert.equal(s.pointer, null);
    assert.deepEqual(s.camera, { zoom: 1, cx: 0, cy: 0 });
  }
});

test('夹具集成：buildReplayScripts → layoutScripts → deriveFrameState 闭环', () => {
  const dumpPath = fileURLToPath(new URL('../fixtures/sample-dump.json', import.meta.url));
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const layout = layoutScripts(buildReplayScripts(dump.executions[0]));

  // End 帧 200ms → 6 帧，不计入进度
  assert.equal(layout.totalFrames - layout.lastEffectiveFrame, 6);
  const s = deriveFrameState(layout.lastEffectiveFrame, layout);
  assert.equal(s.taskId, null);
  assert.equal(s.playing, false);
  assert.equal(s.screenshotId, 'shot-0004');
  // 首帧属于 task 0 的 tap
  const first = deriveFrameState(0, layout);
  assert.equal(first.taskId, '0');
  assert.equal(first.kind, 'img');
});
