// kimi 适配器：kimi/kimi3（Moonshot 视觉系）。
// 差异点：输出 point、0-1 单位归一化（不是 0-1000——误按千分比处理会挤在左上角）；
// 思考控制走 thinking:{type} 方言（见 reasoning.js translateKimi）。

import { COORDINATE_SPECS } from '../strategy.js';

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const kimiAdapterDefinition = {
  family: 'kimi',
  coordinates: COORDINATE_SPECS.POINT_XY_UNIT,
  responseFormat: 'json',
  reasoningDefaults: { enabled: false },
};

export default kimiAdapterDefinition;