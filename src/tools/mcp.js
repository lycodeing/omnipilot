// MCP 工具动态注册（§8）：把桥内放行的工具转成 Pi ToolDefinition。
// 描述已带 [MCP:server] 前缀（bridge 生成）；调用走 bridge.callByName（30s 超时 + 8KB 截断）。

import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { jsonSchemaToTypeBox } from '../mcp/bridge.js';
import { confirmWrite, denied } from './action.js';

export function buildMcpTools(ctx) {
  const bridge = ctx.mcp;
  if (!bridge || !Array.isArray(bridge.tools)) return [];
  return bridge.tools.map((t) =>
    defineTool({
      name: t.finalName,
      label: t.finalName,
      description: t.description,
      parameters: jsonSchemaToTypeBox(t.inputSchema),
      execute: async (_toolCallId, params) => {
        // MCP 调用确认闸（§8.2）：MCP 服务器可暴露任意有副作用的工具（删配置、
        // 写仓库、跑 SQL），而 allowlist 是通配符、无法区分读写——故一律走确认。
        // 与原生写操作工具同一道闸：--yes 直通，否则经 ctx.confirm 征求同意。
        const gate = await confirmWrite(ctx, t.finalName, `MCP ${t.server} / ${t.originalName}`, { kind: 'mcp' });
        if (!gate.allowed) return denied(t.finalName);
        const { text, truncated, bytes } = await bridge.callByName(t.finalName, params);
        return {
          content: [{ type: 'text', text: truncated ? text : text || '(空结果)' }],
          details: { mcp: { server: t.server, tool: t.originalName, truncated, bytes } },
        };
      },
    }),
  );
}
