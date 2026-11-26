// 上下文治理执行后端（appendContextEdit）：删除/替换/digest 注入三语义
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createContextGovernor } from '../src/session/context-governor.js';

function makeSession() {
  const sm = SessionManager.inMemory('/tmp');
  return sm;
}
const u = (t) => ({ role: 'user', content: [{ type: 'text', text: t }], timestamp: Date.now() });
const a = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }], timestamp: Date.now() });
const tc = { type: 'toolCall', id: 'c1', name: 'tap', arguments: { target: 'x' } };
const atc = () => ({ role: 'assistant', content: [tc], timestamp: Date.now(), provider: 'p', model: 'm', api: 'openai-completions', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: 'toolUse' });
const tr = () => ({ role: 'toolResult', toolCallId: 'c1', toolName: 'tap', content: [{ type: 'text', text: '{"ok":true}' }], isError: false, timestamp: Date.now() });

test('governor.foldToolHistory：旧工具轮折叠后投影无 toolCall 块、无 toolResult role', () => {
  const sm = makeSession();
  sm.appendMessage(u('q1'));
  sm.appendMessage(atc());
  sm.appendMessage(tr());
  sm.appendMessage(u('q2'));
  const gov = createContextGovernor({ sessionManager: sm });
  const r = gov.foldToolHistory();
  assert.ok(r.folded >= 2);
  const proj = sm.buildSessionProjection();
  assert.ok(!proj.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'toolCall')), '折叠后无 toolCall 块');
  assert.ok(!proj.messages.some((m) => m.role === 'toolResult'), '折叠后无 toolResult role');
});

test('governor.pruneStepHistory：超窗口删除最旧段 + digest 注入', () => {
  const sm = makeSession();
  sm.appendMessage(u('s1')); sm.appendMessage(a('r1'));
  sm.appendMessage(u('s2')); sm.appendMessage(a('r2'));
  sm.appendMessage(u('s3')); sm.appendMessage(a('r3'));
  sm.appendMessage(u('s4')); sm.appendMessage(a('r4'));
  const gov = createContextGovernor({ sessionManager: sm });
  const r = gov.pruneStepHistory([2, 2, 2, 2], { keepSteps: 3, digest: 'DIGEST' });
  assert.equal(r.changed, true);
  assert.equal(r.removed, 2);
  const proj = sm.buildSessionProjection();
  const texts = proj.messages.map((m) => Array.isArray(m.content) ? m.content.map((b) => b.text ?? '').join('') : String(m.content ?? ''));
  assert.ok(texts.some((t) => t.includes('DIGEST')), 'digest 已注入');
  assert.ok(!texts.includes('s1'), '最旧段已删除');
  assert.ok(texts.includes('s4'), '最近段保留');
});

test('governor.pruneImages：保留最近 N 张，更早替换为占位符', () => {
  const sm = makeSession();
  const img = (kb) => ({ type: 'image', mimeType: 'image/png', data: 'A'.repeat(kb * 1024) });
  sm.appendMessage({ role: 'user', content: [img(10), { type: 'text', text: 'q1' }], timestamp: Date.now() });
  sm.appendMessage({ role: 'user', content: [img(10), { type: 'text', text: 'q2' }], timestamp: Date.now() });
  sm.appendMessage({ role: 'user', content: [img(10), { type: 'text', text: 'q3' }], timestamp: Date.now() });
  sm.appendMessage({ role: 'user', content: [img(10), { type: 'text', text: 'q4' }], timestamp: Date.now() });
  const gov = createContextGovernor({ sessionManager: sm });
  const r = gov.pruneImages({ keepRecent: 3 });
  assert.equal(r.replaced, 1);
  const proj = sm.buildSessionProjection();
  const images = proj.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === 'image') : []);
  assert.equal(images.length, 3, '只保留最近 3 张');
});

test('governor 幂等：重复执行不重复删除/注入', () => {
  const sm = makeSession();
  sm.appendMessage(u('s1')); sm.appendMessage(a('r1'));
  sm.appendMessage(u('s2')); sm.appendMessage(a('r2'));
  const gov = createContextGovernor({ sessionManager: sm });
  gov.pruneStepHistory([2, 2], { keepSteps: 1, digest: 'D' });
  const n1 = sm.buildSessionProjection().messages.length;
  gov.pruneStepHistory([2, 2], { keepSteps: 1, digest: 'D' });
  const n2 = sm.buildSessionProjection().messages.length;
  assert.equal(n1, n2, '重复执行消息数不变');
});

// —— 上下文治理守护（brief 四测试之上追加）——
// 有 edit 的 entry 每次投影返回新对象，按引用匹配找不到 id 会让折叠 omit 静默失败 →
// 投影残留 role:toolResult → 请求侧 role:"tool" → 网关 400。以下用真实 finally 顺序覆盖。

const atcN = (id, name) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: {} }], timestamp: Date.now(), provider: 'p', model: 'm', api: 'openai-completions', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: 'toolUse' });
const trN = (id, name, text, extra = []) => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }, ...extra], isError: false, timestamp: Date.now() });
const BIG = JSON.stringify({ tree: 'x'.repeat(20 * 1024) }); // uitree 常态体量 >300 字符，必触发截断
const residueOf = (sm) => {
  const msgs = sm.buildSessionProjection().messages;
  return {
    trs: msgs.filter((m) => m.role === 'toolResult').length,
    tcs: msgs.filter((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === 'toolCall')).length,
  };
};
const foldedSummaries = (sm) => sm.buildSessionProjection().messages
  .filter((m) => m.role === 'custom' && m.customType === 'ask-folded-tool-result')
  .map((m) => (Array.isArray(m.content) ? m.content.map((b) => b.text ?? '').join('') : String(m.content)));

test('governor C1：截断+折叠组合（单步两轮 uitree→tap，真实 finally 顺序）零残留', () => {
  const sm = makeSession();
  sm.appendMessage(u('步骤1'));
  sm.appendMessage(atcN('c1', 'uitree'));
  sm.appendMessage(trN('c1', 'uitree', BIG));
  sm.appendMessage(atcN('c2', 'tap'));
  sm.appendMessage(trN('c2', 'tap', '{"ok":true}'));
  const gov = createContextGovernor({ sessionManager: sm });
  const pr2 = gov.pruneToolResults({ keepRecent: 1, keepChars: 300 }); // 先截断：uitree tr 成为已 edit entry
  const pr3 = gov.pruneToolHistory({ keepRecent: 0 }); // 再折叠：omit 须对已 edit entry 生效
  assert.ok(pr2.replaced >= 1, '长工具结果确实被截断');
  assert.ok(pr3.folded >= 4, '两条 assistant + 两条 toolResult 全部折叠');
  const r = residueOf(sm);
  assert.equal(r.trs, 0, '投影零 toolResult 残留');
  assert.equal(r.tcs, 0, '投影零 toolCall 块');
  assert.equal(foldedSummaries(sm).length, 2, '两条工具结果摘要都注入');
});

test('governor C1：多步多轮序列（4 步 uitree+tap）残留恒 0 不累积', () => {
  const sm = makeSession();
  const gov = createContextGovernor({ sessionManager: sm });
  for (let step = 1; step <= 4; step++) {
    sm.appendMessage(u(`步骤${step}`));
    sm.appendMessage(atcN(`u${step}`, 'uitree'));
    sm.appendMessage(trN(`u${step}`, 'uitree', BIG));
    sm.appendMessage(atcN(`t${step}`, 'tap'));
    sm.appendMessage(trN(`t${step}`, 'tap', '{"ok":true}'));
    gov.pruneImages({ keepRecent: 3 });
    gov.pruneToolResults({ keepRecent: 1, keepChars: 300 });
    gov.pruneToolHistory({ keepRecent: 0 });
    const r = residueOf(sm);
    assert.equal(r.trs, 0, `步${step} 零 toolResult 残留`);
    assert.equal(r.tcs, 0, `步${step} 零 toolCall 块`);
  }
  assert.equal(foldedSummaries(sm).length, 8, '8 条工具结果摘要增量保留（不丢不重）');
});

test('governor C1：pruneImages 先 edit 带图 tr 后折叠零残留', () => {
  const sm = makeSession();
  const img = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(8 * 1024) };
  sm.appendMessage(u('看图步骤'));
  sm.appendMessage(atcN('c1', 'uitree'));
  sm.appendMessage(trN('c1', 'uitree', BIG, [img]));
  sm.appendMessage(atcN('c2', 'screenshot'));
  sm.appendMessage(trN('c2', 'screenshot', '截图完成', [img]));
  sm.appendMessage(atcN('c3', 'tap'));
  sm.appendMessage(trN('c3', 'tap', '{"ok":true}', [img]));
  sm.appendMessage({ role: 'user', content: [img, { type: 'text', text: '最新问题' }], timestamp: Date.now() });
  const gov = createContextGovernor({ sessionManager: sm });
  const pr1 = gov.pruneImages({ keepRecent: 1 }); // 先 edit 带图 tr（c1/c2 图被替换 → 已 edit entry）
  gov.pruneToolResults({ keepRecent: 1, keepChars: 300 });
  gov.pruneToolHistory({ keepRecent: 0 });
  assert.ok(pr1.replaced >= 2, '图片治理确实发生');
  const r = residueOf(sm);
  assert.equal(r.trs, 0, '投影零 toolResult 残留');
  assert.equal(r.tcs, 0, '投影零 toolCall 块');
});

test('governor C1：截断+折叠组合重复执行幂等（残留仍 0、消息数/摘要数稳定）', () => {
  const sm = makeSession();
  sm.appendMessage(u('步骤1'));
  sm.appendMessage(atcN('c1', 'uitree'));
  sm.appendMessage(trN('c1', 'uitree', BIG));
  sm.appendMessage(atcN('c2', 'tap'));
  sm.appendMessage(trN('c2', 'tap', '{"ok":true}'));
  const gov = createContextGovernor({ sessionManager: sm });
  const run = () => {
    gov.pruneImages({ keepRecent: 3 });
    gov.pruneToolResults({ keepRecent: 1, keepChars: 300 });
    gov.pruneToolHistory({ keepRecent: 0 });
  };
  run();
  const n1 = sm.buildSessionProjection().messages.length;
  const s1 = foldedSummaries(sm).length;
  run();
  const n2 = sm.buildSessionProjection().messages.length;
  const s2 = foldedSummaries(sm).length;
  const r = residueOf(sm);
  assert.equal(r.trs, 0, '重复执行残留仍 0');
  assert.equal(r.tcs, 0, '重复执行零 toolCall 块');
  assert.equal(n1, n2, '消息数稳定不累积');
  assert.equal(s1, s2, '摘要数稳定不重复注入');
  assert.equal(s2, 2, '恰好两条摘要');
});

test('governor I1：跨步折叠早期摘要保留（步1 A 折叠 → 步3 B 折叠，A/B 都在投影）', () => {
  const sm = makeSession();
  const gov = createContextGovernor({ sessionManager: sm });
  sm.appendMessage(u('第1题问卷'));
  sm.appendMessage(atcN('a1', 'read'));
  sm.appendMessage(trN('a1', 'read', '答案A：42'));
  gov.foldToolHistory(); // 马拉松轮 foldForGateway：折叠 A
  sm.appendMessage(u('第3题引用第1题'));
  sm.appendMessage(atcN('b1', 'read'));
  sm.appendMessage(trN('b1', 'read', '答案B：7'));
  gov.foldToolHistory(); // 再折叠 B：早期轮摘要 A 不得被清掉（永久丢失）
  const texts = foldedSummaries(sm);
  assert.equal(texts.length, 2, '摘要恰好 2 条（不丢不重）');
  assert.ok(texts.some((t) => t.includes('答案A：42')), '早期轮摘要 A 仍在投影');
  assert.ok(texts.some((t) => t.includes('答案B：7')), '新轮摘要 B 也在投影');
  const r = residueOf(sm);
  assert.equal(r.trs, 0, '零 toolResult 残留');
  assert.equal(r.tcs, 0, '零 toolCall 块');
});
