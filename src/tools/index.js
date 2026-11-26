// 工具注册表工厂（§1.2 / §10）：buildTools(ctx) → ToolDefinition[]
// 工具内只调 ctx.device / ctx.store / ctx.recorder / ctx.mcp，禁止直接跑 adb（§2.3）。
// ctx 可选扩展字段：mcp（MCP 桥）、confirm（交互确认钩子）、chat（小模型客户端，ai 提取用）、
//                   vlm（VLM 定位函数）、runStartMs、currentStepIndex、lastThought（最近模型文本）。
// 记账包装：每个工具调用记录为 run.json 的一个 step（§14.1：type=工具名、locate 透传、
// 写动作成功后自动留一张"动作后截图"），报告与定位统计的数据源都在这里。

import { buildPerceptionTools } from './perception.js';
import { buildActionTools, ENGINE_ONLY_TOOLS } from './action.js';
import { buildEnvTools } from './env.js';
import { buildDataTools } from './data.js';
import { buildMcpTools } from './mcp.js';
import { createCachedLocate } from './locate-cache.js';

function ensureLocateCache(ctx) {
  // 带缓存的定位在工具层共享一份（§1.5）：locate/tap/long_press/input/swipe 统一入口，
  // 避免动作工具绕过缓存（曾导致 cache 命中率仅 3%）
  if (!ctx.locateWithCache) {
    ctx.locateWithCache = createCachedLocate({ device: ctx.device, store: ctx.store, opts: ctx.opts, ctx });
  }
}

// 契约工具（25 个，§10 清单）：模型工具面 = 契约工具面。
// 引擎专用工具（point_tap，坐标点击）**不在此列**——它只服务 allowCoords 用例的引擎直执行步，
// 注册给模型等于把"禁止像素坐标"（2026-09-24 裁定）在模型侧作废。见 buildEngineTools。
export function buildTools(ctx) {
  ensureLocateCache(ctx);
  return [
    ...buildPerceptionTools(ctx),
    ...buildActionTools(ctx),
    ...buildEnvTools(ctx),
    ...buildDataTools(ctx),
    ...buildMcpTools(ctx),
  ].filter((t) => !ENGINE_ONLY_TOOLS.has(t.name)).map((t) => withRecording(t, ctx));
}

// 引擎专用工具（不在 EXPECTED_TOOLS / 模型工具面）：仅由 buildToolCall 产出的调用命中。
// 与契约工具同款记账包装（坐标步在报告里也要有 step + 动作后截图）。
export function buildEngineTools(ctx) {
  ensureLocateCache(ctx);
  return buildActionTools(ctx)
    .filter((t) => ENGINE_ONLY_TOOLS.has(t.name))
    .map((t) => withRecording(t, ctx));
}

// §10 工具清单（25 个：感知5 + 操作9 + 环境6 + 数据扩展5；操作含 tap_each_row 逐行批量点击）
export const EXPECTED_TOOLS = [
  // 感知
  'screen', 'uitree', 'locate', 'screen_diff', 'read',
  // 操作
  'tap', 'long_press', 'input', 'swipe', 'scroll', 'tap_each_row', 'key', 'launch', 'terminate',
  // 环境
  'net_profile', 'net_status', 'wait_idle', 'wait_element', 'assert_no_crash', 'ui_dump',
  // 数据与扩展
  'data_extract', 'data_query', 'data_store', 'secret_get', 'sms_read',
];

// 需要留取证截图的工具：写操作留"动作后截图"；locate 留"定位时截图"——
// 它是 bounds 的真实载体，报告的"找元素镜头"（insight 高亮）就画在这张动作前画面上

function targetOf(params = {}) {
  return params.target ?? params.appId ?? params.packageName ?? params.provider ?? params.name
    ?? params.profile ?? params.direction ?? params.label ?? params.question
    ?? params.selector ?? (Array.isArray(params.selectors) ? params.selectors.join('|') : null) ?? null;
}

// 截图入档前遮罩：用最近一次 dumpTree 的缓存树（cache.peek()）找 password 节点 bounds，
// 把凭据图像面填灰。无缓存树 / 遮罩失败一律用原图（尽力而为，不额外 dump、不阻断取证）。
async function redactShot(buf, ctx) {
  try {
    const cached = ctx.device.cachePeek?.();
    if (cached?.nodes) {
      const { redactScreenshot } = await import('../device/screenshot-redact.js');
      const { flattenNodes } = await import('../device/uitree.js');
      return redactScreenshot(buf, flattenNodes(cached.nodes));
    }
  } catch { /* 遮罩失败用原图（尽力而为） */ }
  return buf;
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
          } else if (!denied) {
            // 报告截图**全覆盖**（2026-11-01）：每个工具步都留终态截图——失败步的截图
            // 恰是诊断金矿（dump 全盲事故里 tap 全 MISS 却无图可看），只读工具（read/
            // uitree/wait_element）的截图则是"决策当时画面"的证据。取证截图移出关键路径
            // （性能）：不 await（adb 回传 0.5~1.5s），serial 队列保证"截图排在下一动作
            // 之前"的画面时序；Promise 挂 recorder 待写队列，finish 前统一排空不丢图。
            // busy 态下 serial 队列可能被 40-55s 的长 dump 堵住，screencap 15s 客户端预算
            // 会排队超时 → 失败后隔 2s 重试，最多 3 次（穿透拥堵窗口）
            const chain = (async () => {
              for (let i = 0; i < 3; i++) {
                try {
                  const shot = await ctx.device.screencap();
                  recorder.attachScreenshot(handle.index, await redactShot(shot.buffer, ctx));
                  return;
                } catch { if (i < 2) await new Promise((r) => setTimeout(r, 2000)); }
              }
            })();
            recorder.trackPending?.(chain);
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
