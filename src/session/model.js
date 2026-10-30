// 模型解析（§2.2 / §5.5.4）：ASK_MODEL_URL / ASK_MODEL_KEY / ASK_MODEL_NAME / ASK_MODEL_FAMILY
// 为主路径，--model-* CLI 参数可覆盖。用 ModelRuntime + registerProvider 派生 Model。
// baseUrlHash = sha1(url).slice(0, 8)（不落密钥明文 §14.1）。

import crypto from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export class ModelConfigError extends Error {}

export function resolveModelConfig(cliOverrides = {}, env = process.env) {
  // parseArgv 保留连字符（flags['model-url']），usage 文本也用连字符形态——两种键名都要认
  const pick = (camel, kebab) => cliOverrides[camel] ?? cliOverrides[kebab];
  const cfg = {
    url: pick('modelUrl', 'model-url') || env.ASK_MODEL_URL || '',
    key: pick('modelKey', 'model-key') || env.ASK_MODEL_KEY || '',
    name: pick('modelName', 'model-name') || env.ASK_MODEL_NAME || '',
    family: pick('modelFamily', 'model-family') || env.ASK_MODEL_FAMILY || '',
  };
  return cfg;
}

export function validateModelConfig(cfg) {
  const missing = ['url', 'key', 'name', 'family'].filter((k) => !cfg[k]);
  if (missing.length) {
    throw new ModelConfigError(
      `模型配置缺失：${missing.map((k) => 'ASK_MODEL_' + k.toUpperCase()).join(' / ')}（或用 --model-* 覆盖）`,
    );
  }
}

export function baseUrlHash(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
}

// 思考控制定档（2026-10-28 调研，详见 docs/THINKING-CONTROL.md）：
//   - 能否关闭思考因模型而异：DeepSeek(ds)/Qwen(qwen)/MiniMax 支持关闭（reasoning_effort=none
//     或 thinking:{type:"disabled"} / enable_thinking:false）；**智谱 GLM-5.3 系不支持关闭**
//     （官方原文「GLM-5.3 会始终启用思考功能…并不再支持禁用思考功能」，仅接受 low/high/max，
//     且从 disabled 迁移时"请求将失败"）。
//   - 故对不能关闭的模型，最低档降到 'low'（官方允许的最低有效档），而不是 none。
// 返回符合该模型能力的 thinkingLevelMap（Pi 的 thinkingLevel → 网关思考控制值）。
export function buildThinkingLevelMap(name = '') {
  // GLM-5.3 / 5.3-Flash / 5.3-FlashX：思考不可关闭，最低只到 low
  const glm53 = /^glm-5\.3(-flash|-flashx)?$/i.test(String(name).trim());
  const minEffort = glm53 ? 'low' : 'none';
  // 中/高档一律置 null（不允许出现、会被钳制），保证 agent 循环不会自发长思考（省时间与 token）
  return {
    off: minEffort,
    minimal: minEffort,
    low: minEffort,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
}

// 返回 { model, modelRuntime, info: { family, name, baseUrlHash } }
export async function createModel(cfg = resolveModelConfig(), { modelRuntime } = {}) {
  validateModelConfig(cfg);
  const runtime = modelRuntime || (await ModelRuntime.create());
  runtime.registerProvider(cfg.family, {
    name: cfg.family,
    baseUrl: cfg.url,
    apiKey: cfg.key,
    api: 'openai-completions',
    models: [
      {
        id: cfg.name,
        name: cfg.name,
        // reasoning:true 是**必需**的：SDK 的 openai-completions provider 在**每个**思考控制分支
        // （reasoning_effort / thinking / enable_thinking / chat_template_kwargs）上都带 `&& model.reasoning` 守卫，
        // 且 getSupportedThinkingLevels 在 reasoning:false 时只返回 ['off']。
        // 若置 false，思考控制参数根本不会发往网关（实测 5 个模型 outbound 全为 undefined），
        // 网关于是回退到**自身默认**（如 glm 默认长思考，实测单轮 16s、94% 时间耗在自发 reasoning）。
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
        // 思考级别映射：会话默认 thinkingLevel='off'（src/session/create.js）。
        // 能关思考的模型 → 'none'（关）；不能关的（GLM-5.3 系）→ 'low'（最低有效档）。
        thinkingLevelMap: buildThinkingLevelMap(cfg.name),
      },
    ],
  });
  const model = runtime.getModel(cfg.family, cfg.name);
  if (!model) throw new ModelConfigError(`注册后仍找不到模型 ${cfg.family}/${cfg.name}`);
  return { model, modelRuntime: runtime, info: { family: cfg.family, name: cfg.name, baseUrlHash: baseUrlHash(cfg.url) } };
}
