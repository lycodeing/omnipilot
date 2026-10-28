// MCP 工具动态注册（§8）：把桥内放行的工具转成 Pi ToolDefinition。
// 描述已带 [MCP:server] 前缀（bridge 生成）；调用走 bridge.callByName（30s 超时 + 8KB 截断）。

import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { jsonSchemaToTypeBox } from '../mcp/bridge.js';

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
        // MCP 调用确认钩子：非 --yes 交互模式下应先征求用户同意（§8.2），
        // CLI 非交互场景由 opts.yes 直通；此处保留扩展点。
        const { text, truncated, bytes } = await bridge.callByName(t.finalName, params);
        return {
          content: [{ type: 'text', text: truncated ? text : text || '(空结果)' }],
          details: { mcp: { server: t.server, tool: t.originalName, truncated, bytes } },
        };
      },
    }),
  );
}
