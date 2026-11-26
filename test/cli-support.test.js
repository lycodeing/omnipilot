// CLI 支撑模块单测：参数解析 / 设备锁 / 设备事实采集（从 bin/ask.js 抽出，无设备依赖）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgv } from '../src/cli/argv.js';
import { pidAlive, acquireLock, releaseLock, lockPath, lockDir, sharedLockPath } from '../src/cli/lock.js';
import { collectDeviceFacts } from '../src/cli/device-facts.js';
import { RunRecorder } from '../src/recorder/index.js';

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

// —— 设备共享锁（Task 10：ask 只读并发，exclusive 与 shared 互斥） ——
test('acquireLock shared：同设备多个 shared 共存；exclusive 与 shared 互斥', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  const s1 = acquireLock(root, 'dev', { mode: 'shared', pid: process.pid });
  assert.equal(s1.ok, true);
  // 第二次用真实 acquireLock（另一 pid）取读锁，验证同设备多个 shared 可共存。
  // s1 用 process.pid 保活，确保下面的 exclusive 扫描必命中一个存活读锁；s2 的 pid
  // 是否存活不影响判定，故只对文件存在性断言即可（无需依赖 pidAlive）。
  const otherPid = process.pid + 1;
  const s2 = acquireLock(root, 'dev', { mode: 'shared', pid: otherPid });
  assert.equal(s2.ok, true, '第二个 shared 读锁也应获取成功');
  assert.ok(existsSync(s1.path), '第一个 shared 锁文件存在');
  assert.ok(existsSync(s2.path), '第二个 shared 锁文件存在');
  assert.notEqual(s1.path, s2.path, '不同 pid 的读锁分文件');
  const ex = acquireLock(root, 'dev', { mode: 'exclusive', pid: process.pid });
  assert.equal(ex.ok, false, '有存活 shared 锁时 exclusive 应被拒');
  assert.match(ex.reason, /shared|读锁/);
  // 清理全部 shared 锁后 exclusive 可获取（s1、s2 都要移除）
  rmSync(s1.path);
  rmSync(s2.path);
  const ex2 = acquireLock(root, 'dev', { mode: 'exclusive', pid: process.pid });
  assert.equal(ex2.ok, true);
});

test('acquireLock shared：exclusive 存活/损坏新鲜时 shared 被拒，过期残留清理后可获取', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  acquireLock(root, 'dev', { pid: process.pid }); // exclusive
  const sh = acquireLock(root, 'dev', { mode: 'shared', pid: process.pid });
  assert.equal(sh.ok, false);
  // M3：exclusive 锁文件损坏/为空时，shared 分支按 mtime 保守判活（对称 exclusive 路径）。
  // 属主刚以 'wx' 创建、还没写入：新鲜则拒绝 shared，防偷走正在建立的活锁。
  const root2 = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  const exPath = lockPath(root2, 'dev');
  mkdirSync(dirname(exPath), { recursive: true });
  writeFileSync(exPath, '', 'utf8');
  const fresh = acquireLock(root2, 'dev', { mode: 'shared', staleMs: 10 * 60_000, now: () => Date.now() });
  assert.equal(fresh.ok, false, '损坏且新鲜的 exclusive 锁须拒绝 shared');
  assert.match(fresh.reason, /未到清理期|拒绝/);
  assert.ok(existsSync(exPath), '拒绝时不得删除损坏的 exclusive 锁');
  // 超 staleMs 才清理继续（now 前推 20min 让 mtime 必定过期，避免依赖真实时间流逝）
  const stale = acquireLock(root2, 'dev', { mode: 'shared', staleMs: 10 * 60_000, now: () => Date.now() + 20 * 60_000 });
  assert.equal(stale.ok, true, '损坏且超 staleMs 的 exclusive 残留应清理后取到 shared');
  assert.ok(existsSync(stale.path), 'shared 锁文件应落盘');
});

test('releaseLock shared：只删本进程的 shared 锁，不动他人', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  acquireLock(root, 'dev', { mode: 'shared', pid: process.pid });
  const minePath = sharedLockPath(root, 'dev', process.pid);
  assert.ok(existsSync(minePath), '释放前本进程 shared 锁存在');
  const otherPath = join(lockDir(root), 'dev.shared-99999999.lock');
  writeFileSync(otherPath, JSON.stringify({ pid: 99999999, ts: Date.now(), serial: 'dev', mode: 'shared' }));
  releaseLock(root, 'dev', { mode: 'shared', pid: process.pid });
  assert.ok(!existsSync(minePath), '本进程 shared 锁须被删除');
  assert.ok(existsSync(otherPath), '他人 shared 锁不得删除');
});

// —— cancelled 终态（Task 1 评审裁定）：SIGINT/SIGTERM 中断时 run 不应留 _partial 残留 ——
test('finish(cancelled)：写终态，覆写增量快照的 _partial 残留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-runs-'));
  const rec = new RunRecorder({ runsDir: root, caseName: 'cases/中断.yaml' });
  // 模拟崩溃安全增量快照：先落一份带 _partial:true 的 running 态
  writeFileSync(rec.jsonPath, JSON.stringify({ runId: rec.runId, status: 'running', _partial: true }));
  const doc = await rec.finish('cancelled', { exitCode: 130 });
  const onDisk = JSON.parse(readFileSync(rec.jsonPath, 'utf8'));
  assert.equal(doc.status, 'cancelled', 'finish 返回 cancelled');
  assert.equal(doc.exitCode, 130);
  assert.equal(onDisk.status, 'cancelled', '落盘为 cancelled 终态');
  assert.equal(onDisk.exitCode, 130);
  assert.equal(onDisk._partial, undefined, '终态不得残留 _partial 标记');
  rmSync(root, { recursive: true, force: true });
});

test('gracefulExit 接线：对 activeRuns 每个 run 调 finish(cancelled)', () => {
  // 守护 gracefulExit 的 cancelled 终态接线（该函数直接 process.exit，无法在单测内调用）：
  // 源码文本断言——遍历 activeRuns 后、device.close 之前，必须用 try/catch 包住
  // run.ctx?.recorder 的 finish('cancelled', { exitCode: 130 })，已 finish 的抛错被忽略。
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ask.js'), 'utf8');
  const g = src.indexOf('async function gracefulExit');
  assert.ok(g > 0, '找到 gracefulExit');
  const body = src.slice(g, src.indexOf('process.once', g));
  const loopAt = body.indexOf('for (const run of activeRuns)');
  const closeAt = body.indexOf('run.device?.close');
  assert.ok(loopAt > 0, '找到 activeRuns 遍历');
  assert.ok(closeAt > loopAt, 'device.close 在遍历之后');
  // 锚点收紧到「循环起点 → device.close」之间，逐项校验接线细节。
  const seg = body.slice(loopAt, closeAt);
  assert.match(seg, /try\s*\{/, 'cancelled 落终态须有 try 包裹');
  assert.match(seg, /\}\s*catch/, 'cancelled 落终态须有 catch 吞掉「不能重复调用」');
  assert.ok(seg.includes('run.ctx?.recorder'), '须对 run.ctx?.recorder 落终态（整串锚点）');
  const finishAt = body.indexOf("finish?.('cancelled', { exitCode: 130 })");
  assert.ok(finishAt > loopAt, 'finish(cancelled) 须落在 activeRuns 遍历内');
  assert.ok(finishAt < closeAt, 'finish 须在 device.close 之前（先落终态再关设备）');
});

// —— I1 守护：cmdAsk 取锁后 fail() 同步退出，finally 不执行，须在 fail 内自行释放 shared 读锁 ——
test('fail 路径释放 shared 读锁：heldSharedLock 登记 + fail 内 releaseLock(mode:shared) 守护', () => {
  // fail() 直接 process.exit，无法在单测内调用（Node 不展开调用栈、finally 不执行），
  // 改以精确源码文本断言 + 代码走查守护：断言必须含 heldSharedLock 与 mode:'shared'，
  // 不能只搜 releaseLock 字样（避免误命中 runOne 的 exclusive 释放）。
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ask.js'), 'utf8');
  // 1) 模块级声明（与 activeRuns/sharedBridgeRef 同处）
  assert.ok(/let\s+heldSharedLock\s*=\s*null/.test(src), '存在模块级 heldSharedLock 声明');
  // 2) cmdAsk 取锁成功后登记 { root, serial }
  const lockAt = src.indexOf("acquireLock(WORKSPACE.lockRoot, serial, { mode: 'shared' })");
  assert.ok(lockAt > 0, '找到 cmdAsk 的 shared 取锁');
  assert.ok(/heldSharedLock\s*=\s*\{\s*root:\s*WORKSPACE\.lockRoot,\s*serial\s*\}/.test(src),
    '取锁成功后须登记 heldSharedLock = { root: WORKSPACE.lockRoot, serial }');
  // 3) cmdAsk 正常 finally 释放后清空
  const finallyAt = src.indexOf("releaseLock(WORKSPACE.lockRoot, serial, { mode: 'shared' });\n    heldSharedLock = null;", lockAt);
  assert.ok(finallyAt > lockAt, 'cmdAsk finally 释放后须清空 heldSharedLock');
  // 4) fail() 函数体内：heldSharedLock 守卫 + releaseLock(shared) 精确调用 + 置空，且都在 process.exit 之前
  const fAt = src.indexOf('function fail(');
  const fEnd = src.indexOf('process.exit(code);', fAt);
  assert.ok(fEnd > fAt, '定位到 fail() 的 process.exit');
  const fBody = src.slice(fAt, fEnd);
  assert.ok(fBody.includes('if (heldSharedLock)'), 'fail 内须有 heldSharedLock 守卫');
  assert.ok(fBody.includes("releaseLock(heldSharedLock.root, heldSharedLock.serial, { mode: 'shared' })"),
    'fail 内须精确调用 releaseLock(..., { mode: \'shared\' }) 释放 shared 读锁');
  assert.ok(fBody.includes('heldSharedLock = null'), 'fail 释放后须清空 heldSharedLock');
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

test('parsePackageVersion：从 dumpsys 文本提取 versionName', async () => {
  const { parsePackageVersion } = await import('../src/cli/pregrant.js');
  assert.equal(parsePackageVersion('versionName=9.31.0\nversionCode=931'), '9.31.0');
  assert.equal(parsePackageVersion('no version here'), null);
});

test('parseArgv：布尔 flag 与可选值 flag 不受影响', () => {
  assert.equal(parseArgv(['run', '--yes']).flags.yes, true);
  assert.equal(parseArgv(['run', '--timeout', '60']).flags.timeout, '60');
  // 可选值 flag（doctor 的"检查默认设备"用法）：裸 --device 为 true
  assert.equal(parseArgv(['doctor', '--device']).flags.device, true);
  assert.equal(parseArgv(['doctor', '--device', 'emulator-5554']).flags.device, 'emulator-5554');
});
