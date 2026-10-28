// 工具注册表工厂（§1.2 / §10）：buildTools(ctx) → ToolDefinition[]
// 工具内只调 ctx.device / ctx.store / ctx.recorder / ctx.mcp，禁止直接跑 adb（§2.3）。
// ctx 可选扩展字段：mcp（MCP 桥）、confirm（交互确认钩子）、chat（小模型客户端，ai 提取用）、
//                   vlm（VLM 定位函数）、runStartMs、currentStepIndex、lastThought（最近模型文本）。
// 记账包装：每个工具调用记录为 run.json 的一个 step（§14.1：type=工具名、locate 透传、
// 写动作成功后自动留一张"动作后截图"），报告与定位统计的数据源都在这里。

import { buildPerceptionTools } from './perception.js';
import { buildActionTools } from './action.js';
import { buildEnvTools } from './env.js';
import { buildDataTools } from './data.js';
import { buildMcpTools } from './mcp.js';
import { createCachedLocate } from './locate-cache.js';

export function buildTools(ctx) {
  // 带缓存的定位在工具层共享一份（§1.5）：locate/tap/long_press/input/swipe 统一入口，
  // 避免动作工具绕过缓存（曾导致 cache 命中率仅 3%）
  if (!ctx.locateWithCache) {
    ctx.locateWithCache = createCachedLocate({ device: ctx.device, store: ctx.store, opts: ctx.opts, ctx });
  }
  return [
    ...buildPerceptionTools(ctx),
    ...buildActionTools(ctx),
    ...buildEnvTools(ctx),
    ...buildDataTools(ctx),
    ...buildMcpTools(ctx),
  ].map((t) => withRecording(t, ctx));
}

// §10 工具清单（22 个内置 + 5 感知 + 8 操作 + 5 环境 + 5 数据扩展 = 23，其中 §10 表计 22 行）
export const EXPECTED_TOOLS = [
  // 感知
  'screen', 'uitree', 'locate', 'screen_diff', 'read',
  // 操作
  'tap', 'long_press', 'input', 'swipe', 'scroll', 'key', 'launch', 'terminate',
  // 环境
  'net_profile', 'net_status', 'wait_idle', 'assert_no_crash', 'ui_dump',
  // 数据与扩展
  'data_extract', 'data_query', 'data_store', 'secret_get', 'sms_read',
];

// 需要留取证截图的工具：写操作留"动作后截图"；locate 留"定位时截图"——
// 它是 bounds 的真实载体，报告的"找元素镜头"（insight 高亮）就画在这张动作前画面上
const SCREENSHOT_TOOLS = new Set(['tap', 'long_press', 'input', 'swipe', 'scroll', 'key', 'launch', 'terminate', 'net_profile', 'locate']);

function targetOf(params = {}) {
  return params.target ?? params.appId ?? params.packageName ?? params.provider ?? params.name
    ?? params.profile ?? params.direction ?? params.label ?? params.question ?? null;
}

// 记账包装：不动工具自身逻辑，只在外层记 step（§14.1）
export function withRecording(tool, ctx) {
  const recorder = ctx?.recorder;
  if (!recorder) return tool;
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate, execCtx) => {
      const handle = recorder.startStep(tool.name, targetOf(params));
      const secretsBefore = ctx.secretCalls?.length ?? 0;
      try {
        const res = await execute(id, params, signal, onUpdate, execCtx);
        const d = res?.details ?? {};
        const denied = d.denied === true;
        handle.end({
          result: denied ? 'cancelled' : d.ok === false ? 'failed' : 'ok',
          locate: d.locate ?? null,
          error: d.ok === false ? (d.error ?? d.code ?? 'failed') : null,
          thought: ctx.lastThought ?? null,
        });
        // secret 类工具拿到的值登记给 recorder，收尾时全文兜底脱敏（§19.7）
        const secret = ctx.secretCalls?.[secretsBefore];
        if (secret?.value != null) {
          try { recorder.registerSecret?.(secret); } catch { /* ignore */ }
        }
        try {
          if (tool.name === 'screen' && res?.content?.[0]?.type === 'image') {
            recorder.attachScreenshot(handle.index, Buffer.from(res.content[0].data, 'base64'));
          } else if (SCREENSHOT_TOOLS.has(tool.name) && !denied && d.ok !== false) {
            const shot = await ctx.device.screencap();
            recorder.attachScreenshot(handle.index, shot.buffer);
          }
        } catch { /* 取证截图失败不影响动作 */ }
        return res;
      } catch (e) {
        // 工具执行异常不再上抛：转成结构化失败返回，让模型看到原因并可自行重试。
        // 上抛会穿透到 run 的步骤级 catch → 整个 run 判 error 并 break（冷启动期
        // wm size 未就绪曾导致 7 条用例齐刷刷中断，见 VERIFICATION-REPORT §10）。
        const msg = String(e?.message ?? e);
        try { handle.end({ result: 'error', error: msg, thought: ctx.lastThought ?? null }); } catch { /* ignore */ }
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg, tool: tool.name }) }],
          details: { ok: false, error: msg, thrown: true },
        };
      }
    },
  };
}
