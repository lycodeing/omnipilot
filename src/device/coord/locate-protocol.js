// 统一 VLM 定位提示词组装 + 响应解析（设计文档 §3.6，借鉴 Midscene 三段式）。
// System = intro（适配器提供或通用默认）+ groundingRules（全局 7 条定位纪律）+ responseInstructions（由坐标元数据自动生成）。
// User = "Find: {target}"。
// protocol 与 codec 正交：本模块只管提示词骨架与响应结构（json/xml-tags/raw-numbers），
// 坐标语义与像素换算归 strategy.js 的 CoordinateCodec。

import { toNumbers } from './strategy.js';

/**
 * 通用系统提示词前缀（适配器未提供 systemPromptIntro 时的缺省段）。
 * @type {string}
 */
export const DEFAULT_SYSTEM_PROMPT_INTRO =
  'You are a visual grounding assistant for UI automation. ' +
  'You receive a screenshot of a mobile device screen and a description of one target element. ' +
  'Your only job is to locate that element precisely on the screenshot.';

/**
 * 全局共享的 7 条定位纪律（grounding rules）。
 * 第 5/6 条为 CJK 文本处理规则：跨行文本取前 2-4 字匹配、框紧贴可见文本区域——
 * 中文按钮文案常带换行/省略号，整串匹配会导致框偏移或放大（评估报告 y 偏 +62px 的教训之一）。
 * @type {string[]}
 */
export const GROUNDING_RULES = [
  'Locate ONLY the element that best matches the description; never return coordinates of a similar-looking neighbor.',
  'The box must tightly enclose the visible extent of the target element itself, not its parent container or the whole row/card.',
  'Coordinates are relative to the provided screenshot image, whose top-left corner is the origin (0, 0).',
  'If multiple candidates match, prefer the one that is fully visible, enabled and interactive (not grayed out or clipped).',
  'For CJK (Chinese/Japanese/Korean) text targets that wrap across lines or end with an ellipsis, match by the first 2-4 visible characters instead of requiring the full string.',
  'For text targets, hug the visible glyph area of the text; do not extend the box into surrounding padding, icons or blank background.',
  'If the target is not visible on this screen, use the not-found response defined below. NEVER guess or fabricate coordinates.',
];

/**
 * 把坐标元数据渲染成提示词中的坐标制式描述（与解析器同一份 spec，杜绝漂移）。
 * @param {import('./strategy.js').CoordinateSpec} coordinateSpec - 坐标元数据
 * @returns {string} 坐标制式英文描述（进提示词）
 */
function describeCoordinateSystem(coordinateSpec) {
  const order = coordinateSpec.order ?? 'xy';
  const shape = coordinateSpec.shape ?? 'bbox';
  const normalizedBy = coordinateSpec.normalizedBy ?? null;
  const shapeDescription = shape === 'bbox'
    ? `a bounding box [${order === 'yx' ? 'y1, x1, y2, x2' : 'x1, y1, x2, y2'}]`
    : `a point [${order === 'yx' ? 'y, x' : 'x, y'}]`;
  const scaleDescription = normalizedBy != null
    ? `normalized to 0-${normalizedBy} relative to the screenshot size (NOT pixel coordinates)`
    : 'in actual pixel coordinates relative to the screenshot (do NOT normalize)';
  const orderNote = order === 'yx' ? ' Note: y comes first.' : '';
  const boundsNote = coordinateSpec.boundsType === 'left-closed-right-open'
    ? ' The right/bottom edges are exclusive (left-closed, right-open).'
    : '';
  return `Report the target as ${shapeDescription}, ${scaleDescription}.${orderNote}${boundsNote}`;
}

/**
 * 生成一组合法示例坐标值（按 spec 的 shape/order/normalizedBy 推导，保证示例落在值域内）。
 * @param {import('./strategy.js').CoordinateSpec} coordinateSpec - 坐标元数据
 * @returns {number[]} 示例坐标数组（bbox 4 元素 / point 2 元素）
 */
function buildExampleCoordinates(coordinateSpec) {
  const shape = coordinateSpec.shape ?? 'bbox';
  const normalizedBy = coordinateSpec.normalizedBy ?? null;
  if (normalizedBy === 1) {
    // 0-1 单位比：示例用小数
    return shape === 'bbox' ? [0.1, 0.2, 0.3, 0.4] : [0.5, 0.6];
  }
  if (normalizedBy != null) {
    // 千分比等整数归一化：示例取量程内的整数
    const scale = normalizedBy;
    return shape === 'bbox'
      ? [Math.round(scale * 0.1), Math.round(scale * 0.2), Math.round(scale * 0.3), Math.round(scale * 0.4)]
      : [Math.round(scale * 0.5), Math.round(scale * 0.6)];
  }
  // 绝对像素：示例用小像素值（真实值随截图尺寸变化）
  return shape === 'bbox' ? [100, 200, 300, 400] : [500, 600];
}

/**
 * 由坐标元数据自动生成响应格式指令（JSON schema 描述 + 命中/未命中示例）。
 * 三种 responseFormat：
 * - 'json'（默认）：{"<resultKey>": [...]}，未命中空数组 + error 说明
 * - 'xml-tags'（deepseek 风格）：<resultKey>x1,y1,x2,y2</resultKey>，未命中 <error> 标签
 * - 'raw-numbers'（兼容旧模式）：只回数字，未命中回 NOT_FOUND 字符串
 * @param {import('./strategy.js').CoordinateSpec} coordinateSpec - 坐标元数据
 * @param {'json'|'xml-tags'|'raw-numbers'} [responseFormat='json'] - 响应格式
 * @returns {string} 响应格式指令段（进系统提示词第三段）
 */
export function buildResponseInstructions(coordinateSpec, responseFormat = 'json') {
  const resultKey = coordinateSpec.resultKey ?? 'bbox';
  const coordinateDescription = describeCoordinateSystem(coordinateSpec);
  const exampleCoordinates = buildExampleCoordinates(coordinateSpec);
  const expectedLength = (coordinateSpec.shape ?? 'bbox') === 'bbox' ? 4 : 2;

  if (responseFormat === 'xml-tags') {
    return [
      coordinateDescription,
      `Respond with ONLY an XML tag named "${resultKey}" containing exactly ${expectedLength} comma-separated numbers, e.g. <${resultKey}>${exampleCoordinates.join(', ')}</${resultKey}>.`,
      `If the target is not visible, respond with ONLY <error>Target not found on screen.</error>.`,
      'No markdown fences, no explanations, no extra text outside the tags.',
    ].join('\n');
  }

  if (responseFormat === 'raw-numbers') {
    return [
      coordinateDescription,
      `Respond with ONLY the ${expectedLength} numbers separated by commas or spaces, e.g. ${exampleCoordinates.join(', ')}.`,
      'If the target is NOT visible on this screen, reply with exactly: NOT_FOUND.',
      'No JSON, no labels, no explanations — only the numbers or NOT_FOUND.',
    ].join('\n');
  }

  // json（默认）：结构化 NOT_FOUND 出口（空数组 + error），替代纯文本 NOT_FOUND
  const hitExample = JSON.stringify({ [resultKey]: exampleCoordinates });
  const missExample = JSON.stringify({ [resultKey]: [], error: 'Target not found on screen.' });
  return [
    coordinateDescription,
    `Respond with ONLY a single JSON object of the form {"${resultKey}": [${expectedLength} numbers]}, e.g. ${hitExample}.`,
    `If the target is not visible, respond with ${missExample} (empty array means not found).`,
    'No markdown fences, no explanations, no extra keys beyond the coordinate array and the optional "error" string.',
  ].join('\n');
}

/**
 * 组装完整系统提示词（三段式：intro + groundingRules + responseInstructions）。
 * @param {{systemPromptIntro?: string, coordinateSpec: import('./strategy.js').CoordinateSpec, responseFormat?: 'json'|'xml-tags'|'raw-numbers'}} adapter - 适配器的协议槽位（ResolvedModelAdapter.protocol 或等价对象）
 * @returns {string} 完整系统提示词
 */
export function buildSystemPrompt(adapter) {
  const intro = adapter.systemPromptIntro ?? DEFAULT_SYSTEM_PROMPT_INTRO;
  const rulesSection = ['Grounding rules:', ...GROUNDING_RULES.map((rule, index) => `${index + 1}. ${rule}`)].join('\n');
  const responseSection = buildResponseInstructions(adapter.coordinateSpec, adapter.responseFormat ?? 'json');
  return [intro, rulesSection, responseSection].join('\n\n');
}

/**
 * 组装用户提示词（Midscene 同款极简形态，目标描述独占一行）。
 * @param {string} target - 目标元素描述（如 "text=确认" 或自然语言描述）
 * @returns {string} 用户提示词
 */
export function buildUserPrompt(target) {
  return `Find: ${target}`;
}

/**
 * 从字符串中剥离 markdown 代码围栏并截取首个 JSON 对象/数组片段。
 * 模型常见污染：```json 围栏、前后解释文字——先剥围栏再定位括号边界。
 * @param {string} rawText - 模型原始文本
 * @returns {*|null} 解析出的 JSON 值；无有效 JSON 返回 null
 */
function extractJsonPayload(rawText) {
  const withoutFences = String(rawText).replace(/```(?:json|xml)?/gi, '').trim();
  try {
    return JSON.parse(withoutFences);
  } catch { /* 整体不是纯 JSON，继续尝试截取片段 */ }
  const objectStart = withoutFences.indexOf('{');
  const objectEnd = withoutFences.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      return JSON.parse(withoutFences.slice(objectStart, objectEnd + 1));
    } catch { /* 对象片段也无效 */ }
  }
  const arrayStart = withoutFences.indexOf('[');
  const arrayEnd = withoutFences.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(withoutFences.slice(arrayStart, arrayEnd + 1));
    } catch { /* 数组片段也无效 */ }
  }
  return null;
}

/**
 * 在已解析的 JSON 对象中按主键 + 别名提取坐标值。
 * @param {Object} payload - 已解析 JSON 对象
 * @param {import('./strategy.js').CoordinateSpec} coordinateSpec - 坐标元数据
 * @returns {number[]|null|undefined} 坐标数组；主键值为空数组 → null（not-found）；未命中任何键 → undefined（调用方决定兜底策略）
 */
function extractByKey(payload, coordinateSpec) {
  const candidateKeys = [coordinateSpec.resultKey ?? 'bbox', ...(coordinateSpec.resultKeyAliases ?? [])];
  for (const key of candidateKeys) {
    if (payload != null && typeof payload === 'object' && key in payload) {
      const value = payload[key];
      if (Array.isArray(value) && value.length === 0) return null; // 结构化 not-found 出口
      const numbers = toNumbers(value);
      return numbers.length > 0 ? numbers : null;
    }
  }
  return undefined; // 未命中任何键：交给调用方决定是否盲抓数字
}

/**
 * 解析 xml-tags 格式响应（deepseek 风格：<resultKey>数字列表</resultKey>）。
 * 容错：标签名大小写不敏感、允许别名标签、<error> 标签判 not-found。
 * @param {string} rawText - 模型原始文本
 * @param {import('./strategy.js').CoordinateSpec} coordinateSpec - 坐标元数据
 * @returns {number[]|null} 坐标数组；未找到/无法解析返回 null
 */
function parseXmlTagsResponse(rawText, coordinateSpec) {
  const text = String(rawText);
  if (/<error\b[^>]*>/i.test(text)) return null;
  const candidateKeys = [coordinateSpec.resultKey ?? 'bbox', ...(coordinateSpec.resultKeyAliases ?? [])];
  for (const key of candidateKeys) {
    const tagPattern = new RegExp(`<${key}\\b[^>]*>([\\s\\S]*?)</${key}>`, 'i');
    const match = text.match(tagPattern);
    if (match) {
      const numbers = toNumbers(match[1]);
      return numbers.length > 0 ? numbers : null;
    }
  }
  // 无匹配标签：兜底盲抓数字（宽松代理下模型可能省略标签）
  const fallbackNumbers = toNumbers(text);
  return fallbackNumbers.length > 0 ? fallbackNumbers : null;
}

/**
 * 解析 VLM 定位响应为坐标数字数组（不做像素换算——那是 CoordinateCodec.toPixels 的职责）。
 * NOT_FOUND 出口约定：
 * - json：主键空数组 [] 或 "NOT_FOUND" 文本 → null
 * - xml-tags：<error> 标签或 "NOT_FOUND" 文本 → null
 * - raw-numbers："NOT_FOUND" 字符串 → null
 * @param {*} raw - 模型原始响应（字符串 / 已解析对象 / 数组）
 * @param {import('./strategy.js').CoordinateSpec} coordinateSpec - 坐标元数据
 * @param {'json'|'xml-tags'|'raw-numbers'} [responseFormat='json'] - 响应格式
 * @returns {number[]|null} 坐标数字数组（原始值域，未换算像素）；not-found 或无法解析返回 null
 */
export function parseLocateResponse(raw, coordinateSpec, responseFormat = 'json') {
  if (raw == null) return null;

  // 已是对象/数组（上游 chat 层可能已 JSON.parse）：直接按键提取
  if (typeof raw === 'object') {
    if (Array.isArray(raw)) {
      if (raw.length === 0) return null;
      const numbers = toNumbers(raw);
      return numbers.length > 0 ? numbers : null;
    }
    const byKey = extractByKey(raw, coordinateSpec);
    if (byKey !== undefined) return byKey;
    const fallbackNumbers = toNumbers(raw);
    return fallbackNumbers.length > 0 ? fallbackNumbers : null;
  }

  const rawText = String(raw).trim();
  if (rawText.length === 0) return null;
  // 三种格式共认的显式 not-found 文本出口（兼容旧模式回复）
  if (/^NOT_FOUND$/i.test(rawText)) return null;

  if (responseFormat === 'raw-numbers') {
    const numbers = toNumbers(rawText);
    return numbers.length > 0 ? numbers : null;
  }

  if (responseFormat === 'xml-tags') {
    return parseXmlTagsResponse(rawText, coordinateSpec);
  }

  // json（默认）：剥围栏 → 解析 → 按键提取；JSON 里嵌 NOT_FOUND 字符串也判 not-found
  const payload = extractJsonPayload(rawText);
  if (payload != null) {
    if (Array.isArray(payload)) {
      if (payload.length === 0) return null;
      const numbers = toNumbers(payload);
      return numbers.length > 0 ? numbers : null;
    }
    const byKey = extractByKey(payload, coordinateSpec);
    if (byKey !== undefined) return byKey;
    // 有 JSON 但没匹配键：不盲抓（避免把 error 文案里的数字当坐标），判无法解析
    return null;
  }
  // 完全不是 JSON：最后兜底盲抓数字（宽松代理下模型可能回纯数字）
  if (/NOT_FOUND/i.test(rawText)) return null;
  const fallbackNumbers = toNumbers(rawText);
  return fallbackNumbers.length > 0 ? fallbackNumbers : null;
}