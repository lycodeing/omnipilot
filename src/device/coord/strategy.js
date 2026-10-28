// VLM 坐标换算策略（§5.5.2）：shape(bbox/point) × order(xy/yx) × normalizedBy(1000/1/无)
// 配置值来自 Midscene v1.17.0 源码提取（§5.5.1 表格）

function toNumbers(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.flat(Infinity).map(Number).filter(Number.isFinite);
  if (typeof raw === 'object') {
    const o = raw;
    if (['x1', 'y1', 'x2', 'y2'].every((k) => k in o)) return [o.x1, o.y1, o.x2, o.y2].map(Number);
    if ('x' in o && 'y' in o) return [o.x, o.y].map(Number);
    return toNumbers(Object.values(o));
  }
  if (typeof raw === 'string') {
    const nums = raw.match(/-?\d+(?:\.\d+)?/g);
    return nums ? nums.map(Number) : [];
  }
  return [];
}

export function pointInBounds([x, y], [l, t, r, b]) {
  return x >= l && x <= r && y >= t && y <= b;
}

export class CoordinateStrategy {
  constructor(name) {
    this._name = name;
  }
  get name() {
    return this._name;
  }
  // raw → 设备像素：{ bounds: [l,t,r,b]|null, center: [x,y]|null, inScreen: boolean }
  toPixels() {
    throw new Error('abstract');
  }
  describeForPrompt() {
    return '';
  }
  _bboxFinish([l, t, r, b], size) {
    const L = Math.min(l, r), T = Math.min(t, b), R = Math.max(l, r), B = Math.max(t, b);
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

// GLM / Qwen / DeepSeek / 豆包：bbox，xy 序，0-1000 归一化
export class Normalized1000Bbox extends CoordinateStrategy {
  constructor() {
    super('normalized_1000_xy');
  }
  toPixels(raw, size) {
    const nums = toNumbers(raw);
    if (nums.length >= 4) {
      const [x1, y1, x2, y2] = nums;
      return this._bboxFinish([x1 * size.w / 1000, y1 * size.h / 1000, x2 * size.w / 1000, y2 * size.h / 1000], size);
    }
    if (nums.length >= 2) return this._pointFinish([nums[0] * size.w / 1000, nums[1] * size.h / 1000], size);
    return { bounds: null, center: null, inScreen: false };
  }
  describeForPrompt() {
    return 'Return the target as a bounding box [x1, y1, x2, y2] in [x, y] order, normalized to 0-1000 relative to the screenshot. Do NOT use pixel coordinates.';
  }
}

// Gemini：bbox，先交换 yx 再换算（坐标顺序是先 y 后 x）
export class Normalized1000BboxYX extends CoordinateStrategy {
  constructor() {
    super('normalized_1000_yx');
  }
  toPixels(raw, size) {
    const nums = toNumbers(raw);
    if (nums.length >= 4) {
      const [y1, x1, y2, x2] = nums;
      return this._bboxFinish([x1 * size.w / 1000, y1 * size.h / 1000, x2 * size.w / 1000, y2 * size.h / 1000], size);
    }
    if (nums.length >= 2) return this._pointFinish([nums[1] * size.w / 1000, nums[0] * size.h / 1000], size);
    return { bounds: null, center: null, inScreen: false };
  }
  describeForPrompt() {
    return 'Return the target as a bounding box in [y, x] order (y comes first), normalized to 0-1000 relative to the screenshot. Do NOT use pixel coordinates.';
  }
}

// Kimi：point，0-1 归一化（normalizedBy=1，不是 0-1000）
export class NormalizedUnitPoint extends CoordinateStrategy {
  constructor() {
    super('normalized_unit_point');
  }
  toPixels(raw, size) {
    const nums = toNumbers(raw);
    if (nums.length >= 4) {
      const [x1, y1, x2, y2] = nums;
      return this._bboxFinish([x1 * size.w, y1 * size.h, x2 * size.w, y2 * size.h], size);
    }
    if (nums.length >= 2) return this._pointFinish([nums[0] * size.w, nums[1] * size.h], size);
    return { bounds: null, center: null, inScreen: false };
  }
  describeForPrompt() {
    return 'Return the target as a point [x, y] normalized to 0-1 relative to the screenshot. Do NOT use pixel coordinates.';
  }
}

// GPT：绝对像素，不能归一化
export class AbsolutePixel extends CoordinateStrategy {
  constructor() {
    super('absolute_pixel');
  }
  toPixels(raw, size) {
    const nums = toNumbers(raw);
    if (nums.length >= 4) return this._bboxFinish([nums[0], nums[1], nums[2], nums[3]], size);
    if (nums.length >= 2) return this._pointFinish([nums[0], nums[1]], size);
    return { bounds: null, center: null, inScreen: false };
  }
  describeForPrompt() {
    return 'Return the target as a bounding box [x1, y1, x2, y2] in actual pixel coordinates relative to the screenshot. Do NOT normalize.';
  }
}
