// APP 初始化：确保目标应用在首页干净状态。
// 平台无关接口，Android 通过 adb 命令实现；后续小程序/桌面端各自扩展。
//
// 流程：force-stop → (可选 pm clear) → launch → 等待渲染 → 清弹窗
// 嵌入 runOne 装配流程，在 applyPregrant 之后、runCaseLoop 之前执行。

/** 启动后默认等待首页渲染的时间（毫秒） */
const DEFAULT_LAUNCH_WAIT_MS = 8000;

/**
 * 初始化目标应用：停止 → 可选清空数据 → 冷启动 → 等待 → 清弹窗。
 *
 * @param {object} device - 设备门面（需提供 terminate / launch / clearAppData）
 * @param {object} options
 * @param {string} options.packageName - 目标包名（已通过白名单校验）
 * @param {boolean} [options.clearData=false] - 是否清空应用数据（pm clear）
 * @param {number} [options.launchWaitMs] - 启动后等待首页渲染的时间
 * @param {Function} [options.dismissPopups] - 清弹窗函数（复用 cleanLaunchPopups）
 * @param {Function} [options.resetAccessibility] - 重置无障碍服务（force-stop 后 uia2 被杀时需调用）
 * @returns {Promise<{ok: boolean, error?: string, steps: string[]}>}
 */
export async function initializeApp(device, {
  packageName,
  clearData = false,
  launchWaitMs = DEFAULT_LAUNCH_WAIT_MS,
  dismissPopups = null,
  resetAccessibility = null,
}) {
  const executedSteps = [];

  // 1. force-stop：无论是否在运行都先停，确保冷启动
  const stopResult = await device.terminate(packageName);
  if (!stopResult.ok) {
    return { ok: false, error: `force-stop 失败: ${stopResult.error}`, steps: executedSteps };
  }
  executedSteps.push('force-stop');

  // 2. 可选：pm clear 清空应用数据（全量重置，含登录态/缓存/数据库）
  if (clearData) {
    const clearResult = await device.clearAppData(packageName);
    if (!clearResult.ok) {
      return { ok: false, error: `pm clear 失败: ${clearResult.error}`, steps: executedSteps };
    }
    executedSteps.push('pm-clear');
  }

  // 3. launch 冷启动
  const launchResult = await device.launch(packageName);
  if (!launchResult.ok) {
    return { ok: false, error: `launch 失败: ${launchResult.error}`, steps: executedSteps };
  }
  executedSteps.push('launch');

  // 4. 等待首页渲染
  await new Promise((resolve) => setTimeout(resolve, launchWaitMs));
  executedSteps.push(`wait-${launchWaitMs}ms`);

  // 5. 重置无障碍服务（force-stop 杀掉 uia2 instrumentation 后必须重启，否则后续 dump 全盲）
  if (resetAccessibility) {
    try {
      const ready = await resetAccessibility();
      executedSteps.push(ready ? 'reset-a11y-ok' : 'reset-a11y-fallback');
    } catch {
      executedSteps.push('reset-a11y-skipped');
    }
  }

  // 6. 清弹窗（权限/安装器/隐私协议等）——必须在无障碍服务就绪后执行
  if (dismissPopups) {
    try {
      await dismissPopups();
      executedSteps.push('dismiss-popups');
    } catch {
      // 清弹窗失败不阻断初始化（App 可能已在首页无弹窗）
      executedSteps.push('dismiss-popups-skipped');
    }
  }

  return { ok: true, steps: executedSteps };
}
