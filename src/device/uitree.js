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
