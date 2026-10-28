// mcp.json 解析（§8）。默认交付内容：{"servers":{},"toolPrefix":true,"allowTools":[]}
// server 形状：
//   stdio: { "transport":"stdio", "command":"npx", "args":[...], "env":{...} }
//   http:  { "transport":"http", "url":"https://...", "headers":{...} }
// transport 缺省：有 command 视为 stdio，有 url 视为 http。

import fs from 'node:fs';

export const DEFAULT_MCP_CONFIG = { servers: {}, toolPrefix: true, allowTools: [] };

export function parseMcpConfig(raw, { source = 'mcp.json' } = {}) {
  const warnings = [];
  if (raw === undefined || raw === null) return { ...DEFAULT_MCP_CONFIG, servers: {}, warnings };
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { throw new Error(`${source} 不是合法 JSON：${e.message}`); }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${source} 顶层必须是对象`);
  const cfg = {
    servers: {},
    toolPrefix: raw.toolPrefix !== false,
    allowTools: Array.isArray(raw.allowTools) ? raw.allowTools.map(String) : [],
  };
  const servers = raw.servers && typeof raw.servers === 'object' && !Array.isArray(raw.servers) ? raw.servers : {};
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== 'object') { warnings.push(`server ${name} 配置不是对象，已跳过`); continue; }
    const transport = s.transport || (s.command ? 'stdio' : s.url ? 'http' : null);
    if (transport === 'stdio') {
      if (!s.command) { warnings.push(`server ${name}：stdio 缺 command，已跳过`); continue; }
      cfg.servers[name] = { name, transport, command: String(s.command), args: Array.isArray(s.args) ? s.args.map(String) : [], env: s.env && typeof s.env === 'object' ? { ...s.env } : {} };
    } else if (transport === 'http') {
      if (!s.url) { warnings.push(`server ${name}：http 缺 url，已跳过`); continue; }
      cfg.servers[name] = { name, transport, url: String(s.url), headers: s.headers && typeof s.headers === 'object' ? { ...s.headers } : {} };
    } else {
      warnings.push(`server ${name}：无法识别 transport（缺 command/url），已跳过`);
    }
  }
  return { ...cfg, warnings };
}

export function loadMcpConfig(configPath = 'mcp.json') {
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); } catch {
    // 文件不存在 → 跳过 MCP（§8.1 C2 分支）
    return { ...DEFAULT_MCP_CONFIG, warnings: [], missing: true };
  }
  const parsed = parseMcpConfig(text, { source: configPath });
  return { ...parsed, missing: false };
}
