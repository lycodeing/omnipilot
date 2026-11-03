// 动作计划缓存单测：读写往返 / 持久化 / LRU 截断 / 损坏重建 / 键随步骤文本变化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planKey, createPlanCache } from '../src/session/plan-cache.js';

test('planKey：同参数同键；步骤文本/序号/用例任一变化即换键', () => {
  const a = planKey({ caseId: 'c1', stepIndex: 3, stepText: '点击健康自测' });
  assert.equal(a, planKey({ caseId: 'c1', stepIndex: 3, stepText: '点击健康自测' }));
  assert.notEqual(a, planKey({ caseId: 'c1', stepIndex: 3, stepText: '点击卒中评估' }));
  assert.notEqual(a, planKey({ caseId: 'c1', stepIndex: 4, stepText: '点击健康自测' }));
  assert.notEqual(a, planKey({ caseId: 'c2', stepIndex: 3, stepText: '点击健康自测' }));
});

test('put/get 往返 + 跨实例持久化（同 stateDir 重建后仍可读）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-pc-'));
  const c1 = createPlanCache(dir);
  c1.put(planKey({ caseId: 'c', stepIndex: 1, stepText: 'x' }), { tool: 'tap', params: { target: 'text=健康' } });
  const c2 = createPlanCache(dir); // 新实例 = 新 run（模拟二次执行）
  const hit = c2.get(planKey({ caseId: 'c', stepIndex: 1, stepText: 'x' }));
  assert.deepEqual(hit?.params, { target: 'text=健康' });
  assert.equal(hit?.tool, 'tap');
  // 落盘文件真实存在且可解析
  const raw = JSON.parse(readFileSync(join(dir, 'plan-cache.json'), 'utf8'));
  assert.equal(raw.version, 1);
});

test('LRU 截断：超出 maxEntries 淘汰最旧条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-pc2-'));
  const c = createPlanCache(dir, { maxEntries: 3 });
  for (let i = 0; i < 5; i++) c.put(`k${i}`, { tool: 'tap', params: {} });
  const c2 = createPlanCache(dir, { maxEntries: 3 });
  assert.equal(c2.size(), 3);
  assert.equal(c2.get('k0'), null, '最旧的被淘汰');
  assert.equal(c2.get('k1'), null, '次旧的被淘汰');
  assert.ok(c2.get('k2'));
  assert.ok(c2.get('k3'));
  assert.ok(c2.get('k4'), '最新的被保留');
});

test('缓存文件损坏 → 重建空表（不抛错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-pc3-'));
  writeFileSync(join(dir, 'plan-cache.json'), '{broken json!!');
  const c = createPlanCache(dir);
  assert.equal(c.size(), 0);
  c.put('k', { tool: 'tap', params: {} });
  assert.equal(c.get('k')?.tool, 'tap');
});

test('delete 删除并落盘（回放失败后由调用方删除失效条目）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-pc4-'));
  const c = createPlanCache(dir);
  c.put('k', { tool: 'tap', params: {} });
  c.delete('k');
  assert.equal(c.get('k'), null);
  assert.equal(createPlanCache(dir).get('k'), null);
});
