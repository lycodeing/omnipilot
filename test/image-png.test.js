// PNG 解码边界（§src/image/png.js）：尺寸上限与非法输入
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng } from '../src/image/png.js';

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
  // 分配——68 字节的伪造头声明 20000×20000 就能触发 1.5GB 分配。
  assert.throws(() => decodePng(fakeHeader(20000, 20000)), /尺寸过大/);
});

test('decodePng：零尺寸抛错', () => {
  assert.throws(() => decodePng(fakeHeader(0, 100)), /尺寸非法/);
});
