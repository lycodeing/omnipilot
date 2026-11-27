// qwen-legacy 适配器：qwen2.5-vl 等非混合思考系。
// 差异点：bbox_2d 输出的是绝对像素坐标（非归一化）、图像需按 28px 块对齐 padding、
// 该代模型不支持 enable_thinking——思考翻译器返回空参数（见 reasoning.js translateQwenLegacy）。

import { COORDINATE_SPECS } from '../strategy.js';

/** @type {import('../adapter-resolver.js').ModelAdapterDefinition} */
const qwenLegacyAdapterDefinition = {
  family: 'qwen-legacy',
  coordinates: COORDINATE_SPECS.BBOX_2D_XY_PIXEL,
  responseFormat: 'json',
  padBlockSize: 28,
};

export default qwenLegacyAdapterDefinition;