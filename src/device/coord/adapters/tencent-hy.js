// tencent-hy 适配器：hy4/hy4-flash（腾讯混元视觉系）。
// 差异点：主键 box_2d、最低 max_tokens 16384（评估报告要求）、
// content 为空时用 reasoning 字段兜底（部分网关把答案放思考文本里）。

import { COORDINATE_SPECS } from '../strategy.js';

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const tencentHyAdapterDefinition = {
  family: 'tencent-hy',
  coordinates: COORDINATE_SPECS.BOX_2D_XY_1000,
  responseFormat: 'json',
  maxTokensMinimum: 16384,
  reasoningDefaults: { enabled: false, effort: 'none' },
  useReasoningAsContentFallback: true,
};

export default tencentHyAdapterDefinition;