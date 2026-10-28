// 会话保留策略（§9.1）：keep（默认）/ fresh / continue / session
// 例外：含 secret_get/sms_read 调用的 run 强制 inMemory（会话文件可能携带凭据，不得落盘）。

import { SessionManager } from '@earendil-works/pi-coding-agent';

export const STRATEGIES = ['keep', 'fresh', 'continue', 'session'];

// 纯函数：根据 CLI 标志与 secret 调用记录决定最终策略（可单测，不触碰文件系统）
export function resolveStrategy({ keep, fresh, cont, session, hasSecretCalls = false } = {}) {
  let strategy = 'keep';
  if (fresh) strategy = 'fresh';
  else if (cont) strategy = 'continue';
  else if (session) strategy = 'session';
  else if (keep === true) strategy = 'keep';
  // 默认就是 keep（--keep 为默认值，显式传入亦同）
  const forced = hasSecretCalls && strategy !== 'fresh';
  return {
    strategy: forced ? 'fresh' : strategy,
    forcedBySecret: forced,
    reason: forced ? '本 run 含 secret_get/sms_read 调用，会话强制 inMemory 不落盘（§9.1 例外）' : null,
  };
}

// 由 ctx.secretCalls（§1.2）判定
export function resolveStrategyForCtx(ctx, flags = {}) {
  const hasSecretCalls = Array.isArray(ctx?.secretCalls) && ctx.secretCalls.length > 0;
  return resolveStrategy({ ...flags, hasSecretCalls });
}

// 按策略产出 SessionManager 实例（§9.1 表格对应的 Pi 静态工厂）
export async function createSessionManager({ strategy = 'keep', sessionFile, cwd = process.cwd() } = {}) {
  switch (strategy) {
    case 'fresh':
      return SessionManager.inMemory(cwd);
    case 'continue':
      return SessionManager.continueRecent(cwd);
    case 'session':
      if (!sessionFile) throw new Error('--session 需要指定会话文件路径');
      return SessionManager.open(sessionFile);
    case 'keep':
    default:
      return SessionManager.create(cwd);
  }
}
