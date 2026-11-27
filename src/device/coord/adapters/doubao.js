// doubao 适配器：doubao/seed 视觉系（火山方舟）。
// 坐标制式与默认基线一致（bbox xy 0-1000）；
// 差异点：content 为空时用 reasoning 字段兜底、思考控制走 thinking:{type} 方言。

import { COORDINATE_SPECS } from '../strategy.js';

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const doubaoAdapterDefinition = {
  family: 'doubao',
  coordinates: COORDINATE_SPECS.BBOX_XY_1000,
  responseFormat: 'json',
  reasoningDefaults: { enabled: false },
  useReasoningAsContentFallback: true,
};

export default doubaoAdapterDefinition;