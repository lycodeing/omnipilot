// 系统弹窗侦测与自适应关闭（§2.7）单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSystemDialogForeground, detectDialog, dismissDialog, SYSTEM_DIALOG_PACKAGES } from '../src/device/popup.js';

test('isSystemDialogForeground：识别权限/安装器/systemui 弹窗包', () => {
  for (const p of SYSTEM_DIALOG_PACKAGES) assert.equal(isSystemDialogForeground({ package: p }), true, p);
  assert.equal(isSystemDialogForeground({ package: 'com.daimajia.gold' }), false);
  assert.equal(isSystemDialogForeground(null), false);
  assert.equal(isSystemDialogForeground({}), false);
});

test('detectDialog：前台是系统弹窗包 → detected', async () => {
  const device = { foreground: async () => ({ package: 'com.google.android.permissioncontroller', activity: 'x' }) };
  const r = await detectDialog(device);
  assert.equal(r.detected, true);
  assert.equal(r.pkg, 'com.google.android.permissioncontroller');
  assert.equal(r.reason, 'foreground-is-system-dialog');
});

test('detectDialog：前台是目标 App 且无授权按钮 → 不误报', async () => {
  const device = {
    foreground: async () => ({ package: 'com.daimajia.gold', activity: 'Main' }),
    dumpTree: async () => ({ nodes: [{ index: 0, text: '首页', cls: 'T', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 0, 10, 10], children: [] }] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, false);
});

test('detectDialog：前台是目标 App 但屏幕有"允许"按钮 → detected（App 内权限框）', async () => {
  const device = {
    foreground: async () => ({ package: 'com.daimajia.gold', activity: 'Main' }),
    dumpTree: async () => ({ nodes: [{ index: 0, text: '允许', cls: 'Button', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 0, 10, 10], children: [] }] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, true);
  assert.equal(r.reason, 'allow-button-visible');
});

test('dismissDialog：按优先级点"允许"（先于"确定"）；不点"拒绝"', async () => {
  const clicked = [];
  const device = {
    foreground: async () => ({ package: 'com.google.android.permissioncontroller', activity: 'GrantPermissionsActivity' }),
    dumpTree: async () => ({ nodes: [
      { index: 0, text: '拒绝', cls: 'Button', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 0, 10, 10], children: [] },
      { index: 1, text: '确定', cls: 'Button', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 10, 10, 20], children: [] },
      { index: 2, text: '允许', cls: 'Button', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 20, 10, 30], children: [] },
    ] }),
    locate: async (t) => (t === '允许' ? { ok: true, bounds: [0, 20, 10, 30], strategy: 'exact_text' } : { ok: false, bounds: null }),
    tap: async (b) => { clicked.push(b); return { ok: true }; },
    waitIdle: async () => ({ stable: true }),
  };
  const r = await dismissDialog(device);
  assert.equal(r.ok, true);
  assert.equal(r.clicked, '允许');
  assert.deepEqual(clicked, [[0, 20, 10, 30]]);
});

test('dismissDialog：无匹配按钮 → 兜底 back 键（不点"拒绝"）', async () => {
  let keyed = null;
  const device = {
    foreground: async () => ({ package: 'com.google.android.permissioncontroller', activity: 'x' }),
    dumpTree: async () => ({ nodes: [] }),
    locate: async () => ({ ok: false, bounds: null }),
    key: async (n) => { keyed = n; return { ok: true }; },
    waitIdle: async () => ({ stable: true }),
  };
  const r = await dismissDialog(device);
  assert.equal(r.ok, true);
  assert.equal(keyed, 'back');
  assert.equal(r.clicked, 'back');
});

test('dismissDialog：tap 失败 → 继续试下一个候选', async () => {
  const device = {
    foreground: async () => ({ package: 'com.google.android.permissioncontroller', activity: 'x' }),
    dumpTree: async () => ({ nodes: [] }),
    locate: async (t) => (t === '始终允许' ? { ok: true, bounds: [0, 0, 1, 1] } : (t === '允许' ? { ok: true, bounds: [0, 2, 1, 3] } : { ok: false, bounds: null })),
    tap: async (b) => (b[1] === 0 ? { ok: false, error: 'boom' } : { ok: true }),
    key: async () => ({ ok: true }),
    waitIdle: async () => ({ stable: true }),
  };
  const r = await dismissDialog(device);
  assert.equal(r.ok, true);
  assert.equal(r.clicked, '允许', '第一个候选 tap 失败应继续下一个');
});
