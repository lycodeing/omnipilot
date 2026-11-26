// 会话装配（§1.2 / §11）：createRunContext + createAskSession
// Pi 自带 read/bash/edit/write 一律关闭（noTools:'builtin'），工具全部来自 buildTools(ctx)。

import { createAgentSession, DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import { buildTools } from '../tools/index.js';
import { resolvePlatform } from '../platform/index.js';

// 运行上下文（§1.2，逐字遵守的字段：device/recorder/store/vars/opts/secretCalls；
// 其余为会话层内部扩展：mcp/confirm/chat/vlm/runStartMs/currentStepIndex/assertions）
export function createRunContext({ device, recorder, store, opts = {} } = {}) {
  return {
    device,
    recorder,
    store,
    platform: resolvePlatform(opts.platform ?? 'android'), // 平台包注入（缺省 android，工具描述示例等消费）
    vars: new Map(),            // data_extract 写入，${var} 执行期插值（§7.5）
    opts: {
      yes: false,
      timeoutMs: 60_000,
      vlmLocate: false,
      freshLocate: false,
      ...opts,
    },
    secretCalls: [],            // 每次 secret_get/sms_read 调用 push {tool, provider, key, stepIndex}（§9.1 强制 fresh 的依据）
    stateMutations: [],         // 全局设备状态改动记录（§2.6：网络档位回滚用）
    engineLog: [],              // 引擎直执行步骤的 run 内记录（§2.4；不进模型上下文，收尾时 recorder.setEngineLog 落 run.json）
    // —— 内部扩展字段 ——
    mcp: null,                  // MCP 桥（src/mcp/bridge.js）
    confirm: null,              // 交互确认钩子（写操作 / MCP 调用）
    chat: null,                 // 小模型客户端（data_extract ai 模式，src/tools/ai.js）
    vlm: null,                  // VLM 定位函数（--vlm-locate）
    stateDir: null,             // 工作区私有状态目录（ui_dump 兜底 / secrets 查找；null → cwd/.ask）
    runStartMs: Date.now(),     // 网络时间线相对起点
    currentStepIndex: null,     // 当前执行到的用例步骤序号
    assertions: [],             // 断言结果镜像（exit code 判定用）
  };
}

// 装配 Pi 会话：自定义工具 + 关内置工具 + 系统提示词覆盖（照 examples/sdk/03-custom-prompt.ts）
// tools：可选的工具数组覆盖（ask 只读问答用白名单过滤后的子集）；缺省 buildTools(ctx)
export async function createAskSession(ctx, { systemPrompt, sessionManager, model, modelRuntime, thinkingLevel = 'off', tools } = {}) {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(), // win32 上缺省会崩（normalizeWindowsShellPath 对 undefined 调 startsWith）
    ...(systemPrompt
      ? {
          systemPromptOverride: () => systemPrompt,
          // 不追加 ~/.pi/agent 或 .pi/ 下的 APPEND_SYSTEM.md，保证提示词完全由三层装配决定
          appendSystemPromptOverride: () => [],
        }
      : {}),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    customTools: tools || buildTools(ctx),
    noTools: 'builtin',
    resourceLoader: loader,
    ...(sessionManager ? { sessionManager } : {}),
    ...(model ? { model } : {}),
    ...(modelRuntime ? { modelRuntime } : {}),
    thinkingLevel,
  });
  return session;
}
