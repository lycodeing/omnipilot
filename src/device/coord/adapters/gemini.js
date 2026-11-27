// gemini 适配器：gemini 视觉系（Google）。
// 差异点：bbox 为 yx 序（y1, x1, y2, x2）、0-1000 归一化——codec 先换轴再换算；
// 思考控制走 extra_body.google.thinking_config（见 reasoning.js translateGemini）。

import { COORDINATE_SPECS } from '../strategy.js';

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const geminiAdapterDefinition = {
  family: 'gemini',
  coordinates: COORDINATE_SPECS.BBOX_YX_1000,
  responseFormat: 'json',
  reasoningDefaults: { enabled: false },
};

export default geminiAdapterDefinition;