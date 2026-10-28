// 失败回退（§5.0.6）：A 单步内重识别 + B 步骤级回滚
// device 为鸭子类型：locate / invalidateCache / foreground / screenDiffHash / key
// 每条失败路径都先丢缓存再重试，绝不用同一份旧缓存重试（§5.0.6）

// A. 定位失败 / 动作无响应 → 丢缓存重识别 → 重试上限（默认 2）
// act: async ({ locateResult }) => { ok, changed?, error? }（changed=false 表示动作后画面无变化）
export async function withLocateRetry({ device, target, locateOpts = {}, act, maxRetry = 2 }) {
  const attempts = [];
  let last = null;
  for (let i = 0; i <= maxRetry; i++) {
    if (i > 0) device.invalidateCache(); // 重试必须绕过缓存（含 VLM 缓存）
    const locateOpts2 = i > 0 ? { ...locateOpts, hintBounds: null, hintIdentity: null } : locateOpts;
    const located = await device.locate(target, locateOpts2);
    const attempt = { attempt: i + 1, stage: 'locate', ok: false, strategy: located.strategy, error: located.error ?? null };
    if (!located.ok) {
      attempts.push(attempt);
      last = { ok: false, located, attempts, error: located.error ?? '定位失败' };
      continue;
    }
    attempt.stage = 'act';
    let acted;
    try {
      acted = await act(located);
    } catch (e) {
      acted = { ok: false, error: String(e?.message ?? e) };
    }
    attempt.ok = Boolean(acted?.ok) && acted?.changed !== false; // changed=false = 动作后画面无变化
    attempt.error = acted?.error ?? null;
    attempts.push(attempt);
    if (acted?.ok && acted?.changed !== false) return { ok: true, located, attempts, changed: true };
    last = { ok: false, located, attempts, error: acted?.error ?? '动作未生效' };
  }
  return last ?? { ok: false, attempts, error: '未知失败' };
}

// B. 步骤级回滚（§5.0.6B）：回到上一个成功步骤的界面状态，重新识别；每步最多回滚 1 次
export class StepRollout {
  constructor(device, { recover = null, maxRollback = 1 } = {}) {
    this.device = device;
    this.recover = recover; // async (checkpoint) => boolean：恢复界面（如 key back / 重新 launch）
    this.maxRollback = maxRollback;
    this._checkpoint = null;
    this._used = 0;
  }

  get checkpoint() {
    return this._checkpoint;
  }

  get rollbacksUsed() {
    return this._used;
  }

  // 每步成功后记录：Activity + 树hash + 步骤标识 + 变量表快照
  async saveCheckpoint({ stepIndex, stepText, vars } = {}) {
    const fg = await this.device.foreground().catch(() => ({}));
    let treeHash = null;
    try {
      treeHash = await this.device.screenDiffHash();
    } catch {}
    this._checkpoint = {
      stepIndex: stepIndex ?? null,
      stepText: stepText ?? '',
      activity: fg.package ?? null,
      treeHash,
      vars: vars instanceof Map ? [...vars.entries()] : (vars ?? []),
    };
    return { ...this._checkpoint };
  }

  async rollbackToCheckpoint() {
    if (!this._checkpoint) return { attempted: false, recovered: false, reason: '无 checkpoint' };
    if (this._used >= this.maxRollback) return { attempted: false, recovered: false, reason: '回滚次数已达上限(1)' };
    this._used++;
    const cp = this._checkpoint;
    let matched = await this._matches(cp);
    if (!matched && this.recover) {
      const ok = await this.recover(cp).catch(() => false);
      if (ok) matched = await this._matches(cp);
    }
    // 重识别前提：丢缓存强制 void（§5.0.7）
    this.device.invalidateCache();
    return { attempted: true, recovered: matched, matched, reason: matched ? null : '无法恢复到步骤前置界面' };
  }

  async _matches(cp) {
    const fg = await this.device.foreground().catch(() => ({}));
    if ((fg.package ?? null) !== cp.activity) return false;
    const h = await this.device.screenDiffHash().catch(() => null);
    return h != null && h === cp.treeHash;
  }
}
