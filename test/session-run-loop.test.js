// run 循环编排测试（fake session + fake device，不真连）
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 本 Task 先测 timeout 终态逻辑的纯函数抽取；run-loop 下沉在阶段三
test('timeout 终态：超预算 break 后 status 必须是 timeout 而非 pass', async () => {
  // 抽取为纯函数后测试；当前先验证 recorder 支持 timeout 状态
  const { RunRecorder } = await import('../src/recorder/index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-timeout-'));
  const rec = new RunRecorder({ runsDir: dir, caseName: 'timeout.yaml' });
  rec.startStep('tap', 'x').end();
  const doc = await rec.finish('timeout', { exitCode: 2 });
  assert.equal(doc.status, 'timeout');
  assert.equal(doc.exitCode, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('引擎步失败终态：engineFailed 标记使零断言 run 判 fail', async () => {
  // 终态判定纯函数抽取到 run-loop-helpers（阶段三），此处先守护 recorder 侧
  const { RunRecorder } = await import('../src/recorder/index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-engine-'));
  const rec = new RunRecorder({ runsDir: dir, caseName: 'engine.yaml' });
  rec.setEngineLog([{ step: 0, type: 'aiTap', tool: 'tap', ok: false, error: 'LOCATE_MISS' }]);
  const doc = await rec.finish('fail', { exitCode: 1 });
  assert.equal(doc.status, 'fail');
  assert.equal(doc.engineLog[0].ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
