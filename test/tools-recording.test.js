// 工具调用记账包装（src/tools/index.js withRecording）与凭据脱敏链路集成测试
// 链路：buildTools 包装 → recorder.startStep/end → run.json steps[]（§14.1）→ registerSecret 全文兜底脱敏

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTools, EXPECTED_TOOLS, withRecording } from '../src/tools/index.js';
import { RunRecorder } from '../src/recorder/index.js';
import { createRunContext } from '../src/session/create.js';
import { encodePng, decodePng } from '../src/image/png.js';
import { redactScreenshot } from '../src/device/screenshot-redact.js';

function fakeDevice() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG 魔数前缀即可，落盘文件存在性是断言点
  return {
    serial: 'fake-001',
    async screencap() {
      return { buffer: png, size: { w: 720, h: 1280 } };
    },
    async locate() {
      return {
        ok: true, bounds: [100, 200, 300, 400], center: [200, 300], strategy: 'exact_text',
        treeCacheHit: false, vlmCacheHit: false, dumpMs: 5, identity: { text: '电子相册' }, error: null,
      };
    },
    async tap() {
      return { ok: true, latencyMs: 10, error: null };
    },
    async foreground() {
      return { package: 'com.demo', activity: 'com.demo.MainActivity', resumedActivity: 'com.demo/.MainActivity' };
    },
    async screenSize() {
      return { w: 720, h: 1280 };
    },
    async waitIdle() {
      return { stable: true, dumps: 2 };
    },
    async close() {},
  };
}

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-rec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function toolOf(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `工具 ${name} 应存在`);
  return t;
}

test('包装后 23 个契约工具名齐全且 execute 可调用', () => {
  const ctx = createRunContext({ device: fakeDevice(), recorder: null, store: null, opts: { yes: true } });
  const tools = buildTools(ctx);
  assert.equal(tools.length, EXPECTED_TOOLS.length);
  for (const name of EXPECTED_TOOLS) assert.ok(tools.some((t) => t.name === name), name);
});

test('tap 调用记为一步：type/target/locate/动作后截图齐全', async (t) => {
  const dir = makeTmp(t);
  const recorder = new RunRecorder({ runsDir: path.join(dir, 'runs'), caseName: '记账冒烟' });
  const ctx = createRunContext({ device: fakeDevice(), recorder, store: null, opts: { yes: true } });
  ctx.lastThought = '我要点击电子相册';
  const tap = toolOf(buildTools(ctx), 'tap');
  const res = await tap.execute('t1', { target: '电子相册' });
  assert.equal(res.details.ok, true);
  const doc = await recorder.finish('pass');
  assert.equal(doc.steps.length, 1);
  const s = doc.steps[0];
  assert.equal(s.type, 'tap');
  assert.equal(s.target, '电子相册');
  assert.equal(s.result, 'ok');
  assert.equal(s.thought, '我要点击电子相册');
  assert.equal(s.locate.bounds[0], 100);
  assert.equal(s.locate.strategy, 'exact_text');
  assert.ok(s.screenshot && s.screenshot.endsWith('step-0.png'));
  assert.ok(fs.existsSync(path.resolve(dir, s.screenshot)), '动作后截图应落盘');
});

test('screen 工具的截图直接入档；locate 步骤带 locate 形状', async (t) => {
  const dir = makeTmp(t);
  const recorder = new RunRecorder({ runsDir: path.join(dir, 'runs'), caseName: '感知记账' });
  const ctx = createRunContext({ device: fakeDevice(), recorder, store: null, opts: { yes: true } });
  const screen = toolOf(buildTools(ctx), 'screen');
  const r1 = await screen.execute('t1', {});
  assert.equal(r1.content[0].type, 'image');
  const locate = toolOf(buildTools(ctx), 'locate');
  await locate.execute('t2', { target: '电子相册' });
  const doc = await recorder.finish('pass');
  assert.equal(doc.steps.length, 2);
  assert.ok(doc.steps[0].screenshot, 'screen 步骤应有截图');
  assert.equal(doc.steps[1].locate.strategy, 'exact_text');
  assert.equal(doc.steps[1].locate.bounds[3], 400);
});

test('secret_get 的值登记后，thought 里的明文在 finish 时被全文脱敏', async (t) => {
  const dir = makeTmp(t);
  const cwd = process.cwd();
  fs.mkdirSync(path.join(dir, '.ask'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.ask', 'secrets.json'),
    JSON.stringify({ demo: { password: 'S3cret-V4lue' } }),
  );
  process.chdir(dir);
  try {
    const recorder = new RunRecorder({ runsDir: path.join(dir, 'runs'), caseName: '脱敏链路' });
    const ctx = createRunContext({ device: fakeDevice(), recorder, store: null, opts: { yes: true } });
    const tools = buildTools(ctx);
    const secretGet = toolOf(tools, 'secret_get');
    const r = await secretGet.execute('t1', { provider: 'demo', key: 'password' });
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.value, 'S3cret-V4lue', '凭据只回模型上下文');
    // 模拟凭据回声进后续 thought
    ctx.lastThought = `已输入 S3cret-V4lue 到密码框`;
    const input = toolOf(tools, 'wait_idle');
    await input.execute('t2', {});
    const doc = await recorder.finish('pass');
    assert.equal(ctx.secretCalls.length, 1);
    assert.equal(ctx.secretCalls[0].value, 'S3cret-V4lue');
    assert.ok(!JSON.stringify(doc).includes('S3cret-V4lue'), 'run.json 不得出现凭据明文');
    assert.ok(JSON.stringify(doc).includes('[REDACTED:demo:password]'));
  } finally {
    process.chdir(cwd);
  }
});

test('无 recorder 的 ctx 不包装（ask 只读流程）', async () => {
  const ctx = createRunContext({ device: fakeDevice(), recorder: null, store: null, opts: { yes: true } });
  const tap = toolOf(buildTools(ctx), 'tap');
  assert.equal(tap.withRecording, undefined);
  const res = await tap.execute('t1', { target: 'x' });
  assert.equal(res.details.ok, true);
});

// 守护：screen 工具直接返回的 image 入档前也必须走 redactShot（凭据图像面不留缺口）。
// 构造带 password 节点缓存树的 ctx + 假的 screen 工具，断言 attachScreenshot 收到的
// Buffer 与 redactScreenshot 期望值逐字节一致且遮罩区像素被填灰。
test('screen 工具 image 截图入档前按 password 节点遮罩', async () => {
  const w = 16, h = 16;
  const px = Buffer.alloc(w * h * 4, 255); // 全白 RGBA，密码框区域本可泄明文
  const png = encodePng(w, h, px, 6);
  const nodes = [{ password: true, bounds: [2, 2, 6, 6] }];
  const device = { cachePeek: () => ({ nodes, hash: 'fake' }) };

  const shots = [];
  const recorder = {
    startStep: () => ({ index: 0, end: () => {} }),
    attachScreenshot: (index, buf) => shots.push({ index, buf }),
    trackPending: () => {},
    registerSecret: () => {},
  };
  const ctx = createRunContext({ device, recorder, store: null, opts: { yes: true } });
  const screenTool = {
    name: 'screen',
    execute: async () => ({
      content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
      details: { ok: true },
    }),
  };
  await withRecording(screenTool, ctx).execute('t1', {});

  assert.equal(shots.length, 1, 'screen 分支应入档一张截图');
  // redactShot 用 device/uitree.js 的 flattenNodes(cached.nodes)（扁平数组为恒等），
  // 故期望值 = 同一 PNG 经 redactScreenshot(png, nodes) 的结果。
  const expected = redactScreenshot(png, nodes);
  assert.ok(shots[0].buf.equals(expected), '入档 Buffer 应为遮罩后字节（与原图不同）');
  assert.ok(!shots[0].buf.equals(png), '未遮罩的原图不得直接入档');
  const dec = decodePng(shots[0].buf);
  assert.equal(dec.pixels[(3 * w + 3) * 4], 128, '遮罩区像素应为 128');
  assert.equal(dec.pixels[0], 255, '非遮罩区保持原样');
});
