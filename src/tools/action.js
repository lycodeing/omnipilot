// 操作工具（§10）：tap / long_press / input / swipe / scroll / key / launch / terminate
// 只调 ctx.device 门面；写操作确认：--yes 直通，交互确认留 ctx.confirm 钩子。

import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { textResult } from './perception.js';
import { assertSafePackage, assertSafeActivity } from '../device/package-guard.js';

// —— 命名常量（原散落在各 execute 闭包里的魔法数字/字符串） ——

/** long_press 未显式传 durationMs 时的默认长按时长（毫秒），与 device.longPress 缺省一致 */
const DEFAULT_LONG_PRESS_DURATION_MS = 800;
/** swipe 未显式传 durationMs 时的默认滑动时长（毫秒），与 device.swipe 缺省一致 */
const DEFAULT_SWIPE_DURATION_MS = 300;
/** scroll 普通滚动（无 until）的最大滚动次数缺省值 */
const DEFAULT_SCROLL_MAX_STEPS = 5;
/** scroll until=edge/top 边界跳转的最大滚动次数缺省值 */
const EDGE_SCROLL_MAX_STEPS = 20;
/** scroll until=<selector> 小步滚动的最大滚动次数缺省值，与 device.scrollUntil 缺省一致 */
const SELECTOR_SCROLL_MAX_STEPS = 12;
/** launch clean=true 时清弹窗循环的最大轮数（弹窗消失或前台离开弹窗包即提前停） */
const LAUNCH_CLEAN_POPUP_MAX_ROUNDS = 3;
/** tap_each_row 逐题取证子步骤标题中题目文本的截断长度（字符） */
const ANSWER_ROW_TITLE_MAX_LENGTH = 24;
/** swipe from/to 可直接透传给设备层的屏幕区域名（无需语义定位） */
const SWIPE_REGION_NAMES = ['bottom', 'top', 'left', 'right'];
/** key 工具支持的系统按键名白名单 */
const SUPPORTED_KEY_NAMES = ['back', 'home', 'enter', 'recent'];
/** launch clean 清弹窗循环判定"前台仍是系统弹窗包"的正则（权限控制器/安装器） */
const SYSTEM_DIALOG_PACKAGE_PATTERN = /permissioncontroller|packageinstaller/;

// 写/敏感操作确认钩子：opts.yes 直通；交互模式由 ctx.confirm 提供扩展点（§13.3）
// 告警标志挂在 ctx 上（而非模块级）：bin/ask.js 支持多 run 并发，模块级标志会
// 让先告警的 run 抑制掉其它 run 的告警——后者可能根本没有确认能力。
//
// kind：'write'（改设备状态）/ 'sensitive'（读凭据、读短信等敏感读取）/ 'mcp'
// （调用外部 MCP 服务器）。措辞必须区分——对只读操作宣称"写操作"会让用户误解
// 自己批准了什么。
export async function confirmWrite(ctx, toolName, targetDesc, { kind = 'write' } = {}) {
  if (ctx.opts?.yes) return { allowed: true };
  const verb = kind === 'write' ? '调用写操作' : kind === 'sensitive' ? '执行敏感读取' : '调用外部工具';
  if (typeof ctx.confirm === 'function') {
    const ok = await ctx.confirm(`${verb} ${toolName}（${targetDesc}）`);
    return { allowed: !!ok };
  }
  // 非交互且未提供 confirm（CI/后台/管道）：按设计放行，但必须显式告警一次——
  // 否则"写操作零确认执行"对使用者完全不可见（权限绕过面）
  if (!ctx._autoAllowWarned) {
    ctx._autoAllowWarned = true;
    console.warn('[warn] 非交互环境未启用操作确认，所有 tap/input/swipe/launch 等写操作与敏感读取将直接执行（如需门禁请用 --yes 以外的交互模式，或自行注入 ctx.confirm）');
  }
  return { allowed: true };
}

export function denied(toolName) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `用户拒绝了 ${toolName} 调用` }) }],
    // 带 error：withRecording 据此记录被拒原因（否则只记成笼统的 'failed'）
    details: { ok: false, denied: true, error: `用户拒绝了 ${toolName} 调用` },
  };
}

/**
 * 定位失败统一响应（LOCATE_MISS）：tap 附加补救建议 hint（保持既有形状）。
 * details.code 恒为 LOCATE_MISS（run-loop 的 isLocateMiss 锚，改动它会漏掉三级降级）；
 * 结构化原因放 details.locateCode / details.error，供降级策略 gate 用。
 * @param {string} target 目标描述（可见文本 / resource-id）
 * @param {string|null} error 定位层返回的具体错误
 * @param {{hint?: boolean, fallback?: string, loc?: object|null}} options hint=附补救建议；fallback=error 为空时的兜底文案；loc=定位记账对象
 * @returns {object} 工具结果（content + details）
 */
function locateMiss(target, error, { hint = false, fallback = '未找到目标', loc = null } = {}) {
  const body = { ok: false, code: 'LOCATE_MISS', target, error: error || fallback };
  if (hint) body.hint = '先用 uitree 查看页面结构，或换更精确的可见文本';
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    details: { ok: false, code: 'LOCATE_MISS', locateCode: loc?.code ?? null, error: error || fallback },
  };
}

/**
 * 点击类动作成功响应：透传 device 结果 + locate 记账（tap/long_press 共用）。
 * @param {string} target 目标描述
 * @param {object} locate 定位记账对象（strategy/bounds 等）
 * @param {{ok: boolean, latencyMs?: number, error?: string|null}} deviceResult 设备层动作结果
 * @returns {object} 工具结果（content + details）
 */
function actedResult(target, locate, deviceResult) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: deviceResult.ok, target, strategy: locate.strategy, bounds: locate.bounds, latencyMs: deviceResult.latencyMs, error: deviceResult.error }) }],
    details: { ok: deviceResult.ok, locate },
  };
}

/**
 * 写操作前的弹窗检查（§2.7）：遇系统弹窗先关闭，避免用例被授权框打断。
 * 不计入 steps、不产生断言；关闭失败只 warn + 记 rollback（不阻断原操作）。
 * @param {object} ctx 运行上下文（recorder/currentStepIndex 用于失败记账）
 * @param {object} device 设备门面
 */
async function handlePopupBeforeAction(ctx, device) {
  try {
    const { detectDialog, dismissDialog } = await import('../device/popup.js');
    const detection = await detectDialog(device);
    if (!detection.detected) return;
    const dismissal = await dismissDialog(device);
    if (dismissal.ok) {
      console.warn(`[warn] 检测到系统弹窗（${detection.reason}），已按「${dismissal.clicked}」关闭`);
    } else {
      console.warn(`[warn] 系统弹窗关闭失败：${dismissal.error}`);
      try { ctx.recorder?.addRollback?.({ stepIndex: ctx.currentStepIndex ?? null, reason: `弹窗未关闭：${dismissal.error}`, recovered: false }); } catch { /* ignore */ }
    }
  } catch { /* 弹窗检查失败不阻断主流程 */ }
}

/**
 * 「确认闸 → 弹窗预检 → 语义定位 → 执行动作」通用模板（tap/long_press/input 共用）。
 * 定位失败返回 LOCATE_MISS（missOptions 定制 hint/fallback 文案），不触达设备动作；
 * 动作结果的响应形状由各工具经 buildResponse 自行组装。
 * @param {object} deps 依赖集合
 * @param {object} deps.ctx 运行上下文（确认闸/弹窗预检用）
 * @param {object} deps.device 设备门面
 * @param {Function} deps.locateWithCache 带缓存的定位函数（buildTools 注入共享实例）
 * @param {string} deps.toolName 工具名（确认闸与拒绝响应用）
 * @param {string} deps.target 目标描述
 * @param {{hint?: boolean, fallback?: string}} [deps.missOptions] 定位失败响应的定制项
 * @param {(locate: object) => Promise<object>} deps.performAction 拿到定位记账后执行的设备动作
 * @param {(locate: object, deviceResult: object) => object} deps.buildResponse 动作结果 → 工具响应
 * @returns {Promise<object>} 工具结果（denied / LOCATE_MISS / 动作响应三选一）
 */
async function executeLocatedAction({ ctx, device, locateWithCache, toolName, target, missOptions = {}, performAction, buildResponse }) {
  const gate = await confirmWrite(ctx, toolName, target);
  if (!gate.allowed) return denied(toolName);
  await handlePopupBeforeAction(ctx, device);
  const locate = await locateWithCache(target);
  if (!locate.ok || !locate.bounds) return locateMiss(target, locate.error, { ...missOptions, loc: locate });
  const deviceResult = await performAction(locate);
  return buildResponse(locate, deviceResult);
}

/**
 * swipe 端点解析：from/to 为区域名时直接透传；元素描述先走缓存定位取 bounds。
 * 定位失败必须返回 miss 标记（由调用方转 LOCATE_MISS）：若把描述原样丢给设备层，
 * 设备的 resolvePoint 只认区域名/坐标 → 报"未知区域名: 列表底部（可用: top/bottom/…）"，
 * 既掩盖了真因（元素没找到），又列出了模型从未用过的区域名，模型无法自纠。
 * @param {string} description 区域名或元素描述
 * @param {Function} locateWithCache 带缓存的定位函数
 * @returns {Promise<string|number[]|{miss: string, error: string|null}>} 区域名 / bounds / miss 标记
 */
async function resolveSwipeEndpoint(description, locateWithCache) {
  if (SWIPE_REGION_NAMES.includes(description)) return description;
  const locate = await locateWithCache(description);
  if (locate.ok && locate.bounds) return locate.bounds;
  return { miss: description, error: locate.error };
}

/**
 * scroll 参数解析与分派：until=edge/top 走边界跳转、until=<selector> 走小步滚动、
 * 缺省走定量滚动。三种形态的 max 缺省值不同（20/12/5），distancePct 仅在显式传入时透传。
 * selector 形态 found=false 且无 error 时补写"仍不可见"错误（调用方可区分"到底未见"）。
 * @param {object} device 设备门面
 * @param {{direction?: string, distancePct?: number, until?: string, max?: number, stopWhenNoChange?: boolean}} params scroll 工具入参
 * @returns {Promise<object>} 设备层滚动结果（scrolls/changed/found/error 等）
 */
async function resolveScrollParams(device, params) {
  if (params.until === 'edge' || params.until === 'top') {
    // 边界跳转（§2.4）：循环滚到画面不再变化（复用 stopWhenNoChange 语义）
    const direction = params.until === 'top' ? 'up' : (params.direction === 'up' ? 'up' : 'down');
    return device.scroll(direction, { max: params.max ?? EDGE_SCROLL_MAX_STEPS, stopWhenNoChange: true });
  }
  if (params.until) {
    // selector 形态：小步滚到目标在屏（WebView fling 惯性大，定量距离会过冲整段）
    const result = await device.scrollUntil(params.until, {
      direction: params.direction || 'down',
      max: params.max ?? SELECTOR_SCROLL_MAX_STEPS,
      ...(params.distancePct != null ? { distancePct: params.distancePct } : {}),
    });
    if (!result.found && !result.error) result.error = `滚动 ${result.scrolls} 步后目标仍不可见: ${params.until}`;
    return result;
  }
  return device.scroll(params.direction, {
    max: params.max ?? DEFAULT_SCROLL_MAX_STEPS,
    stopWhenNoChange: params.stopWhenNoChange !== false,
    ...(params.distancePct != null ? { distancePct: params.distancePct } : {}),
  });
}

/**
 * 异常 → 结构化失败响应（scroll/tap_each_row 同款兜底）：冷启动 getSize 未就绪等
 * 异常转 ok:false 而非上抛（上抛会把整个 run 判 error）。
 * @param {unknown} error 捕获到的异常
 * @returns {object} 工具结果（content + details 均带 error）
 */
function structuredFailure(error) {
  const message = String(error?.message ?? error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }],
    details: { ok: false, error: message },
  };
}

/**
 * tap_each_row 逐题取证回调工厂（视觉/selector 两形态共用）：每题一行 answer_row
 * 子步骤 + 验证截图（info.buffer 为 null 时补拍终态），使逐题作答过程在报告里可见。
 * 取证失败不阻断作答：兜底把子步骤标 ok 结束。
 * @param {object} ctx 运行上下文（recorder/device）
 * @returns {Function|null} onQuestion 回调；无 recorder 时返回 null（不取证）
 */
function makeAnswerRecorder(ctx) {
  if (!ctx.recorder) return null;
  return async (info) => {
    const handle = ctx.recorder.startStep('answer_row', `${String(info.row).slice(0, ANSWER_ROW_TITLE_MAX_LENGTH)} → ${info.option}`);
    try {
      let screenshotBuffer = info.buffer;
      if (!screenshotBuffer) { const shot = await ctx.device.screencap(); screenshotBuffer = shot.buffer; }
      ctx.recorder.attachScreenshot(handle.index, screenshotBuffer);
      handle.end({ result: info.ok ? 'ok' : 'failed', error: info.ok ? null : '像素验证未确认（可能已滚动出屏）' });
    } catch { try { handle.end({ result: 'ok' }); } catch { /* ignore */ } }
  };
}

/**
 * tap_each_row 视觉模式（缺省，推荐）：VLM 看图逐题定位未作答题目并点选其第一个
 * 选项，不依赖 a11y 树（busy 态免疫）。场景 profile 与 selector 形态统一走
 * profiles.resolveTiming，避免 settle/maxRounds/verifyColor 缺省值分叉。
 * @param {object} ctx 运行上下文（device/chat/modelCfg/recorder）
 * @param {{maxRounds?: number, verify?: boolean, verifyColor?: string, profile?: string}} params 工具入参（不含 rows/tap）
 * @returns {Promise<object>} 作答统计结果（rounds/taps/verified/done/error 等）
 */
async function runVisualAnswerMode(ctx, params) {
  // 场景 profile 按需加载：未知名抛错 → 外层 catch 转结构化失败（与 selector 形态 device 层报错同款 UX）
  let profile = null;
  if (params.profile) {
    const { loadProfile } = await import('../device/profiles/index.js');
    profile = await loadProfile(params.profile);
  }
  const { resolveTiming } = await import('../device/profiles/index.js');
  const timing = resolveTiming({ maxRounds: params.maxRounds, verifyColor: params.verifyColor }, profile);
  const { runVisualAnswer } = await import('./visual-answer.js');
  const { resolveStrategy } = await import('../device/coord/registry.js');
  const strategy = resolveStrategy(ctx.modelCfg?.family);
  return runVisualAnswer({
    device: ctx.device,
    chat: ctx.chat,
    strategy,
    maxRounds: timing.maxRounds,
    verify: params.verify !== false,
    verifyColor: timing.verifyColor,
    settleMs: timing.settleMs,
    ...(profile?.doneTexts?.length ? { doneTexts: profile.doneTexts } : {}),
    onQuestion: makeAnswerRecorder(ctx),
    log: (message) => console.warn('[visual-answer] ' + message),
  });
}

/**
 * tap_each_row selector 模式（确定性快路径）：rows=行 scope selector + tap=行内
 * 目标 selector，适合文案稳定的表单。maxRounds/verify/verifyColor/profile 仅在
 * 显式传入时透传（缺省交由设备层/profile 兜底，工具层不钉死）。
 * @param {object} ctx 运行上下文（device/recorder）
 * @param {{rows: string, tap: string, stopWhen?: string, maxRounds?: number, verify?: boolean, verifyColor?: string, profile?: string}} params 工具入参
 * @returns {Promise<object>} 作答统计结果（rounds/taps/verified/done/error 等）
 */
async function runSelectorAnswerMode(ctx, params) {
  return ctx.device.tapEachRow({
    rows: params.rows, tap: params.tap, stopWhen: params.stopWhen ?? null,
    ...(params.maxRounds != null ? { maxRounds: params.maxRounds } : {}),
    ...(params.verify != null ? { verify: params.verify } : {}),
    ...(params.verifyColor != null ? { verifyColor: params.verifyColor } : {}),
    ...(params.profile != null ? { profile: params.profile } : {}),
    onQuestion: makeAnswerRecorder(ctx),
  });
}

/**
 * launch appId 白名单校验（工具层第一道防线）：appId 会进 adb shell 命令串，而
 * adb shell 是设备端 /bin/sh -c 执行的。设备层也有同样的校验（最后防线），但在
 * 工具层拦住能给出准确的参数错误，而不是"设备层拒绝"的误导信息。
 * @param {string} appId 包名或 包名/activity
 * @returns {string|null} 非法时返回错误消息；合法返回 null
 */
function validateLaunchAppId(appId) {
  const trimmedId = String(appId ?? '').trim();
  const [packageName, activityName] = trimmedId.split('/');
  try {
    assertSafePackage(packageName);
    if (activityName) assertSafeActivity(activityName);
    return null;
  } catch (error) {
    return error.message;
  }
}

/**
 * launch clean=true 的清弹窗循环：冷启动常伴随权限/安装器弹窗，复用写动作前的
 * 同一套 detectDialog+dismissDialog 循环关闭（最多 LAUNCH_CLEAN_POPUP_MAX_ROUNDS
 * 轮，弹窗消失或前台离开弹窗包即停），不再靠用例里的防御咒语。
 * @param {object} ctx 运行上下文
 * @param {object} device 设备门面
 */
export async function cleanLaunchPopups(ctx, device) {
  for (let round = 0; round < LAUNCH_CLEAN_POPUP_MAX_ROUNDS; round++) {
    await handlePopupBeforeAction(ctx, device);
    const foreground = await device.foreground().catch(() => null);
    if (!foreground?.package || !SYSTEM_DIALOG_PACKAGE_PATTERN.test(foreground.package)) break;
  }
}

export function buildActionTools(ctx) {
  const { device } = ctx;
  // 带缓存的定位（§1.5）：由 buildTools 注入共享实例；动作工具不再直连 device.locate（绕过缓存）
  const locateWithCache = ctx.locateWithCache ?? ((target) => device.locate(target));

  const tap = defineTool({
    name: 'tap',
    label: 'tap',
    description: '语义定位并点击目标中心点。target 用可见文本或 resourceId，禁止像素坐标。',
    parameters: Type.Object({
      target: Type.String({ description: '目标描述（可见文本 / resource-id）' }),
    }),
    execute: async (_id, params) => executeLocatedAction({
      ctx, device, locateWithCache,
      toolName: 'tap',
      target: params.target,
      missOptions: { hint: true },
      performAction: (locate) => device.tap(locate.bounds),
      buildResponse: (locate, deviceResult) => actedResult(params.target, locate, deviceResult),
    }),
  });

  // 坐标点击（allowCoords 逃生口）：**不注册给模型**（见 buildActionTools 末尾与 index.js 过滤）。
  // 语义：跳过定位，直接点 (x,y)。仅由引擎直执行坐标步（buildToolCall → point_tap）调用，
  // 模型侧工具面保持"禁止像素坐标"（tap 的 description 仍是原话）。
  const pointTap = defineTool({
    name: 'point_tap',
    label: 'point_tap',
    description: '按坐标点击（仅 allowCoords 用例的引擎直执行步调用；模型侧不可用）。',
    parameters: Type.Object({
      x: Type.Number({ description: '屏幕 x 像素' }),
      y: Type.Number({ description: '屏幕 y 像素' }),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'point_tap', `${params.x},${params.y}`);
      if (!gate.allowed) return denied('point_tap');
      await handlePopupBeforeAction(ctx, device);
      const centerPoint = [Number(params.x), Number(params.y)];
      const deviceResult = await device.tap(centerPoint);
      // locate 记账：坐标步没有定位过程，但报告/定位统计需要一条可渲染的记录
      const locate = { ok: deviceResult.ok, bounds: null, center: centerPoint, strategy: 'coords', treeCacheHit: false, vlmCacheHit: false, dumpMs: 0, identity: null, error: deviceResult.error ?? null };
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: deviceResult.ok, target: `(${params.x},${params.y})`, strategy: 'coords', center: locate.center, latencyMs: deviceResult.latencyMs, error: deviceResult.error }) }],
        details: { ok: deviceResult.ok, locate },
      };
    },
  });

  const longPress = defineTool({
    name: 'long_press',
    label: 'long_press',
    description: '语义定位并长按目标中心点。',
    parameters: Type.Object({
      target: Type.String(),
      durationMs: Type.Optional(Type.Number({ description: '长按时长，默认 800ms' })),
    }),
    execute: async (_id, params) => executeLocatedAction({
      ctx, device, locateWithCache,
      toolName: 'long_press',
      target: params.target,
      performAction: (locate) => device.longPress(locate.bounds, params.durationMs ?? DEFAULT_LONG_PRESS_DURATION_MS),
      buildResponse: (locate, deviceResult) => actedResult(params.target, locate, deviceResult),
    }),
  });

  const input = defineTool({
    name: 'input',
    label: 'input',
    description: '定位输入框并输入文本（支持中文），输入后回读校验。需先有输入框目标。',
    parameters: Type.Object({
      target: Type.String({ description: '输入框描述' }),
      value: Type.String({ description: '要输入的内容（可含 ${var} 已插值文本）' }),
      clear: Type.Optional(Type.Boolean({ description: '输入前是否清空（默认 true）' })),
    }),
    execute: async (_id, params) => executeLocatedAction({
      ctx, device, locateWithCache,
      toolName: 'input',
      target: params.target,
      missOptions: { fallback: '未找到输入框' },
      performAction: (locate) => device.inputText(locate.bounds, params.value, { clear: params.clear !== false }),
      buildResponse: (locate, deviceResult) => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: deviceResult.ok, target: params.target, readBack: deviceResult.readBack, match: deviceResult.ok, error: deviceResult.error }) }],
        details: { ok: deviceResult.ok, locate },
      }),
    }),
  });

  const swipe = defineTool({
    name: 'swipe',
    label: 'swipe',
    description: '滑动：from/to 为区域名（bottom/top/left/right）或元素描述。',
    parameters: Type.Object({
      from: Type.String(),
      to: Type.String(),
      durationMs: Type.Optional(Type.Number({ description: '默认 300ms' })),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'swipe', `${params.from}→${params.to}`);
      if (!gate.allowed) return denied('swipe');
      // from/to 为区域名时直接透传；元素描述先定位，失败转 LOCATE_MISS（见 resolveSwipeEndpoint）
      const fromEndpoint = await resolveSwipeEndpoint(params.from, locateWithCache);
      const toEndpoint = await resolveSwipeEndpoint(params.to, locateWithCache);
      for (const endpoint of [fromEndpoint, toEndpoint]) {
        if (endpoint && typeof endpoint === 'object' && endpoint.miss) {
          return locateMiss(endpoint.miss, endpoint.error, { fallback: `未找到滑动起点/终点元素：${endpoint.miss}` });
        }
      }
      const deviceResult = await device.swipe(fromEndpoint, toEndpoint, { durationMs: params.durationMs ?? DEFAULT_SWIPE_DURATION_MS });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: deviceResult.ok, from: params.from, to: params.to, latencyMs: deviceResult.latencyMs, error: deviceResult.error }) }],
        details: { ok: deviceResult.ok },
      };
    },
  });

  const scroll = defineTool({
    name: 'scroll',
    label: 'scroll',
    description: '滚动页面。direction 为内容语义：down=看更多下方内容（内容上移）/ up=回看上方内容 / left / right；distancePct=滚动距离（整屏100/半屏50，缺省约60）；until=edge 滚到底、until=top 回顶部；画面无变化（树 hash）即停。',
    parameters: Type.Object({
      direction: Type.String({ description: 'down（看更多下方内容，内容上移）/ up（回看上方）/ left / right' }),
      distancePct: Type.Optional(Type.Number({ description: '滚动距离（屏高百分比）：整屏=100、0.75屏=75、半屏=50' })),
      until: Type.Optional(Type.String({ description: "edge（滚到边界即停，用于'翻到最底部'）| top（回到顶部）| 目标 selector 字符串（小步滚动直到该元素在屏可见，抗 WebView fling 过冲）" })),
      max: Type.Optional(Type.Number({ description: '最大滚动次数，默认 5（until 时默认 20）' })),
      stopWhenNoChange: Type.Optional(Type.Boolean({ description: '默认 true' })),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'scroll', params.direction);
      if (!gate.allowed) return denied('scroll');
      // 冷启动期 getSize 失败等异常在此兜住：转结构化失败而非上抛（会把整个 run 判 error）
      let scrollResult;
      try {
        scrollResult = await resolveScrollParams(device, params);
      } catch (error) {
        return structuredFailure(error);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: !scrollResult.error, ...scrollResult }) }],
        details: { ok: !scrollResult.error, scrolls: scrollResult.scrolls, changed: scrollResult.changed, ...(scrollResult.found != null ? { found: scrollResult.found } : {}) },
      };
    },
  });

  const tapEachRow = defineTool({
    name: 'tap_each_row',
    label: 'tap_each_row',
    description: '问卷/表单逐行作答。**缺省（推荐）视觉模式**：不传 rows/tap，VLM 看图逐题定位未作答题目并点选其第一个选项（tap 后像素验证，未验证项下一轮 VLM 复核），App/问卷无关；maxRounds=轮数上限、verifyColor 指定选中色。selector 模式（传 rows=行 scope selector + tap=行内目标 selector）为确定性快路径，适合文案稳定的表单。',
    parameters: Type.Object({
      rows: Type.Optional(Type.String({ description: 'selector 模式：行 scope selector；不传=视觉模式（推荐）' })),
      tap: Type.Optional(Type.String({ description: 'selector 模式：行内目标 selector（取每行最左匹配）' })),
      stopWhen: Type.Optional(Type.String()),
      maxRounds: Type.Optional(Type.Number()),
      verify: Type.Optional(Type.Boolean({ description: '默认 true：tap 后做像素选中色校验' })),
      verifyColor: Type.Optional(Type.String({ description: "选中色：'auto'（蓝色启发式，默认）| '#RRGGBB'" })),
      profile: Type.Optional(Type.String({ description: "场景预设（按需加载，只含时序调优不含选择器）：questionnaire|form，或 ASK_PROFILE_DIR 下的自定义名" })),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'tap_each_row', params.rows ?? '视觉模式');
      if (!gate.allowed) return denied('tap_each_row');
      // try/catch 与 scroll 工具同款：冷启动 getSize 未就绪等异常转结构化失败，
      // 不上抛（上抛会把整个 run 判 error）
      let answerResult;
      try {
        if (!params.rows || !params.tap) {
          if (params.stopWhen) {
            const message = 'stopWhen 仅 selector 形态支持；视觉模式的终止条件内建（VLM 判定提交按钮可见且无未答题目）';
            return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], details: { ok: false, error: message } };
          }
          answerResult = await runVisualAnswerMode(ctx, params);
        } else {
          answerResult = await runSelectorAnswerMode(ctx, params);
        }
      } catch (error) {
        // 契约骨架兜底：异常时也返回完整形状，避免调用方读到 undefined
        answerResult = { rounds: 0, taps: 0, verified: 0, unverified: 0, done: false, bottom: false, skipped: [], error: String(error?.message ?? error) };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: !answerResult.error, ...answerResult }) }], details: { ok: !answerResult.error, ...answerResult } };
    },
  });
  const key = defineTool({
    name: 'key',
    label: 'key',
    description: '按系统键：back / home / enter / recent。',
    parameters: Type.Object({
      name: Type.String({ description: 'back|home|enter|recent' }),
    }),
    execute: async (_id, params) => {
      if (!SUPPORTED_KEY_NAMES.includes(params.name)) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `不支持的按键 ${params.name}` }) }], details: { ok: false } };
      }
      const gate = await confirmWrite(ctx, 'key', params.name);
      if (!gate.allowed) return denied('key');
      const deviceResult = await device.key(params.name);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: deviceResult.ok, key: params.name }) }], details: { ok: deviceResult.ok } };
    },
  });

  const launch = defineTool({
    name: 'launch',
    label: 'launch',
    description: '冷启动应用（包名或 包名/activity）。clean=true 时启动后自动清掉系统弹窗（权限/安装器）。',
    parameters: Type.Object({
      appId: Type.String(),
      clean: Type.Optional(Type.Boolean({ description: '启动后自动清弹窗（detectDialog + dismissDialog 最多 3 轮）' })),
    }),
    execute: async (_id, params) => {
      // 包名白名单（第一道防线，见 validateLaunchAppId）
      const validationError = validateLaunchAppId(params.appId);
      if (validationError) return textResult({ ok: false, error: validationError });
      const gate = await confirmWrite(ctx, 'launch', params.appId);
      if (!gate.allowed) return denied('launch');
      const deviceResult = await device.launch(params.appId);
      if (params.clean && deviceResult.ok) {
        await cleanLaunchPopups(ctx, device);
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...deviceResult, appId: params.appId }) }], details: { ok: deviceResult.ok } };
    },
  });

  const terminate = defineTool({
    name: 'terminate',
    label: 'terminate',
    description: '强杀应用进程。',
    parameters: Type.Object({ packageName: Type.String() }),
    execute: async (_id, params) => {
      // 包名白名单（第一道防线，同 launch）
      try { assertSafePackage(params.packageName); }
      catch (error) { return textResult({ ok: false, error: error.message }); }
      const gate = await confirmWrite(ctx, 'terminate', params.packageName);
      if (!gate.allowed) return denied('terminate');
      const deviceResult = await device.terminate(params.packageName);
      return { content: [{ type: 'text', text: JSON.stringify({ ...deviceResult, packageName: params.packageName }) }], details: { ok: deviceResult.ok } };
    },
  });

  return [tap, pointTap, longPress, input, swipe, scroll, tapEachRow, key, launch, terminate];
}

// 引擎专用工具：只给引擎直执行（buildToolCall）用，**不进模型工具面**。
// point_tap 存在的前提正是"模型不许给像素坐标"（tap.description 原话）——
// 若把它注册给模型，等于在模型侧放行像素坐标（DESIGN.md:978 禁止裸坐标）。buildTools 据此过滤。
export const ENGINE_ONLY_TOOLS = new Set(['point_tap']);