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