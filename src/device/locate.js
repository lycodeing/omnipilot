// 定位策略链（§5.1）：精确文本 → 正则/包含 → resource-id → class+index → VLM（注入函数）
// clickable=false 兜底（§5.4.2）；hint 跨执行坐标缓存校验（§5.0.5 R2）；文本匹配不缓存（§5.0.2.1）
import { flattenNodes, nodeIdentity } from './uitree.js';
import { resolveStrategy } from './coord/registry.js';
import { loadProbeFamily, probeCachePath } from './coord/probe.js';

export function inScreen(bounds, size) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return false;
  const [l, t, r, b] = bounds;
  return l >= 0 && t >= 0 && r <= size.w && b <= size.h && r > l && b > t;
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
// 是"外部输入 → 正则执行器"的直连通道。嵌套量词（如 (a+)+$）会在 UI 树的每个节点上
// 触发灾难性回溯——UI 树常有数百节点，单次 locate 可挂死数分钟（无超时、无中断）。
// 无依赖方案：限制长度 + 拒绝嵌套量词 + 拒绝回溯型构造。
const MAX_REGEX_LEN = 200;
// 嵌套量词：(?:\([^)]*[+*][^)]*\)|\[[^\]]*\][+*])\s*[+*] 之类
const NESTED_QUANTIFIER_RE = /\((?:[^()]*[+*][^()]*)\)\s*[+*?]/;
const BACKTRACKING_HINT_RE = /\(\?<[=!]|\\1|\\2/;

export function compileSafeRegex(pattern, flags = 'i') {
  const src = String(pattern ?? '');
  if (!src || src.length > MAX_REGEX_LEN) return null;
  if (NESTED_QUANTIFIER_RE.test(src)) return null;   // 嵌套量词 → 灾难性回溯
  if (BACKTRACKING_HINT_RE.test(src)) return null;   // 反向引用 / 前后查找 → 复杂回溯
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

export function findByRegex(flat, pattern) {
  const re = compileSafeRegex(pattern);
  if (!re) return [];
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
export function candidatesOf(flat, limit = 8) {
  return flat
    .filter((n) => n.text || n.contentDesc)
    .slice(0, limit)
    .map((n) => ({ text: n.text, contentDesc: n.contentDesc, resourceId: n.resourceId, cls: n.cls, bounds: n.bounds }));
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

// deps：getTree（门面 dumpTree）、getSize、screencap、vlmCache、probeFile（.ask/family-probe.json）
export function createLocator({ getTree, getSize, screencap, vlmCache = new Map(), probeFile = probeCachePath() }) {
  return async function locate(target, { vlm = null, hintBounds = null, hintIdentity = null } = {}) {
    const base = { ok: false, bounds: null, center: null, strategy: 'none', treeCacheHit: false, vlmCacheHit: false, dumpMs: 0, identity: null, error: null };
    if (!target || !String(target).trim()) return { ...base, error: 'target 为空' };

    let tree;
    try {
      tree = await getTree();
    } catch (e) {
      return { ...base, error: `获取 UI 树失败: ${e?.message ?? e}` };
    }
    const flat = flattenNodes(tree.nodes);
    // getSize 必须在 try 内：冷启动期 wm size 不可用（服务未就绪/超时）时应结构化返回，
    // 不能让异常逃出 locate（曾导致整个 run 被判 error，见 VERIFICATION-REPORT §10）。
    // 返回形状严守契约 §1.1（不新增字段），"设备未就绪"由 error 文本表达。
    let size;
    try {
      size = await getSize();
    } catch (e) {
      return { ...base, error: `设备未就绪，获取屏幕尺寸失败: ${e?.message ?? e}` };
    }
    const result = { ...base, treeCacheHit: Boolean(tree.fromCache), dumpMs: tree.dumpMs ?? 0 };

    // ① hint：bounds 命中且 identity 一致才复用（§5.0.5 / §14.2.1）
    if (hintBounds && hintIdentity) {
      const node = nodeAtBounds(flat, hintBounds);
      if (node && sameIdentity(node, hintIdentity)) {
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
    const tryStrategy = (nodes, name) => {
      if (matched || !nodes?.length) return;
      matched = nodes.filter((n) => inScreen(n.bounds, size)).sort((a, b) => area(a.bounds) - area(b.bounds))[0] ?? null;
      if (matched) strategy = name;
    };

    if (parsed.kind === 'exact_text') {
      const hits = findByExactText(flat, parsed.text);
      if (parsed.index) matched = hits[parsed.index] && inScreen(hits[parsed.index].bounds, size) ? hits[parsed.index] : null;
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
      return {
        ...result,
        ok: true,
        bounds: hit.bounds,
        center: hit.center,
        strategy,
        identity: nodeIdentity(hit),
        ...(warning ? { warning } : {}),
      };
    }

    // ② VLM 兜底：只在 vlm 注入函数存在时启用；结果按 树hash+target 缓存（§5.0.3.2）
    if (vlm) {
      const key = `${tree.hash}::${target}`;
      const cached = vlmCache.get(key);
      if (cached) {
        return { ...result, ok: true, bounds: cached.bounds, center: cached.center, strategy: 'vlm', vlmCacheHit: true, identity: cached.identity };
      }
      let png;
      try {
        png = await screencap();
      } catch (e) {
        return { ...result, error: `截图失败: ${e?.message ?? e}` };
      }
      let raw = null;
      let family = null;
      try {
        const out = await vlm({ png, size, target: String(target), instruction: '' });
        raw = out?.raw ?? out;
        family = out?.family ?? null;
      } catch (e) {
        return { ...result, error: `VLM 定位失败: ${e?.message ?? e}` };
      }
      family = family ?? loadProbeFamily(probeFile);
      const cs = family ? resolveStrategy(family) : null;
      if (!cs) {
        return { ...result, error: '无法确定坐标策略：请设置 ASK_MODEL_FAMILY 或先运行 probeFamily 探测' };
      }
      const conv = cs.toPixels(raw, size);
      if (!conv.bounds && !conv.center) {
        return { ...result, error: `VLM 返回无法解析: ${JSON.stringify(raw)?.slice(0, 120)}` };
      }
      if (!conv.inScreen) {
        // 越界告警：多为 family 坐标约定用错（§5.5.1），降级失败
        return { ...result, error: `VLM 坐标越界(${JSON.stringify(conv.bounds ?? conv.center)})，请检查 model family 坐标约定` };
      }
      const identity = { text: '', contentDesc: String(target), resourceId: '', cls: '', clickable: null };
      vlmCache.set(key, { bounds: conv.bounds, center: conv.center, identity });
      return { ...result, ok: true, bounds: conv.bounds, center: conv.center, strategy: 'vlm', identity };
    }

    return { ...result, error: '未找到目标', candidates: candidatesOf(flat) };
  };
}
