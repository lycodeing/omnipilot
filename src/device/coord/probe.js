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

// modelIdentifier 可选（`${modelName}::${baseUrlHash}`）：传入且缓存中记录的也非空时，
// 两者不一致视为无效缓存返回 null——换模型/换端点后不复用旧 family。
// 未传或缓存无此字段时保持原行为（向后兼容）。
export function loadProbeFamily(file = probeCachePath(), modelIdentifier) {
  try {
    const cachedRecord = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof cachedRecord.family !== 'string') return null;
    const cachedModelIdentifier = cachedRecord.modelIdentifier;
    if (modelIdentifier && cachedModelIdentifier && modelIdentifier !== cachedModelIdentifier) return null;
    return cachedRecord.family;
  } catch {
    return null;
  }
}

// modelIdentifier 可选：写入后供 loadProbeFamily 校验缓存是否属于当前模型+端点。
export function saveProbeFamily(family, file = probeCachePath(), modelIdentifier) {
  mkdirSync(dirname(file), { recursive: true });
  const cacheRecord = { family, probedAt: new Date().toISOString() };
  if (modelIdentifier) cacheRecord.modelIdentifier = modelIdentifier;
  const temporaryFile = `${file}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(cacheRecord, null, 2));
  renameSync(temporaryFile, file);
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
