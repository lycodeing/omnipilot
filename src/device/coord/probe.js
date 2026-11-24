// 未知 family 的探测式推断（§5.5.3）：已知位置元素 → 各策略换算 → 唯一命中者胜
// 结果记入 .ask/family-probe.json 供复用；多命中/全不命中 → 拒绝，不猜
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPRESENTATIVES } from './registry.js';
import { pointInBounds } from './strategy.js';

// raw 按各策略换算，换算结果（点或 bbox 中心）落在 knownBounds 内者计命中
export function inferFamily(raw, size, knownBounds) {
  const hits = [];
  for (const [family, strategy] of REPRESENTATIVES) {
    const r = strategy.toPixels(raw, size);
    if (r.center && pointInBounds(r.center, knownBounds)) hits.push(family);
  }
  return hits.length === 1 ? hits[0] : null;
}

export function probeCachePath(dir = process.cwd()) {
  return join(dir, '.ask', 'family-probe.json');
}

export function loadProbeFamily(file = probeCachePath()) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return typeof j.family === 'string' ? j.family : null;
  } catch {
    return null;
  }
}

export function saveProbeFamily(family, file = probeCachePath()) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ family, probedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, file);
}

// 用一次 VLM 调用探测：known = { target, bounds }（如左上角返回箭头的已知 bounds）
export async function probeFamily({ vlm, png, size, known, file } = {}) {
  if (!vlm || !known?.bounds) return { family: null, raw: null };
  const raw = await vlm({
    png: png ?? null,
    size,
    target: known.target ?? '已知位置元素',
    instruction: `Locate "${known.target ?? 'the element'}" in the screenshot and return its coordinates.`,
  });
  const rawValue = raw?.raw ?? raw;
  const family = inferFamily(rawValue, size, known.bounds);
  if (family) saveProbeFamily(family, file);
  return { family, raw: rawValue };
}
