// adb 执行器：串行队列 / 单命令超时 / 断连一次重连 / exec-out 二进制（注入假执行器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Adb } from '../src/device/adb.js';

test('同设备命令严格串行', async () => {
  let running = 0;
  let maxConcurrent = 0;
  const order = [];
  const exec = async (args) => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, args.includes('slow') ? 30 : 5));
    order.push(args.at(-1));
    running--;
    return { code: 0, stdout: 'ok', stderr: '' };
  };
  const adb = new Adb({ serial: 'emulator-5554', exec });
  await Promise.all([adb.shell('a'), adb.shell('slow'), adb.shell('c')]);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(order, ['a', 'slow', 'c']);
});

test('单命令超时', async () => {
  const exec = async () => new Promise(() => {});
  const adb = new Adb({ serial: 's', exec });
  await assert.rejects(adb.shell('hang', { timeoutMs: 30 }), /超时/);
});

test('断连自动重连一次并重试成功', async () => {
  const calls = [];
  let shellTries = 0;
  const exec = async (args) => {
    calls.push(args.join(' '));
    if (args.includes('shell')) {
      shellTries++;
      if (shellTries === 1) return { code: 1, stdout: '', stderr: 'error: device offline' };
      return { code: 0, stdout: 'done', stderr: '' };
    }
    return { code: 0, stdout: 'connected to 1.2.3.4:5555', stderr: '' }; // connect
  };
  const adb = new Adb({ serial: '1.2.3.4:5555', exec });
  const out = await adb.shell('x');
  assert.equal(out, 'done');
  assert.equal(shellTries, 2, '原命令只重试一次');
  assert.ok(calls.some((c) => c.startsWith('connect 1.2.3.4:5555')), 'TCP 序列号用 adb connect');
  // 串行队列中带 -s
  assert.ok(calls[0].startsWith('-s 1.2.3.4:5555'));
});

test('远端命令退出码非 0 不算断连（pidof 场景），不触发重连', async () => {
  let extra = 0;
  const exec = async (args) => {
    if (!args.includes('shell')) extra++;
    return { code: 1, stdout: '', stderr: '' };
  };
  const adb = new Adb({ serial: 's', exec });
  const out = await adb.shell('pidof nope');
  assert.equal(out, '');
  assert.equal(extra, 0);
});

test('execOut 返回原始 Buffer（screencap 通道）', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const exec = async () => ({ code: 0, stdout: png, stderr: '' });
  const adb = new Adb({ serial: 's', exec });
  const buf = await adb.execOut(['screencap', '-p']);
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('execOut 失败抛错', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  const adb = new Adb({ serial: 's', exec });
  await assert.rejects(adb.execOut(['screencap', '-p']), /boom/);
});

test('ensureConnected：get-state 失败后 connect 再验', async () => {
  const calls = [];
  let stateTries = 0;
  const exec = async (args) => {
    calls.push(args.join(' '));
    if (args.includes('get-state')) {
      stateTries++;
      if (stateTries === 1) return { code: 1, stdout: 'error: device not found', stderr: '' };
      return { code: 0, stdout: 'device', stderr: '' };
    }
    return { code: 0, stdout: 'connected', stderr: '' };
  };
  const adb = new Adb({ serial: '10.0.0.1:5555', exec });
  assert.equal(await adb.ensureConnected(), true);
  assert.deepEqual(calls, ['-s 10.0.0.1:5555 get-state', 'connect 10.0.0.1:5555', '-s 10.0.0.1:5555 get-state']);
});

test('shell({withStderr:true}) 返回 {stdout, stderr}；默认仍返回字符串', async () => {
  const adb = new Adb({
    serial: 'test',
    exec: async () => ({ code: 0, stdout: 'out-text', stderr: 'err-text' }),
  });
  // 默认：向后兼容，仍是字符串
  assert.equal(await adb.shell('echo hi'), 'out-text');
  // 显式要 stderr
  const r = await adb.shell('net 2g', { withStderr: true });
  assert.deepEqual(r, { stdout: 'out-text', stderr: 'err-text' });
});
