// 工作区解析单测（src/cli/workspace.js）：运行时产物与源码分离的路径规则
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace, ensureWorkspace, formatDate, DEFAULT_INSTANCE, pickDefaultHome } from '../src/cli/workspace.js';

test('formatDate：YYYY-MM-DD 零填充', () => {
  assert.equal(formatDate(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(formatDate(new Date(2026, 9, 27)), '2026-10-27');
});

test('resolveWorkspace：显式 home/date/instance → <home>/<date>/<instance> 各子目录', () => {
  const ws = resolveWorkspace({ home: '/base', date: '2026-10-27', instance: 'instance', env: {} });
  assert.equal(ws.root, join('/base', '2026-10-27', 'instance'));
  assert.equal(ws.caseDir, join(ws.root, 'case'));
  assert.equal(ws.runDir, join(ws.root, 'run'));
  assert.equal(ws.reportDir, join(ws.root, 'report'));
  assert.equal(ws.datasetDir, join(ws.root, 'dataset'));
  assert.equal(ws.stateDir, join(ws.root, '.ask'));
});

test('resolveWorkspace：锁与 probe 缓存落全局（跨实例共享，锁才有效）', () => {
  const ws = resolveWorkspace({ home: '/base', date: 'd1', instance: 'i1', env: {} });
  const ws2 = resolveWorkspace({ home: '/base', date: 'd2', instance: 'i2', env: {} });
  assert.equal(ws.lockRoot, '/base');
  assert.equal(ws2.lockRoot, '/base', '不同实例的锁根相同（否则锁失效）');
  assert.equal(ws.probeFile, join('/base', '.ask', 'family-probe.json'));
  assert.equal(ws2.probeFile, ws.probeFile, 'probe 缓存全局复用');
});

test('resolveWorkspace：环境变量覆盖（ASK_HOME/ASK_DATE/ASK_INSTANCE）', () => {
  const ws = resolveWorkspace({ env: { ASK_HOME: '/h', ASK_DATE: '2020-01-01', ASK_INSTANCE: 'ci' } });
  assert.equal(ws.root, join('/h', '2020-01-01', 'ci'));
  assert.equal(ws.instance, 'ci');
});

test('resolveWorkspace：ASK_WORKSPACE 直接钉死整个 instance 目录', () => {
  // 路径用平台无关的绝对路径（path.resolve 会在 win32 上把 C:/tmp/ws 也解析成绝对路径）
  const ws = resolveWorkspace({ env: { ASK_WORKSPACE: '/tmp/ws', ASK_HOME: '/ignored' } });
  assert.equal(ws.root, '/tmp/ws');
  assert.equal(ws.runDir, join('/tmp/ws', 'run'));
  assert.equal(ws.lockRoot, '/ignored', '锁根仍用 ASK_HOME（全局）');
});

test('resolveWorkspace：默认实例名为 instance', () => {
  const ws = resolveWorkspace({ home: '/base', date: '2026-10-27', env: {} });
  assert.equal(ws.instance, DEFAULT_INSTANCE);
});

test('ensureWorkspace：幂等创建所有子目录（含全局锁目录）', () => {
  const base = mkdtempSync(join(tmpdir(), 'ask-ws-'));
  const ws = resolveWorkspace({ home: base, date: '2026-10-27', instance: 'instance', env: {} });
  ensureWorkspace(ws);
  for (const d of [ws.caseDir, ws.runDir, ws.reportDir, ws.datasetDir, ws.stateDir, join(ws.lockRoot, '.ask', 'locks')]) {
    assert.ok(existsSync(d), `应创建 ${d}`);
  }
  ensureWorkspace(ws); // 再调一次不抛错
});

// ---- pickDefaultHome：默认工作区探测（含更名兼容） ----

// 构造一个"哪些路径存在"的假文件系统
const fsStub = (existing) => (p) => existing.includes(p);

test('pickDefaultHome：win32 优先用当前目录名 C:/opt/omni-pilot', () => {
  const home = pickDefaultHome({
    platform: 'win32',
    env: { HOME: '/h' },
    existsSync: fsStub(['C:/opt/omni-pilot']),
  });
  assert.equal(home, 'C:/opt/omni-pilot');
});

test('pickDefaultHome：win32 当前名不存在时回落更名前的历史工作区（兼容老用户）', () => {
  // 老用户机器上只有 C:/opt/scene-kit——必须继续沿用，否则历史 run / 设备锁 / probe 缓存失联
  const home = pickDefaultHome({
    platform: 'win32',
    env: { HOME: '/h' },
    existsSync: fsStub(['C:/opt/scene-kit']),
  });
  assert.equal(home, 'C:/opt/scene-kit');
});

test('pickDefaultHome：win32 两个目录都不存在时回退用户目录', () => {
  const home = pickDefaultHome({
    platform: 'win32',
    env: { HOME: '/h', USERPROFILE: '/h' },
    existsSync: fsStub([]),
  });
  assert.equal(home, join('/h', '.local', 'share', 'omni-pilot'));
});

test('pickDefaultHome：win32 当前名与历史名同时存在时用当前名', () => {
  const home = pickDefaultHome({
    platform: 'win32',
    env: { HOME: '/h' },
    existsSync: fsStub(['C:/opt/omni-pilot', 'C:/opt/scene-kit']),
  });
  assert.equal(home, 'C:/opt/omni-pilot', '新目录优先');
});

test('pickDefaultHome：unix 当前名不可用时回落历史工作区', () => {
  // /opt 不可写（无 root 权限）时，若历史目录存在则继续沿用
  const home = pickDefaultHome({
    platform: 'darwin',
    env: { HOME: '/h' },
    existsSync: fsStub(['/opt/scene-kit']),
  });
  assert.equal(home, '/opt/scene-kit');
});

test('pickDefaultHome：unix 无任何可用目录时回退用户目录', () => {
  const home = pickDefaultHome({
    platform: 'linux',
    env: { HOME: '/h' },
    existsSync: fsStub([]),
  });
  assert.equal(home, join('/h', '.local', 'share', 'omni-pilot'));
});
