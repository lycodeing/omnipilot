// uiautomator dump XML → 结构化 UiNode（契约 §1.1 形状）
// 解析规则：bounds="[l,t][r,b]" → 数组；/dev/tty 输出按 </hierarchy> 截断去杂质（§5.0.1）
import { createHash } from 'node:crypto';

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(s) {
  if (!s || !s.includes('&')) return s;
  return s
    .replace(/&(lt|gt|quot|apos|nbsp|#x?[0-9a-fA-F]+);/g, (m, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code] ?? m;
    })
    .replace(/&amp;/g, '&');
}

// 按 </hierarchy> 截断，去掉 "UI hierchary dumped to: ..." 等尾缀杂质
export function truncateAtHierarchyEnd(text) {
  const s = String(text ?? '');
  const i = s.indexOf('</hierarchy>');
  if (i === -1) return s;
  return s.slice(0, i + '</hierarchy>'.length);
}

export function parseBounds(s) {
  const m = /^\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]$/.exec(String(s ?? ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

function makeNode(attrs) {
  const bounds = parseBounds(attrs.bounds) ?? [0, 0, 0, 0];
  return {
    index: Number.parseInt(attrs.index ?? '0', 10) || 0,
    text: decodeXml(attrs.text ?? ''),
    cls: attrs.class ?? '',
    resourceId: attrs['resource-id'] ?? '',
    contentDesc: decodeXml(attrs['content-desc'] ?? ''),
    clickable: attrs.clickable === 'true',
    enabled: attrs.enabled !== 'false',
    // 密码框：uiautomator 的 password="true" 标记。凭据图像面（截图遮罩）与
    // 回读面（readTextAt 掩码）靠它识别；缺省/非 "true" 一律 false。
    password: attrs.password === 'true',
    // 附加字段（契约 §1.1 之外的增量）：节点所属包名。uiautomator XML 每节点自带 package=，
    // 根节点 package 即前台应用包——供弹窗检测从树派生前台，省一次 dumpsys 往返（性能审计 #2）。
    pkg: attrs.package ?? '',
    bounds,
    center: [Math.floor((bounds[0] + bounds[2]) / 2), Math.floor((bounds[1] + bounds[3]) / 2)],
    children: [],
  };
}

const TAG_RE = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

// 返回 hierarchy 的顶层节点数组；parent 以非枚举属性挂在子节点上（不影响深比较/序列化）
export function parseXmlDump(xmlText) {
  const roots = [];
  const stack = [{ pseudo: true, children: roots }];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(String(xmlText ?? '')))) {
    const [, close, name, attrBlob, selfClose] = m;
    if (close) {
      const top = stack.pop();
      if (top?.pseudo && stack.length) stack[stack.length - 1].children.push(...top.children);
      continue;
    }
    if (name === 'hierarchy') {
      if (!selfClose) stack.push({ pseudo: true, children: [] });
      continue;
    }
    const attrs = {};
    if (attrBlob) {
      ATTR_RE.lastIndex = 0;
      let a;
      while ((a = ATTR_RE.exec(attrBlob))) attrs[a[1]] = a[2];
    }
    const node = makeNode(attrs);
    const parent = stack[stack.length - 1];
    if (!parent.pseudo) Object.defineProperty(node, 'parent', { value: parent, enumerable: false, configurable: true });
    parent.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return roots;
}

// 深度优先扁平数组
export function flattenNodes(nodes) {
  const out = [];
  const walk = (list) => {
    for (const n of list ?? []) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// 稳定 hash：扁平化后的 (text, resourceId, cls, clickable, bounds) 序列 sha1 前 16 位
export function treeHash(nodes) {
  const h = createHash('sha1');
  for (const n of flattenNodes(nodes)) {
    h.update(`${n.text}\u0001${n.resourceId}\u0001${n.cls}\u0001${n.clickable ? 1 : 0}\u0001${n.bounds.join(',')}\u0002`);
  }
  return h.digest('hex').slice(0, 16);
}

// identity 快照（§14.2.1 / hint 校验 R2 用）
export function nodeIdentity(node) {
  return {
    text: node?.text ?? '',
    contentDesc: node?.contentDesc ?? '',
    resourceId: node?.resourceId ?? '',
    cls: node?.cls ?? '',
    clickable: Boolean(node?.clickable),
  };
}

// ─── WebView 零面积 bounds 统一判定 ───────────────────────────────────────
// uni-app / WebView 壳 App 的可见元素经常报 bounds=[0,0][0,0]（零面积），
// 这是渲染器特性而非「隐藏节点」。全仓所有几何过滤点必须复用以下三个函数，
// 避免各处自行实现导致行为不一致（waitFor 能等到、locate 却点不到）。
//
// 核心原则：
//   - 纯原生树里零面积 = 隐藏节点 → 严格过滤（不放行）
//   - WebView 壳内零面积 = 几何未知 → 放行，但标记 inWebView，
//     下游消费方须走 VLM / 视觉确认获取真实坐标，不可直接用 center=[0,0] 点击
//   - 排序时零面积节点 area=0 必须排最后，防止「最小面积优先」误选

/**
 * 判断节点 bounds 是否为零面积（无效或宽高 ≤ 0）。
 * 用于替代各处内联的 `bounds[2]-bounds[0]>0 && bounds[3]-bounds[1]>0` 判断。
 */
export function isZeroAreaBounds(node) {
  const bounds = node?.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4) return true;
  return bounds[2] <= bounds[0] || bounds[3] <= bounds[1];
}

/**
 * 判断扁平节点列表中是否存在 WebView 壳容器。
 * 判据与 matchOnScreen 一致：cls 含 "WebView"（不区分大小写）。
 * 只有存在 WebView 壳时，零面积才被视为「几何未知」而非「隐藏」。
 */
export function hasWebViewContainer(flatNodes) {
  return (flatNodes ?? []).some((node) => /WebView/i.test(node.cls || ''));
}

/**
 * 组合判定：该节点的零面积 bounds 是否应被放行。
 * 仅当「零面积 + WebView 壳」同时成立时返回 true。
 * 调用方据此决定跳过面积过滤，并在结果中标记 inWebView=true。
 */
export function shouldAllowZeroAreaNode(node, flatNodes) {
  return isZeroAreaBounds(node) && hasWebViewContainer(flatNodes);
}
