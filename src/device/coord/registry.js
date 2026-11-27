// family → 坐标策略映射（§5.5.2 registry）
import { Normalized1000Bbox, Normalized1000BboxYX, NormalizedUnitPoint, AbsolutePixel } from './strategy.js';

export const STRATEGIES = {
  xy1000: new Normalized1000Bbox(),
  yx1000: new Normalized1000BboxYX(),
  unitPoint: new NormalizedUnitPoint(),
  absolute: new AbsolutePixel(),
};

// §5.5.1 表格 + VLM 适配层扩展（2026-11-27）
// 新增 family 只改此表，session/model.js 委托 inferFamilyFromModelName。
const FAMILY_ALIASES = {
  glm: STRATEGIES.xy1000,
  qwen: STRATEGIES.xy1000,
  deepseek: STRATEGIES.xy1000,
  doubao: STRATEGIES.xy1000,
  kimi: STRATEGIES.unitPoint,
  gemini: STRATEGIES.yx1000,
  gpt: STRATEGIES.absolute,
  openai: STRATEGIES.absolute,
  minimax: STRATEGIES.xy1000,
  // 长键放后面：前缀匹配时短键优先（qwen 先于 qwen-vl/qwen-legacy）
  'qwen-vl': STRATEGIES.xy1000,      // qwen3-vl/qwen3.8 系列（bbox_2d 0-1000）
  'qwen-legacy': STRATEGIES.absolute, // qwen2.5-vl（像素坐标）
  'tencent-hy': STRATEGIES.xy1000,   // hy4/hy4-flash（box_2d 0-1000）
};

const custom = new Map();

export function registerStrategy(family, strategy) {
  custom.set(String(family).toLowerCase().trim(), strategy);
}

export function resolveStrategy(family) {
  if (!family) return null;
  const f = String(family).toLowerCase().trim();
  const exact = custom.get(f) ?? FAMILY_ALIASES[f];
  if (exact) return exact;
  const entries = [...custom.entries(), ...Object.entries(FAMILY_ALIASES)];
  for (const [k, s] of entries) if (f.startsWith(k)) return s;
  // 未命中返回 null——调用方走 probe 探测（probe.js inferFamily）或显式报错，不猜。
  return null;
}

// 模型名 → family 推断：FAMILY_ALIASES 键前缀匹配（与 resolveStrategy 同款逻辑），
// family 清单的单一真源——新增 family 只改 FAMILY_ALIASES，session/model.js 委托本函数。
export function inferFamilyFromModelName(modelName = '') {
  const normalizedName = String(modelName).toLowerCase().trim();
  if (!normalizedName) return null;
  for (const familyKey of Object.keys(FAMILY_ALIASES)) {
    if (normalizedName.startsWith(familyKey)) {
      // openai 归一化为 gpt：两者共用绝对像素策略，对外统一报 gpt
      return familyKey === 'openai' ? 'gpt' : familyKey;
    }
  }
  return null;
}

// 探测代表集：每个策略取 FAMILY_ALIASES 中首个登记的 family 作为代表，
// 从 STRATEGIES 派生——新增策略时 probe 无需再同步登记。
export const REPRESENTATIVES = Object.entries(STRATEGIES)
  .map(([sid, strategy]) => [Object.entries(FAMILY_ALIASES).find(([, s]) => s === strategy)?.[0] ?? sid, strategy]);

