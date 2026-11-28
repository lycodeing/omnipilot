// run 循环编排（从 bin/ask.js runOne 下沉）。
//
// 设计意图：把"逐步执行 + 降级 + 断言判定 + 终态"的编排逻辑与设备/会话装配解耦，
// 使 agent 循环可用 fake session + fake device 单测（见 test/session-run-loop.test.js）。
// runOne 只负责装配（设备/recorder/store/ctx/模型/提示词/session/MCP/pregrant/网络还原/锁），
// 装配完调用本函数并接收 { status, engineFailed }。
//
// 参数（全部由调用方注入，闭包工厂在内部构造）：
//   ctx        createRunContext 产物（device/recorder/store/opts/vars/engineLog/assertions…）
//   session    createAskSession 产物（或 fake session）
//   recorder   RunRecorder
//   toolMap    工具名 → 工具实例（契约工具 + 引擎工具，与 session 共享引用）
//   planCache  动作计划缓存（get/put/delete）
//   gov        createContextGovernor 产物（四道治理 + foldToolHistory）
//   flags      CLI 标志
//   caseObj    用例对象（steps/source/name/context/allowCoords）
//   runDeadline 整 run 时间预算绝对毫秒（0 = 不限）
//   modelCfg   模型配置（family 用于坐标策略）
//
// 返回 Promise<{ status, engineFailed }>；不负责 recorder.finish / session.dispose / 输出 / 退出码
// （这些留在 runOne 收尾，属装配/进程边界）。
//
// 结构约定（单一职责拆分）：runCaseLoop 只做逐步骤调度与终态判定；各职责块提取为
// 模块级命名函数，外部依赖（ctx/session/recorder/gov/toolMap…）一律经参数显式传入，
// 不做跨函数闭包捕获。

import { REPLAY_ACTION_TYPES } from '../tools/vocab.js';
import { planKey } from './plan-cache.js';
import { ENGINE_TYPES, COORD_TYPES, buildToolCall } from './case-steps.js';
import { waitSelectorFromText, resolveLoopPlan } from './case-loop.js';
import { interpolate } from './case.js';
import { LOCATE_DEGRADE_POLICY, MARATHON_MARKER_WAIT_MS } from '../device/locate-policy.js';
import { screenSignature } from '../device/png.js';
import { lastAssistantText, makeAttachStepShot, makeFoldForGateway } from './run-loop-helpers.js';

// —— 命名常量（原散落在循环体内的魔法数字）——

// 非幂等/敏感工具：其调用被整段回放会在错误时机重复副作用或拿不到当次数据，
// 故含这些调用的步骤不写计划缓存。
const NON_IDEMPOTENT = new Set(['data_store', 'net_profile', 'terminate', 'secret_get', 'sms_read']);

// 上下文窗口默认保留的"有内容步"数（--context-steps / YAML context: 均未声明时）
const DEFAULT_CONTEXT_KEEP_STEPS = 3;
// 历史截图默认保留张数（--keep-images 未声明或非法时）
const DEFAULT_KEEP_IMAGES = 3;
// 旧工具结果截断：只保留最近 1 条完整（当前步所需），更早截断为摘要
const TOOL_RESULT_KEEP_RECENT = 1;
// 旧工具结果摘要保留字符数
const TOOL_RESULT_KEEP_CHARS = 300;
// aiWaitFor 默认超时毫秒（step.timeout 未声明时）
const DEFAULT_WAIT_TIMEOUT_MS = 10000;
// aiWaitFor 等树稳定的默认 quiet 档（quiet=1 更快但无稳定性校验）
const DEFAULT_WAIT_QUIET = 2;
// WebView 视觉确认：单次 waitForElement 的最小等待毫秒
const MIN_ELEMENT_WAIT_MS = 1500;
// WebView 视觉确认最大轮数
const MAX_VISUAL_CONFIRM_ROUNDS = 3;
// WebView 壳 App 页面加载慢，视觉确认轮间隔放宽到 5s
const VISUAL_CONFIRM_INTERVAL_MS = 500;
// aiAssert 会话催答最大轮数（不含 chat 兜底）
const MAX_ASSERT_NUDGE_ROUNDS = 3;
// ai/aiQuery 空轮重试最大次数
const MAX_EMPTY_ROUND_RETRIES = 3;
// 续作循环"完成自报"的最大回复长度（防长篇散文里 incidental 完成二字误判）
const SELF_DONE_MAX_ANSWER_LENGTH = 20;
// long_press 未声明 durationMs 时的默认长按毫秒
const DEFAULT_LONG_PRESS_DURATION_MS = 800;
// 批量接地截图压缩参数（一次看图为多目标预取坐标）
const BATCH_GROUND_IMAGE_MAX_WIDTH = 720;
const BATCH_GROUND_IMAGE_QUALITY = 70;
// 随 prompt 附屏的通用压缩参数（降级/断言/续作/催答共用）
const PROMPT_IMAGE_MAX_WIDTH = 540;
const PROMPT_IMAGE_QUALITY = 70;
// 批量接地回复无法解析时告警截取的字符数
const UNPARSEABLE_REPLY_LOG_CHARS = 80;
// 步骤标题在报告 steps[] 里的最大展示字符数
const STEP_TITLE_MAX_CHARS = 40;
// 批量接地的最少目标数（单目标无需批量）
const MIN_BATCH_GROUND_TARGETS = 2;
// 批量接地模型未提供坐标约定说明时的兜底文案
const DEFAULT_COORD_FORMAT_HINT = 'Return coordinates normalized to 0-1000.';

/**
 * 包装 toolMap 中所有工具的 execute，记录"本步实际使用的工具调用序列"（仅统计，不改行为）。
 * ai/aiAct 步结束时若全部调用成功，则缓存完整调用序列（plan）。toolMap 的契约工具与
 * session 共享同一实例，就地改写 execute 即覆盖模型路径的工具调用。
 * @param {Map<string, object>} toolMap 工具名 → 工具实例
 * @returns {{ calls: Array<{ tool: string, params: object, ok: boolean }> }} 记账容器（每步开头清空 calls）
 */
function instrumentToolCalls(toolMap) {
  const ledger = { calls: [] };
  for (const tool of toolMap.values()) {
    const originalExecute = tool.execute.bind(tool);
    tool.execute = async (callId, params, ...rest) => {
      const result = await originalExecute(callId, params, ...rest);
      ledger.calls.push({ tool: tool.name, params, ok: result?.details ? result.details.ok !== false : true });
      return result;
    };
  }
  return ledger;
}

/**
 * 构造步骤的计划缓存键：用例身份 + 步骤序号/文本 + 设备序列号 + 应用版本。
 * @returns {(stepIndex: number, stepText: string) => string}
 */
function makePlanKeyOf({ caseObj, device, ctx }) {
  return (stepIndex, stepText) => planKey({
    caseId: caseObj.source || caseObj.name || 'case',
    stepIndex,
    stepText,
    serial: device.serial ?? 'unknown',
    appVersion: ctx.appVersion ?? 'unknown',
  });
}

/**
 * 截取当前屏幕并压缩为可随 prompt 附带的小图（省一轮模型调 screen 的往返）。
 * 任何失败（取图/压缩/模块加载）都返回 null，由调用方决定退回无图路径。
 * @param {object} device 设备句柄
 * @param {{ maxWidth: number, quality: number }} options 压缩参数
 * @returns {Promise<{ buffer: Buffer, data: string, mimeType: string } | null>}
 */
async function captureCompressedScreen(device, { maxWidth, quality }) {
  try {
    const { compressForContext } = await import('../image/png.js');
    const screenshot = await device.screencap();
    const compressed = await compressForContext(screenshot.buffer, { maxWidth, quality });
    return { buffer: compressed.buffer, data: compressed.buffer.toString('base64'), mimeType: compressed.mimeType };
  } catch {
    return null;
  }
}

/**
 * 同屏批量视觉接地（性能）：一次看图为"当前步 + 后续连续引擎 tap 步"预取多个目标坐标，
 * 写入 device.vlmCache（键 tree.hash::target）。屏幕一变 hash 即变，预取坐标自动失效——
 * 跨转场无风险。触发时机：某 aiTap 引擎 MISS 进入 VLM 降级时顺带批量接地，
 * 后续步骤直接 vlmCacheHit，省掉每个目标一轮模型往返。
 * @returns {Promise<number>} 成功预取的目标数（任何前置条件不满足/失败均返回 0）
 */
async function batchGroundTargets({ ctx, device, steps, fromIndex, flags, modelCfg }) {
  if (!ctx.vlm || !ctx.chat || !device?.vlmCache) return 0;
  const targets = [];
  for (let scanIndex = fromIndex; scanIndex < steps.length && targets.length < LOCATE_DEGRADE_POLICY.batchGroundMaxTargets; scanIndex++) {
    const candidateStep = steps[scanIndex];
    if (candidateStep.type === 'sleep') continue; // sleep 不改屏幕，可跨过收集
    if (candidateStep.type !== 'aiTap' && candidateStep.type !== 'aiLongPress') break; // 遇改屏步骤即停
    const targetText = interpolate(candidateStep.text, ctx.vars);
    if (targetText && !targets.includes(targetText)) targets.push(targetText);
  }
  if (targets.length < MIN_BATCH_GROUND_TARGETS) return 0; // 单目标无需批量
  let tree;
  try { tree = await device.dumpTree(); } catch { return 0; }
  const screenSize = await device.screenSize().catch(() => null);
  if (!screenSize) return 0;
  const shot = await captureCompressedScreen(device, { maxWidth: BATCH_GROUND_IMAGE_MAX_WIDTH, quality: BATCH_GROUND_IMAGE_QUALITY });
  if (!shot) return 0;
  const { resolveStrategy } = await import('../device/coord/registry.js');
  const coordStrategy = resolveStrategy(modelCfg.family);
  const formatHint = coordStrategy?.describeForPrompt?.() || DEFAULT_COORD_FORMAT_HINT;
  const targetList = targets.map((targetText, targetIndex) => `${targetIndex + 1}. ${targetText}`).join('\n');
  let rawReply;
  try {
    rawReply = await ctx.chat(
      `Locate EACH of the following UI elements on this screenshot. For each, reply one JSON object {"i": <number>, "bbox": [x1,y1,x2,y2]} using this convention: ${formatHint} If an element is NOT visible, use {"i": <number>, "bbox": null}. Reply with ONLY a JSON array of ${targets.length} objects. Targets:\n${targetList}`,
      { images: [{ data: shot.data, mimeType: shot.mimeType }] },
    );
  } catch { return 0; }
  const parsedItems = await parseBatchGroundReply(rawReply);
  if (!Array.isArray(parsedItems)) {
    if (!flags.quiet && rawReply) console.warn('[engine] 批量接地回复无法解析：' + String(rawReply).slice(0, UNPARSEABLE_REPLY_LOG_CHARS));
    return 0;
  }
  let seededCount = 0;
  for (const item of parsedItems) {
    const targetIndex = Number(item?.i) - 1;
    const bboxRaw = item?.bbox;
    // bbox 可为数组（JSON 形态）或字符串（编号行回退形态）；toPixels/toNumbers 两者都吃
    const bboxText = Array.isArray(bboxRaw) ? bboxRaw.join(' ') : (typeof bboxRaw === 'string' ? bboxRaw : null);
    if (targetIndex < 0 || targetIndex >= targets.length || bboxText == null) continue;
    if (!/\d/.test(bboxText)) continue; // NOT_FOUND / 无坐标
    const converted = coordStrategy?.toPixels?.(bboxText, screenSize);
    if (!converted?.bounds || !converted.inScreen) continue;
    const identity = { text: '', contentDesc: targets[targetIndex], resourceId: '', cls: '', clickable: null };
    device.vlmCache.set(`${tree.hash}::${targets[targetIndex]}`, { bounds: converted.bounds, center: converted.center, identity });
    seededCount++;
  }
  if (seededCount && !flags.quiet) console.warn(`[engine] 批量视觉接地：一次看图预取 ${seededCount}/${targets.length} 个目标坐标`);
  return seededCount;
}

/**
 * 宽容解析批量接地的模型回复：标准 JSON 数组、包一层对象（{results:[...]}）、
 * 或编号行列表（"N. x1 y1 x2 y2" / "N: [x1,y1,x2,y2]"）三种形态都接受。
 * @param {*} rawReply 模型原始回复
 * @returns {Promise<Array | null>} 解析出的条目数组；无法解析返回 null
 */
async function parseBatchGroundReply(rawReply) {
  let items = null;
  try {
    const { repairJson } = await import('../tools/ai.js');
    items = repairJson(rawReply);
  } catch { items = null; }
  if (items && !Array.isArray(items) && typeof items === 'object') {
    items = items.results ?? items.list ?? items.items ?? items.bboxes ?? null;
  }
  if (!Array.isArray(items) && typeof rawReply === 'string' && /\d/.test(rawReply)) {
    // 编号行回退：每行 "N. x1 y1 x2 y2" 或 "N: [x1,y1,x2,y2]"
    const lineItems = [];
    for (const line of rawReply.split(/\r?\n/)) {
      const match = /^\s*(\d+)[.):、]\s*(.+)$/.exec(line);
      if (match) lineItems.push({ i: Number(match[1]), bbox: match[2] });
    }
    if (lineItems.length) items = lineItems;
  }
  return Array.isArray(items) ? items : null;
}

/**
 * 解析步骤上下文窗口配置（docs/CONTEXT-COMPRESSION-RESEARCH.md）：
 * 优先级 CLI > YAML 顶层 context: > 默认 3。'all'/'全部' = 不折叠（保留全部历史步原文）。
 * 非法值（<1 / 非整数 / 缺值）打告警并回退。
 * @returns {number} 保留的"有内容步"数（Infinity = 不折叠）
 */
function resolveContextKeepSteps({ flags, caseObj }) {
  const rawConfig = flags['context-steps'] ?? caseObj.context ?? DEFAULT_CONTEXT_KEEP_STEPS;
  const keepAll = /^(all|全部)$/i.test(String(rawConfig).trim());
  const numericConfig = Number(rawConfig);
  const keepSteps = keepAll ? Infinity : (Number.isFinite(numericConfig) ? Math.max(1, Math.trunc(numericConfig)) : DEFAULT_CONTEXT_KEEP_STEPS);
  if (!keepAll && Number.isFinite(numericConfig) && numericConfig < 1) console.warn(`[warn] --context-steps ${rawConfig} 非法（<1），已回退 ${DEFAULT_CONTEXT_KEEP_STEPS}`);
  if (!keepAll && Number.isFinite(numericConfig) && !Number.isInteger(numericConfig)) console.warn(`[warn] --context-steps ${rawConfig} 非整数，已取整为 ${keepSteps}`);
  if (flags['context-steps'] === true) console.warn(`[warn] --context-steps 需要一个值（n 或 all），已回退 ${DEFAULT_CONTEXT_KEEP_STEPS}`);
  return keepSteps;
}

/**
 * SDK 消息数组双路径兼容读取器（旧版 SDK 挂 session.messages）：取不到时 delta 记账为 0，
 * 首次取不到须有告警（只告警一次）。治理执行已迁 governor（读投影），本读取器只服务
 * 步间 delta 记账；每步 finally 治理后 refreshContext 把投影同步回 state.messages，
 * 记账与请求侧视图一致。
 * @returns {() => Array | null} 读取当前会话消息数组的函数
 */
function makeMessagesReader(session) {
  let warnedOnce = false;
  return () => {
    const messages = session?.agent?.state?.messages ?? session?.messages ?? null;
    if (!Array.isArray(messages) && !warnedOnce) {
      warnedOnce = true;
      console.warn('[warn] 未取到会话消息数组（SDK 路径变更？），步骤 delta 记账本轮全部跳过');
    }
    return Array.isArray(messages) ? messages : null;
  };
}

/**
 * sleep 步：纯等待指定秒数，记 ok 步并补终态取证截图。
 */
async function executeSleepStep({ step, recorder, attachStepShot, runDeadline }) {
  const handle = recorder.startStep('sleep', `${step.seconds}s`);
  const { interruptibleSleep } = await import('../device/poll.js');
  const durationMs = (step.seconds || 0) * 1000;
  const completed = await interruptibleSleep(durationMs, () => runDeadline && Date.now() > runDeadline);
  handle.end({ result: completed ? 'ok' : 'interrupted' });
  attachStepShot(handle.index);
}

/**
 * net 步：切网前先记账（§2.6，收尾/中断时据此还原档位），再切换网络档位并记事件。
 * 记账失败打告警并登记回滚项，但不阻断切网本身。
 */
async function executeNetStep({ step, ctx, device, recorder }) {
  const handle = recorder.startStep('net', step.profile);
  try {
    const { recordNetMutation } = await import('../state-mutations.js');
    await recordNetMutation(ctx, device, step.profile);
  } catch (error) {
    console.warn(`[warn] 切网记账失败（${error.message}）：设备可能无法自动还原档位`);
    try { recorder?.addRollback?.({ stepIndex: ctx.currentStepIndex ?? null, reason: `切网记账失败：${error.message}`, recovered: false }); } catch { /* ignore */ }
  }
  const netResult = await device.netSetProfile(step.profile);
  recorder.addNetworkEvent({ at: Date.now() - ctx.runStartMs, profile: step.profile });
  handle.end({ result: netResult.ok ? 'ok' : 'failed', error: netResult.ok ? null : (netResult.error || 'net 命令失败') });
}

/**
 * 对引擎步的全部字符串字段做 ${var} 运行期插值（rows/tap/until 等字段里的变量引用同样生效，
 * 否则会原样进 selector 静默 MISS）。返回浅拷贝，不改原步骤对象。
 */
function interpolateEngineStep(step, vars) {
  const interpolated = { ...step };
  for (const fieldName of Object.keys(interpolated)) {
    if (typeof interpolated[fieldName] === 'string') interpolated[fieldName] = interpolate(interpolated[fieldName], vars);
  }
  return interpolated;
}

/**
 * 判定引擎步结果是否为"定位 MISS"（可进入视觉降级链）。
 * 注意 locateMiss 把标记放在 details.code（details.error 可能为 undefined）。
 */
function isLocateMissResult(details) {
  const missText = `${details.code ?? ''} ${details.error ?? ''}`;
  return details.ok === false && /LOCATE_MISS|未找到目标/i.test(missText);
}

/**
 * 点击前后截屏比对，给「VLM 接地是否真的生效」留证据（只记 engineLog.verified，不改终态）。
 * screenSignature 排除状态栏（上下各跳 6%）+ 等距采样，避免时钟/通知/动画导致裸
 * Buffer.equals 恒 true。decodePng 对非 PNG 抛错 → verified=null（不臆断）。
 * @returns {Promise<boolean | null>} true=画面有变化；false=无变化；null=证据不可用
 */
async function verifyScreenChanged(device, beforeShot) {
  if (!beforeShot) return null;
  try {
    const afterShot = await device.screencap();
    const beforeBuffer = beforeShot.buffer ?? beforeShot;
    const afterBuffer = afterShot.buffer ?? afterShot;
    return Buffer.isBuffer(beforeBuffer) && Buffer.isBuffer(afterBuffer)
      ? screenSignature(beforeBuffer) !== screenSignature(afterBuffer)
      : null;
  } catch { return null; /* 截图不可用或解码失败不臆断 */ }
}

/**
 * LOCATE_MISS 一级降级：VLM 视觉接地（确定性：截图→坐标→family 策略转像素→tap/longPress），
 * 并记录点击前后画面差异证据。成功时撤销**本步**的失败标记（不能抹掉更早步骤的失败）。
 * @returns {Promise<{ handled: boolean, engineFailed: boolean }>}
 *   handled=true 表示本步已由 VLM 降级收尾（无论成败），主循环应 continue；
 *   handled=false 表示 VLM 未产出可用坐标，落 agent 轮降级。
 */
async function attemptVlmFallback({ ctx, device, step, interpStep, call, stepIndex, engineFailedBefore, flags }) {
  try {
    const locateResult = await device.locate(interpStep.text ?? step.text, { vlm: ctx.vlm });
    if (locateResult?.ok && locateResult.bounds) {
      // 点击前截屏：点击后比对像素留证据（画面变化≠点对了，不能当硬门槛）
      let beforeShot = null;
      try { beforeShot = await device.screencap(); } catch { /* 取图失败跳过校验 */ }
      const actionResult = call.tool === 'long_press'
        ? await device.longPress(locateResult.bounds, Number(step.durationMs) || DEFAULT_LONG_PRESS_DURATION_MS)
        : await device.tap(locateResult.bounds);
      const verified = await verifyScreenChanged(device, beforeShot);
      ctx.engineLog.push({ step: stepIndex, type: step.type + '+vlm-fallback', tool: call.tool, ok: actionResult?.ok !== false, error: actionResult?.error ?? null, verified });
      // VLM 降级成功 = 本步最终完成，只撤销本步的失败标记；降级仍失败则保留（终态判 fail）
      const engineFailed = actionResult?.ok !== false ? engineFailedBefore : true;
      if (!flags.quiet) console.warn('[engine] ' + step.type + ' 引擎 MISS → VLM 接地 ' + (actionResult?.ok !== false ? '成功' : '失败') + (verified === false ? '（点击前后画面无变化）' : ''));
      return { handled: true, engineFailed };
    }
  } catch { /* VLM 失败 → 落 agent 轮降级 */ }
  return { handled: false, engineFailed: true };
}

/**
 * LOCATE_MISS 二级降级：花**一轮** agent 往返让模型看屏接地并点击（随 prompt 附当前屏
 * 压缩图，免模型再花一轮调 screen）。如实记录降级结果：只算 engineStepsBefore 起算范围内
 * result==='ok' 的动作类工具步（不过滤会把引擎自身那条失败步误当"模型完成了动作"）。
 * @returns {Promise<boolean>} 更新后的 engineFailed（有成功动作步则只撤销本步标记）
 */
async function runAgentVisualFallback({ ctx, device, session, recorder, step, call, stepIndex, engineStepsBefore, engineFailedBefore, flags, foldForGateway }) {
  const verb = call.tool === 'long_press' ? '长按' : '点击';
  if (!flags.quiet) console.warn(`[engine] ${step.type} 定位失败，降级一轮视觉接地`);
  const fallbackShot = await captureCompressedScreen(device, { maxWidth: PROMPT_IMAGE_MAX_WIDTH, quality: PROMPT_IMAGE_QUALITY });
  const fallbackImages = fallbackShot ? [{ type: 'image', data: fallbackShot.data, mimeType: fallbackShot.mimeType }] : [];
  foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
  await session.prompt(
    `引擎定位失败，改用视觉接地：请在随附截屏对应的当前屏幕上找到并${verb}以下目标。**必须调用 ${call.tool} 工具完成${verb}**——只调 locate/uitree 查看不算完成本步。只这一次操作，做完即止，不要滚动/返回/做其它事：${step.text}\n若确实找不到，回复"未找到"并说明原因。`,
    { images: fallbackImages },
  );
  const acted = recorder.stepsSince(engineStepsBefore)
    .some((recordedStep) => REPLAY_ACTION_TYPES.includes(recordedStep.type) && recordedStep.result === 'ok');
  ctx.engineLog.push({ step: stepIndex, type: `${step.type}+visual-fallback`, tool: 'agent', ok: acted, error: acted ? null : '降级轮未产生成功的动作步' });
  // 有动作步 = 降级完成本步，只撤销本步的失败标记；无动作步 = 降级后仍失败，终态判 fail
  return acted ? engineFailedBefore : true;
}

/**
 * LOCATE_MISS 降级链编排：waitIdle（busy 态等树稳定）→ batchGround（同屏批量预取）→
 * VLM 单目标接地 → agent 视觉轮。树不可用/槽冲突时 waitIdle 与 batchGround 内部同样是
 * fresh dump，必超时空耗——跳过它们直接视觉接地；普通 MISS 仍走原等待
 * （等 idle 后目标回到 a11y 树是有效补救）。
 * @param {string | null} locateCode 结构化定位失败原因（details.locateCode 透传）
 * @returns {Promise<boolean>} 更新后的 engineFailed
 */
async function handleLocateMissDegrade({ ctx, device, session, recorder, steps, step, interpStep, call, stepIndex, locateCode, engineStepsBefore, engineFailedBefore, flags, modelCfg, foldForGateway }) {
  const treeUnavailable = locateCode === 'TREE_UNAVAILABLE' || locateCode === 'SIZE_UNAVAILABLE';
  // MISS 后直接走 VLM 视觉接地，不再 waitIdle。
  // VLM 看截图不需要 a11y 树稳定；等树是纯浪费（实测 15-90s 空耗）。
  // 如果目标在屏幕上可见，VLM 就能定位；不可见则等再久也没用。
  if (ctx.vlm) {
    // 批量预取仅在树可用时执行（依赖 tree.hash 做缓存键）
    if (!treeUnavailable) {
      try { await batchGroundTargets({ ctx, device, steps, fromIndex: stepIndex, flags, modelCfg }); } catch { /* 批量失败不阻断单目标降级 */ }
    }
    const vlmOutcome = await attemptVlmFallback({ ctx, device, step, interpStep, call, stepIndex, engineFailedBefore, flags });
    if (vlmOutcome.handled) return vlmOutcome.engineFailed;
  }
  // VLM 失败或无 VLM：一轮 agent 视觉接地往返
  return runAgentVisualFallback({ ctx, device, session, recorder, step, call, stepIndex, engineStepsBefore, engineFailedBefore, flags, foldForGateway });
}

/**
 * 引擎直执行步骤（§2.4 混合执行）：aiTap/aiInput/aiLongPress/aiKeyboardPress/aiScroll/
 * launch/terminate 直接调对应工具（复用工具层记账），不经 agent 选工具——0 轮模型往返。
 * 结果**不进 session**（那会多一轮 LLM 请求）；记录到 ctx.engineLog 供 run 内排查。
 * 定位 MISS 时进入降级链（handleLocateMissDegrade）。
 * @returns {Promise<{ handled: boolean, engineFailed: boolean }>}
 *   handled=false 表示该步不是引擎步（或找不到工具且无 call），交回主循环走 agent 路径。
 */
async function executeEngineStep({ ctx, device, session, recorder, toolMap, steps, step, stepIndex, caseObj, flags, modelCfg, engineFailed, foldForGateway }) {
  if (!(ENGINE_TYPES.has(step.type) || COORD_TYPES.has(step.type))) {
    return { handled: false, engineFailed };
  }
  // 坐标步运行期门控（装载期已按 YAML allowCoords 拒绝过；此处兜住 --allow-coords 与
  // 手改 caseObj 的路径）：未开启则拒绝执行，绝不让坐标点击"悄悄发生/悄悄不发生"。
  if (COORD_TYPES.has(step.type) && !(caseObj.allowCoords || flags['allow-coords'])) {
    const message = `坐标步骤 ${step.type}: { x: ${step.x}, y: ${step.y} } 被拒绝执行：未开启 allowCoords（用例顶层加 allowCoords: true，或传 --allow-coords）`;
    console.warn(`[warn] ${message}`);
    const handle = recorder.startStep(step.type, `(${step.x},${step.y})`);
    handle.end({ result: 'failed', error: message });
    // 报告取证截图由调用方补（attachStepShot 属主循环装配）
    return { handled: true, engineFailed, rejectedCoordHandleIndex: handle.index };
  }
  const interpStep = interpolateEngineStep(step, ctx.vars);
  const call = buildToolCall(interpStep);
  if (!call) return { handled: false, engineFailed };
  const tool = toolMap.get(call.tool);
  if (!tool) {
    console.warn(`[warn] 引擎步骤 ${step.type} 找不到工具 ${call.tool}`);
    return { handled: false, engineFailed };
  }
  // engineStepsBefore：本步执行前的记账步数，视觉降级轮据此判断模型是否真调了动作工具。
  // engineFailedBefore：进入本步前已有的失败标记——降级成功只撤销**本步**的标记，
  // 不能把更早步骤的失败一并抹掉（否则前面引擎步失败的 run 又恒 pass）。
  const engineStepsBefore = recorder.stepCount;
  const engineFailedBefore = engineFailed;
  const result = await tool.execute(`engine-${stepIndex}`, call.params, null, null, {});
  const details = result?.details ?? {};
  ctx.engineLog.push({ step: stepIndex, type: step.type, tool: call.tool, ok: details.ok !== false, error: details.error ?? null });
  if (details.ok === false) console.warn(`[engine] ${step.type}「${step.text ?? ''}」失败：${details.error || ''}`);
  // 引擎步失败（含降级后仍失败）必须影响终态——零断言用例的 exit 0 不代表任务完成
  let nextEngineFailed = details.ok === false ? true : engineFailed;
  const isLocateMiss = isLocateMissResult(details);
  const isTapFamily = call.tool === 'tap' || call.tool === 'long_press';
  if (isLocateMiss && isTapFamily) {
    nextEngineFailed = await handleLocateMissDegrade({
      ctx, device, session, recorder, steps, step, interpStep, call, stepIndex,
      locateCode: details.locateCode ?? null,
      engineStepsBefore, engineFailedBefore, engineFailed: nextEngineFailed,
      flags, modelCfg, foldForGateway,
    });
  }
  return { handled: true, engineFailed: nextEngineFailed };
}

/**
 * aiWaitFor 的"等具体元素出现"路径：WebView 壳 App（uni-app 等）会把未打开的页面预渲染进
 * accessibility 树（bounds 在屏内但不可见）→ 树等待误报 appeared。命中节点在 WebView
 * 容器内时加视觉确认（附截图问模型目标是否真可见），最多 3 轮、轮间睡 5s。
 * 否定优先：仅当模型**明确**答 NOT_VISIBLE/不可见 才判未确认；空响应或肯定一律放行
 * （全 WebView 壳 App 每次树命中都要过确认，把网关空响应当"不可见"会误判在屏元素）。
 * @returns {Promise<{ confirmed: boolean, confirmRounds: number, lastWaitResult: object | undefined }>}
 */
async function waitForElementWithVisualConfirm({ device, session, selector, timeoutMs, foldForGateway }) {
  const startTime = Date.now();
  let confirmed = false;
  let confirmRounds = 0;
  let lastWaitResult;
  while (Date.now() - startTime < timeoutMs) {
    lastWaitResult = await device.waitForElement(selector, { timeoutMs: Math.max(MIN_ELEMENT_WAIT_MS, timeoutMs - (Date.now() - startTime)) });
    if (!lastWaitResult?.appeared) break;
    if (!lastWaitResult.inWebView) { confirmed = true; break; }
    if (confirmRounds >= MAX_VISUAL_CONFIRM_ROUNDS) break;
    confirmRounds++;
    const confirmShot = await captureCompressedScreen(device, { maxWidth: PROMPT_IMAGE_MAX_WIDTH, quality: PROMPT_IMAGE_QUALITY });
    if (!confirmShot) { confirmed = true; break; /* 取图失败按命中处理，不卡流程 */ }
    const confirmImages = [{ type: 'image', data: confirmShot.data, mimeType: confirmShot.mimeType }];
    foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
    await session.prompt(
      `视觉确认（不要调用任何工具）：随附截屏中，目标元素「${selector}」当前是否真实可见？若可见回复 VISIBLE；若不可见（隐藏层/未打开的页面/不在屏上）回复 NOT_VISIBLE。只回复这一个词。`,
      { images: confirmImages },
    );
    let answerText = lastAssistantText(session);
    if (!answerText) {
      // 空响应（网关偶发）：重问一次再判，降低"隐藏层+空响应"漏检概率
      foldForGateway();
      await session.prompt('只回复一个词：VISIBLE 或 NOT_VISIBLE。', { images: confirmImages });
      answerText = lastAssistantText(session);
    }
    const explicitNo = answerText && /(NOT_VISIBLE|不可见|未见|未出现|不存在|隐藏|预渲染)/i.test(answerText);
    if (!explicitNo) { confirmed = true; break; }
    if (Date.now() - startTime >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, VISUAL_CONFIRM_INTERVAL_MS));
  }
  return { confirmed, confirmRounds, lastWaitResult };
}

/**
 * aiWaitFor 步（§21）：**优先"等具体元素出现"**（语义化、通常更快：首次 dump 命中即返回），
 * 无法解析出具体元素时退回"等树稳定"（quiet 可配，默认 2）。纯引擎，不调模型
 * （WebView 命中的视觉确认除外）。显式 selector 参数行优先；散文解析仅作未声明时的兜底。
 */
async function handleAiWaitFor({ step, stepText, device, session, recorder, flags, attachStepShot, foldForGateway }) {
  const handle = recorder.startStep('aiWaitFor', stepText ? stepText.slice(0, STEP_TITLE_MAX_CHARS) : '');
  const timeoutMs = Number(step.timeout) || DEFAULT_WAIT_TIMEOUT_MS;
  const quietLevel = step.quiet != null ? Number(step.quiet) : DEFAULT_WAIT_QUIET;
  const selector = (step.selector && String(step.selector).trim())
    ? (waitSelectorFromText(String(step.selector)) || String(step.selector).trim())
    : waitSelectorFromText(stepText);
  if (selector) {
    const { confirmed, confirmRounds } = await waitForElementWithVisualConfirm({ device, session, selector, timeoutMs, foldForGateway });
    handle.end({ result: confirmed ? 'ok' : 'failed' });
    attachStepShot(handle.index); // 报告取证：aiWaitFor 步没有工具层截图钩子，这里补终态截图
    if (!confirmed && !flags.quiet) console.warn(`[warn] aiWaitFor「${stepText}」未见真实可见元素（${selector}，视觉确认 ${confirmRounds} 轮）`);
  } else {
    await device.waitIdle({ quiet: quietLevel, timeoutMs });
    handle.end({ result: 'ok' });
    attachStepShot(handle.index);
  }
}

/**
 * 构建 aiAssert 的判定输入：当前屏压缩图（省一轮 screen 往返）+ 前台包名系统事实
 * （截图无法表达"前台是哪个包"，不注入会诱导模型调工具核实导致无文本输出）+
 * 数据集事实（C-P2：文本引用数据集时注入行数与样本，不再让模型凭截图猜测）。
 * 任一采集失败都不阻断断言（回退旧屏幕口径模板）。
 * @returns {Promise<{ promptImages: Array, assertShotBuffer: Buffer | null, promptText: string, datasetFacts: * }>}
 */
async function buildAssertInputs({ stepText, device, ctx }) {
  let promptImages = [];
  // 判定输入截图的原始压缩 buffer（Task 14）：promptImages 里是 base64 字符串，
  // 判定段需要 buffer 本身落盘为 assert-<i>.png（JPEG 也按魔数处理），故单独保留。
  let assertShotBuffer = null;
  let foregroundNote = '';
  const assertShot = await captureCompressedScreen(device, { maxWidth: PROMPT_IMAGE_MAX_WIDTH, quality: PROMPT_IMAGE_QUALITY });
  if (assertShot) {
    assertShotBuffer = assertShot.buffer;
    promptImages = [{ type: 'image', data: assertShot.data, mimeType: assertShot.mimeType }];
  }
  try {
    const foreground = await device.foreground();
    if (foreground?.package) foregroundNote = `\n（系统事实：当前前台包名为 ${foreground.package}，Activity 为 ${foreground.activity ?? '未知'}）`;
  } catch { /* 前台事实缺失不阻断 */ }
  let datasetFacts = null;
  let buildAssertPrompt = null;
  try {
    const assertPromptModule = await import('./assert-prompt.js');
    buildAssertPrompt = assertPromptModule.buildAssertPrompt;
    datasetFacts = await assertPromptModule.collectDatasetFacts(stepText, ctx.datasetWrites, ctx.store);
  } catch { /* 事实采集失败不阻断断言（含模块加载失败，下方回退旧屏幕口径模板） */ }
  const promptText = buildAssertPrompt
    ? buildAssertPrompt({ stepText, fgNote: foregroundNote, datasetFacts })
    : `【断言】${stepText}${foregroundNote}\n只依据随附的当前屏幕截图与上述系统事实判断，不要调用任何工具。只输出一行 JSON：{"passed": true/false, "reason": "不超过30字"}。`;
  return { promptImages, assertShotBuffer, promptText, datasetFacts };
}

/**
 * 动作计划缓存回放（0 模型往返）：命中即按序回放缓存的调用序列；任一失败删条目并
 * 落回模型规划（重新学习后重写）。回放全部成功时补最后一步的终态取证截图
 * （M6：recorder.stepCount 是"下一个"索引，回放产生的最后一步索引是 stepCount-1）。
 * @returns {Promise<boolean>} true=回放成功（本步收尾，主循环 continue）；false=走模型路径
 */
async function replayPlanCache({ planCache, cacheKey, stepIndex, toolMap, lastTool, recorder, flags, attachStepShot }) {
  const cached = planCache.get(cacheKey);
  const plan = Array.isArray(cached?.plan) && cached.plan.length ? cached.plan : (cached ? [cached] : null);
  if (!plan) return false;
  if (!flags.quiet) console.warn(`[plan-cache] 步骤 ${stepIndex} 命中缓存，回放 ${plan.length} 个调用（省模型往返）`);
  let allOk = true;
  lastTool.calls = [];
  for (const cachedCall of plan) {
    const tool = toolMap.get(cachedCall.tool);
    if (!tool) { allOk = false; break; }
    const result = await tool.execute(`plan-${stepIndex}`, cachedCall.params);
    if (result?.details?.ok === false) { allOk = false; break; }
  }
  if (allOk) {
    attachStepShot(recorder.stepCount - 1); // 回放步终态取证
    return true;
  }
  if (!flags.quiet) console.warn('[plan-cache] 回放未成功，回退模型规划');
  planCache.delete(cacheKey);
  lastTool.calls = []; // 丢弃回放期的半程调用，模型路径重新记账
  return false;
}

/**
 * 计划缓存写入：全部工具调用成功、且不含非幂等工具的 ai/aiAct 步记完整 plan；
 * 马拉松步不缓存（其续作依赖逐轮页面状态，整段回放不安全——Midscene 同款取舍）。
 * 非幂等工具（写库/切网/终止进程/读凭据/读短信）的调用若被整段回放，会在错误时机
 * 重复产生副作用或读不到当次数据，故一律不进计划缓存。
 */
function writePlanCache({ planCache, cacheKey, marathonRan, lastTool }) {
  if (cacheKey && !marathonRan
    && lastTool.calls.length >= 1
    && lastTool.calls.every((recordedCall) => recordedCall.ok)
    && lastTool.calls.every((recordedCall) => !NON_IDEMPOTENT.has(recordedCall.tool))) {
    planCache.put(cacheKey, {
      tool: lastTool.calls[0].tool,
      params: lastTool.calls[0].params,
      plan: lastTool.calls.map((recordedCall) => ({ tool: recordedCall.tool, params: recordedCall.params })),
    });
  }
}

/**
 * 续作循环（ai/aiAct 步）：长任务步模型常做一两个动作就收尾（如 27 题只答 1 题）。
 * 触发与参数见 case.js resolveLoopPlan：步级显式 until/maxRounds/batch 优先，
 * 散文关键词（直到/重复/逐题/每一题/依次）为存量用例兼容路径。每轮先查完成自报
 * （短回复含"完成"/BLOCKED）与终止标记确定性检测，最多 maxRounds 轮。
 * @returns {Promise<{ answer: string | null, marathonRan: boolean }>}
 *   marathonRan=true 表示发生过续作催促（该步不写计划缓存）。
 */
async function runMarathonLoop({ loopPlan, answer, promptText, device, session, flags, runDeadline, foldForGateway }) {
  const { marker: marathonMarker, batch: loopBatch, maxRounds: loopMaxRounds } = loopPlan;
  let currentAnswer = answer;
  let marathonRan = false;
  for (let resumeRound = 0; resumeRound < loopMaxRounds; resumeRound++) {
    if (runDeadline && Date.now() > runDeadline) { console.warn('[timeout] 步内催促超 --timeout 预算，提前收束'); break; }
    // 完成自报：催促词让模型"终止条件已满足回复'完成'"，循环须检查 answer，
    // 否则模型每轮回"完成"仍会被逼答满轮数上限（单步空耗 24-88 分钟）。
    // 仅认"短回复含完成"（防长篇散文里 incidental 完成二字误判）；BLOCKED 同义结束。
    const selfDone = currentAnswer && currentAnswer.length <= SELF_DONE_MAX_ANSWER_LENGTH && /完成/i.test(currentAnswer);
    if (currentAnswer && (/BLOCKED/i.test(currentAnswer) || selfDone)) break;
    // 确定性终止检测：终止标记元素已可见 → 任务完成，结束循环
    if (marathonMarker) {
      try {
        const markerResult = await device.waitForElement(marathonMarker, { timeoutMs: MARATHON_MARKER_WAIT_MS });
        if (markerResult?.appeared) break;
      } catch { /* 检测失败继续催 */ }
    }
    marathonRan = true;
    if (!flags.quiet) console.warn(`[warn] 马拉松步未完成（终止标记未满足），催促继续 ${resumeRound + 1}/${loopMaxRounds}`);
    // 每轮取新截图：题目推进后屏幕已变，步首旧图会误导模型
    const freshShot = await captureCompressedScreen(device, { maxWidth: PROMPT_IMAGE_MAX_WIDTH, quality: PROMPT_IMAGE_QUALITY });
    const freshImages = freshShot ? [{ type: 'image', data: freshShot.data, mimeType: freshShot.mimeType }] : [];
    foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
    // 催促话术按形态分流：batch=true 用并行话术；false（显式缺省）= 逐个处理
    // （避免把"依次逐个"类任务催成整屏并行点击）。
    const nudgeText = loopBatch
      ? `任务尚未完成（终止条件未满足）。继续执行：${promptText}\n（高效做法：一次 uitree 看清当前屏全部待处理项，然后**一轮并行 tap** 处理完本屏所有项，再滚动看下一屏；若终止条件已满足回复”完成”，无法继续回复”BLOCKED: 原因”）`
      : `任务尚未完成（终止条件未满足）。继续执行：${promptText}\n（逐个处理：每轮只处理**一个**待办项——先 uitree 看清当前屏，定位并操作下一项，完成即结束本轮回复；需要看更多内容就滚动后下一轮再处理；若终止条件已满足回复”完成”，无法继续回复”BLOCKED: 原因”）`;
    await session.prompt(nudgeText, { images: freshImages });
    currentAnswer = lastAssistantText(session);
  }
  return { answer: currentAnswer, marathonRan };
}

/**
 * 空轮检测重试（ai/aiQuery 步）：无文本且无工具调用 = 模型空转（网关/模型偶发空响应）
 * → 附屏重试。第 2 次重试去图（网关对"带图+短文本"偶发空响应）并要求显式 BLOCKED 回复：
 * 把"静默空转"变成可观测结果（进报告 thought），否则 ai 步静默无操作会让后续步骤连锁失败。
 * @returns {Promise<string | null>} 重试后的回答文本
 */
async function retryEmptyRound({ answer, promptText, aiImages, session, flags, runDeadline, foldForGateway }) {
  let currentAnswer = answer;
  for (let retryIndex = 0; retryIndex < MAX_EMPTY_ROUND_RETRIES && !currentAnswer; retryIndex++) {
    if (runDeadline && Date.now() > runDeadline) { console.warn('[timeout] 空轮重试超 --timeout 预算，停止重试'); break; }
    const retryImages = retryIndex === 0 ? aiImages : [];
    if (!flags.quiet) console.warn(`[warn] 模型空轮（无文本无工具），重试 ${retryIndex + 1}/${MAX_EMPTY_ROUND_RETRIES}（${retryIndex === 0 ? '附屏' : retryIndex === 1 ? '去图' : '换措辞去图'}）`);
    const extraText = retryIndex === 0
      ? '（随附当前屏幕截图；直接调用工具执行，不要只描述意图）'
      : retryIndex === 1
      ? '（第二次重试。你必须现在调用至少一个工具执行上述任务；若确实无法执行，回复一行：BLOCKED: <原因>）'
      : '（第三次重试，换一种说法）请执行：' + promptText + '。直接调用工具；无法执行则回复 BLOCKED: 原因';
    foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
    await session.prompt(`${promptText}\n${extraText}`, { images: retryImages });
    currentAnswer = lastAssistantText(session);
  }
  return currentAnswer;
}

/**
 * aiAssert 催答：模型以纯 toolCall 或空消息收尾（网关/模型偶发空响应）→ 最多催答 3 轮
 * （第 2 轮起附当前屏图：空响应多发生在"长上下文+无图"轮）。会话催答耗尽仍空时用
 * 无状态单发 chat 兜底判定（不依赖会话历史）。
 * @returns {Promise<{ answer: string | null, nudges: number }>} nudges 含 chat 兜底，落 assertions[].nudges
 */
async function nudgeAssertAnswer({ answer, stepText, device, session, ctx, foldForGateway }) {
  let currentAnswer = answer;
  let nudges = 0;
  for (let nudgeRound = 0; nudgeRound < MAX_ASSERT_NUDGE_ROUNDS && !currentAnswer; nudgeRound++) {
    nudges = nudgeRound + 1;
    let nudgeImages = [];
    if (nudgeRound >= 1) {
      const nudgeShot = await captureCompressedScreen(device, { maxWidth: PROMPT_IMAGE_MAX_WIDTH, quality: PROMPT_IMAGE_QUALITY });
      if (nudgeShot) nudgeImages = [{ type: 'image', data: nudgeShot.data, mimeType: nudgeShot.mimeType }];
    }
    foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
    await session.prompt('不要再调用工具。直接输出一行 JSON：{"passed": true/false, "reason": "不超过30字"}', { images: nudgeImages });
    currentAnswer = lastAssistantText(session);
  }
  if (!currentAnswer && ctx.chat) {
    // 会话催答耗尽仍空（长上下文空响应）：无状态单发 chat 兜底判定
    nudges++; // 兜底也是一次催答，计入轮数
    try {
      const fallbackShot = await captureCompressedScreen(device, { maxWidth: PROMPT_IMAGE_MAX_WIDTH, quality: PROMPT_IMAGE_QUALITY });
      const fallbackImages = fallbackShot ? [{ data: fallbackShot.data, mimeType: fallbackShot.mimeType }] : [];
      currentAnswer = await ctx.chat(
        `【断言】${stepText}
只依据随附截图判断。只输出一行 JSON：{"passed": true/false, "reason": "不超过30字"}`,
        { images: fallbackImages },
      );
    } catch { /* 兜底失败维持无输出 */ }
  }
  return { answer: currentAnswer, nudges };
}

/**
 * aiQuery 收尾催报：查询步已执行工具但无收尾文本 → 催一句结果汇报（1 轮）。
 * 带 name 的落库形态若还没调 data_extract/data_store，先放行落库再汇报——
 * 一刀切"不要再调用工具"会把落库也掐死（数据集会落成 0 条）。
 * @returns {Promise<string | null>} 催报后的回答文本
 */
async function nudgeQueryReport({ step, session, recorder, stepsBefore, foldForGateway }) {
  const needStore = step.name && !recorder.stepsSince(stepsBefore).some((recordedStep) => /data_extract|data_store/.test(recordedStep.type || ''));
  foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
  await session.prompt(
    needStore
      ? `还没把结果落到数据集「${step.name}」。现在就调用一次 data_extract（或 data_store）完成落库，然后用一句话报告结果。`
      : '不要再调用工具。用一句话报告你刚才查询/提取到的结果。',
    { images: [] },
  );
  return lastAssistantText(session);
}

/**
 * aiAssert 判定与记账：除 assertions[] 外补 startStep/end + 终态取证截图，
 * 让耗时、终态截图、催答轮数在 steps[]/报告时间线可见。判定输入截图独立落盘
 * （Task 14）：assertIndex 用判定前已记账的断言数，文件名 assert-<i>.png。
 * evidenceSource：注入了数据集事实 → dataset 口径；否则屏幕口径。
 */
async function recordAssertVerdict({ step, stepText, answer, assertShotBuffer, datasetFacts, assertNudges, ctx, recorder, attachStepShot }) {
  const handle = recorder.startStep('aiAssert', stepText.slice(0, STEP_TITLE_MAX_CHARS));
  const { parseVerdict } = await import('../tools/ai.js');
  const verdict = parseVerdict(answer);
  handle.end({ result: verdict.passed ? 'ok' : 'failed', error: verdict.passed ? null : verdict.reason, thought: answer });
  attachStepShot(handle.index); // 报告取证：判定后的画面状态（走既有 step 索引机制）
  let screenshotRelPath = null;
  if (assertShotBuffer) {
    screenshotRelPath = recorder.attachAssertionShot(ctx.assertions.length, assertShotBuffer);
  }
  recorder.addAssertion({ text: step.text, passed: verdict.passed, reason: verdict.reason, evidenceSource: datasetFacts ? 'dataset' : 'screen', nudges: assertNudges, screenshotId: screenshotRelPath });
  ctx.assertions.push({ text: step.text, passed: verdict.passed, reason: verdict.reason });
}

/**
 * 步间上下文治理（每步 finally 执行，全部经 governor 落 appendContextEdit，
 * 对实际请求生效，持久化历史留原文）：
 * 1) 截图剪枝（§16）：保留最近 N 张图（--keep-images，默认 3），更早替换为文字占位符；
 * 2) 旧工具结果截断：uitree/screen_diff 单条 20-40KB，只保留最近 1 条完整，更早截断为摘要；
 * 3) 旧工具轮全折叠为纯文本（keepRecent=0）：网关对 role:tool 历史偶发 400/空响应；
 * 4) 步骤上下文窗口（第四道治理）：超过 keepSteps 个"有内容步"时把最旧步骤原文删除，
 *    替换为一条确定性整体描述（0 额外 LLM 轮次）。
 * 三层剪枝**必须先于窗口折叠**执行：折叠删除消息段时两段都已是纯文本，
 * 不依赖顺序巧合（role:'tool' 残留会触发网关 400）。任何一道失败都不阻断。
 */
async function applyContextGovernance({ ctx, gov, recorder, steps, caseObj, flags, contextKeep }) {
  try {
    const keepImagesConfig = Number(flags['keep-images']);
    const imagePrune = gov.pruneImages({ keepRecent: Number.isFinite(keepImagesConfig) && keepImagesConfig >= 1 ? keepImagesConfig : DEFAULT_KEEP_IMAGES });
    if (imagePrune.replaced > 0) ctx.imagesPruned = (ctx.imagesPruned || 0) + imagePrune.replaced;
    const toolResultPrune = gov.pruneToolResults({ keepRecent: TOOL_RESULT_KEEP_RECENT, keepChars: TOOL_RESULT_KEEP_CHARS });
    if (toolResultPrune.replaced > 0) ctx.toolResultsPruned = (ctx.toolResultsPruned || 0) + toolResultPrune.replaced;
    const toolHistoryPrune = gov.pruneToolHistory({ keepRecent: 0 });
    if (toolHistoryPrune.folded > 0) ctx.toolHistoryFolded = (ctx.toolHistoryFolded || 0) + toolHistoryPrune.folded;
  } catch { /* 剪枝失败不阻断 */ }
  try {
    if (Number.isFinite(contextKeep) && ctx.stepMsgCounts.length > contextKeep) {
      const { buildStepDigest } = await import('./context-window.js');
      const digest = buildStepDigest({
        caseName: caseObj.name,
        caseTotal: steps.length,
        steps: recorder.stepsSince(0),
        assertions: ctx.assertions,
        vars: ctx.vars,
        datasets: ctx.datasetWrites ?? null,
      });
      const windowPrune = gov.pruneStepHistory(ctx.stepMsgCounts, { keepSteps: contextKeep, digest });
      if (windowPrune.changed && !flags.quiet) console.warn(`[context] 窗口折叠：移除最旧 ${windowPrune.removed} 条消息，保留最近 ${contextKeep} 步原文 + 整体描述`);
    }
  } catch { /* 窗口治理失败不阻断 */ }
}

export async function runCaseLoop({ ctx, session, recorder, toolMap, planCache, gov, flags, caseObj, runDeadline, modelCfg } = {}) {
  const device = ctx.device;
  const steps = caseObj.steps;
  let status = 'pass';
  let engineFailed = false; // 引擎步失败标记（含降级后仍失败）：零断言用例不能因 exit 0 恒判 pass

  const lastTool = instrumentToolCalls(toolMap);
  const planKeyOf = makePlanKeyOf({ caseObj, device, ctx });

  // 非 tool 路径（aiWaitFor 等直记账的步）的报告取证截图：fire-and-forget
  const attachStepShot = makeAttachStepShot(device, recorder);
  // 步内第 2 轮起的 prompt 前先折叠 role:tool 历史（网关 400 防护）
  const foldForGateway = makeFoldForGateway(gov);

  const contextKeep = resolveContextKeepSteps({ flags, caseObj });
  const getMessages = makeMessagesReader(session);
  ctx.stepMsgCounts = []; // 每步产生的消息数（delta），供 pruneStepHistory 分段（delta 跨多轮剪枝稳定）
  const pushStepMsgDelta = () => {
    try { ctx.stepMsgCounts.push(Math.max(0, (getMessages()?.length ?? 0) - (ctx._msgStart ?? 0))); } catch { /* 记账失败不阻断 */ }
  };

  // --continue/--session 恢复的历史可能含 role:tool 轮（网关 400）：主循环前先折叠一次
  try { gov.foldToolHistory(); session.refreshContext?.(); } catch { /* 折叠失败不阻断 */ }

  // 逐步骤执行。ai/aiQuery/aiAssert 的设备动作由工具记账包装自动写入 steps[]（§14.1），
  // 这里只记用例级的 net/sleep/aiWaitFor（它们不走工具层）。
  // ${var} 逐步插值（§7.5 执行期插值）：data_extract 运行期写入的变量对后续步骤生效。
  // 不做整体预插值——那样运行期变量永远取不到（C2 验证暴露）。
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    // 整 run 时间预算（--timeout）：到点即止，剩余步骤跳过。
    if (runDeadline && Date.now() > runDeadline) {
      console.warn(`[timeout] 已超 --timeout 预算（${Math.round((ctx.opts?.timeoutMs ?? 0) / 1000)}s），剩余 ${steps.length - stepIndex} 步跳过`);
      status = 'timeout';
      break;
    }
    const step = steps[stepIndex];
    ctx.currentStepIndex = stepIndex;
    // 坐标缓存键（§2.1）：步骤身份 + 该步骤内定位序号；每步重置 ordinal
    ctx.currentStepKey = { caseId: caseObj.source || caseObj.name || 'case', stepIndex };
    ctx.locateOrdinal = 0;
    ctx._msgStart = getMessages()?.length ?? 0; // 本步开始时的消息数（上下文窗口分段用）
    try {
      if (step.type === 'sleep') {
        await executeSleepStep({ step, recorder, attachStepShot, runDeadline });
        continue;
      }
      if (step.type === 'net') {
        await executeNetStep({ step, ctx, device, recorder });
        continue;
      }
      // 引擎直执行步骤（§2.4 混合执行）：不经 agent 选工具，MISS 时走降级链
      const engineOutcome = await executeEngineStep({
        ctx, device, session, recorder, toolMap, steps, step, stepIndex,
        caseObj, flags, modelCfg, engineFailed, foldForGateway,
      });
      engineFailed = engineOutcome.engineFailed;
      if (engineOutcome.handled) {
        if (engineOutcome.rejectedCoordHandleIndex != null) attachStepShot(engineOutcome.rejectedCoordHandleIndex);
        continue;
      }

      // ai / aiQuery → agent prompt；aiAssert → 断言判定；aiWaitFor → 等稳定(+条件)
      const stepText = interpolate(step.text, ctx.vars);

      if (step.type === 'aiWaitFor') {
        await handleAiWaitFor({ step, stepText, device, session, recorder, flags, attachStepShot, foldForGateway });
        continue;
      }

      // aiAssert：判定输入（附图 + 前台事实 + 数据集事实）；其余步附当前屏压缩图
      // （模型无需先调 screen 就能看到画面，且避免"历史有图、本轮无图"诱发网关空响应）。
      let promptImages = [];
      let assertShotBuffer = null;
      let datasetFacts = null;
      let promptText;
      if (step.type === 'aiAssert') {
        const assertInputs = await buildAssertInputs({ stepText, device, ctx });
        promptImages = assertInputs.promptImages;
        assertShotBuffer = assertInputs.assertShotBuffer;
        datasetFacts = assertInputs.datasetFacts;
        promptText = assertInputs.promptText;
      } else {
        promptText = (step.type === 'aiQuery' && step.name)
          ? `${stepText}\n（把结果用 data_extract 或 data_store 落到数据集「${step.name}」）`
          : stepText;
        const aiShot = await captureCompressedScreen(device, { maxWidth: PROMPT_IMAGE_MAX_WIDTH, quality: PROMPT_IMAGE_QUALITY });
        if (aiShot) promptImages = [{ type: 'image', data: aiShot.data, mimeType: aiShot.mimeType }];
      }

      // —— 动作计划缓存回放（0 模型往返）——
      const curPlanKey = (step.type === 'ai' || step.type === 'aiAct') ? planKeyOf(stepIndex, stepText) : null;
      if (curPlanKey) {
        const replayed = await replayPlanCache({ planCache, cacheKey: curPlanKey, stepIndex, toolMap, lastTool, recorder, flags, attachStepShot });
        if (replayed) continue;
      }
      lastTool.calls = []; // 模型路径重新记账（清掉引擎步/回放步的调用）
      const stepsBefore = recorder.stepCount;
      await session.prompt(promptText, { images: promptImages });
      let answer = lastAssistantText(session);

      // 续作循环（ai/aiAct 步）：触发与参数见 resolveLoopPlan
      const loopPlan = (step.type === 'ai' || step.type === 'aiAct')
        ? resolveLoopPlan(step, stepText)
        : null;
      let marathonRan = false; // 是否发生过续作催促（发生了则该步不写计划缓存）
      if (loopPlan) {
        const marathonOutcome = await runMarathonLoop({ loopPlan, answer, promptText, device, session, flags, runDeadline, foldForGateway });
        answer = marathonOutcome.answer;
        marathonRan = marathonOutcome.marathonRan;
      }

      // 空轮检测：无文本且无工具调用 = 模型空转 → 附屏重试（aiAssert 走专用催答）
      if (!answer && recorder.stepCount === stepsBefore && step.type !== 'aiAssert') {
        answer = await retryEmptyRound({ answer, promptText, aiImages: promptImages, session, flags, runDeadline, foldForGateway });
      }
      let assertNudges = 0; // aiAssert 催答轮数（含 chat 兜底），落 assertions[].nudges 供报告排查
      if (!answer && step.type === 'aiAssert') {
        const assertOutcome = await nudgeAssertAnswer({ answer, stepText, device, session, ctx, foldForGateway });
        answer = assertOutcome.answer;
        assertNudges = assertOutcome.nudges;
      } else if (!answer && step.type === 'aiQuery' && recorder.stepCount > stepsBefore) {
        answer = await nudgeQueryReport({ step, session, recorder, stepsBefore, foldForGateway });
      }

      writePlanCache({ planCache, cacheKey: curPlanKey, marathonRan, lastTool });
      // ai 步无文本属正常（工具调用即交付），不催答
      ctx.lastThought = answer;
      if (step.type === 'aiAssert') {
        await recordAssertVerdict({ step, stepText, answer, assertShotBuffer, datasetFacts, assertNudges, ctx, recorder, attachStepShot });
      }
    } catch (error) {
      // 步骤级异常不能静默吞掉（否则 run 会静默判 error 无任何线索）
      console.error(`[step ${stepIndex}] ${step?.type ?? '?'} 异常: ${error?.stack || error?.message || error}`);
      status = 'error';
      break;
    } finally {
      pushStepMsgDelta();
      await applyContextGovernance({ ctx, gov, recorder, steps, caseObj, flags, contextKeep });
      // 治理后同步 state.messages ← 投影（SDK 公开 API refreshContext，即 _refreshFinalizedContext）。
      // appendContextEdit 不触发刷新，state 会滞后于投影：delta 记账（pushStepMsgDelta/_msgStart）
      // 与 lastAssistantText 都读 state，不同步则窗口分段错位、回答读取取到旧数组。
      // 刷新后 delta 记账、digest 与 answer 读取才与投影一致。
      try { session.refreshContext?.(); } catch { /* 刷新失败不阻断（下轮 prompt 请求侧仍用投影） */ }
    }

    // 步骤失败快速终止：引擎步失败或断言失败时，后续步骤大概率无意义，
    // 立即标记 fail 并 break，避免浪费时间在不可能成功的后续操作上。
    // YAML 顶层 stopOnFailure: false 可关闭此行为（兼容需要继续执行的场景）。
    const stopOnFailure = caseObj.stopOnFailure !== false; // 默认 true
    if (stopOnFailure && status === 'pass') {
      const lastAssertionFailed = ctx.assertions.length > 0 && !ctx.assertions[ctx.assertions.length - 1].passed;
      if (engineFailed || lastAssertionFailed) {
        console.warn(`[fail-fast] 步骤 ${stepIndex} 失败（${engineFailed ? '引擎' : '断言'}），终止后续 ${steps.length - stepIndex - 1} 步`);
        status = 'fail';
        break;
      }
    }
  }

  // 断言失败判定（exit code 1）；断言优先于引擎失败标记
  if (ctx.assertions.some((assertion) => !assertion.passed)) status = 'fail';
  else if (engineFailed && status === 'pass') status = 'fail';

  return { status, engineFailed };
}