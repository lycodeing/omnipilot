// 声明式适配器 → 运行时解析器（设计文档 §3.3-3.4，借鉴 Midscene resolve 模式）。
// ModelAdapterDefinition 只写与默认不同的槽位；ResolvedModelAdapter 逐项 ?? 填默认实现。
// 目标：新增一个 family ≤ 30 行配置。
//
// 依赖说明：CoordinateCodec / CoordinateSpec 由 strategy.js 提供（Phase 1.1）。
// 若运行环境中 CoordinateCodec 尚未导出（并行开发窗口期），本模块内置同构占位实现兜底，
// 接口约定与 strategy.js 完全一致（spec/describeForPrompt/toPixels），后续无缝对接。

import * as strategyModule from './strategy.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  parseLocateResponse,
} from './locate-protocol.js';
import {
  DEFAULT_REASONING_CONFIG,
  buildReasoningParams,
  detectEndpoint,
} from './reasoning.js';

/**
 * ModelAdapterDefinition 声明式配置（只写差异，坐标元数据必填）。
 * @typedef {Object} ModelAdapterDefinition
 * @property {import('./strategy.js').CoordinateSpec} coordinates - 坐标元数据（必填，单一真源）
 * @property {string} [family] - 模型家族标识（思考参数翻译表查表用，如 'tencent-hy'）
 * @property {string} [systemPromptIntro] - 系统提示词前缀（缺省用通用视觉定位助手文案）
 * @property {'json'|'xml-tags'|'raw-numbers'} [responseFormat='json'] - 响应格式
 * @property {Function} [parseRawResponse] - 自定义响应解析（覆盖默认协议解析）
 * @property {Function} [buildReasoningParams] - 思考参数构建（覆盖默认 per-family 翻译）
 * @property {Object} [reasoningDefaults] - 思考默认配置（覆盖 { enabled:false, effort:'none' }）
 * @property {number} [padBlockSize=0] - 图像 padding 块大小（qwen2.5-vl=28）
 * @property {number} [maxTokensMinimum=4096] - 最低 max_tokens（hy4≥16k）
 * @property {boolean} [useReasoningAsContentFallback=false] - content 空时用 reasoning 字段兜底
 * @property {string[]} [reasoningContentKeys] - reasoning 字段名兼容列表
 * @property {Function} [buildChatParams] - 自定义请求参数（覆盖默认空实现）
 * @property {string[]} [supportedEndpoints] - 支持的端点类型（声明性元数据）
 */

/**
 * 默认 reasoning 字段名兼容列表（各网关对思考文本的命名不一致）。
 * @type {string[]}
 */
const DEFAULT_REASONING_CONTENT_KEYS = ['reasoning_content', 'reasoning', 'thinking'];

/**
 * CoordinateCodec 占位实现：仅在 strategy.js 尚未导出 CoordinateCodec 时启用。
 * 接口与 Phase 1.1 的正式实现约定一致：spec 属性 + describeForPrompt() + toPixels(coords, size)。
 * 正式实现就位后自动让位（resolveCodecClass 优先取 strategy.js 导出）。
 */
class FallbackCoordinateCodec {
  /**
   * @param {import('./strategy.js').CoordinateSpec} spec - 坐标元数据
   */
  constructor(spec) {
    this.spec = { ...spec };
    this.shape = spec.shape ?? 'bbox';
    this.order = spec.order ?? 'xy';
    this.normalizedBy = spec.normalizedBy ?? null;
    this.normalizationBasis = spec.normalizationBasis ?? 'image-size';
    this.rounding = spec.rounding ?? 'round';
    this.boundsType = spec.boundsType ?? 'closed';
    this.resultKey = spec.resultKey ?? 'bbox';
    this.resultKeyAliases = spec.resultKeyAliases ?? [];
  }

  /**
   * 生成提示词中的坐标制式描述（与解析共用同一份 spec）。
   * @returns {string} 坐标制式英文描述
   */
  describeForPrompt() {
    const shapeDescription = this.shape === 'bbox'
      ? `a bounding box [${this.order === 'yx' ? 'y1, x1, y2, x2' : 'x1, y1, x2, y2'}]`
      : `a point [${this.order === 'yx' ? 'y, x' : 'x, y'}]`;
    const scaleDescription = this.normalizedBy != null
      ? `normalized to 0-${this.normalizedBy} relative to the screenshot. Do NOT use pixel coordinates.`
      : 'in actual pixel coordinates relative to the screenshot. Do NOT normalize.';
    const orderNote = this.order === 'yx' ? ' Note: y comes first.' : '';
    return `Return the target as ${shapeDescription} ${scaleDescription}${orderNote}`;
  }

  /**
   * 坐标数字数组 → 设备像素（归一化换算 + yx 换轴 + 取整 + 越界判定）。
   * @param {number[]} coords - 原始值域坐标数组
   * @param {{w: number, h: number}} size - 屏幕/图像尺寸
   * @returns {{bounds: number[]|null, center: number[]|null, inScreen: boolean}} 像素结果
   */
  toPixels(coords, size) {
    if (!Array.isArray(coords) || coords.length < 2) return { bounds: null, center: null, inScreen: false };
    const basisWidth = this.normalizationBasis === 'last-pixel' ? size.w - 1 : size.w;
    const basisHeight = this.normalizationBasis === 'last-pixel' ? size.h - 1 : size.h;
    const scaleX = this.normalizedBy != null ? basisWidth / this.normalizedBy : 1;
    const scaleY = this.normalizedBy != null ? basisHeight / this.normalizedBy : 1;
    let pixelCoords;
    if (this.order === 'yx') {
      pixelCoords = coords.length >= 4
        ? [coords[1] * scaleX, coords[0] * scaleY, coords[3] * scaleX, coords[2] * scaleY]
        : [coords[1] * scaleX, coords[0] * scaleY];
    } else {
      pixelCoords = coords.map((value, index) => value * (index % 2 === 0 ? scaleX : scaleY));
    }
    const roundFunction = this.rounding === 'trunc' ? Math.trunc : this.rounding === 'none' ? (value) => value : Math.round;
    pixelCoords = pixelCoords.map(roundFunction);
    if (pixelCoords.length >= 4 && this.shape === 'bbox') {
      const [left, top, right, bottom] = pixelCoords;
      const normalizedLeft = Math.min(left, right);
      const normalizedTop = Math.min(top, bottom);
      const normalizedRight = Math.max(left, right);
      const normalizedBottom = Math.max(top, bottom);
      const inScreen = normalizedLeft >= -1 && normalizedTop >= -1
        && normalizedRight <= size.w + 1 && normalizedBottom <= size.h + 1;
      return {
        bounds: [Math.round(normalizedLeft), Math.round(normalizedTop), Math.round(normalizedRight), Math.round(normalizedBottom)],
        center: [Math.floor((normalizedLeft + normalizedRight) / 2), Math.floor((normalizedTop + normalizedBottom) / 2)],
        inScreen,
      };
    }
    const [pointX, pointY] = pixelCoords;
    const inScreen = pointX >= -1 && pointY >= -1 && pointX <= size.w + 1 && pointY <= size.h + 1;
    return { bounds: null, center: [Math.round(pointX), Math.round(pointY)], inScreen };
  }
}

/**
 * 选定 CoordinateCodec 实现：优先 strategy.js 正式导出，缺席时用占位实现。
 * @returns {typeof FallbackCoordinateCodec} Codec 构造器
 */
function resolveCodecClass() {
  return typeof strategyModule.CoordinateCodec === 'function'
    ? strategyModule.CoordinateCodec
    : FallbackCoordinateCodec;
}

/**
 * 默认请求参数构建：无额外参数（OpenAI 兼容基线）。
 * @returns {Object} 空参数对象
 */
function defaultBuildChatParams() {
  return {};
}

/**
 * 解析协议槽位：把声明式定义收敛为提示词组装 + 响应解析所需的运行时对象。
 * @param {ModelAdapterDefinition} definition - 声明式适配器配置
 * @returns {{systemPromptIntro: string|undefined, coordinateSpec: import('./strategy.js').CoordinateSpec, responseFormat: string, buildSystemPrompt: Function, buildUserPrompt: Function, parseRawResponse: Function}} 协议运行时对象
 */
function resolveProtocol(definition) {
  const responseFormat = definition.responseFormat ?? 'json';
  const coordinateSpec = definition.coordinates;
  const customParser = definition.parseRawResponse;
  return {
    systemPromptIntro: definition.systemPromptIntro,
    coordinateSpec,
    responseFormat,
    /**
     * 组装完整系统提示词（三段式）。
     * @returns {string} 系统提示词
     */
    buildSystemPrompt() {
      return buildSystemPrompt({ systemPromptIntro: definition.systemPromptIntro, coordinateSpec, responseFormat });
    },
    /**
     * 组装用户提示词。
     * @param {string} target - 目标描述
     * @returns {string} 用户提示词
     */
    buildUserPrompt(target) {
      return buildUserPrompt(target);
    },
    /**
     * 解析响应为坐标数组（自定义 parser 优先，缺省走统一协议解析）。
     * @param {*} raw - 模型原始响应
     * @returns {number[]|null} 坐标数组或 null（not-found/无法解析）
     */
    parseRawResponse(raw) {
      if (typeof customParser === 'function') return customParser(raw, coordinateSpec);
      return parseLocateResponse(raw, coordinateSpec, responseFormat);
    },
  };
}

/**
 * 解析思考控制槽位：合并默认配置，绑定 family 翻译表（自定义构建函数优先）。
 * @param {ModelAdapterDefinition} definition - 声明式适配器配置
 * @returns {{defaults: Object, buildParams: Function}} 思考控制运行时对象
 */
function resolveReasoning(definition) {
  const defaults = { ...DEFAULT_REASONING_CONFIG, ...(definition.reasoningDefaults ?? {}) };
  const customBuilder = definition.buildReasoningParams;
  return {
    defaults,
    /**
     * 构建思考参数（三态：true/false/'default'）。
     * @param {'anthropic'|'openrouter'|'openai'} endpoint - 端点类型
     * @param {{enabled?: boolean|'default', effort?: string, modelName?: string}} [overrides] - 调用级覆盖
     * @returns {Object} 请求体附加的思考参数
     */
    buildParams(endpoint, overrides = {}) {
      const enabled = overrides.enabled ?? defaults.enabled;
      const effort = overrides.effort ?? defaults.effort;
      if (typeof customBuilder === 'function') return customBuilder(enabled, effort, endpoint, overrides.modelName);
      return buildReasoningParams(definition.family ?? 'default', enabled, effort, endpoint, overrides.modelName);
    },
  };
}

/**
 * ResolvedModelAdapter：声明式配置的运行时形态。
 * 每个槽位要么来自定义、要么是默认实现——调用方无需判空。
 */
export class ResolvedModelAdapter {
  /**
   * @param {ModelAdapterDefinition} definition - 声明式适配器配置（coordinates 必填）
   * @throws {TypeError} coordinates 缺失或非对象时抛出（坐标元数据是单一真源，不允许缺省猜测）
   */
  constructor(definition) {
    if (!definition || typeof definition.coordinates !== 'object' || definition.coordinates === null) {
      throw new TypeError('ModelAdapterDefinition.coordinates 必填：坐标元数据是提示词/解析/换算的单一真源');
    }
    const CodecClass = resolveCodecClass();
    /** @type {import('./strategy.js').CoordinateCodec} 坐标编解码器（spec 驱动） */
    this.codec = new CodecClass(definition.coordinates);
    /** @type {Object} 协议运行时对象（提示词组装 + 响应解析） */
    this.protocol = resolveProtocol(definition);
    /** @type {Object} 思考控制运行时对象（defaults + buildParams） */
    this.reasoning = resolveReasoning(definition);
    /** @type {Function} 请求参数构建（默认空实现） */
    this.chatParams = definition.buildChatParams ?? defaultBuildChatParams;
    /** @type {number} 图像 padding 块大小（qwen2.5-vl=28，0=不 pad） */
    this.padBlockSize = definition.padBlockSize ?? 0;
    /** @type {number} 最低 max_tokens（hy4≥16384） */
    this.maxTokensMinimum = definition.maxTokensMinimum ?? 4096;
    /** @type {boolean} content 空时是否用 reasoning 字段兜底 */
    this.useReasoningAsContentFallback = definition.useReasoningAsContentFallback ?? false;
    /** @type {string[]} reasoning 字段名兼容列表 */
    this.reasoningContentKeys = definition.reasoningContentKeys ?? [...DEFAULT_REASONING_CONTENT_KEYS];
    /** @type {string[]|null} 支持的端点类型（声明性元数据，null=不限） */
    this.supportedEndpoints = definition.supportedEndpoints ?? null;
    /** @type {string} 家族标识 */
    this.family = definition.family ?? 'default';
  }

  /**
   * 构建完整的 VLM 定位请求素材（提示词 + 思考参数 + 图像负载）。
   * 图像压缩由调用方完成（compressForContext 在 CLI/会话层），本方法接收已备好的图像；
   * png 传入时按原图 base64 直载（小图或调用方已压缩的场景）。
   * @param {Object} options - 请求素材选项
   * @param {string} options.target - 目标元素描述
   * @param {Buffer} [options.png] - 截图 PNG Buffer（与 image 二选一）
   * @param {{data: string, mimeType: string}} [options.image] - 已编码图像负载（优先于 png）
   * @param {{w: number, h: number}} [options.size] - 设备屏幕尺寸（供后续像素换算）
   * @param {string} [options.baseUrl] - 模型服务 baseUrl（端点探测用）
   * @param {'anthropic'|'openrouter'|'openai'} [options.endpoint] - 显式端点类型（优先于 baseUrl 探测）
   * @param {{enabled?: boolean|'default', effort?: string, modelName?: string}} [options.reasoning] - 思考控制覆盖
   * @returns {{systemPrompt: string, userPrompt: string, reasoningParams: Object, imagePayload: {data: string, mimeType: string}|null, maxTokensMinimum: number, padBlockSize: number}} 请求素材
   */
  buildLocateRequest({ target, png, image, size, baseUrl, endpoint, reasoning } = {}) {
    const resolvedEndpoint = endpoint ?? detectEndpoint(baseUrl);
    const systemPrompt = this.protocol.buildSystemPrompt();
    const userPrompt = this.protocol.buildUserPrompt(target);
    const reasoningParams = this.reasoning.buildParams(resolvedEndpoint, reasoning ?? {});
    let imagePayload = image ?? null;
    if (!imagePayload && Buffer.isBuffer(png)) {
      imagePayload = { data: png.toString('base64'), mimeType: 'image/png' };
    }
    return {
      systemPrompt,
      userPrompt,
      reasoningParams,
      imagePayload,
      size: size ?? null,
      maxTokensMinimum: this.maxTokensMinimum,
      padBlockSize: this.padBlockSize,
    };
  }

  /**
   * 解析 VLM 响应为像素坐标。
   * @param {*} raw - 模型原始响应
   * @param {{w: number, h: number}} preparedSize - 实际送入模型的图像尺寸（压缩后）
   * @param {{w: number, h: number}} [contentSize] - 设备屏幕尺寸（缺省与 preparedSize 相同；不同时按比例回放大）
   * @returns {{found: boolean, bounds?: number[]|null, center?: number[]|null, inScreen?: boolean}} found=false 表示 not-found 或无法解析
   */
  parseLocateResponse(raw, preparedSize, contentSize) {
    const parsedCoordinates = this.protocol.parseRawResponse(raw);
    if (!parsedCoordinates || parsedCoordinates.length < 2) return { found: false };
    const targetSize = contentSize ?? preparedSize;
    // 压缩图与设备尺寸不一致时：先在压缩图值域换算像素，再按比例映射回设备坐标系
    // （修复"AbsolutePixel × 图片压缩语义错位"——720px 压缩图的绝对像素 ≠ 设备像素）。
    const needsRescale = targetSize.w !== preparedSize.w || targetSize.h !== preparedSize.h;
    if (!needsRescale) {
      return { found: true, ...this.codec.toPixels(parsedCoordinates, preparedSize) };
    }
    const preparedResult = this.codec.toPixels(parsedCoordinates, preparedSize);
    const rescaleX = targetSize.w / preparedSize.w;
    const rescaleY = targetSize.h / preparedSize.h;
    const rescaledBounds = preparedResult.bounds
      ? [
        Math.round(preparedResult.bounds[0] * rescaleX),
        Math.round(preparedResult.bounds[1] * rescaleY),
        Math.round(preparedResult.bounds[2] * rescaleX),
        Math.round(preparedResult.bounds[3] * rescaleY),
      ]
      : null;
    const rescaledCenter = preparedResult.center
      ? [Math.round(preparedResult.center[0] * rescaleX), Math.round(preparedResult.center[1] * rescaleY)]
      : null;
    const inScreen = rescaledCenter != null
      && rescaledCenter[0] >= -1 && rescaledCenter[1] >= -1
      && rescaledCenter[0] <= targetSize.w + 1 && rescaledCenter[1] <= targetSize.h + 1;
    return { found: true, bounds: rescaledBounds, center: rescaledCenter, inScreen };
  }

  /**
   * content 为空时从消息对象中提取 reasoning 文本兜底（部分网关把答案放思考字段）。
   * 仅当 useReasoningAsContentFallback=true 时生效。
   * @param {Object} message - chat 响应的 message 对象
   * @returns {string|null} 兜底文本；未启用或无可用字段返回 null
   */
  extractReasoningFallback(message) {
    if (!this.useReasoningAsContentFallback || !message || typeof message !== 'object') return null;
    for (const key of this.reasoningContentKeys) {
      const value = message[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return null;
  }
}

/**
 * 声明式适配器 → 运行时解析器的便捷入口。
 * @param {ModelAdapterDefinition} definition - 声明式适配器配置
 * @returns {ResolvedModelAdapter} 运行时适配器
 */
export function resolveAdapter(definition) {
  return new ResolvedModelAdapter(definition);
}