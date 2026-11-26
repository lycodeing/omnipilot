// 步骤类型词表单一来源（src/tools/vocab.js）的一致性守护。
// vocab 刻意保持纯数据（viewer 浏览端可 import），与真实注册表的同步只能靠测试锁：
// 引擎新增工具/记账步而词表漏补 → 这里红，避免新类型在报告端静默降级成静帧。
import test from 'node:test';
import assert from 'node:assert/strict';

import { STEP_LABELS, ENGINE_STEP_TYPES, REPLAY_ACTION_TYPES } from '../src/tools/vocab.js';
import { EXPECTED_TOOLS } from '../src/tools/index.js';
import { ENGINE_ONLY_TOOLS } from '../src/tools/action.js';

test('契约工具（§10 清单）逐一有标签', () => {
  for (const name of EXPECTED_TOOLS) {
    assert.ok(Object.hasOwn(STEP_LABELS, name), `词表缺契约工具: ${name}`);
  }
});

test('引擎专用工具（point_tap 等）有标签——它不进 EXPECTED_TOOLS 但会落 run.json', () => {
  for (const name of ENGINE_ONLY_TOOLS) {
    assert.ok(Object.hasOwn(STEP_LABELS, name), `词表缺引擎专用工具: ${name}`);
  }
});

test('引擎直记账步（sleep/net/aiWaitFor/aiAssert/answer_row）有标签', () => {
  // 生成点：bin/ask.js sleep/net 分支、aiWaitFor 分支、aiAssert 判定段；src/tools/action.js onQuestion
  for (const t of ENGINE_STEP_TYPES) {
    assert.ok(Object.hasOwn(STEP_LABELS, t), `词表缺引擎直记账步: ${t}`);
  }
  // aiAssert 判定步已直记账（startStep('aiAssert')），必须进引擎步清单——漏登记则上方遍历守不到它
  assert.ok(ENGINE_STEP_TYPES.includes('aiAssert'), 'ENGINE_STEP_TYPES 缺 aiAssert（bin/ask.js 判定段已直记账）');
});

test('回放动作类型 ⊆ 词表；且不含从未落盘的旧名（back/home/screenshot/extract）', () => {
  for (const t of REPLAY_ACTION_TYPES) {
    assert.ok(Object.hasOwn(STEP_LABELS, t), `REPLAY_ACTION_TYPES 引用未收录类型: ${t}`);
  }
  for (const stale of ['back', 'home', 'screenshot', 'extract', 'query', 'waitFor']) {
    assert.ok(!REPLAY_ACTION_TYPES.includes(stale), `旧名 ${stale} 不应出现在回放动作类型`);
    assert.ok(!Object.hasOwn(STEP_LABELS, stale), `旧名 ${stale} 不应进词表（历史实测 0 次落盘）`);
  }
});

test('每个标签都是非空字符串', () => {
  for (const [type, label] of Object.entries(STEP_LABELS)) {
    assert.equal(typeof label, 'string', `${type} 标签应为字符串`);
    assert.ok(label.trim().length > 0, `${type} 标签不应为空`);
  }
});
