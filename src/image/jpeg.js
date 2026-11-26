// 纯 JS 基线 JPEG 编码（§17：截图转 JPEG，比 PNG 省约 64% 体积，无外部库）。
//
// 动机：截图进模型上下文要 base64 传输，体积越大 token 越多。540×1200：
//   PNG 194KB → JPEG(70) 69KB（省 64%）；且模型对 JPEG 无感（能准确读图内文字）。
// 实现：RGB→YCbCr → 4:2:0 色度下采样 → 8×8 FDCT → 量化 → 之字形 → Huffman（标准 Annex K 表）。

// —— 标准量化表（Annex K，quality=50 基准）——
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const Q_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const Q_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

// —— 标准 Huffman 表（Annex K）——
const DC_LUMA_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const DC_CHROMA_BITS = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_CHROMA_BITS = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

// 由 BIT 长度表构建 Huffman 码表：code[value] = {bits, code}
function buildHuffTable(bits, vals) {
  const table = new Array(256).fill(null);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len]; i++) {
      table[vals[k]] = { bits: len, code };
      code++; k++;
    }
    code <<= 1;
  }
  return table;
}

const HUFF_DC_LUMA = buildHuffTable(DC_LUMA_BITS, DC_LUMA_VALS);
const HUFF_AC_LUMA = buildHuffTable(AC_LUMA_BITS, AC_LUMA_VALS);
const HUFF_DC_CHROMA = buildHuffTable(DC_CHROMA_BITS, DC_CHROMA_VALS);
const HUFF_AC_CHROMA = buildHuffTable(AC_CHROMA_BITS, AC_CHROMA_VALS);

// 预计算 DCT 余弦表
const COS = (() => {
  const c = [];
  for (let u = 0; u < 8; u++) { c[u] = []; for (let x = 0; x < 8; x++) c[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16); }
  return c;
})();
const CU = [1 / Math.SQRT2, 1, 1, 1, 1, 1, 1, 1];

// 8×8 前向 DCT（分离式：先行后列）
function fdct(block) {
  const tmp = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[u][x];
      tmp[y * 8 + u] = s * (CU[u] / 2);
    }
  }
  const out = new Float32Array(64);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[v][y];
      out[v * 8 + u] = s * (CU[v] / 2);
    }
  }
  return out;
}

function scaleQuant(base, quality) {
  const q = Math.min(100, Math.max(1, quality));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return base.map((v) => {
    const t = Math.floor((v * scale + 50) / 100);
    return Math.min(255, Math.max(1, t));
  });
}

// 位写入器（含 0xFF 字节填充）
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  write(code, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.n++;
      if (this.n === 8) {
        this.bytes.push(this.acc & 0xff);
        if ((this.acc & 0xff) === 0xff) this.bytes.push(0x00); // stuffing
        this.acc = 0; this.n = 0;
      }
    }
  }
  flush() {
    while (this.n > 0) this.write(1, 1); // 补 1 到字节边界
  }
  buffer() { return Buffer.from(this.bytes); }
}

// 数值 → (size, bits)：JPEG 的幅值编码
function magnitude(v) {
  const a = Math.abs(v);
  let size = 0;
  while (a >> size) size++;
  if (size === 0) return { size: 0, bits: 0 };
  let bits = v < 0 ? v - 1 + (1 << size) : v; // 负数用反码
  return { size, bits: bits & ((1 << size) - 1) };
}

function encodeBlock(w, coeffs, quant, huffDC, huffAC, prevDC) {
  const q = new Int32Array(64);
  for (let i = 0; i < 64; i++) q[i] = Math.round(coeffs[i] / quant[i]);
  const diff = q[0] - prevDC;
  const dc = magnitude(diff);
  const dcCode = huffDC[dc.size];
  if (!dcCode) throw new Error(`DC 码字缺失: size=${dc.size}`);
  w.write(dcCode.code, dcCode.bits);
  if (dc.size) w.write(dc.bits, dc.size);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = q[ZIGZAG[k]];
    if (v === 0) { run++; continue; }
    while (run > 15) { const zrl = huffAC[0xf0]; w.write(zrl.code, zrl.bits); run -= 16; }
    const m = magnitude(v);
    const sym = (run << 4) | m.size;
    const code = huffAC[sym];
    if (!code) throw new Error(`AC 码字缺失: sym=0x${sym.toString(16)}`);
    w.write(code.code, code.bits);
    w.write(m.bits, m.size);
    run = 0;
  }
  if (run > 0) { const eob = huffAC[0x00]; w.write(eob.code, eob.bits); }
  return q[0];
}

function marker(m, payload) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE((payload ? payload.length : 0) + 2);
  return Buffer.concat([Buffer.from([0xff, m]), len, payload || Buffer.alloc(0)]);
}

// RGBA/RGB 像素 → 基线 JPEG（4:2:0）
export function encodeJpeg(width, height, pixels, { quality = 70, bpp = 4 } = {}) {
  const qLuma = scaleQuant(Q_LUMA, quality);
  const qChroma = scaleQuant(Q_CHROMA, quality);

  // RGB → YCbCr（整图，再对色度 2×2 下采样）
  const Y = new Float32Array(width * height);
  const Cb = new Float32Array(width * height);
  const Cr = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * bpp;
    const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  }
  const cw = Math.ceil(width / 2), chh = Math.ceil(height / 2);
  const CbS = new Float32Array(cw * chh);
  const CrS = new Float32Array(cw * chh);
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      let sb = 0, sr = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sy = y * 2 + dy, sx = x * 2 + dx;
        if (sy < height && sx < width) { const i = sy * width + sx; sb += Cb[i]; sr += Cr[i]; n++; }
      }
      CbS[y * cw + x] = sb / n; CrS[y * cw + x] = sr / n;
    }
  }

  const bw = Math.ceil(width / 8), bh = Math.ceil(height / 8);
  const cbw = Math.ceil(cw / 8), cbh = Math.ceil(chh / 8);

  const blockOf = (src, sw, sh, bx, by) => {
    const blk = new Float32Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const sy = by * 8 + y, sx = bx * 8 + x;
      const v = (sy < sh && sx < sw) ? src[sy * sw + sx] : 0;
      blk[y * 8 + x] = v - 128; // level shift
    }
    return blk;
  };

  const w = new BitWriter();
  let dcY = 0, dcCb = 0, dcCr = 0;
  // 4:2:0 必须**按 MCU 交错**编码：每个 MCU = 4 个 Y 块(2×2) + 1 个 Cb + 1 个 Cr（按平面分组会解出彩色噪点）。
  for (let my = 0; my < cbh; my++) {
    for (let mx = 0; mx < cbw; mx++) {
      // Y 的 2×2 块
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const bx = mx * 2 + dx, by = my * 2 + dy;
          dcY = encodeBlock(w, fdct(blockOf(Y, width, height, bx, by)), qLuma, HUFF_DC_LUMA, HUFF_AC_LUMA, dcY);
        }
      }
      // 1 个 Cb + 1 个 Cr
      dcCb = encodeBlock(w, fdct(blockOf(CbS, cw, chh, mx, my)), qChroma, HUFF_DC_CHROMA, HUFF_AC_CHROMA, dcCb);
      dcCr = encodeBlock(w, fdct(blockOf(CrS, cw, chh, mx, my)), qChroma, HUFF_DC_CHROMA, HUFF_AC_CHROMA, dcCr);
    }
  }
  w.flush();

  // —— 组装文件 ——
  const dqt = Buffer.concat([
    Buffer.from([0x00]), Buffer.from(qLuma),
    Buffer.from([0x01]), Buffer.from(qChroma),
  ]);
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  sof[6] = 1; sof[7] = 0x22; sof[8] = 0x00;
  sof[9] = 2; sof[10] = 0x11; sof[11] = 0x01;
  sof[12] = 3; sof[13] = 0x11; sof[14] = 0x01;

  const dht = Buffer.concat([
    Buffer.from([0x00]), Buffer.from(DC_LUMA_BITS.slice(1)), Buffer.from(DC_LUMA_VALS),
    Buffer.from([0x10]), Buffer.from(AC_LUMA_BITS.slice(1)), Buffer.from(AC_LUMA_VALS),
    Buffer.from([0x01]), Buffer.from(DC_CHROMA_BITS.slice(1)), Buffer.from(DC_CHROMA_VALS),
    Buffer.from([0x11]), Buffer.from(AC_CHROMA_BITS.slice(1)), Buffer.from(AC_CHROMA_VALS),
  ]);

  const sos = Buffer.from([0x03, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  const app0 = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),          // SOI
    marker(0xe0, app0),                 // APP0 (JFIF)
    marker(0xdb, dqt),                  // DQT
    marker(0xc0, sof),                  // SOF0
    marker(0xc4, dht),                  // DHT
    marker(0xda, sos),                  // SOS
    w.buffer(),                         // 熵数据
    Buffer.from([0xff, 0xd9]),          // EOI
  ]);
}
