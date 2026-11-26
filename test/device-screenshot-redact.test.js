// 截图密码框遮罩（Task 17）：password 节点 bounds 区域填充灰色，防凭据明文进报告截图。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { redactScreenshot } from '../src/device/screenshot-redact.js';
import { encodePng, decodePng } from '../src/image/png.js';

test('redactScreenshot：password 节点区域被填充', () => {
  const w = 10, h = 10;
  const px = Buffer.alloc(w * h * 4, 255); // 全白 RGBA
  const png = encodePng(w, h, px, 6);
  const nodes = [{ password: true, bounds: [2, 2, 5, 5] }];
  const out = redactScreenshot(png, nodes);
  const dec = decodePng(out);
  const i = (3 * w + 3) * 4;
  assert.equal(dec.pixels[i], 128, '遮罩区像素应为灰');
  const j = (0 * w + 0) * 4;
  assert.equal(dec.pixels[j], 255, '非遮罩区不变');
});

test('redactScreenshot：无 password 节点原样返回', () => {
  const px = Buffer.alloc(4 * 4 * 4, 200);
  const png = encodePng(4, 4, px, 6);
  assert.equal(redactScreenshot(png, []), png);
});

// encodePng 只支持输出 RGB(2)/RGBA(6)，造不出灰度 PNG；灰度样本手工构造（colorType=0、filter 0）。
// 守护：decodePng 支持灰度(0) 但 encodePng 不支持灰度重编码——遮罩若直接回传 colorType=0
// 会因 stride 按 3 通道计算而越界抛错。模块内部将灰度膨胀为 RGB 后再编码，遮罩仍生效。
function makeGrayPng(width, height, value) {
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter none
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = value;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8 位灰度
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('redactScreenshot：灰度(0) 输入也能遮罩（encodePng 不支持灰度重编码的防御）', () => {
  const w = 4, h = 4;
  const gray = makeGrayPng(w, h, 255);
  const dec = decodePng(redactScreenshot(gray, [{ password: true, bounds: [1, 1, 3, 3] }]));
  assert.equal(dec.bpp, 3, '灰度输入遮罩后按 RGB 重新编码');
  assert.equal(dec.pixels[(1 * w + 1) * 3], 128, '遮罩区应填灰');
  assert.equal(dec.pixels[0], 255, '非遮罩区不变');
});
