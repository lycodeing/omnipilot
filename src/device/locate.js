// 定位策略链（§5.1）：精确文本 → 正则/包含 → resource-id → class+index → VLM（注入函数）
// clickable=false 兜底（§5.4.2）；hint 跨执行坐标缓存校验（§5.0.5 R2）；文本匹配不缓存（§5.0.2.1）
import { flattenNodes, nodeIdentity, isZeroAreaBounds, hasWebViewContainer } from './uitree.js';
import { resolveStrategy } from './coord/registry.js';
import { loadProbeFamily, probeCachePath } from './coord/probe.js';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

// 单个 case 的诊断快照上限：避免连续 MISS 无限堆积。目录按 case 隔离（bin/ask.js runOne），
// 并发 run 各自独立计数；同 case 内串行定位，readdir 计数竞态风险极低。
const MISS_DUMP_MAX_FILES = 20;

// LOCATE_MISS 诊断：把当次 flat 树落盘，供区分「树不可用 / 树里没有目标 / 目标零面积被过滤」。
// 失败路径专用，成功路径零开销；无 missDumpDir（如单测未注入）时不落盘。
// 异步 + 临时文件 rename 原子写：busy 态下不阻塞事件循环，进程被 kill 也不会留半截 JSON。
// 密码框文本掩码：诊断快照不得把凭据明文写进 run 目录（与截图遮罩同一约束）。
async function dumpMissTree(dir, { target, attempted, flat = [], reason, tree = null, size = null, treeError = null }) {
  if (!dir) return;
  try {
    await fsp.mkdir(dir, { recursive: true });
    const existing = (await fsp.readdir(dir)).filter((f) => f.startsWith('locate-miss-') && f.endsWith('.json'));
    if (existing.length >= MISS_DUMP_MAX_FILES) return; // 达上限静默跳过，不影响定位
    const t = tree ?? {};
    const snap = {
      target,
      attempted,
      reason,
      at: new Date().toISOString(),
      pid: process.pid,
      treeFromCache: Boolean(t.fromCache),
      treeCachedAt: t.cachedAt ?? null,
      dumpMs: t.dumpMs ?? null,
      treeUnavailable: Boolean(treeError),
      treeError: treeError ?? null,
      screenSize: size ? { w: size.w, h: size.h } : null,
      nodes: (flat ?? []).map((n) => {
        const pwd = Boolean(n.password);
        return {
          index: n.index,
          text: pwd ? '[REDACTED]' : (n.text ?? ''),
          contentDesc: pwd ? '[REDACTED]' : (n.contentDesc ?? ''),
          resourceId: n.resourceId ?? '', cls: n.cls ?? '', clickable: n.clickable ?? null,
          password: pwd, bounds: n.bounds ?? null,
        };
      }),
    };
    const final = join(dir, `locate-miss-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    const tmp = `${final}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(snap, null, 2));
    await fsp.rename(tmp, final);
  } catch { /* 诊断落盘失败不影响定位结果 */ }
}

/**
 * 判断 bounds 是否在屏幕内且面积有效。
 * @param {number[]} bounds - [left, top, right, bottom]
 * @param {{w:number, h:number}} size - 屏幕尺寸
 * @param {object[]} [flatNodes] - 可选：扁平节点列表，用于 WebView 零面积放行判定。
 *   传入时，零面积 + WebView 壳 → 返回 true（几何未知，非隐藏）；
 *   不传时保持原严格行为（向后兼容）。
 */
export function inScreen(bounds, size, flatNodes) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return false;
  const [left, top, right, bottom] = bounds;
  const isZeroArea = right <= left || bottom <= top;
  // WebView 壳内零面积 = 渲染器特性（几何未知），不是隐藏节点 → 放行
  if (isZeroArea && flatNodes && hasWebViewContainer(flatNodes)) return true;
  // 非零面积才做严格的四边在屏 + 面积检查
  return left >= 0 && top >= 0 && right <= size.w && bottom <= size.h && !isZeroArea;
}

function area([l, t, r, b]) {
  return Math.max(0, r - l) * Math.max(0, b - t);
}

// 'text=xx' | 'id=xx' | 'resource-id=xx' | 'class=C#index=N' | 'type=C' | 'desc=xx' | 're:pattern' | 自动
// 'within=<scopeSel>::<targetSel>'：行内作用域定位——先找 scope 节点，再在其 bounds 内匹配 target。
// 用于点某一行右侧按钮这类需求（列表行序与 #index 不一致时 index 定位会点错行）。
export function parseTarget(target) {
  const t = String(target ?? '').trim();
  let m;
  if ((m = /^within=(.+?)::(.+)$/s.exec(t))) {
    return { kind: 'within', scope: m[1], inner: m[2] };
  }
  if ((m = /^(?:resource-id|id)=(.+?)(?:#index=(\d+))?$/i.exec(t))) {
    return { kind: 'resource_id', id: m[1], index: m[2] ? Number(m[2]) : 0 };
  }
  if ((m = /^(?:class|type)=(.+?)(?:#index=(\d+))?$/i.exec(t))) {
    return { kind: 'class_index', cls: m[1], index: m[2] ? Number(m[2]) : 0 };
  }
  if ((m = /^text=(.+?)(?:#index=(\d+))?$/i.exec(t))) {
    return { kind: 'exact_text', text: m[1], index: m[2] ? Number(m[2]) : 0 };
  }
  // text*= 前缀匹配（包含）。matchNodeSelector 与工具层文档（ai_wait_for 的 selector 说明）
  // 都承诺支持 text*= —— waitForElement 等走 parseTarget 的路径必须同一套语法。
  if ((m = /^text\*=(.+?)(?:#index=(\d+))?$/i.exec(t))) {
    return { kind: 'contains', text: m[1], field: null };
  }
  if ((m = /^desc=(.+)$/i.exec(t))) return { kind: 'contains', text: m[1], field: 'contentDesc' };
  if ((m = /^re:(.+)$/s.exec(t))) return { kind: 'regex', pattern: m[1] };
  return { kind: 'auto', text: t };
}

// 按 parseTarget 结果取候选节点（within 作用域定位复用）
function findByKind(flat, parsed) {
  if (parsed.kind === 'exact_text') return findByExactText(flat, parsed.text);
  if (parsed.kind === 'contains') return findByContains(flat, parsed.text, parsed.field);
  if (parsed.kind === 'regex') return findByRegex(flat, parsed.pattern);
  if (parsed.kind === 'resource_id') return findByResourceId(flat, parsed.id);
  if (parsed.kind === 'class_index') return findByClass(flat, parsed.cls);
  return findByExactText(flat, parsed.text).concat(findByContains(flat, parsed.text));
}

// 诊断用：取「未经 inScreen 过滤」的原始命中，与 locate 主链同源（findByKind）。
// 仅用于判断失败原因，不参与定位结果。within 形态按主链的 scope/inner 两段还原。
function rawHitsForReason(flat, parsed) {
  if (parsed.kind === 'within') {
    const scope = findByKind(flat, parseTarget(parsed.scope))[0] ?? null;
    if (!scope || !Array.isArray(scope.bounds)) return [];
    return findByKind(flat, parseTarget(parsed.inner)).filter((n) => Array.isArray(n.bounds)
      && n !== scope
      && n.bounds[1] < scope.bounds[3] && n.bounds[3] > scope.bounds[1]);
  }
  return findByKind(flat, parsed);
}

// 节点级 selector 匹配（tools/perception.js 的 matchSelector 同源逻辑，设备层自用）：
// 'text=' 精确 | 'text*=' 包含 | 'resourceId='/'id=' | 'class=#index=' | 're:' 正则
export function matchNodeSelector(node, sel) {
  const s = String(sel ?? '').trim();
  if (s.startsWith('text*=')) return String(node.text || '').includes(s.slice(6));
  if (s.startsWith('text=')) return node.text === s.slice(5) || node.contentDesc === s.slice(5);
  if (s.startsWith('resourceId=')) return node.resourceId === s.slice(11);
  if (s.startsWith('id=')) return node.resourceId === s.slice(3);
  if (s.startsWith('class=')) {
    const [cls, idxPart] = s.slice(6).split('#index=');
    if (node.cls !== cls) return false;
    if (idxPart !== undefined) return Number(node.index) === Number(idxPart);
    return true;
  }
  if (s.startsWith('re:')) {
    const re = compileSafeRegex(s.slice(3));   // 嵌套量词等危险模式会被拒绝（ReDoS 防护）
    if (!re) return false;
    return re.test(String(node.text || '')) || re.test(String(node.contentDesc || ''));
  }
  return false;
}
export function findByExactText(flat, text) {
  return flat.filter((n) => n.text === text || n.contentDesc === text);
}

export function findByContains(flat, text, field = null) {
  const q = String(text).toLowerCase();
  return flat.filter((n) => {
    const inText = n.text && n.text.toLowerCase().includes(q);
    const inDesc = n.contentDesc && n.contentDesc.toLowerCase().includes(q);
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
const MAX_REGEX_LEN = 200;

// 扫描 src，判断是否含回溯风险构造。返回 true = 安全。
function isLinearTimeSafe(src) {
  const stack = [];      // 分组栈：每项记录该组内是否出现过量词/交替
  let i = 0;
  let prevWasQuantifier = false;   // 上一个 token 是量词（用于检测嵌套量词）
  let prevWasGroup = false;        // 上一个 token 是 ')'（用于检测"组被量词修饰"）
  while (i < src.length) {
    const c = src[i];
    // 转义序列：跳过被转义的字符（\w \d \. \( 等）
    if (c === '\\') {
      if (i + 1 >= src.length) return false;      // 尾部孤立反斜杠
      const n = src[i + 1];
      if (n >= '1' && n <= '9') return false;      // 反向引用 → 复杂回溯
      i += 2;
      prevWasQuantifier = false;
      prevWasGroup = false;
      continue;
    }
    // 字符类 [...]：内部内容全部跳过（类内的 ] 与量词无回溯意义）
    if (c === '[') {
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;      // 类首的 ] 是字面量
      while (j < src.length && src[j] !== ']') j++;
      if (j >= src.length) return false;   // 未闭合的类
      i = j + 1;
      prevWasQuantifier = false;
      prevWasGroup = false;
      continue;
    }
    // 分组开始
    if (c === '(') {
      // 前瞻/后顾/命名组 → 拒绝
      let skip = 1;
      if (src[i + 1] === '?') {
        const k = src[i + 2];
        if (k === '=' || k === '!' || k === '<') return false;
        if (k === ':') skip = 3;      // (?: 前缀 —— '?' 不是量词，整段跳过
      }
      stack.push({ hasQuantifier: false, hasAlternation: false });
      i += skip;
      prevWasQuantifier = false;
      prevWasGroup = false;
      continue;
    }
    // 分组结束
    if (c === ')') {
      const grp = stack.pop();
      if (!grp) return false;                      // 括号不配对
      prevWasQuantifier = false;
      prevWasGroup = true;                        // ')' 是分组结束 → 下个量词会修饰组
      if (grp.hasAlternation) return false;       // 组内交替且组可被重复 → 歧义回溯
      continue;
    }
    // 交替
    if (c === '|') {
      const grp = stack[stack.length - 1];
      if (grp) grp.hasAlternation = true;
      i += 1;
      prevWasQuantifier = false;
      prevWasGroup = false;
      continue;
    }
    // 量词
    let qLen = 0;
    if (c === '*' || c === '+' || c === '?') qLen = 1;
    else if (c === '{') {
      const close = src.indexOf('}', i);
      if (close === -1) return false;              // 未闭合的 {
      if (!/^\{\d*(,\d*)?\}$/.test(src.slice(i, close + 1))) {
        i = close + 1;                            // {literal} 不是量词
        prevWasQuantifier = false;
        prevWasGroup = false;
        continue;
      }
      qLen = close - i + 1;
    }
    if (qLen) {
      if (prevWasQuantifier) return false;        // 嵌套量词
      if (prevWasGroup) return false;             // 量词修饰分组 → 指数回溯
      const grp = stack[stack.length - 1];
      if (grp) grp.hasQuantifier = true;
      i += qLen;
      prevWasQuantifier = true;
      prevWasGroup = false;
      continue;
    }
    // 普通字面字符
    i += 1;
    prevWasQuantifier = false;
    prevWasGroup = false;
  }
  if (stack.length) return false;                // 括号未闭合
  return true;
}

export function compileSafeRegex(pattern, flags = 'i') {
  const src = String(pattern ?? '');
  if (!src || src.length > MAX_REGEX_LEN) return null;
  if (!isLinearTimeSafe(src)) return null;
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

export function findByRegex(flat, pattern) {
  const re = compileSafeRegex(pattern);
  if (!re) {
    // 静默返回空数组会让用户分不清"正则被安全策略拒绝"与"确实没匹配到"——
    // 前者需要改写正则，后者需要换目标。必须显式告知。
    console.warn(`[warn] 正则被安全策略拒绝（可能含灾难性回溯形态，如分组被量词修饰或交替歧义）: ${pattern}`);
    return [];
  }
  return flat.filter((n) => (n.text && re.test(n.text)) || (n.contentDesc && re.test(n.contentDesc)));
}

export function findByResourceId(flat, idSpec) {
  const q = String(idSpec).toLowerCase();
  return flat.filter((n) => n.resourceId && (n.resourceId.toLowerCase() === q || n.resourceId.toLowerCase().endsWith(`/${q}`)));
}

export function findByClass(flat, cls) {
  const q = String(cls).toLowerCase();
  return flat.filter((n) => n.cls.toLowerCase() === q);
}

export function findByClassIndex(flat, cls, index = 0) {
  const matches = findByClass(flat, cls);
  return matches[index] ? [matches[index]] : [];
}

// §5.4.2：clickable=false → 先向上找最近可点祖先，再向下找第一个可点子孙
export function resolveClickable(node) {
  if (node.clickable && node.enabled) return { node, resolved: false };
  for (let p = node.parent; p; p = p.parent) {
    if (p.clickable && p.enabled) return { node: p, resolved: true };
  }
  const findDesc = (n) => {
    for (const c of n.children ?? []) {
      if (c.clickable && c.enabled) return c;
      const d = findDesc(c);
      if (d) return d;
    }
    return null;
  };
  const d = findDesc(node);
  if (d) return { node: d, resolved: true };
  return { node, resolved: false, unclickable: true };
}

// hint 校验（§5.0.5 R2）：节点存在且 identity 快照一致才复用
export function sameIdentity(node, identity) {
  if (!node || !identity || typeof identity !== 'object') return false;
  if (!(identity.text || identity.resourceId || identity.contentDesc || identity.cls)) return false;
  for (const k of ['text', 'contentDesc', 'resourceId', 'cls']) {
    if (identity[k] != null && String(node[k] ?? '') !== String(identity[k])) return false;
  }
  if (identity.clickable != null && Boolean(node.clickable) !== Boolean(identity.clickable)) return false;
  return true;
}

export function nodeAtBounds(flat, bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  return flat.find((n) => n.bounds.every((v, i) => v === bounds[i])) ?? null;
}

// 失败时返回候选节点列表，让模型改写描述（§5.1 策略 5）
// 候选节点（失败时给模型参考）。按与目标的相关度排序——原实现取 DFS 顺序的前 8 个，
// 与目标往往无关，模型无法据此改写描述。相关度：目标文本与节点文本的公共字符数。
export function candidatesOf(flat, target = null, limit = 8) {
  const nodes = flat.filter((n) => n.text || n.contentDesc);
  const needle = String(target ?? '').trim();
  if (!needle) return nodes.slice(0, limit).map(candidateView);
  const score = (n) => {
    const hay = `${n.text ?? ''} ${n.contentDesc ?? ''}`;
    let s = 0;
    for (const ch of new Set(needle)) if (hay.includes(ch)) s += 1;
    if (n.resourceId && needle && (n.resourceId.includes(needle) || needle.includes(n.resourceId))) s += 3;
    return s;
  };
  return nodes
    .map((n) => ({ n, s: score(n) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => candidateView(x.n));
}

function candidateView(n) {
  return { text: n.text, contentDesc: n.contentDesc, resourceId: n.resourceId, cls: n.cls, bounds: n.bounds };
}

export function matchSelector(flat, selector) {
  const s = String(selector ?? '').trim();
  const pos = /^index=(\d+)$/.exec(s);
  if (pos) {
    const n = flat[Number(pos[1])];
    return n ? { node: n, value: n.text || n.contentDesc || '' } : null;
  }
  const parsed = parseTarget(s);
  const value = (n) => (n ? { node: n, value: n.text || n.contentDesc || '' } : null);
  // within= 只有完整 locator 链支持（需 getSize/几何判定）；flat 级匹配不支持时返回 null，
  // 不能坠入 auto 分支拿 parsed.text=undefined 去搜字面量 "undefined"
  if (parsed.kind === 'within') return null;
  if (parsed.kind === 'exact_text') {
    const hits = findByExactText(flat, parsed.text);
    // 严格下标语义（与 locate() 一致）：显式 #index 越界就是未命中，不静默回退首个
    return value(hits[parsed.index] ?? null);
  }
  if (parsed.kind === 'class_index') {
    const hits = findByClass(flat, parsed.cls);
    return value(hits[parsed.index] ?? null);
  }
  if (parsed.kind === 'resource_id') {
    const n = findByResourceId(flat, parsed.id)[0];
    return n ? { node: n, value: n.resourceId } : null;
  }
  if (parsed.kind === 'contains') {
    const n = findByContains(flat, parsed.text, parsed.field)[0];
    return n ? { node: n, value: parsed.field === 'contentDesc' ? n.contentDesc : n.text } : null;
  }
  if (parsed.kind === 'regex') {
    const n = findByRegex(flat, parsed.pattern)[0];
    return n ? { node: n, value: n.text || n.contentDesc || '' } : null;
  }
  const n = findByExactText(flat, parsed.text)[0] ?? findByContains(flat, parsed.text)[0];
  return value(n);
}

// deps：getTree（门面 dumpTree）、getSize、screencap、vlmCache、probeFile（.ask/family-probe.json）、
// missDumpDir（LOCATE_MISS 时把当次 flat 树落盘供排查；不注入则不落盘）
export function createLocator({ getTree, getSize, screencap, vlmCache = new Map(), probeFile = probeCachePath(), missDumpDir = null }) {
  return async function locate(target, { vlm = null, hintBounds = null, hintIdentity = null } = {}) {
    const base = { ok: false, bounds: null, center: null, strategy: 'none', treeCacheHit: false, vlmCacheHit: false, dumpMs: 0, identity: null, error: null, code: null };
    if (!target || !String(target).trim()) return { ...base, code: 'EMPTY_TARGET', error: 'target 为空' };

    let tree;
    let treeError = null;
    try {
      tree = await getTree();
    } catch (e) {
      treeError = `获取 UI 树失败: ${e?.message ?? e}`;
      if (!vlm) {
        // 无 VLM 时如实表达「树不可用」，不伪装成「页面里没有目标」——上层据此跳过
        // 同样依赖 fresh dump 的 waitIdle（在 uia2 槽冲突下必超时空耗）。
        await dumpMissTree(missDumpDir, { target, attempted: [], flat: [], reason: '树不可用(dump 失败)', treeError });
        return { ...base, code: 'TREE_UNAVAILABLE', error: treeError };
      }
      // 有 VLM：树不可用不应直接判死——flat 置空继续走到 VLM 分支（截图→坐标）。
      // hash 用错误文本派生唯一值，避免 VLM 缓存键恒定导致跨不同画面复用同一份坐标。
      tree = { nodes: [], hash: `tree-unavailable:${treeError}`, dumpMs: 0, fromCache: false };
    }
    const flat = flattenNodes(tree.nodes);
    // getSize 必须在 try 内：冷启动期 wm size 不可用（服务未就绪/超时）时应结构化返回，
    // 不能让异常逃出 locate（否则整个 run 会被判 error，见 VERIFICATION-REPORT §10）。
    // code 是给上层降级策略读的结构化原因（不进模型可见的 content），其余字段守 §1.1 形状。
    // 拿不到树 ≠ 拿不到 size（size-probe 有会话级缓存），VLM 换算依赖它，不能一起跳过。
    let size;
    try {
      size = await getSize();
    } catch (e) {
      const sizeErr = `设备未就绪，获取屏幕尺寸失败: ${e?.message ?? e}`;
      const error = treeError ? `${treeError}；且${sizeErr}` : sizeErr;
      await dumpMissTree(missDumpDir, { target, attempted: [], flat: [], reason: '树与尺寸均不可用', treeError: error });
      return { ...base, code: 'SIZE_UNAVAILABLE', error };
    }
    const result = { ...base, treeCacheHit: Boolean(tree.fromCache), dumpMs: tree.dumpMs ?? 0 };

    // ① hint：bounds 命中且 identity 一致才复用（§5.0.5 / §14.2.1）
    if (hintBounds && hintIdentity) {
      const node = nodeAtBounds(flat, hintBounds);
      // 必须加 inScreen 检查：其余每条策略都过 inScreen（定位到屏幕外的节点会被
      // 判定为无效），唯独 hint 路径漏了——hint 来自持久化的 locate_cache（上一
      // 步或上一轮写入），节点滚出屏幕后 identity 仍匹配 → 返回屏幕外坐标，
      // 点击落在别处。VLM 路径同样检查 conv.inScreen。
      if (node && sameIdentity(node, hintIdentity) && inScreen(node.bounds, size, flat)) {
        return { ...result, ok: true, bounds: node.bounds, center: node.center, strategy: 'cache', identity: nodeIdentity(node) };
      }
      // 校验失败 → 弃用 hint，走正常链
    }

    const parsed = parseTarget(target);
    let matched = null;
    let strategy = 'none';
    if (parsed.kind === 'within') {
      // 行内作用域：scope 命中后，在与其垂直相交（同一行）的节点中匹配 inner。不用包含于 scope bounds：行文本节点的 bounds 只覆盖左侧文字，行右侧按钮不在其内；同一行判据为 y 区间相交。
      const scopeParsed = parseTarget(parsed.scope);
      const scopeNodes = findByKind(flat, scopeParsed);
      const scope = scopeNodes[0] ?? null;
      if (scope && Array.isArray(scope.bounds)) {
        const innerParsed = parseTarget(parsed.inner);
        const innerNodes = findByKind(flat, innerParsed).filter((n) => Array.isArray(n.bounds)
          && n !== scope
          && n.bounds[1] < scope.bounds[3] && n.bounds[3] > scope.bounds[1]);
        matched = innerNodes.sort((a, b) => area(a.bounds) - area(b.bounds))[0] ?? null;
        if (matched) strategy = 'within';
      }
    }
    // 已尝试的策略序列（失败时告知模型，便于它改写描述）
    const attempted = [];
    const tryStrategy = (nodes, name) => {
      attempted.push(name);
      if (matched || !nodes?.length) return;
      // WebView 零面积节点放行后排最后（area=0），防止「最小面积优先」误选几何未知的节点
      matched = nodes.filter((n) => inScreen(n.bounds, size, flat)).sort((a, b) => {
        const aZero = isZeroAreaBounds(a) ? 1 : 0;
        const bZero = isZeroAreaBounds(b) ? 1 : 0;
        if (aZero !== bZero) return aZero - bZero; // 零面积排最后
        return area(a.bounds) - area(b.bounds);
      })[0] ?? null;
      if (matched) strategy = name;
    };

    if (parsed.kind === 'exact_text') {
      const hits = findByExactText(flat, parsed.text);
      if (parsed.index) matched = hits[parsed.index] && inScreen(hits[parsed.index].bounds, size, flat) ? hits[parsed.index] : null;
      else tryStrategy(hits, 'exact_text');
      if (!matched) tryStrategy(findByContains(flat, parsed.text), 'regex');
      if (!matched) tryStrategy(findByRegex(flat, parsed.text), 'regex');
      if (!matched) tryStrategy(findByResourceId(flat, parsed.text), 'resource_id');
      if (!matched && /^android\./i.test(parsed.text)) tryStrategy(findByClassIndex(flat, parsed.text, 0), 'class_index');
    } else if (parsed.kind === 'contains') {
      tryStrategy(findByContains(flat, parsed.text, parsed.field), 'regex');
    } else if (parsed.kind === 'regex') {
      tryStrategy(findByRegex(flat, parsed.pattern), 'regex');
    } else if (parsed.kind === 'resource_id') {
      tryStrategy(findByResourceId(flat, parsed.id), 'resource_id');
    } else if (parsed.kind === 'class_index') {
      tryStrategy(findByClassIndex(flat, parsed.cls, parsed.index), 'class_index');
    } else if (parsed.kind !== 'within') {
      // within= 未命中时不坠 auto 链：parsed.text 是 undefined，会去搜字面量 "undefined" 误配
      // （ scope/inner 命中情况在 matched=null 时由上层 not-found 路径返回）
      const t = parsed.text;
      tryStrategy(findByExactText(flat, t), 'exact_text');
      if (!matched) tryStrategy(findByContains(flat, t), 'regex');
      if (!matched) tryStrategy(findByResourceId(flat, t), 'resource_id');
      if (!matched && /^android\./i.test(t)) tryStrategy(findByClassIndex(flat, t, 0), 'class_index');
    }

    if (matched) {
      const { node: hit, resolved, unclickable } = resolveClickable(matched);
      const warning = unclickable
        ? '目标本身不可点，且无可点祖先/子孙'
        : resolved
          ? '目标不可点，已解析到最近可点节点'
          : null;
      // WebView 零面积节点放行后 bounds/center 不可信，标记 inWebView 供下游走 VLM 坐标兜底
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

    // ② VLM 兜底：只在 vlm 注入函数存在时启用；结果按 树hash+target 缓存（§5.0.3.2）
    if (vlm) {
      // 缓存失效完全依赖 tree.hash 随画面变化。树不可用时 hash 是「错误文本」派生的稳定值，
      // 不随画面变——若照常缓存，槽冲突期间同 target 会跨画面命中陈旧坐标点错位置。
      // 故树不可用路径跳过 vlmCache 读写：每次重新看图（多付 VLM 往返，换点击正确）。
      const cacheable = !treeError;
      const key = `${tree.hash}::${target}`;
      const cached = cacheable ? vlmCache.get(key) : undefined;
      if (cached) {
        return { ...result, ok: true, bounds: cached.bounds, center: cached.center, strategy: 'vlm', vlmCacheHit: true, identity: cached.identity };
      }
      // VLM 分支早退统一带结构化 code：树不可用时不能让上层再走同样依赖 fresh dump 的 waitIdle。
      const vlmFail = async (msg) => {
        const code = treeError ? 'TREE_UNAVAILABLE' : 'VLM_FAILED';
        await dumpMissTree(missDumpDir, { target, attempted, flat, reason: `视觉定位失败: ${msg}`, tree, size, treeError });
        return { ...result, code, error: msg };
      };
      let png;
      try {
        png = await screencap();
      } catch (e) {
        return vlmFail(`截图失败: ${e?.message ?? e}`);
      }
      let raw = null;
      let family = null;
      try {
        const out = await vlm({ png, size, target: String(target), instruction: '' });
        raw = out?.raw ?? out;
        family = out?.family ?? null;
      } catch (e) {
        return vlmFail(`VLM 定位失败: ${e?.message ?? e}`);
      }
      family = family ?? loadProbeFamily(probeFile);
      const cs = family ? resolveStrategy(family) : null;
      if (!cs) {
        return vlmFail('无法确定坐标策略：请设置 ASK_MODEL_FAMILY 或运行 ask doctor --probe-family');
      }
      const conv = cs.toPixels(raw, size);
      if (!conv.bounds && !conv.center) {
        return vlmFail(`VLM 返回无法解析: ${JSON.stringify(raw)?.slice(0, 120)}`);
      }
      if (!conv.inScreen) {
        // 越界告警：多为 family 坐标约定用错（§5.5.1），降级失败
        return vlmFail(`VLM 坐标越界(${JSON.stringify(conv.bounds ?? conv.center)})，请检查 model family 坐标约定`);
      }
      const identity = { text: '', contentDesc: String(target), resourceId: '', cls: '', clickable: null };
      if (cacheable) vlmCache.set(key, { bounds: conv.bounds, center: conv.center, identity });
      return { ...result, ok: true, bounds: conv.bounds, center: conv.center, strategy: 'vlm', identity };
    }

    // 失败信息必须可操作：模型据此改写描述。原实现只给"未找到目标"——
    // 既没说搜的是什么，也没说试过哪些策略，candidates 还是 DFS 顺序的前 8 个
    // （与目标无关的节点），模型无法据此调整。
    // 诊断：区分「树里压根没有目标」与「目标存在但零面积/不在屏被 inScreen 丢弃」——
    // 后者在 uni-app WebView 壳里常见（可见元素报 [0,0][0,0]），落盘当次 flat 供排查。
    // rawHits 必须与定位主链同源：用 findByKind(flat, parsed) 取未经 inScreen 过滤的原始
    // 命中，不能拿带前缀的原始 target 串去搜（within/re:/id=/class= 等形态 parsed.text
    // 为 undefined，会恒空并把真实的几何过滤误标成「无匹配节点」）。
    const rawHits = rawHitsForReason(flat, parsed);
    const reason = treeError
      ? '树不可用(dump 失败)'
      : parsed.kind === 'within'
        ? (rawHits.length ? 'within 作用域内命中但目标不可解析' : 'within 作用域未命中')
        : (rawHits.length && !rawHits.some((n) => inScreen(n.bounds, size, flat)) ? 'inScreen 过滤' : '无匹配节点');
    await dumpMissTree(missDumpDir, { target, attempted, flat, reason, tree, size, treeError });
    return {
      ...result,
      ...(treeError ? { code: 'TREE_UNAVAILABLE' } : {}),
      error: treeError
        ? `${treeError}；且视觉定位未命中 "${target}"`
        : `未找到目标 "${target}"：已尝试策略 ${attempted.join('→')}，未命中`,
      candidates: candidatesOf(flat, target),
    };
  };
}
