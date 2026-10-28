// 设备事实采集（L2 提示词占位符填充用）。
// 全程只读且 try/catch 降级：任何一步失败都留 null，由 assemblePrompt 用查询提示兜底，不阻断主流程。
// net 支持判定：device.netStatus() 返回的 profile 落在 NET_PROFILES 内即支持；
// 'unknown'/null 视为本设备不支持 net 命令（net_profile 会返回 ok=false，属预期）。
// 从 bin/ask.js 抽出以便单测（不依赖真机：device 门面可注入 mock）。

import { NET_PROFILES } from '../net/profile.js';

export async function collectDeviceFacts(device) {
  const facts = { screenSize: null, androidVersion: null, deviceModel: null, netSupported: null };

  try {
    const size = await device.screenSize();
    if (size && Number(size.w) > 0 && Number(size.h) > 0) facts.screenSize = { w: Number(size.w), h: Number(size.h) };
  } catch { /* 降级：分辨率未采集 */ }

  try {
    if (typeof device.getProp === 'function') {
      const ver = await device.getProp('ro.build.version.release');
      if (ver) facts.androidVersion = ver;
      const model = await device.getProp('ro.product.model');
      if (model) facts.deviceModel = model;
    }
  } catch { /* 降级：型号/系统版本未采集 */ }

  try {
    const st = await device.netStatus();
    facts.netSupported = st?.profile != null && NET_PROFILES.includes(st.profile);
  } catch { /* 降级：net 支持未探测 */ }

  const collected = facts.screenSize || facts.androidVersion || facts.deviceModel || facts.netSupported !== null;
  return collected ? facts : null; // 全部失败 → 返回 null（不传），assemblePrompt 走缺省降级
}
