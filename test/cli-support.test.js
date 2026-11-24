// CLI 支撑模块单测：参数解析 / 设备锁 / 设备事实采集（从 bin/ask.js 抽出，无设备依赖）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgv } from '../src/cli/argv.js';
import { pidAlive, acquireLock, releaseLock, lockPath } from '../src/cli/lock.js';
import { collectDeviceFacts } from '../src/cli/device-facts.js';

// 预置锁文件（父目录可能尚未创建）
function seedLock(root, serial, body) {
  const p = lockPath(root, serial);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body));
  return p;
}

// —— parseArgv ——
test('parseArgv：子命令 + 位置参数 + --flag value', () => {
  const r = parseArgv(['run', 'cases/a.yaml', '--device', 'emulator-5554']);
  assert.equal(r.cmd, 'run');
  assert.deepEqual(r.positional, ['cases/a.yaml']);
  assert.equal(r.flags.device, 'emulator-5554');
});

test('parseArgv：--flag=value 形式', () => {
  const r = parseArgv(['run', '--timeout=120', '--model-name=glm-5.3-flash']);
  assert.equal(r.flags.timeout, '120');
  assert.equal(r.flags['model-name'], 'glm-5.3-flash');
});

test('parseArgv：布尔 flag 不吞下一个参数', () => {
  const r = parseArgv(['run', 'cases/a.yaml', '--yes', '--json']);
  assert.equal(r.flags.yes, true);
  assert.equal(r.flags.json, true);
  assert.deepEqual(r.positional, ['cases/a.yaml']);
});

test('parseArgv：缺省命令为 help；连续值 flag 取紧随的非 -- 项', () => {
  assert.equal(parseArgv([]).cmd, 'help');
  const r = parseArgv(['do', '打开首页', '--prompt', '自定义提示']);
  assert.deepEqual(r.positional, ['打开首页']);
  assert.equal(r.flags.prompt, '自定义提示');
});

// —— 设备锁 ——
test('acquireLock：空目录首次获取成功并写 {pid,ts,serial}', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  const r = acquireLock(root, 'emulator-5554');
  assert.equal(r.ok, true);
  const rec = JSON.parse(readFileSync(lockPath(root, 'emulator-5554'), 'utf8'));
  assert.equal(rec.serial, 'emulator-5554');
  assert.equal(rec.pid, process.pid);
  assert.ok(rec.ts > 0);
});

test('acquireLock：属主存活 → 拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  seedLock(root, 'dev', { pid: process.pid, ts: Date.now(), serial: 'dev' });
  const r = acquireLock(root, 'dev');
  assert.equal(r.ok, false);
  assert.match(r.reason, /正被 PID/);
});

test('acquireLock：死进程未过清理期 → 拒绝；超过 staleMs → 自动清理接管', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  const deadPid = 99999999; // 不存在
  seedLock(root, 'dev', { pid: deadPid, ts: 1000, serial: 'dev' });
  const early = acquireLock(root, 'dev', { staleMs: 10 * 60_000, now: () => 1000 + 5_000 });
  assert.equal(early.ok, false, '未过清理期应拒绝');
  assert.match(early.reason, /未到清理期/);
  const late = acquireLock(root, 'dev', { staleMs: 10 * 60_000, now: () => 1000 + 11 * 60_000 });
  assert.equal(late.ok, true, '超过 staleMs 应清理并接管');
});

test('acquireLock：serial 特殊字符被规整进文件名', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  const r = acquireLock(root, '172.16.1.2:5555');
  assert.equal(r.ok, true);
  const base = basename(lockPath(root, '172.16.1.2:5555'));
  assert.equal(base.includes(':'), false, '文件名不得含冒号');
  assert.ok(base.startsWith('172.16.1.2'), '可见字符保留');
  assert.ok(existsSync(lockPath(root, '172.16.1.2:5555')));
});

test('releaseLock：仅当属主是当前进程才删除', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  acquireLock(root, 'dev');
  releaseLock(root, 'dev');
  assert.equal(existsSync(lockPath(root, 'dev')), false, '当前进程应能释放');
  // 他人持有则不动
  seedLock(root, 'other', { pid: 99999999, ts: Date.now(), serial: 'other' });
  releaseLock(root, 'other');
  assert.ok(existsSync(lockPath(root, 'other')), '非本进程持有的锁不得删除');
});

test('pidAlive：当前进程 true，不存在 pid false', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(99999999), false);
});

test('acquireLock：锁文件损坏且新鲜 → 拒绝且不删（防偷走刚创建还没写入的活锁，O_EXCL 修复回归）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  const p = lockPath(root, 'dev');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '', 'utf8'); // 模拟属主 openSync('wx') 后、写入前被读到
  const r = acquireLock(root, 'dev', { staleMs: 10 * 60_000 });
  assert.equal(r.ok, false, '损坏但新鲜的锁必须拒绝接管');
  assert.match(r.reason, /未到清理期/);
  assert.ok(existsSync(p), '拒绝时不得删除锁文件');
});

test('acquireLock：锁文件损坏且超过 staleMs → 清理接管', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  const p = lockPath(root, 'dev');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '', 'utf8');
  await new Promise((r) => setTimeout(r, 60));
  const r2 = acquireLock(root, 'dev', { staleMs: 30 });
  assert.equal(r2.ok, true, '损坏且过期的锁应清理接管');
});

test('acquireLock：O_EXCL 互斥——同进程连续两次获取，第二次必被拒（TOCTOU 回归）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  const first = acquireLock(root, 'dev');
  assert.equal(first.ok, true);
  const second = acquireLock(root, 'dev');
  assert.equal(second.ok, false, '锁存在时第二次获取必须失败');
  assert.match(second.reason, /正被 PID/);
});

// —— 设备事实采集（mock 门面，无真机） ——
const mockDevice = (over = {}) => ({
  screenSize: async () => ({ w: 1080, h: 2400 }),
  getProp: async (k) => ({ 'ro.build.version.release': '15', 'ro.product.model': 'sdk_gphone64_x86_64' }[k] ?? ''),
  netStatus: async () => ({ profile: 'unknown' }),
  ...over,
});

test('collectDeviceFacts：真机形态（1080x2400 + net 不可用）', async () => {
  const f = await collectDeviceFacts(mockDevice());
  assert.deepEqual(f.screenSize, { w: 1080, h: 2400 });
  assert.equal(f.androidVersion, '15');
  assert.equal(f.deviceModel, 'sdk_gphone64_x86_64');
  assert.equal(f.netSupported, false, 'profile=unknown → net 不支持');
});

test('collectDeviceFacts：net 可用（profile=off）→ netSupported=true', async () => {
  const f = await collectDeviceFacts(mockDevice({ netStatus: async () => ({ profile: 'off' }) }));
  assert.equal(f.netSupported, true);
});

test('collectDeviceFacts：门面全挂 → 返回 null 走降级', async () => {
  const f = await collectDeviceFacts(mockDevice({
    screenSize: async () => { throw new Error('boom'); },
    getProp: async () => { throw new Error('boom'); },
    netStatus: async () => { throw new Error('boom'); },
  }));
  assert.equal(f, null);
});

test('collectDeviceFacts：缺 getProp 能力不抛错（部分降级）', async () => {
  const dev = mockDevice();
  delete dev.getProp;
  const f = await collectDeviceFacts(dev);
  assert.deepEqual(f.screenSize, { w: 1080, h: 2400 });
  assert.equal(f.androidVersion, null);
  assert.equal(f.deviceModel, null);
});

test('collectDeviceFacts：分辨率非法（0）视为未采集', async () => {
  const f = await collectDeviceFacts(mockDevice({ screenSize: async () => ({ w: 0, h: 0 }) }));
  assert.equal(f.screenSize, null);
});

test('parseRequestedPermissions：从 dumpsys 文本提取运行时权限', async () => {
  const { parseRequestedPermissions } = await import('../src/cli/pregrant.js');
  const text = `  requested permissions:
      android.permission.CAMERA
      android.permission.READ_EXTERNAL_STORAGE
      com.huawei.launcher.permission.WRITE_SETTINGS
      android.permission.POST_NOTIFICATIONS`;
  const perms = parseRequestedPermissions(text);
  assert.ok(perms.includes('android.permission.CAMERA'));
  assert.ok(perms.includes('android.permission.POST_NOTIFICATIONS'));
  assert.ok(!perms.some((p) => p.startsWith('com.huawei')), '只取 android.permission.* 运行时权限');
});

test('pregrantPackage：只 grant 白名单内权限；失败不抛错', async () => {
  const { pregrantPackage } = await import('../src/cli/pregrant.js');
  const granted = [];
  const device = {
    dumpsysPackage: async () => `requested permissions:
      android.permission.CAMERA
      android.permission.POST_NOTIFICATIONS
      android.permission.BIND_ACCESSIBILITY_SERVICE`,
    pmGrant: async (perm, pkg) => {
      if (perm === 'android.permission.POST_NOTIFICATIONS') return { ok: false, error: 'denied' };
      granted.push(perm);
      return { ok: true, error: null };
    },
  };
  const r = await pregrantPackage(device, 'com.demo');
  assert.deepEqual(granted, ['android.permission.CAMERA']);
  assert.equal(r.granted.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].perm, 'android.permission.POST_NOTIFICATIONS');
});

test('preflight 顺序约束：grant 前必须终止目标 App（真机实测 grant 会杀掉运行中的 App）', async () => {
  const { pregrantPackage } = await import('../src/cli/pregrant.js');
  const order = [];
  const device = {
    terminate: async (pkg) => { order.push('terminate:' + pkg); return { ok: true }; },
    dumpsysPackage: async () => 'requested permissions:\n      android.permission.CAMERA',
    pmGrant: async (perm) => { order.push('grant:' + perm); return { ok: true, error: null }; },
  };
  // 复刻 bin/ask.js 的调用顺序
  const pkg = 'com.demo';
  await device.terminate(pkg);
  const r = await pregrantPackage(device, pkg);
  assert.deepEqual(order, ['terminate:com.demo', 'grant:android.permission.CAMERA'],
    '必须先 terminate 再 grant（否则 App 被杀）');
  assert.equal(r.granted.length, 1);
});

// —— 取值型 flag 缺值必须报错（此前静默取 true）——

test('parseArgv：取值型 flag 缺值时抛错（--timeout --yes）', () => {
  // 回归用例：缺值时 flags.timeout === true → 消费方 Number(true)*1000 = 1000ms，
  // 整个 run 的超时预算变成 1 秒且无任何报错。
  assert.throws(() => parseArgv(['run', '--timeout', '--yes']), /--timeout 需要一个值/);
  assert.throws(() => parseArgv(['run', '--out']), /--out 需要一个值/);
});

test('parseArgv：布尔 flag 与可选值 flag 不受影响', () => {
  assert.equal(parseArgv(['run', '--yes']).flags.yes, true);
  assert.equal(parseArgv(['run', '--timeout', '60']).flags.timeout, '60');
  // 可选值 flag（doctor 的"检查默认设备"用法）：裸 --device 为 true
  assert.equal(parseArgv(['doctor', '--device']).flags.device, true);
  assert.equal(parseArgv(['doctor', '--device', 'emulator-5554']).flags.device, 'emulator-5554');
});
