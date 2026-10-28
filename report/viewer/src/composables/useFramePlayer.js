// rAF 固定步长累加器播放引擎（DESIGN.md §19.8.3，契约 §3.4）。
// vue-free：B 在组件里包一层 ref；timing 可注入假时钟供测试。
// 帧号是唯一状态，onFrame 只在实际帧变化时调用。

import { FPS } from '../utils/playback-math.js';

export function createFramePlayer(options = {}) {
  const totalFrames = Math.max(0, Math.floor(options.totalFrames ?? 0));
  const fps = typeof options.fps === 'number' && options.fps > 0 ? options.fps : FPS;
  const frameDuration = 1000 / fps;
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;

  const timing = options.timing ?? {};
  const raf = timing.requestAnimationFrame
    ?? (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame.bind(globalThis) : null);
  const caf = timing.cancelAnimationFrame
    ?? (typeof globalThis.cancelAnimationFrame === 'function' ? globalThis.cancelAnimationFrame.bind(globalThis) : null);
  const now = timing.now
    ?? (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now() : () => Date.now());

  const clampFrame = (f) => Math.min(Math.max(Math.floor(f), 0), Math.max(0, totalFrames - 1));

  let currentFrame = clampFrame(options.initialFrame ?? 0);
  let rate = normalizeRate(options.rate ?? 1);
  let playing = false;
  let destroyed = false;
  let rafId = null;
  let lastTime = null; // 首帧 delta 记 0，避免用启动时刻差值大跳
  let accumulated = 0;

  function normalizeRate(r) {
    return typeof r === 'number' && Number.isFinite(r) ? Math.max(0, r) : 1;
  }

  function setFrame(f) {
    if (f === currentFrame) return false;
    currentFrame = f;
    if (onFrame) onFrame(currentFrame);
    return true;
  }

  function tick() {
    if (destroyed || !playing) return;
    const t = now();
    if (lastTime == null) lastTime = t;
    const delta = Math.max(0, t - lastTime);
    lastTime = t;
    accumulated += delta * rate;
    const steps = Math.floor(accumulated / frameDuration);
    if (steps > 0) {
      accumulated -= steps * frameDuration;
      const next = currentFrame + steps;
      if (next >= totalFrames - 1) {
        // 到末帧：停在 totalFrames-1 并自动暂停
        setFrame(totalFrames - 1);
        pause();
        return;
      }
      setFrame(next);
    }
    rafId = raf(tick);
  }

  function play() {
    if (destroyed || playing || totalFrames <= 0 || !raf) return;
    // 在末帧时回到 0 再播
    if (currentFrame >= totalFrames - 1) setFrame(0);
    playing = true;
    lastTime = now(); // 起始时间戳，首 tick delta 从 0 起算
    accumulated = 0;
    rafId = raf(tick);
  }

  function pause() {
    if (destroyed || !playing) return;
    playing = false;
    if (rafId != null && caf) caf(rafId);
    rafId = null;
  }

  function seekTo(frame) {
    if (destroyed) return;
    setFrame(clampFrame(frame));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    playing = false;
    if (rafId != null && caf) caf(rafId);
    rafId = null;
  }

  return {
    play,
    pause,
    toggle() { if (!destroyed) (playing ? pause() : play()); },
    seekTo,
    setRate(r) { if (!destroyed) rate = normalizeRate(r); },
    getRate() { return rate; },
    getFrame() { return currentFrame; },
    isPlaying() { return playing; },
    destroy,
  };
}
