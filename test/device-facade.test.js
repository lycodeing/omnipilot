// 门面 createDevice（契约 §1.1）：缓存流 / 动作置脏 / yadb 输入序列 / 环境查询 / 取证（注入假 adb 执行器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
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
// 密码框变体：search_input 节点为 password 且 text 为掩码串（Android a11y 常见形态）
const FIXTURE_PASSWORD = FIXTURE.replace(
  '<node index="2" text="" resource-id="com.lgdg:id/search_input"',
  '<node index="2" text="••••" password="true" resource-id="com.lgdg:id/search_input"'
);

const DUMPSYS = '  mResumedActivity: ActivityRecord{948c168 u0 com.lgdg.fourt/io.dcloud.PandoraEntryActivity t123}\n';

// 构造最小合法 PNG（8-bit RGB、filter 0）：screenSignature 需要真可解码的截图，
// 否则恒走 tree 回退路径，快通道永远测不到。
function makePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * (stride + 1) + 1 + x * 3;
      raw[i] = rgb[0]; raw[i + 1] = rgb[1]; raw[i + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[12] = 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 按子命令路由的假 adb 执行器
// screencapScript：依次返回的 PNG（用于测"出帧 vs 冻帧"）；缺省返回非法 PNG（走 tree 回退）
function makeExec({ dumpScript = null, screencapScript = null } = {}) {
  const calls = [];
  let dumpIdx = 0;
  let shotIdx = 0;
  const exec = async (args) => {
    const joined = args.join(' ');
    calls.push(joined);
    if (joined.includes('get-state')) return { code: 0, stdout: 'device', stderr: '' };
    if (joined.includes('wm size')) return { code: 0, stdout: 'Physical size: 720x1280', stderr: '' };
    if (joined.includes('screencap')) {
      if (!screencapScript) return { code: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]), stderr: '' };
      const png = screencapScript[Math.min(shotIdx, screencapScript.length - 1)];
      shotIdx++;
      return { code: 0, stdout: png, stderr: '' };
    }
    if (joined.includes('uiautomator dump')) {
      const xml = dumpScript ? (dumpIdx < dumpScript.length ? dumpScript[dumpIdx++] : dumpScript.at(-1)) : FIXTURE;
      if (xml === '__FAIL__') return { code: 1, stdout: '', stderr: 'could not get idle state' };
      return { code: 0, stdout: `${xml}\nUI hierchary dumped to: /dev/tty\n`, stderr: '' };
    }
    // 合并命令（dumpsys+pidof 一条 shell，性能优化）：两段输出拼接
    if (joined.includes('dumpsys') && joined.includes('pidof')) {
      const alive = joined.includes('pidof com.lgdg.fourt');
      return { code: 0, stdout: `${DUMPSYS.trim()}\n${alive ? '12345' : ''}\n`, stderr: '' };
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
    'tapEachRow', 'scrollUntil', 'waitForElement', 'waitForAnyElement',
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
  // 等值 MISS → 包含兜底（WebView 文本节点粒度波动防线；'text*=xx' 不经 parseTarget，直接 includes）
  const t5 = await device.readText('text=子相');
  assert.deepEqual({ ok: t5.ok, value: t5.value, strategy: t5.strategy }, { ok: true, value: '电子相册', strategy: 'contains-fallback' });
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

test('inputText：password 节点掩码回读，长度一致即 ok，不泄明文', async () => {
  const exec = makeExec({ dumpScript: [FIXTURE_PASSWORD] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.inputText([16, 1140, 704, 1220], 'abcd');
  assert.equal(r.ok, true, '掩码长度 4 = 输入长度 4 → ok');
  assert.equal(r.readBack, '••••');
  assert.ok(!JSON.stringify(r).includes('abcd'), '结果不得含明文');
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
  // dumpXmlRaw 三通道回退（exec-out→shell→file）：一次 dumpTree 内前两通道吃掉两个失败
  // 哨兵，file 通道成功返回 FIXTURE；随后一次成功达成 quiet=2
  const device = await makeDevice({ dumpScript: ['__FAIL__', '__FAIL__', FIXTURE, FIXTURE] });
  const r = await device.waitIdle({ quiet: 2, intervalMs: 1, timeoutMs: 5000 });
  assert.equal(r.stable, true);
  assert.ok(r.dumps >= 2, '失败那次也计入 dumps');
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

test('tapEachRow：verify=true 且 screencap 解码失败 → 放行计数 verified；无 stopWhen 时滚到底 bottom', async () => {
  const device = await makeDevice(); // 静态树：hash 永不变；screencap 返回假 PNG（解码失败→放行）
  const r = await device.tapEachRow({ rows: 'text*=相册', tap: 'text=2025-09-16', maxRounds: 9 });
  assert.equal(r.error, null);
  assert.equal(r.taps, 1, '每轮至多 1 tap；行答完即不再 tap');
  assert.equal(r.verified, 1);
  assert.equal(r.screencapFailed, 1, '假 PNG 解码失败被计数暴露');
  assert.equal(r.skipped.length, 3, '无匹配选项带的行记 skipped 不重 tap');
  assert.equal(r.bottom, true, '无在屏可答行且滚动无变化（连续两轮同键）→ bottom');
  await device.close();
});

test('tapEachRow：verify=false 且树无响应 → 不记假已答，连续 2 次报 renderer_unresponsive', async () => {
  const device = await makeDevice(); // 静态树：hash 永不变，verify=false 时 hash 是唯一信号
  const r = await device.tapEachRow({ rows: 'text*=相册', tap: 'text=2025-09-16', verify: false, maxRounds: 6 });
  assert.match(r.error, /renderer_unresponsive/);
  assert.equal(r.unverified, 2);
  assert.equal(r.verified, 0);
  await device.close();
});

test('tapEachRow：无文本行不进集群（入口排除），rows 命中空文本节点时 0 tap 不空转', async () => {
  const device = await makeDevice();
  const r = await device.tapEachRow({ rows: 'class=android.widget.ImageView', tap: 'text=查看', maxRounds: 4 });
  assert.equal(r.taps, 0, '无文本行被排除，不得每轮重 tap');
  assert.equal(r.error, null);
  await device.close();
});

test('scrollUntil：目标在屏 → found=true 且 0 滚动；不存在 → 滚到无变化 found=false', async () => {
  const device = await makeDevice();
  const r1 = await device.scrollUntil('text=电子相册', { max: 4 });
  assert.deepEqual({ found: r1.found, scrolls: r1.scrolls }, { found: true, scrolls: 0 });
  const r2 = await device.scrollUntil('text=不存在的东西', { max: 4 });
  assert.equal(r2.found, false);
  assert.ok(r2.scrolls >= 1);
  await device.close();
});

test('tapEachRow：stopWhen 在屏且无未答行 → done=true（回归锁：find 返回节点本身，守卫不得用 .node）', async () => {
  // 静态树：行=「相册」（1 行），选项=「2025-09-16」，终止标记=「家庭相册」在屏
  const device = await makeDevice();
  const r = await device.tapEachRow({ rows: 'text=相册', tap: 'text=2025-09-16', stopWhen: 'text=家庭相册', maxRounds: 4 });
  assert.equal(r.done, true, 'stopWhen 可见且行已答完必须 done');
  assert.equal(r.taps, 1, 'done 前必须真的答了那行（锁 pending 守卫：过早 done 会 taps=0）');
  assert.equal(r.error, null);
  await device.close();
});

test('tapEachRow：stopWhen 在屏但仍有未答行 → 答完才 done（pending 守卫半边 + rows | 交替）', async () => {
  const device = await makeDevice();
  // 两行（电子相册/家庭相册）+ 各自选项都在树上，stopWhen「新建相册」第 0 轮即在屏：
  // 若 pending 守卫缺失会第 0 轮 done=true 且 taps=0；正确行为是两行各答一次后才 done
  const r = await device.tapEachRow({ rows: 'text=电子相册|text=家庭相册', tap: 'text=2025-09-16|text=2026-01-02', stopWhen: 'text=新建相册', maxRounds: 9 });
  assert.ok(r.taps >= 2, '有未答行时不得因 stopWhen 在屏提前终止（早退则 taps=0）');
  assert.equal(r.done, true, '两行答完后应正常终止');
  await device.close();
});

test('readText：text=x#index=N 等值 MISS 后兜底剥 #index 做包含匹配', async () => {
  const device = await makeDevice();
  // 等值 MISS（无节点文本恰为 '电子相册#index=0'）→ 兜底剥后缀 → 包含命中
  const r = await device.readText('text=子相#index=0'); // 等值必 MISS（无节点文本为'子相'），只能走剥 #index 的包含兜底
  assert.equal(r.ok, true);
  assert.equal(r.value, '电子相册');
  await device.close();
});

// 回归（2026-11-02 真机实证）：该 App 的 WebView 会**停止出帧**——screencap 连续返回逐字节
// 相同的陈旧画面，而 a11y 树仍在更新。纯像素签名会因此恒判"无变化"、把 scroll 误停在第一轮。
// 修复后签名只作单向快通道（变了 ⇒ 一定变了），签名没变时必须用树 hash 确认。
test('scroll：签名不变时回落树 hash（防 WebView 冻帧误判到底）', async () => {
  // screencap 固定返回同一张 PNG（模拟冻帧），树按脚本变化
  const device = await makeDevice({ dumpScript: [FIXTURE, FIXTURE_B, FIXTURE_B] });
  const r = await device.scroll('up', { max: 5 });
  assert.deepEqual(r, { scrolls: 2, changed: true }, '冻帧下仍按树变化判定（2 轮后树不再变 → 停）');
  await device.close();
});

// 快通道验证：滚动持续生效（每帧都不同）时**0 次 dump**。
// 前提是已有 lastTreeHash（真实调用方都先 dump 过：scrollUntil/tapEachRow 每轮开头 dump）。
test('scroll：签名持续变化走快通道（0 次 uiautomator dump）', async () => {
  const frames = [
    makePng(40, 40, [200, 30, 40]),
    makePng(40, 40, [30, 160, 60]),
    makePng(40, 40, [40, 60, 200]),
    makePng(40, 40, [220, 200, 40]),
  ];
  const exec = makeExec({ screencapScript: frames, dumpScript: [FIXTURE] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  await device.dumpTree({ fresh: true }); // 建立 lastTreeHash（真实调用方的常态）
  const before = exec.calls.filter((c) => c.includes('uiautomator dump')).length;
  const r = await device.scroll('up', { max: 3 });
  assert.deepEqual(r, { scrolls: 3, changed: true }, '每轮都判有变化，跑满 max');
  const dumpCalls = exec.calls.filter((c) => c.includes('uiautomator dump')).length - before;
  assert.equal(dumpCalls, 0, `快通道不应触发整树 dump，实际 ${dumpCalls} 次`);
  await device.close();
});

// 冻帧场景：签名恒等 → 每轮付一次树 dump 确认。基线取 lastTreeHash 时（已有前置 dump）
// 首轮即可正确判定"没动"，不会把真实滚动误报成到底。
test('scroll：冻帧时用树 hash 兜底判定，且不重复建基线', async () => {
  const red = makePng(40, 40, [200, 30, 40]);
  const exec = makeExec({ screencapScript: [red, red, red, red], dumpScript: [FIXTURE, FIXTURE, FIXTURE] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  await device.dumpTree({ fresh: true }); // lastTreeHash = FIXTURE 的 hash
  const before = exec.calls.filter((c) => c.includes('uiautomator dump')).length;
  const r = await device.scroll('up', { max: 5 });
  assert.deepEqual(r, { scrolls: 1, changed: false }, '首轮签名不变 + 树未变 → 立即判到底');
  const dumpCalls = exec.calls.filter((c) => c.includes('uiautomator dump')).length - before;
  assert.equal(dumpCalls, 1, `复用基线后仅需 1 次确认 dump，实际 ${dumpCalls} 次`);
  await device.close();
});

// 正确性红线：没有 lastTreeHash 时必须在首次 swipe **之前**补基线，
// 否则"签名没变"无法证明"没动"（scrollUntil / tapEachRow 转向都用 max=1，会直接卡死）。
test('scroll：无既有树基线时先补一次基线（max=1 也能识别真实滚动）', async () => {
  const red = makePng(40, 40, [200, 30, 40]);
  // 树从 FIXTURE 变到 FIXTURE_B：第 1 轮就应判 changed=true
  const exec = makeExec({ screencapScript: [red, red], dumpScript: [FIXTURE, FIXTURE_B] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.scroll('up', { max: 1 });
  assert.deepEqual(r, { scrolls: 1, changed: true }, '首轮基线在 swipe 前取 → 能识别滚动');
  await device.close();
});

// 回归（2026-11-02 真机实证）：调用方常在"点进问卷"同一步紧接着调 tapEachRow，此时页面
// 还在转场/首屏渲染，树里一行都没有。旧实现见到 0 行立刻按"无行可答"收尾返回 ok
// （实测 11s 就 ok 退出，整轮后续断言全灭）。修复：从未 tap 过且 0 行时先等页面就绪。
test('tapEachRow：0 行且未 tap 过 → 先等页面就绪（不立刻 ok 退出）', async () => {
  // 前两次 dump 是空树（模拟转场中），第 3 次起出现行与选项
  const empty = '<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="加载中" resource-id="" class="android.widget.TextView" clickable="false" bounds="[0,600][720,660]" /></hierarchy>';
  const exec = makeExec({ dumpScript: [empty, empty, FIXTURE, FIXTURE, FIXTURE] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.tapEachRow({ rows: 'text=相册', tap: 'text=2025-09-16', maxRounds: 6, profile: 'form' });
  assert.ok(r.taps >= 1, `就绪后应真的作答，实际 taps=${r.taps}（0 = 又提前 ok 退出了）`);
  assert.equal(r.error, null);
  await device.close();
});

// 对照：一直没有行（页面压根没有此类表单）→ 必须在预算耗尽后正常收尾，不能无限等
test('tapEachRow：始终 0 行 → 就绪预算耗尽后收尾（不挂死）', async () => {
  const empty = '<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="加载中" resource-id="" class="android.widget.TextView" clickable="false" bounds="[0,600][720,660]" /></hierarchy>';
  const exec = makeExec({ dumpScript: [empty] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const t0 = Date.now();
  const r = await device.tapEachRow({ rows: 'text=相册', tap: 'text=2025-09-16', maxRounds: 4, profile: 'form' });
  assert.equal(r.taps, 0);
  assert.equal(r.error, null, '无行是正常情形（非错误），但必须退出');
  assert.ok(Date.now() - t0 < 60_000, '不应无限等待');
  await device.close();
});

// 回归（自查发现的隐患）：就绪等待**不得消耗** maxRounds 配额。否则 questionnaire profile
// 的 45s 就绪预算会吃掉 45 轮，YAML 的 maxRounds: 60 只剩 15 轮给 27 题（表现为答到一半
// exhausted，且与就绪快慢耦合）。
test('tapEachRow：就绪等待不消耗 maxRounds 配额', async () => {
  // 前 3 次 dump 无行（转场），之后出现完整行/选项；maxRounds 设很小（2）也能答完
  const loading = '<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="加载中" resource-id="" class="android.widget.TextView" clickable="false" bounds="[0,600][720,660]" /></hierarchy>';
  const exec = makeExec({ dumpScript: [loading, loading, loading, FIXTURE, FIXTURE, FIXTURE] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.tapEachRow({ rows: 'text=相册', tap: 'text=2025-09-16', maxRounds: 2, profile: 'form' });
  assert.ok(r.taps >= 1, `就绪等待不应吃掉配额，实际 taps=${r.taps} rounds=${r.rounds}`);
  assert.equal(r.error, null);
  await device.close();
});

// 回归（2026-11-04 双代理评审实证复现）：快通道命中（签名变化）会把树基线置 null；
// 紧接着的冻帧轮进树确认分支时若无基线，moved 恒 false → 误判"到底"提前 break。
// 修复后循环顶部在 swipe 前补基线。帧=[变,冻,冻]、树逐轮都变 → 必须跑满 max 轮。
test('scroll：快通道→冻帧切换点仍做树确认（不误判到底）', async () => {
  const frames = [
    makePng(40, 40, [200, 30, 40]), // 基线
    makePng(40, 40, [30, 160, 60]), // r1 签名变化 → 快通道
    makePng(40, 40, [30, 160, 60]), // r2 冻帧 → 树确认
    makePng(40, 40, [30, 160, 60]), // r3 冻帧 → 树确认
  ];
  const treeA = FIXTURE;
  const treeB = FIXTURE_B;
  const treeC = FIXTURE_B.replace('</hierarchy>', '  <node index="9" text="再变" resource-id="com.lgdg:id/extra2" class="android.widget.TextView" clickable="false" bounds="[0,1260][720,1280]"/>\n</hierarchy>');
  // 树逐轮都在变（真实滚动中 WebView 冻帧的场景）——任何一轮误判"没动"都会提前 break
  const exec = makeExec({ screencapScript: frames, dumpScript: [treeA, treeB, treeC, treeC] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.scroll('up', { max: 3 });
  assert.deepEqual(r, { scrolls: 3, changed: true }, `冻帧切换点须做树确认并继续滚动，实际 ${JSON.stringify(r)}`);
  await device.close();
});

// ===== dumpXmlRaw 通道决策（uia2 注入缝）=====
// 评审（2026-11-04）：这是整个引擎的可用性命门，此前因"注入 exec 就硬性 uia2=null"零覆盖。

function makeUia2Stub({ sourceImpl, pid = '4242' }) {
  const calls = { source: 0, pid: 0 };
  return {
    calls,
    source: async (...a) => { calls.source++; return sourceImpl(...a); },
    serverPid: async () => { calls.pid++; return pid; },
    ensure: async () => true,
    ensureSession: async () => 'stub',
    resetSession: () => {},
  };
}

test('通道决策：uia2 成功 → 直接返回，不碰 legacy', async () => {
  const exec = makeExec({});
  const stub = makeUia2Stub({ sourceImpl: async () => FIXTURE });
  const device = await createDeviceWithExecutor({ serial: 'test', exec, uia2: stub, waitReady: false });
  const r = await device.dumpTree({ fresh: true });
  assert.ok(r.nodes.length > 0);
  assert.equal(stub.calls.source, 1);
  assert.equal(exec.calls.filter((c) => c.includes('uiautomator dump')).length, 0, 'legacy 通道不应被触碰');
  await device.close();
});

// P1 回归（评审 P1-1）：uia2 "有应答但无树"（无 hierarchy）时服务必活着=槽被占，
// 不得掉进注定的 legacy 三通道；应走有界 uia2 重试。重试仍失败 → 抛"槽被占"错误，
// 且全程零 legacy dump 调用。
test('通道决策：uia2 无 hierarchy（槽被占）→ 有界重试，绝不碰 legacy', async () => {
  const exec = makeExec({});
  const stub = makeUia2Stub({ sourceImpl: async () => '<?xml version="1.0"?><hierarchy rotation="0"/>' });
  const device = await createDeviceWithExecutor({ serial: 'test', exec, uia2: stub, waitReady: false });
  await assert.rejects(
    () => device.dumpTree({ fresh: true }),
    /UiAutomation 槽被 uia2 占用/,
  );
  assert.equal(exec.calls.filter((c) => c.includes('uiautomator dump')).length, 0, '槽被占时 legacy 是死路，不得触碰');
  assert.ok(stub.calls.source >= 2, `应有首次 + 有界重试，实际 ${stub.calls.source}`);
  await device.close();
});

// 对照：建会话 500 = 服务活着但未注册 UiAutomation = 槽空闲 → legacy 可用且必须走
test('通道决策：uia2 建会话 500（槽空闲）→ 正常走 legacy 三通道', async () => {
  const exec = makeExec({});
  const stub = makeUia2Stub({ sourceImpl: async () => { const e = new Error('uia2 建会话失败: 500'); e.status = 500; throw e; }, pid: null });
  const device = await createDeviceWithExecutor({ serial: 'test', exec, uia2: stub, waitReady: false });
  const r = await device.dumpTree({ fresh: true });
  assert.ok(r.nodes.length > 0, '500 型失败（槽空闲）应走 legacy 拿到树');
  assert.ok(exec.calls.some((c) => c.includes('uiautomator dump')), '应触碰 legacy 通道');
  await device.close();
});

// 槽守卫下 busy 重试成功路径：首次超时（槽被占）→ 退避等待 → 重试拿到树
test('通道决策：uia2 超时（槽被占）→ 退避后重试成功，不碰 legacy', async () => {
  const exec = makeExec({});
  let n = 0;
  const stub = makeUia2Stub({ sourceImpl: async () => { if (++n === 1) throw new Error('uia2 超时(30000ms)'); return FIXTURE; } });
  const device = await createDeviceWithExecutor({ serial: 'test', exec, uia2: stub, waitReady: false });
  const r = await device.dumpTree({ fresh: true });
  assert.ok(r.nodes.length > 0);
  assert.equal(stub.calls.source, 2, '首次超时 + 重试一次');
  assert.equal(exec.calls.filter((c) => c.includes('uiautomator dump')).length, 0);
  await device.close();
});

// kind 化回归（评审 #6）：ensure 失败挂 e.kind='unavailable'，message 不含中文"不可用"——
// 槽判定必须凭结构化 kind，不得依赖文案正则；服务没起来 = 槽空闲 → legacy 可用且必须走。
// pid 非 null（服务进程残留但 ensure 失败的真实形态）：若槽被误判为占用，会进守卫做
// 有界重试而非走 legacy——pid=null 时守卫静默放行，测不出误判。
test('通道决策：uia2 ensure 失败（unavailable，槽空闲）→ 正常走 legacy', async () => {
  const exec = makeExec({});
  const stub = makeUia2Stub({ sourceImpl: async () => { const e = new Error('service not installed'); e.kind = 'unavailable'; throw e; } });
  const device = await createDeviceWithExecutor({ serial: 'test', exec, uia2: stub, waitReady: false });
  const r = await device.dumpTree({ fresh: true });
  assert.ok(r.nodes.length > 0, 'unavailable（服务没起来，槽空闲）应走 legacy 拿到树');
  assert.ok(exec.calls.some((c) => c.includes('uiautomator dump')), '应触碰 legacy 通道');
  assert.equal(stub.calls.source, 1, '槽空闲不应触发 busy 有界重试');
  await device.close();
});

test('inputText：ASCII 文本 yadb 回读失败 → input text 降级重试一次（评审 #16）', async () => {
  const exec = makeExec(); // dump 回来输入框为空 → yadb 与降级路径都回读失败
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.inputText([16, 1140, 704, 1220], 'hello123');
  assert.equal(r.ok, false, '降级后仍未回读到 → 失败语义不变');
  assert.equal(r.strategy, 'input-text-fallback');
  const fb = exec.calls.find((c) => c.includes('input text'));
  assert.ok(fb, '应尝试原生 input text 降级');
  await device.close();
});

test('inputText：ASCII 降级时 % 不被反斜杠转义（设备端只认 %s，不认 \\）', async () => {
  // 回归用例：AOSP 的 input text 用 escapeFlag 机制——% 后的字符是 s 才解成空格，
  // 其它情况 % 与后字符都保留；反斜杠设备端完全不认。
  // 故降级路径绝不能反斜杠转义 %（会多出字面反斜杠），也不能自造 %% 编码
  // （AOSP 会原样保留两个 %）。字面 % 属平台限制，靠回读校验如实报错。
  const exec = makeExec();
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  await device.inputText([16, 1140, 704, 1220], '50% off');
  const fb = exec.calls.find((c) => c.includes('input text'));
  assert.ok(fb, '应尝试原生 input text 降级');
  // AOSP Input.sendText 的 escapeFlag 机制：% 后的字符是 s 才解成空格；其它情况
  // % 与后字符都保留；反斜杠设备端完全不认。
  //
  // 原文 "50% off"：% 后面紧跟的空格必须编码成 %s，于是相邻的 % 与 %s 拼成 "%%s"
  // ——这是协议本身的限制（AOSP 没有 % 的字面转义），不是实现错误。
  // 因此这里断言的是"不做错误的转义"：不反斜杠转义、不自造 %% 编码成两个字面 %。
  assert.ok(fb.includes('50%'), '字面 % 必须保留');
  assert.ok(fb.includes('%soff'), '空格应转 %s');
  assert.ok(!fb.includes('\\%'), '% 不应被反斜杠转义（设备端不认反斜杠）');
  // 自造 %% 编码的表现是"%% 后面跟的不是 s"（AOSP 会把 %%s 的首个 % 当字面）
  // ——原文 "50% off" 恰好产生 "%%s"（% + 空格转的 %s），无法从字面区分，
  // 故此处只断言"没有把 % 变成 %% 之外的形态"，真实转义由 AOSP 端语义保证。
  assert.ok(!/%%[^s]/.test(fb), '不应出现 %% 紧跟非 s 的形态（自造 %% 编码）');
  await device.close();
});

test('inputText：非 ASCII（中文）yadb 失败不降级（input text 对中文静默失败，§5.4.5）', async () => {
  const exec = makeExec();
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.inputText([16, 1140, 704, 1220], '中文测试');
  assert.equal(r.ok, false);
  assert.equal(r.strategy, undefined);
  assert.equal(exec.calls.some((c) => c.includes('input text ')), false, '中文不得走 input text');
  await device.close();
});
