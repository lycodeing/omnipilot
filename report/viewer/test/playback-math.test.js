import test from 'node:test';
import assert from 'node:assert/strict';
import { FPS, DUR, CROSS_FADE_FRAMES, CAMERA_ZOOM_MAX, framesFor, layoutScripts } from '../src/utils/playback-math.js';

test('常量与 DESIGN §19.8.6.5 节奏表一致', () => {
  assert.equal(FPS, 30);
  assert.deepEqual(DUR, {
    stillAfterInsight: 300, locate: 800, spinningPointer: 300,
    action: 500, still: 900, lastFrame: 200,
  });
  assert.equal(CROSS_FADE_FRAMES, 10);
  assert.equal(CAMERA_ZOOM_MAX, 2.2);
});

test('framesFor：ceil(ms/1000×FPS)，ms<=0 → 0', () => {
  assert.equal(framesFor(0), 0);
  assert.equal(framesFor(-100), 0);
  assert.equal(framesFor(300), 9);
  assert.equal(framesFor(800), 24);
  assert.equal(framesFor(500), 15);
  assert.equal(framesFor(900), 27);
  assert.equal(framesFor(200), 6);
  assert.equal(framesFor(1), 1);          // ceil(0.03) = 1
  assert.equal(framesFor(34), 2);         // ceil(1.02) = 2
  assert.equal(framesFor(1000), FPS);
});

test('layoutScripts：顺序游标累加，无缝无叠', () => {
  const scripts = [
    { kind: 'img', durationMs: 300 },   // 9 帧  [0..8]
    { kind: 'insight', durationMs: 800 }, // 24 帧 [9..32]
    { kind: 'img', durationMs: 500 },   // 15 帧 [33..47]
  ];
  const { segments, totalFrames, lastEffectiveFrame } = layoutScripts(scripts);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((s) => s.startFrame), [0, 9, 33]);
  assert.deepEqual(segments.map((s) => s.frameCount), [9, 24, 15]);
  assert.deepEqual(segments.map((s) => s.index), [0, 1, 2]);
  assert.ok(segments.every((s) => s.script === scripts[s.index]));
  assert.equal(totalFrames, 48);
  assert.equal(lastEffectiveFrame, 48); // 无 End 段 → totalFrames
});

test('layoutScripts：0 帧脚本占游标不推进', () => {
  const scripts = [
    { kind: 'img', durationMs: 300 },  // [0..8]
    { kind: 'spinning-pointer', durationMs: 0 }, // 0 帧，startFrame=9
    { kind: 'img', durationMs: 500 },  // startFrame=9
  ];
  const { segments, totalFrames } = layoutScripts(scripts);
  assert.deepEqual(segments.map((s) => [s.startFrame, s.frameCount]), [[0, 9], [9, 0], [9, 15]]);
  assert.equal(totalFrames, 24);
});

test('layoutScripts：End 段的 startFrame 即 lastEffectiveFrame', () => {
  const end = { taskId: null, end: true, kind: 'img', durationMs: DUR.lastFrame };
  const { segments, totalFrames, lastEffectiveFrame } = layoutScripts([
    { kind: 'img', durationMs: 900 }, // 27 帧 [0..26]
    end,                              // 6 帧 [27..32]
  ]);
  assert.equal(totalFrames, 33);
  assert.equal(lastEffectiveFrame, 27);
  assert.equal(segments[1].startFrame, 27);
});

test('layoutScripts：空脚本数组', () => {
  const { segments, totalFrames, lastEffectiveFrame } = layoutScripts([]);
  assert.deepEqual(segments, []);
  assert.equal(totalFrames, 0);
  assert.equal(lastEffectiveFrame, 0);
});

test('layoutScripts：非数组输入按空处理', () => {
  assert.equal(layoutScripts(null).totalFrames, 0);
  assert.equal(layoutScripts(undefined).lastEffectiveFrame, 0);
});
