// 极简 PNG 解码（仅 adb screencap 产物所需子集）：8-bit、非隔行、色彩类型 2(RGB)/6(RGBA)。
// 用途：tapEachRow 的选中态像素校验（WebView 选择态不进 a11y 树，只能看像素）。
// 不引第三方依赖：zlib 用 node 内置，CRC/滤波手工实现（~80 行，纯函数可单测）。
import zlib from 'node:zlib';

function readUInt32(buf, off) { return buf.readUInt32BE(off); }

// 返回 { width, height, channels, data }，data 为按行的原始 RGBA/RGB 像素（未去滤波前的 IDAT 已解压）
export function decodePng(buf) {
  if (!buf || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let off = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; let interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = readUInt32(buf, off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = readUInt32(data, 0);
      height = readUInt32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`不支持的 PNG: bitDepth=${bitDepth} interlace=${interlace}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  if (!channels) throw new Error(`不支持的 PNG 色彩类型: ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos + x];
      const a = x >= channels ? row[x - channels] : 0; // left
      const b = prev ? prev[x] : 0; // up
      const c = prev && x >= channels ? prev[x - channels] : 0; // up-left
      let v;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`未知 PNG 滤波类型: ${filter}`);
      }
      row[x] = v & 0xff;
    }
    pos += stride;
  }
  return { width, height, channels, data: out };
}

// 取像素 RGB（channels=1 时灰度三通道同值）
export function pixelAt(png, x, y) {
  const { width, height, channels, data } = png;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const i = (y * width + x) * channels;
  if (channels === 1) return [data[i], data[i], data[i]];
  return [data[i], data[i + 1], data[i + 2]];
}

// 选中态判据：蓝色填充（b 明显高于 r，且 b 足够亮）；未选中灰底三通道接近。
export function isBlueish([r, g, b]) {
  return b > 140 && b - r > 40 && g > r - 20;
}
