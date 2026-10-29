// lint 规则测试（§13.4）：八条规则 + 行内豁免，error/warn 各有样本
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lintCaseText, ruleIds } from '../src/lint/rules.js';

describe('lint rules', () => {
  test('规则集恰好八条', () => {
    assert.equal(ruleIds.length, 8);
  });

  // —— error 1：像素坐标 ——
  test('E1 pixel-coords：input tap 坐标 / 文本含像素坐标', () => {
    const r = lintCaseText('steps:\n  - do: input tap 512 760\n  - do: 点击坐标 608,820');
    assert.ok(r.some((i) => i.rule === 'pixel-coords' && i.level === 'error' && i.line === 2));
    assert.ok(r.some((i) => i.rule === 'pixel-coords' && i.level === 'error' && i.line === 3));
  });

  // —— error 2：平台片段模式 ——
  test('E2 platform-fragment：顶层 android: / tasks:', () => {
    const r = lintCaseText('steps:\n  - do: x\nandroid: 1\ntasks: []');
    const hits = r.filter((i) => i.rule === 'platform-fragment');
    assert.equal(hits.length, 2);
    assert.ok(hits.every((i) => i.level === 'error'));
  });

  // —— error 3：引用未定义变量 ——
  test('E3 undefined-var：未定义 ${var} 报错；定义过的放行', () => {
    const bad = lintCaseText('steps:\n  - do: 输入 ${password}');
    assert.ok(bad.some((i) => i.rule === 'undefined-var' && i.level === 'error'));
    const ok = lintCaseText('steps:\n  - data_extract: album\n  - do: 输入 ${album}');
    assert.equal(ok.filter((i) => i.rule === 'undefined-var').length, 0);
  });

  // —— error 4：滚动目标不可达 ——
  test('E4 unreachable-scroll：直到最后一个 / 让所有都显示', () => {
    const r = lintCaseText('steps:\n  - do: 向下滚动直到最后一个相册\n  - do: 让所有相册都显示出来');
    assert.ok(r.some((i) => i.rule === 'unreachable-scroll' && i.level === 'error' && i.line === 2));
    assert.ok(r.some((i) => i.rule === 'unreachable-scroll' && i.level === 'error' && i.line === 3));
  });

  // —— error 5：aiNumeral / aiInput 嵌套 ——
  test('E5 bad-ai-func：aiNumeral 不存在、aiInput 嵌套对象', () => {
    const r = lintCaseText('steps:\n  - do: aiNumeral("123")\n  - do: aiInput({value: "x"})');
    const hits = r.filter((i) => i.rule === 'bad-ai-func');
    assert.equal(hits.length, 2);
    assert.ok(hits.every((i) => i.level === 'error'));
  });

  // —— warn 1：推断式断言 ——
  test('W1 inferred-assert：已进入 XX 页', () => {
    const r = lintCaseText('steps:\n  - assert: 已进入电子相册页');
    assert.ok(r.some((i) => i.rule === 'inferred-assert' && i.level === 'warn' && i.line === 2));
  });

  // —— warn 2：全称量词/颜色/已变化 ——
  test('W2 universal-assert：每个/所有/红色/已变化', () => {
    const r = lintCaseText('steps:\n  - assert: 每个卡片都有封面\n  - assert: 按钮是红色的\n  - assert: 列表已变化');
    const hits = r.filter((i) => i.rule === 'universal-assert');
    assert.ok(hits.length >= 2);
    assert.ok(hits.every((i) => i.level === 'warn'));
  });

  // —— warn 3：点击后紧跟断言无等待 ——
  test('W3 assert-after-click：点击后紧跟断言且无 wait_idle/sleep', () => {
    const bad = lintCaseText('steps:\n  - do: 点击登录\n  - assert: 按钮存在');
    assert.ok(bad.some((i) => i.rule === 'assert-after-click' && i.level === 'warn' && i.line === 3));
    const good = lintCaseText('steps:\n  - do: 点击登录\n  - do: wait_idle\n  - assert: 按钮存在');
    assert.equal(good.filter((i) => i.rule === 'assert-after-click').length, 0);
  });

  // —— 行内豁免（§13.4 末行） ——
  test('豁免须有理由：有理由则抑制，无理由豁免无效', () => {
    const withReason = lintCaseText('steps:\n  - do: input tap 512 760  # ask-lint: allow pixel-coords 老版本页面无控件，仅此一次');
    assert.equal(withReason.filter((i) => i.rule === 'pixel-coords').length, 0, '有效豁免不产生 finding');

    const noReason = lintCaseText('steps:\n  - do: input tap 512 760  # ask-lint: allow pixel-coords');
    const hit = noReason.find((i) => i.rule === 'pixel-coords');
    assert.ok(hit, '无理由豁免无效');
    assert.equal(hit.level, 'error');
    assert.ok(hit.message.includes('豁免无效'));

    const otherRule = lintCaseText('steps:\n  - do: input tap 512 760  # ask-lint: allow unreachable-scroll 理由A');
    assert.ok(otherRule.some((i) => i.rule === 'pixel-coords' && i.level === 'error'), '豁免只作用于指定规则');
  });

  test('返回形状统一 {level,rule,message,line}，行号从 1 计', () => {
    // 用断言行做夹具：推断式/全称类规则只对断言行生效（步骤描述文本不属断言判据）
    const r = lintCaseText('# 注释行\n\nsteps:\n  - assert: 已进入设置页');
    assert.equal(r.length, 1);
    assert.deepEqual(Object.keys(r[0]).sort(), ['level', 'line', 'message', 'rule']);
    assert.equal(r[0].line, 4);
  });
});

test('unreachable-scroll：有显式停止条件（until/maxScrolls）时不拦（§2.4.5）', () => {
  const explicit = 'steps:\n  - scroll:\n      until: edge\n';
  assert.equal(lintCaseText(explicit).filter((i) => i.rule === 'unreachable-scroll').length, 0);
  const nl = 'steps:\n  - do: 一直往下滚直到最后\n';
  assert.ok(lintCaseText(nl).some((i) => i.rule === 'unreachable-scroll'), '纯 NL 仍拦');
});
