// 引擎定位降级/续作时序预算：命名成组，避免字面量散落。
// 数值对齐各消费点的设计依据（见消费点注释）。
export const LOCATE_DEGRADE_POLICY = {
  // 引擎 tap MISS 后等 busy 窗口过去再降级。分级超时：
  //   首次 MISS 用短超时（弹窗/转场通常 5-15s 内稳定），避免 90s 空耗；
  //   连续 MISS（同一目标重试）才升级到长超时（真正的 busy 态需要更长等待）。
  busyWaitIdleMs: 15_000,
  busyWaitIdleEscalatedMs: 60_000,
  // 批量视觉接地单次预取目标上限：一次看图喂给 VLM 的目标数（过多命中率下降）
  batchGroundMaxTargets: 6,
  // 降级 prompt 附屏压缩参数（随屏喂模型，免模型再花一轮 screen）
  nudgeShotMaxWidth: 540,
  nudgeShotQuality: 70,
};

// 续作循环终止标记的单次确定性检测等待（waitForElement）
export const MARATHON_MARKER_WAIT_MS = 3000;
