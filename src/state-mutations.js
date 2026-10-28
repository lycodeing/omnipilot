// 运行期「全局设备状态」改动记录与还原（§2.6）。
// 只覆盖会污染后续 run 的状态：网络档位。前台 App / 输入内容不还原（破坏用例语义）。
// 依赖方向：本模块只被 bin/ask.js 与 src/tools/env.js 消费，不认识 device 内部实现。

const NET_NORMALIZE = (p) => (p && p !== 'unknown' ? p : 'off');

// 切网前记录 from（读当前档位，归一化 unknown → off），push 到 ctx.stateMutations
export async function recordNetMutation(ctx, device, to) {
  if (!ctx.stateMutations) ctx.stateMutations = [];
  const st = await device.netStatus().catch(() => ({ profile: null }));
  const rawFrom = st?.profile ?? null;
  ctx.stateMutations.push({ kind: 'net', from: NET_NORMALIZE(rawFrom), to, rawFrom, at: Date.now() });
}

export function needsNetworkRestore(ctx) {
  return Array.isArray(ctx?.stateMutations) && ctx.stateMutations.some((m) => m.kind === 'net');
}

// 还原到 run 开始前的档位：取**第一条** mutation 的 from（多次切网 2g→4g→off 时，
// last.from 是最后一次切网前的档位而非原始档位，会导致设备被留在弱网档——评审 Critical 修复）
export async function restoreNetwork(device, ctx) {
  const nets = (ctx?.stateMutations ?? []).filter((m) => m.kind === 'net');
  if (!nets.length) return { ok: true, restored: null, error: null };
  const target = nets[0].from;
  try {
    const r = await device.netSetProfile(target);
    if (r && r.ok === false) return { ok: false, restored: null, error: r.error || 'netSetProfile 返回失败' };
    return { ok: true, restored: target, error: null };
  } catch (e) {
    return { ok: false, restored: null, error: String(e?.message ?? e) };
  }
}
