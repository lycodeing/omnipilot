// 动作命令封装（§5.4）：基于 bounds 中心点 / 点 / 区域名 → adb input
export const KEYCODES = {
  back: 4,
  home: 3,
  enter: 66,
  recent: 187,
  app_switch: 187,
  menu: 82,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  tab: 61,
  delete: 67,
};

export function centerOf([l, t, r, b]) {
  return [Math.floor((l + r) / 2), Math.floor((t + b) / 2)];
}

// 区域名 → 边缘参考点（'bottom'→[w/2, h*0.8] 等，供 swipe/scroll）
export function regionPoint(name, size) {
  switch (String(name).toLowerCase()) {
    case 'bottom': return [Math.floor(size.w / 2), Math.floor(size.h * 0.8)];
    case 'top': return [Math.floor(size.w / 2), Math.floor(size.h * 0.2)];
    case 'left': return [Math.floor(size.w * 0.2), Math.floor(size.h / 2)];
    case 'right': return [Math.floor(size.w * 0.8), Math.floor(size.h / 2)];
    default: throw new Error(`未知区域名: ${name}（可用: top/bottom/left/right）`);
  }
}

// 按距离滚动起止点（§2.4）：distancePct 为屏高百分比。
// 纵向滚动的起止点必须避开屏幕最上/最下缘——从 y < 0.10h 起手会触发系统下拉通知栏把 App 顶出前台；
// 且需在屏内。故纵向安全区取 [0.12h, 0.88h]，横向取屏宽的 [0.05w, 0.95w]。
// 本函数吃**手指滑动方向**（'up'=手指上滑=看更多下方内容）；device.scroll 对外是内容语义，
// 内部换算后传入本函数。与 regionPoint 的 from/to 区域一致。
export function scrollDistancePoints(direction, size, distancePct = 60) {
  const h = size.h;
  const w = size.w;
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  // 纵向安全区（避开通知栏与手势区）
  const vLo = Math.round(h * 0.12);
  const vHi = Math.round(h * 0.88);
  const vSpan = vHi - vLo;
  // 横向安全区
  const hLo = Math.round(w * 0.05);
  const hHi = Math.round(w * 0.95);
  const hSpan = hHi - hLo;
  const d = String(direction ?? 'down').toLowerCase();
  // 钳制距离百分比：0/负值会让起止点重合，input swipe 同点 ≈ 一次误触点击
  const pct = Math.max(1, Math.min(100, Number(distancePct) || 0));
  const vDist = Math.round((vSpan * pct) / 100);
  const hDist = Math.round((hSpan * pct) / 100);
  if (d === 'down') return [[cx, vLo], [cx, Math.min(vHi, vLo + vDist)]];
  if (d === 'up') return [[cx, vHi], [cx, Math.max(vLo, vHi - vDist)]];
  if (d === 'right') return [[hLo, cy], [hLo + hDist, cy]];
  // left（默认兜底）
  return [[hHi, cy], [Math.max(hLo, hHi - hDist), cy]];
}

// §5.4.1：中心 + 4 内缩点（各向内缩 25%），过滤屏幕外；中心优先
export function pickPoint([l, t, r, b], size) {
  const cx = Math.floor((l + r) / 2);
  const cy = Math.floor((t + b) / 2);
  const w = r - l;
  const h = b - t;
  const candidates = [
    [cx, cy],
    [Math.floor(l + w * 0.25), cy],
    [Math.floor(l + w * 0.75), cy],
    [cx, Math.floor(t + h * 0.25)],
    [cx, Math.floor(t + h * 0.75)],
  ];
  const ok = candidates.filter(([x, y]) => x >= 0 && y >= 0 && x < size.w && y < size.h);
  // 回退也必须在屏幕内：全部候选越界时直接返回原中心会给出屏幕外坐标
  // （facade 的 tap(bounds) 是公开方法，不保证调用方已过滤），点击会落在别处。
  // 越界时钳到屏幕内边缘——宁可点在边缘，也不点空。
  if (ok.length) return ok[0];
  const clampedX = Math.min(Math.max(cx, 0), Math.max(0, size.w - 1));
  const clampedY = Math.min(Math.max(cy, 0), Math.max(0, size.h - 1));
  return [clampedX, clampedY];
}

// bounds([l,t,r,b]) | [x,y] | 区域名 → [x,y]
export function resolvePoint(p, size) {
  if (typeof p === 'string') return regionPoint(p, size);
  if (Array.isArray(p) && p.length === 4) return pickPoint(p, size);
  if (Array.isArray(p) && p.length === 2) return [Math.round(p[0]), Math.round(p[1])];
  throw new Error(`无法解析点位: ${JSON.stringify(p)}`);
}

// 写操作统一检查远端退出码：input tap/swipe/keyevent 在设备侧失败时
// （如缺 INJECT_EVENTS 权限）stdout 为空、错误在 stderr 且退出码非 0。
// 不检查就会把失败当成功返回——引擎据此以为点击成功，进而报出
// renderer_unresponsive 之类指向错误方向的诊断。
async function runWrite(adb, cmd, { timeoutMs } = {}) {
  const { code, stdout, stderr } = await adb.shell(cmd, { timeoutMs, withCode: true, withStderr: true });
  if (code !== 0) {
    const detail = String(stderr || stdout || '').trim();
    throw new Error(`设备侧命令失败(exit ${code}): ${cmd}${detail ? ` — ${detail}` : ''}`);
  }
  return stdout;
}

export async function tap(adb, [x, y], { timeoutMs } = {}) {
  return runWrite(adb, `input tap ${x} ${y}`, { timeoutMs });
}

// input swipe 同点 + duration 即长按（§5.4.4）
export async function longPress(adb, [x, y], durationMs = 800, { timeoutMs } = {}) {
  return runWrite(adb, `input swipe ${x} ${y} ${x} ${y} ${durationMs}`, { timeoutMs });
}

export async function swipe(adb, [x1, y1], [x2, y2], durationMs = 300, { timeoutMs } = {}) {
  return runWrite(adb, `input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, { timeoutMs });
}

export async function key(adb, name, { timeoutMs } = {}) {
  const code = KEYCODES[String(name).toLowerCase()];
  if (!code) throw new Error(`不支持的按键: ${name}（可用: ${Object.keys(KEYCODES).join('/')}）`);
  return runWrite(adb, `input keyevent ${code}`, { timeoutMs });
}
