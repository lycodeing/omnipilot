// family → 坐标策略映射（§5.5.2 registry）
import { Normalized1000Bbox, Normalized1000BboxYX, NormalizedUnitPoint, AbsolutePixel } from './strategy.js';

export const STRATEGIES = {
  xy1000: new Normalized1000Bbox(),
  yx1000: new Normalized1000BboxYX(),
  unitPoint: new NormalizedUnitPoint(),
  absolute: new AbsolutePixel(),
};

// §5.5.1 表格：glm/qwen/deepseek/doubao → xy·1000；kimi → 0-1 point；gemini → yx；gpt → 绝对像素
const FAMILY_ALIASES = {
  glm: STRATEGIES.xy1000,
  qwen: STRATEGIES.xy1000,
  deepseek: STRATEGIES.xy1000,
  doubao: STRATEGIES.xy1000,
  kimi: STRATEGIES.unitPoint,
  gemini: STRATEGIES.yx1000,
  gpt: STRATEGIES.absolute,
  openai: STRATEGIES.absolute,
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
  // includes 模糊匹配已删（2026-11-10 评审 #15）："mygptx" 之类未知名曾凭子串静默误路由到
  // gpt 策略。未命中返回 null——调用方走 probe 探测（probe.js inferFamily）或显式报错，不猜。
  return null;
}

// 探测代表集（评审 #15）：每个策略取 FAMILY_ALIASES 中首个登记的 family 作为代表，
// 从 STRATEGIES 派生——新增策略时 probe 无需再同步登记（此前两处清单会漂移）。
export const REPRESENTATIVES = Object.entries(STRATEGIES)
  .map(([sid, strategy]) => [Object.entries(FAMILY_ALIASES).find(([, s]) => s === strategy)?.[0] ?? sid, strategy]);

