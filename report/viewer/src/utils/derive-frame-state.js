// 帧号 → 纯状态（DESIGN.md §19.8.3/§19.8.4，契约 §3.3）：画面、高亮、运镜、指针、字幕全是帧号的纯函数

import { CROSS_FADE_FRAMES, CAMERA_ZOOM_MAX } from './playback-math.js';

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

function emptyState(frame) {
  return {
    empty: true,
    frame,
    segmentIndex: -1,
    taskId: null,
    kind: null,
    playing: false,
    screenshotId: null,
    prevScreenshotId: null,
    opacity: 1,
    camera: { zoom: 1, cx: 0, cy: 0 },
    highlight: null,
    highlightOpacity: 0,
    pointer: null,
    subtitle: { title: '', subTitle: '', errorMessage: null },
  };
}

export function deriveFrameState(frame, layout) {
  const segments = Array.isArray(layout?.segments) ? layout.segments : [];
  const totalFrames = typeof layout?.totalFrames === 'number' ? layout.totalFrames : 0;
  const maxFrame = Math.max(0, totalFrames - 1);
  let f = Math.floor(typeof frame === 'number' && Number.isFinite(frame) ? frame : 0);
  f = Math.min(Math.max(f, 0), maxFrame);

  if (totalFrames === 0 || segments.length === 0) {
    return emptyState(f);
  }

  // 命中段 = startFrame <= f 的最后一个段（含 0 帧段，同 startFrame 取后者，瞬时状态生效）。
  // startFrame 由游标累加保证非降序 → 二分找第一个 startFrame > f 的位置，其前一个即命中段（P2-7）
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((segments[mid]?.startFrame ?? 0) <= f) lo = mid + 1;
    else hi = mid;
  }
  let hitIndex = lo - 1;
  let hit = hitIndex >= 0 ? segments[hitIndex] : null;
  if (!hit) {
    hit = segments[0];
    hitIndex = 0;
  }

  const script = hit.script ?? {};
  const isEnd = script.end === true;
  const local = f - (hit.startFrame ?? 0);
  const frameCount = hit.frameCount ?? 0;
  const shot = script.screenshotId ?? null;

  // 交叉淡入：与前段不同图时，段前 min(CROSS_FADE_FRAMES, frameCount) 帧线性 0→1
  const prevSeg = hitIndex > 0 ? segments[hitIndex - 1] : null;
  const prevShot = prevSeg ? (prevSeg.script?.screenshotId ?? null) : null;
  // 前段必须有图才淡入：前段无图（prevShot 为 null）时淡入的起点是"无底图"，
  // opacity 从 0 升到 1 期间画面全白（约 9 帧 / 300ms 空白闪帧）。
  // 当前段也须有图——无图段（spin 等）不该触发淡入。
  const isChange = prevSeg != null && shot != null && prevShot != null && shot !== prevShot;
  let opacity = 1;
  let prevScreenshotId = null;
  if (isChange && !isEnd && frameCount > 0) {
    const fadeFrames = Math.min(CROSS_FADE_FRAMES, frameCount);
    prevScreenshotId = prevShot;
    opacity = Math.min(1, local / fadeFrames);
  }

  // insight 相位：高亮前 1/4 淡入；p>=0.5 起 easeInOut 运镜，cx/cy 恒为 bounds 中心
  let highlight = null;
  let highlightOpacity = 0;
  let camera = { zoom: 1, cx: 0, cy: 0 };
  const b = Array.isArray(script.bounds) && script.bounds.length === 4 ? script.bounds : null;
  if (script.kind === 'insight' && b) {
    const [l, t, r, bot] = b;
    const cx = (l + r) / 2;
    const cy = (t + bot) / 2;
    const p = frameCount > 0 ? Math.min(1, Math.max(0, local / frameCount)) : 1;
    highlight = { x: l, y: t, w: r - l, h: bot - t };
    highlightOpacity = Math.min(1, Math.max(0, p * 4));
    let zoom = 1;
    if (p >= 0.5) {
      zoom = 1 + (CAMERA_ZOOM_MAX - 1) * easeInOut((p - 0.5) / 0.5);
    }
    camera = { zoom, cx, cy };
  }

  // 指针：动作 img 带坐标；spinning-pointer 段只有转圈无坐标
  let pointer = null;
  if (script.kind === 'spinning-pointer') {
    pointer = { spinning: true };
  } else if (script.pointer && typeof script.pointer.x === 'number' && typeof script.pointer.y === 'number') {
    pointer = { x: script.pointer.x, y: script.pointer.y, spinning: false };
  }

  return {
    empty: false,
    frame: f,
    segmentIndex: hit.index ?? hitIndex,
    taskId: script.taskId ?? null,
    kind: script.kind ?? null,
    playing: !isEnd,
    screenshotId: shot,
    prevScreenshotId,
    opacity,
    camera,
    highlight,
    highlightOpacity,
    pointer,
    subtitle: {
      title: script.title ?? '',
      subTitle: script.subTitle ?? '',
      errorMessage: script.errorMessage ?? null,
    },
  };
}
