// 真机集成测试（§16.1 ②层）：无模型，只依赖设备
// 门控：默认整体 skip；ASK_TEST_DEVICE=1 且 ASK_SERIAL 指定序列号才真跑
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevice } from '../src/device/index.js';

const ENABLED = process.env.ASK_TEST_DEVICE === '1';
const SERIAL = process.env.ASK_SERIAL || '127.0.0.1:5555';

async function withDevice(fn) {
  const device = await createDevice({ serial: SERIAL });
  try {
    return await fn(device);
  } finally {
    await device.close();
  }
}

test('真机：连接与分辨率', async (t) => {
  if (!ENABLED) return t.skip('需要真机：设置 ASK_TEST_DEVICE=1（ASK_SERIAL 默认 127.0.0.1:5555）');
  await withDevice(async (d) => {
    const size = await d.screenSize();
    assert.ok(size.w > 0 && size.h > 0);
  });
});

test('真机：screencap 返回 PNG 与分辨率一致', async (t) => {
  if (!ENABLED) return t.skip('需要真机');
  await withDevice(async (d) => {
    const { buffer, size } = await d.screencap();
    assert.equal(buffer.subarray(1, 4).toString('latin1'), 'PNG');
    assert.ok(buffer.length > 1000);
    assert.deepEqual(size, await d.screenSize());
  });
});

test('真机：dump 同一页面三次 hash 一致（§16.2 树缓存可行性）', async (t) => {
  if (!ENABLED) return t.skip('需要真机');
  await withDevice(async (d) => {
    const h1 = (await d.dumpTree({ fresh: true })).hash;
    const h2 = (await d.dumpTree({ fresh: true })).hash;
    const h3 = (await d.dumpTree({ fresh: true })).hash;
    assert.equal(h1, h2);
    assert.equal(h2, h3);
  });
});

test('真机：树缓存命中与动作置脏', async (t) => {
  if (!ENABLED) return t.skip('需要真机');
  await withDevice(async (d) => {
    await d.dumpTree();
    const hit = await d.dumpTree();
    assert.equal(hit.fromCache, true);
    d.markDirty();
    const miss = await d.dumpTree();
    assert.equal(miss.fromCache, false);
    const stats = d.cacheStats();
    assert.ok(stats.hits >= 1 && stats.dumps >= 2);
  });
});

test('真机：定位树中真实存在的文本节点', async (t) => {
  if (!ENABLED) return t.skip('需要真机');
  await withDevice(async (d) => {
    const { nodes } = await d.dumpTree();
    const flat = (function flat(list, out = []) {
      for (const n of list ?? []) {
        if (n.text) out.push(n);
        flat(n.children, out);
      }
      return out;
    })(nodes);
    assert.ok(flat.length > 0, '当前页面无文本节点，请先手动进入有文字的页面');
    const r = await d.locate(flat[0].text);
    assert.equal(r.ok, true);
    assert.ok(['exact_text', 'regex', 'resource_id', 'class_index', 'cache'].includes(r.strategy));
    assert.deepEqual(r.bounds, flat.find((n) => n.text === flat[0].text).bounds);
  });
});

test('真机：前台判定（ResumedActivity）与进程存活', async (t) => {
  if (!ENABLED) return t.skip('需要真机');
  await withDevice(async (d) => {
    const fg = await d.foreground();
    assert.ok(fg.package, 'ResumedActivity 应可解析');
    assert.ok(typeof (await d.processAlive('com.android.systemui')) === 'boolean');
  });
});

test('真机：launch/terminate/key 生命周期（settings）', async (t) => {
  if (!ENABLED) return t.skip('需要真机');
  await withDevice(async (d) => {
    const launched = await d.launch('com.android.settings');
    assert.equal(launched.ok, true, `launch 失败: ${launched.error ?? ''}`);
    await d.waitIdle({ quiet: 2, intervalMs: 300, timeoutMs: 15000 });
    const fg = await d.foreground();
    assert.equal(fg.package, 'com.android.settings');
    assert.equal((await d.terminate('com.android.settings')).ok, true);
    assert.equal((await d.key('home')).ok, true);
  });
});

test('真机：中文输入回读一致（§16.2，需页面有输入框时手工验证）', async (t) => {
  if (!ENABLED) return t.skip('需要真机且有输入框的页面（如设置搜索）');
  await withDevice(async (d) => {
    const r = await d.locate('class=android.widget.EditText');
    assert.equal(r.ok, true, '当前页面无 EditText');
    const input = await d.inputText(r.bounds, '中文输入测试');
    assert.deepEqual({ ok: input.ok, readBack: input.readBack }, { ok: true, readBack: '中文输入测试' });
  });
});

test('真机：dumpToFile 落盘取证', async (t) => {
  if (!ENABLED) return t.skip('需要真机');
  await withDevice(async (d) => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-it-'));
    const p = join(dir, 'ui_dump.xml');
    await d.dumpToFile(p);
    const { readFileSync } = await import('node:fs');
    assert.ok(readFileSync(p, 'utf8').includes('</hierarchy>'));
  });
});
