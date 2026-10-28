import test from 'node:test';
import assert from 'node:assert/strict';
import { createFramePlayer } from '../src/composables/useFramePlayer.js';

// 假时钟：advance 推进时间并手动触发排队的 rAF 回调
function createFakeTiming() {
  let time = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => time,
    requestAnimationFrame(cb) {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) { pending.delete(id); },
    advance(ms) {
      time += ms;
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb();
    },
    pendingCount: () => pending.size,
  };
}

test('播放推进：单帧步进与一次 delta 多帧（fps 50，帧长 20ms 浮点精确）', () => {
  const timing = createFakeTiming();
  const frames = [];
  const player = createFramePlayer({ totalFrames: 30, fps: 50, timing, onFrame: (f) => frames.push(f) });
  assert.equal(player.getFrame(), 0);
  assert.equal(player.getRate(), 1);

  player.play();
  assert.ok(player.isPlaying());
  for (let i = 0; i < 5; i++) timing.advance(20);
  assert.equal(player.getFrame(), 5);
  assert.deepEqual(frames, [1, 2, 3, 4, 5]);

  timing.advance(100); // 一次 delta 推进 5 帧 → 单次 onFrame
  assert.equal(player.getFrame(), 10);
  assert.deepEqual(frames, [1, 2, 3, 4, 5, 10]);
});

test('默认 30fps：大 delta 越过末帧时直接停在末帧并暂停', () => {
  const timing = createFakeTiming();
  const frames = [];
  const player = createFramePlayer({ totalFrames: 30, timing, onFrame: (f) => frames.push(f) });
  player.play();
  timing.advance(1000);
  assert.equal(player.getFrame(), 29);
  assert.ok(!player.isPlaying());
  assert.deepEqual(frames, [29]);
});

test('默认 30fps：长播步速近似准确（累加器容差）', () => {
  const timing = createFakeTiming();
  const player = createFramePlayer({ totalFrames: 3000, timing });
  player.play();
  for (let i = 0; i < 120; i++) timing.advance(1000 / 30);
  const frame = player.getFrame();
  assert.ok(Math.abs(frame - 120) <= 2, `expect ~120, got ${frame}`);
  assert.ok(player.isPlaying());
});

test('seekTo 钳制且未变化不触发 onFrame', () => {
  const timing = createFakeTiming();
  const frames = [];
  const player = createFramePlayer({ totalFrames: 30, timing, onFrame: (f) => frames.push(f) });
  player.seekTo(-5);
  assert.equal(player.getFrame(), 0);
  player.seekTo(999);
  assert.equal(player.getFrame(), 29);
  player.seekTo(29); // 不变
  player.seekTo(10);
  assert.equal(player.getFrame(), 10);
  assert.deepEqual(frames, [29, 10]);
});

test('倍速：setRate 影响推进速度', () => {
  const timing = createFakeTiming();
  const player = createFramePlayer({ totalFrames: 100, fps: 50, timing });
  player.play();
  player.setRate(2);
  timing.advance(20); // 40ms 累积 → 2 步
  assert.equal(player.getFrame(), 2);
  assert.equal(player.getRate(), 2);
  player.setRate(0.5);
  timing.advance(20); // 半步，累积不推进
  assert.equal(player.getFrame(), 2);
  timing.advance(20); // 凑满一步
  assert.equal(player.getFrame(), 3);
});

test('末帧自停，play 在末帧回 0 再播', () => {
  const timing = createFakeTiming();
  const frames = [];
  const player = createFramePlayer({ totalFrames: 30, fps: 50, timing, onFrame: (f) => frames.push(f) });
  player.seekTo(27);
  player.play();
  timing.advance(20);
  assert.equal(player.getFrame(), 28);
  assert.ok(player.isPlaying());
  timing.advance(20); // next=29 → 停在末帧
  assert.equal(player.getFrame(), 29);
  assert.ok(!player.isPlaying());
  timing.advance(100);
  assert.equal(player.getFrame(), 29);

  player.play(); // 末帧回 0
  assert.equal(player.getFrame(), 0);
  assert.ok(player.isPlaying());
  timing.advance(20);
  assert.equal(player.getFrame(), 1);
  assert.deepEqual(frames, [27, 28, 29, 0, 1]);
});

test('pause 后不再推进；toggle 切换', () => {
  const timing = createFakeTiming();
  const player = createFramePlayer({ totalFrames: 30, fps: 50, timing });
  player.toggle();
  assert.ok(player.isPlaying());
  timing.advance(20);
  assert.equal(player.getFrame(), 1);
  player.pause();
  assert.ok(!player.isPlaying());
  timing.advance(1000);
  assert.equal(player.getFrame(), 1);
  player.toggle();
  assert.ok(player.isPlaying());
});

test('initialFrame 与 fps 选项', () => {
  const timing = createFakeTiming();
  const player = createFramePlayer({ totalFrames: 10, initialFrame: 4, fps: 10, timing });
  assert.equal(player.getFrame(), 4);
  player.play();
  timing.advance(100); // 1000/10
  assert.equal(player.getFrame(), 5);
});

test('totalFrames=0：play 为 no-op，seek 钳为 0', () => {
  const timing = createFakeTiming();
  const player = createFramePlayer({ totalFrames: 0, timing });
  player.play();
  assert.ok(!player.isPlaying());
  player.seekTo(3);
  assert.equal(player.getFrame(), 0);
});

test('destroy：取消 rAF，之后所有方法 no-op', () => {
  const timing = createFakeTiming();
  const frames = [];
  const player = createFramePlayer({ totalFrames: 10, fps: 50, timing, onFrame: (f) => frames.push(f) });
  player.play();
  player.destroy();
  assert.ok(!player.isPlaying());
  player.play();
  player.toggle();
  player.seekTo(5);
  player.setRate(3);
  assert.equal(player.getFrame(), 0);
  assert.equal(player.getRate(), 1);
  assert.deepEqual(frames, []);
  timing.advance(1000);
  assert.equal(player.getFrame(), 0);
  assert.equal(timing.pendingCount(), 0); // rAF 已被取消
});
