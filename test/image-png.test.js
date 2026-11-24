// 纯 JS PNG 下采样（§16 截图压缩）单测：编解码往返 + 降采样正确性 + 体积收益
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, encodePng, downscale, shrinkPng } from '../src/image/png.js';

// 造一张测试 PNG（w×h，RGBA，纯色+渐变，filter=0）
function makePng(w, h, colorFn) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = colorFn(x, y);
      const i = (y * w + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  return encodePng(w, h, px, 6);
}

test('encodePng/decodePng 往返：像素完全一致', () => {
  const png = makePng(8, 6, (x, y) => [x * 30, y * 40, 128, 255]);
  const d = decodePng(png);
  assert.equal(d.width, 8);
  assert.equal(d.height, 6);
  assert.equal(d.bpp, 4);
  // 抽查几个像素
  const at = (x, y) => [...d.pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [0, 0, 128, 255]);
  assert.deepEqual(at(7, 5), [210, 200, 128, 255]);
});

test('decodePng：拒绝非 PNG / 非法参数', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /不是合法 PNG/);
  assert.throws(() => decodePng(Buffer.alloc(100)), /不是合法 PNG/);
});

test('downscale：2× 降采样，尺寸减半、块平均色正确', () => {
  // 4×4，每 2×2 块一种颜色
  const png = makePng(4, 4, (x, y) => {
    const block = (Math.floor(x / 2) + Math.floor(y / 2) * 2);
    return [block * 60, 0, 0, 255];
  });
  const r = downscale(png, { factor: 2 });
  assert.equal(r.width, 2);
  assert.equal(r.height, 2);
  const d = decodePng(r.buffer);
  const at = (x, y) => [...d.pixels.subarray((y * 2 + x) * 4, (y * 2 + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [0, 0, 0, 255], '左上块=0');
  assert.deepEqual(at(1, 0), [60, 0, 0, 255], '右上块=60');
  assert.deepEqual(at(0, 1), [120, 0, 0, 255], '左下块=120');
  assert.deepEqual(at(1, 1), [180, 0, 0, 255], '右下块=180');
});

test('downscale：混合色块取平均（不丢信息）', () => {
  // 2×2 全不同色 → 降为 1×1 应为平均
  const png = makePng(2, 2, (x, y) => {
    if (x === 0 && y === 0) return [0, 0, 0, 255];
    if (x === 1 && y === 0) return [100, 0, 0, 255];
    if (x === 0 && y === 1) return [0, 200, 0, 255];
    return [0, 0, 40, 255];
  });
  const r = downscale(png, { factor: 2 });
  assert.equal(r.width, 1);
  const d = decodePng(r.buffer);
  assert.deepEqual([...d.pixels.subarray(0, 4)], [25, 50, 10, 255], '四色平均');
});

test('shrinkPng：宽度未超阈值时原样返回', () => {
  const png = makePng(20, 10, () => [10, 20, 30, 255]);
  const r = shrinkPng(png, { maxWidth: 540 });
  assert.equal(r.scaled, false);
  assert.equal(r.buffer, png, '未缩放应返回同一 Buffer');
});

test('shrinkPng：超阈值时按 2 的幂降采样到 ≤maxWidth', () => {
  const png = makePng(1080, 2400, (x, y) => [x % 256, y % 256, 100, 255]);
  const r = shrinkPng(png, { maxWidth: 540 });
  assert.equal(r.scaled, true);
  assert.equal(r.width, 540, '1080 → 540');
  assert.equal(r.height, 1200);
  assert.ok(r.buffer.length < png.length, `缩小后应更小（${r.buffer.length} < ${png.length}）`);
});

test('shrinkPng：极窄阈值也能收敛（1080→270）', () => {
  const png = makePng(1080, 2400, () => [1, 2, 3, 255]);
  const r = shrinkPng(png, { maxWidth: 300 });
  assert.ok(r.width <= 300, `宽度 ${r.width} 应 ≤300`);
  assert.equal(r.factor, 4);
});

test('体积收益：纯色大图缩小后显著变小', () => {
  const big = makePng(1080, 2400, () => [200, 100, 50, 255]);
  const r = shrinkPng(big, { maxWidth: 540 });
  assert.ok(r.buffer.length < big.length * 0.6, `应显著缩小（${r.buffer.length} vs ${big.length}）`);
});

// —— 尺寸上限（防伪造头致巨额分配）——

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 构造最小 PNG 头（声明尺寸，不含实际像素数据）
function fakeHeader(width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;    // bit depth
  ihdr[17] = 6;    // color type RGBA
  ihdr[18] = 0; ihdr[19] = 0; ihdr[20] = 0;
  return Buffer.concat([PNG_SIG, ihdr]);
}

test('decodePng：尺寸超上限时抛错（防伪造头致巨额分配）', () => {
  // 回归用例：width/height 来自文件头（不可信输入），unfilter 按 stride*height
  // 分配像素缓冲——68 字节的伪造头声明 20000×20000 就能触发 1.5GB 分配（实测）。
  assert.throws(() => decodePng(fakeHeader(20000, 20000)), /尺寸过大/);
});

test('decodePng：零尺寸抛错', () => {
  assert.throws(() => decodePng(fakeHeader(0, 100)), /尺寸非法/);
});
