// 设备事实采集（L2 提示词占位符填充用）。
// 全程只读且 try/catch 降级：任何一步失败都留 null，由 assemblePrompt 用查询提示兜底，不阻断主流程。
// net 支持判定：device.netStatus() 返回的 profile 落在 NET_PROFILES 内即支持；
// 'unknown'/null 视为本设备不支持 net 命令（net_profile 会返回 ok=false，属预期）。
// 从 bin/ask.js 抽出以便单测（不依赖真机：device 门面可注入 mock）。

import { NET_PROFILES } from '../net/profile.js';

// 静态事实（分辨率/型号/系统版本）按 serial 进程内缓存：多用例 run 中这些值不变，
// 每 case 重采是纯浪费（旧实现每 case 4 次串行 adb）。netProfile 不缓存——
// 档位可在 run 中被 net 步骤改动，自检需要每 case 的新鲜值。
const STATIC_FACTS_CACHE = new Map();

export async function collectDeviceFacts(device, { serial = null } = {}) {
  let stat = serial ? STATIC_FACTS_CACHE.get(serial) : null;
  if (!stat) {
    stat = { screenSize: null, androidVersion: null, deviceModel: null };
    // 分辨率与 getprop 并行（旧实现 4 次串行 adb 调用；getProps 把两个属性合并为一条 shell）
    const [sizeRes, props] = await Promise.all([
      device.screenSize().catch(() => null),
      (typeof device.getProps === 'function'
        ? device.getProps(['ro.build.version.release', 'ro.product.model'])
        : Promise.all([
          typeof device.getProp === 'function' ? device.getProp('ro.build.version.release') : '',
          typeof device.getProp === 'function' ? device.getProp('ro.product.model') : '',
        ])
      ).catch(() => ['', '']),
    ]);
    if (sizeRes && Number(sizeRes.w) > 0 && Number(sizeRes.h) > 0) stat.screenSize = { w: Number(sizeRes.w), h: Number(sizeRes.h) };
    const [ver, model] = props || [];
    if (ver) stat.androidVersion = ver;
    if (model) stat.deviceModel = model;
    if (serial) STATIC_FACTS_CACHE.set(serial, stat);
  }

  const facts = { ...stat, netSupported: null, netProfile: null };
  try {
    const st = await device.netStatus();
    facts.netSupported = st?.profile != null && NET_PROFILES.includes(st.profile);
    facts.netProfile = st?.profile ?? null; // 供启动自检复用，避免重复 adb 往返
  } catch { /* 降级：net 支持未探测 */ }

  const collected = facts.screenSize || facts.androidVersion || facts.deviceModel || facts.netSupported !== null;
  return collected ? facts : null; // 全部失败 → 返回 null（不传），assemblePrompt 走缺省降级
}
