// 步骤图标类别与词表的漂移守护（评审发现项）。
//
// STEP_LABELS 是步骤类型的单一来源（src/tools/vocab.js），ICON_CATEGORY 是 viewer
// 的图标映射。两者此前无守护：新增步骤类型时图标会静默落 default 圆点，无人察觉。
// 本测试把关系锁死——ICON_CATEGORY 的键必须是 STEP_LABELS 的子集；词表里未映射
// 图标的类型以**显式白名单**记录（新增类型时须来此登记，避免静默降级）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { STEP_LABELS } from '../../../src/tools/vocab.js'
import { ICON_CATEGORY } from '../src/components/icon-category.js'

test('ICON_CATEGORY 的键集 ⊆ STEP_LABELS（不得引用词表外的幽灵类型）', () => {
  for (const k of Object.keys(ICON_CATEGORY)) {
    assert.ok(Object.hasOwn(STEP_LABELS, k), `ICON_CATEGORY 含词表外类型 "${k}"`);
  }
});

test('ICON_CATEGORY 的值均为已声明的图标类别', () => {
  const valid = new Set(['tap', 'input', 'swipe', 'pen', 'nav', 'camera', 'crosshair', 'clock', 'extract', 'assert']);
  for (const [k, v] of Object.entries(ICON_CATEGORY)) {
    assert.ok(valid.has(v), `类型 "${k}" 的图标类别 "${v}" 未声明`);
  }
});

test('词表中未映射图标的类型须在白名单登记（防静默落 default）', () => {
  // 已知且有意不映射（落 default 圆点）的类型。新增步骤类型时：
  //   - 要么在 icon-category.js 补图标映射；
  //   - 要么在此登记，明确接受 default 降级。
  // 二者都不做 → 本测试失败，逼迫显式决策。
  const acceptedDefault = new Set(['assert_no_crash']);
  const unmapped = Object.keys(STEP_LABELS).filter((k) => !Object.hasOwn(ICON_CATEGORY, k));
  for (const k of unmapped) {
    assert.ok(acceptedDefault.has(k),
      `步骤类型 "${k}" 未映射图标且未在白名单登记——请在 icon-category.js 补映射或在此登记`);
  }
  // 反向：白名单里不该留已映射的类型（防登记腐烂）
  for (const k of acceptedDefault) {
    assert.ok(!Object.hasOwn(ICON_CATEGORY, k),
      `白名单里的 "${k}" 已补图标映射，应从 acceptedDefault 移除`);
  }
});
