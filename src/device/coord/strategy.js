// VLM 坐标换算策略（§5.5.2）：shape(bbox/point) × order(xy/yx) × normalizedBy(1000/1/无)
// 配置值来自 Midscene v1.17.0 源码提取（§5.5.1 表格）
//
// 架构升级（2026-11-27）：新增 CoordinateSpec + CoordinateCodec 作为统一基础，
// 一份坐标元数据同时驱动提示词、解析、换算，杜绝"提示词说 0-1000、解析按像素"的漂移。
// 原有 4 个策略类保留向后兼容，内部委托给 CoordinateCodec。

// ─── 通用输入清洗 ──────────────────────────────────────────────────────────
/**
 * 从模型原始响应中提取数字数组。
 * 支持数组、对象（{x1,y1,x2,y2} / {x,y}）、字符串（正则抓数字）。
 * @param {*} raw - 模型原始返回值
 * @returns {number[]} 有限数字数组
 */
export function toNumbers(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.flat(Infinity).map(Number).filter(Number.isFinite);
  if (typeof raw === 'object') {
    const obj = raw;
    if (['x1', 'y1', 'x2', 'y2'].every((key) => key in obj)) return [obj.x1, obj.y1, obj.x2, obj.y2].map(Number);
    if ('x' in obj && 'y' in obj) return [obj.x, obj.y].map(Number);
    return toNumbers(Object.values(obj));
  }
  if (typeof raw === 'string') {
    const matches = raw.match(/-?\d+(?:\.\d+)?/g);
    return matches ? matches.map(Number) : [];
  }
  return [];
}

/** 判断点是否在 bounds 内 */
export function pointInBounds([x, y], [left, top, right, bottom]) {
  return x >= left && x <= right && y >= top && y <= bottom;
}

// ─── CoordinateSpec：坐标元数据单一真源 ─────────────────────────────────────
/**
 * @typedef {Object} CoordinateSpec
 * @property {'bbox'|'point'} shape - 输出形状
 * @property {'xy'|'yx'} order - 坐标轴顺序
 * @property {number|null} normalizedBy - null=像素, 1000=千分比, 1=单位比
 * @property {'image-size'|'last-pixel'} [normalizationBasis='image-size'] - 归一化基准
 * @property {'round'|'trunc'|'none'} [rounding='round'] - 取整方式
 * @property {'closed'|'left-closed-right-open'} [boundsType='closed'] - 区间类型
 * @property {string} [resultKey='bbox'] - JSON 响应中的主键名（进提示词）
 * @property {string[]} [resultKeyAliases=[]] - 别名（仅解析容错，不进提示词）
 */

/** 预定义坐标规格常量 */
export const COORDINATE_SPECS = {
  /** GLM/Qwen/DeepSeek/Doubao/hy4: bbox xy 0-1000 */
  BBOX_XY_1000: { shape: 'bbox', order: 'xy', normalizedBy: 1000, resultKey: 'bbox' },
  /** tencent-hy: box_2d xy 0-1000 */
  BOX_2D_XY_1000: { shape: 'bbox', order: 'xy', normalizedBy: 1000, resultKey: 'box_2d' },
  /** qwen3-vl: bbox_2d xy 0-1000 */
  BBOX_2D_XY_1000: { shape: 'bbox', order: 'xy', normalizedBy: 1000, resultKey: 'bbox_2d', resultKeyAliases: ['bbox'] },
  /** Gemini: bbox yx 0-1000 */
  BBOX_YX_1000: { shape: 'bbox', order: 'yx', normalizedBy: 1000, resultKey: 'bbox' },
  /** Kimi: point xy 0-1 */
  POINT_XY_UNIT: { shape: 'point', order: 'xy', normalizedBy: 1, resultKey: 'point' },
  /** GPT: bbox xy 像素 */
  BBOX_XY_PIXEL: { shape: 'bbox', order: 'xy', normalizedBy: null, boundsType: 'left-closed-right-open', resultKey: 'bbox' },
  /** qwen2.5-vl: bbox_2d xy 像素 */
  BBOX_2D_XY_PIXEL: { shape: 'bbox', order: 'xy', normalizedBy: null, resultKey: 'bbox_2d', resultKeyAliases: ['bbox'] },
  /** DeepSeek element: point xy 0-1000 */
  POINT_XY_1000: { shape: 'point', order: 'xy', normalizedBy: 1000, resultKey: 'point' },
};

// ─── CoordinateCodec：统一坐标编解码器 ──────────────────────────────────────
/**
 * 由 CoordinateSpec 驱动的坐标编解码器。
 * 同一份 spec 同时生成提示词文案、解析校验、像素换算。
 */
export class CoordinateCodec {
  /**
   * @param {CoordinateSpec} spec
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
   * 生成提示词中的坐标描述文案（与解析器永远一致）。
   * @returns {string}
   */
  describeForPrompt() {
    const shapeDesc = this.shape === 'bbox'
      ? `a bounding box [${this.order === 'yx' ? 'y1, x1, y2, x2' : 'x1, y1, x2, y2'}]`
      : `a point [${this.order === 'yx' ? 'y, x' : 'x, y'}]`;
    const normDesc = this.normalizedBy != null
      ? `normalized to 0-${this.normalizedBy} relative to the screenshot. Do NOT use pixel coordinates.`
      : 'in actual pixel coordinates relative to the screenshot. Do NOT normalize.';
    const orderNote = this.order === 'yx' ? ' Note: y comes first.' : '';
    return `Return the target as ${shapeDesc} ${normDesc}${orderNote}`;
  }

  /**
   * 生成 JSON 响应示例（用于提示词）。
   * @returns {string}
   */
  buildResponseExample() {
    if (this.shape === 'bbox') {
      return `{"${this.resultKey}": [100, 200, 300, 400]}`;
    }
    return `{"${this.resultKey}": [500, 600]}`;
  }

  /**
   * 生成未找到时的响应示例。
   * @returns {string}
   */
  buildNotFoundExample() {
    return `{"${this.resultKey}": [], "error": "Target not found on screen."}`;
  }

  /**
   * 从模型原始响应中提取坐标数字数组。
   * @param {*} raw - 模型返回值（JSON 对象 / 数组 / 字符串）
   * @returns {number[]|null} 坐标数组，null 表示未找到
   */
  parseCoordinates(raw) {
    // JSON 对象：按 resultKey + aliases 查找
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const keys = [this.resultKey, ...this.resultKeyAliases];
      for (const key of keys) {
        if (key in raw) {
          const value = raw[key];
          if (Array.isArray(value) && value.length === 0) return null; // 空数组 = not found
          return toNumbers(value);
        }
      }
      // 没有匹配的 key，尝试直接提取数字（兼容旧模式）
      return toNumbers(raw);
    }
    // 字符串 "NOT_FOUND"
    if (typeof raw === 'string' && /NOT_FOUND/i.test(raw)) return null;
    // 其他：直接提取数字
    const numbers = toNumbers(raw);
    return numbers.length > 0 ? numbers : null;
  }

  /**
   * 将坐标数字转换为设备像素。
   * @param {number[]} coords - 坐标数字数组
   * @param {{w: number, h: number}} size - 设备屏幕尺寸
   * @returns {{bounds: number[]|null, center: number[]|null, inScreen: boolean}}
   */
  toPixels(coords, size) {
    if (!coords || coords.length < 2) return { bounds: null, center: null, inScreen: false };

    // 归一化 → 像素换算
    const scaleX = this.normalizedBy != null
      ? (this.normalizationBasis === 'last-pixel' ? size.w - 1 : size.w) / this.normalizedBy
      : 1;
    const scaleY = this.normalizedBy != null
      ? (this.normalizationBasis === 'last-pixel' ? size.h - 1 : size.h) / this.normalizedBy
      : 1;

    let pixelCoords;
    if (this.order === 'yx') {
      // yx 序：先交换轴再换算
      if (coords.length >= 4) {
        pixelCoords = [coords[1] * scaleX, coords[0] * scaleY, coords[3] * scaleX, coords[2] * scaleY];
      } else {
        pixelCoords = [coords[1] * scaleX, coords[0] * scaleY];
      }
    } else {
      pixelCoords = coords.map((value, index) => value * (index % 2 === 0 ? scaleX : scaleY));
    }

    // 取整
    const roundFn = this.rounding === 'trunc' ? Math.trunc : this.rounding === 'none' ? (v) => v : Math.round;
    pixelCoords = pixelCoords.map(roundFn);

    if (pixelCoords.length >= 4 && this.shape === 'bbox') {
      return this._finishBbox(pixelCoords.slice(0, 4), size);
    }
    return this._finishPoint(pixelCoords.slice(0, 2), size);
  }

  /** @private bbox 收尾：规范化左上右下 + inScreen 判定 */
  _finishBbox([left, top, right, bottom], size) {
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

  /** @private point 收尾 */
  _finishPoint([x, y], size) {
    const inScreen = x >= -1 && y >= -1 && x <= size.w + 1 && y <= size.h + 1;
    return { bounds: null, center: [Math.round(x), Math.round(y)], inScreen };
  }
}

// ─── 原有策略类（向后兼容，内部委托 CoordinateCodec）────────────────────────
export class CoordinateStrategy {
  constructor(name) {
    this._name = name;
  }
  get name() { return this._name; }
  toPixels() { throw new Error('abstract'); }
  describeForPrompt() { return ''; }
  _bboxFinish([left, top, right, bottom], size) {
    const L = Math.min(left, right), T = Math.min(top, bottom), R = Math.max(left, right), B = Math.max(top, bottom);
    const inScreen = L >= -1 && T >= -1 && R <= size.w + 1 && B <= size.h + 1;
    return {
      bounds: [Math.round(L), Math.round(T), Math.round(R), Math.round(B)],
      center: [Math.floor((L + R) / 2), Math.floor((T + B) / 2)],
      inScreen,
    };
  }
  _pointFinish([x, y], size) {
    const inScreen = x >= -1 && y >= -1 && x <= size.w + 1 && y <= size.h + 1;
    return { bounds: null, center: [Math.round(x), Math.round(y)], inScreen };
  }
}

/** GLM / Qwen / DeepSeek / 豆包：bbox，xy 序，0-1000 归一化 */
export class Normalized1000Bbox extends CoordinateStrategy {
  constructor() {
    super('normalized_1000_xy');
    this._codec = new CoordinateCodec(COORDINATE_SPECS.BBOX_XY_1000);
  }
  toPixels(raw, size) {
    const coords = toNumbers(raw);
    if (coords.length < 2) return { bounds: null, center: null, inScreen: false };
    return this._codec.toPixels(coords, size);
  }
  describeForPrompt() { return this._codec.describeForPrompt(); }
}

/** Gemini：bbox，yx 序，0-1000 归一化 */
export class Normalized1000BboxYX extends CoordinateStrategy {
  constructor() {
    super('normalized_1000_yx');
    this._codec = new CoordinateCodec(COORDINATE_SPECS.BBOX_YX_1000);
  }
  toPixels(raw, size) {
    const coords = toNumbers(raw);
    if (coords.length < 2) return { bounds: null, center: null, inScreen: false };
    return this._codec.toPixels(coords, size);
  }
  describeForPrompt() { return this._codec.describeForPrompt(); }
}

/** Kimi：point，0-1 归一化 */
export class NormalizedUnitPoint extends CoordinateStrategy {
  constructor() {
    super('normalized_unit_point');
    this._codec = new CoordinateCodec(COORDINATE_SPECS.POINT_XY_UNIT);
  }
  toPixels(raw, size) {
    const coords = toNumbers(raw);
    if (coords.length < 2) return { bounds: null, center: null, inScreen: false };
    return this._codec.toPixels(coords, size);
  }
  describeForPrompt() { return this._codec.describeForPrompt(); }
}

/** GPT：绝对像素 */
export class AbsolutePixel extends CoordinateStrategy {
  constructor() {
    super('absolute_pixel');
    this._codec = new CoordinateCodec(COORDINATE_SPECS.BBOX_XY_PIXEL);
  }
  toPixels(raw, size) {
    const coords = toNumbers(raw);
    if (coords.length < 2) return { bounds: null, center: null, inScreen: false };
    return this._codec.toPixels(coords, size);
  }
  describeForPrompt() { return this._codec.describeForPrompt(); }
}
