// 门面 createDevice（契约 §1.1）：缓存流 / 动作置脏 / yadb 输入序列 / 环境查询 / 取证（注入假 adb 执行器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDeviceWithExecutor } from '../src/device/index.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/ui-dump.xml', import.meta.url)), 'utf8');
// 树内容变体 B：根下多一个节点 → hash 变化
const FIXTURE_B = FIXTURE.replace(
  '</hierarchy>',
  '  <node index="9" text="变动" resource-id="com.lgdg:id/extra" class="android.widget.TextView" clickable="false" bounds="[0,1260][720,1280]"/>\n</hierarchy>'
);
// 输入回读变体：输入框已有文字
const FIXTURE_INPUT = FIXTURE.replace('<node index="2" text="" resource-id="com.lgdg:id/search_input"', '<node index="2" text="中文测试" resource-id="com.lgdg:id/search_input"');

const DUMPSYS = '  mResumedActivity: ActivityRecord{948c168 u0 com.lgdg.fourt/io.dcloud.PandoraEntryActivity t123}\n';

// 按子命令路由的假 adb 执行器
function makeExec({ dumpScript = null } = {}) {
  const calls = [];
  let dumpIdx = 0;
  const exec = async (args) => {
    const joined = args.join(' ');
    calls.push(joined);
    if (joined.includes('get-state')) return { code: 0, stdout: 'device', stderr: '' };
    if (joined.includes('wm size')) return { code: 0, stdout: 'Physical size: 720x1280', stderr: '' };
    if (joined.includes('screencap')) return { code: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]), stderr: '' };
    if (joined.includes('uiautomator dump')) {
      const xml = dumpScript ? (dumpIdx < dumpScript.length ? dumpScript[dumpIdx++] : dumpScript.at(-1)) : FIXTURE;
      if (xml === '__FAIL__') return { code: 1, stdout: '', stderr: 'could not get idle state' };
      return { code: 0, stdout: `${xml}\nUI hierchary dumped to: /dev/tty\n`, stderr: '' };
    }
    if (joined.includes('pidof com.lgdg.fourt')) return { code: 0, stdout: '12345', stderr: '' };
    if (joined.includes('pidof')) return { code: 1, stdout: '', stderr: '' };
    if (joined.includes('dumpsys activity')) return { code: 0, stdout: DUMPSYS, stderr: '' };
    if (joined.includes('input ')) return { code: 0, stdout: '', stderr: '' };
    if (joined.includes('monkey -p') || joined.includes('am start')) return { code: 0, stdout: 'Events injected: 1', stderr: '' };
    if (joined.includes('am force-stop')) return { code: 0, stdout: '', stderr: '' };
    if (joined.includes('net status')) return { code: 0, stdout: 'current: off', stderr: '' };
    if (joined.includes('net ')) return { code: 0, stdout: 'Profile set: 4g', stderr: '' };
    if (joined.includes('ls /data/local/tmp/yadb')) return { code: 0, stdout: '/data/local/tmp/yadb\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

const makeDevice = (opts) => createDeviceWithExecutor({ serial: 'test', exec: makeExec(opts) });

test('契约形状：createDevice 返回对象逐方法齐备', async () => {
  const device = await makeDevice();
  const required = [
    'screencap', 'dumpTree', 'locate', 'readText', 'screenDiffHash',
    'tap', 'longPress', 'inputText', 'swipe', 'scroll', 'key', 'launch', 'terminate',
    'foreground', 'screenSize', 'processAlive', 'waitIdle', 'assertNoCrash',
    'netSetProfile', 'netStatus', 'markDirty', 'invalidateCache', 'cacheStats',
    'dumpToFile', 'close',
  ];
  for (const m of required) assert.equal(typeof device[m], 'function', `缺少方法 ${m}`);
  await device.close();
});

test('dumpTree：首次 dump，缓存命中 fromCache=true + dumpMs=0（§5.0）', async () => {
  const device = await makeDevice();
  const r1 = await device.dumpTree();
  assert.equal(r1.fromCache, false);
  assert.ok(r1.dumpMs >= 0);
  assert.equal(r1.nodes.length, 1);
  assert.equal(r1.hash.length, 16);
  const r2 = await device.dumpTree();
  assert.equal(r2.fromCache, true);
  assert.equal(r2.dumpMs, 0);
  assert.equal(r2.hash, r1.hash);
  const stats = device.cacheStats();
  assert.ok(stats.dumps >= 1 && stats.hits === 1 && stats.misses === 1);
  await device.close();
});

test('dumpTree({fresh:true}) 强制重 dump；screenDiffHash 用树 hash', async () => {
  const device = await makeDevice();
  const h1 = await device.screenDiffHash();
  const r = await device.dumpTree({ fresh: true });
  assert.equal(r.fromCache, false);
  assert.equal(r.hash, h1, '同内容同 hash（§16.2）');
  await device.close();
});

test('动作置脏：tap 后缓存失效，下次 dump 重新 dump（§5.0.6 R1）', async () => {
  const device = await makeDevice();
  await device.dumpTree();
  const t = await device.tap([16, 140, 704, 300]);
  assert.deepEqual({ ok: t.ok, error: t.error }, { ok: true, error: null });
  assert.ok(t.latencyMs >= 0);
  const r = await device.dumpTree();
  assert.equal(r.fromCache, false);
  const stats = device.cacheStats();
  assert.equal(stats.dirtyResets, 1);
  await device.close();
});

test('screenSize 会话级缓存：wm size 只查一次', async () => {
  const exec = makeExec();
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const s1 = await device.screenSize();
  const s2 = await device.screenSize();
  assert.deepEqual([s1, s2], [{ w: 720, h: 1280 }, { w: 720, h: 1280 }]);
  assert.equal(exec.calls.filter((c) => c.includes('wm size')).length, 1);
  // screencap 复用 size 缓存
  const shot = await device.screencap();
  assert.equal(shot.buffer.subarray(1, 4).toString('latin1'), 'PNG');
  assert.deepEqual(shot.size, { w: 720, h: 1280 });
  await device.close();
});

test('locate 走门面：精确文本 + clickable 兜底；readText 各 selector', async () => {
  const device = await makeDevice();
  const r = await device.locate('电子相册');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'exact_text');
  assert.deepEqual(r.bounds, [16, 140, 704, 300]);
  const t1 = await device.readText('text=电子相册');
  assert.deepEqual({ ok: t1.ok, value: t1.value }, { ok: true, value: '电子相册' });
  const t2 = await device.readText('class=android.widget.Button');
  assert.equal(t2.value, '新建相册');
  const t3 = await device.readText('text=不存在');
  assert.equal(t3.ok, false);
  assert.match(t3.error, /未匹配/);
  const t4 = await device.readText('index=0');
  assert.equal(t4.value, '');
  await device.close();
});

test('inputText：聚焦→清空+输入（可合并为单条 shell）→回读校验（yadb 序列 §5.4.5）', async () => {
  const exec = makeExec({ dumpScript: [FIXTURE_INPUT] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.inputText([16, 1140, 704, 1220], '中文测试');
  assert.deepEqual({ ok: r.ok, readBack: r.readBack, error: r.error }, { ok: true, readBack: '中文测试', error: null });
  const calls = exec.calls;
  const clearIdx = calls.findIndex((c) => c.includes('-keyboardClear'));
  const kbIdx = calls.findIndex((c) => c.includes(`-keyboard '中文测试'`));
  assert.notEqual(clearIdx, -1);
  assert.notEqual(kbIdx, -1);
  // 合并为单条 shell 时两者同索引：用串内顺序判定"先清空再输入"
  if (clearIdx === kbIdx) {
    const one = calls[clearIdx];
    assert.ok(one.indexOf('-keyboardClear') < one.indexOf(`-keyboard '中文测试'`), '单条 shell 内先清空再输入');
  } else {
    assert.ok(clearIdx < kbIdx, '先清空再输入');
  }
  // 序列：聚焦 tap → 清空+输入 → dump 回读
  const tapIdx = calls.findIndex((c) => c.includes('input tap'));
  assert.ok(tapIdx !== -1 && tapIdx < clearIdx, '先点击聚焦');
  const dumpIdx = calls.findIndex((c) => c.includes('uiautomator dump'));
  assert.ok(dumpIdx > kbIdx, '回读必须 dump 新树');
  await device.close();
});

test('inputText：回读不一致 → ok=false（input text 假成功的防线）', async () => {
  const device = await makeDevice(); // dump 回来输入框为空
  const r = await device.inputText([16, 1140, 704, 1220], '中文测试');
  assert.equal(r.ok, false);
  assert.equal(r.readBack, '');
  assert.match(r.error, /回读不一致/);
  await device.close();
});

test('scroll：树 hash 判变化，无变化即停（§10）', async () => {
  const device = await makeDevice({ dumpScript: [FIXTURE, FIXTURE_B, FIXTURE_B, FIXTURE_B] });
  const r1 = await device.scroll('up', { max: 5 });
  assert.deepEqual(r1, { scrolls: 2, changed: true });
  const r2 = await device.scroll('up', { max: 5 });
  assert.deepEqual(r2, { scrolls: 1, changed: false }, 'hash 未变 → 立即停');
  await device.close();
});

test('waitIdle：连续两次相同 hash 即稳定（fresh dump，不吃缓存）', async () => {
  const device = await makeDevice({ dumpScript: [FIXTURE, FIXTURE] });
  const r = await device.waitIdle({ quiet: 2, intervalMs: 1, timeoutMs: 5000 });
  assert.deepEqual(r, { stable: true, dumps: 2 });
  await device.close();
});

test('waitIdle：dump 失败（转场/idle 超时）不抛错，当作未稳定继续等', async () => {
  // dumpXmlRaw 有 exec-out→shell 双通道回退：一次 dumpTree 失败要两个通道都失败，
  // 故哨兵连给两次（消耗于同一次 dumpTree 的两通道），随后两次成功达成 quiet=2
  const device = await makeDevice({ dumpScript: ['__FAIL__', '__FAIL__', FIXTURE, FIXTURE] });
  const r = await device.waitIdle({ quiet: 2, intervalMs: 1, timeoutMs: 5000 });
  assert.equal(r.stable, true);
  assert.ok(r.dumps >= 3, '失败那次也计入 dumps');
  await device.close();
});

test('waitIdle：全程 dump 失败 → 超时返回 stable=false 而非抛错', async () => {
  const device = await makeDevice({ dumpScript: ['__FAIL__'] });
  const r = await device.waitIdle({ quiet: 2, intervalMs: 1, timeoutMs: 300 });
  assert.equal(r.stable, false);
  await device.close();
});

test('环境方法：foreground/processAlive/assertNoCrash/launch/terminate/key/net', async () => {
  const device = await makeDevice();
  const fg = await device.foreground();
  assert.equal(fg.package, 'com.lgdg.fourt');
  assert.equal(fg.resumedActivity, 'com.lgdg.fourt/io.dcloud.PandoraEntryActivity');
  assert.equal(await device.processAlive('com.lgdg.fourt'), true);
  assert.equal(await device.processAlive('nope.pkg'), false);
  const crash = await device.assertNoCrash('com.lgdg.fourt');
  assert.deepEqual({ ok: crash.ok, alive: crash.alive, foreground: crash.foreground }, { ok: true, alive: true, foreground: 'com.lgdg.fourt' });
  const launched = await device.launch('com.lgdg.fourt');
  assert.deepEqual(launched, { ok: true, error: null });
  const terminated = await device.terminate('com.lgdg.fourt');
  assert.deepEqual(terminated, { ok: true });
  assert.deepEqual(await device.key('back'), { ok: true, error: null });
  assert.equal((await device.key('bogus')).ok, false);
  const net = await device.netSetProfile('4g');
  assert.deepEqual(net, { ok: true, profile: '4g', error: null });
  const badNet = await device.netSetProfile('99g');
  assert.equal(badNet.ok, false);
  assert.match(badNet.error, /未知档位/);
  assert.deepEqual(await device.netStatus(), { profile: 'off' });
  await device.close();
});

test('invalidateCache 丢树缓存+VLM 缓存；dumpToFile 落盘去杂质', async () => {
  const device = await makeDevice();
  await device.dumpTree();
  device.invalidateCache();
  const r = await device.dumpTree();
  assert.equal(r.fromCache, false);
  const dir = mkdtempSync(join(tmpdir(), 'ask-dump-'));
  const p = join(dir, 'ui_dump.xml');
  assert.equal(await device.dumpToFile(p), p);
  const saved = await readFile(p, 'utf8');
  assert.ok(saved.trimEnd().endsWith('</hierarchy>'));
  assert.ok(!saved.includes('UI hierchary dumped to'), '落盘内容不得含杂质尾缀');
  await device.close();
});

test('waitForElement：元素首次出现即返回（比等树不变快）', async () => {
  // 第 1 次 dump 无该文本，第 2 次有 → 应 appeared=true、dumps=2
  const noText = FIXTURE.replace(/text="电子相册"/g, 'text="其它"');
  const device = await makeDevice({ dumpScript: [noText, FIXTURE, FIXTURE] });
  const r = await device.waitForElement('text=电子相册', { timeoutMs: 5000, intervalMs: 1 });
  assert.equal(r.appeared, true);
  assert.equal(r.dumps, 2, '第二次命中即返回');
  assert.equal(r.matched, '电子相册');
  await device.close();
});

test('waitForElement：超时未出现 → appeared=false（不抛错）', async () => {
  const device = await makeDevice();
  const r = await device.waitForElement('text=不存在的元素XYZ', { timeoutMs: 300, intervalMs: 1 });
  assert.equal(r.appeared, false);
  assert.ok(r.dumps >= 1);
  await device.close();
});

test('waitForElement：空 selector → 结构化错误（不 dump）', async () => {
  const device = await makeDevice();
  const r = await device.waitForElement('', { timeoutMs: 1000 });
  assert.equal(r.appeared, false);
  assert.equal(r.dumps, 0);
  assert.match(r.error, /selector 为空/);
  await device.close();
});

test('waitForElement：支持 text*= 包含匹配与 resourceId', async () => {
  const device = await makeDevice();
  const r1 = await device.waitForElement('电子相册', { timeoutMs: 2000, intervalMs: 1 });
  assert.equal(r1.appeared, true, '裸文本（auto 链：精确→包含）应命中');
  const device2 = await makeDevice();
  const r2 = await device2.waitForElement('resource-id=com.lgdg:id/album_list', { timeoutMs: 2000, intervalMs: 1 });
  assert.equal(r2.appeared, true, 'resourceId 应命中');
  await device.close();
  await device2.close();
});

test('waitForAnyElement：任一命中即返回', async () => {
  const noText = FIXTURE.replace(/text="电子相册"/g, 'text="其它"');
  const device = await makeDevice({ dumpScript: [noText, FIXTURE] });
  const r = await device.waitForAnyElement(['text=不存在A', 'text=电子相册', 'text=不存在B'], { timeoutMs: 5000, intervalMs: 1 });
  assert.equal(r.appeared, true);
  assert.match(r.matched, /电子相册/);
  await device.close();
});

test('waitIdle：quiet=1 单次 dump 即返回（快但有风险）', async () => {
  const device = await makeDevice({ dumpScript: [FIXTURE] });
  const r = await device.waitIdle({ quiet: 1, intervalMs: 1, timeoutMs: 2000 });
  assert.deepEqual(r, { stable: true, dumps: 1 }, 'quiet=1 → 1 次 dump 即稳定');
  await device.close();
});
