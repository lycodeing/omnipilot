// minimax 适配器：minimax M 系列视觉模型。
// 坐标制式与默认基线一致（bbox xy 0-1000）；
// 思考控制走 reasoning_effort:'none'（网关实测关闭态 reasoning_tokens 归零）。

import { COORDINATE_SPECS } from '../strategy.js';

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const minimaxAdapterDefinition = {
  family: 'minimax',
  coordinates: COORDINATE_SPECS.BBOX_XY_1000,
  responseFormat: 'json',
  reasoningDefaults: { enabled: false, effort: 'none' },
};

export default minimaxAdapterDefinition;