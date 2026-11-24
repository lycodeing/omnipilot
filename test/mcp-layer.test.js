// MCP 层测试：config 解析 / glob 白名单默认拒绝 / 命名冲突前缀 / 8KB 截断
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseMcpConfig, loadMcpConfig, DEFAULT_MCP_CONFIG } from '../src/mcp/config.js';
import { globToRegExp, matchesAllowList, jsonSchemaToTypeBox, truncateResult, createMcpBridge } from '../src/mcp/bridge.js';
import { buildMcpTools } from '../src/tools/mcp.js';

// —— config 解析（§8） ——
describe('mcp config', () => {
  test('默认交付内容：servers 空、toolPrefix true、allowTools 空', () => {
    const r = parseMcpConfig('{"servers":{},"toolPrefix":true,"allowTools":[]}');
    assert.deepEqual(r.servers, {});
    assert.equal(r.toolPrefix, true);
    assert.deepEqual(r.allowTools, []);
  });

  test('stdio server 解析（含 env/args）', () => {
    const r = parseMcpConfig(JSON.stringify({
      servers: { nacos: { transport: 'stdio', command: 'npx', args: ['-y', 'nacos-mcp-server'], env: { NACOS_ADDR: 'x' } } },
    }));
    assert.equal(r.servers.nacos.transport, 'stdio');
    assert.equal(r.servers.nacos.command, 'npx');
    assert.deepEqual(r.servers.nacos.args, ['-y', 'nacos-mcp-server']);
    assert.equal(r.servers.nacos.env.NACOS_ADDR, 'x');
  });

  test('transport 缺省推断：command→stdio、url→http', () => {
    const r = parseMcpConfig(JSON.stringify({
      servers: { a: { command: 'foo' }, b: { url: 'https://x/mcp', headers: { Authorization: 't' } } },
    }));
    assert.equal(r.servers.a.transport, 'stdio');
    assert.equal(r.servers.b.transport, 'http');
    assert.equal(r.servers.b.headers.Authorization, 't');
  });

  test('非法条目跳过并 warn，不抛错', () => {
    const r = parseMcpConfig(JSON.stringify({ servers: { bad: {}, ok: { command: 'x' } } }));
    assert.equal(r.servers.bad, undefined);
    assert.ok(r.warnings.some((w) => w.includes('bad')));
    assert.ok(r.servers.ok);
  });

  test('JSON 非法抛错；文件缺失返回 missing', () => {
    assert.throws(() => parseMcpConfig('{oops'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-mcp-'));
    const r = loadMcpConfig(path.join(dir, 'nope.json'));
    assert.equal(r.missing, true);
    assert.deepEqual(r.allowTools, []);
    assert.deepEqual(DEFAULT_MCP_CONFIG.allowTools, []);
  });
});

// —— glob 白名单：默认拒绝（§8.2） ——
describe('allowlist', () => {
  test('空 allowTools = 拒绝一切（默认拒绝）', () => {
    assert.equal(matchesAllowList('get_config', 'nacos', []), false);
    assert.equal(matchesAllowList('anything', 'server', undefined), false);
  });

  test('glob 命中三种形态：原名 / server__原名 / server:原名', () => {
    const allow = ['nacos_*', 'gitee_create_issue'];
    assert.equal(matchesAllowList('get_config', 'nacos', allow), true);
    assert.equal(matchesAllowList('nacos__get_config', 'nacos', allow), true);
    assert.equal(matchesAllowList('nacos:get_config', 'nacos', allow), true);
    assert.equal(matchesAllowList('create_issue', 'gitee', allow), true);
    assert.equal(matchesAllowList('delete_repo', 'gitee', allow), false);
    assert.equal(matchesAllowList('get_config', 'other', allow), false);
  });

  test('globToRegExp 基本语义', () => {
    assert.ok(globToRegExp('nacos_*').test('nacos__get_config'));
    assert.ok(globToRegExp('*').test('anything'));
    assert.ok(globToRegExp('a?c').test('abc'));
    assert.ok(!globToRegExp('a?c').test('abbc'));
  });
});

// —— 命名冲突前缀（§8.1 C12/R1） ——
describe('bridge naming', () => {
  const mkConfig = (servers, allowTools, toolPrefix) => ({ servers, allowTools, toolPrefix });

  function fakeConnect(toolsByServer) {
    return async (server) => ({
      client: { close() {} },
      tools: toolsByServer[server.name] || [],
    });
  }

  test('toolPrefix=true → 一律加 server__ 前缀，描述带 [MCP:server]', async () => {
    const bridge = await createMcpBridge({
      config: mkConfig({ nacos: { name: 'nacos', transport: 'stdio', command: 'x' } }, ['*'], true),
      connectImpl: fakeConnect({ nacos: [{ name: 'get_config', description: 'cfg', inputSchema: { type: 'object', properties: {} } }] }),
    });
    assert.deepEqual(bridge.tools.map((t) => t.finalName), ['nacos__get_config']);
    assert.match(bridge.tools[0].description, /^\[MCP:nacos\]/);
  });

  test('toolPrefix=false → 保留原名；冲突才加前缀', async () => {
    const config = mkConfig(
      { a: { name: 'a', transport: 'stdio', command: 'x' }, b: { name: 'b', transport: 'stdio', command: 'y' } },
      ['*'], false,
    );
    const bridge = await createMcpBridge({
      config,
      connectImpl: fakeConnect({
        a: [{ name: 'run', description: '', inputSchema: { type: 'object', properties: {} } }],
        b: [{ name: 'run', description: '', inputSchema: { type: 'object', properties: {} } }, { name: 'other', description: '', inputSchema: { type: 'object', properties: {} } }],
      }),
    });
    const names = bridge.tools.map((t) => t.finalName).sort();
    // a 的 run 先注册保留原名；b 的 run 冲突 → b__run；b 的 other 无冲突保留原名
    assert.deepEqual(names, ['b__run', 'other', 'run']);
    assert.equal(names.filter((n) => n === 'run').length, 1, '重名不共存，后者加前缀');
    assert.ok(names.includes('b__run'), '冲突者加 server__ 前缀');
    assert.ok(names.includes('other'), '无冲突保留原名');
  });

  test('默认拒绝：allowTools 空 → 不注册任何工具，但 server 状态仍记录', async () => {
    const bridge = await createMcpBridge({
      config: mkConfig({ nacos: { name: 'nacos', transport: 'stdio', command: 'x' } }, [], true),
      connectImpl: fakeConnect({ nacos: [{ name: 'get_config', description: '', inputSchema: {} }] }),
    });
    assert.equal(bridge.tools.length, 0);
    assert.equal(bridge.servers[0].status, 'ok');
  });

  test('连接失败只 warn 不阻断（status=error）', async () => {
    const warns = [];
    const bridge = await createMcpBridge({
      config: mkConfig({ broken: { name: 'broken', transport: 'stdio', command: 'x' } }, ['*'], true),
      connectImpl: async () => ({ error: 'spawn 失败' }),
      logger: (m) => warns.push(m),
    });
    assert.equal(bridge.servers[0].status, 'error');
    assert.equal(bridge.tools.length, 0);
    assert.ok(warns.some((w) => w.includes('broken')));
  });
});

// —— 8KB 截断（§8.2） ——
describe('result truncation', () => {
  test('小于 8KB 原样返回', () => {
    const r = truncateResult('x'.repeat(1000));
    assert.equal(r.truncated, false);
    assert.equal(r.text, 'x'.repeat(1000));
  });

  test('大于 8KB 截断并标注', () => {
    const r = truncateResult('y'.repeat(20 * 1024));
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.text, 'utf8') <= 8 * 1024 + 200, '截断后不超上限太多');
    assert.ok(r.text.includes('已截断'));
    assert.ok(r.bytes > 8 * 1024);
  });

  test('中文内容按字节截断', () => {
    const r = truncateResult('测'.repeat(10_000)); // 30KB utf8
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.text, 'utf8') < 9 * 1024);
  });
});

// —— JSON Schema → TypeBox 转换 + MCP 工具转 Pi ToolDefinition ——
describe('schema bridge', () => {
  test('jsonSchemaToTypeBox 基本类型转换', () => {
    const tb = jsonSchemaToTypeBox({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } },
      required: ['a'],
    });
    assert.equal(tb.type, 'object');
    assert.ok(tb.properties.a);
    assert.ok(tb.properties.b);
  });

  test('buildMcpTools 生成 Pi 工具并可调用', async () => {
    const bridge = await createMcpBridge({
      config: { servers: { srv: { name: 'srv', transport: 'stdio', command: 'x' } }, allowTools: ['srv_*'], toolPrefix: true },
      connectImpl: async () => ({
        client: { close() {} },
        tools: [{ name: 'echo', description: '回声', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }],
      }),
    });
    let callArgs = null;
    bridge.callByName = async (name, args) => { callArgs = args; return { text: 'pong', truncated: false, bytes: 4, tool: {} }; };
    const tools = buildMcpTools({ mcp: bridge });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'srv__echo');
    assert.match(tools[0].description, /^\[MCP:srv\]/);
    const r = await tools[0].execute('id', { msg: 'ping' }, undefined, undefined, {});
    assert.deepEqual(callArgs, { msg: 'ping' });
    assert.equal(r.content[0].text, 'pong');
  });
});

// —— 写操作确认闸与 schema required 保真 ——

test('MCP 工具走确认闸：用户拒绝时不调用 MCP 服务器', async () => {
  // 回归用例：MCP 工具此前完全绕过确认钩子——MCP 服务器可暴露任意有副作用的
  // 工具（删配置/写仓库/跑 SQL），allowlist 是通配符无法区分读写。
  const bridge = await createMcpBridge({
    config: { servers: { srv: { name: 'srv', transport: 'stdio', command: 'x' } }, allowTools: ['srv_*'], toolPrefix: true },
    connectImpl: async () => ({
      client: { close() {} },
      tools: [{ name: 'delete_config', description: '删配置', inputSchema: { type: 'object', properties: {} } }],
    }),
  });
  let called = 0;
  bridge.callByName = async () => { called += 1; return { text: 'DELETED', truncated: false, bytes: 7, tool: {} }; };

  let confirmCalls = 0;
  const ctx = {
    mcp: bridge,
    opts: { yes: false },
    confirm: async () => { confirmCalls += 1; return false; },   // 用户拒绝
  };
  const tools = buildMcpTools(ctx);
  const r = await tools[0].execute('id', {}, undefined, undefined, {});
  assert.equal(confirmCalls, 1, 'MCP 调用必须经过确认');
  assert.equal(called, 0, '用户拒绝后不得调用 MCP 服务器');
  assert.equal(r.details.denied, true);
});

test('MCP 工具：--yes 直通确认闸', async () => {
  const bridge = await createMcpBridge({
    config: { servers: { srv: { name: 'srv', transport: 'stdio', command: 'x' } }, allowTools: ['srv_*'], toolPrefix: true },
    connectImpl: async () => ({
      client: { close() {} },
      tools: [{ name: 'echo', description: 'x', inputSchema: { type: 'object', properties: {} } }],
    }),
  });
  let called = 0;
  bridge.callByName = async () => { called += 1; return { text: 'pong', truncated: false, bytes: 4, tool: {} }; };
  const ctx = { mcp: bridge, opts: { yes: true } };
  const tools = buildMcpTools(ctx);
  const r = await tools[0].execute('id', {}, undefined, undefined, {});
  assert.equal(called, 1, '--yes 应直通');
  assert.equal(r.content[0].text, 'pong');
});

test('jsonSchemaToTypeBox 尊重 required：可选参数不得变成必填', () => {
  // 回归用例：原实现把所有属性转成非 optional，typebox 因而视全部为必填——
  // Pi 的校验器会拒绝缺可选参数的合法调用，且模型被告知该参数必填而臆造值。
  const tb = jsonSchemaToTypeBox({
    type: 'object',
    properties: { msg: { type: 'string' }, count: { type: 'number' } },
    required: ['msg'],
  });
  assert.deepEqual(tb.required, ['msg'], 'required 只应含 schema 声明的必填字段');
  assert.ok(!tb.required.includes('count'), '可选参数不得进入 required');
});

test('jsonSchemaToTypeBox：无 required 声明时全部字段可选', () => {
  const tb = jsonSchemaToTypeBox({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
  });
  // typebox 在无必填字段时省略 required 键（而非空数组）
  assert.ok(!tb.required || tb.required.length === 0, '未声明 required 时不应有必填字段');
});
