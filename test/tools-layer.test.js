// 工具层测试：buildTools 注册表完整性（§10 清单）+ 假 device/store/recorder 注入的主链路
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildTools, buildEngineTools, EXPECTED_TOOLS } from '../src/tools/index.js';
import { flattenNodes, matchSelector } from '../src/tools/perception.js';
import { repairJson, createChatClient, extractJson } from '../src/tools/ai.js';

// —— 假件（§16.3 单元层允许 mock） ——

function makeNode(index, text, cls, resourceId, bounds, clickable = false, contentDesc = '', children = []) {
  const center = bounds ? [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)] : null;
  return { index, text, cls, resourceId, contentDesc, clickable, bounds, center, children };
}

function makeFakeDevice(overrides = {}) {
  return {
    screencap: async () => ({ buffer: Buffer.from('89504e47', 'hex'), size: { w: 720, h: 1280 } }),
    dumpTree: async () => ({
      nodes: [makeNode(0, 'root', 'android.widget.FrameLayout', '', [0, 0, 720, 1280], true, '', [
        makeNode(1, '童年记忆', 'android.widget.TextView', '', [0, 100, 200, 160]),
        makeNode(2, '电子相册', 'android.widget.TextView', 'com.lgdg:id/album', [0, 200, 200, 300]),
      ])],
      hash: 'abc123',
      dumpMs: 2,
      fromCache: false,
    }),
    locate: async (target, hints) => ({ ok: true, bounds: [512, 760, 704, 880], center: [608, 820], strategy: 'exact_text', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: null, ...(overrides.locate || {}) }),
    readText: async (sel) => ({ ok: true, value: '电子相册', error: null }),
    screenDiffHash: async () => 'abc123',
    tap: async (bounds) => ({ ok: true, latencyMs: 123, error: null }),
    longPress: async (bounds, d) => ({ ok: true, latencyMs: 300, error: null }),
    inputText: async (bounds, text) => ({ ok: true, readBack: text, error: null }),
    swipe: async () => ({ ok: true }),
    scroll: async (dir, o) => ({ scrolls: 1, changed: true }),
    key: async (n) => ({ ok: true }),
    launch: async () => ({ ok: true, error: null }),
    terminate: async () => ({ ok: true }),
    foreground: async () => ({ package: 'com.lgdg.fourt', activity: '.MainActivity', resumedActivity: '.MainActivity' }),
    screenSize: async () => ({ w: 720, h: 1280 }),
    processAlive: async () => true,
    waitIdle: async (o) => ({ stable: true, dumps: 2 }),
    assertNoCrash: async (p) => ({ ok: true, alive: true, foreground: 'com.lgdg.fourt', error: null }),
    netSetProfile: async (name) => ({ ok: true, profile: name, error: null }),
    netStatus: async () => ({ profile: 'off' }),
    markDirty: () => {},
    invalidateCache: () => {},
    cacheStats: () => ({ dumps: 1, hits: 0, misses: 1, dirtyResets: 0 }),
    dumpToFile: async (p) => p,
    close: async () => {},
    ...overrides,
  };
}

function makeFakeStore() {
  const data = new Map();
  return {
    append(name, rows, meta = {}) {
      const list = data.get(name) || [];
      let written = 0;
      for (const r of rows) { list.push({ _id: String(list.length + 1), _run: meta.run ?? null, _step: meta.step ?? null, ...r }); written++; }
      data.set(name, list);
      return { written };
    },
    upsert(name, key, rows, meta = {}) {
      const list = data.get(name) || [];
      let written = 0, merged = 0;
      for (const r of rows) {
        const i = list.findIndex((x) => x[key] === r[key]);
        if (i >= 0) { list[i] = { ...list[i], ...r }; merged++; } else { list.push(r); written++; }
      }
      data.set(name, list);
      return { written, merged };
    },
    read: (name) => data.get(name) || [],
    clear: (name) => data.delete(name),
    query: (name, opts = {}) => {
      let rows = data.get(name) || [];
      if (opts.where) rows = rows.filter(() => true);
      return rows;
    },
    _data: data,
  };
}

function makeFakeRecorder() {
  return {
    runId: 'run-20261027-000000-abcd',
    dir: '/tmp/fake-run',
    get jsonPath() { return '/tmp/fake-run.json'; },
    startStep(type, target) { return { end() {} }; },
    addAssertion() {},
    addNetworkEvent() {},
    addRollback() {},
    setExtracts() {},
    setContextLayers() {},
    finish() {},
  };
}

function makeCtx(overrides = {}) {
  const device = overrides.device || makeFakeDevice();
  const ctx = {
    device,
    recorder: overrides.recorder !== undefined ? overrides.recorder : makeFakeRecorder(),
    store: overrides.store !== undefined ? overrides.store : makeFakeStore(),
    vars: new Map(),
    opts: { yes: true, timeoutMs: 60000, vlmLocate: false, freshLocate: false, rollback: 'on', ...(overrides.opts || {}) },
    secretCalls: [],
    mcp: overrides.mcp ?? null,
    confirm: overrides.confirm ?? null,
    chat: overrides.chat ?? null,
    vlm: null,
    runStartMs: Date.now(),
    currentStepIndex: 0,
    assertions: [],
  };
  return ctx;
}

function getContent(toolResult) {
  return JSON.parse(toolResult.content.find((c) => c.type === 'text').text);
}

// —— 注册表完整性（§10 清单逐一断言） ——
describe('tools registry', () => {
  const ctx = makeCtx();
  const tools = buildTools(ctx);
  const names = new Set(tools.map((t) => t.name));

  test('§10 清单 22 个工具逐一存在', () => {
    for (const name of EXPECTED_TOOLS) {
      assert.ok(names.has(name), `缺少工具: ${name}`);
    }
    assert.equal(EXPECTED_TOOLS.length, 25, '感知5+操作9+环境6+数据扩展5');
  });

  test('每个工具都有 name/label/description/parameters/execute', () => {
    for (const t of tools) {
      assert.equal(typeof t.name, 'string');
      assert.ok(t.label);
      assert.ok(t.description);
      assert.ok(t.parameters, `${t.name} 缺 parameters schema`);
      assert.equal(typeof t.execute, 'function');
    }
  });

  test('MCP 桥为空时无 MCP 工具、缺桥不崩', () => {
    assert.equal(tools.filter((t) => t.name.includes('__')).length, 0);
  });
});

// —— 主链路 1：tap 成功 / 定位失败回退 ——
describe('action tools', () => {
  // —— 坐标点击（allowCoords 逃生口）：只在引擎专用工具面，模型侧不可见 ——
  test('point_tap 不进契约工具面（模型仍禁止像素坐标，2026-09-24 裁定）', () => {
    const ctx = makeCtx();
    const names = buildTools(ctx).map((t) => t.name);
    assert.ok(!names.includes('point_tap'), 'buildTools 不应含引擎专用工具');
    assert.ok(!EXPECTED_TOOLS.includes('point_tap'), 'point_tap 不在契约清单');
    assert.deepEqual(buildEngineTools(ctx).map((t) => t.name), ['point_tap'], '引擎工具面只有 point_tap');
  });

  test('point_tap：跳过定位直点坐标，locate.strategy=coords', async () => {
    const device = makeFakeDevice();
    const calls = [];
    device.tap = async (b) => { calls.push(b); return { ok: true, latencyMs: 7, error: null }; };
    let located = 0;
    device.locate = async () => { located++; return { ok: true, bounds: [0, 0, 1, 1] }; };
    const ctx = makeCtx({ device });
    const pt = buildEngineTools(ctx).find((t) => t.name === 'point_tap');
    const body = getContent(await pt.execute('id1', { x: 405, y: 2115 }, undefined, undefined, {}));
    assert.equal(body.ok, true);
    assert.equal(body.strategy, 'coords');
    assert.deepEqual(body.center, [405, 2115]);
    assert.deepEqual(calls, [[405, 2115]], '直接把坐标交给 device.tap');
    assert.equal(located, 0, '坐标步不做语义定位');
  });

  test('point_tap：设备 tap 失败时透传错误（不静默成功）', async () => {
    const device = makeFakeDevice();
    device.tap = async () => ({ ok: false, latencyMs: 1, error: 'adb 命令超时' });
    const ctx = makeCtx({ device });
    const pt = buildEngineTools(ctx).find((t) => t.name === 'point_tap');
    const r = await pt.execute('id1', { x: 1, y: 2 }, undefined, undefined, {});
    assert.equal(getContent(r).ok, false);
    assert.equal(r.details.locate.strategy, 'coords');
    assert.equal(r.details.locate.error, 'adb 命令超时');
  });

  test('tap 成功：定位 → 点击，返回策略与 bounds', async () => {
    const device = makeFakeDevice();
    const calls = [];
    device.tap = async (b) => { calls.push(b); return { ok: true, latencyMs: 42, error: null }; };
    const ctx = makeCtx({ device });
    const tap = buildTools(ctx).find((t) => t.name === 'tap');
    const r = await tap.execute('id1', { target: '电子相册' }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(body.ok, true);
    assert.equal(body.strategy, 'exact_text');
    assert.deepEqual(body.bounds, [512, 760, 704, 880]);
    assert.equal(body.latencyMs, 42);
    assert.equal(calls.length, 1);
  });

  test('tap 定位失败：LOCATE_MISS + 补救建议，不点击', async () => {
    const device = makeFakeDevice({
      locate: async () => ({ ok: false, bounds: null, center: null, strategy: '', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: '未命中' }),
    });
    let tapped = 0;
    device.tap = async () => { tapped++; return { ok: true, latencyMs: 1, error: null }; };
    const ctx = makeCtx({ device });
    const tap = buildTools(ctx).find((t) => t.name === 'tap');
    const r = await tap.execute('id1', { target: '不存在的东西' }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'LOCATE_MISS');
    assert.ok(body.hint.includes('uitree'));
    assert.equal(tapped, 0, '定位失败不应点击');
  });

  test('input 前置定位并回读', async () => {
    const ctx = makeCtx();
    const input = buildTools(ctx).find((t) => t.name === 'input');
    const r = await input.execute('id1', { target: '搜索框', value: '你好 world' }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(body.ok, true);
    assert.equal(body.readBack, '你好 world');
  });

  test('key 校验按键名', async () => {
    const ctx = makeCtx();
    const key = buildTools(ctx).find((t) => t.name === 'key');
    const bad = await key.execute('id1', { name: 'menu' }, undefined, undefined, {});
    assert.equal(getContent(bad).ok, false);
    const good = await key.execute('id1', { name: 'back' }, undefined, undefined, {});
    assert.equal(getContent(good).ok, true);
  });
});

// —— 主链路 2：data_extract ui 模式（零模型调用） ——
describe('data tools', () => {
  test('ui 模式：容器 + 字段提取，写数据集与变量表', async () => {
    const device = makeFakeDevice();
    device.dumpTree = async () => ({
      nodes: [makeNode(0, 'page', 'android.widget.FrameLayout', '', [0, 0, 720, 1280], true, '', [
        makeNode(1, 'card1', 'android.view.ViewGroup', '', [0, 0, 720, 200], true, '', [
          makeNode(2, '春游', 'android.widget.TextView', '', [0, 0, 300, 60]),
          makeNode(3, '2025-09-16', 'android.widget.TextView', '', [0, 60, 300, 120]),
        ]),
        makeNode(4, 'card2', 'android.view.ViewGroup', '', [0, 200, 720, 400], true, '', [
          makeNode(5, '秋游', 'android.widget.TextView', '', [0, 200, 300, 260]),
          makeNode(6, '2025-10-01', 'android.widget.TextView', '', [0, 260, 300, 320]),
        ]),
      ])],
      hash: 'h1', dumpMs: 2, fromCache: false,
    });
    const store = makeFakeStore();
    const ctx = makeCtx({ device, store });
    const tool = buildTools(ctx).find((t) => t.name === 'data_extract');
    const r = await tool.execute('id1', {
      name: 'album_list', mode: 'ui', container: 'class=android.view.ViewGroup',
      fields: [
        { name: 'album_name', from: 'text', selector: 'index=0' },
        { name: 'album_date', from: 'text', selector: 'index=1' },
      ],
    }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(body.ok, true);
    assert.equal(body.count, 2);
    assert.deepEqual(body.sample[0], { album_name: '春游', album_date: '2025-09-16' });
    assert.equal(store.read('album_list').length, 2);
    assert.deepEqual(ctx.vars.get('album_list')[0], { album_name: '春游', album_date: '2025-09-16' });
  });

  test('ai 模式：注入 chat mock，JSON 容错', async () => {
    const ctx = makeCtx({
      chat: async () => '```json\n[{"name": "相册A", "price": 1}]\n```',
    });
    const tool = buildTools(ctx).find((t) => t.name === 'data_extract');
    const r = await tool.execute('id1', { mode: 'ai', query: '返回 {name: string, price: number}[]' }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(body.ok, true);
    assert.deepEqual(body.sample[0], { name: '相册A', price: 1 });
  });

  test('data_query 委托 store', async () => {
    const store = makeFakeStore();
    store.append('t', [{ a: 1 }, { a: 2 }]);
    const ctx = makeCtx({ store });
    const tool = buildTools(ctx).find((t) => t.name === 'data_query');
    const r = await tool.execute('id1', { name: 't' }, undefined, undefined, {});
    assert.equal(getContent(r).count, 2);
  });

  test('secret_get 记账 ctx.secretCalls（§19.7）', async () => {
    const ctx = makeCtx();
    const tool = buildTools(ctx).find((t) => t.name === 'secret_get');
    const r = await tool.execute('id1', { provider: 'vault', key: 'password' }, undefined, undefined, {});
    assert.equal(ctx.secretCalls.length, 1);
    assert.deepEqual(ctx.secretCalls[0], { tool: 'secret_get', provider: 'vault', key: 'password', stepIndex: 0 });
    // 无凭据文件时返回 SECRET_UNAVAILABLE（值绝不硬编码）
    const body = getContent(r);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SECRET_UNAVAILABLE');
  });
});

// —— 主链路 3：wait_idle / env ——
describe('env tools', () => {
    test('wait_element：透传 waitForElement，appeared 映射 ok', async () => {
    let gotSel = null;
    const device = makeFakeDevice();
    device.waitForElement = async (sel, o) => { gotSel = sel; return { appeared: true, dumps: 2, matched: sel }; };
    const ctx = makeCtx({ device });
    const tool = buildTools(ctx).find((t) => t.name === 'wait_element');
    assert.ok(tool, 'wait_element 已注册');
    const r = await tool.execute('id', { selector: 'text=热榜', timeoutMs: 5000 }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(gotSel, 'text=热榜');
    assert.equal(body.ok, true);
    assert.equal(body.appeared, true);
    assert.equal(body.dumps, 2);
  });
test('wait_idle 用树 hash 静默判定（参数透传门面）', async () => {
    const seen = [];
    const device = makeFakeDevice();
    device.waitIdle = async (o) => { seen.push(o); return { stable: true, dumps: 2 }; };
    const ctx = makeCtx({ device });
    const tool = buildTools(ctx).find((t) => t.name === 'wait_idle');
    const r = await tool.execute('id1', { timeoutMs: 15000 }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(body.ok, true);
    assert.equal(body.stable, true);
    assert.equal(seen[0].quiet, 2, '默认 quiet=2（§10）');
    assert.equal(seen[0].intervalMs, undefined, '间隔改用门面默认（200ms，§16 优化：原 600ms 每次多等约 0.4s）');
    assert.equal(seen[0].timeoutMs, 15000);
  });

  test('net_profile 校验档位并记账', async () => {
    const events = [];
    const recorder = makeFakeRecorder();
    recorder.addNetworkEvent = (e) => events.push(e);
    const ctx = makeCtx({ recorder });
    const tool = buildTools(ctx).find((t) => t.name === 'net_profile');
    const bad = await tool.execute('id1', { profile: '5.5g' }, undefined, undefined, {});
    assert.equal(getContent(bad).ok, false);
    const good = await tool.execute('id1', { profile: '3g' }, undefined, undefined, {});
    assert.equal(getContent(good).ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].profile, '3g');
  });

  test('assert_no_crash 结果进 ctx.assertions', async () => {
    const ctx = makeCtx();
    const tool = buildTools(ctx).find((t) => t.name === 'assert_no_crash');
    const r = await tool.execute('id1', { expectedPackage: 'com.lgdg.fourt' }, undefined, undefined, {});
    assert.equal(getContent(r).passed, true);
    assert.equal(ctx.assertions.length, 1);
  });
});

// —— screen 工具返回图片 ——
describe('perception tools', () => {
  test('screen 返回 image + 前台 + 分辨率', async () => {
    const ctx = makeCtx();
    const tool = buildTools(ctx).find((t) => t.name === 'screen');
    const r = await tool.execute('id1', {}, undefined, undefined, {});
    const img = r.content.find((c) => c.type === 'image');
    assert.ok(img, '包含图片内容');
    assert.equal(img.mimeType, 'image/png');
    const meta = JSON.parse(r.content.find((c) => c.type === 'text').text);
    assert.deepEqual(meta.size, { w: 720, h: 1280 });
    assert.equal(meta.foreground.package, 'com.lgdg.fourt');
  });

  test('uitree 支持 clickableOnly 过滤与截断', async () => {
    const ctx = makeCtx();
    const tool = buildTools(ctx).find((t) => t.name === 'uitree');
    const r = await tool.execute('id1', { clickableOnly: true, maxNodes: 10 }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(body.ok, true);
    assert.ok(body.nodes.every((n) => n.clickable));
  });

  test('locate 走坐标缓存 upsert（§1.5，新键=步骤身份）', async () => {
    const store = makeFakeStore();
    const ctx = makeCtx({ store });
    ctx.currentStepKey = { caseId: 'c1', stepIndex: 3 };
    ctx.locateOrdinal = 0;
    const tool = buildTools(ctx).find((t) => t.name === 'locate');
    const r = await tool.execute('id1', { target: '电子相册' }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(body.ok, true);
    await ctx.locateWithCache.flush(); // 攒批写盘后断言
    const rows = store.read('locate_cache');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'c1::3::0::电子相册', '新键 = caseId::stepIndex::locateOrdinal::target');
    assert.deepEqual(rows[0].bounds, [512, 760, 704, 880]);
    assert.equal(rows[0].caseId, 'c1');
    assert.equal(rows[0].locateOrdinal, 0);
  });

  test('动作工具（tap/long_press/input）也走坐标缓存，不再绕过（真机验证：曾致命中率仅 3%）', async () => {
    const store = makeFakeStore();
    const ctx = makeCtx({ store });
    // 模拟"同一步骤内重跑"：步骤身份固定、ordinal 归零 → 第二次应命中 hint
    ctx.currentStepKey = { caseId: 'c1', stepIndex: 0 };
    const tools = buildTools(ctx);
    let locateCalls = 0;
    let lastHints = null;
    ctx.device.locate = async (target, hints) => {
      locateCalls++;
      lastHints = hints;
      return { ok: true, bounds: [512, 760, 704, 880], center: [608, 820], strategy: hints?.hintBounds ? 'cache' : 'exact_text', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: { text: '电子相册', resourceId: '', contentDesc: '', cls: 'C', clickable: true }, error: null };
    };
    const tap = tools.find((t) => t.name === 'tap');
    ctx.locateOrdinal = 0;
    await tap.execute('id1', { target: '电子相册' }, undefined, undefined, {});
    ctx.locateOrdinal = 0;   // 重跑同一步骤，ordinal 归零 → 键相同 → 命中
    await tap.execute('id2', { target: '电子相册' }, undefined, undefined, {});
    assert.equal(locateCalls, 2);
    assert.ok(lastHints.hintBounds, '【关键】同一步骤重跑时应带上缓存 hint');
    assert.deepEqual(lastHints.hintBounds, [512, 760, 704, 880]);
  });

  test('locate 与 tap 共享同一缓存实例（ctx.locateWithCache）', async () => {
    const store = makeFakeStore();
    const ctx = makeCtx({ store });
    buildTools(ctx);
    assert.equal(typeof ctx.locateWithCache, 'function', 'buildTools 应注入共享定位函数');
  });

  test('flattenNodes 深度优先 + matchSelector', () => {
    const tree = [makeNode(0, 'a', 'C1', '', [0, 0, 1, 1], true, '', [makeNode(1, 'b', 'C2', 'r:id/1', [0, 1, 2, 2])])];
    const flat = flattenNodes(tree);
    assert.equal(flat.length, 2);
    assert.equal(matchSelector(flat[1], 'text=b'), true);
    assert.equal(matchSelector(flat[1], 'resourceId=r:id/1'), true);
    assert.equal(matchSelector(flat[0], 'class=C1'), true);
    assert.equal(matchSelector(flat[0], 'text=z'), false);
  });
});

// —— ai.js 单测（mock fetch，不真连） ——
describe('ai helper', () => {
  test('repairJson：剥围栏/截大括号/尾逗号', () => {
    assert.deepEqual(repairJson('```json\n[{"a":1},]\n```'), [{ a: 1 }]);
    assert.deepEqual(repairJson('前置说明 {"a": {"b": 2}} 后缀'), { a: { b: 2 } });
  });

  test('createChatClient 注入 fetchImpl（不真连）', async () => {
    let called = 0;
    const chat = createChatClient({
      url: 'https://mock.api/v1', key: 'k', model: 'm',
      fetchImpl: async (url, init) => {
        called++;
        assert.equal(url, 'https://mock.api/v1/chat/completions');
        assert.ok(init.headers.authorization.includes('k'));
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":1}' } }] }) };
      },
    });
    const text = await chat('hi');
    assert.equal(text, '{"ok":1}');
    assert.equal(called, 1);
  });

  test('extractJson 失败重试 1 次后标 partial', async () => {
    let n = 0;
    const chat = async () => { n++; return n === 1 ? '不是JSON' : '[{"v":2}]'; };
    const r = await extractJson(chat, 'q');
    assert.equal(r.partial, false);
    assert.deepEqual(r.data, [{ v: 2 }]);
    const chat2 = async () => '仍然不是JSON';
    const r2 = await extractJson(chat2, 'q');
    assert.equal(r2.partial, true);
    assert.equal(r2.data, null);
  });
});

// —— path 冒烟：recorder 契约形状 ——
describe('contract shapes', () => {
  test('recorder 步骤 handle.end 契约', async () => {
    const ended = [];
    const recorder = {
      ...makeFakeRecorder(),
      startStep(type, target) { return { end(o = {}) { ended.push({ type, target, ...o }); } }; },
    };
    const ctx = makeCtx({ recorder });
    const tool = buildTools(ctx).find((t) => t.name === 'terminate');
    const r = await tool.execute('id1', { packageName: 'com.x' }, undefined, undefined, {});
    // 断言被测对象本身：terminate 结果形状 + 记账链路（旧版两条恒真断言已删）
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.ok, true);
    assert.deepEqual(ended.map((e) => e.type), ['terminate']);
    assert.equal(ended[0].result, 'ok');
  });
});

test('net_profile 工具切网后 ctx.stateMutations 有记录（§2.6）', async () => {
  const ctx = makeCtx({});
  ctx.stateMutations = [];
  const tool = buildTools(ctx).find((t) => t.name === 'net_profile');
  await tool.execute('id1', { profile: '2g' }, undefined, undefined, {});
  assert.equal(ctx.stateMutations.length, 1);
  assert.equal(ctx.stateMutations[0].to, '2g');
  assert.equal(ctx.stateMutations[0].kind, 'net');
});

test('tap 无弹窗时不误触授权按钮（弹窗检查零副作用）', async () => {
  const store = makeFakeStore();
  const ctx = makeCtx({ store });
  ctx.opts = { yes: true };
  let allowTouched = false;
  ctx.device.foreground = async () => ({ package: 'com.droidcust', activity: 'Main' });
  ctx.device.dumpTree = async () => ({ nodes: [], hash: 'h', dumpMs: 1, fromCache: false });
  const origLocate = ctx.device.locate;
  ctx.device.locate = async (t) => { if (t === '允许' || t === '始终允许') allowTouched = true; return origLocate(t); };
  const tap = buildTools(ctx).find((t) => t.name === 'tap');
  const r = await tap.execute('id1', { target: '首页' }, undefined, undefined, {});
  assert.equal(allowTouched, false, '无弹窗时不应触碰授权按钮');
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.ok, true, '正常点击仍成功');
});

test('tap 遇系统弹窗：先关闭弹窗，再执行原点击', async () => {
  const store = makeFakeStore();
  const ctx = makeCtx({ store });
  ctx.opts = { yes: true };
  let fgCalls = 0;
  let dismissTapped = null;
  ctx.device.foreground = async () => {
    fgCalls++;
    return fgCalls === 1
      ? { package: 'com.google.android.permissioncontroller', activity: 'GrantPermissionsActivity' }
      : { package: 'com.droidcust', activity: 'Main' };
  };
  ctx.device.dumpTree = async () => ({ nodes: [], hash: 'h', dumpMs: 1, fromCache: false });
  // locate：只有"允许"命中弹窗按钮；其余（含 dismissDialog 先试的"始终允许"）都不命中，
  // 从而走优先级链到"允许"（避免测试桩因默认 locate 返回 bounds 而假命中）
  ctx.device.locate = async (t) => (t === '允许'
    ? { ok: true, bounds: [0, 0, 10, 10], center: [5, 5], strategy: 'exact_text', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: null }
    : { ok: false, bounds: null, center: null, strategy: 'none', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: '未命中' });
  ctx.device.tap = async (b) => { dismissTapped = b; return { ok: true, latencyMs: 1, error: null }; };
  const tool = buildTools(ctx).find((t) => t.name === 'tap');
  await tool.execute('id1', { target: '电子相册' }, undefined, undefined, {});
  assert.deepEqual(dismissTapped, [0, 0, 10, 10], '应先点"允许"关闭弹窗');
});

test('scroll 工具 until=edge：走边界跳转（不传 distancePct）', async () => {
  const ctx = makeCtx({});
  ctx.opts = { yes: true };
  const seen = [];
  ctx.device.scroll = async (dir, o) => { seen.push({ dir, o }); return { scrolls: o.max ?? 5, changed: true }; };
  const tool = buildTools(ctx).find((t) => t.name === 'scroll');
  const r = await tool.execute('id1', { direction: 'down', until: 'edge' }, undefined, undefined, {});
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].dir, 'down');
  assert.equal(seen[0].o.max, 20, 'until 时 max 默认 20');
});

test('scroll 工具 distancePct：透传给 device.scroll', async () => {
  const ctx = makeCtx({});
  ctx.opts = { yes: true };
  let captured = null;
  ctx.device.scroll = async (dir, o) => { captured = { dir, o }; return { scrolls: 1, changed: true }; };
  const tool = buildTools(ctx).find((t) => t.name === 'scroll');
  await tool.execute('id1', { direction: 'down', distancePct: 75 }, undefined, undefined, {});
  assert.equal(captured.o.distancePct, 75);
});

test('buildCacheKey：caseId::stepIndex::locateOrdinal::target（§2.1 评审 C1 重设计）', async () => {
  const { buildCacheKey } = await import('../src/tools/locate-cache.js');
  assert.equal(
    buildCacheKey({ caseId: 's2-profile', stepIndex: 3, locateOrdinal: 0, target: '热榜' }),
    's2-profile::3::0::热榜',
  );
});

test('locate 用步骤身份做键：连续两次同 target 得到两行不同键（ordinal 递增）', async () => {
  const store = makeFakeStore();
  const ctx = makeCtx({ store });
  ctx.currentStepKey = { caseId: 'c1', stepIndex: 0 };
  ctx.locateOrdinal = 0;
  const locate = buildTools(ctx).find((t) => t.name === 'locate');
  await locate.execute('a', { target: '热榜' }, undefined, undefined, {});
  await locate.execute('b', { target: '热榜' }, undefined, undefined, {});
  await ctx.locateWithCache.flush(); // 攒批写盘后断言
  const rows = store.read('locate_cache');
  assert.equal(rows.length, 2, '两次定位应两行（不互相覆盖）');
  assert.notEqual(rows[0].key, rows[1].key);
  assert.ok(rows[0].key.includes('c1::0::0::热榜'), `第一行键应为 c1::0::0::热榜，实际 ${rows[0].key}`);
  assert.ok(rows[1].key.includes('c1::0::1::热榜'), `第二行键应为 c1::0::1::热榜，实际 ${rows[1].key}`);
});

test('locate 缓存：screenSize 不一致 → 判 miss（跨设备失效防护）', async () => {
  const store = makeFakeStore();
  // 预置一行：不同分辨率
  store.upsert('locate_cache', 'key', [{
    key: 'c1::0::0::热榜', bounds: [1, 2, 3, 4], identity: { text: '热榜' }, screenSize: { w: 999, h: 999 }, hits: 1, lastHitAt: 1,
  }], {});
  const ctx = makeCtx({ store });
  ctx.currentStepKey = { caseId: 'c1', stepIndex: 0 };
  ctx.locateOrdinal = 0;
  let hintsPassed = 'UNSET';
  const orig = ctx.device.locate;
  ctx.device.locate = async (t, hints) => { hintsPassed = hints?.hintBounds; return orig(t, hints); };
  const locate = buildTools(ctx).find((t) => t.name === 'locate');
  await locate.execute('a', { target: '热榜' }, undefined, undefined, {});
  assert.equal(hintsPassed, null, '分辨率不符时不应传 hint（判 miss）');
});

test('scroll 工具 until=<selector>：透传 scrollUntil，found=false 转 error', async () => {
  const ctx = makeCtx({});
  ctx.opts = { yes: true };
  let captured = null;
  ctx.device.scrollUntil = async (sel, o) => { captured = { sel, o }; return { scrolls: 3, found: true, changed: true }; };
  const tool = buildTools(ctx).find((t) => t.name === 'scroll');
  const r = await tool.execute('id1', { direction: 'down', until: 'text*=搜索', max: 6 }, undefined, undefined, {});
  const body = JSON.parse(r.content[0].text);
  assert.equal(captured.sel, 'text*=搜索');
  assert.equal(captured.o.max, 6);
  assert.equal(body.ok, true);
  assert.equal(body.found, true);
  // found=false → ok:false + error（调用方可区分"到底未见"）
  ctx.device.scrollUntil = async () => ({ scrolls: 12, found: false, changed: true });
  const r2 = await tool.execute('id2', { until: 'text*=不存在' }, undefined, undefined, {});
  const b2 = JSON.parse(r2.content[0].text);
  assert.equal(b2.ok, false);
  assert.match(b2.error, /仍不可见/);
});

test('tap_each_row 工具：参数透传 + maxRounds 交由设备层/profile 兜底 + device 抛错转结构化', async () => {
  const ctx = makeCtx({});
  ctx.opts = { yes: true };
  let captured = null;
  ctx.device.tapEachRow = async (o) => { captured = o; return { rounds: 1, taps: 1, verified: 1, unverified: 0, done: true, bottom: false, error: null, skipped: [] }; };
  const tool = buildTools(ctx).find((t) => t.name === 'tap_each_row');
  await tool.execute('id1', { rows: 're:Q', tap: 'text=opt', verifyColor: '#FF0000' }, undefined, undefined, {});
  // 工具层不钉死 maxRounds：缺省交给设备层（profile 可提供），显式值原样透传
  assert.equal(captured.maxRounds, undefined, '未传时不得覆盖设备层/profile 默认');
  assert.equal(captured.profile, undefined, '未传 profile 时不得注入');
  assert.equal(captured.verifyColor, '#FF0000');
  assert.equal(captured.verify, undefined);
  await tool.execute('id1b', { rows: 're:Q', tap: 'text=opt', maxRounds: 12, profile: 'questionnaire' }, undefined, undefined, {});
  assert.equal(captured.maxRounds, 12, '显式 maxRounds 原样透传');
  assert.equal(captured.profile, 'questionnaire', 'profile 原样透传（按需加载在设备层）');
  // device 抛错（冷启动 getSize 未就绪等）→ ok:false 结构化，不上抛
  ctx.device.tapEachRow = async () => { throw new Error('屏幕尺寸未就绪'); };
  const r = await tool.execute('id2', { rows: 're:Q', tap: 'text=opt' }, undefined, undefined, {});
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.ok, false);
  assert.match(body.error, /屏幕尺寸未就绪/);
});

// —— 视觉形态接 profile（回归：此前 profile 只在 selector 形态生效，
// visual-answer.js 另写一份缺省与 profiles/questionnaire 数值分叉） ——
test('tap_each_row 视觉形态：未知 profile 报结构化错误（不静默忽略拼写）', async () => {
  const ctx = makeCtx({ chat: async () => '' });
  ctx.modelCfg = { family: 'deepseek' };
  const tool = buildTools(ctx).find((t) => t.name === 'tap_each_row');
  const r = await tool.execute('id1', { profile: 'questinnaire' }, undefined, undefined, {});
  assert.equal(r.details.ok, false);
  assert.match(String(r.details.error), /未知 profile/);
});

test('tap_each_row 视觉形态：合法 profile 通过加载与 strategy 解析（进入主循环前置）', async () => {
  // screenSize 置 null → runVisualAnswer 在 profile 加载/timing 解析之后、首轮截图前
  // 以确定性错误返回；以此证明 profile 接线通路完好（此前该通路不存在）。
  const device = makeFakeDevice();
  device.screenSize = async () => null;
  const ctx = makeCtx({ device, chat: async () => '' });
  ctx.modelCfg = { family: 'deepseek' };
  const tool = buildTools(ctx).find((t) => t.name === 'tap_each_row');
  const r = await tool.execute('id1', { profile: 'questionnaire' }, undefined, undefined, {});
  assert.equal(String(r.details.error), 'screenSize 获取失败，无法视觉定位');
});
