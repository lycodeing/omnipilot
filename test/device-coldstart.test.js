// 回归（2026-10-27 缺陷 #11）：冷启动期 wm size 不可用导致整个 run 被判 error
//
// 现象：8 槽并发冷启动时 7 条用例齐刷刷停在 wm size 探测。根因不是超时/并发竞争，而是：
//   1. locate.js 的 getSize() 在 try 外 → 异常逃出 locate → 工具上抛 → run 步骤级 catch → status=error + break
//   2. withRecording 把工具异常 throw e 上抛，一个瞬时错误杀死整个 run
//   3. getSize() 无退避/负缓存：每失败一次，后续每个工具都立刻重撞
//   4. screen.js 把"服务未就绪"误报成"解析失败"，误导排查
//   5. createDevice 从不等待设备系统服务就绪（无 boot_completed / wm size 就绪判定）
// 本测试用注入 executor 复现冷启动窗口，逐项钉死修复后的行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDeviceWithExecutor } from '../src/device/index.js';
import { isDeviceNotReady, ScreenSizeError, parseWmSize } from '../src/device/screen.js';
import { buildTools } from '../src/tools/index.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/ui-dump.xml', import.meta.url)), 'utf8');

// 冷启动模拟：wm size 前 failTimes 次失败（服务未就绪），之后正常
function makeColdExec({ failTimes = 2, wmOutput = 'Physical size: 720x1280' } = {}) {
  const calls = [];
  let wmCalls = 0;
  const exec = async (args) => {
    const joined = args.join(' ');
    calls.push(joined);
    if (joined.includes('get-state')) return { code: 0, stdout: 'device', stderr: '' };
    if (joined.includes('wm size')) {
      wmCalls++;
      if (wmCalls <= failTimes) return { code: 0, stdout: '', stderr: '' }; // 冷启动：空输出
      return { code: 0, stdout: wmOutput, stderr: '' };
    }
    if (joined.includes('uiautomator dump')) return { code: 0, stdout: FIXTURE, stderr: '' };
    if (joined.includes('screencap')) return { code: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]), stderr: '' };
    if (joined.includes('pidof')) return { code: 0, stdout: '123', stderr: '' };
    if (joined.includes('dumpsys')) return { code: 0, stdout: 'mResumedActivity: ActivityRecord{a u0 com.demo/.Main t1}', stderr: '' };
    if (joined.includes('getprop')) return { code: 0, stdout: '1', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  exec.calls = calls;
  exec.wmCalls = () => wmCalls;
  return exec;
}

// 设备永久不就绪：wm size 始终无有效输出
function makeNeverReadyExec() {
  const calls = [];
  const exec = async (args) => {
    const joined = args.join(' ');
    calls.push(joined);
    if (joined.includes('get-state')) return { code: 0, stdout: 'device', stderr: '' };
    if (joined.includes('wm size')) return { code: 0, stdout: 'error: service not ready', stderr: '' };
    if (joined.includes('uiautomator dump')) return { code: 0, stdout: FIXTURE, stderr: '' };
    if (joined.includes('screencap')) return { code: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]), stderr: '' };
    if (joined.includes('getprop')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

// 夹具里真实存在的可点文本（用于让 locate 走到"找到目标"分支）
const TARGET_IN_FIXTURE = '电子相册';

test('screen：区分"设备未就绪"与"解析失败"（isDeviceNotReady + ScreenSizeError.notReady）', () => {
  assert.equal(isDeviceNotReady(''), true, '空输出 = 未就绪');
  assert.equal(isDeviceNotReady('error: service not ready'), true);
  assert.equal(isDeviceNotReady('/system/bin/sh: wm: inaccessible or not found'), true);
  assert.equal(isDeviceNotReady('Physical size: 1080x2400'), false);
  assert.deepEqual(parseWmSize('Physical size: 1080x2400'), { w: 1080, h: 2400 });
  const e = new ScreenSizeError('设备未就绪', { notReady: true });
  assert.equal(e.notReady, true);
  assert.equal(e.name, 'ScreenSizeError');
});

test('locate：wm size 冷启动失败时不抛异常，返回结构化结果（缺陷 #11 主路径）', async () => {
  const exec = makeNeverReadyExec(); // wm size 始终失败
  const dev = await createDeviceWithExecutor({ serial: 'cold', exec });
  let threw = false;
  let res;
  try {
    res = await dev.locate(TARGET_IN_FIXTURE);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '【关键】locate 不得抛异常（曾导致 run 被判 error）');
  assert.equal(res.ok, false);
  assert.match(res.error, /设备未就绪|屏幕尺寸/, '错误信息应指向设备未就绪而非笼统解析失败');
  await dev.close();
});

test('locate：冷启动窗口内重试后成功（getSize 退避重试）', async () => {
  // 前 2 次 wm size 失败，第 3 次成功（getSize attempts=3）→ 应跨过窗口并正常完成定位
  const exec = makeColdExec({ failTimes: 2 });
  const dev = await createDeviceWithExecutor({ serial: 'cold', exec });
  const res = await dev.locate(TARGET_IN_FIXTURE);
  assert.equal(res.ok, true, '退避重试应跨过冷启动窗口并定位成功');
  assert.ok(res.bounds, '应返回 bounds');
  await dev.close();
});

test('getSize：负缓存冷却——持续失败时不无限重撞设备', async () => {
  const exec = makeNeverReadyExec();
  const dev = await createDeviceWithExecutor({ serial: 'cold', exec });
  const before = exec.calls.filter((c) => c.includes('wm size')).length;
  await dev.locate('text=a');
  await dev.locate('text=b');
  await dev.locate('text=c');
  const after = exec.calls.filter((c) => c.includes('wm size')).length;
  // 首次调用会重试 attempts 次；后续两次应在冷却期内立刻失败，不再打设备
  assert.ok(after - before <= 3, `冷却期内不应反复探测（实际多打 ${after - before} 次）`);
  await dev.close();
});

test('scroll：wm size 失败时抛错（形状守契约），工具层转 ok:false 不上抛', async () => {
  const exec = makeNeverReadyExec();
  const dev = await createDeviceWithExecutor({ serial: 'cold', exec });
  // 底层 scroll 抛错（形状仍是契约 { scrolls, changed }，不新增字段）
  await assert.rejects(() => dev.scroll('up'), /设备未就绪|屏幕尺寸/);
  await dev.close();
});

test('screencap：size 探测失败不阻断截图（size 降级为 null）', async () => {
  const exec = makeNeverReadyExec();
  const dev = await createDeviceWithExecutor({ serial: 'cold', exec });
  const r = await dev.screencap();
  assert.equal(r.size, null, 'size 拿不到应为 null，而不是抛错');
  assert.ok(r.buffer.length > 0, '截图本身仍应返回');
  await dev.close();
});

test('工具层：设备未就绪时 scroll 工具返回 ok:false 而非抛异常（withRecording 兜底）', async () => {
  const exec = makeNeverReadyExec();
  const dev = await createDeviceWithExecutor({ serial: 'cold', exec });
  const ctx = { device: dev, opts: { yes: true } }; // 无 recorder → 直接用原工具
  const tools = buildTools(ctx);
  const scroll = tools.find((t) => t.name === 'scroll');
  let threw = false;
  let res;
  try {
    res = await scroll.execute('id', { direction: 'up' }, null, null, null);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '工具不得上抛（上抛会杀死整个 run）');
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, false);
  await dev.close();
});

test('withRecording：工具异常被转为结构化失败返回（不再 throw e 上抛）', async () => {
  const { withRecording } = await import('../src/tools/index.js');
  const steps = [];
  const fakeRecorder = {
    startStep: () => ({ index: steps.length, end: (o) => steps.push(o) }),
    attachScreenshot: () => {},
  };
  const boomTool = {
    name: 'boom',
    execute: async () => { throw new Error('冷启动期瞬时故障'); },
  };
  const wrapped = withRecording(boomTool, { recorder: fakeRecorder, secretCalls: [], device: {} });
  let threw = false;
  let res;
  try {
    res = await wrapped.execute('id', {}, null, null, null);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '【关键】包装层不得上抛异常');
  assert.equal(res.details.ok, false);
  assert.equal(res.details.thrown, true);
  assert.match(res.details.error, /冷启动期瞬时故障/);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].result, 'error');
});

test('waitForBoot：设备未就绪时超时返回 ready:false（不抛错）', async () => {
  const { Adb } = await import('../src/device/adb.js');
  const adb = new Adb({
    serial: 'cold',
    timeouts: { command: 500 },
    exec: async (args) => {
      const j = args.join(' ');
      if (j.includes('getprop')) return { code: 0, stdout: '', stderr: '' };
      if (j.includes('wm size')) return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const r = await adb.waitForBoot({ timeoutMs: 700, intervalMs: 100 });
  assert.equal(r.ready, false);
  assert.match(r.reason, /超时/);
});

test('waitForBoot：boot_completed=1 且 wm size 可读 → ready:true', async () => {
  const { Adb } = await import('../src/device/adb.js');
  const adb = new Adb({
    serial: 'ok',
    timeouts: { command: 500 },
    exec: async (args) => {
      const j = args.join(' ');
      if (j.includes('getprop')) return { code: 0, stdout: '1', stderr: '' };
      if (j.includes('wm size')) return { code: 0, stdout: 'Physical size: 1080x2400', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const r = await adb.waitForBoot({ timeoutMs: 2000, intervalMs: 100 });
  assert.equal(r.ready, true);
});

test('createDevice：注入 exec 时默认跳过就绪等待（测试不被 60s 阻塞）', async () => {
  const exec = makeColdExec({ failTimes: 0 });
  const t0 = Date.now();
  const dev = await createDeviceWithExecutor({ serial: 'test', exec });
  assert.ok(Date.now() - t0 < 3000, '注入 exec 时不应等待 boot');
  await dev.close();
});
