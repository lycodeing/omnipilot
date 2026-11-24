// 场景 profile（skills 式按需加载）单测：内置名/边界钳制/未知名报错/自定义目录加载。
// profile 的**设计边界**必须锁住：只允许时序调优参数，不得夹带选择器（否则会变成
// "硬编码某 App"的后门，破坏引擎的通用性）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile, PROFILE_NAMES } from '../src/device/profiles/index.js';

test('内置 profile：questionnaire / form 可加载，只含时序参数', async () => {
  assert.ok(PROFILE_NAMES.includes('questionnaire'));
  assert.ok(PROFILE_NAMES.includes('form'));
  for (const name of PROFILE_NAMES) {
    const p = await loadProfile(name);
    assert.ok(Number.isFinite(p.settleMs), `${name}.settleMs 应为数字`);
    assert.ok(Number.isFinite(p.maxRounds), `${name}.maxRounds 应为数字`);
    // 不得出现任何选择器类字段（rows/tap/stopWhen/selector…）
    for (const k of Object.keys(p)) {
      assert.ok(['settleMs', 'maxRounds', 'verifyColor', 'readyTimeoutMs'].includes(k), `profile 出现非法字段: ${k}`);
    }
  }
});

test('未知 profile：明确报错（不静默忽略拼写错误）', async () => {
  await assert.rejects(() => loadProfile('questinnaire'), /未知 profile/);
  await assert.rejects(() => loadProfile(''), /profile 名为空/);
});

test('数值钳制：settleMs / maxRounds 越界被夹到安全区间', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-prof-'));
  writeFileSync(join(dir, 'wild.js'), 'export default { settleMs: 999999, maxRounds: 0, verifyColor: "#FF0000" };\n');
  const p = await loadProfile('wild', { dir });
  assert.equal(p.settleMs, 5000, 'settleMs 上限 5000');
  assert.equal(p.maxRounds, 1, 'maxRounds 下限 1');
  assert.equal(p.verifyColor, '#FF0000');
});

test('自定义目录：ASK_PROFILE_DIR 下同名模块可加载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-prof2-'));
  writeFileSync(join(dir, 'myform.js'), 'export default { settleMs: 300, maxRounds: 42 };\n');
  const p = await loadProfile('myform', { dir });
  assert.deepEqual(p, { settleMs: 300, maxRounds: 42 });
});

test('自定义目录缺失该模块：报错带文件路径（便于排查）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-prof3-'));
  await assert.rejects(() => loadProfile('nope', { dir }), /profile 加载失败/);
});

// —— resolveTiming：tap_each_row 两形态（selector/视觉）共用的时序优先级 ——
// 统一前：视觉形态没接 profile，settle/maxRounds/verifyColor 在 visual-answer.js 另写一份
// 缺省，与 questionnaire 预设数值分叉。此组测试锁住"显式参数 > profile > 内置缺省"。
test('resolveTiming：无 profile 走内置缺省（与历史视觉形态行为一致）', async () => {
  const { resolveTiming } = await import('../src/device/profiles/index.js');
  assert.deepEqual(resolveTiming({}, null), { maxRounds: 60, verifyColor: 'auto', settleMs: 700 });
  assert.deepEqual(resolveTiming(), { maxRounds: 60, verifyColor: 'auto', settleMs: 700 });
});

test('resolveTiming：profile 提供时序，显式参数优先于 profile', async () => {
  const { resolveTiming } = await import('../src/device/profiles/index.js');
  const prof = await loadProfile('questionnaire'); // settleMs:700 maxRounds:80 verifyColor:'auto'
  // 全部来自 profile
  assert.deepEqual(resolveTiming({}, prof), { maxRounds: 80, verifyColor: 'auto', settleMs: 700 });
  // 显式参数压过 profile
  assert.equal(resolveTiming({ maxRounds: 12 }, prof).maxRounds, 12);
  assert.equal(resolveTiming({ verifyColor: '#FF0000' }, prof).verifyColor, '#FF0000');
  // form 预设的 settleMs 生效
  const form = await loadProfile('form');
  assert.equal(resolveTiming({}, form).settleMs, 400);
  // 非法 maxRounds（NaN/负数/小数）钳到 [1,∞) 的行为与旧 device 实现一致
  assert.equal(resolveTiming({ maxRounds: NaN }, prof).maxRounds, 60, 'NaN 回退缺省');
  assert.equal(resolveTiming({ maxRounds: -5 }, prof).maxRounds, 1, '负数钳到 1');
  assert.equal(resolveTiming({ maxRounds: 7.9 }, prof).maxRounds, 7, '小数截断');
});
