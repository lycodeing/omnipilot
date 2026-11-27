// 定位策略链（§5.1）：精确文本 → 正则/包含 → resource-id → class+index → VLM（注入函数）
// clickable=false 兜底（§5.4.2）；hint 跨执行坐标缓存校验（§5.0.5 R2）；文本匹配不缓存（§5.0.2.1）
//
// 职责拆分：每个子函数只做一件事，locate 主函数只负责编排。
import { flattenNodes, nodeIdentity, isZeroAreaBounds, hasWebViewContainer } from './uitree.js';
import { resolveStrategy } from './coord/registry.js';
import { loadProbeFamily, probeCachePath } from './coord/probe.js';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

// ─── 常量 ──────────────────────────────────────────────────────────────────
// 单个 case 的诊断快照上限：避免连续 MISS 无限堆积。目录按 case 隔离（bin/ask.js runOne），
// 并发 run 各自独立计数；同 case 内串行定位，readdir 计数竞态风险极低。
const MISS_DUMP_MAX_FILES = 20;
// bounds 数组固定为 [left, top, right, bottom] 四元组
const BOUNDS_LENGTH = 4;
// 安全正则的最大长度（超长模式直接拒绝，见 compileSafeRegex）
const MAX_REGEX_LEN = 200;
// 失败候选列表默认条数（给模型改写描述用）
const DEFAULT_CANDIDATE_LIMIT = 8;
// 候选相关度：resourceId 与目标互相包含时的加权分
const RESOURCE_ID_SCORE_BONUS = 3;
// VLM 返回无法解析时，错误信息里原始输出的截断长度
const VLM_RAW_ERROR_SNIPPET_LEN = 120;
// MISS 快照文件名随机后缀的起止位（toString(36) 去掉 "0." 前缀后截取）
const MISS_FILE_RANDOM_SUFFIX_START = 2;
const MISS_FILE_RANDOM_SUFFIX_END = 8;
// selector 各前缀的字面长度（slice 偏移量来源）
const TEXT_CONTAINS_PREFIX_LEN = 'text*='.length;
const TEXT_EXACT_PREFIX_LEN = 'text='.length;
const RESOURCE_ID_PREFIX_LEN = 'resourceId='.length;
const ID_PREFIX_LEN = 'id='.length;
const CLASS_PREFIX_LEN = 'class='.length;
const REGEX_PREFIX_LEN = 're:'.length;
// auto/exact_text 链中「形如 Android 类名」的判定（命中才追加 class_index 策略）
const ANDROID_CLASS_NAME_PATTERN = /^android\./i;
// identity 快照比对的字段集合（§5.0.5 R2）
const IDENTITY_FIELDS = ['text', 'contentDesc', 'resourceId', 'cls'];

// ─── MISS 诊断落盘 ─────────────────────────────────────────────────────────
/**
 * LOCATE_MISS 诊断：把当次 flat 树落盘，供区分「树不可用 / 树里没有目标 / 目标零面积被过滤」。
 * 失败路径专用，成功路径零开销；无 missDumpDir（如单测未注入）时不落盘。
 * 异步 + 临时文件 rename 原子写：busy 态下不阻塞事件循环，进程被 kill 也不会留半截 JSON。
 * 密码框文本掩码：诊断快照不得把凭据明文写进 run 目录（与截图遮罩同一约束）。
 */
async function dumpMissTree(dir, { target, attempted, flat = [], reason, tree = null, size = null, treeError = null }) {
  if (!dir) return;
  try {
    await fsp.mkdir(dir, { recursive: true });
    const existing = (await fsp.readdir(dir)).filter((fileName) => fileName.startsWith('locate-miss-') && fileName.endsWith('.json'));
    if (existing.length >= MISS_DUMP_MAX_FILES) return; // 达上限静默跳过，不影响定位
    const treeSnapshot = tree ?? {};
    const randomSuffix = Math.random().toString(36).slice(MISS_FILE_RANDOM_SUFFIX_START, MISS_FILE_RANDOM_SUFFIX_END);
    const snapshot = {
      target,
      attempted,
      reason,
      at: new Date().toISOString(),
      pid: process.pid,
      treeFromCache: Boolean(treeSnapshot.fromCache),
      treeCachedAt: treeSnapshot.cachedAt ?? null,
      dumpMs: treeSnapshot.dumpMs ?? null,
      treeUnavailable: Boolean(treeError),
      treeError: treeError ?? null,
      screenSize: size ? { w: size.w, h: size.h } : null,
      nodes: (flat ?? []).map((node) => {
        const isPassword = Boolean(node.password);
        return {
          index: node.index,
          text: isPassword ? '[REDACTED]' : (node.text ?? ''),
          contentDesc: isPassword ? '[REDACTED]' : (node.contentDesc ?? ''),
          resourceId: node.resourceId ?? '', cls: node.cls ?? '', clickable: node.clickable ?? null,
          password: isPassword, bounds: node.bounds ?? null,
        };
      }),
    };
    const finalPath = join(dir, `locate-miss-${Date.now()}-${process.pid}-${randomSuffix}.json`);
    const tmpPath = `${finalPath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(snapshot, null, 2));
    await fsp.rename(tmpPath, finalPath);
  } catch { /* 诊断落盘失败不影响定位结果 */ }
}

// ─── 几何工具 ──────────────────────────────────────────────────────────────
/**
 * 判断 bounds 是否在屏幕内且面积有效。
 * @param {number[]} bounds - [left, top, right, bottom]
 * @param {{w:number, h:number}} size - 屏幕尺寸
 * @param {object[]} [flatNodes] - 可选：扁平节点列表，用于 WebView 零面积放行判定。
 *   传入时，零面积 + WebView 壳 → 返回 true（几何未知，非隐藏）；
 *   不传时保持原严格行为（向后兼容）。
 */
export function inScreen(bounds, size, flatNodes) {
  if (!Array.isArray(bounds) || bounds.length !== BOUNDS_LENGTH) return false;
  const [left, top, right, bottom] = bounds;
  const isZeroArea = right <= left || bottom <= top;
  // WebView 壳内零面积 = 渲染器特性（几何未知），不是隐藏节点 → 放行
  if (isZeroArea && flatNodes && hasWebViewContainer(flatNodes)) return true;
  // 非零面积才做严格的四边在屏 + 面积检查
  return left >= 0 && top >= 0 && right <= size.w && bottom <= size.h && !isZeroArea;
}

/**
 * 计算 bounds 面积（负宽高按 0 计）。用于「最小面积优先」排序。
 * @param {number[]} bounds - [left, top, right, bottom]
 */
function area([left, top, right, bottom]) {
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

// ─── selector 解析 ─────────────────────────────────────────────────────────
/**
 * 解析 target 字符串为结构化 selector。支持形态：
 * 'text=xx' | 'id=xx' | 'resource-id=xx' | 'class=C#index=N' | 'type=C' | 'desc=xx' | 're:pattern' | 自动
 * 'within=<scopeSel>::<targetSel>'：行内作用域定位——先找 scope 节点，再在其 bounds 内匹配 target。
 * 用于点某一行右侧按钮这类需求（列表行序与 #index 不一致时 index 定位会点错行）。
 */
export function parseTarget(target) {
  const trimmed = String(target ?? '').trim();
  let match;
  if ((match = /^within=(.+?)::(.+)$/s.exec(trimmed))) {
    return { kind: 'within', scope: match[1], inner: match[2] };
  }
  if ((match = /^(?:resource-id|id)=(.+?)(?:#index=(\d+))?$/i.exec(trimmed))) {
    return { kind: 'resource_id', id: match[1], index: match[2] ? Number(match[2]) : 0 };
  }
  if ((match = /^(?:class|type)=(.+?)(?:#index=(\d+))?$/i.exec(trimmed))) {
    return { kind: 'class_index', cls: match[1], index: match[2] ? Number(match[2]) : 0 };
  }
  if ((match = /^text=(.+?)(?:#index=(\d+))?$/i.exec(trimmed))) {
    return { kind: 'exact_text', text: match[1], index: match[2] ? Number(match[2]) : 0 };
  }
  // text*= 前缀匹配（包含）。matchNodeSelector 与工具层文档（ai_wait_for 的 selector 说明）
  // 都承诺支持 text*= —— waitForElement 等走 parseTarget 的路径必须同一套语法。
  if ((match = /^text\*=(.+?)(?:#index=(\d+))?$/i.exec(trimmed))) {
    return { kind: 'contains', text: match[1], field: null };
  }
  if ((match = /^desc=(.+)$/i.exec(trimmed))) return { kind: 'contains', text: match[1], field: 'contentDesc' };
  if ((match = /^re:(.+)$/s.exec(trimmed))) return { kind: 'regex', pattern: match[1] };
  return { kind: 'auto', text: trimmed };
}

/**
 * 按 parseTarget 结果取候选节点（within 作用域定位复用）。
 * auto 形态退化为「精确 ∪ 包含」的并集。
 */
function findByKind(flat, parsed) {
  if (parsed.kind === 'exact_text') return findByExactText(flat, parsed.text);
  if (parsed.kind === 'contains') return findByContains(flat, parsed.text, parsed.field);
  if (parsed.kind === 'regex') return findByRegex(flat, parsed.pattern);
  if (parsed.kind === 'resource_id') return findByResourceId(flat, parsed.id);
  if (parsed.kind === 'class_index') return findByClass(flat, parsed.cls);
  return findByExactText(flat, parsed.text).concat(findByContains(flat, parsed.text));
}

/**
 * 诊断用：取「未经 inScreen 过滤」的原始命中，与 locate 主链同源（findByKind）。
 * 仅用于判断失败原因，不参与定位结果。within 形态按主链的 scope/inner 两段还原。
 */
function rawHitsForReason(flat, parsed) {
  if (parsed.kind === 'within') {
    const scope = findByKind(flat, parseTarget(parsed.scope))[0] ?? null;
    if (!scope || !Array.isArray(scope.bounds)) return [];
    return findByKind(flat, parseTarget(parsed.inner)).filter((node) => Array.isArray(node.bounds)
      && node !== scope
      && node.bounds[1] < scope.bounds[3] && node.bounds[3] > scope.bounds[1]);
  }
  return findByKind(flat, parsed);
}

/**
 * 节点级 selector 匹配（tools/perception.js 的 matchSelector 同源逻辑，设备层自用）：
 * 'text=' 精确 | 'text*=' 包含 | 'resourceId='/'id=' | 'class=#index=' | 're:' 正则
 */
export function matchNodeSelector(node, sel) {
  const selector = String(sel ?? '').trim();
  if (selector.startsWith('text*=')) return String(node.text || '').includes(selector.slice(TEXT_CONTAINS_PREFIX_LEN));
  if (selector.startsWith('text=')) {
    const expected = selector.slice(TEXT_EXACT_PREFIX_LEN);
    return node.text === expected || node.contentDesc === expected;
  }
  if (selector.startsWith('resourceId=')) return node.resourceId === selector.slice(RESOURCE_ID_PREFIX_LEN);
  if (selector.startsWith('id=')) return node.resourceId === selector.slice(ID_PREFIX_LEN);
  if (selector.startsWith('class=')) {
    const [className, indexPart] = selector.slice(CLASS_PREFIX_LEN).split('#index=');
    if (node.cls !== className) return false;
    if (indexPart !== undefined) return Number(node.index) === Number(indexPart);
    return true;
  }
  if (selector.startsWith('re:')) {
    const regex = compileSafeRegex(selector.slice(REGEX_PREFIX_LEN));   // 嵌套量词等危险模式会被拒绝（ReDoS 防护）
    if (!regex) return false;
    return regex.test(String(node.text || '')) || regex.test(String(node.contentDesc || ''));
  }
  return false;
}

// ─── 基础查找器 ────────────────────────────────────────────────────────────
/** 精确文本匹配：text 或 contentDesc 全等。 */
export function findByExactText(flat, text) {
  return flat.filter((node) => node.text === text || node.contentDesc === text);
}

/** 包含匹配（大小写不敏感）：field='contentDesc' 时只查 contentDesc，否则 text/contentDesc 任一命中。 */
export function findByContains(flat, text, field = null) {
  const query = String(text).toLowerCase();
  return flat.filter((node) => {
    const inText = node.text && node.text.toLowerCase().includes(query);
    const inDesc = node.contentDesc && node.contentDesc.toLowerCase().includes(query);
    if (field === 'contentDesc') return inDesc;
    return inText || inDesc;
  });
}

// 安全正则编译：selector 的 re: 分支可由用例文本、data_extract 参数或模型产出提供，
// 是"外部输入 → 正则执行器"的直连通道。危险正则会在 UI 树的每个节点上触发灾难性
// 回溯——UI 树常有数百节点，单次 locate 可挂死数分钟（无超时、无中断）。
//
// 判据用**逐字符扫描**而非整模式正则匹配——嵌套组会让"组 + 量词"的正则匹配
// 失效（`[^()]*` 遇嵌套括号即断），黑名单式整模式匹配挡不住所有形态：
// (a|aa)+$、(?:a{1,10}){1,10}$、(a{2,})+$ 都能绕过"嵌套量词"检测，
// 其中 (?:a{1,10}){1,10}$ 只需 36 字符即 5.5s（36 字符 × 数百节点 = 整轮挂死）。
//
// 扫描规则（每个量词看它的作用对象）：
//   - 作用对象是**分组**（(...) 或 (?:...)）→ 拒绝（组内重复 → 指数回溯）
//   - 作用对象是**量词**（* + ? {n,m} 紧跟另一个量词）→ 拒绝（嵌套量词）
//   - 出现反向引用 / 前后查找 / 命名组 → 拒绝
// 允许：字面字符、字符类、转义、锚点、无量词修饰的分组、单层量词。

/**
 * 逐字符扫描正则源码，判断是否含回溯风险构造。返回 true = 线性时间安全。
 * 规则见上方注释块；任何可疑构造一律拒绝（宁可误拒也不挂死）。
 */
function isLinearTimeSafe(source) {
  const groupStack = [];      // 分组栈：每项记录该组内是否出现过量词/交替
  let cursor = 0;
  let prevWasQuantifier = false;   // 上一个 token 是量词（用于检测嵌套量词）
  let prevWasGroup = false;        // 上一个 token 是 ')'（用于检测"组被量词修饰"）
  while (cursor < source.length) {
    const char = source[cursor];
    // 转义序列：跳过被转义的字符（\w \d \. \( 等）
    if (char === '\\') {
      if (cursor + 1 >= source.length) return false;      // 尾部孤立反斜杠
      const escaped = source[cursor + 1];
      if (escaped >= '1' && escaped <= '9') return false;      // 反向引用 → 复杂回溯
      cursor += 2;
      prevWasQuantifier = false;
      prevWasGroup = false;
      continue;
    }
    // 字符类 [...]：内部内容全部跳过（类内的 ] 与量词无回溯意义）
    if (char === '[') {
      let classCursor = cursor + 1;
      if (source[classCursor] === '^') classCursor++;
      if (source[classCursor] === ']') classCursor++;      // 类首的 ] 是字面量
      while (classCursor < source.length && source[classCursor] !== ']') classCursor++;
      if (classCursor >= source.length) return false;   // 未闭合的类
      cursor = classCursor + 1;
      prevWasQuantifier = false;
      prevWasGroup = false;
      continue;
    }
    // 分组开始
    if (char === '(') {
      // 前瞻/后顾/命名组 → 拒绝
      let skipLength = 1;
      if (source[cursor + 1] === '?') {
        const modifier = source[cursor + 2];
        if (modifier === '=' || modifier === '!' || modifier === '<') return false;
        if (modifier === ':') skipLength = 3;      // (?: 前缀 —— '?' 不是量词，整段跳过
      }
      groupStack.push({ hasQuantifier: false, hasAlternation: false });
      cursor += skipLength;
      prevWasQuantifier = false;
      prevWasGroup = false;
      continue;
    }
    // 分组结束
    if (char === ')') {
      const group = groupStack.pop();
      if (!group) return false;                      // 括号不配对
      prevWasQuantifier = false;
      prevWasGroup = true;                        // ')' 是分组结束 → 下个量词会修饰组
      if (group.hasAlternation) return false;       // 组内交替且组可被重复 → 歧义回溯
      continue;
    }
    // 交替
    if (char === '|') {
      const group = groupStack[groupStack.length - 1];
      if (group) group.hasAlternation = true;
      cursor += 1;
      prevWasQuantifier = false;
      prevWasGroup = false;
      continue;
    }
    // 量词
    let quantifierLength = 0;
    if (char === '*' || char === '+' || char === '?') quantifierLength = 1;
    else if (char === '{') {
      const closeIndex = source.indexOf('}', cursor);
      if (closeIndex === -1) return false;              // 未闭合的 {
      if (!/^\{\d*(,\d*)?\}$/.test(source.slice(cursor, closeIndex + 1))) {
        cursor = closeIndex + 1;                            // {literal} 不是量词
        prevWasQuantifier = false;
        prevWasGroup = false;
        continue;
      }
      quantifierLength = closeIndex - cursor + 1;
    }
    if (quantifierLength) {
      if (prevWasQuantifier) return false;        // 嵌套量词
      if (prevWasGroup) return false;             // 量词修饰分组 → 指数回溯
      const group = groupStack[groupStack.length - 1];
      if (group) group.hasQuantifier = true;
      cursor += quantifierLength;
      prevWasQuantifier = true;
      prevWasGroup = false;
      continue;
    }
    // 普通字面字符
    cursor += 1;
    prevWasQuantifier = false;
    prevWasGroup = false;
  }
  if (groupStack.length) return false;                // 括号未闭合
  return true;
}

/**
 * 安全正则编译：超长 / 含回溯风险构造 / 语法非法一律返回 null（调用方需显式处理）。
 */
export function compileSafeRegex(pattern, flags = 'i') {
  const source = String(pattern ?? '');
  if (!source || source.length > MAX_REGEX_LEN) return null;
  if (!isLinearTimeSafe(source)) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** 正则匹配 text/contentDesc。危险模式被安全策略拒绝时显式告警并返回空数组。 */
export function findByRegex(flat, pattern) {
  const regex = compileSafeRegex(pattern);
  if (!regex) {
    // 静默返回空数组会让用户分不清"正则被安全策略拒绝"与"确实没匹配到"——
    // 前者需要改写正则，后者需要换目标。必须显式告知。
    console.warn(`[warn] 正则被安全策略拒绝（可能含灾难性回溯形态，如分组被量词修饰或交替歧义）: ${pattern}`);
    return [];
  }
  return flat.filter((node) => (node.text && regex.test(node.text)) || (node.contentDesc && regex.test(node.contentDesc)));
}

/** resource-id 匹配（大小写不敏感）：全名相等或短名以 "/短名" 结尾。 */
export function findByResourceId(flat, idSpec) {
  const query = String(idSpec).toLowerCase();
  return flat.filter((node) => node.resourceId && (node.resourceId.toLowerCase() === query || node.resourceId.toLowerCase().endsWith(`/${query}`)));
}

/** 类名匹配（大小写不敏感全等）。 */
export function findByClass(flat, cls) {
  const query = String(cls).toLowerCase();
  return flat.filter((node) => node.cls.toLowerCase() === query);
}

/** 类名 + 下标选取：越界返回空数组（严格下标语义，不静默回退首个）。 */
export function findByClassIndex(flat, cls, index = 0) {
  const matches = findByClass(flat, cls);
  return matches[index] ? [matches[index]] : [];
}

// ─── clickable 兜底与 hint 校验 ────────────────────────────────────────────
/**
 * §5.4.2：clickable=false → 先向上找最近可点祖先，再向下找第一个可点子孙。
 * 返回 { node, resolved, unclickable? }：resolved=true 表示已改选其他节点；
 * unclickable=true 表示本身与祖先/子孙均不可点（保留原节点并告警）。
 */
export function resolveClickable(node) {
  if (node.clickable && node.enabled) return { node, resolved: false };
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.clickable && ancestor.enabled) return { node: ancestor, resolved: true };
  }
  const findClickableDescendant = (current) => {
    for (const child of current.children ?? []) {
      if (child.clickable && child.enabled) return child;
      const descendant = findClickableDescendant(child);
      if (descendant) return descendant;
    }
    return null;
  };
  const descendant = findClickableDescendant(node);
  if (descendant) return { node: descendant, resolved: true };
  return { node, resolved: false, unclickable: true };
}

/**
 * hint 校验（§5.0.5 R2）：节点存在且 identity 快照一致才复用。
 * identity 至少含一个非空识别字段；已记录的字段逐一比对，clickable 按布尔语义比对。
 */
export function sameIdentity(node, identity) {
  if (!node || !identity || typeof identity !== 'object') return false;
  if (!(identity.text || identity.resourceId || identity.contentDesc || identity.cls)) return false;
  for (const field of IDENTITY_FIELDS) {
    if (identity[field] != null && String(node[field] ?? '') !== String(identity[field])) return false;
  }
  if (identity.clickable != null && Boolean(node.clickable) !== Boolean(identity.clickable)) return false;
  return true;
}

/** 按 bounds 四元组全等查找节点（hint 坐标复用的第一步）。 */
export function nodeAtBounds(flat, bounds) {
  if (!Array.isArray(bounds) || bounds.length !== BOUNDS_LENGTH) return null;
  return flat.find((node) => node.bounds.every((value, position) => value === bounds[position])) ?? null;
}

// ─── 失败候选 ──────────────────────────────────────────────────────────────
/**
 * 失败时返回候选节点列表，让模型改写描述（§5.1 策略 5）。
 * 候选按与目标的相关度排序——原实现取 DFS 顺序的前 8 个，与目标往往无关，
 * 模型无法据此改写描述。相关度：目标文本与节点文本的公共字符数 + resourceId 互含加权。
 */
export function candidatesOf(flat, target = null, limit = DEFAULT_CANDIDATE_LIMIT) {
  const nodes = flat.filter((node) => node.text || node.contentDesc);
  const needle = String(target ?? '').trim();
  if (!needle) return nodes.slice(0, limit).map(candidateView);
  const relevanceScore = (node) => {
    const haystack = `${node.text ?? ''} ${node.contentDesc ?? ''}`;
    let score = 0;
    for (const char of new Set(needle)) if (haystack.includes(char)) score += 1;
    if (node.resourceId && needle && (node.resourceId.includes(needle) || needle.includes(node.resourceId))) score += RESOURCE_ID_SCORE_BONUS;
    return score;
  };
  return nodes
    .map((node) => ({ node, score: relevanceScore(node) }))
    .sort((first, second) => second.score - first.score)
    .slice(0, limit)
    .map((entry) => candidateView(entry.node));
}

/** 候选节点的对外视图：只暴露识别字段与 bounds，不带 parent/children 等内部结构。 */
function candidateView(node) {
  return { text: node.text, contentDesc: node.contentDesc, resourceId: node.resourceId, cls: node.cls, bounds: node.bounds };
}

/**
 * flat 级 selector 匹配（waitForElement 等轻量路径用）：返回 { node, value } 或 null。
 * within= 只有完整 locator 链支持（需 getSize/几何判定），此处返回 null，
 * 不能坠入 auto 分支拿 parsed.text=undefined 去搜字面量 "undefined"。
 */
export function matchSelector(flat, selector) {
  const trimmed = String(selector ?? '').trim();
  const indexMatch = /^index=(\d+)$/.exec(trimmed);
  if (indexMatch) {
    const node = flat[Number(indexMatch[1])];
    return node ? { node, value: node.text || node.contentDesc || '' } : null;
  }
  const parsed = parseTarget(trimmed);
  const toResult = (node) => (node ? { node, value: node.text || node.contentDesc || '' } : null);
  if (parsed.kind === 'within') return null;
  if (parsed.kind === 'exact_text') {
    const hits = findByExactText(flat, parsed.text);
    // 严格下标语义（与 locate() 一致）：显式 #index 越界就是未命中，不静默回退首个
    return toResult(hits[parsed.index] ?? null);
  }
  if (parsed.kind === 'class_index') {
    const hits = findByClass(flat, parsed.cls);
    return toResult(hits[parsed.index] ?? null);
  }
  if (parsed.kind === 'resource_id') {
    const node = findByResourceId(flat, parsed.id)[0];
    return node ? { node, value: node.resourceId } : null;
  }
  if (parsed.kind === 'contains') {
    const node = findByContains(flat, parsed.text, parsed.field)[0];
    return node ? { node, value: parsed.field === 'contentDesc' ? node.contentDesc : node.text } : null;
  }
  if (parsed.kind === 'regex') {
    const node = findByRegex(flat, parsed.pattern)[0];
    return node ? { node, value: node.text || node.contentDesc || '' } : null;
  }
  const node = findByExactText(flat, parsed.text)[0] ?? findByContains(flat, parsed.text)[0];
  return toResult(node);
}

// ─── locate 主链的子步骤 ───────────────────────────────────────────────────
/**
 * 获取 UI 树并扁平化。dump 失败时：
 * - 无 VLM：如实返回 TREE_UNAVAILABLE（上层据此跳过同样依赖 fresh dump 的 waitIdle，
 *   在 uia2 槽冲突下必超时空耗），并落盘诊断；
 * - 有 VLM：flat 置空继续走视觉兜底。hash 用错误文本派生唯一值，
 *   避免 VLM 缓存键恒定导致跨不同画面复用同一份坐标。
 * 返回 { tree, flat, treeError, failure }：failure 非空时调用方应直接返回它。
 */
async function acquireUiTree({ getTree, vlm, target, missDumpDir }) {
  let tree;
  let treeError = null;
  try {
    tree = await getTree();
  } catch (error) {
    treeError = `获取 UI 树失败: ${error?.message ?? error}`;
    if (!vlm) {
      await dumpMissTree(missDumpDir, { target, attempted: [], flat: [], reason: '树不可用(dump 失败)', treeError });
      return { tree: null, flat: [], treeError, failure: { code: 'TREE_UNAVAILABLE', error: treeError } };
    }
    tree = { nodes: [], hash: `tree-unavailable:${treeError}`, dumpMs: 0, fromCache: false };
  }
  return { tree, flat: flattenNodes(tree.nodes), treeError, failure: null };
}

/**
 * 获取屏幕尺寸。冷启动期 wm size 不可用（服务未就绪/超时）时应结构化返回，
 * 不能让异常逃出 locate（否则整个 run 会被判 error，见 VERIFICATION-REPORT §10）。
 * code 是给上层降级策略读的结构化原因（不进模型可见的 content），其余字段守 §1.1 形状。
 * 拿不到树 ≠ 拿不到 size（size-probe 有会话级缓存），VLM 换算依赖它，不能一起跳过。
 * 返回 { size, failure }：failure 非空时调用方应直接返回它。
 */
async function acquireScreenSize({ getSize, target, treeError, missDumpDir }) {
  try {
    return { size: await getSize(), failure: null };
  } catch (error) {
    const sizeError = `设备未就绪，获取屏幕尺寸失败: ${error?.message ?? error}`;
    const combinedError = treeError ? `${treeError}；且${sizeError}` : sizeError;
    await dumpMissTree(missDumpDir, { target, attempted: [], flat: [], reason: '树与尺寸均不可用', treeError: combinedError });
    return { size: null, failure: { code: 'SIZE_UNAVAILABLE', error: combinedError } };
  }
}

/**
 * hint 缓存匹配（§5.0.5 / §14.2.1）：bounds 命中且 identity 一致才复用。
 * 必须加 inScreen 检查：其余每条策略都过 inScreen（定位到屏幕外的节点会被
 * 判定为无效），唯独 hint 路径曾漏了——hint 来自持久化的 locate_cache（上一
 * 步或上一轮写入），节点滚出屏幕后 identity 仍匹配 → 返回屏幕外坐标，
 * 点击落在别处。VLM 路径同样检查 conv.inScreen。
 * 返回命中节点或 null（校验失败 → 弃用 hint，走正常链）。
 */
function extractHintMatch(flat, size, hintBounds, hintIdentity) {
  if (!hintBounds || !hintIdentity) return null;
  const node = nodeAtBounds(flat, hintBounds);
  if (node && sameIdentity(node, hintIdentity) && inScreen(node.bounds, size, flat)) return node;
  return null;
}

/**
 * within 作用域定位：scope 命中后，在与其垂直相交（同一行）的节点中匹配 inner。
 * 不用包含于 scope bounds：行文本节点的 bounds 只覆盖左侧文字，行右侧按钮不在其内；
 * 同一行判据为 y 区间相交。多命中取面积最小者。
 * 返回命中节点或 null。
 */
function resolveWithinScope(flat, parsed) {
  const scopeParsed = parseTarget(parsed.scope);
  const scopeNodes = findByKind(flat, scopeParsed);
  const scope = scopeNodes[0] ?? null;
  if (!scope || !Array.isArray(scope.bounds)) return null;
  const innerParsed = parseTarget(parsed.inner);
  const innerNodes = findByKind(flat, innerParsed).filter((node) => Array.isArray(node.bounds)
    && node !== scope
    && node.bounds[1] < scope.bounds[3] && node.bounds[3] > scope.bounds[1]);
  return innerNodes.sort((first, second) => area(first.bounds) - area(second.bounds))[0] ?? null;
}

/**
 * 从候选节点中选出最终命中：先过 inScreen 过滤，再按「零面积排最后 + 面积最小优先」排序。
 * WebView 零面积节点放行后排最后（area=0），防止「最小面积优先」误选几何未知的节点。
 */
function pickVisibleSmallest(nodes, size, flat) {
  return nodes.filter((node) => inScreen(node.bounds, size, flat)).sort((first, second) => {
    const firstZero = isZeroAreaBounds(first) ? 1 : 0;
    const secondZero = isZeroAreaBounds(second) ? 1 : 0;
    if (firstZero !== secondZero) return firstZero - secondZero; // 零面积排最后
    return area(first.bounds) - area(second.bounds);
  })[0] ?? null;
}

/**
 * 策略链执行（§5.1）：按 parsed.kind 依次尝试各查找策略，首个命中即停。
 * - exact_text 带显式 #index 时严格下标选取（越界即未命中，不静默回退首个）；
 * - within 形态由 resolveWithinScope 单独处理，未命中不坠 auto 链
 *   （parsed.text 是 undefined，会去搜字面量 "undefined" 误配）；
 * - attempted 记录已尝试的策略序列（失败时告知模型，便于它改写描述）。
 * 返回 { matched, strategy, attempted }。
 */
function runStrategyChain(flat, parsed, size) {
  const attempted = [];
  let matched = null;
  let strategy = 'none';
  const tryStrategy = (nodes, name) => {
    attempted.push(name);
    if (matched || !nodes?.length) return;
    matched = pickVisibleSmallest(nodes, size, flat);
    if (matched) strategy = name;
  };

  if (parsed.kind === 'exact_text') {
    const hits = findByExactText(flat, parsed.text);
    if (parsed.index) {
      const indexed = hits[parsed.index];
      matched = indexed && inScreen(indexed.bounds, size, flat) ? indexed : null;
    } else {
      tryStrategy(hits, 'exact_text');
    }
    if (!matched) tryStrategy(findByContains(flat, parsed.text), 'regex');
    if (!matched) tryStrategy(findByRegex(flat, parsed.text), 'regex');
    if (!matched) tryStrategy(findByResourceId(flat, parsed.text), 'resource_id');
    if (!matched && ANDROID_CLASS_NAME_PATTERN.test(parsed.text)) tryStrategy(findByClassIndex(flat, parsed.text, 0), 'class_index');
  } else if (parsed.kind === 'contains') {
    tryStrategy(findByContains(flat, parsed.text, parsed.field), 'regex');
  } else if (parsed.kind === 'regex') {
    tryStrategy(findByRegex(flat, parsed.pattern), 'regex');
  } else if (parsed.kind === 'resource_id') {
    tryStrategy(findByResourceId(flat, parsed.id), 'resource_id');
  } else if (parsed.kind === 'class_index') {
    tryStrategy(findByClassIndex(flat, parsed.cls, parsed.index), 'class_index');
  } else if (parsed.kind !== 'within') {
    // auto：精确 → 包含 → resource-id →（形如类名时）class+index
    const text = parsed.text;
    tryStrategy(findByExactText(flat, text), 'exact_text');
    if (!matched) tryStrategy(findByContains(flat, text), 'regex');
    if (!matched) tryStrategy(findByResourceId(flat, text), 'resource_id');
    if (!matched && ANDROID_CLASS_NAME_PATTERN.test(text)) tryStrategy(findByClassIndex(flat, text, 0), 'class_index');
  }
  return { matched, strategy, attempted };
}

/**
 * 命中节点 → 成功结果：clickable 兜底（§5.4.2）+ 警告文案 + WebView 标记。
 * WebView 零面积节点放行后 bounds/center 不可信，标记 inWebView 供下游走 VLM 坐标兜底。
 */
function buildHitResult(result, matched, strategy, flat) {
  const { node: hit, resolved, unclickable } = resolveClickable(matched);
  const warning = unclickable
    ? '目标本身不可点，且无可点祖先/子孙'
    : resolved
      ? '目标不可点，已解析到最近可点节点'
      : null;
  const hitInWebView = isZeroAreaBounds(hit) && hasWebViewContainer(flat);
  return {
    ...result,
    ok: true,
    bounds: hit.bounds,
    center: hit.center,
    strategy,
    identity: nodeIdentity(hit),
    ...(hitInWebView ? { inWebView: true } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * VLM 视觉兜底（§5.0.3.2）：截图 → 模型看图 → family 坐标换算 → 在屏校验。
 * 结果按 树hash+target 缓存；缓存失效完全依赖 tree.hash 随画面变化。
 * 树不可用时 hash 是「错误文本」派生的稳定值，不随画面变——若照常缓存，
 * 槽冲突期间同 target 会跨画面命中陈旧坐标点错位置。
 * 故树不可用路径跳过 vlmCache 读写：每次重新看图（多付 VLM 往返，换点击正确）。
 * 早退统一带结构化 code：树不可用时不能让上层再走同样依赖 fresh dump 的 waitIdle。
 */
async function runVlmFallback({ vlm, screencap, vlmCache, probeFile, missDumpDir, target, tree, treeError, flat, size, attempted, result }) {
  const cacheable = !treeError;
  const cacheKey = `${tree.hash}::${target}`;
  const cached = cacheable ? vlmCache.get(cacheKey) : undefined;
  if (cached) {
    return { ...result, ok: true, bounds: cached.bounds, center: cached.center, strategy: 'vlm', vlmCacheHit: true, identity: cached.identity };
  }
  const vlmFail = async (message) => {
    const code = treeError ? 'TREE_UNAVAILABLE' : 'VLM_FAILED';
    await dumpMissTree(missDumpDir, { target, attempted, flat, reason: `视觉定位失败: ${message}`, tree, size, treeError });
    return { ...result, code, error: message };
  };
  let png;
  try {
    png = await screencap();
  } catch (error) {
    return vlmFail(`截图失败: ${error?.message ?? error}`);
  }
  let raw = null;
  let family = null;
  try {
    const output = await vlm({ png, size, target: String(target), instruction: '' });
    raw = output?.raw ?? output;
    family = output?.family ?? null;
  } catch (error) {
    return vlmFail(`VLM 定位失败: ${error?.message ?? error}`);
  }
  family = family ?? loadProbeFamily(probeFile);
  const coordStrategy = family ? resolveStrategy(family) : null;
  if (!coordStrategy) {
    return vlmFail('无法确定坐标策略：请设置 ASK_MODEL_FAMILY 或运行 ask doctor --probe-family');
  }
  const converted = coordStrategy.toPixels(raw, size);
  if (!converted.bounds && !converted.center) {
    return vlmFail(`VLM 返回无法解析: ${JSON.stringify(raw)?.slice(0, VLM_RAW_ERROR_SNIPPET_LEN)}`);
  }
  if (!converted.inScreen) {
    // 越界告警：多为 family 坐标约定用错（§5.5.1），降级失败
    return vlmFail(`VLM 坐标越界(${JSON.stringify(converted.bounds ?? converted.center)})，请检查 model family 坐标约定`);
  }
  const identity = { text: '', contentDesc: String(target), resourceId: '', cls: '', clickable: null };
  if (cacheable) vlmCache.set(cacheKey, { bounds: converted.bounds, center: converted.center, identity });
  return { ...result, ok: true, bounds: converted.bounds, center: converted.center, strategy: 'vlm', identity };
}

/**
 * MISS 失败结果：可操作的错误信息 + 相关度候选 + 诊断落盘。
 * 失败信息必须可操作：模型据此改写描述。原实现只给"未找到目标"——
 * 既没说搜的是什么，也没说试过哪些策略，candidates 还是 DFS 顺序的前 8 个
 * （与目标无关的节点），模型无法据此调整。
 * 诊断：区分「树里压根没有目标」与「目标存在但零面积/不在屏被 inScreen 丢弃」——
 * 后者在 uni-app WebView 壳里常见（可见元素报 [0,0][0,0]），落盘当次 flat 供排查。
 * rawHits 必须与定位主链同源：用 findByKind(flat, parsed) 取未经 inScreen 过滤的原始
 * 命中，不能拿带前缀的原始 target 串去搜（within/re:/id=/class= 等形态 parsed.text
 * 为 undefined，会恒空并把真实的几何过滤误标成「无匹配节点」）。
 */
async function buildMissResult({ result, target, parsed, flat, size, tree, treeError, attempted, missDumpDir }) {
  const rawHits = rawHitsForReason(flat, parsed);
  const reason = treeError
    ? '树不可用(dump 失败)'
    : parsed.kind === 'within'
      ? (rawHits.length ? 'within 作用域内命中但目标不可解析' : 'within 作用域未命中')
      : (rawHits.length && !rawHits.some((node) => inScreen(node.bounds, size, flat)) ? 'inScreen 过滤' : '无匹配节点');
  await dumpMissTree(missDumpDir, { target, attempted, flat, reason, tree, size, treeError });
  return {
    ...result,
    ...(treeError ? { code: 'TREE_UNAVAILABLE' } : {}),
    error: treeError
      ? `${treeError}；且视觉定位未命中 "${target}"`
      : `未找到目标 "${target}"：已尝试策略 ${attempted.join('→')}，未命中`,
    candidates: candidatesOf(flat, target),
  };
}

// ─── locator 工厂（主编排） ────────────────────────────────────────────────
/**
 * 创建 locate 函数。deps：getTree（门面 dumpTree）、getSize、screencap、vlmCache、
 * probeFile（.ask/family-probe.json）、missDumpDir（LOCATE_MISS 时把当次 flat 树落盘供排查；不注入则不落盘）。
 * 主函数只做编排：取树/尺寸 → hint 缓存 → within/策略链 → 命中构建 → VLM 兜底 → MISS 诊断。
 */
export function createLocator({ getTree, getSize, screencap, vlmCache = new Map(), probeFile = probeCachePath(), missDumpDir = null }) {
  return async function locate(target, { vlm = null, hintBounds = null, hintIdentity = null } = {}) {
    const base = { ok: false, bounds: null, center: null, strategy: 'none', treeCacheHit: false, vlmCacheHit: false, dumpMs: 0, identity: null, error: null, code: null };
    if (!target || !String(target).trim()) return { ...base, code: 'EMPTY_TARGET', error: 'target 为空' };

    const treeOutcome = await acquireUiTree({ getTree, vlm, target, missDumpDir });
    if (treeOutcome.failure) return { ...base, ...treeOutcome.failure };
    const { tree, flat, treeError } = treeOutcome;

    const sizeOutcome = await acquireScreenSize({ getSize, target, treeError, missDumpDir });
    if (sizeOutcome.failure) return { ...base, ...sizeOutcome.failure };
    const { size } = sizeOutcome;

    const result = { ...base, treeCacheHit: Boolean(tree.fromCache), dumpMs: tree.dumpMs ?? 0 };

    // ① hint：bounds 命中且 identity 一致才复用（§5.0.5 / §14.2.1）
    const hintNode = extractHintMatch(flat, size, hintBounds, hintIdentity);
    if (hintNode) {
      return { ...result, ok: true, bounds: hintNode.bounds, center: hintNode.center, strategy: 'cache', identity: nodeIdentity(hintNode) };
    }

    const parsed = parseTarget(target);
    // within 行内作用域先行；其余形态走策略链（within 未命中不坠 auto 链）
    let matched = parsed.kind === 'within' ? resolveWithinScope(flat, parsed) : null;
    let strategy = matched ? 'within' : 'none';
    const chain = runStrategyChain(flat, parsed, size);
    const attempted = chain.attempted;
    if (!matched && chain.matched) {
      matched = chain.matched;
      strategy = chain.strategy;
    }

    if (matched) return buildHitResult(result, matched, strategy, flat);

    // ② VLM 兜底：只在 vlm 注入函数存在时启用
    if (vlm) {
      return runVlmFallback({ vlm, screencap, vlmCache, probeFile, missDumpDir, target, tree, treeError, flat, size, attempted, result });
    }

    return buildMissResult({ result, target, parsed, flat, size, tree, treeError, attempted, missDumpDir });
  };
}