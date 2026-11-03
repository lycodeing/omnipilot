import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, pixelAt, isBlueish, isColorish, parseHexColor, screenSignature } from '../src/device/png.js';

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

test('isColorish / parseHexColor：任意主题色容差匹配（通用化）', () => {
  assert.deepEqual(parseHexColor('#2196F3'), [33, 150, 243]);
  assert.deepEqual(parseHexColor('2196f3'), [33, 150, 243]);
  assert.equal(parseHexColor('zzz'), null);
  assert.equal(parseHexColor(''), null);
  // 红色主题选中态：isBlueish 判 false，isColorish 按指定色判 true
  assert.equal(isBlueish([229, 57, 53]), false);
  assert.equal(isColorish([229, 57, 53], [244, 67, 54]), true);
  assert.equal(isColorish([245, 246, 248], [244, 67, 54]), false);
  // 容差边界
  assert.equal(isColorish([100, 100, 100], [100, 100, 100], 0), true);
  assert.equal(isColorish([100, 100, 100], [110, 100, 100], 5), false);
  assert.equal(isColorish([105, 100, 100], [100, 100, 100], 5), true);
});

test('decodePng：非 PNG 输入抛错', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /不是 PNG/);
});

// scroll 的变化检测从整树 hash 换成屏幕像素签名（性能修复）：busy WebView 上一次 a11y dump
// 4-30s（uia2）/ 38-55s（legacy），而截图+解码+采样 0.5-1s。签名必须满足：同画面同签名、
// 任一显著像素变化即变签名、与尺寸无关地稳定。
test('screenSignature：同画面稳定，像素变化即变签名', () => {
  const flat = Buffer.from(Array.from({ length: W * H }, () => px(245, 246, 248)).flat());
  const pngA = makePng(W, H, flat);
  const pngB = makePng(W, H, flat);
  assert.equal(screenSignature(pngA), screenSignature(pngB), '同像素 → 同签名');
  assert.equal(screenSignature(pngA), screenSignature(pngA), '重复调用稳定');

  // 单像素变化：4×3 图在 40px 步长下只会采到左上角一点 → 用 step=1 保证覆盖
  const changed = Buffer.from(flat);
  changed[0] = 0; changed[1] = 0; changed[2] = 0;
  const pngC = makePng(W, H, changed);
  assert.notEqual(screenSignature(pngA, { step: 1, marginPct: 0 }), screenSignature(pngC, { step: 1, marginPct: 0 }), '像素变化 → 签名变化');
});

test('screenSignature：跳过上下边缘（状态栏/导航栏时钟不触发"画面变化"）', () => {
  // 4×3 图：marginPct=0.34 → 只采中间行（y=1）。改第 0 行（顶部）签名不变，改第 1 行才变
  const base = Buffer.from(Array.from({ length: W * H }, () => px(20, 20, 20)).flat());
  const topChanged = Buffer.from(base);
  for (let x = 0; x < W * 3; x++) topChanged[x] = 255; // 第 0 行整行变白
  const midChanged = Buffer.from(base);
  for (let x = W * 3; x < W * 6; x++) midChanged[x] = 255; // 第 1 行整行变白
  const sig = (buf2) => screenSignature(makePng(W, H, buf2), { step: 1, marginPct: 0.34 });
  assert.equal(sig(base), sig(topChanged), '顶部边缘变化被跳过');
  assert.notEqual(sig(base), sig(midChanged), '中间区域变化被采到');
});
