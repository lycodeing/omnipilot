// 思考控制定档测试（§18 / docs/THINKING-CONTROL.md）：
// 能关闭思考的模型 → 'none'；不能关闭的（GLM-5.3 系）→ 'low'。无设备、无网络。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildThinkingLevelMap } from '../src/session/model.js';

describe('thinking level map（模型思考控制定档）', () => {
  test('可关闭思考的模型：最低档为 none', () => {
    for (const name of ['deepseek-v4.1-flash', 'qwen3.8-flash', 'qwen3.7-plus', 'minimax-m3.1-flash']) {
      const m = buildThinkingLevelMap(name);
      assert.equal(m.off, 'none', `${name} 应可关闭`);
      assert.equal(m.minimal, 'none');
      assert.equal(m.low, 'none');
    }
  });

  test('GLM-5.3 系不能关闭思考：最低档降为 low', () => {
    for (const name of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'GLM-5.3-Flash']) {
      const m = buildThinkingLevelMap(name);
      assert.equal(m.off, 'low', `${name} 不能关闭，最低应为 low`);
      assert.equal(m.minimal, 'low');
      assert.equal(m.low, 'low');
    }
  });

  test('中/高档一律为 null（钳制，禁止自发长思考）', () => {
    for (const name of ['deepseek-v4.1-flash', 'glm-5.3-flash', 'qwen3.8-flash']) {
      const m = buildThinkingLevelMap(name);
      for (const k of ['medium', 'high', 'xhigh', 'max']) {
        assert.equal(m[k], null, `${name}.${k} 应为 null`);
      }
    }
  });

  test('不误伤其他 glm 版本（仅 5.3 系不可关闭）', () => {
    const m = buildThinkingLevelMap('glm-4.6');
    assert.equal(m.off, 'none', 'GLM-4.5+ 支持 thinking:disabled，应可关闭');
    const m2 = buildThinkingLevelMap('glm-5.2');
    assert.equal(m2.off, 'none', 'GLM-5.2 传 none 可放弃思考，应可关闭');
  });
});
