// 状态回滚（§2.6）：网络档位改动的记录与还原
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordNetMutation, restoreNetwork } from '../src/state-mutations.js';

const mockDevice = (over = {}) => ({
  netStatus: async () => ({ profile: 'off' }),
  netSetProfile: async (p) => ({ ok: true, profile: p, error: null }),
  ...over,
});

test('recordNetMutation：切网前读 from 并归一化 unknown→off', async () => {
  const ctx = { stateMutations: [] };
  await recordNetMutation(ctx, mockDevice({ netStatus: async () => ({ profile: 'unknown' }) }), '2g');
  assert.equal(ctx.stateMutations.length, 1);
  assert.deepEqual(
    { kind: ctx.stateMutations[0].kind, from: ctx.stateMutations[0].from, to: ctx.stateMutations[0].to },
    { kind: 'net', from: 'off', to: '2g' },
  );
  assert.equal(ctx.stateMutations[0].rawFrom, 'unknown', '原始读数留证');
});

test('restoreNetwork：还原到最初的档位（第一条 mutation 的 from），成功 → ok=true', async () => {
  const calls = [];
  const device = mockDevice({ netSetProfile: async (p) => { calls.push(p); return { ok: true, profile: p, error: null }; } });
  const ctx = { stateMutations: [{ kind: 'net', from: 'off', to: '2g', rawFrom: 'unknown', at: 1 }] };
  const r = await restoreNetwork(device, ctx);
  assert.deepEqual(calls, ['off']);
  assert.equal(r.ok, true);
  assert.equal(r.restored, 'off');
});

test('restoreNetwork：多次切网还原到最初档位，而非最后一次切网前的档位（回归：last.from 曾把设备留在弱网）', async () => {
  const calls = [];
  const device = mockDevice({ netSetProfile: async (p) => { calls.push(p); return { ok: true, profile: p, error: null }; } });
  // 复现标准弱网流程：初始 off → 切 2g → 恢复 off。last.from 是 '2g'，还原目标是第一条的 'off'
  const ctx = { stateMutations: [
    { kind: 'net', from: 'off', to: '2g', rawFrom: 'off', at: 1 },
    { kind: 'net', from: '2g', to: 'off', rawFrom: '2g', at: 2 },
  ] };
  const r = await restoreNetwork(device, ctx);
  assert.deepEqual(calls, ['off'], '必须还原到 off（最初档位），而不是 2g（最后切网前的档位）');
  assert.equal(r.restored, 'off');
});

test('restoreNetwork：三段切网（off→2g→4g→off）同样还原到最初的 off', async () => {
  const calls = [];
  const device = mockDevice({ netSetProfile: async (p) => { calls.push(p); return { ok: true, profile: p, error: null }; } });
  const ctx = { stateMutations: [
    { kind: 'net', from: 'off', to: '2g', rawFrom: 'off', at: 1 },
    { kind: 'net', from: '2g', to: '4g', rawFrom: '2g', at: 2 },
    { kind: 'net', from: '4g', to: 'off', rawFrom: '4g', at: 3 },
  ] };
  await restoreNetwork(device, ctx);
  assert.deepEqual(calls, ['off']);
});

test('restoreNetwork：还原失败 → ok=false 带 error（不静默）', async () => {
  const device = mockDevice({ netSetProfile: async (p) => ({ ok: false, profile: p, error: 'boom' }) });
  const ctx = { stateMutations: [{ kind: 'net', from: 'off', to: '2g' }] };
  const r = await restoreNetwork(device, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('restoreNetwork：无记录 → 跳过（不调设备）', async () => {
  let called = false;
  const device = mockDevice({ netSetProfile: async () => { called = true; return { ok: true }; } });
  const r = await restoreNetwork(device, { stateMutations: [] });
  assert.equal(called, false);
  assert.equal(r.ok, true);
});

test('restoreNetwork 幂等：连续两次调用不报错（信号 + finally 双触发）', async () => {
  const device = mockDevice();
  const ctx = { stateMutations: [{ kind: 'net', from: 'off', to: '2g' }] };
  const a = await restoreNetwork(device, ctx);
  const b = await restoreNetwork(device, ctx);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});
