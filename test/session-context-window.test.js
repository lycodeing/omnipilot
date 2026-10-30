import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneStepHistory, buildStepDigest, STEP_DIGEST_PREFIX } from '../src/session/context-window.js';
import { parseCaseText } from '../src/session/case.js';

const u = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] });
const a = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
const sys = { role: 'system', content: [{ type: 'text', text: 'SYS' }] };

test('pruneStepHistory：未超窗口 → 不动', () => {
  const msgs = [sys, u('s1'), a('r1'), u('s2'), a('r2')];
  const r = pruneStepHistory(msgs, [1, 1, 1], { keepSteps: 3, digest: 'D' });
  assert.equal(r.changed, false);
  assert.equal(msgs.length, 5);
  // 恰好等于窗口也不动
  const r2 = pruneStepHistory(msgs, [1, 1, 1, 1], { keepSteps: 4, digest: 'D' });
  assert.equal(r2.changed, false);
});

test('pruneStepHistory：超窗口 → 删最旧段，插入整体描述，system 保持首位', () => {
  // 4 步各 2 条消息；system + 8 条
  const msgs = [sys, u('s1'), a('r1'), u('s2'), a('r2'), u('s3'), a('r3'), u('s4'), a('r4')];
  const r = pruneStepHistory(msgs, [2, 2, 2, 2], { keepSteps: 3, digest: 'DIGEST' });
  assert.equal(r.changed, true);
  assert.equal(r.removed, 2); // 删掉最旧 1 段（2 条）
  assert.equal(msgs.length, 8); // 9 - 2 + 1(digest)
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content[0].text, 'DIGEST');
  // 保留的是最近 3 段：s2..s4
  const texts = msgs.map((m) => m.content?.[0]?.text ?? '');
  assert.ok(texts.includes('s2') && texts.includes('s4'));
  assert.ok(!texts.includes('s1') || texts[1] === 'DIGEST' ? !texts.slice(2).includes('s1') : true);
});

test('pruneStepHistory：无 system 消息时 digest 插在 0 位', () => {
  const msgs = [u('s1'), a('r1'), u('s2'), a('r2'), u('s3'), a('r3'), u('s4'), a('r4')];
  const r = pruneStepHistory(msgs, [2, 2, 2, 2], { keepSteps: 3, digest: 'D' });
  assert.equal(r.changed, true);
  assert.equal(msgs[0].content[0].text, 'D');
});

test('pruneStepHistory：keepSteps=Infinity（all）→ 由调用方跳过，函数本身按段数判断', () => {
  const msgs = [sys, u('s1'), u('s2'), u('s3'), u('s4')];
  const r = pruneStepHistory(msgs, [1, 1, 1, 1], { keepSteps: Infinity, digest: 'D' });
  assert.equal(r.changed, false);
  assert.equal(msgs.length, 5);
});

test('pruneStepHistory：计数异常（负数/NaN）→ 保守不动', () => {
  const msgs = [sys, u('a'), u('b'), u('c'), u('d'), u('e')];
  const r1 = pruneStepHistory(msgs, [1, 1, -1, 1, 1], { keepSteps: 3, digest: 'D' });
  assert.equal(r1.changed, false);
  const r2 = pruneStepHistory(msgs, [1, 1, NaN, 1, 1], { keepSteps: 3, digest: 'D' });
  assert.equal(r2.changed, false);
  assert.equal(msgs.length, 6);
});

test('pruneStepHistory：含空段（引擎步 0 消息）照常工作', () => {
  // 5 步：#1 引擎(0) #2-#5 各 2 条；keep 3 → 删 #1(0条)+#2(2条)
  const msgs = [sys, u('s2'), a('r2'), u('s3'), a('r3'), u('s4'), a('r4'), u('s5'), a('r5')];
  const r = pruneStepHistory(msgs, [0, 2, 2, 2, 2], { keepSteps: 3, digest: 'D' });
  assert.equal(r.changed, true);
  assert.equal(r.removed, 2);
  const texts = msgs.map((m) => m.content?.[0]?.text ?? '');
  assert.ok(!texts.includes('s2'));
  assert.ok(texts.includes('s3') && texts.includes('s5'));
});

test('pruneStepHistory：digest 为空 → 用兜底文案', () => {
  const msgs = [u('s1'), a('r1'), u('s2'), a('r2'), u('s3'), a('r3'), u('s4'), a('r4')];
  pruneStepHistory(msgs, [2, 2, 2, 2], { keepSteps: 3, digest: '' });
  assert.ok(msgs[0].content[0].text.includes(STEP_DIGEST_PREFIX));
});

test('buildStepDigest：进度 + 最近步骤行 + 断言计数 + 失败列表', () => {
  const d = buildStepDigest({
    caseName: '健康自测',
    caseTotal: 27,
    steps: [
      { index: 0, type: 'aiWaitFor', target: '导航栏', result: 'ok' },
      { index: 1, type: 'tap', target: '生活', result: 'ok' },
      { index: 2, type: 'tap', target: '健康', result: 'failed', error: 'LOCATE_MISS' },
    ],
    assertions: [{ text: '标题可见', passed: true }, { text: '按钮可见长文本断言…', passed: false }],
    vars: { m4_hot: '热榜第一' },
  });
  assert.ok(d.includes(STEP_DIGEST_PREFIX));
  assert.ok(d.includes('《健康自测》'));
  assert.ok(d.includes('共 27 步'));
  assert.ok(d.includes('已完成 3 步'));
  assert.ok(d.includes('#1 tap 生活 ✓'));
  assert.ok(d.includes('#2 tap 健康 ✗ LOCATE_MISS'));
  assert.ok(d.includes('断言 1/2 通过'));
  assert.ok(d.includes('失败：'));
  assert.ok(d.includes('m4_hot=热榜第一'));
});

test('buildStepDigest：只保留最近 keepLines 行', () => {
  const steps = Array.from({ length: 20 }, (_, i) => ({ index: i, type: 'tap', target: `t${i}`, result: 'ok' }));
  const d = buildStepDigest({ caseName: 'X', caseTotal: 40, steps, assertions: [], keepLines: 8 });
  assert.ok(d.includes('#19'));
  assert.ok(!d.includes('#11'));
});

test('parseCaseText：顶层 context 键解析（数字/all/非法）', () => {
  const c1 = parseCaseText('name: T\ncontext: 5\nsteps:\n  - aiTap: X\n');
  assert.equal(c1.context, 5);
  const c2 = parseCaseText('name: T\ncontext: all\nsteps:\n  - aiTap: X\n');
  assert.equal(c2.context, 'all');
  const c3 = parseCaseText('name: T\ncontext: abc\nsteps:\n  - aiTap: X\n');
  assert.equal(c3.context, undefined);
  assert.ok(c3.warnings.some((w) => /context/.test(w)));
  const c4 = parseCaseText('name: T\ncontext: 全部\nsteps:\n  - aiTap: X\n');
  assert.equal(c4.context, 'all');
});

test('pruneStepHistory：keepFrom==start（全历史恰为窗口）→ 不动', () => {
  const msgs = [sys, u('s1'), a('r1'), u('s2'), a('r2')];
  const r = pruneStepHistory(msgs, [2, 2, 2, 2], { keepSteps: 2, digest: 'D' });
  assert.equal(r.changed, false);
  assert.equal(msgs.length, 5);
});

test('pruneStepHistory：保留窗内全 0 段（连续引擎步）→ 保守不动，不整库折叠', () => {
  // 1 个 ai 步(2 条) + 4 个引擎步(0 条)：k=5>3，tail=0 → keepFrom=length → 不得删光
  const msgs = [sys, u('ai'), a('r'), u('e1'), u('e2'), u('e3'), u('e4')];
  const r = pruneStepHistory(msgs, [2, 0, 0, 0, 0], { keepSteps: 3, digest: 'D' });
  assert.equal(r.changed, false);
  assert.equal(msgs.length, 7);
});

test('buildStepDigest：datasets Map 渲染"已落库数据集"行；vars Map 渲染变量行', () => {
  const d = buildStepDigest({
    caseName: 'C', caseTotal: 5, steps: [], assertions: [],
    datasets: new Map([['hot', 3], ['meta', 1]]),
    vars: new Map([['m4_hot', [{ title: 'x' }]]]),
  });
  assert.ok(d.includes('已落库数据集：hot=3条、meta=1条'));
  assert.ok(d.includes('m4_hot=[{"title":"x"}]'));
});
