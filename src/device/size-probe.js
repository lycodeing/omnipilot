// 屏幕尺寸探测：带会话级缓存与负缓存（失败后冷却，避免每个工具立刻重复撞墙）。
//
// 从 device/index.js 抽出——尺寸探测是独立关注点（重试/冷却策略），
// 与门面的树抓取/定位/动作分发无关。状态（sizeCache / sizeFailedAt）只服务于
// 尺寸探测，随之一并搬出。
import { ScreenSizeError, readScreenSize } from './screen.js';

const SIZE_RETRY = { attempts: 3, delayMs: 500, cooldownMs: 1500 };

export function createSizeProbe({ adb, bootSize = null }) {
  let sizeCache = bootSize; // waitForBoot 已探测过 wm size 时直接复用（省一次往返）
  let sizeFailedAt = 0; // 上次探测失败的时刻（负缓存冷却，避免每个工具立刻重复撞墙）

  // 屏幕尺寸会话级缓存。冷启动期 wm size 可能未就绪：短退避重试；仍失败则记负缓存冷却，
  // 冷却期内的调用立刻失败（不再反复打设备），冷却过后允许重探（设备此时通常已就绪）。
  return async function getSize() {
    if (sizeCache) return sizeCache;
    if (sizeFailedAt && Date.now() - sizeFailedAt < SIZE_RETRY.cooldownMs) {
      throw new ScreenSizeError('设备未就绪：屏幕尺寸探测处于冷却期', { notReady: true });
    }
    let lastErr;
    for (let i = 0; i < SIZE_RETRY.attempts; i++) {
      try {
        sizeCache = await readScreenSize(adb, { timeoutMs: adb.timeouts.command });
        sizeFailedAt = 0;
        return sizeCache;
      } catch (e) {
        lastErr = e;
        if (i < SIZE_RETRY.attempts - 1) await new Promise((r) => setTimeout(r, SIZE_RETRY.delayMs));
      }
    }
    sizeFailedAt = Date.now();
    throw lastErr;
  };
}
