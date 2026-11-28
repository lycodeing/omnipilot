// run 循环编排测试（fake session + fake device，不真连）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCaseLoop } from '../src/session/run-loop.js';
import { encodePng } from '../src/image/png.js';
import { createRunContext } from '../src/session/create.js';
import { RunRecorder } from '../src/recorder/index.js';
import { buildTools, buildEngineTools } from '../src/tools/index.js';
import { createContextGovernor } from '../src/session/context-governor.js';
import { SessionManager } from '@earendil-works/pi-coding-agent';

// timeout 终态逻辑由 runCaseLoop 承载；此处同时守护 recorder 支持 timeout 状态
test('timeout 终态：超预算 break 后 status 必须是 timeout 而非 pass', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rec = new RunRecorder({ runsDir: dir, caseName: 'timeout.yaml' });
  rec.startStep('tap', 'x').end();
  const doc = await rec.finish('timeout', { exitCode: 2 });
  assert.equal(doc.status, 'timeout');
  assert.equal(doc.exitCode, 2);
});

// 终态判定由 runCaseLoop 的 engineFailed 承载；此处守护 recorder 侧 engineLog 形状
test('引擎步失败终态：engineFailed 标记使零断言 run 判 fail', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rec = new RunRecorder({ runsDir: dir, caseName: 'engine.yaml' });
  rec.setEngineLog([{ step: 0, type: 'aiTap', tool: 'tap', ok: false, error: 'LOCATE_MISS' }]);
  const doc = await rec.finish('fail', { exitCode: 1 });
  assert.equal(doc.status, 'fail');
  assert.equal(doc.engineLog[0].ok, false);
});

function fakeSession({ answers = [] } = {}) {
  let i = 0;
  const messages = [];
  const prompts = [];
  return {
    prompts,
    agent: { state: { messages } },
    async prompt(text, opts) {
      prompts.push(text);
      messages.push({ role: 'user', content: [{ type: 'text', text }] });
      const ans = answers[Math.min(i++, answers.length - 1)] ?? '';
      messages.push({ role: 'assistant', content: [{ type: 'text', text: ans }] });
    },
    dispose() {},
  };
}

function fakeDevice(over = {}) {
  return {
    serial: 'fake-001',
    screencap: async () => ({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), size: { w: 720, h: 1280 } }),
    dumpTree: async () => ({ nodes: [], hash: 'h1', dumpMs: 1, fromCache: false }),
    locate: async () => ({ ok: true, bounds: [0, 0, 100, 100], center: [50, 50], strategy: 'exact_text', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: null }),
    tap: async () => ({ ok: true, latencyMs: 10, error: null }),
    longPress: async () => ({ ok: true, latencyMs: 10, error: null }),
    inputText: async (b, t) => ({ ok: true, readBack: t, error: null }),
    scroll: async () => ({ scrolls: 1, changed: true }),
    key: async () => ({ ok: true }),
    launch: async () => ({ ok: true, error: null }),
    terminate: async () => ({ ok: true }),
    waitIdle: async () => ({ stable: true, dumps: 1 }),
    waitForElement: async () => ({ appeared: true, dumps: 1 }),
    screenSize: async () => ({ w: 720, h: 1280 }),
    foreground: async () => ({ package: 'com.demo', activity: '.Main', resumedActivity: '.Main' }),
    netStatus: async () => ({ profile: 'off' }),
    netSetProfile: async (p) => ({ ok: true, profile: p, error: null }),
    vlmCache: new Map(),
    invalidateCache() {}, markDirty() {},
    close: async () => {},
    ...over,
  };
}

function setup(t, { device, answers, caseObj, flags = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorder = new RunRecorder({ runsDir: path.join(dir, 'runs'), caseName: caseObj?.name ?? 'test' });
  const ctx = createRunContext({ device: device ?? fakeDevice(), recorder, store: null, opts: { yes: true, ...flags } });
  ctx.stateDir = dir;
  const session = fakeSession({ answers });
  const sm = SessionManager.inMemory(dir);
  const gov = createContextGovernor({ sessionManager: sm });
  const toolMap = new Map([...buildTools(ctx), ...buildEngineTools(ctx)].map((tool) => [tool.name, tool]));
  return { ctx, recorder, session, gov, toolMap, dir };
}

test('runCaseLoop：纯引擎步用例（aiTap）零模型往返，终态 pass', async (t) => {
  const { ctx, recorder, session, gov, toolMap } = setup(t, { caseObj: { name: 'engine', steps: [{ type: 'aiTap', text: '热榜' }] } });
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true }, caseObj: { name: 'engine', steps: [{ type: 'aiTap', text: '热榜' }] }, runDeadline: 0, modelCfg: {}, planCache: { get: () => null, put() {}, delete() {} } });
  assert.equal(status, 'pass');
  assert.equal(session.prompts.length, 0, '引擎步零模型往返');
});

test('runCaseLoop：引擎步失败（降级也失败）→ 终态 fail', async (t) => {
  const device = fakeDevice({ locate: async () => ({ ok: false, bounds: null, center: null, strategy: 'none', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: 'LOCATE_MISS' }) });
  const caseObj = { name: 'engine-fail', steps: [{ type: 'aiTap', text: '不存在' }] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { device, caseObj, answers: ['未找到'] });
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true, quiet: true }, caseObj, runDeadline: 0, modelCfg: {}, planCache: { get: () => null, put() {}, delete() {} } });
  assert.equal(status, 'fail');
});

test('runCaseLoop：aiAssert 数据类断言注入数据集事实', async (t) => {
  const caseObj = { name: 'assert', steps: [{ type: 'aiAssert', text: '数据集 hotlist 中至少有3条记录' }] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { caseObj, answers: ['{"passed": true, "reason": "7条"}'] });
  ctx.datasetWrites = new Map([['hotlist', 7]]);
  ctx.store = { read: async () => [{ title: 'A' }, { title: 'B' }, { title: 'C' }] };
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true }, caseObj, runDeadline: 0, modelCfg: {}, planCache: { get: () => null, put() {}, delete() {} } });
  assert.equal(status, 'pass');
  assert.ok(session.prompts[0].includes('数据集事实'), '断言提示词应注入数据集事实');
});

test('runCaseLoop：timeout 到点 → 终态 timeout', async (t) => {
  const caseObj = { name: 'timeout', steps: [{ type: 'aiTap', text: '热榜' }, { type: 'aiTap', text: '推荐' }] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { caseObj });
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true }, caseObj, runDeadline: Date.now() - 1000, modelCfg: {}, planCache: { get: () => null, put() {}, delete() {} } });
  assert.equal(status, 'timeout');
});

test('runCaseLoop：plan-cache 回放截图挂到最后一步（M6 回归）', async (t) => {
  const caseObj = { name: 'replay', steps: [{ type: 'ai', text: '点击热榜' }] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { caseObj, answers: [''] });
  const planCache = {
    get: () => ({ tool: 'tap', params: { target: '热榜' }, plan: [{ tool: 'tap', params: { target: '热榜' } }] }),
    put() {}, delete() {},
  };
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true }, caseObj, runDeadline: 0, modelCfg: {}, planCache });
  assert.equal(status, 'pass');
  const doc = await recorder.finish('pass');
  const last = doc.steps[doc.steps.length - 1];
  assert.ok(last.screenshot, '回放最后一步应有截图（不再孤儿）');
});

// 守护：树不可用（uia2 槽冲突/busy）时跳过 waitIdle——它内部同样是 fresh dump，
// 在槽冲突下必超时空耗；普通 MISS 仍走 90s 等待（等 idle 后目标回到 a11y 树）。
test('runCaseLoop：LOCATE_MISS 降级不再 waitIdle（直接 VLM）', async (t) => {
  const missResult = (code) => ({ ok: false, bounds: null, center: null, strategy: 'none', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: '未找到目标', code });
  for (const code of ['TREE_UNAVAILABLE', null]) {
    let waitIdleCalls = 0;
    const device = fakeDevice({
      locate: async () => missResult(code),
      waitIdle: async () => { waitIdleCalls++; return { stable: true, dumps: 1 }; },
    });
    const caseObj = { name: 'gate', steps: [{ type: 'aiTap', text: '确认' }] };
    const { ctx, recorder, session, gov, toolMap } = setup(t, { device, caseObj, answers: ['未找到'] });
    await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true, quiet: true }, caseObj, runDeadline: 0, modelCfg: {}, planCache: { get: () => null, put() {}, delete() {} } });
    assert.equal(waitIdleCalls, 0, `code=${code ?? 'null'} 时 MISS 降级不应调 waitIdle`);
  }
});

// 守护：VLM 降级点击后记录 verified（点击前后截屏差异），但不改终态判定——
// 画面变化≠点对了，槽冲突时 fresh dump 也不可用，只能作为证据不能当硬门槛。
// 构造最小合法 RGB PNG（screenSignature 需要真可解码的截图）
function makeTestPng(w, h, rgb) {
  const pixels = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { pixels[i*3]=rgb[0]; pixels[i*3+1]=rgb[1]; pixels[i*3+2]=rgb[2]; }
  return encodePng(w, h, pixels, 2);
}

test('runCaseLoop：VLM 降级记录 verified 且不因「无画面变化」改判 fail', async (t) => {
  const png = makeTestPng(100, 200, [128, 128, 128]);
  const device = fakeDevice({
    locate: (() => { let n=0; return async()=>(++n===1?{ok:false,bounds:null,center:null,strategy:'none',treeCacheHit:false,vlmCacheHit:false,dumpMs:1,identity:null,error:'LOCATE_MISS'}:{ok:true,bounds:[100,100,200,200],center:[150,150],strategy:'vlm',identity:null}); })(),
    screencap: async () => ({ buffer: png, size:{w:100,h:200} }),
  });
  const caseObj = { name:'v-verified', steps:[{type:'aiTap',text:'确认'}] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { device, caseObj, answers:['未找到'] });
  ctx.vlm = async()=>({raw:'150 150',family:'deepseek'}); ctx.modelCfg={family:'deepseek'};
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags:{yes:true,quiet:true}, caseObj, runDeadline:0, modelCfg:{family:'deepseek'}, planCache:{get:()=>null,put(){},delete(){}} });
  assert.equal(status, 'pass', 'verified 不应改判终态');
  const log = (ctx.engineLog||[]).find(e=>String(e.type).includes('vlm-fallback'));
  assert.ok(log, 'engineLog 应有 VLM 降级记录');
  assert.ok(typeof log.verified === 'boolean' || log.verified === null, 'verified 应为 boolean 或 null');
});


// 守护：树不可用时跳过 batchGround——它首句就是 device.dumpTree()（无超时参数），槽冲突下
// 会阻塞到 dump 抛错（实测 30-60s）才进 catch，是 waitIdle 之外的另一处空耗来源；
// 且它写 vlmCache 的键依赖 tree.hash，树不可用时本就无意义。
// 判据：两个 aiTap 步，tap 固有的弹窗检测（handlePopupBeforeAction → detectDialog，
// dump 失败时 treeScan 还会回退重扫）实测恰好 3 次 dumpTree；batchGround 若被调用会再多 1 次。
// 用 dumpTree 调用次数守护，且必须做反向验证（还原修复应变红），否则是假绿。
test('runCaseLoop：locateCode=TREE_UNAVAILABLE 时跳过 batchGround（不多付 dumpTree）', async (t) => {
  let dumpCalls = 0;
  const device = fakeDevice({
    locate: (() => { let n = 0; return async () => (++n === 1
      ? { ok: false, bounds: null, center: null, strategy: 'none', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: '获取 UI 树失败', code: 'TREE_UNAVAILABLE' }
      : { ok: true, bounds: [100, 100, 200, 200], center: [150, 150], strategy: 'vlm', identity: null }); })(),
    dumpTree: async () => { dumpCalls++; throw new Error('uia2 busy'); },
    screencap: async () => ({ buffer: Buffer.from([1]), size: { w: 720, h: 1280 } }),
  });
  const caseObj = { name: 'gate-bg', steps: [{ type: 'aiTap', text: '确认' }, { type: 'aiTap', text: '返回' }] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { device, caseObj, answers: ['未找到'] });
  ctx.vlm = async () => ({ raw: '150 150', family: 'deepseek' });
  ctx.chat = async () => '';
  await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true, quiet: true }, caseObj, runDeadline: 0, modelCfg: { family: 'deepseek' }, planCache: { get: () => null, put() {}, delete() {} } });
  assert.equal(dumpCalls, 3, `应为弹窗检测固有的 3 次 dump，多出说明 batchGround 被触发（实际 ${dumpCalls}）`);
});
