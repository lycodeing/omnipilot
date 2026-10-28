// 定位策略链（§5.1）：精确→正则/包含→resource_id→class_index→VLM；clickable 兜底（§5.4.2）；hint 校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseXmlDump, truncateAtHierarchyEnd, treeHash } from '../src/device/uitree.js';
import { createLocator, parseTarget } from '../src/device/locate.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/ui-dump.xml', import.meta.url));
const nodes = parseXmlDump(truncateAtHierarchyEnd(readFileSync(FIXTURE, 'utf8')));
const hash = treeHash(nodes);

function makeLocator({ fromCache = false } = {}) {
  const probeFile = join(mkdtempSync(join(tmpdir(), 'ask-locate-')), 'family-probe.json');
  const vlmCache = new Map();
  const locate = createLocator({
    getTree: async () => ({ nodes, hash, dumpMs: 5, fromCache }),
    getSize: async () => ({ w: 720, h: 1280 }),
    screencap: async () => Buffer.alloc(8),
    vlmCache,
    probeFile,
  });
  return { locate, vlmCache, probeFile };
}

test('parseTarget：各 selector 形式', () => {
  assert.deepEqual(parseTarget('text=电子相册#index=1'), { kind: 'exact_text', text: '电子相册', index: 1 });
  assert.deepEqual(parseTarget('id=com.lgdg:id/album'), { kind: 'resource_id', id: 'com.lgdg:id/album', index: 0 });
  assert.deepEqual(parseTarget('class=android.widget.TextView#index=2'), { kind: 'class_index', cls: 'android.widget.TextView', index: 2 });
  assert.deepEqual(parseTarget('desc=返回'), { kind: 'contains', text: '返回', field: 'contentDesc' });
  assert.deepEqual(parseTarget('re:相.*册'), { kind: 'regex', pattern: '相.*册' });
  assert.deepEqual(parseTarget('电子相册'), { kind: 'auto', text: '电子相册' });
});

test('策略1 精确文本：命中并按 §5.4.2 解析到可点祖先', async () => {
  const { locate } = makeLocator();
  const r = await locate('电子相册');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'exact_text');
  assert.deepEqual(r.bounds, [16, 140, 704, 300], 'clickable=false → 最近可点祖先 item0');
  assert.deepEqual(r.center, [360, 220]);
  assert.match(r.warning, /可点/);
  assert.deepEqual(r.identity, { text: '', contentDesc: '', resourceId: 'com.lgdg:id/album_item', cls: 'android.widget.LinearLayout', clickable: true });
});

test('策略1：本就可点的节点直接返回，无警告', async () => {
  const { locate } = makeLocator();
  const r = await locate('新建相册');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'exact_text');
  assert.deepEqual(r.bounds, [200, 980, 520, 1060]);
  assert.equal(r.warning, undefined);
});

test('策略2 正则/包含：短文本命中长 text', async () => {
  const { locate } = makeLocator();
  const r = await locate('电子');
  assert.equal(r.strategy, 'regex');
  assert.deepEqual(r.bounds, [16, 140, 704, 300]);
  const d = await locate('desc=返回');
  assert.equal(d.strategy, 'regex');
  assert.deepEqual(d.bounds, [16, 72, 80, 120], 'content-desc 命中 btn_back');
});

test('策略3 resource-id：id 全名或短名均命中', async () => {
  const { locate } = makeLocator();
  const r1 = await locate('album_name');
  assert.equal(r1.strategy, 'resource_id');
  assert.deepEqual(r1.bounds, [16, 140, 704, 300]);
  const r2 = await locate('id=album_date');
  assert.equal(r2.strategy, 'resource_id');
  assert.deepEqual(r2.bounds, [16, 140, 704, 300], '日期节点不可点 → 解析到 item0');
});

test('策略3 class+index：类名与 #index 选取', async () => {
  const { locate } = makeLocator();
  const r1 = await locate('class=android.widget.Button');
  assert.equal(r1.strategy, 'class_index');
  assert.deepEqual(r1.bounds, [200, 980, 520, 1060]);
  const r2 = await locate('class=android.widget.TextView#index=1');
  assert.equal(r2.strategy, 'class_index');
  assert.deepEqual(r2.bounds, [16, 140, 704, 300], '第 2 个 TextView 是 电子相册 → 可点祖先 item0');
  const r3 = await locate('android.widget.Button');
  assert.equal(r3.strategy, 'class_index', 'auto 目标形如类名也走 class_index');
});

test('策略5 失败：返回候选列表让模型改写描述', async () => {
  const { locate } = makeLocator();
  const r = await locate('不存在的元素xyz');
  assert.equal(r.ok, false);
  assert.equal(r.bounds, null);
  assert.match(r.error, /未找到目标/);
  assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 8);
  assert.ok(r.candidates.every((c) => c.text || c.contentDesc));
});

test('策略1 多命中：按面积最小优先', async () => {
  const probeFile = join(mkdtempSync(join(tmpdir(), 'ask-locate-')), 'p.json');
  const small = { index: 0, text: '按钮', cls: 'B', resourceId: '', contentDesc: '', clickable: true, enabled: true, bounds: [100, 500, 200, 600], center: [150, 550], children: [] };
  const big = { index: 1, text: '按钮', cls: 'B', resourceId: '', contentDesc: '', clickable: true, enabled: true, bounds: [0, 0, 700, 100], center: [350, 50], children: [] };
  const locate = createLocator({
    getTree: async () => ({ nodes: [small, big], hash: 'x', dumpMs: 0, fromCache: false }),
    getSize: async () => ({ w: 720, h: 1280 }),
    screencap: async () => Buffer.alloc(0),
    vlmCache: new Map(),
    probeFile,
  });
  const r = await locate('按钮');
  assert.deepEqual(r.bounds, [100, 500, 200, 600]);
});

test('hint 跨执行坐标缓存：bounds+identity 双重校验命中 → strategy=cache', async () => {
  const { locate } = makeLocator();
  const first = await locate('电子相册');
  const again = await locate('电子相册', { hintBounds: first.bounds, hintIdentity: first.identity });
  assert.equal(again.strategy, 'cache');
  assert.deepEqual(again.bounds, first.bounds);
  assert.deepEqual(again.identity, first.identity);
});

test('hint 校验失败（identity 不符 / 缺 identity / bounds 无节点）→ 弃用走正常链', async () => {
  const { locate } = makeLocator();
  const bad1 = await locate('电子相册', { hintBounds: [16, 140, 704, 300], hintIdentity: { text: '别的', cls: 'X' } });
  assert.equal(bad1.strategy, 'exact_text');
  const bad2 = await locate('电子相册', { hintBounds: [16, 140, 704, 300] });
  assert.equal(bad2.strategy, 'exact_text');
  const bad3 = await locate('电子相册', { hintBounds: [1, 2, 3, 4], hintIdentity: { text: '电子相册', cls: 'android.widget.TextView' } });
  assert.equal(bad3.strategy, 'exact_text');
});

test('VLM 兜底（注入函数）：family 换算 + 结果缓存命中不再调模型', async () => {
  const { locate } = makeLocator();
  let calls = 0;
  const vlm = async ({ png, size, target }) => {
    calls++;
    assert.ok(png && size && target);
    return { raw: [250, 300, 500, 600], family: 'glm' };
  };
  const r1 = await locate('蓝色圆形按钮', { vlm });
  assert.equal(r1.ok, true);
  assert.equal(r1.strategy, 'vlm');
  assert.equal(r1.vlmCacheHit, false);
  assert.deepEqual(r1.bounds, [180, 384, 360, 768], '0-1000·xy 换算');
  assert.deepEqual(r1.center, [270, 576]);
  const r2 = await locate('蓝色圆形按钮', { vlm });
  assert.equal(r2.strategy, 'vlm');
  assert.equal(r2.vlmCacheHit, true, '同页面同 target 复用模型结果');
  assert.equal(calls, 1);
  // 树内可匹配的目标不触发 VLM
  await locate('新建相册', { vlm });
  assert.equal(calls, 1);
});

test('VLM：无 family 且无探测缓存 → 拒绝不猜（§5.5.3）', async () => {
  const { locate } = makeLocator();
  const r = await locate('蓝色圆形按钮', { vlm: async () => ({ raw: [250, 300, 500, 600] }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /坐标策略/);
});

test('VLM：换算越界 → 告警失败（family 约定用错的典型表现）', async () => {
  const { locate } = makeLocator();
  const r = await locate('蓝色圆形按钮', { vlm: async () => ({ raw: [500, 500, 1500, 1500], family: 'glm' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /越界/);
});

test('treeCacheHit / dumpMs 透传；空 target 报错', async () => {
  const { locate } = makeLocator({ fromCache: true });
  const r = await locate('新建相册');
  assert.equal(r.treeCacheHit, true);
  assert.equal(r.dumpMs, 5);
  const empty = await locate('  ');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /target 为空/);
});

test('clickable=false 且无祖先可点 → 向下找可点子孙（§5.4.2 顺序 3）', async () => {
  const probeFile = join(mkdtempSync(join(tmpdir(), 'ask-locate-')), 'p.json');
  const child = { index: 0, text: '', cls: 'C', resourceId: 'x:id/ok', contentDesc: '', clickable: true, enabled: true, bounds: [10, 10, 90, 90], center: [50, 50], children: [], parent: null };
  const parent = { index: 0, text: '确定', cls: 'P', resourceId: '', contentDesc: '', clickable: false, enabled: true, bounds: [0, 0, 100, 100], center: [50, 50], children: [child], parent: null };
  Object.defineProperty(child, 'parent', { value: parent, enumerable: false });
  const locate = createLocator({
    getTree: async () => ({ nodes: [parent], hash: 'x', dumpMs: 0, fromCache: false }),
    getSize: async () => ({ w: 720, h: 1280 }),
    screencap: async () => Buffer.alloc(0),
    vlmCache: new Map(),
    probeFile,
  });
  const r = await locate('确定');
  assert.deepEqual(r.bounds, [10, 10, 90, 90], '解析到可点子节点');
});
