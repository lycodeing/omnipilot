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
      const props = {};
      for (const [k, v] of Object.entries(node.properties || {})) props[k] = convert(v);
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
  // 按字节截断（避开代理对：从字符层面回退到不越界）
  let cut = text;
  while (Buffer.byteLength(cut, 'utf8') > limit) cut = cut.slice(0, Math.floor(cut.length * 0.95));
  return {
    text: cut + `\n[MCP 结果已截断：原始 ${size} 字节 > ${limit} 上限，完整内容见 run.json]`,
    truncated: true,
    bytes: size,
  };
}

// 建立 MCP 桥：读配置 → 逐个连接（失败只 warn）→ 白名单过滤 → 冲突加前缀
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

  for (const server of Object.values(servers)) {
    const res = await connectImpl(server);
    if (res.error) {
      bridge.servers.push({ name: server.name, status: 'error', error: res.error, toolCount: 0 });
      logger(`[mcp] server ${server.name} 连接失败（不阻断启动）：${res.error}`);
      continue;
    }
    let registered = 0;
    for (const t of res.tools) {
      if (!matchesAllowList(t.name, server.name, allowTools)) continue; // 默认拒绝
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

  bridge.hasAccess = (originalName, serverName) => matchesAllowList(originalName, serverName, allowTools);

  bridge.callByName = async (finalName, args) => {
    const t = bridge.tools.find((x) => x.finalName === finalName);
    if (!t) throw new Error(`MCP 工具未注册或未放行：${finalName}`);
    const raw = await callTool(t.client, t.originalName, args);
    return { ...truncateResult(raw), tool: t };
  };

  bridge.close = async () => {
    if (bridge.closed) return;
    bridge.closed = true;
    for (const t of bridge.tools) { try { t.client.close(); } catch { /* ignore */ } }
  };

  return bridge;
}
