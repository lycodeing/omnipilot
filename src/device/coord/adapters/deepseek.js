// deepseek 适配器：deepseek-v4.1-flash 等视觉系。
// 差异点：输出 point（非 bbox）、0-1000 归一化；响应格式暂用 raw-numbers 兼容旧模式
// （后续可升级为 xml-tags，locate-protocol.js 已支持）；content 空时用 reasoning 字段兜底。

import { COORDINATE_SPECS } from '../strategy.js';

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const deepseekAdapterDefinition = {
  family: 'deepseek',
  coordinates: COORDINATE_SPECS.POINT_XY_1000,
  responseFormat: 'raw-numbers',
  reasoningDefaults: { enabled: false, effort: 'none' },
  useReasoningAsContentFallback: true,
};

export default deepseekAdapterDefinition;