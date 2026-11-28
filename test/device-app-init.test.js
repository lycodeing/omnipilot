// APP 初始化模块单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp } from '../src/device/app-init.js';

/** 构造 mock device，记录调用顺序 */
function makeMockDevice({ terminateOk = true, clearOk = true, launchOk = true } = {}) {
  const calls = [];
  return {
    calls,
    serial: 'test-device',
    async terminate(packageName) {
      calls.push(['terminate', packageName]);
      return terminateOk ? { ok: true } : { ok: false, error: 'stop failed' };
    },
    async clearAppData(packageName) {
      calls.push(['clearAppData', packageName]);
      return clearOk ? { ok: true } : { ok: false, error: 'clear failed' };
    },
    async launch(packageName) {
      calls.push(['launch', packageName]);
      return launchOk ? { ok: true } : { ok: false, error: 'launch failed' };
    },
  };
}

test('initializeApp：默认轻量模式 clear-task-launch（不 force-stop）', async () => {
  const device = makeMockDevice();
  const result = await initializeApp(device, { packageName: 'com.example.app', launchWaitMs: 10 });
  assert.equal(result.ok, true);
  // 轻量模式调 launch（monkey），不调 terminate
  assert.deepEqual(device.calls.map((c) => c[0]), ['launch']);
  assert.ok(result.steps.includes('relaunch'));
  assert.ok(!result.steps.includes('force-stop'));
  assert.ok(!result.steps.includes('pm-clear'));
});

test('initializeApp：clearData=true 时 force-stop → pm-clear → launch', async () => {
  const device = makeMockDevice();
  const result = await initializeApp(device, { packageName: 'com.example.app', clearData: true, launchWaitMs: 10 });
  assert.equal(result.ok, true);
  assert.deepEqual(device.calls.map((c) => c[0]), ['terminate', 'clearAppData', 'launch']);
  assert.ok(result.steps.includes('force-stop'));
  assert.ok(result.steps.includes('pm-clear'));
  assert.ok(result.steps.includes('launch'));
});

test('initializeApp：dismissPopups 回调被调用', async () => {
  const device = makeMockDevice();
  let dismissed = false;
  const result = await initializeApp(device, {
    packageName: 'com.example.app',
    launchWaitMs: 10,
    dismissPopups: async () => { dismissed = true; },
  });
  assert.equal(result.ok, true);
  assert.equal(dismissed, true);
  assert.ok(result.steps.includes('dismiss-popups'));
});

test('initializeApp：clearData=true + terminate 失败时早退', async () => {
  const device = makeMockDevice({ terminateOk: false });
  const result = await initializeApp(device, { packageName: 'com.example.app', clearData: true, launchWaitMs: 10 });
  assert.equal(result.ok, false);
  assert.match(result.error, /force-stop/);
  assert.equal(device.calls.length, 1);
});

test('initializeApp：clearData=true + clearAppData 失败时早退', async () => {
  const device = makeMockDevice({ clearOk: false });
  const result = await initializeApp(device, { packageName: 'com.example.app', clearData: true, launchWaitMs: 10 });
  assert.equal(result.ok, false);
  assert.match(result.error, /pm clear/);
  assert.equal(device.calls.length, 2);
});

test('initializeApp：clearData=true + launch 失败时早退', async () => {
  const device = makeMockDevice({ launchOk: false });
  const result = await initializeApp(device, { packageName: 'com.example.app', clearData: true, launchWaitMs: 10 });
  assert.equal(result.ok, false);
  assert.match(result.error, /launch/);
});

test('initializeApp：dismissPopups 抛错不阻断', async () => {
  const device = makeMockDevice();
  const result = await initializeApp(device, {
    packageName: 'com.example.app',
    launchWaitMs: 10,
    dismissPopups: async () => { throw new Error('popup error'); },
  });
  assert.equal(result.ok, true);
  assert.ok(result.steps.includes('dismiss-popups-skipped'));
});

test('initializeApp：clearData=true 时 resetAccessibility 被调用', async () => {
  const device = makeMockDevice();
  let resetCalled = false;
  const result = await initializeApp(device, {
    packageName: 'com.example.app',
    clearData: true,
    launchWaitMs: 10,
    resetAccessibility: async () => { resetCalled = true; return true; },
  });
  assert.equal(result.ok, true);
  assert.equal(resetCalled, true);
  assert.ok(result.steps.includes('reset-a11y-ok'));
});

test('initializeApp：默认模式不调 resetAccessibility', async () => {
  const device = makeMockDevice();
  let resetCalled = false;
  const result = await initializeApp(device, {
    packageName: 'com.example.app',
    launchWaitMs: 10,
    resetAccessibility: async () => { resetCalled = true; return true; },
  });
  assert.equal(result.ok, true);
  assert.equal(resetCalled, false); // 轻量模式不需要重置
});
