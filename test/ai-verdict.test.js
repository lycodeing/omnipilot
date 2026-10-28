// 断言判词解析（src/tools/ai.js parseVerdict）：run 的 assert 步骤 → 退出码 1 的依据

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../src/tools/ai.js';

test('JSON 判词优先', () => {
  assert.deepEqual(parseVerdict('{"passed": true, "reason": "列表按时间倒序"}'),
    { passed: true, reason: '列表按时间倒序' });
  assert.equal(parseVerdict('{"passed": false, "reason": "白屏"}').passed, false);
  assert.equal(parseVerdict('true').passed, true);
});

test('中文关键词判词：不通过优先于通过字样', () => {
  assert.equal(parseVerdict('断言不通过，页面白屏').passed, false);
  assert.equal(parseVerdict('未通过：列表为空').passed, false);
  assert.equal(parseVerdict('列表按时间倒序展示，验证通过').passed, true);
  assert.equal(parseVerdict('页面显示正常，断言成立').passed, true);
});

test('英文与兜底', () => {
  assert.equal(parseVerdict('Assertion failed: element not found').passed, false);
  assert.equal(parseVerdict('assertion passed').passed, true);
  assert.equal(parseVerdict('模型输出无法判断成败的一长段话').passed, false, '无法判定时保守判失败');
  assert.equal(parseVerdict('').passed, false);
  assert.equal(parseVerdict(null).passed, false);
});
