// 断言提示词分流：屏幕类 vs 数据类（C-P2 修复守护）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssertPrompt, collectDatasetFacts, extractDatasetNames } from '../src/session/assert-prompt.js';

test('extractDatasetNames：从断言文本提取数据集名', () => {
  assert.deepEqual(extractDatasetNames('数据集 hotlist 中至少有3条记录且每条标题文本非空'), ['hotlist']);
  assert.deepEqual(extractDatasetNames('数据集 c4_hot_all 至少 5 条，数据集 c4_digest 非空'), ['c4_hot_all', 'c4_digest']);
  assert.deepEqual(extractDatasetNames('列表按时间倒序'), []);
});

test('collectDatasetFacts：注入行数与样本', async () => {
  const writes = new Map([['hotlist', 7]]);
  const store = { read: async (name) => name === 'hotlist' ? [{ title: 'A' }, { title: 'B' }] : [] };
  const facts = await collectDatasetFacts('数据集 hotlist 中至少有3条', writes, store);
  assert.ok(facts.includes('hotlist'));
  assert.ok(facts.includes('7'));
  assert.ok(facts.includes('样本'));
});

test('collectDatasetFacts：无数据集引用 → null', async () => {
  const facts = await collectDatasetFacts('列表按时间倒序', new Map(), { read: async () => [] });
  assert.equal(facts, null);
});

test('buildAssertPrompt：屏幕类断言保持原口径', () => {
  const p = buildAssertPrompt({ stepText: '列表按时间倒序', fgNote: '', datasetFacts: null });
  assert.ok(p.includes('只依据随附的当前屏幕截图'));
  assert.ok(p.includes('不要调用任何工具'));
});

test('buildAssertPrompt：数据类断言注入数据集事实', () => {
  const p = buildAssertPrompt({ stepText: '数据集 hotlist 至少3条', fgNote: '', datasetFacts: '【数据集事实】hotlist=7条，样本：[{"title":"A"}]' });
  assert.ok(p.includes('数据集事实'));
  assert.ok(p.includes('hotlist=7条'));
  assert.ok(p.includes('不要调用任何工具'));
});