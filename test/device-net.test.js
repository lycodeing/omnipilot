// 网络档位（§10）：off/2g/3g/4g/5g/airplane/cut/custom，走设备 /system/bin/net
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Adb } from '../src/device/adb.js';
import { NET_PROFILES, setNetProfile, netStatus } from '../src/device/net-profile.js';

test('档位清单（§10）', () => {
  assert.deepEqual(NET_PROFILES, ['off', '2g', '3g', '4g', '5g', 'airplane', 'cut', 'custom']);
});

test('setNetProfile：合法档位下发 net <档位>；非法档位拒绝', async () => {
  const cmds = [];
  const adb = new Adb({
    serial: 'test',
    exec: async (args) => {
      if (args.includes('shell')) cmds.push(args.at(-1));
      return { code: 0, stdout: 'Bandwidth profile set: 4g', stderr: '' };
    },
  });
  const r = await setNetProfile(adb, '4g');
  assert.deepEqual(r, { ok: true, profile: '4g', error: null });
  assert.deepEqual(cmds, ['net 4g']);
  const bad = await setNetProfile(adb, '99g');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /未知档位/);
  assert.equal(cmds.length, 1, '非法档位不下发命令');
});

test('setNetProfile：设备脚本报错 → ok=false 带输出', async () => {
  const adb = new Adb({
    serial: 'test',
    exec: async () => ({ code: 0, stdout: 'Error: unknown profile', stderr: '' }),
  });
  const r = await setNetProfile(adb, '5g');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown profile/);
});

test('netStatus：解析当前档位；查询失败回退 unknown', async () => {
  const adb = new Adb({
    serial: 'test',
    exec: async (args) => {
      const joined = args.join(' ');
      if (joined.includes('net status')) return { code: 0, stdout: 'current: airplane', stderr: '' };
      throw new Error('no net script');
    },
  });
  assert.deepEqual(await netStatus(adb), { profile: 'airplane' });
  const adb2 = new Adb({
    serial: 'test',
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  assert.deepEqual(await netStatus(adb2), { profile: 'unknown' });
});

test('setNetProfile：设备无 net 命令（报错在 stderr）→ ok=false（缺陷 #14）', async () => {
  const adb = new Adb({
    serial: 'test',
    exec: async () => ({
      code: 127,
      stdout: '',
      stderr: '/system/bin/sh: net: inaccessible or not found\n',
    }),
  });
  const r = await setNetProfile(adb, '2g');
  assert.equal(r.ok, false, 'stderr 报错必须判为失败（修复前错判 ok=true）');
  assert.match(r.error, /inaccessible or not found/);
});
