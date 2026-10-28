// state：ResumedActivity 判前台（禁用 mCurrentFocus §5.0.1）/ pidof / 崩溃检测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Adb } from '../src/device/adb.js';
import { parseResumedActivity, foreground, processAlive, assertNoCrash } from '../src/device/state.js';

const DUMPSYS_APP = `
  mCurrentFocus=Window{abc123 u0 null}
  mFocusedApp=AppWindowToken{...}
  mResumedActivity: ActivityRecord{948c168 u0 com.lgdg.fourt/io.dcloud.PandoraEntryActivity t123}
`;
const DUMPSYS_HOME = `
  mResumedActivity: ActivityRecord{7c8d9e0 u0 com.android.launcher3/com.android.launcher3.Launcher t42}
`;

test('parseResumedActivity：解析包名/Activity，无视 mCurrentFocus=null', () => {
  const r = parseResumedActivity(DUMPSYS_APP);
  assert.deepEqual(r, { package: 'com.lgdg.fourt', activity: 'io.dcloud.PandoraEntryActivity', resumedActivity: 'com.lgdg.fourt/io.dcloud.PandoraEntryActivity' });
  const home = parseResumedActivity(DUMPSYS_HOME);
  assert.equal(home.package, 'com.android.launcher3', '按 HOME 后变为 launcher（§5.0.1 实测行为）');
  assert.equal(parseResumedActivity(''), null);
  assert.equal(parseResumedActivity('nothing here'), null);
});

test('foreground：走 dumpsys activity | grep resumedactivity', async () => {
  const cmds = [];
  const adb = new Adb({
    serial: 'test',
    exec: async (args) => {
      if (args.includes('shell')) cmds.push(args.at(-1));
      return { code: 0, stdout: DUMPSYS_APP, stderr: '' };
    },
  });
  const r = await foreground(adb);
  assert.equal(r.package, 'com.lgdg.fourt');
  assert.match(cmds[0], /dumpsys activity activities \| grep/);
  assert.equal(cmds[0].includes('mCurrentFocus'), false, '禁止用 mCurrentFocus 判前台');
});

test('processAlive：pidof 输出含 PID 才算存活', async () => {
  let out = '12345';
  const adb = new Adb({
    serial: 'test',
    exec: async () => ({ code: out ? 0 : 1, stdout: out, stderr: '' }),
  });
  assert.equal(await processAlive(adb, 'com.lgdg.fourt'), true);
  out = '';
  assert.equal(await processAlive(adb, 'com.lgdg.fourt'), false, 'force-stop 后 pidof 为空');
});

test('assertNoCrash：存活+前台一致 / 被杀 / 离开 app 三态', async () => {
  let dumpsys = DUMPSYS_APP;
  let pid = '12345';
  const adb = new Adb({
    serial: 'test',
    exec: async (args) => {
      const joined = args.join(' ');
      // 合并命令（dumpsys+pidof 一条 shell，性能优化）：模拟真实设备把两段输出拼一起
      if (joined.includes('dumpsys') && joined.includes('pidof')) {
        return { code: 0, stdout: `${dumpsys.trim()}\n${pid}\n`, stderr: '' };
      }
      if (joined.includes('pidof')) return { code: pid ? 0 : 1, stdout: pid, stderr: '' };
      return { code: 0, stdout: dumpsys, stderr: '' };
    },
  });
  const ok = await assertNoCrash(adb, 'com.lgdg.fourt');
  assert.deepEqual({ ok: ok.ok, alive: ok.alive, foreground: ok.foreground, error: ok.error }, { ok: true, alive: true, foreground: 'com.lgdg.fourt', error: null });
  pid = '';
  const killed = await assertNoCrash(adb, 'com.lgdg.fourt');
  assert.equal(killed.ok, false);
  assert.equal(killed.alive, false);
  assert.match(killed.error, /进程不存在/);
  pid = '1';
  dumpsys = DUMPSYS_HOME;
  const left = await assertNoCrash(adb, 'com.lgdg.fourt');
  assert.equal(left.ok, false);
  assert.match(left.error, /前台已离开/);
});

test('assertNoCrash：无 expectedPackage 时退化为"当前前台应用存活"，不得拿 null 去 pidof', async () => {
  const pidofs = [];
  let pid = '12345';
  const adb = new Adb({
    serial: 'test',
    exec: async (args) => {
      const joined = args.join(' ');
      if (joined.includes('pidof')) { pidofs.push(joined); return { code: pid ? 0 : 1, stdout: pid, stderr: '' }; }
      return { code: 0, stdout: DUMPSYS_APP, stderr: '' };
    },
  });
  const r = await assertNoCrash(adb, undefined);
  assert.equal(r.ok, true, '前台应用存活即通过');
  assert.equal(r.foreground, 'com.lgdg.fourt');
  assert.ok(pidofs.every((c) => !c.includes('pidof null')), '禁止 pidof null');
  assert.ok(pidofs.some((c) => c.includes('pidof com.lgdg.fourt')), '应按前台包名探测进程');
  pid = '';
  const dead = await assertNoCrash(adb, null);
  assert.equal(dead.ok, false);
  assert.match(dead.error, /进程不存在/);
  assert.match(dead.error, /com\.lgdg\.fourt/, '错误信息里应是解析出的包名而非 null/undefined');
});

test('assertNoCrash：合并 shell 输出含 topResumedActivity= 行时仍解析冒号行（回归）', async () => {
  // 真实设备 grep -iE resumedactivity 会同时命中 topResumedActivity=（等号）与 mResumedActivity:（冒号）；
  // parse 只认冒号形态，合并单条 shell 后必须显式选对行
  const combined = [
    'topResumedActivity=ActivityRecord{aaa u0 com.lgdg.fourt/io.X t1}',
    'mResumedActivity: ActivityRecord{948c168 u0 com.lgdg.fourt/io.dcloud.PandoraEntryActivity t123}',
    '12345',
  ].join('\n');
  const adb = new Adb({ serial: "test", exec: async () => ({ code: 0, stdout: combined, stderr: "" }) });
  const r = await assertNoCrash(adb, "com.lgdg.fourt");
  assert.deepEqual({ ok: r.ok, alive: r.alive, foreground: r.foreground, error: r.error },
    { ok: true, alive: true, foreground: "com.lgdg.fourt", error: null });
});
