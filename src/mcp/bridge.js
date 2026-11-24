// MCP 桥（§8.1/8.2）：
//   - allowTools glob 白名单，默认拒绝（空数组 = 不启用任何 MCP 工具）
//   - toolPrefix=true 时一律加 server__ 前缀；false 时仅命名冲突才加
//   - 描述前缀 [MCP:server]；结果 >8KB 截断标注
//   - JSON Schema → TypeBox 参数转换（供 defineTool 使用）

import { Type } from 'typebox';
import { connectServer, callTool } from './client.js';

export const RESULT_LIMIT_BYTES = 8 * 1024;

// 极简 glob：* 与 ** 均匹配任意字符（含 server__ 前缀），? 单字符
export function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const rx = esc.replace(/\*\*/g, '\0').replace(/\*/g, '.*').replace(/\0/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${rx}$`, 'i');
}

// 白名单匹配：工具可写原名、server__原名、server:原名 或 server_原名 四种形态
export function matchesAllowList(originalName, serverName, allowTools) {
  if (!Array.isArray(allowTools) || allowTools.length === 0) return false; // 默认拒绝
  const forms = [
    originalName,
    `${serverName}__${originalName}`,
    `${serverName}:${originalName}`,
    `${serverName}_${originalName}`,
  ];
  return allowTools.some((g) => {
    const re = globToRegExp(String(g));
    return forms.some((f) => re.test(f));
  });
}

// JSON Schema（MCP）→ TypeBox（Pi defineTool parameters）
export function jsonSchemaToTypeBox(schema) {
  if (!schema || typeof schema !== 'object') return Type.Object({});
  return convert(schema);
}
function convert(node) {
  if (!node || typeof node !== 'object') return Type.Any();
  const opts = node.description ? { description: node.description } : {};
  switch (node.type) {
    case 'string': return node.enum ? Type.Unsafe({ ...node }) : Type.String(opts);
    case 'number':
    case 'integer': return Type.Number(opts);
    case 'boolean': return Type.Boolean(opts);
    case 'array': return Type.Array(node.items ? convert(node.items) : Type.Any(), opts);
    case 'object': {
      // 必须尊重 JSON Schema 的 required 数组：typebox 会把「非 Optional 的属性」
      // 一律视为必填。若不按 required 包裹，可选参数会变成必填——Pi 的校验器
      // 会拒绝合法的调用（缺可选参数的正常请求被拒），且模型也会被告知
      // 该参数必填而臆造值。
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const props = {};
      for (const [k, v] of Object.entries(node.properties || {})) {
        const t = convert(v);
        props[k] = required.has(k) ? t : Type.Optional(t);
      }
      return Type.Object(props, { ...opts, additionalProperties: node.additionalProperties !== false });
    }
    default:
      if (node.enum || node.anyOf || node.oneOf) return Type.Unsafe({ ...node });
      return Type.Any(opts);
  }
}

export function truncateResult(text, limit = RESULT_LIMIT_BYTES) {
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= limit) return { text, truncated: false, bytes: size };
  // 一步按字节截断并回退到 UTF-8 字符边界（旧实现每轮砍 5% 再全量 byteLength，
  // 10MB→8KB 需 ~130 次迭代、累计扫描 ~1GB 字符）
  const buf = Buffer.from(text, 'utf8');
  let end = Math.min(limit, buf.length);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // 跳过续字节 0b10xxxxxx
  const cut = buf.subarray(0, end).toString('utf8');
  return {
    text: cut + `\n[MCP 结果已截断：原始 ${size} 字节 > ${limit} 上限，完整内容见 run.json]`,
    truncated: true,
    bytes: size,
  };
}

// 建立 MCP 桥：读配置 → **并行**连接（失败只 warn）→ 白名单过滤 → 冲突加前缀
// connectImpl：可注入的连接实现（测试用），默认 connectServer
export async function createMcpBridge({ config, logger = () => {}, connectImpl = connectServer } = {}) {
  const bridge = {
    servers: [],   // { name, status: 'ok'|'error', toolCount, error }
    tools: [],     // { finalName, server, originalName, description, inputSchema, client }
    closed: false,
  };
  const servers = config?.servers || {};
  const allowTools = config?.allowTools || [];
  const toolPrefix = config?.toolPrefix !== false;

  // 白名单 glob 预编译（旧实现每次匹配都 new RegExp，T 工具 × G glob × 4 形态重复编译）
  const allowRes = allowTools.map((g) => globToRegExp(String(g)));
  const matchesCompiled = (originalName, serverName) => {
    if (!allowRes.length) return false; // 默认拒绝
    const forms = [
      originalName,
      `${serverName}__${originalName}`,
      `${serverName}:${originalName}`,
      `${serverName}_${originalName}`,
    ];
    return allowRes.some((re) => forms.some((f) => re.test(f)));
  };

  // 并行连接各 server（旧实现串行，超时最坏叠加：每 server 10s 上限）
  const entries = Object.values(servers);
  const results = await Promise.all(entries.map((s) => connectImpl(s).catch((e) => ({ error: String(e?.message ?? e) }))));

  for (let i = 0; i < entries.length; i++) {
    const server = entries[i];
    const res = results[i];
    if (!res || res.error) {
      bridge.servers.push({ name: server.name, status: 'error', error: res?.error ?? 'connect failed', toolCount: 0 });
      logger(`[mcp] server ${server.name} 连接失败（不阻断启动）：${res?.error ?? 'connect failed'}`);
      continue;
    }
    let registered = 0;
    for (const t of res.tools) {
      if (!matchesCompiled(t.name, server.name)) continue; // 默认拒绝
      let finalName = toolPrefix ? `${server.name}__${t.name}` : t.name;
      if (bridge.tools.some((x) => x.finalName === finalName)) {
        finalName = `${server.name}__${t.name}`;
        if (bridge.tools.some((x) => x.finalName === finalName)) {
          logger(`[mcp] 工具 ${finalName} 命名冲突且加前缀仍冲突，跳过`);
          continue;
        }
      }
      bridge.tools.push({
        finalName,
        server: server.name,
        originalName: t.name,
        description: `[MCP:${server.name}] ${t.description}`.trim(),
        inputSchema: t.inputSchema,
        client: res.client,
      });
      registered++;
    }
    bridge.servers.push({ name: server.name, status: 'ok', toolCount: registered, error: null });
  }

  // 运行期 O(1) 工具查找（旧实现 callByName 每次线性 find）
  const byFinalName = new Map(bridge.tools.map((t) => [t.finalName, t]));

  bridge.hasAccess = (originalName, serverName) => matchesCompiled(originalName, serverName);

  bridge.callByName = async (finalName, args) => {
    const t = byFinalName.get(finalName);
    if (!t) throw new Error(`MCP 工具未注册或未放行：${finalName}`);
    const raw = await callTool(t.client, t.originalName, args);
    return { ...truncateResult(raw), tool: t };
  };

  bridge.close = async () => {
    if (bridge.closed) return;
    bridge.closed = true;
    const clients = new Set(bridge.tools.map((t) => t.client));
    for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
  };

  return bridge;
}
