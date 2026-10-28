// rollout（§5.0.6）：A 单步内重识别状态机 + B 步骤级回滚（用假 device 测）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLocateRetry, StepRollout } from '../src/device/rollout.js';

function fakeDevice({ locateResults = [], hash = 'h1', fg = 'com.app' } = {}) {
  const calls = { locate: 0, invalidate: 0, key: 0 };
  const state = { hash, fg };
  return {
    calls,
    state,
    async locate(target) {
      const r = locateResults[Math.min(calls.locate, locateResults.length - 1)] ?? { ok: true, bounds: [0, 0, 10, 10], strategy: 'exact_text' };
      calls.locate++;
      return r;
    },
    invalidateCache() {
      calls.invalidate++;
    },
    async screenDiffHash() {
      return state.hash;
    },
    async foreground() {
      return { package: state.fg, activity: 'Main', resumedActivity: `${state.fg}/Main` };
    },
    async key() {
      calls.key++;
      return { ok: true };
    },
  };
}

test('withLocateRetry：一次成功只定位一次，不丢缓存', async () => {
  const device = fakeDevice();
  const r = await withLocateRetry({
    device,
    target: '按钮',
    act: async () => ({ ok: true, changed: true }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.attempts.length, 1);
  assert.equal(device.calls.invalidate, 0);
});

test('withLocateRetry：定位失败 → 丢缓存重识别后成功（§5.0.6A ①）', async () => {
  const device = fakeDevice({
    locateResults: [
      { ok: false, strategy: 'none', error: '未找到目标' },
      { ok: true, bounds: [0, 0, 10, 10], strategy: 'exact_text' },
    ],
  });
  const r = await withLocateRetry({ device, target: '按钮', act: async () => ({ ok: true, changed: true }) });
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].stage, 'locate');
  assert.equal(device.calls.invalidate, 1, '每条失败路径先丢缓存再重试');
});

test('withLocateRetry：动作无响应（changed=false）→ 丢缓存重新定位+动作，重试上限 2', async () => {
  const device = fakeDevice();
  const r = await withLocateRetry({
    device,
    target: '按钮',
    act: async () => ({ ok: true, changed: false }),
    maxRetry: 2,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, '动作未生效');
  assert.equal(r.attempts.length, 3, '首次 + 2 次重试');
  assert.equal(device.calls.locate, 3);
  assert.equal(device.calls.invalidate, 2);
  // 重试时必须弃用 hint
  const device2 = fakeDevice();
  const hint = { hintBounds: [0, 0, 1, 1], hintIdentity: { text: 'x', cls: 'y' } };
  await withLocateRetry({ device: device2, target: '按钮', locateOpts: hint, act: async () => ({ ok: false, error: 'x' }) });
  assert.equal(device2.calls.locate, 3);
});

test('withLocateRetry：act 抛异常按失败计并重试', async () => {
  const device = fakeDevice({ locateResults: [{ ok: false, strategy: 'none', error: 'e1' }, { ok: false, strategy: 'none', error: 'e2' }] });
  let acts = 0;
  const r = await withLocateRetry({
    device,
    target: '按钮',
    act: async () => {
      acts++;
      throw new Error('adb boom');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(acts, 0, '三次定位全失败，act 不执行');
  assert.equal(r.error, 'e2');
});

test('StepRollout：checkpoint 记录前台+树hash+变量快照', async () => {
  const device = fakeDevice({ hash: 'h1', fg: 'com.app' });
  const ro = new StepRollout(device);
  const cp = await ro.saveCheckpoint({ stepIndex: 3, stepText: '点击电子相册', vars: new Map([['a', '1']]) });
  assert.deepEqual(cp, { stepIndex: 3, stepText: '点击电子相册', activity: 'com.app', treeHash: 'h1', vars: [['a', '1']] });
  assert.deepEqual(ro.checkpoint, cp);
});

test('StepRollout：界面漂移后 recover 成功 → 重识别前提成立', async () => {
  const device = fakeDevice({ hash: 'h1', fg: 'com.app' });
  const ro = new StepRollout(device, { recover: async () => { device.state.fg = 'com.app'; device.state.hash = 'h1'; return true; } });
  await ro.saveCheckpoint({ stepIndex: 3 });
  // 漂移：跳到 launcher
  device.state.fg = 'com.android.launcher3';
  device.state.hash = 'h2';
  const r = await ro.rollbackToCheckpoint();
  assert.equal(r.attempted, true);
  assert.equal(r.recovered, true);
  assert.equal(device.calls.invalidate, 1, '回滚后强制丢缓存重新识别');
  assert.equal(ro.rollbacksUsed, 1);
});

test('StepRollout：recover 失败 → recovered=false；最多回滚 1 次（§5.0.6B）', async () => {
  const device = fakeDevice({ hash: 'h1', fg: 'com.app' });
  const ro = new StepRollout(device, { recover: async () => false });
  await ro.saveCheckpoint({ stepIndex: 1 });
  device.state.fg = 'com.android.launcher3';
  const r1 = await ro.rollbackToCheckpoint();
  assert.equal(r1.recovered, false);
  assert.match(r1.reason, /无法恢复/);
  const r2 = await ro.rollbackToCheckpoint();
  assert.equal(r2.attempted, false);
  assert.match(r2.reason, /上限/);
});

test('StepRollout：无 checkpoint / 界面本就一致则直接匹配', async () => {
  const ro = new StepRollout(fakeDevice());
  const r0 = await ro.rollbackToCheckpoint();
  assert.equal(r0.attempted, false);
  const device = fakeDevice({ hash: 'h1', fg: 'com.app' });
  const ro2 = new StepRollout(device);
  await ro2.saveCheckpoint({ stepIndex: 2 });
  const r = await ro2.rollbackToCheckpoint();
  assert.equal(r.matched, true, '界面一致无需恢复');
  assert.equal(device.calls.key, 0);
});
