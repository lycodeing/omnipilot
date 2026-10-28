// RunRecorder 测试：§14.1 形状逐字段断言、locate 透传、脱敏三处落点、tmp+rename 原子性、
// PNG 落盘与相对路径回填

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunRecorder } from '../src/recorder/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpRuns(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-runs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeDevice() {
  return {
    serial: '172.16.198.174:5555',
    model: 'redroid',
    screenSize: async () => ({ w: 720, h: 1280 }),
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

test('runId 格式与目录/jsonPath getter，构造即建 step 目录', (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'cases/相册列表.yaml' });
  assert.match(rec.runId, /^run-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.equal(rec.dir, path.join(runsDir, rec.runId));
  assert.equal(rec.jsonPath, path.join(runsDir, `${rec.runId}.json`));
  assert.equal(fs.existsSync(rec.dir), true);
  assert.equal(fs.existsSync(rec.jsonPath), false); // finish 前无 .json
});

test('finish 产出 §14.1 完整形状，逐字段断言', async (t) => {
  const runsDir = tmpRuns(t);
  const device = fakeDevice();
  const rec = new RunRecorder({
    runsDir,
    caseName: 'cases/相册列表.yaml',
    device,
    model: { family: 'glm', name: 'glm-4.6v', baseUrlHash: 'a1b2c3d4', apiKey: 'sk-should-not-leak' },
  });
  const locate = {
    ok: true, bounds: [512, 760, 704, 880], center: [608, 820], strategy: 'exact_text',
    treeCacheHit: true, vlmCacheHit: false, dumpMs: 0, identity: { text: '电子相册' }, error: null,
  };
  const h = rec.startStep('tap', '电子相册');
  await sleep(30);
  h.end({ locate });
  const shot = rec.attachScreenshot(0, PNG);
  rec.addAssertion({ text: '列表按时间倒序', passed: true, reason: '排序正确' });
  rec.addNetworkEvent({ at: 4210, profile: '3g' });
  rec.addRollback({ stepIndex: 2, reason: 'locate_miss_x3', recovered: true });
  rec.setExtracts({ date_1: '2025-09-16' });
  rec.setContextLayers([{ name: 'KIT', chars: 1204 }, { name: 'USER', chars: 388 }]);
  const doc = await rec.finish('pass', { exitCode: 0 });

  assert.equal(doc.runId, rec.runId);
  assert.equal(doc.case, 'cases/相册列表.yaml');
  assert.equal(doc.status, 'pass');
  assert.equal(doc.exitCode, 0);
  assert.match(doc.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(typeof doc.durationMs, 'number');
  assert.ok(doc.durationMs >= 30);
  assert.deepEqual(doc.device, { serial: '172.16.198.174:5555', model: 'redroid', size: '720x1280' });
  assert.deepEqual(doc.model, { family: 'glm', name: 'glm-4.6v', baseUrlHash: 'a1b2c3d4' });
  assert.deepEqual(doc.contextLayers, [{ name: 'KIT', chars: 1204 }, { name: 'USER', chars: 388 }]);

  const [step] = doc.steps;
  assert.equal(step.index, 0);
  assert.equal(step.type, 'tap');
  assert.equal(step.target, '电子相册');
  assert.equal(typeof step.startedAt, 'number');
  assert.ok(step.startedAt < 1000); // 相对 run 起点 ms
  assert.ok(step.durationMs >= 25);
  assert.equal(step.result, 'ok');
  assert.deepEqual(step.locate, locate); // 原样透传
  assert.equal(step.screenshot, shot);
  assert.equal(step.error, null);

  assert.deepEqual(doc.assertions, [{ text: '列表按时间倒序', passed: true, reason: '排序正确' }]);
  assert.deepEqual(doc.extracts, { date_1: '2025-09-16' });
  assert.deepEqual(doc.networkTimeline, [{ at: 4210, profile: '3g' }]);
  assert.deepEqual(doc.rollbacks, [{ stepIndex: 2, reason: 'locate_miss_x3', recovered: true }]);
  assert.equal(doc.artifacts.report, `${toPosix(runsDir)}/${rec.runId}/index.html`); // 预留
  assert.deepEqual(doc.artifacts.uiDumps, []);

  // 落盘文件与内存 doc 一致；model 白名单字段，密钥明文不出现
  const text = fs.readFileSync(rec.jsonPath, 'utf8');
  const saved = JSON.parse(text);
  assert.equal(saved.runId, rec.runId);
  assert.ok(!text.includes('sk-should-not-leak'));
  assert.ok(!('apiKey' in saved.model));
});

function toPosix(p) {
  return p.split(path.sep).join('/');
}

test('end 默认 result=ok；error/失败结果落盘； locate 为空时为 null', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  rec.startStep('key', 'back').end({ result: 'fail', error: 'locate_miss' });
  rec.startStep('screen', null).end();
  const doc = await rec.finish('fail');
  assert.deepEqual(
    doc.steps.map((s) => [s.result, s.error, s.locate]),
    [['fail', 'locate_miss', null], ['ok', null, null]],
  );
  assert.equal(doc.exitCode, 0); // 默认 exitCode
});

test('未收口的步骤在 finish 时自动标记 unfinished', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  rec.startStep('tap', '按钮');
  const doc = await rec.finish('error');
  assert.equal(doc.steps[0].result, 'unfinished');
  assert.equal(typeof doc.steps[0].durationMs, 'number');
});

test('attachScreenshot 落 PNG 并回填 step.screenshot 相对路径', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  const h = rec.startStep('tap', 'x');
  h.end();
  const rel = rec.attachScreenshot(h.index, PNG);
  const abs = path.join(runsDir, rec.runId, `step-${h.index}.png`);
  assert.equal(rel, toPosix(abs));
  assert.equal(fs.existsSync(abs), true);
  assert.ok(fs.statSync(abs).size > 0);
  assert.equal(fs.readFileSync(abs).subarray(0, 4).toString('latin1'), '\x89PNG');
  assert.equal(rec._steps[0].screenshot, rel);
});

test('脱敏三处落点：secret 步结果强制替换、thought 与全文兜底扫描', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'login.yaml' });
  // ① secret 步：结果字段整个替换为 [REDACTED:provider:key]；value 登记后供全文扫描
  const h1 = rec.startStep('secret_get', 'sms_code');
  h1.end({ result: '验证码是 654321', secret: { provider: 'mcp-sms', key: 'code', value: '654321' } });
  // ② thought 落点：模型思考里复述了验证码，靠全文兜底替换
  const h2 = rec.startStep('input', '验证码输入框');
  h2.end({ result: 'ok', thought: '从短信读到验证码 654321，回填输入框' });
  // ③ 全文兜底：断言 reason 里也出现 secret
  rec.addAssertion({ text: '登录成功', passed: true, reason: '模型确认验证码 654321 已提交' });
  // 未登记 value 的 secret：结果字段仍强制替换
  const h3 = rec.startStep('secret_get', 'password');
  h3.end({ result: 'p@ssw0rd-xyz', secret: { provider: 'vault', key: 'pwd' } });
  const doc = await rec.finish('pass');

  const token1 = '[REDACTED:mcp-sms:code]';
  assert.equal(doc.steps[0].result, token1);
  assert.equal(doc.steps[1].thought, `从短信读到验证码 ${token1}，回填输入框`);
  assert.equal(doc.assertions[0].reason, `模型确认验证码 ${token1} 已提交`);
  assert.equal(doc.steps[2].result, '[REDACTED:vault:pwd]');
  const text = fs.readFileSync(rec.jsonPath, 'utf8');
  assert.ok(!text.includes('654321'));
  assert.ok(!text.includes('p@ssw0rd-xyz'));
  assert.ok(!text.includes('验证码是'));
  assert.equal(text.split(token1).length - 1, 3); // result / thought / reason 三处
});

test('registerSecret 单独登记也能全文兜底', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  rec.registerSecret({ provider: 'vault', key: 'token', value: 'SECRET-VALUE-42' });
  rec.startStep('tap', 'x').end({ error: '失败：SECRET-VALUE-42 已过期' });
  const doc = await rec.finish('fail');
  assert.equal(doc.steps[0].error, '失败：[REDACTED:vault:token] 已过期');
  assert.ok(!fs.readFileSync(rec.jsonPath, 'utf8').includes('SECRET-VALUE-42'));
});

test('tmp+rename 原子写：finish 前无 .json、后有、tmp 清理、不可重复 finish', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  rec.startStep('tap', 'x').end();
  assert.equal(fs.existsSync(rec.jsonPath), false);
  await rec.finish('pass');
  assert.equal(fs.existsSync(rec.jsonPath), true);
  JSON.parse(fs.readFileSync(rec.jsonPath, 'utf8'));
  const leftovers = fs.readdirSync(runsDir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  await assert.rejects(() => rec.finish('pass'), /重复/);
});

test('finish 状态校验与未收尾步骤之外的非法 end', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  await assert.rejects(() => rec.finish('bogus'), /status/);
  const h = rec.startStep('tap', 'x');
  h.end();
  assert.throws(() => h.end(), /重复收口/);
  await rec.finish('cancelled', { exitCode: 130 });
  assert.throws(() => rec.startStep('tap', 'y'), /收尾/);
  const doc = JSON.parse(fs.readFileSync(rec.jsonPath, 'utf8'));
  assert.equal(doc.status, 'cancelled');
  assert.equal(doc.exitCode, 130);
});

test('无 device/model 时字段为 null，size 支持描述对象形态', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: null, device: { serial: 'emulator-5554', size: '720x1280' } });
  const doc = await rec.finish('pass');
  assert.equal(doc.model, null);
  assert.deepEqual(doc.device, { serial: 'emulator-5554', model: null, size: '720x1280' });
  const rec2 = new RunRecorder({ runsDir });
  assert.equal((await rec2.finish('pass')).device, null);
});
