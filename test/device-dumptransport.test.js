// 回归（2026-10-27 真机验证发现）：dump/screencap 的 adb 传输通道钉死
//   - `adb shell uiautomator dump /dev/tty` 在新版 platform-tools 上 stdout 只有提示行，XML 须走
//     `adb exec-out uiautomator dump /dev/tty`；exec-out 失败或返回不含 </hierarchy> 时回退 legacy shell
//   - screencap 必须走 exec-out 传输：`adb -s X screencap -p` 会报 unknown command（adb.exe 无此子命令）
//   - dumpToFile 不得把非 XML 内容静默落盘
//   - 2026-10-31：新增设备侧 timeout 包裹（防 busy 弹窗态孤儿锁）+ file&&cat 第三通道（tty
//     在 busy 态只回提示行时，file 形式等满 idle 可用，实测 38s）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDeviceWithExecutor } from '../src/device/index.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/ui-dump.xml', import.meta.url)), 'utf8');
const STATUS_LINE_ONLY = 'UI hierchary dumped to: /dev/tty\n';

// 假 adb 执行器：按传输通道分别可编程
function makeExec({ execOutDump = FIXTURE, shellDump = FIXTURE, execOutDumpThrows = false } = {}) {
  const calls = [];
  const exec = async (args) => {
    const joined = args.join(' ');
    calls.push(joined);
    if (joined.includes('get-state')) return { code: 0, stdout: 'device', stderr: '' };
    if (joined.includes('wm size')) return { code: 0, stdout: 'Physical size: 720x1280', stderr: '' };
    // 设备侧 timeout 探测（dumpXmlRaw 首次调用时探一次）
    if (joined.includes('which timeout')) return { code: 0, stdout: '/system/bin/timeout\n', stderr: '' };
    if (/exec-out timeout 10 uiautomator dump/.test(joined)) {
      if (execOutDumpThrows) throw new Error('adb exec-out 失败(exit 1): mock');
      return { code: 0, stdout: execOutDump, stderr: '' };
    }
    if (/shell timeout 10 uiautomator dump/.test(joined)) return { code: 0, stdout: shellDump, stderr: '' };
    if (/timeout 50 uiautomator dump \/sdcard/.test(joined)) return { code: 0, stdout: shellDump, stderr: '' };
    if (/exec-out screencap/.test(joined)) {
      return { code: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

test('dumpTree：走 exec-out 通道，且不触发 legacy shell 回退', async () => {
  const exec = makeExec();
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.dumpTree({ fresh: true });
  assert.ok(r.nodes.length > 0);
  assert.ok(exec.calls.some((c) => /exec-out timeout 10 uiautomator dump/.test(c)), '应有 exec-out dump 调用');
  assert.ok(!exec.calls.some((c) => /shell timeout 10 uiautomator dump/.test(c)), 'exec-out 成功时不应回退 legacy shell');
  assert.ok(!exec.calls.some((c) => /timeout 50 uiautomator dump/.test(c)), 'exec-out 成功时不应落到 file 通道');
  await device.close();
});

test('dumpTree：exec-out 抛错时回退 legacy shell', async () => {
  const exec = makeExec({ execOutDumpThrows: true });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.dumpTree({ fresh: true });
  assert.ok(r.nodes.length > 0);
  assert.ok(exec.calls.some((c) => /shell timeout 10 uiautomator dump/.test(c)), '应回退 legacy shell');
  await device.close();
});

test('dumpTree：exec-out 返回纯提示行（无 XML）时同样回退 legacy shell', async () => {
  const exec = makeExec({ execOutDump: STATUS_LINE_ONLY });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.dumpTree({ fresh: true });
  assert.ok(r.nodes.length > 0);
  assert.ok(exec.calls.some((c) => /shell timeout 10 uiautomator dump/.test(c)), '空响应应触发回退');
  await device.close();
});

test('screencap：走 exec-out 传输（裸 screencap 会报 unknown command）', async () => {
  const exec = makeExec();
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const { buffer } = await device.screencap();
  assert.equal(buffer.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(exec.calls.some((c) => /exec-out screencap/.test(c)), '应有 exec-out screencap 调用');
  assert.ok(!exec.calls.some((c) => /-s test screencap/.test(c) && !/exec-out/.test(c)), '不允许裸 screencap 命令');
  await device.close();
});

test('dumpToFile：双通道都无 XML 时抛错且不落盘', async () => {
  const exec = makeExec({ execOutDump: STATUS_LINE_ONLY, shellDump: STATUS_LINE_ONLY });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const dir = mkdtempSync(join(tmpdir(), 'ask-dump-'));
  const target = join(dir, 'forensic.xml');
  await assert.rejects(() => device.dumpToFile(target));
  assert.ok(!existsSync(target), '失败 dump 不应写文件');
  await device.close();
});
