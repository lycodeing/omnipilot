// 纯 JS PNG 下采样（§16：截图压缩，无需外部库——契约禁止 npm install，用 Node 内置 zlib）。
//
// 用途：截图进模型上下文前降尺寸，减少 prompt tokens（实测 20 张 1080×2400 图 → 67k tokens、单轮 26s）。
// 只处理 screencap 产出的标准 PNG：8 位、颜色类型 6(RGBA) 或 2(RGB)、非隔行、filter 0-4。
// 降采样用「块平均」（2×向下取整），生成新的真彩 PNG。

import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG filter 反解（每行首字节是 filter 类型）
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const src = raw.subarray(pos, pos + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      row[x] = v & 0xff;
    }
    pos += stride;
  }
  return out;
}

// 每行加 filter=0 前缀（不预测，最简单，配合 zlib 仍能压得不错）
function filterNone(pixels, stride, height) {
  const out = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (stride + 1)] = 0;
    pixels.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return out;
}

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 解析 PNG → { width, height, bpp, pixels(RGBA/RGB 连续字节) }
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('不是合法 PNG');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8) throw new Error(`仅支持 8 位 PNG（实际 ${bitDepth}）`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`仅支持 RGBA(6)/RGB(2) PNG（实际颜色类型 ${colorType}）`);

  const idats = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    if (type === 'IDAT') idats.push(buf.subarray(off + 8, off + 8 + len));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const pixels = unfilter(raw, width, height, bpp);
  return { width, height, bpp, colorType, pixels };
}

// RGBA/RGB 像素 → PNG Buffer
export function encodePng(width, height, pixels, colorType = 6) {
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(filterNone(pixels, stride, height), { level: 6 });
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 块平均降采样（factor>=2 的整数倍）
export function downscale(png, { factor = 2 } = {}) {
  const f = Math.max(2, Math.floor(factor));
  const { width, height, bpp, colorType, pixels } = decodePng(png);
  const nw = Math.max(1, Math.floor(width / f));
  const nh = Math.max(1, Math.floor(height / f));
  const out = Buffer.alloc(nw * nh * bpp);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const acc = new Array(bpp).fill(0);
      let n = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = y * f + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < f; dx++) {
          const sx = x * f + dx;
          if (sx >= width) break;
          const i = (sy * width + sx) * bpp;
          for (let k = 0; k < bpp; k++) acc[k] += pixels[i + k];
          n++;
        }
      }
      const o = (y * nw + x) * bpp;
      for (let k = 0; k < bpp; k++) out[o + k] = Math.round(acc[k] / n);
    }
  }
  return { buffer: encodePng(nw, nh, out, colorType), width: nw, height: nh };
}

// 便捷：按目标最大宽度降采样（选 2 的幂因子，返回原图或缩小图）
export function shrinkPng(png, { maxWidth = 540 } = {}) {
  let { width } = decodePng(png);
  if (width <= maxWidth) return { buffer: png, width, scaled: false };
  let factor = 1;
  while (Math.floor(width / factor) > maxWidth) factor *= 2;
  const r = downscale(png, { factor });
  return { buffer: r.buffer, width: r.width, height: r.height, scaled: true, factor };
}

// —— 截图的统一"进上下文"压缩入口（§17）——
// 目标：base64 后体积最小，且模型仍能看清。
// 实测（540×1200）：PNG 194KB → JPEG(q70) ~75KB（省 61%）；模型对 JPEG 无感（能准确读图内文字）。
// 策略：先按 maxWidth 降采样（PNG 域，块平均保色准），再编码 JPEG。
export async function compressForContext(png, { maxWidth = 540, quality = 70 } = {}) {
  const { encodeJpeg } = await import('./jpeg.js');
  const small = shrinkPng(png, { maxWidth });
  const { decodePng: dec } = await import('./png.js');
  const d = dec(small.buffer);
  const jpg = encodeJpeg(d.width, d.height, d.pixels, { quality, bpp: d.bpp });
  // 取更小的那个（JPEG 通常更小，但极小图上 PNG 可能更优）
  if (jpg.length < small.buffer.length) {
    return { buffer: jpg, mimeType: 'image/jpeg', width: d.width, height: d.height, format: 'jpeg', originalBytes: png.length };
  }
  return { buffer: small.buffer, mimeType: 'image/png', width: small.width, height: small.height, format: 'png', originalBytes: png.length };
}
