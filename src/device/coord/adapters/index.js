// 声明式适配器汇总：family → ModelAdapterDefinition（供 registry / resolveAdapter 消费）。
// 新增 family 时：新建 adapters/<family>.js + 此处登记一行。

import defaultAdapterDefinition from './default.js';
import tencentHyAdapterDefinition from './tencent-hy.js';
import qwenVlAdapterDefinition from './qwen-vl.js';
import qwenLegacyAdapterDefinition from './qwen-legacy.js';
import deepseekAdapterDefinition from './deepseek.js';
import kimiAdapterDefinition from './kimi.js';
import geminiAdapterDefinition from './gemini.js';
import gptAdapterDefinition from './gpt.js';
import doubaoAdapterDefinition from './doubao.js';
import minimaxAdapterDefinition from './minimax.js';

/**
 * family → 声明式适配器定义映射（键与 reasoning.js REASONING_TRANSLATORS 的 family 对齐）。
 * @type {Object<string, import('../adapter-resolver.js').ModelAdapterDefinition>}
 */
export const ADAPTER_DEFINITIONS = {
  default: defaultAdapterDefinition,
  'tencent-hy': tencentHyAdapterDefinition,
  'qwen-vl': qwenVlAdapterDefinition,
  'qwen-legacy': qwenLegacyAdapterDefinition,
  deepseek: deepseekAdapterDefinition,
  kimi: kimiAdapterDefinition,
  gemini: geminiAdapterDefinition,
  gpt: gptAdapterDefinition,
  doubao: doubaoAdapterDefinition,
  minimax: minimaxAdapterDefinition,
};