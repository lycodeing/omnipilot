// lint 规则测试（§13.4）：八条规则 + 行内豁免，error/warn 各有样本
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lintCaseText, ruleIds } from '../src/lint/rules.js';

describe('lint rules', () => {
  test('规则集恰好九条（评审 #4 新增 target-package-missing）', () => {
    assert.equal(ruleIds.length, 9);
  });

  // —— error 1：像素坐标 ——
  test('E1 pixel-coords：input tap 坐标 / 文本含像素坐标', () => {
    const r = lintCaseText('steps:\n  - ai: input tap 512 760\n  - ai: 点击坐标 608,820');
    assert.ok(r.some((i) => i.rule === 'pixel-coords' && i.level === 'error' && i.line === 2));
    assert.ok(r.some((i) => i.rule === 'pixel-coords' && i.level === 'error' && i.line === 3));
  });

  // 守护：步骤命令对象形态 { x: N, y: N } 须被拦（两个数之间隔着 "y:"，裸数字对正则不命中），
  // 否则坐标点击会 lint 报 0 error 却静默失效。
  test('E1b pixel-coords：坐标步 { x, y } 被拦（旧写法漏网回归）', () => {
    const r = lintCaseText('steps:\n  - tap: { x: 135, y: 2115 }');
    assert.ok(r.some((i) => i.rule === 'pixel-coords' && i.level === 'error' && i.line === 2));
    // 紧凑与引号形态同样拦
    assert.ok(lintCaseText('steps:\n  - tap: {x:1,y:2}').some((i) => i.rule === 'pixel-coords'));
    assert.ok(lintCaseText('steps:\n  - tap: { "x": 10, "y": 20 }').some((i) => i.rule === 'pixel-coords'));
  });

  // 逃生口（DESIGN.md:449）：顶层 allowCoords: true 时坐标行放行；未声明/写 false 仍拦。
  test('E1c pixel-coords：顶层 allowCoords 才放行坐标步', () => {
    const allowed = lintCaseText('allowCoords: true\nsteps:\n  - tap: { x: 135, y: 2115 }');
    assert.equal(allowed.filter((i) => i.rule === 'pixel-coords').length, 0, '声明后放行');
    assert.ok(lintCaseText('allowCoords: false\nsteps:\n  - tap: { x: 1, y: 2 }').some((i) => i.rule === 'pixel-coords'), 'false 不放行');
    assert.ok(lintCaseText('steps:\n  - tap: { x: 1, y: 2 }').some((i) => i.rule === 'pixel-coords'), '未声明不放行');
    // 逃生口只覆盖"坐标步骤"：ai: 文本里的裸 adb 命令仍拦（声明 allowCoords 不该放过它）
    const still = lintCaseText('allowCoords: true\nsteps:\n  - ai: input tap 512 760');
    assert.ok(still.some((i) => i.rule === 'pixel-coords' && i.level === 'error'), '裸 adb 命令不受逃生口豁免');
  });

  // —— error 2：平台片段模式 ——
  test('E2 platform-fragment：顶层 android: / tasks:', () => {
    const r = lintCaseText('steps:\n  - ai: x\nandroid: 1\ntasks: []');
    const hits = r.filter((i) => i.rule === 'platform-fragment');
    assert.equal(hits.length, 2);
    assert.ok(hits.every((i) => i.level === 'error'));
  });

  // Task 22：平台片段规则平台无关化，ios:/web: 也命中（android:/tasks: 旧样本保持）
  test('E2 platform-fragment：顶层 android:/ios:/web:/tasks: 均拦', () => {
    const r = lintCaseText('steps:\n  - ai: x\nandroid: 1\nios: 1\nweb: 1\ntasks: []');
    const hits = r.filter((i) => i.rule === 'platform-fragment');
    assert.equal(hits.length, 4);
  });

  // —— error 3：引用未定义变量 ——
  test('E3 undefined-var：未定义 ${var} 报错；定义过的放行', () => {
    const bad = lintCaseText('steps:\n  - ai: 输入 ${password}');
    assert.ok(bad.some((i) => i.rule === 'undefined-var' && i.level === 'error'));
    const ok = lintCaseText('steps:\n  - data_extract: album\n  - ai: 输入 ${album}');
    assert.equal(ok.filter((i) => i.rule === 'undefined-var').length, 0);
  });

  // —— error 4：滚动目标不可达 ——
  test('E4 unreachable-scroll：直到最后一个 / 让所有都显示', () => {
    const r = lintCaseText('steps:\n  - ai: 向下滚动直到最后一个相册\n  - ai: 让所有相册都显示出来');
    assert.ok(r.some((i) => i.rule === 'unreachable-scroll' && i.level === 'error' && i.line === 2));
    assert.ok(r.some((i) => i.rule === 'unreachable-scroll' && i.level === 'error' && i.line === 3));
  });

  // —— error 5：aiNumeral / aiInput 嵌套 ——
  test('E5 bad-ai-func：aiNumeral 不存在、aiInput 嵌套对象', () => {
    const r = lintCaseText('steps:\n  - ai: aiNumeral("123")\n  - ai: aiInput({value: "x"})');
    const hits = r.filter((i) => i.rule === 'bad-ai-func');
    assert.equal(hits.length, 2);
    assert.ok(hits.every((i) => i.level === 'error'));
  });

  // —— warn 1：推断式断言 ——
  test('W1 inferred-assert：已进入 XX 页', () => {
    const r = lintCaseText('steps:\n  - aiAssert: 已进入电子相册页');
    assert.ok(r.some((i) => i.rule === 'inferred-assert' && i.level === 'warn' && i.line === 2));
  });

  // —— warn 2：全称量词/颜色/已变化 ——
  test('W2 universal-assert：每个/所有/红色/已变化', () => {
    const r = lintCaseText('steps:\n  - aiAssert: 每个卡片都有封面\n  - aiAssert: 按钮是红色的\n  - aiAssert: 列表已变化');
    const hits = r.filter((i) => i.rule === 'universal-assert');
    assert.ok(hits.length >= 2);
    assert.ok(hits.every((i) => i.level === 'warn'));
  });

  // —— warn 3：点击后紧跟断言无等待 ——
  test('W3 assert-after-click：点击后紧跟断言且无 wait_idle/sleep', () => {
    const bad = lintCaseText('steps:\n  - ai: 点击登录\n  - aiAssert: 按钮存在');
    assert.ok(bad.some((i) => i.rule === 'assert-after-click' && i.level === 'warn' && i.line === 3));
    const good = lintCaseText('steps:\n  - ai: 点击登录\n  - ai: wait_idle\n  - aiAssert: 按钮存在');
    assert.equal(good.filter((i) => i.rule === 'assert-after-click').length, 0);
  });

  // —— 行内豁免（§13.4 末行） ——
  test('豁免须有理由：有理由则抑制，无理由豁免无效', () => {
    const withReason = lintCaseText('steps:\n  - ai: input tap 512 760  # ask-lint: allow pixel-coords 老版本页面无控件，仅此一次');
    assert.equal(withReason.filter((i) => i.rule === 'pixel-coords').length, 0, '有效豁免不产生 finding');

    const noReason = lintCaseText('steps:\n  - ai: input tap 512 760  # ask-lint: allow pixel-coords');
    const hit = noReason.find((i) => i.rule === 'pixel-coords');
    assert.ok(hit, '无理由豁免无效');
    assert.equal(hit.level, 'error');
    assert.ok(hit.message.includes('豁免无效'));

    const otherRule = lintCaseText('steps:\n  - ai: input tap 512 760  # ask-lint: allow unreachable-scroll 理由A');
    assert.ok(otherRule.some((i) => i.rule === 'pixel-coords' && i.level === 'error'), '豁免只作用于指定规则');
  });

  test('返回形状统一 {level,rule,message,line}，行号从 1 计', () => {
    // 用断言行做夹具：推断式/全称类规则只对断言行生效（步骤描述文本不属断言判据）
    const r = lintCaseText('# 注释行\n\nsteps:\n  - aiAssert: 已进入设置页');
    assert.equal(r.length, 1);
    assert.deepEqual(Object.keys(r[0]).sort(), ['level', 'line', 'message', 'rule']);
    assert.equal(r[0].line, 4);
  });
});

test('unreachable-scroll：有显式停止条件（until/maxScrolls）时不拦（§2.4.5）', () => {
  const explicit = 'steps:\n  - scroll:\n      until: edge\n';
  assert.equal(lintCaseText(explicit).filter((i) => i.rule === 'unreachable-scroll').length, 0);
  const nl = 'steps:\n  - ai: 一直往下滚直到最后\n';
  assert.ok(lintCaseText(nl).some((i) => i.rule === 'unreachable-scroll'), '纯 NL 仍拦');
});

test('assert-after-click：否定语境剥离（不要/请勿/严禁）不误报，正例仍报', () => {
  const pos = lintCaseText('steps:' + String.fromCharCode(10) + '  - ai: 点击按钮后返回列表页' + String.fromCharCode(10) + '  - aiAssert: 屏幕正常');
  assert.ok(pos.some((i) => i.rule === 'assert-after-click' && i.level === 'warn'), '相邻点击+断言应报 warn');
  for (const neg of ['不要点击按钮', '请勿点击任何内容', '严禁点击文章、图片、宫格']) {
    const r = lintCaseText('steps:' + String.fromCharCode(10) + '  - ai: ' + neg + String.fromCharCode(10) + '  - aiAssert: 屏幕正常');
    assert.equal(r.filter((f) => f.id === 'assert-after-click').length, 0, neg + ' 不应报');
  }
});

test('lint 与 parser 对 allowCoords 位置判定一致：steps 之后的 allowCoords 不放行', () => {
  // 守护：lint 与 parser 须一致只在 steps 前缀里找 allowCoords——
  // 否则 lint 放行、run 时硬失败，作者按 lint 修完仍跑不起来。
  const text = ['steps:', '  - tap: {x: 135, y: 2115}', 'allowCoords: true'].join('\n');
  const findings = lintCaseText(text);
  assert.ok(findings.some((f) => f.rule === 'pixel-coords' && f.level === 'error'),
    'steps 之后的 allowCoords 不应放行坐标步');
});

test('lint 与 parser 对 allowCoords 位置判定一致：steps 之前的 allowCoords 放行', () => {
  const text = ['allowCoords: true', 'steps:', '  - tap: {x: 135, y: 2115}'].join('\n');
  const findings = lintCaseText(text);
  assert.ok(!findings.some((f) => f.rule === 'pixel-coords'),
    'steps 之前的 allowCoords 应放行坐标步');
});
