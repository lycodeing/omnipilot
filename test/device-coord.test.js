// 坐标策略换算（§5.5.2）：GLM/Qwen(0-1000·xy)、Gemini(0-1000·yx)、Kimi(0-1 point)、GPT(绝对像素)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CoordinateStrategy,
  Normalized1000Bbox,
  Normalized1000BboxYX,
  NormalizedUnitPoint,
  AbsolutePixel,
  pointInBounds,
} from '../src/device/coord/strategy.js';
import { resolveStrategy, registerStrategy } from '../src/device/coord/registry.js';

const SIZE = { w: 720, h: 1280 };

test('GLM/Qwen：bbox 0-1000·xy 换算 v×size/1000', () => {
  const s = new Normalized1000Bbox();
  const r = s.toPixels([500, 500, 1000, 1000], SIZE);
  assert.deepEqual(r.bounds, [360, 640, 720, 1280]);
  assert.deepEqual(r.center, [540, 960]);
  assert.equal(r.inScreen, true);
  // 2 元素按 point 处理（Qwen2.5-VL 需区分 2/4 元素）
  const p = s.toPixels([250, 500], SIZE);
  assert.equal(p.bounds, null);
  assert.deepEqual(p.center, [180, 640]);
  // 对象形式
  assert.deepEqual(s.toPixels({ x1: 0, y1: 0, x2: 500, y2: 500 }, SIZE).bounds, [0, 0, 360, 640]);
  // 字符串形式
  assert.deepEqual(s.toPixels('[500,500,1000,1000]', SIZE).bounds, [360, 640, 720, 1280]);
});

test('Gemini：bbox 0-1000·yx，先交换再换算', () => {
  const s = new Normalized1000BboxYX();
  const r = s.toPixels([250, 500, 750, 1000], SIZE); // y1=250, x1=500, y2=750, x2=1000
  assert.deepEqual(r.bounds, [360, 320, 720, 960]);
  assert.deepEqual(r.center, [540, 640]);
  const p = s.toPixels([250, 500], SIZE); // y=250, x=500
  assert.deepEqual(p.center, [360, 320]);
});

test('Kimi：point 0-1 归一化（normalizedBy=1，不是 0-1000）', () => {
  const s = new NormalizedUnitPoint();
  const r = s.toPixels([0.5, 0.25], SIZE);
  assert.deepEqual(r.center, [360, 320]);
  assert.equal(r.bounds, null);
  // 若误按 0-1000 处理会挤在左上角——这里必须铺满屏幕
  assert.deepEqual(s.toPixels([1, 1], SIZE).center, [720, 1280]);
});

test('GPT：绝对像素直用，不归一化', () => {
  const s = new AbsolutePixel();
  const r = s.toPixels([100, 200, 300, 400], SIZE);
  assert.deepEqual(r.bounds, [100, 200, 300, 400]);
  assert.deepEqual(r.center, [200, 300]);
  assert.equal(r.inScreen, true);
});

test('越界检测：换算后不在屏幕内 → inScreen=false（§5.5.2 越界告警）', () => {
  assert.equal(new Normalized1000Bbox().toPixels([1200, 500], SIZE).inScreen, false);
  assert.equal(new AbsolutePixel().toPixels([100, 200, 300, 4000], SIZE).inScreen, false);
  assert.throws(() => new CoordinateStrategy('x').toPixels([1], SIZE), /abstract/, '基类为抽象方法');
  assert.equal(pointInBounds([5, 5], [0, 0, 10, 10]), true);
  assert.equal(pointInBounds([11, 5], [0, 0, 10, 10]), false);
});

test('registry：family → 策略映射（含前缀匹配与自定义注册）', () => {
  assert.equal(resolveStrategy('glm-4.6v').name, 'normalized_1000_xy');
  assert.equal(resolveStrategy('qwen3-vl').name, 'normalized_1000_xy');
  assert.equal(resolveStrategy('qwen2.5-vl').name, 'normalized_1000_xy');
  assert.equal(resolveStrategy('deepseek-vl2').name, 'normalized_1000_xy');
  assert.equal(resolveStrategy('doubao-1.5-vision-pro').name, 'normalized_1000_xy');
  assert.equal(resolveStrategy('kimi-latest').name, 'normalized_unit_point');
  assert.equal(resolveStrategy('gemini-2.0-flash').name, 'normalized_1000_yx');
  assert.equal(resolveStrategy('gpt-4o').name, 'absolute_pixel');
  assert.equal(resolveStrategy('openai/gpt-4o').name, 'absolute_pixel');
  assert.equal(resolveStrategy('mimo'), null);
  assert.equal(resolveStrategy(''), null);
  assert.equal(resolveStrategy(null), null);
  registerStrategy('my-custom-model', new AbsolutePixel());
  assert.equal(resolveStrategy('my-custom-model-v2').name, 'absolute_pixel');
});

test('describeForPrompt：提示词与源码措辞对应（§5.5.2）', () => {
  assert.match(resolveStrategy('glm').describeForPrompt(), /0-1000/);
  assert.match(resolveStrategy('glm').describeForPrompt(), /Do NOT use pixel coordinates/);
  assert.match(resolveStrategy('gemini').describeForPrompt(), /y.*x.*order|y comes first|\[y1, x1/);
  assert.match(resolveStrategy('kimi').describeForPrompt(), /0-1/);
  assert.match(resolveStrategy('gpt').describeForPrompt(), /actual pixel coordinates/);
});
