// qwen-vl 适配器：qwen3-vl/qwen3.8 混合思考系。
// 差异点：主键 bbox_2d（别名 bbox）、自定义解析解包单元素数组 [{bbox_2d:...}] → {bbox_2d:...}、
// content 为空时用 reasoning_content/reasoning 字段兜底（DashScope 兼容网关常见行为）。

import { COORDINATE_SPECS } from '../strategy.js';
import { parseLocateResponse } from '../locate-protocol.js';

/**
 * qwen3-vl 响应解析：先解包单元素对象数组，再走统一协议解析。
 * 模型偶尔把结果包成 [{"bbox_2d": [...]}]——直接按键提取会落空，先剥掉这层数组壳。
 * @param {*} raw - 模型原始响应（字符串 / 已解析对象 / 数组）
 * @param {import('../strategy.js').CoordinateSpec} coordinateSpec - 坐标元数据
 * @returns {number[]|null} 坐标数字数组；not-found 或无法解析返回 null
 */
function parseQwenVlResponse(raw, coordinateSpec) {
  let unwrappedResponse = raw;
  if (Array.isArray(unwrappedResponse)
    && unwrappedResponse.length === 1
    && unwrappedResponse[0] != null
    && typeof unwrappedResponse[0] === 'object'
    && !Array.isArray(unwrappedResponse[0])) {
    unwrappedResponse = unwrappedResponse[0];
  }
  return parseLocateResponse(unwrappedResponse, coordinateSpec, 'json');
}

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const qwenVlAdapterDefinition = {
  family: 'qwen-vl',
  coordinates: COORDINATE_SPECS.BBOX_2D_XY_1000,
  responseFormat: 'json',
  parseRawResponse: parseQwenVlResponse,
  reasoningDefaults: { enabled: false },
  useReasoningAsContentFallback: true,
  reasoningContentKeys: ['reasoning_content', 'reasoning'],
};

export default qwenVlAdapterDefinition;