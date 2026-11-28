// 统一条件轮询工具：替代全仓的固定盲等。
// 模式：初始 500ms → 指数退避 ×1.5 → 封顶 3s → 用例可配上限。
// 所有引擎内部等待必须使用此函数，禁止直接 setTimeout(N) 其中 N > 2000。

/**
 * 条件轮询 + 指数退避。
 * @param {Function} condition - async () => boolean，返回 true 表示就绪
 * @param {object} [options]
 * @param {number} [options.maxWaitMs=5000] - 最大等待时间（用例可配）
 * @param {number} [options.initialIntervalMs=500] - 首次检查后间隔
 * @param {number} [options.backoffFactor=1.5] - 退避因子
 * @param {number} [options.maxIntervalMs=3000] - 间隔封顶
 * @returns {Promise<boolean>} true=条件满足，false=超时
 */
export async function pollUntil(condition, {
  maxWaitMs = 5000,
  initialIntervalMs = 500,
  backoffFactor = 1.5,
  maxIntervalMs = 3000,
} = {}) {
  const deadline = Date.now() + maxWaitMs;
  let interval = initialIntervalMs;

  // 立即检查一次（不等待）
  if (await condition()) return true;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
    if (await condition()) return true;
    interval = Math.min(interval * backoffFactor, maxIntervalMs);
  }
  return false;
}

/**
 * 可中断的固定等待（用于 YAML sleep 步）。
 * 每 500ms 检查一次 shouldAbort，被中断时提前返回。
 * @param {number} durationMs - 等待时长
 * @param {Function} [shouldAbort] - () => boolean，返回 true 时提前终止
 * @returns {Promise<boolean>} true=完整等待，false=被中断
 */
export async function interruptibleSleep(durationMs, shouldAbort = null) {
  const deadline = Date.now() + durationMs;
  const checkInterval = 500;
  while (Date.now() < deadline) {
    if (shouldAbort && shouldAbort()) return false;
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(checkInterval, remaining)));
  }
  return true;
}
