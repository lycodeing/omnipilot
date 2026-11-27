// gpt 适配器：gpt-5/gpt-6（OpenAI 视觉系）。
// 差异点：bbox 输出绝对像素坐标、区间为左闭右开（右/下边界不含）；
// gpt-6 不接受 reasoning_effort:'none'，翻译器按模型名钳到 'low'（见 reasoning.js translateGpt）。

import { COORDINATE_SPECS } from '../strategy.js';

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const gptAdapterDefinition = {
  family: 'gpt',
  coordinates: COORDINATE_SPECS.BBOX_XY_PIXEL,
  responseFormat: 'json',
  reasoningDefaults: { enabled: false, effort: 'none' },
};

export default gptAdapterDefinition;