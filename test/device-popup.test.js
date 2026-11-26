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
test('detectDialog：树根 pkg 派生前台，不再付 dumpsys 往返（性能）', async () => {
  let fgCalls = 0;
  const device = {
    foreground: async () => { fgCalls++; return { package: 'com.google.android.permissioncontroller' }; },
    dumpTree: async () => ({ nodes: [{ index: 0, text: '', cls: 'Frame', pkg: 'com.daimajia.gold', resourceId: '', contentDesc: '', clickable: false, bounds: [0,0,10,10], children: [] }] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, false, '树根 pkg 是目标 App，不应误判系统弹窗');
  assert.equal(fgCalls, 0, '有树 pkg 时不应调用 foreground（省一次 dumpsys）');
});

test('detectDialog：树根 pkg 是系统弹窗包 → 从树即可判弹窗（无需 dumpsys）', async () => {
  let fgCalls = 0;
  const device = {
    foreground: async () => { fgCalls++; return { package: 'com.daimajia.gold' }; },
    dumpTree: async () => ({ nodes: [{ index: 0, text: '', cls: 'Frame', pkg: 'com.google.android.permissioncontroller', resourceId: '', contentDesc: '', clickable: false, bounds: [0,0,10,10], children: [] }] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, true);
  assert.equal(r.reason, 'foreground-is-system-dialog');
  assert.equal(fgCalls, 0);
});

// —— 弹窗族 registry：locale 文案包 + 复合判据 ——
// 守护：词表按 locale 分包（英文设备也命中），内嵌检测须复合可点击判据，避免把
// "您需同意…"静态文案/合法协议页误判成权限框自动点掉。
import { POPUP_WORD_PACKS, resolvePopupTexts } from '../src/device/popup.js';

test('resolvePopupTexts：完整 tag / 语言前缀 / 未识别 locale 并集兜底', () => {
  assert.equal(resolvePopupTexts('zh-CN'), POPUP_WORD_PACKS.zh);
  assert.equal(resolvePopupTexts('zh_CN'), POPUP_WORD_PACKS.zh);
  assert.equal(resolvePopupTexts('en-US'), POPUP_WORD_PACKS.en);
  assert.equal(resolvePopupTexts('en'), POPUP_WORD_PACKS.en);
  // 未识别 locale：全部包并集（宁可多候选，不可静默全盲），zh 在前保持历史优先序
  const fr = resolvePopupTexts('fr-FR');
  assert.ok(fr.allowTexts.includes('允许') && fr.allowTexts.includes('Allow'));
  assert.ok(fr.allowTexts.indexOf('允许') < fr.allowTexts.indexOf('Allow'));
  const empty = resolvePopupTexts('');
  assert.ok(empty.detectTexts.length >= POPUP_WORD_PACKS.zh.detectTexts.length + POPUP_WORD_PACKS.en.detectTexts.length);
});

test('词表包纪律：detectTexts ⊆ allowTexts（检测子集必可点）且不含泛化确认词', () => {
  for (const [lang, p] of Object.entries(POPUP_WORD_PACKS)) {
    for (const d of p.detectTexts) {
      assert.ok(p.allowTexts.includes(d), `${lang}.detectTexts "${d}" 不在 allowTexts 中`);
    }
    // '确定/OK/继续' 是普通 App 按钮常见文案，进 detect 会把协议页/支付确认误判为权限框
    assert.ok(!p.detectTexts.some((t) => ['确定', '知道了', '好的', 'OK', 'Continue', 'Got it'].includes(t)), `${lang}.detectTexts 混入泛化确认词`);
  }
});

test('detectDialog：en 设备（getProp）识别英文权限框；zh 文案在 en 包下不误报', async () => {
  const device = {
    getProp: async (n) => (n === 'persist.sys.locale' ? 'en-US' : ''),
    foreground: async () => ({ package: 'com.daimajia.gold', activity: 'Main' }),
    dumpTree: async () => ({ nodes: [{ index: 0, text: 'Allow', cls: 'Button', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 0, 10, 10], children: [] }] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, true);
  assert.equal(r.reason, 'allow-button-visible');

  const zhOnly = {
    getProp: async () => 'en-US',
    foreground: async () => ({ package: 'com.daimajia.gold', activity: 'Main' }),
    dumpTree: async () => ({ nodes: [{ index: 0, text: '允许', cls: 'Button', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 0, 10, 10], children: [] }] }),
  };
  const r2 = await detectDialog(zhOnly);
  assert.equal(r2.detected, false, 'en locale 下 zh 文案不应触发内嵌检测');
});

test('复合判据：不可点链上的权限文案（静态段落/协议页）不再误报', async () => {
  const device = {
    foreground: async () => ({ package: 'com.daimajia.gold', activity: 'Main' }),
    dumpTree: async () => ({ nodes: [{
      index: 0, text: '', cls: 'TextView', resourceId: '', contentDesc: '', clickable: false, bounds: [0, 0, 10, 10],
      children: [{ index: 1, text: '您需要同意隐私政策后才能继续使用', cls: 'TextView', resourceId: '', contentDesc: '', clickable: false, bounds: [0, 0, 10, 10], children: [] }],
    }] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, false, '纯文案（整链不可点）不应判为权限框');
});

test('复合判据：叶子不可点但祖先可点（WebView 常态）仍可检出', async () => {
  const device = {
    foreground: async () => ({ package: 'com.daimajia.gold', activity: 'Main' }),
    dumpTree: async () => ({ nodes: [{
      index: 0, text: '', cls: 'View', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 0, 10, 10],
      children: [{ index: 1, text: '允许', cls: 'TextView', resourceId: '', contentDesc: '', clickable: false, bounds: [0, 0, 10, 10], children: [] }],
    }] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, true);
});

test('ASK_POPUP_LOCALE 覆盖：跳过 getprop，强制指定词表', async () => {
  process.env.ASK_POPUP_LOCALE = 'en';
  try {
    const device = {
      // 故意不实现 getProp：覆盖生效时不应尝试读取
      foreground: async () => ({ package: 'com.daimajia.gold', activity: 'Main' }),
      dumpTree: async () => ({ nodes: [{ index: 0, text: 'Allow', cls: 'Button', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 0, 10, 10], children: [] }] }),
    };
    const r = await detectDialog(device);
    assert.equal(r.detected, true);
  } finally {
    delete process.env.ASK_POPUP_LOCALE;
  }
});

test('dismissDialog：en 设备按 en 包点按（优先长语）', async () => {
  const clicked = [];
  const device = {
    getProp: async () => 'en-US',
    foreground: async () => ({ package: 'com.google.android.permissioncontroller', activity: 'x' }),
    dumpTree: async () => ({ nodes: [] }),
    locate: async (t) => (t === 'Allow only while using the app' || t === 'Allow'
      ? { ok: true, bounds: [0, 0, 10, 10] } : { ok: false, bounds: null }),
    tap: async (b) => { clicked.push(b); return { ok: true }; },
    waitIdle: async () => ({ stable: true }),
  };
  const r = await dismissDialog(device);
  assert.equal(r.ok, true);
  assert.equal(r.clicked, 'Allow only while using the app', '长语优先（对齐 zh 包 始终允许>允许 的语义）');
  assert.equal(clicked.length, 1);
});

test('detectDialog：多窗口树（应用 + 权限弹窗）应识别出系统弹窗', async () => {
  // 守护：uiautomator dump 每窗口一个根，权限弹窗叠在应用上时解析出两个根，
  // 须识别出"前台是系统弹窗"（不能只认 nodes[0] 底层应用窗口）。
  const device = {
    foreground: async () => ({ package: 'com.daimajia.gold' }),
    dumpTree: async () => ({ nodes: [
      { index: 0, text: '', cls: 'Frame', pkg: 'com.daimajia.gold', resourceId: '', contentDesc: '', clickable: false, bounds: [0,0,10,10], children: [] },
      { index: 1, text: '', cls: 'Frame', pkg: 'com.google.android.permissioncontroller', resourceId: '', contentDesc: '', clickable: false, bounds: [0,0,10,10], children: [] },
    ] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, true, '多窗口时应识别出系统弹窗');
  assert.equal(r.reason, 'foreground-is-system-dialog');
});

test('detectDialog：systemui 常驻窗口根不误判为系统弹窗', async () => {
  // 守护：uiautomator dump 的多根来自多窗口，systemui（状态栏/导航栏）是
  // **常驻**窗口，App 前台时也会作为根出现；不能把任一系统包根判为弹窗而误按 back。
  const device = {
    foreground: async () => ({ package: 'com.daimajia.gold' }),
    dumpTree: async () => ({ nodes: [
      { index: 0, text: '', cls: 'Frame', pkg: 'com.daimajia.gold', resourceId: '', contentDesc: '', clickable: false, bounds: [0,0,10,10], children: [] },
      { index: 1, text: '', cls: 'Frame', pkg: 'com.android.systemui', resourceId: '', contentDesc: '', clickable: false, bounds: [0,0,10,10], children: [] },
    ] }),
  };
  const r = await detectDialog(device);
  assert.notEqual(r.reason, 'foreground-is-system-dialog', 'systemui 常驻窗口不应被判为弹窗');
});

test('detectDialog：权限控制器根仍正确判为系统弹窗', async () => {
  const device = {
    foreground: async () => ({ package: 'com.daimajia.gold' }),
    dumpTree: async () => ({ nodes: [
      { index: 0, text: '', cls: 'Frame', pkg: 'com.daimajia.gold', resourceId: '', contentDesc: '', clickable: false, bounds: [0,0,10,10], children: [] },
      { index: 1, text: '', cls: 'Frame', pkg: 'com.android.permissioncontroller', resourceId: '', contentDesc: '', clickable: false, bounds: [0,0,10,10], children: [] },
    ] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, true, '权限弹窗根应被识别');
  assert.equal(r.reason, 'foreground-is-system-dialog');
});
