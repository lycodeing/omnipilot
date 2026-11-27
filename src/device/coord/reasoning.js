// 思考控制参数构建（设计文档 §3.5）：per-family + per-endpoint 翻译。
// 统一输入三态：enabled = true（显式开）| false（显式关）| 'default'（不传参数，用服务端默认）。
// VLM 定位默认关思考（评估结论：hy4-flash 关思考中位误差 1.6px、速度最优）。
// 端点差异依据：docs/THINKING-CONTROL.md 网关实测 + hy4/hy4-flash 视觉定位评估报告。

/**
 * VLM 定位路径的思考默认配置：默认关闭思考。
 * 评估数据显示关思考的定位精度与速度均优于开思考（长思考反而引入坐标漂移）。
 * @type {{enabled: boolean, effort: string}}
 */
export const DEFAULT_REASONING_CONFIG = { enabled: false, effort: 'none' };

/**
 * 按 baseUrl 探测端点类型（同一 family 在不同网关上的参数方言不同）。
 * - 腾讯官方 tokenhub（tokenhub.tencentmaas.com）走 Anthropic 风格：thinking:{type}
 * - OpenRouter 聚合网关走 OpenAI 风格，但部分参数需嵌套进 reasoning 对象
 * - 其余（u2a 等 OpenAI 兼容代理）一律按 openai 处理
 * @param {string} baseUrl - 模型服务 baseUrl
 * @returns {'anthropic'|'openrouter'|'openai'} 端点类型
 */
export function detectEndpoint(baseUrl) {
  const normalizedUrl = String(baseUrl ?? '').toLowerCase();
  if (/tokenhub\.tencentmaas/.test(normalizedUrl)) return 'anthropic';
  if (/openrouter/.test(normalizedUrl)) return 'openrouter';
  return 'openai';
}

/**
 * 思考力度档位 → token 预算映射（qwen 系 thinking_budget 用）。
 * 数值为工程约定档位（非官方精确值），仅用于开启思考时限制预算上限。
 * @param {'none'|'low'|'medium'|'high'} effort - 思考力度
 * @returns {number|undefined} token 预算；none/未知档位返回 undefined（不传预算）
 */
function mapEffortToBudget(effort) {
  const budgetByEffort = { low: 1024, medium: 4096, high: 16384 };
  return budgetByEffort[effort];
}

/**
 * 归一化思考力度：非法/缺省值回落到 fallback。
 * @param {string|undefined|null} effort - 调用方传入的力度
 * @param {string} fallback - 回落档位
 * @returns {string} 合法档位（none/low/medium/high）
 */
function normalizeEffort(effort, fallback) {
  const validEfforts = ['none', 'low', 'medium', 'high'];
  return validEfforts.includes(effort) ? effort : fallback;
}

/**
 * tencent-hy（hy4/hy4-flash）翻译器：端点方言差异最大的家族。
 * - anthropic（腾讯官方 tokenhub）：thinking:{type:'enabled'|'disabled'}，开启时附 budget_tokens
 * - openai/openrouter（u2a 等代理）：reasoning_effort:'none' 关闭 / 档位开启
 * @param {boolean} enabled - 是否开启思考（'default' 已在上游拦截，不会进入翻译器）
 * @param {string} effort - 思考力度
 * @param {'anthropic'|'openrouter'|'openai'} endpoint - 端点类型
 * @returns {Object} 请求体附加参数
 */
function translateTencentHy(enabled, effort, endpoint) {
  if (endpoint === 'anthropic') {
    if (!enabled) return { thinking: { type: 'disabled' } };
    return { thinking: { type: 'enabled', budget_tokens: mapEffortToBudget(normalizeEffort(effort, 'medium')) ?? 4096 } };
  }
  return { reasoning_effort: enabled ? normalizeEffort(effort, 'medium') : 'none' };
}

/**
 * qwen-vl（qwen3-vl/qwen3.8 混合思考系）翻译器：enable_thinking 布尔开关。
 * 开启且给出有效力度时附 thinking_budget 限制预算。
 * 注意：DashScope 原生协议要求 enable_thinking 放 extra_body；OpenAI 兼容网关直收顶层字段，
 * 本项目走 OpenAI 兼容路径故置顶层（如后续接原生端点，由适配器 buildChatParams 覆写搬运）。
 * @param {boolean} enabled - 是否开启思考
 * @param {string} effort - 思考力度
 * @returns {Object} 请求体附加参数
 */
function translateQwenVl(enabled, effort) {
  const params = { enable_thinking: Boolean(enabled) };
  const budget = enabled ? mapEffortToBudget(effort) : undefined;
  if (budget !== undefined) params.thinking_budget = budget;
  return params;
}

/**
 * qwen-legacy（qwen2.5-vl 等非混合思考系）翻译器：无思考开关可发。
 * 该代模型不支持 enable_thinking（发了会被网关忽略或报错），一律不传参数。
 * @returns {Object} 空参数对象
 */
function translateQwenLegacy() {
  return {};
}

/**
 * deepseek 翻译器：reasoning_effort:'none' 即关闭（官方 "none disables thinking mode"）。
 * anthropic 风格端点用 thinking:{type}（与 tencent-hy 同款 Anthropic 方言）。
 * @param {boolean} enabled - 是否开启思考
 * @param {string} effort - 思考力度
 * @param {'anthropic'|'openrouter'|'openai'} endpoint - 端点类型
 * @returns {Object} 请求体附加参数
 */
function translateDeepseek(enabled, effort, endpoint) {
  if (endpoint === 'anthropic') {
    return { thinking: { type: enabled ? 'enabled' : 'disabled' } };
  }
  return { reasoning_effort: enabled ? normalizeEffort(effort, 'medium') : 'none' };
}

/**
 * kimi（kimi/kimi3）翻译器：thinking:{type:'enabled'|'disabled'}（Moonshot 官方方言）。
 * OpenAI 兼容代理同样透传 thinking 对象（网关实测接受）。
 * @param {boolean} enabled - 是否开启思考
 * @returns {Object} 请求体附加参数
 */
function translateKimi(enabled) {
  return { thinking: { type: enabled ? 'enabled' : 'disabled' } };
}

/**
 * gemini 翻译器：extra_body.google.thinking_config（OpenAI 兼容层转发 Google 原生字段）。
 * 关闭用 thinking_budget:0；开启按力度映射预算，include_thoughts 保持 false（定位不需要思考文本）。
 * @param {boolean} enabled - 是否开启思考
 * @param {string} effort - 思考力度
 * @returns {Object} 请求体附加参数
 */
function translateGemini(enabled, effort) {
  const thinkingConfig = enabled
    ? { thinking_budget: mapEffortToBudget(normalizeEffort(effort, 'medium')) ?? 4096, include_thoughts: false }
    : { thinking_budget: 0, include_thoughts: false };
  return { extra_body: { google: { thinking_config: thinkingConfig } } };
}

/**
 * gpt（gpt-5/gpt-6）翻译器：reasoning_effort 档位。
 * gpt-6 不接受 'none'（推断，未验证——按任务约定以 'low' 兜底），
 * 通过 modelName 判定：名字含 gpt-6 时最低档钳到 'low'。
 * @param {boolean} enabled - 是否开启思考
 * @param {string} effort - 思考力度
 * @param {'anthropic'|'openrouter'|'openai'} endpoint - 端点类型（gpt 各方言一致，保留签名对齐）
 * @param {string} [modelName] - 模型名（用于 gpt-6 特判）
 * @returns {Object} 请求体附加参数
 */
function translateGpt(enabled, effort, endpoint, modelName) {
  const isGpt6 = /gpt-6/i.test(String(modelName ?? ''));
  if (!enabled) return { reasoning_effort: isGpt6 ? 'low' : 'none' };
  const resolvedEffort = normalizeEffort(effort, 'medium');
  // 开启但传了 none：语义矛盾，回落到最低有效档 low
  if (resolvedEffort === 'none') return { reasoning_effort: 'low' };
  return { reasoning_effort: resolvedEffort };
}

/**
 * doubao（doubao/seed 系）翻译器：thinking:{type:'enabled'|'disabled'}（火山方舟方言）。
 * @param {boolean} enabled - 是否开启思考
 * @returns {Object} 请求体附加参数
 */
function translateDoubao(enabled) {
  return { thinking: { type: enabled ? 'enabled' : 'disabled' } };
}

/**
 * minimax（M 系列）翻译器：reasoning_effort:'none'（网关实测关闭态 reasoning_tokens 归零，
 * 见 docs/THINKING-CONTROL.md §三）。
 * @param {boolean} enabled - 是否开启思考
 * @param {string} effort - 思考力度
 * @returns {Object} 请求体附加参数
 */
function translateMinimax(enabled, effort) {
  return { reasoning_effort: enabled ? normalizeEffort(effort, 'medium') : 'none' };
}

/**
 * default 兜底翻译器：OpenAI 兼容通用方言 reasoning_effort。
 * 未登记的 family 一律走此路径（宽松代理对未知参数不报错，none 是最保守的关闭尝试）。
 * @param {boolean} enabled - 是否开启思考
 * @param {string} effort - 思考力度
 * @returns {Object} 请求体附加参数
 */
function translateDefault(enabled, effort) {
  return { reasoning_effort: enabled ? normalizeEffort(effort, 'medium') : 'none' };
}

/**
 * per-family 思考参数翻译函数表（单一真源，新增 family 加一行）。
 * 每个翻译器签名：(enabled: boolean, effort: string, endpoint: string, modelName?: string) => Object。
 * 'default' 三态在 buildReasoningParams 上游拦截，翻译器只处理 true/false。
 * @type {Object<string, Function>}
 */
export const REASONING_TRANSLATORS = {
  'tencent-hy': translateTencentHy,
  'qwen-vl': translateQwenVl,
  'qwen-legacy': translateQwenLegacy,
  deepseek: translateDeepseek,
  kimi: translateKimi,
  gemini: translateGemini,
  gpt: translateGpt,
  doubao: translateDoubao,
  minimax: translateMinimax,
  default: translateDefault,
};

/**
 * 构建思考控制请求参数（统一入口）。
 * 三态语义：enabled='default' → 返回 {}（不传参数，用服务端默认）；
 * true/false → 查 family 翻译表按端点方言翻译；未登记 family 走 default 翻译器。
 * @param {string} family - 模型家族（tencent-hy/qwen-vl/deepseek/...）
 * @param {boolean|'default'} enabled - 思考开关三态
 * @param {'none'|'low'|'medium'|'high'} [effort='none'] - 思考力度
 * @param {'anthropic'|'openrouter'|'openai'} [endpoint='openai'] - 端点类型
 * @param {string} [modelName] - 模型名（gpt-6 等型号特判用）
 * @returns {Object} 合并进请求体的思考参数（可能为空对象）
 */
export function buildReasoningParams(family, enabled, effort = 'none', endpoint = 'openai', modelName = '') {
  // 'default' 三态：显式不传参数，让服务端用自身默认
  if (enabled === 'default') return {};
  const normalizedFamily = String(family ?? '').toLowerCase().trim();
  const translator = REASONING_TRANSLATORS[normalizedFamily] ?? REASONING_TRANSLATORS.default;
  return translator(Boolean(enabled), effort, endpoint, modelName);
}