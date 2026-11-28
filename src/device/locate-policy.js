// 引擎定位降级/续作时序预算：命名成组，避免字面量散落。
// 数值对齐各消费点的设计依据（见消费点注释）。
export const LOCATE_DEGRADE_POLICY = {
  // MISS 降级不再 waitIdle（VLM 看截图不需要树稳定）。
  // 以下常量仅供 batchGround / agent 视觉轮等仍需要 dump 的场景参考。
  busyWaitIdleMs: 3000,
  // 批量视觉接地单次预取目标上限
  batchGroundMaxTargets: 6,
  // 降级 prompt 附屏压缩参数
  nudgeShotMaxWidth: 540,
  nudgeShotQuality: 70,
};

// 续作循环终止标记的单次确定性检测等待（waitForElement）
export const MARATHON_MARKER_WAIT_MS = 3000;
