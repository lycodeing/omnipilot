// 截图密码框遮罩：password 节点 bounds 区域填充灰色，防凭据明文进报告截图。
// 纯函数：解码 → 改写像素 → 重新编码；无 password 节点或解码失败时原样返回（尽力而为）。
import { decodePng, encodePng } from '../image/png.js';

export function redactScreenshot(pngBuffer, nodes) {
  const pwd = (nodes ?? []).filter((n) => n?.password && Array.isArray(n.bounds));
  if (!pwd.length) return pngBuffer;
  let dec;
  try { dec = decodePng(pngBuffer); } catch { return pngBuffer; }
  const { width, height, bpp, colorType, pixels } = dec;
  for (const n of pwd) {
    const [l, t, r, b] = n.bounds;
    for (let y = Math.max(0, t); y < Math.min(height, b); y++) {
      for (let x = Math.max(0, l); x < Math.min(width, r); x++) {
        const i = (y * width + x) * bpp;
        // 灰度（bpp=1）只一通道；RGB/RGBA 前 3 通道填灰；RGBA 顺带把 alpha 置不透明，
        // 避免原图 alpha=0 的透明密码区遮罩后仍透出底层内容。
        pixels[i] = 128;
        if (bpp >= 3) { pixels[i + 1] = 128; pixels[i + 2] = 128; }
        if (bpp === 4) pixels[i + 3] = 255;
      }
    }
  }
  // encodePng 仅支持输出 RGB(2)/RGBA(6)：灰度(0) 解码出的是 1 字节/像素缓冲，
  // 直接按原 colorType 重编码会因 stride 按 3 通道计算而越界抛错。灰度输入先膨胀成
  // 3 通道 RGB 再编码（真实 screencap 不出灰度，此为对通用解码器的防御，遮罩仍生效）。
  let outPixels = pixels;
  let outColorType = colorType;
  if (bpp === 1) {
    outPixels = Buffer.alloc(width * height * 3);
    for (let p = 0; p < width * height; p++) {
      const v = pixels[p];
      outPixels[p * 3] = v; outPixels[p * 3 + 1] = v; outPixels[p * 3 + 2] = v;
    }
    outColorType = 2;
  }
  try { return encodePng(width, height, outPixels, outColorType); } catch { return pngBuffer; }
}
