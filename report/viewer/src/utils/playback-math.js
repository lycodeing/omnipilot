// 帧播放数学层：节奏常量 + 摊帧 + 脚本布局（DESIGN.md §19.8.2 / §19.8.6.5）

// 固定节奏与真实耗时无关，均匀节奏观感更好（§19.8.6.5 节奏常量表）
export const FPS = 30;
export const DUR = {
  stillAfterInsight: 300, // Locate 前先放原始整屏截图
  locate: 800,            // insight 运镜相位时长
  spinningPointer: 300,   // 动作前等待转圈
  action: 500,            // 动作后截图帧
  still: 900,             // 普通任务/断言静止帧
  lastFrame: 200,         // End 收尾帧
};
export const CROSS_FADE_FRAMES = 10; // 换图交叉淡入帧数
export const CAMERA_ZOOM_MAX = 2.2;  // insight 运镜最大缩放

// ms → 帧数：ceil(ms/1000 × FPS)；ms<=0 → 0
export function framesFor(ms) {
  if (!(ms > 0)) return 0;
  return Math.ceil((ms / 1000) * FPS);
}

// 顺序游标累加：segment = { index, script, startFrame, frameCount }
// startFrame_{i+1} = startFrame_i + frameCount_i；0 帧脚本占当前游标不推进。
// lastEffectiveFrame = 结尾 End 段（taskId===null 且 end===true）的 startFrame，无 End 段 → totalFrames。
export function layoutScripts(scripts) {
  const segments = [];
  let cursor = 0;
  const list = Array.isArray(scripts) ? scripts : [];
  for (const script of list) {
    const frameCount = framesFor(script?.durationMs);
    segments.push({ index: segments.length, script, startFrame: cursor, frameCount });
    cursor += frameCount;
  }
  const last = segments.length ? segments[segments.length - 1] : null;
  const totalFrames = last ? last.startFrame + last.frameCount : 0;

  let lastEffectiveFrame = totalFrames;
  for (const seg of segments) {
    if (seg.script?.taskId === null && seg.script?.end === true) {
      lastEffectiveFrame = seg.startFrame;
    }
  }
  return { segments, totalFrames, lastEffectiveFrame };
}
