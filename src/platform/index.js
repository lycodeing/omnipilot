// 平台选择缝：当前只有 android；后续 iOS/Web/桌面在此注册。
import { androidPlatform } from './android.js';

const PLATFORMS = { android: androidPlatform };

// 缺省 android（向后兼容）；未知平台名报错（不静默回退）。
export function resolvePlatform(name = 'android') {
  const p = PLATFORMS[String(name).toLowerCase()];
  if (!p) throw new Error(`未知平台: ${name}（当前支持: ${Object.keys(PLATFORMS).join(', ')}）`);
  return p;
}

export function listPlatforms() { return Object.keys(PLATFORMS); }
