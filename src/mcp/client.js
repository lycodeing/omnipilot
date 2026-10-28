// MCP server 连接（§8）：连接超时 10s、失败只 warn 不阻断；调用超时 30s。
// 用顶层已安装的 @modelcontextprotocol/sdk。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const CONNECT_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 30_000;

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// 连接单个 server 并 listTools。成功 → { client, tools }；失败 → { error }
export async function connectServer(server, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  let transport;
  try {
    if (server.transport === 'stdio') {
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args || [],
        env: { ...process.env, ...(server.env || {}) },
        stderr: 'pipe',
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      });
    }
    const client = new Client({ name: 'omniscene', version: '0.1.0' });
    await withTimeout(client.connect(transport), timeoutMs, `MCP ${server.name} 连接`);
    const toolsRes = await withTimeout(client.listTools(), timeoutMs, `MCP ${server.name} listTools`);
    const tools = (toolsRes.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    return { client, tools };
  } catch (e) {
    try { transport?.close?.(); } catch { /* ignore */ }
    return { error: e.message || String(e) };
  }
}

// 调用 MCP 工具（30s 超时）。返回展平的文本内容。
export async function callTool(client, name, args = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const res = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, `MCP 工具 ${name} 调用`);
  if (res.isError) {
    const errText = contentToText(res.content) || 'MCP 工具返回错误';
    throw new Error(errText);
  }
  return contentToText(res.content);
}

function contentToText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : `[${c.type}]`)).join('\n');
  }
  return String(content);
}
