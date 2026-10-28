// 缓存三态（§5.0.7）：fresh/dirty/void + TTL 4000ms + 动作置脏 + 统计
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeCache, CACHE_TTL_MS } from '../src/device/cache.js';

test('默认 TTL 为 4000ms', () => {
  assert.equal(CACHE_TTL_MS, 4000);
  const c = new TreeCache();
  c.set({ nodes: [], hash: 'h' });
  assert.equal(c.state, 'fresh');
  c.invalidate();
  assert.equal(c.state, 'void');
});

test('TTL 到期：fresh → void（§5.0.7 V→X）', () => {
  let t = 1000;
  const c = new TreeCache({ now: () => t });
  c.set({ nodes: ['n'], hash: 'h1' });
  assert.equal(c.state, 'fresh');
  assert.equal(c.peek().hash, 'h1');
  t += 4001;
  assert.equal(c.state, 'void');
  assert.equal(c.peek(), null);
});

test('TTL 到期：dirty 也作废（§5.0.7 D→X）', () => {
  let t = 1000;
  const c = new TreeCache({ now: () => t });
  c.set({ nodes: [], hash: 'h1' });
  c.markDirty();
  assert.equal(c.state, 'dirty');
  t += 4001;
  assert.equal(c.state, 'void');
});

test('动作置脏：dirty 读不到，须重新 dump（§5.0.7 V→D）', () => {
  const c = new TreeCache();
  c.set({ nodes: [], hash: 'h1' });
  c.markDirty();
  assert.equal(c.state, 'dirty');
  assert.equal(c.peek(), null, 'dirty 态 peek 必须为 null（读树先 dump）');
  c.set({ nodes: [], hash: 'h2' });
  assert.equal(c.state, 'fresh');
});

test('失败回退强制 void：void 上 markDirty 仍是 void', () => {
  const c = new TreeCache();
  c.set({ nodes: [], hash: 'h1' });
  c.invalidate();
  assert.equal(c.state, 'void');
  c.markDirty();
  assert.equal(c.state, 'void', 'void 已不可信任，无需再标脏');
});

test('stats：dumps/hits/misses/dirtyResets', () => {
  let t = 1000;
  const c = new TreeCache({ now: () => t });
  c.recordMiss();
  c.recordDump();
  c.set({ nodes: [], hash: 'h1' });
  c.recordHit();
  c.markDirty(); // fresh → dirty：1 次 dirtyResets
  c.markDirty(); // dirty → dirty：不重复计
  c.invalidate(); // 失败回退
  c.markDirty(); // void：不计
  assert.deepEqual(c.stats(), { dumps: 1, hits: 1, misses: 1, dirtyResets: 1 });
  assert.notEqual(c.stats(), c.stats(), '每次返回副本');
  t += 1;
});
