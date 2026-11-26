// 感知工具（§10）：screen / uitree / locate / screen_diff / read
// 只调 ctx.device 门面（§2.3），禁止直接跑 adb。

import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { createCachedLocate } from './locate-cache.js';

// —— 共享纯函数（data.js 复用） ——

// UiNode[] 深度优先扁平化（§1.1 UiNode 形状）
export function flattenNodes(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (Array.isArray(n.children) && n.children.length) flattenNodes(n.children, out);
  }
  return out;
}

// selector 节点匹配：单一实现源在 device/locate.js（matchNodeSelector），此处委托，避免两份分叉。
import { matchNodeSelector } from '../device/locate.js';
export function matchSelector(node, sel) {
  if (String(sel).startsWith('index=')) return false; // index= 由 findBySelector 处理
  return matchNodeSelector(node, sel);
}
// 在 scope 内按 selector 找节点；'index=N' 按在 scope 中的序号
export function findBySelector(flat, sel) {
  if (sel.startsWith('index=')) {
    const i = Number(sel.slice(6));
    return flat[i] ?? null;
  }
  return flat.find((n) => matchSelector(n, sel)) ?? null;
}

// 容器级多匹配（列表卡片每张一个 scope）：与 findBySelector 同源（matchNodeSelector 委托），
// 不走自造的 class= 字符串比较（那会绕过单一实现源，'#index=' 语义也会被忽略）。
export function findAllBySelector(flat, sel) {
  if (String(sel).startsWith('index=')) {
    const n = findBySelector(flat, sel);
    return n ? [n] : [];
  }
  return flat.filter((n) => matchSelector(n, sel));
}

function nodeSummary(n) {
  return { index: n.index, text: n.text, cls: n.cls, resourceId: n.resourceId, contentDesc: n.contentDesc, clickable: n.clickable, bounds: n.bounds, center: n.center };
}

// 统一文本响应：content 放**紧凑** JSON（进模型上下文，缩进纯浪费 token：
// 真机 uitree pretty 38088 字符 vs compact 21036，膨胀 44.8%）；details 镜像原对象供 recorder。
export function textResult(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    details: obj,
  };
}

export function buildPerceptionTools(ctx) {
  const { device, store, opts } = ctx;

  // screen_diff 需要记住上次树 hash（会话内状态）
  let lastHash = null;

  // 带跨执行坐标缓存的定位（§1.5）：由 buildTools 注入共享实例，locate/tap/long_press/input/swipe 共用
  const locateWithCache = ctx.locateWithCache ?? createCachedLocate({ device, store, opts, ctx });

  const screen = defineTool({
    name: 'screen',
    label: 'screen',
    description: '截图并把画面交给模型看，同时返回前台包/Activity 与分辨率。动作后先看画面再决定下一步。',
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: '截图标注名（如 loading/loaded），仅用于取证' })),
    }),
    execute: async (_id, params) => {
      const shot = await device.screencap();
      const fg = await device.foreground().catch(() => null);
      // 进模型上下文的图压缩（§17）：540×1200 + JPEG(q70)，340KB→75KB（省 78%），
      // 模型对 JPEG 无感（能准确读出图内文章标题）。取证用原图仍由记账层单独落盘。
      let data = shot.buffer;
      let mimeType = 'image/png';
      let compressed = null;
      try {
        const { compressForContext } = await import('../image/png.js');
        const r = await compressForContext(shot.buffer, { maxWidth: 540, quality: 70 });
        data = r.buffer; mimeType = r.mimeType;
        compressed = `${r.width}x${r.height}.${r.format}`;
      } catch { /* 压缩失败则用原图，不阻断 */ }
      const meta = {
        ok: true,
        label: params.label || null,
        size: shot.size,
        ...(compressed ? { compressedTo: compressed } : {}),
        foreground: fg,
      };
      return {
        content: [
          { type: 'image', data: data.toString('base64'), mimeType },
          { type: 'text', text: JSON.stringify(meta) },
        ],
        details: meta,
      };
    },
  });

  const uitree = defineTool({
    name: 'uitree',
    label: 'uitree',
    description: '返回当前 UI 树（结构化 JSON）。可只过滤可点节点。用于了解页面结构。',
    parameters: Type.Object({
      clickableOnly: Type.Optional(Type.Boolean({ description: '只返回可点节点' })),
      fresh: Type.Optional(Type.Boolean({ description: '强制重 dump 并刷新缓存' })),
      maxNodes: Type.Optional(Type.Number({ description: '最多返回节点数（默认 120）' })),
    }),
    execute: async (_id, params) => {
      const tree = await device.dumpTree({ fresh: !!params.fresh });
      let flat = flattenNodes(tree.nodes);
      if (params.clickableOnly) flat = flat.filter((n) => n.clickable);
      const max = params.maxNodes ?? 120;
      const truncated = flat.length > max;
      const body = {
        ok: true,
        hash: tree.hash,
        fromCache: tree.fromCache,
        dumpMs: tree.dumpMs,
        total: flat.length,
        truncated,
        nodes: flat.slice(0, max).map(nodeSummary),
      };
      return textResult(body);
    },
  });

  const locate = defineTool({
    name: 'locate',
    label: 'locate',
    description: '语义/文本定位元素，返回 bounds 与命中策略。不执行点击。',
    parameters: Type.Object({
      target: Type.String({ description: '目标描述，如 "电子相册"、resourceId=... ' }),
    }),
    execute: async (_id, params) => {
      const target = params.target;
      const res = await locateWithCache(target);
      return textResult({ ok: res.ok, target, ...res, locate: { strategy: res.strategy, bounds: res.bounds, treeCacheHit: res.treeCacheHit, vlmCacheHit: res.vlmCacheHit, dumpMs: res.dumpMs, identity: res.identity } });
    },
  });

  const screenDiff = defineTool({
    name: 'screen_diff',
    label: 'screen_diff',
    description: '判断画面是否变化（基于 UI 树 hash，绝不用截图判变）。第一次调用只记录基线。',
    parameters: Type.Object({}),
    execute: async () => {
      const hash = await device.screenDiffHash();
      const changed = lastHash === null ? null : hash !== lastHash;
      lastHash = hash;
      return textResult({ ok: true, hash, changed, note: changed === null ? '已记录基线 hash' : undefined });
    },
  });

  const read = defineTool({
    name: 'read',
    label: 'read',
    description: `从 UI 树读文本/数字（零模型调用）。selector 形如 text=xx | index=0 | ${ctx.platform?.toolDescriptionExamples?.read ?? 'class=android.widget.TextView#index=1'} | resourceId=...`,
    parameters: Type.Object({
      selector: Type.Optional(Type.String()),
      selectors: Type.Optional(Type.Array(Type.String(), { description: '一次读多个字段' })),
    }),
    execute: async (_id, params) => {
      const sels = params.selectors || (params.selector ? [params.selector] : []);
      if (!sels.length) return textResult({ ok: false, error: '需要 selector 或 selectors 参数' });
      const values = [];
      for (const sel of sels) {
        const r = await device.readText(sel);
        values.push({ selector: sel, ok: r.ok, value: r.value, error: r.error });
      }
      const allOk = values.every((v) => v.ok);
      const body = { ok: allOk, values };
      if (sels.length === 1) body.value = values[0].value;
      return textResult(body);
    },
  });

  return [screen, uitree, locate, screenDiff, read];
}
