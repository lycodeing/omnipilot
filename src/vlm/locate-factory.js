// VLM 视觉定位函数工厂（设计文档 §3.4 / Phase 2.6，自 bin/ask.js 迁移）。
// runOne / cmdAsk / doctor probe-family 共用：截图压缩 → 坐标制式提示词 → ctx.chat 看图 → 原始应答。
// 增强路径：family 在 registry 命中策略且 adapters/index.js 有声明式定义时，
// 用 resolveAdapter 构建运行时适配器——提示词由 adapter.codec 生成（与解析同一份坐标元数据），
// 思考参数经 reasoning.js 按 family + 端点方言翻译后注入请求体。
// 兼容路径：adapters 目录缺席（并行开发窗口期）或 family 无定义时，回退原有 coordStrategy 提示词，行为不变。

import { resolveStrategy, inferFamilyFromModelName } from '../device/coord/registry.js';
import { resolveAdapter } from '../device/coord/adapter-resolver.js';
import { buildReasoningParams, detectEndpoint } from '../device/coord/reasoning.js';
import { compressForContext } from '../image/png.js';

/** VLM 定位截图压缩最大宽度（像素）：全尺寸 PNG base64 ~570KB/次太贵 */
const VLM_IMAGE_MAX_WIDTH = 720;
/** VLM 定位截图压缩质量（JPEG quality） */
const VLM_IMAGE_QUALITY = 70;
/** 坐标策略与适配器都缺席时的兜底坐标制式描述（与迁移前 bin/ask.js 一致） */
const FALLBACK_COORD_FORMAT = 'Return coordinates normalized to 0-1000.';

/**
 * 尝试加载 family 对应的声明式适配器并解析为运行时形态。
 * adapters/index.js 可能尚未就位（另一任务并行创建中）：dynamic import 容错，
 * 加载失败 / 无该 family 定义 / 定义非法一律返回 null，调用方回退旧路径。
 * 匹配顺序：精确键 → 最长前缀键（qwen-legacy 须优先于 qwen-vl）→ registry 归一化家族
 * （用户常配 'qwen'/'openai' 等泛 family，经 inferFamilyFromModelName 同款映射收敛到适配器键）。
 * @param {string} family 模型家族标识（如 'tencent-hy' / 'qwen-vl' / 'qwen'）
 * @returns {Promise<import('../device/coord/adapter-resolver.js').ResolvedModelAdapter|null>}
 */
async function tryResolveModelAdapter(family) {
  const normalizedFamily = String(family ?? '').toLowerCase().trim();
  if (!normalizedFamily) return null;
  try {
    const adaptersModule = await import('../device/coord/adapters/index.js');
    const definitionMap = adaptersModule.ADAPTER_DEFINITIONS ?? {};
    let adapterDefinition = definitionMap[normalizedFamily];
    if (!adapterDefinition) {
      const prefixCandidates = Object.entries(definitionMap)
        .filter(([familyKey]) => normalizedFamily.startsWith(familyKey))
        .sort(([leftKey], [rightKey]) => rightKey.length - leftKey.length);
      adapterDefinition = prefixCandidates[0]?.[1];
    }
    if (!adapterDefinition) {
      // 泛 family 归一化：registry 的 FAMILY_ALIASES 键（glm/qwen/gpt...）与适配器键不一一对应，
      // 复用 inferFamilyFromModelName 的前缀映射（openai→gpt），命中后再查一次精确键
      const canonicalFamily = inferFamilyFromModelName(normalizedFamily);
      if (canonicalFamily) adapterDefinition = definitionMap[canonicalFamily];
    }
    if (!adapterDefinition) return null;
    return resolveAdapter(adapterDefinition);
  } catch {
    // adapters 目录未就位或定义解析失败：静默回退，不阻断定位主链
    return null;
  }
}

/**
 * --vlm-locate 的视觉定位函数工厂（runOne / cmdAsk / doctor probe-family 共用）。
 * 坐标约定优先取声明式适配器的 codec.describeForPrompt()（提示词与解析共用同一份坐标元数据），
 * 无适配器时回退 model family 策略的 describeForPrompt；返回交给 locate 的 toPixels 解析。
 * 截图先经 compressForContext 降采样（全尺寸 PNG base64 ~570KB/次太贵）。
 * @param {object} ctx 运行上下文（需已注入 ctx.chat）
 * @param {object} modelConfig 模型配置（family 决定坐标约定与适配器；url/name 供思考参数端点方言翻译）
 * @returns {Promise<function({png: Buffer, target: string, instruction?: string}): Promise<{raw: string, family: string}>>}
 */
export async function buildVlmLocate(ctx, modelConfig) {
  const coordStrategy = resolveStrategy(modelConfig.family);
  // family 未显式配置时从模型名推断（与 session/model.js createModel 同款兜底）：
  // 否则用户只配 ASK_MODEL_NAME 时特化适配器永远匹配不到
  const adapterFamily = modelConfig.family || inferFamilyFromModelName(modelConfig.name);
  // 适配器自带坐标元数据（codec），不依赖 registry 登记：tencent-hy/qwen-vl 等新 family
  // 在 registry FAMILY_ALIASES 中尚未登记，若以 registry 命中为门槛这些适配器永远启用不了。
  // 加载失败 / 无定义时回退 coordStrategy 旧路径，行为与迁移前一致。
  const modelAdapter = await tryResolveModelAdapter(adapterFamily);
  const endpointType = detectEndpoint(modelConfig.url);
  return async ({ png, target, instruction }) => {
    let image = { data: png.toString('base64'), mimeType: 'image/png' };
    try {
      const compressed = await compressForContext(png, { maxWidth: VLM_IMAGE_MAX_WIDTH, quality: VLM_IMAGE_QUALITY });
      image = { data: compressed.buffer.toString('base64'), mimeType: compressed.mimeType };
    } catch { /* 压缩失败用原图 */ }
    const chatOptions = { images: [image] };
    let locatePrompt;
    if (modelAdapter) {
      // 适配器路径：坐标制式描述出自 adapter.codec（与响应解析同一份 spec，杜绝提示词/解析漂移）
      const coordFormat = modelAdapter.codec.describeForPrompt();
      locatePrompt = `Locate the UI element described as: ${target}. ${instruction || ''} ${coordFormat} If the target is NOT visible on this screen, reply with exactly: NOT_FOUND. Otherwise reply with ONLY the numbers.`;
      // 思考参数：per-family + per-endpoint 翻译（VLM 定位默认关思考，见 reasoning.js DEFAULT_REASONING_CONFIG）
      const reasoningParams = buildReasoningParams(
        modelAdapter.family,
        modelAdapter.reasoning.defaults.enabled,
        modelAdapter.reasoning.defaults.effort,
        endpointType,
        modelConfig.name,
      );
      if (Object.keys(reasoningParams).length > 0) chatOptions.reasoning = reasoningParams;
    } else {
      // 兼容路径：与迁移前 bin/ask.js 完全一致的提示词与请求形态
      const coordFormat = coordStrategy?.describeForPrompt?.() || FALLBACK_COORD_FORMAT;
      locatePrompt = `Locate the UI element described as: ${target}. ${instruction || ''} ${coordFormat} If the target is NOT visible on this screen, reply with exactly: NOT_FOUND. Otherwise reply with ONLY the numbers.`;
    }
    // 必须给"找不到"的出口：否则目标不在屏上时模型会被迫编造坐标点中无关卡片、进入错误页面。
    // locate 走"VLM 返回无法解析"失败路径，安全。
    const rawAnswer = await ctx.chat(locatePrompt, chatOptions);
    return { raw: rawAnswer, family: modelConfig.family };
  };
}