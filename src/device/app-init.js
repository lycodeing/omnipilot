// APP 初始化：确保目标应用在首页干净状态。
// 平台无关接口，Android 通过 adb 命令实现；后续小程序/桌面端各自扩展。
//
// 两种模式：
//   clearData=false（默认）：am start --activity-clear-task 清栈重启，不杀进程，
//     保留 uia2 instrumentation，避免 VLM 定位全盲。
//   clearData=true：force-stop → pm clear → launch → resetUia2，全量重置。
//
// 嵌入 runOne 装配流程，在 applyPregrant 之后、runCaseLoop 之前执行。

/** 启动后默认等待首页渲染的时间（毫秒） */
const DEFAULT_LAUNCH_WAIT_MS = 8000;

/**
 * 初始化目标应用。
 *
 * @param {object} device - 设备门面
 * @param {object} options
 * @param {string} options.packageName - 目标包名
 * @param {boolean} [options.clearData=false] - 是否清空应用数据（pm clear + force-stop）
 * @param {number} [options.launchWaitMs] - 启动后等待首页渲染的时间
 * @param {Function} [options.dismissPopups] - 清弹窗函数
 * @param {Function} [options.resetAccessibility] - 重置无障碍服务（仅 clearData 时需要）
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

  if (clearData) {
    // 全量重置模式：force-stop → pm clear → launch → resetUia2
    const stopResult = await device.terminate(packageName);
    if (!stopResult.ok) {
      return { ok: false, error: `force-stop 失败: ${stopResult.error}`, steps: executedSteps };
    }
    executedSteps.push('force-stop');

    const clearResult = await device.clearAppData(packageName);
    if (!clearResult.ok) {
      return { ok: false, error: `pm clear 失败: ${clearResult.error}`, steps: executedSteps };
    }
    executedSteps.push('pm-clear');

    const launchResult = await device.launch(packageName);
    if (!launchResult.ok) {
      return { ok: false, error: `launch 失败: ${launchResult.error}`, steps: executedSteps };
    }
    executedSteps.push('launch');
  } else {
    // 轻量模式：通过 device.launch 重启应用（monkey 方式），不 force-stop，
    // 保留 uia2 instrumentation，避免 VLM 定位全盲。
    // launch 内部用 monkey -p <pkg> -c LAUNCHER 1，等效于点击桌面图标，
    // 如果 App 已在运行则切到前台（不会清栈，但配合用例首步 aiWaitFor 可确认首页）。
    const launchResult = await device.launch(packageName);
    if (!launchResult.ok) {
      return { ok: false, error: `启动失败: ${launchResult.error}`, steps: executedSteps };
    }
    executedSteps.push('relaunch');
  }

  // 等待首页渲染
  await new Promise((resolve) => setTimeout(resolve, launchWaitMs));
  executedSteps.push(`wait-${launchWaitMs}ms`);

  // 仅 clearData 模式需要重置无障碍服务（force-stop 杀了 uia2）
  if (clearData && resetAccessibility) {
    try {
      const ready = await resetAccessibility();
      executedSteps.push(ready ? 'reset-a11y-ok' : 'reset-a11y-fallback');
    } catch {
      executedSteps.push('reset-a11y-skipped');
    }
  }

  // 清弹窗
  if (dismissPopups) {
    try {
      await dismissPopups();
      executedSteps.push('dismiss-popups');
    } catch {
      executedSteps.push('dismiss-popups-skipped');
    }
  }

  return { ok: true, steps: executedSteps };
}
