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
  // 默认产出 HTML 报告（run 收尾自动生成）。路径相对 runsDir——与 steps[].screenshot
  // 同一基准（同一 artifacts 对象内混用绝对/相对路径会让消费方无法用统一规则解析）。
  assert.equal(doc.artifacts.report, `${rec.runId}/index.html`);
  const reportAbs = path.join(runsDir, doc.artifacts.report);
  assert.ok(fs.existsSync(reportAbs), 'HTML 报告应已生成');
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

test('attachScreenshot 回填相对路径；PNG 异步落盘、finish 后保证在盘', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  const h = rec.startStep('tap', 'x');
  h.end();
  const rel = rec.attachScreenshot(h.index, PNG);
  const abs = path.join(runsDir, rec.runId, `step-${h.index}.png`);
  assert.equal(rel, toPosix(abs));
  assert.equal(rec._steps[0].screenshot, rel);
  await rec.finish('pass'); // finish 前统一 await 后台写盘
  assert.equal(fs.existsSync(abs), true);
  assert.ok(fs.statSync(abs).size > 0);
  assert.equal(fs.readFileSync(abs).subarray(0, 4).toString('latin1'), '\x89PNG');
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

test('tmp+rename 原子写：立即无 .json、finish 后有、tmp 清理、不可重复 finish', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  rec.startStep('tap', 'x').end();
  // 崩溃安全：记账后去抖落盘，finish 前可能已有增量快照（_partial 标记）
  // ——但快照是去抖的，刚记账完立刻断言仍应无文件
  assert.equal(fs.existsSync(rec.jsonPath), false);
  await rec.finish('pass');
  assert.equal(fs.existsSync(rec.jsonPath), true);
  const doc = JSON.parse(fs.readFileSync(rec.jsonPath, 'utf8'));
  assert.equal(doc._partial, undefined, '最终态不带 _partial 标记');
  const leftovers = fs.readdirSync(runsDir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  await assert.rejects(() => rec.finish('pass'), /重复/);
});

test('崩溃安全：未 finish 时增量快照仍留下可解析的 run.json（含步骤与断言）', async (t) => {
  // 回归用例：run.json 原先只在 finish() 落盘，SIGKILL/OOM 会让整条 run 的
  // 步骤、断言、网络时间线全部丢失（只剩孤儿截图）。增量快照保证崩溃后仍可读。
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  rec.startStep('tap', 'x').end();
  rec.startStep('tap', 'y').end();
  rec.addAssertion({ text: '断言A', passed: true });
  await new Promise((r) => setTimeout(r, 700)); // 等去抖落盘
  assert.equal(fs.existsSync(rec.jsonPath), true, '崩溃前应已落增量快照');
  const doc = JSON.parse(fs.readFileSync(rec.jsonPath, 'utf8'));
  assert.equal(doc._partial, true, '增量快照带 _partial 标记');
  assert.equal(doc.status, 'running');
  assert.equal(doc.steps.length, 2, '步骤数据不丢');
  assert.equal(doc.assertions.length, 1, '断言数据不丢');
});

test('崩溃安全：finish 覆写增量快照，去掉 _partial 标记', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'c.yaml' });
  rec.startStep('tap', 'x').end();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(JSON.parse(fs.readFileSync(rec.jsonPath, 'utf8'))._partial, true);
  await rec.finish('pass', { exitCode: 0 });
  const final = JSON.parse(fs.readFileSync(rec.jsonPath, 'utf8'));
  assert.equal(final._partial, undefined, '最终态应去掉 _partial');
  assert.equal(final.status, 'pass');
  assert.equal(final.exitCode, 0);
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

test('崩溃安全：finish 与增量快照并发时不被覆盖回 _partial（竞态回归）', async (t) => {
  // 回归用例：_flushPartial 原先先 await _buildDoc（内部 snapshotDevice 是真实设备
  // IO）才赋值 _partialWriting —— 那个窗口里 finish 看到 _partialWriting 仍是 null
  // 而不等待，于是 finish 先写最终态、迟到的快照再 rename 覆盖 → 已完成的 run
  // 变成 status:'running' + _partial:true（已复现）。
  const runsDir = tmpRuns(t);
  let screenCalls = 0;
  const rec = new RunRecorder({
    runsDir,
    caseName: 'c.yaml',
    // 第一次 screenSize 挂起 300ms —— 快照会卡在 _buildDoc 的 await 处
    device: {
      serial: 's', model: 'm',
      screenSize: async () => {
        screenCalls += 1;
        if (screenCalls === 1) await new Promise((r) => setTimeout(r, 300));
        return { w: 720, h: 1280 };
      },
    },
  });
  rec.startStep('tap', 'x').end();
  await new Promise((r) => setTimeout(r, 560));   // 等去抖快照触发并进入 await
  await rec.finish('pass');
  await new Promise((r) => setTimeout(r, 400));   // 等迟到的快照落盘
  const doc = JSON.parse(fs.readFileSync(rec.jsonPath, 'utf8'));
  assert.equal(doc._partial, undefined, '已完成的 run 不得被增量快照覆盖回 _partial');
  assert.equal(doc.status, 'pass');
});

test('engineLog 落盘：setEngineLog 后 finish 产出 doc.engineLog', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'engine.yaml' });
  rec.startStep('aiTap', '热榜').end({ result: 'failed', error: 'LOCATE_MISS' });
  rec.setEngineLog([{ step: 0, type: 'aiTap', tool: 'tap', ok: false, error: 'LOCATE_MISS' }]);
  const doc = await rec.finish('fail', { exitCode: 1 });
  assert.deepEqual(doc.engineLog, [{ step: 0, type: 'aiTap', tool: 'tap', ok: false, error: 'LOCATE_MISS' }]);
});

test('addAssertion 扩展字段：screenshotId/evidenceSource/nudges 可选落盘', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'assert.yaml' });
  rec.addAssertion({ text: '数据集 hotlist 至少3条', passed: true, reason: '7条', screenshotId: 'runs/x/assert-0.png', evidenceSource: 'dataset', nudges: 1 });
  rec.addAssertion({ text: '列表倒序', passed: false, reason: '白屏' });
  const doc = await rec.finish('fail', { exitCode: 1 });
  assert.equal(doc.assertions[0].screenshotId, 'runs/x/assert-0.png');
  assert.equal(doc.assertions[0].evidenceSource, 'dataset');
  assert.equal(doc.assertions[0].nudges, 1);
  assert.equal(doc.assertions[1].screenshotId, undefined);
});
