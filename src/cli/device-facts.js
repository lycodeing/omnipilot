// 设备事实采集（L2 提示词占位符填充用）。
// 全程只读且 try/catch 降级：任何一步失败都留 null，由 assemblePrompt 用查询提示兜底，不阻断主流程。
// net 支持判定：device.netStatus() 返回的 profile 落在 NET_PROFILES 内即支持；
// 'unknown'/null 视为本设备不支持 net 命令（net_profile 会返回 ok=false，属预期）。
// 从 bin/ask.js 抽出以便单测（不依赖真机：device 门面可注入 mock）。

import { NET_PROFILES } from '../device/net-profile.js';
import { resolvePlatform } from '../platform/index.js';

// 静态事实（分辨率/型号/系统版本）按 serial 进程内缓存：多用例 run 中这些值不变，
// 每 case 重采是纯浪费（避免每 case 4 次串行 adb）。netProfile 不缓存——
// 档位可在 run 中被 net 步骤改动，自检需要每 case 的新鲜值。
const STATIC_FACTS_CACHE = new Map();

export async function collectDeviceFacts(device, { serial = null, platform = null } = {}) {
  const p = platform ?? resolvePlatform('android');
  let stat = serial ? STATIC_FACTS_CACHE.get(serial) : null;
  if (!stat) {
    stat = { screenSize: null };
    for (const f of p.factsProps) stat[f.key] = null;
    // 分辨率与 getprop 并行（getProps 把多个属性合并为一条 shell，避免 4 次串行 adb）
    const propsFor = () => p.factsProps.map((f) => (typeof device.getProp === 'function' ? device.getProp(f.prop) : ''));
    const [sizeRes, props] = await Promise.all([
      device.screenSize().catch(() => null),
      (typeof device.getProps === 'function'
        ? device.getProps(p.factsProps.map((f) => f.prop))
        : Promise.all(propsFor())
      ).catch(() => p.factsProps.map(() => '')),
    ]);
    if (sizeRes && Number(sizeRes.w) > 0 && Number(sizeRes.h) > 0) stat.screenSize = { w: Number(sizeRes.w), h: Number(sizeRes.h) };
    const values = props || [];
    p.factsProps.forEach((f, i) => { if (values[i]) stat[f.key] = values[i]; });
    if (serial) STATIC_FACTS_CACHE.set(serial, stat);
  }

  const facts = { ...stat, netSupported: null, netProfile: null };
  try {
    const st = await device.netStatus();
    facts.netSupported = st?.profile != null && NET_PROFILES.includes(st.profile);
    facts.netProfile = st?.profile ?? null; // 供启动自检复用，避免重复 adb 往返
  } catch { /* 降级：net 支持未探测 */ }

  const collected = facts.screenSize || p.factsKeys.some((k) => facts[k]) || facts.netSupported !== null;
  return collected ? facts : null; // 全部失败 → 返回 null（不传），assemblePrompt 走缺省降级
}
