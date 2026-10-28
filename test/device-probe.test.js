// probe：探测式推断（§5.5.3）+ .ask/family-probe.json 读写
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferFamily, loadProbeFamily, saveProbeFamily, probeFamily, probeCachePath } from '../src/device/coord/probe.js';

const SIZE = { w: 720, h: 1280 };
// 左上角返回箭头（中心 [48,96]）的紧致已知区域：只放行正确换算
const KNOWN = [44, 92, 52, 100];

test('探测式推断：各家族 raw 唯一命中对应策略', () => {
  assert.equal(inferFamily([67, 75], SIZE, KNOWN), 'glm'); // 0-1000·xy → (48,96)
  assert.equal(inferFamily([0.0667, 0.075], SIZE, KNOWN), 'kimi'); // 0-1 point → (48,96)
  assert.equal(inferFamily([75, 67], SIZE, KNOWN), 'gemini'); // yx → (48,96)
  assert.equal(inferFamily([48, 96], SIZE, KNOWN), 'gpt'); // 绝对像素 → (48,96)
});

test('探测式推断：多命中/全不命中 → 拒绝（null），不猜', () => {
  assert.equal(inferFamily([67, 75], SIZE, [30, 70, 70, 120]), null, '宽松区域下 xy/yx 都命中');
  assert.equal(inferFamily([67, 75], SIZE, [200, 200, 300, 300]), null, '全不命中');
  assert.equal(inferFamily(null, SIZE, KNOWN), null);
});

test('family-probe.json 读写（原子写）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-probe-'));
  const file = join(dir, '.ask', 'family-probe.json');
  assert.equal(probeCachePath(dir), join(dir, '.ask', 'family-probe.json'));
  assert.equal(loadProbeFamily(file), null, '不存在 → null');
  saveProbeFamily('glm', file);
  assert.ok(existsSync(file));
  assert.equal(loadProbeFamily(file), 'glm');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).family, 'glm');
  assert.equal(loadProbeFamily(join(dir, 'nope.json')), null);
});

test('probeFamily：一次 VLM 调用 + 命中落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-probe-'));
  const file = join(dir, '.ask', 'family-probe.json');
  let calls = 0;
  const vlm = async ({ png, size, target, instruction }) => {
    calls++;
    assert.ok(size && target);
    return { raw: [67, 75] }; // glm 风格
  };
  const r = await probeFamily({ vlm, png: Buffer.alloc(0), size: SIZE, known: { target: '返回箭头', bounds: KNOWN }, file });
  assert.equal(calls, 1);
  assert.equal(r.family, 'glm');
  assert.equal(loadProbeFamily(file), 'glm');
  // 探测不出不落盘
  const file2 = join(dir, 'p2.json');
  const r2 = await probeFamily({ vlm, png: null, size: SIZE, known: { target: 'x', bounds: [200, 200, 300, 300] }, file: file2 });
  assert.equal(r2.family, null);
  assert.equal(existsSync(file2), false);
});
