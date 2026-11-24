// 引擎定位降级/续作时序预算（2026-11-10 评审 #5：命名成组，替代散落 ask.js 的字面量）。
// 数值逐位对齐历史实现（各自注释里的真机实证保留在消费点）。
export const LOCATE_DEGRADE_POLICY = {
  // 引擎 tap MISS 后等 busy 窗口（提交动画/转场）过去再降级——实测 6×380s 全 MISS 的
  // 事故根因是盲试，等 idle 后目标自然回到 a11y 树
  busyWaitIdleMs: 90_000,
  // 批量视觉接地单次预取目标上限：一次看图喂给 VLM 的目标数（过多命中率下降）
  batchGroundMaxTargets: 6,
  // 降级 prompt 附屏压缩参数（随屏喂模型，免模型再花一轮 screen）
  nudgeShotMaxWidth: 540,
  nudgeShotQuality: 70,
};

// 续作循环终止标记的单次确定性检测等待（waitForElement）
export const MARATHON_MARKER_WAIT_MS = 3000;
