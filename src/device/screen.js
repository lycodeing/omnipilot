// screencap → PNG Buffer；wm size 解析（§3.0.1 480ms 通道）
// screencap 须经 exec-out 传输：`adb -s X screencap` 会报 unknown command（adb.exe 无此子命令）
export async function screencap(adb, { timeoutMs } = {}) {
  const buf = await adb.execOut(['exec-out', 'screencap', '-p'], { timeoutMs, binary: true });
  if (!buf || buf.length < 8 || buf.subarray(1, 4).toString('latin1') !== 'PNG') {
    throw new Error(`screencap 返回异常（${buf ? buf.length : 0} 字节，非 PNG）`);
  }
  return buf;
}

// Override size（实际生效分辨率）优先于 Physical size
export function parseWmSize(text) {
  if (!text) return null;
  const override = /Override size:\s*(\d+)x(\d+)/.exec(text);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(text);
  const m = override ?? physical;
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

// 判定 wm size 输出是否属"设备/服务未就绪"（冷启动期 window 服务未起、shell 报错等），
// 与"输出格式异常"区分开，便于排查（否则冷启动失败会误报成解析 bug）
export function isDeviceNotReady(text) {
  const s = String(text ?? '').trim();
  if (!s) return true; // 空输出：服务未就绪的典型表现
  return /service not ready|cannot find|not found|no such|inaccessible|device offline|error:|sh:/i.test(s);
}

export class ScreenSizeError extends Error {
  constructor(message, { notReady = false } = {}) {
    super(message);
    this.name = 'ScreenSizeError';
    this.notReady = notReady;
  }
}

export async function readScreenSize(adb, { timeoutMs } = {}) {
  const out = await adb.shell('wm size', { timeoutMs });
  const size = parseWmSize(out);
  if (size) return size;
  if (isDeviceNotReady(out)) {
    throw new ScreenSizeError(`设备未就绪：wm size 无有效输出（${out.trim().slice(0, 80) || '空'}）`, { notReady: true });
  }
  throw new ScreenSizeError(`无法解析 wm size 输出: ${out.trim().slice(0, 100)}`);
}
