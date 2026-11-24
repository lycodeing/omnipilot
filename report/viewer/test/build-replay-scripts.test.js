import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTION_TYPES, typeLabel, buildReplayScripts } from '../src/utils/buildReplayScripts.js';
import { DUR } from '../src/utils/playback-math.js';

const fixturePath = fileURLToPath(new URL('../fixtures/sample-dump.json', import.meta.url));
const dump = JSON.parse(readFileSync(fixturePath, 'utf8'));

test('ACTION_TYPES：从引擎词表派生（REPLAY_ACTION_TYPES），覆盖全部设备写动作', () => {
  // 词表单一来源 src/tools/vocab.js；此处显式列出以锁定编排语义（改动须经由词表 + 引擎同步测试）
  assert.deepEqual(ACTION_TYPES, [
    'tap', 'point_tap', 'long_press', 'input', 'swipe', 'scroll',
    'key', 'launch', 'terminate', 'tap_each_row',
  ]);
  // 历史旧名（实测 0 次落盘）不再混入
  assert.ok(!ACTION_TYPES.includes('back'));
  assert.ok(!ACTION_TYPES.includes('home'));
});

test('typeLabel：词表标签；未收录类型（如 MCP 动态工具名）原样回退', () => {
  assert.equal(typeLabel('tap'), '点击');
  assert.equal(typeLabel('input'), '输入');
  assert.equal(typeLabel('swipe'), '滑动');
  assert.equal(typeLabel('point_tap'), '坐标点击'); // 引擎专用工具也落 run.json，须有标签
  assert.equal(typeLabel('tap_each_row'), '逐行点击');
  assert.equal(typeLabel('assert'), '断言'); // 历史兼容（旧版引擎出现过 1 次）
  assert.equal(typeLabel('screen'), '截图');
  assert.equal(typeLabel('sleep'), '等待');
  assert.equal(typeLabel('data_extract'), '提取');
  assert.equal(typeLabel('key'), '按键');
  assert.equal(typeLabel('long_press'), '长按');
  assert.equal(typeLabel('answer_row'), '作答');
  assert.equal(typeLabel('mcp__some__dynamic_tool'), 'mcp__some__dynamic_tool');
});

test('夹具编排：tap+bounds → [img, insight, img(pointer)]', () => {
  const scripts = buildReplayScripts(dump.executions[0]);
  const [s0, s1, s2] = scripts;
  // task 0：带 bounds 的 tap
  assert.equal(s0.kind, 'img');
  assert.equal(s0.durationMs, DUR.stillAfterInsight);
  assert.equal(s0.screenshotId, 'shot-0001');
  assert.equal(s0.taskId, '0');
  assert.equal(s0.title, '点击');
  assert.equal(s0.subTitle, '电子相册');
  assert.equal(s0.errorMessage, null);
  assert.equal(s0.pointer, undefined);
  assert.equal(s0.bounds, undefined);
  assert.equal(s1.kind, 'insight');
  assert.equal(s1.durationMs, DUR.locate);
  assert.deepEqual(s1.bounds, [512, 760, 704, 880]);
  assert.equal(s2.kind, 'img');
  assert.equal(s2.durationMs, DUR.action);
  assert.deepEqual(s2.bounds, [512, 760, 704, 880]);
  assert.deepEqual(s2.pointer, { x: 608, y: 820 }); // bounds 中心
});

test('夹具编排：key 无 bounds → 仅 spinning-pointer（无图 img 被跳过）', () => {
  const scripts = buildReplayScripts(dump.executions[0]);
  const s3 = scripts[3];
  assert.equal(s3.taskId, '1');
  assert.equal(s3.kind, 'spinning-pointer');
  assert.equal(s3.durationMs, DUR.spinningPointer);
  assert.equal(s3.screenshotId, null);
  assert.equal(s3.title, '按键'); // 词表标签（此前词表缺 key，裸回退）
  assert.equal(s3.subTitle, 'back');
  assert.equal(s3.pointer, undefined);
});

test('夹具编排：assert → [img(still)]；screenshot+bounds → [img, insight]', () => {
  const scripts = buildReplayScripts(dump.executions[0]);
  const s4 = scripts[4];
  assert.equal(s4.taskId, '2');
  assert.equal(s4.kind, 'img');
  assert.equal(s4.durationMs, DUR.still);
  assert.equal(s4.screenshotId, 'shot-0002');
  assert.equal(s4.title, '断言');
  assert.equal(s4.subTitle, '列表按时间倒序'); // param.text

  const [s5, s6] = scripts.slice(5, 7);
  assert.equal(s5.taskId, '3');
  assert.equal(s5.kind, 'img');
  assert.equal(s5.durationMs, DUR.stillAfterInsight);
  assert.equal(s6.kind, 'insight');
  assert.deepEqual(s6.bounds, [0, 0, 720, 1280]);
});

test('failed 任务：序列末尾附加 errorMessage 帧', () => {
  const scripts = buildReplayScripts(dump.executions[0]);
  const [s7, s8, s9] = scripts.slice(7, 10);
  assert.equal(s7.taskId, '4');
  assert.equal(s7.kind, 'spinning-pointer');
  assert.equal(s7.screenshotId, 'shot-0004'); // 无 bounds 但有截图
  assert.equal(s8.kind, 'img');
  assert.equal(s8.durationMs, DUR.action);
  assert.equal(s8.errorMessage, null);
  assert.equal(s9.kind, 'img');
  assert.equal(s9.durationMs, DUR.still);
  assert.equal(s9.errorMessage, 'locate_miss_x3: 未找到目标元素');
  assert.equal(s9.screenshotId, 'shot-0004');
});

test('End 段：taskId=null、复用最后一张截图、title=结束、subTitle=run 名', () => {
  const scripts = buildReplayScripts(dump.executions[0]);
  const end = scripts[scripts.length - 1];
  assert.equal(end.taskId, null);
  assert.equal(end.end, true);
  assert.equal(end.kind, 'img');
  assert.equal(end.durationMs, DUR.lastFrame);
  assert.equal(end.screenshotId, 'shot-0004');
  assert.equal(end.title, '结束');
  assert.equal(end.subTitle, '相册列表');
  assert.equal(end.errorMessage, null);
  // 全序列无 0 帧脚本、无独立 pointer kind
  assert.ok(scripts.every((s) => s.durationMs > 0));
  assert.ok(scripts.every((s) => s.kind !== 'pointer'));
  assert.equal(scripts.length, 11);
});

test('空输入：仅 End 段', () => {
  for (const exec of [undefined, null, {}, { name: '空跑', tasks: [] }]) {
    const [end] = buildReplayScripts(exec);
    assert.equal(end.taskId, null);
    assert.equal(end.end, true);
    assert.equal(end.screenshotId, null);
    assert.equal(end.subTitle, exec?.name ?? '');
  }
});

test('整组无图：产出单张 screenshotId=null 的 img(still)', () => {
  const exec = { name: 'x', tasks: [{ taskId: '9', type: 'sleep', param: { ms: 1000 } }] };
  const scripts = buildReplayScripts(exec);
  assert.equal(scripts.length, 2); // 兜底帧 + End
  assert.equal(scripts[0].kind, 'img');
  assert.equal(scripts[0].durationMs, DUR.still);
  assert.equal(scripts[0].screenshotId, null);
  assert.equal(scripts[0].title, '等待');
});

test('failed 且无图：兜底帧后仍附加 errorMessage 帧', () => {
  const exec = {
    name: 'x',
    tasks: [{ taskId: '2', type: 'assert', status: 'failed', param: { text: '检查' }, errorMessage: 'boom' }],
  };
  const scripts = buildReplayScripts(exec);
  assert.equal(scripts.length, 3); // 兜底帧 + failed 帧 + End
  assert.equal(scripts[0].kind, 'img');
  assert.equal(scripts[0].screenshotId, null);
  assert.equal(scripts[1].errorMessage, 'boom');
  assert.equal(scripts[1].screenshotId, null);
});

test('指针中心坐标四舍五入', () => {
  const exec = {
    name: 'x',
    tasks: [{
      taskId: '0', type: 'tap', status: 'finished', param: { target: 'a' },
      locate: { strategy: 'exact_text', bounds: [1, 1, 2, 2], screenshotId: 's1' },
    }],
  };
  const scripts = buildReplayScripts(exec);
  assert.deepEqual(scripts[2].pointer, { x: 2, y: 2 }); // (1+2)/2=1.5 → 2，动作帧才带指针
  assert.equal(scripts[0].pointer, undefined);
});
