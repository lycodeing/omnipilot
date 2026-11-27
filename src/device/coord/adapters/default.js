// 默认适配器：OpenAI 兼容基线（GLM 等未特化 family 的兜底）。
// 坐标制式 bbox xy 0-1000，JSON 响应，思考默认关闭——与 Phase 1 前的既有行为一致。

import { COORDINATE_SPECS } from '../strategy.js';

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const defaultAdapterDefinition = {
  family: 'default',
  coordinates: COORDINATE_SPECS.BBOX_XY_1000,
  responseFormat: 'json',
  reasoningDefaults: { enabled: false, effort: 'none' },
};

export default defaultAdapterDefinition;