// 极简 PNG 解码（仅 adb screencap 产物所需子集）：8-bit、非隔行、色彩类型 2(RGB)/6(RGBA)/0(灰度)。
// 用途：tapEachRow 的选中态像素校验（WebView 选择态不进 a11y 树，只能看像素）；
//      以及 scroll 的"画面变没变"签名（比整树 dump 快 1-2 个数量级，见 screenSignature）。
// 解码核心复用 image/png 单一实现（零依赖、纯函数），本模块只做字段映射与消费方接口适配。
import { createHash } from 'node:crypto';
import { decodePng as decodeCore } from '../image/png.js';

// 返回 { width, height, channels, data }，data 为按行的原始像素（channels=bpp，data=pixels）。
// 委托 image/png 核心：灰度（colorType=0）时 channels=1，消费方 pixelAt/screenSignature 行为不变。
export function decodePng(buf) {
  const { width, height, bpp, pixels } = decodeCore(buf);
  return { width, height, channels: bpp, data: pixels };
}

// 取像素 RGB（channels=1 时灰度三通道同值）
export function pixelAt(png, x, y) {
  const { width, height, channels, data } = png;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const i = (y * width + x) * channels;
  if (channels === 1) return [data[i], data[i], data[i]];
  return [data[i], data[i + 1], data[i + 2]];
}

// 选中态判据（'auto' 兜底启发式）：蓝色填充（b 明显高于 r，且 b 足够亮）；未选中灰底三通道接近。
// 主题色非蓝色的 App 请在 tapEachRow 显式传 verifyColor（hex/RGB），不要依赖本启发式。
export function isBlueish([r, g, b]) {
  return b > 140 && b - r > 40 && g > r - 20;
}

// 指定颜色容差匹配：|Δ| 各通道 ≤ tol（默认 48，容忍抗锯齿/渐变）。
export function isColorish([r, g, b], [tr, tg, tb], tol = 48) {
  return Math.abs(r - tr) <= tol && Math.abs(g - tg) <= tol && Math.abs(b - tb) <= tol;
}

// '#RRGGBB' → [r,g,b]；解析失败返回 null
export function parseHexColor(s) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(s ?? '').trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

// 屏幕内容签名（scroll 等"画面变没变"判定用）：等距采样 RGB 后 sha1 取前 16 位。
// 为什么不用整树 hash：busy WebView 上一次 a11y dump 要 4-30s（uia2）乃至 38-55s（legacy），
// 而截图+解码+采样实测 0.5-1s（解码 116-141ms / 采样 1-2ms）。签名对 CSS 动画、选中高亮等
// **不改 a11y 树**的变化同样敏感，恰好覆盖 WebView 类页面。
// 采样步长 40px、上下各跳过 6%（实测 1080×2400 约 1400 采样点）。步长过大漏小面积变化，
// 过小收益递减。
export function screenSignature(buf, { step = 40, marginPct = 0.06 } = {}) {
  const png = decodePng(buf);
  const top = Math.round(png.height * marginPct);
  const bottom = Math.round(png.height * (1 - marginPct));
  const h = createHash('sha1');
  for (let y = top; y < bottom; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const px = pixelAt(png, x, y);
      if (px) h.update(`${px[0]},${px[1]},${px[2]};`);
    }
  }
  return h.digest('hex').slice(0, 16);
}
