import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, pixelAt, isBlueish } from '../src/device/png.js';

// 构造最小 PNG：8-bit、色彩类型 2(RGB)、指定每行滤波类型
function makePng(width, height, pixels, filterType = 0) {
  const channels = 3;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filterType;
    const row = pixels.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let delta;
      switch (filterType) {
        case 0: delta = row[x]; break;
        case 1: delta = (row[x] - a) & 0xff; break;
        case 2: delta = (row[x] - b) & 0xff; break;
        case 3: delta = (row[x] - ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
          delta = (row[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: delta = row[x];
      }
      raw[y * (stride + 1) + 1 + x] = delta;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[12] = 0;
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    // CRC 省略校验用途：解码器不校验 CRC，填 0 即可
    const crc = Buffer.alloc(4);
    chunks.push(len, td, crc);
  };
  chunk('IHDR', ihdr);
  chunk('IDAT', zlib.deflateSync(raw));
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

const W = 4; const H = 3;
const px = (r, g, b) => [r, g, b];
const pixels = Buffer.from([
  ...px(33, 150, 243), ...px(0, 0, 0), ...px(255, 255, 255), ...px(245, 246, 248),
  ...px(10, 20, 30), ...px(33, 150, 243), ...px(128, 128, 128), ...px(1, 2, 3),
  ...px(200, 30, 40), ...px(5, 5, 5), ...px(33, 150, 243), ...px(9, 9, 9),
]);

for (const f of [0, 1, 2, 3, 4]) {
  test(`decodePng：滤波类型 ${f} 还原像素`, () => {
    const png = decodePng(makePng(W, H, pixels, f));
    assert.equal(png.width, W);
    assert.equal(png.height, H);
    assert.equal(png.channels, 3);
    assert.deepEqual(pixelAt(png, 0, 0), [33, 150, 243]);
    assert.deepEqual(pixelAt(png, 3, 0), [245, 246, 248]);
    assert.deepEqual(pixelAt(png, 1, 1), [33, 150, 243]);
    assert.deepEqual(pixelAt(png, 2, 2), [33, 150, 243]);
    assert.deepEqual(pixelAt(png, 0, 2), [200, 30, 40]);
    assert.equal(pixelAt(png, -1, 0), null);
    assert.equal(pixelAt(png, W, 0), null);
  });
}

test('isBlueish：选中蓝 vs 未选中灰', () => {
  assert.equal(isBlueish([33, 150, 243]), true);
  assert.equal(isBlueish([66, 165, 245]), true);
  assert.equal(isBlueish([245, 246, 248]), false);
  assert.equal(isBlueish([238, 240, 243]), false);
  assert.equal(isBlueish([200, 30, 40]), false);
});

test('decodePng：非 PNG 输入抛错', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /不是 PNG/);
});
