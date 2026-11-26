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

import { REPLAY_ACTION_TYPES } from '../tools/vocab.js';
import { planKey } from './plan-cache.js';
import { ENGINE_TYPES, COORD_TYPES, buildToolCall } from './case-steps.js';
import { waitSelectorFromText, resolveLoopPlan } from './case-loop.js';
import { interpolate } from './case.js';
import { LOCATE_DEGRADE_POLICY, MARATHON_MARKER_WAIT_MS } from '../device/locate-policy.js';
import { lastAssistantText, makeAttachStepShot, makeFoldForGateway } from './run-loop-helpers.js';

// 非幂等/敏感工具：其调用被整段回放会在错误时机重复副作用或拿不到当次数据，
// 故含这些调用的步骤不写计划缓存。
const NON_IDEMPOTENT = new Set(['data_store', 'net_profile', 'terminate', 'secret_get', 'sms_read']);

export async function runCaseLoop({ ctx, session, recorder, toolMap, planCache, gov, flags, caseObj, runDeadline, modelCfg } = {}) {
  const device = ctx.device;
  const steps = caseObj.steps;
  let status = 'pass';
  let engineFailed = false; // 引擎步失败标记（含降级后仍失败）：零断言用例不能因 exit 0 恒判 pass

  // —— 动作计划缓存记账（原 bin/ask.js 装配段下沉）——
  // 包装工具 execute 记录"本步实际使用的工具调用序列"（仅统计，不改行为）；ai/aiAct 步
  // 结束时若全部调用成功，则缓存完整调用序列（plan）。toolMap 的契约工具与 session 共享
  // 同一实例，就地改写 execute 即覆盖模型路径的工具调用。
  const lastTool = { calls: [] };
  for (const t of toolMap.values()) {
    const orig = t.execute.bind(t);
    t.execute = async (id, params, ...rest) => {
      const r = await orig(id, params, ...rest);
      lastTool.calls.push({ tool: t.name, params, ok: r?.details ? r.details.ok !== false : true });
      return r;
    };
  }
  const planKeyOf = (i, stepText) => planKey({
    caseId: caseObj.source || caseObj.name || 'case',
    stepIndex: i,
    stepText,
    serial: device.serial ?? 'unknown',
    appVersion: ctx.appVersion ?? 'unknown',
  });

  // 非 tool 路径（aiWaitFor 等直记账的步）的报告取证截图：fire-and-forget
  const attachStepShot = makeAttachStepShot(device, recorder);
  // 步内第 2 轮起的 prompt 前先折叠 role:tool 历史（网关 400 防护）
  const foldForGateway = makeFoldForGateway(gov);

  // —— 同屏批量视觉接地（性能）——
  // 一次看图为"当前步 + 后续连续引擎 tap 步"预取多个目标坐标，写入 device.vlmCache
  // （键 tree.hash::target）。屏幕一变 hash 即变，预取坐标自动失效——跨转场无风险。
  // 触发时机：某 aiTap 引擎 MISS 进入 VLM 降级时，顺带把后续 tap 目标一起接地，
  // 后续步骤直接 vlmCacheHit，省掉每个目标一轮模型往返。
  async function batchGround(fromIdx) {
    if (!ctx.vlm || !ctx.chat || !device?.vlmCache) return 0;
    const targets = [];
    for (let k = fromIdx; k < steps.length && targets.length < LOCATE_DEGRADE_POLICY.batchGroundMaxTargets; k++) {
      const s = steps[k];
      if (s.type === 'sleep') continue; // sleep 不改屏幕，可跨过收集
      if (s.type !== 'aiTap' && s.type !== 'aiLongPress') break; // 遇改屏步骤即停
      const txt = interpolate(s.text, ctx.vars);
      if (txt && !targets.includes(txt)) targets.push(txt);
    }
    if (targets.length < 2) return 0; // 单目标无需批量
    let tree;
    try { tree = await device.dumpTree(); } catch { return 0; }
    const size = await device.screenSize().catch(() => null);
    if (!size) return 0;
    let shot;
    try {
      const { compressForContext } = await import('../image/png.js');
      const raw = await device.screencap();
      const c = await compressForContext(raw.buffer, { maxWidth: 720, quality: 70 });
      shot = { data: c.buffer.toString('base64'), mimeType: c.mimeType };
    } catch { return 0; }
    const { resolveStrategy } = await import('../device/coord/registry.js');
    const cs = resolveStrategy(modelCfg.family);
    const fmt = cs?.describeForPrompt?.() || 'Return coordinates normalized to 0-1000.';
    const list = targets.map((t, i) => `${i + 1}. ${t}`).join('\n');
    let raw;
    try {
      raw = await ctx.chat(
        `Locate EACH of the following UI elements on this screenshot. For each, reply one JSON object {"i": <number>, "bbox": [x1,y1,x2,y2]} using this convention: ${fmt} If an element is NOT visible, use {"i": <number>, "bbox": null}. Reply with ONLY a JSON array of ${targets.length} objects. Targets:\n${list}`,
        { images: [shot] },
      );
    } catch { return 0; }
    let arr = null;
    try {
      const { repairJson } = await import('../tools/ai.js');
      arr = repairJson(raw);
    } catch { arr = null; }
    // 宽容解析：模型可能包一层对象（{results:[...]}）或回编号行列表
    if (arr && !Array.isArray(arr) && typeof arr === 'object') {
      arr = arr.results ?? arr.list ?? arr.items ?? arr.bboxes ?? null;
    }
    if (!Array.isArray(arr) && typeof raw === 'string' && /\d/.test(raw)) {
      // 编号行回退：每行 "N. x1 y1 x2 y2" 或 "N: [x1,y1,x2,y2]"
      const lineArr = [];
      for (const line of raw.split(/\r?\n/)) {
        const m = /^\s*(\d+)[.):、]\s*(.+)$/.exec(line);
        if (m) lineArr.push({ i: Number(m[1]), bbox: m[2] });
      }
      if (lineArr.length) arr = lineArr;
    }
    if (!Array.isArray(arr)) {
      if (!flags.quiet && raw) console.warn('[engine] 批量接地回复无法解析：' + String(raw).slice(0, 80));
      return 0;
    }
    let seeded = 0;
    for (const item of arr) {
      const idx = Number(item?.i) - 1;
      const bboxRaw = item?.bbox;
      // bbox 可为数组（JSON 形态）或字符串（编号行回退形态）；toPixels/toNumbers 两者都吃
      const bboxStr = Array.isArray(bboxRaw) ? bboxRaw.join(' ') : (typeof bboxRaw === 'string' ? bboxRaw : null);
      if (idx < 0 || idx >= targets.length || bboxStr == null) continue;
      if (!/\d/.test(bboxStr)) continue; // NOT_FOUND / 无坐标
      const conv = cs?.toPixels?.(bboxStr, size);
      if (!conv?.bounds || !conv.inScreen) continue;
      const identity = { text: '', contentDesc: targets[idx], resourceId: '', cls: '', clickable: null };
      device.vlmCache.set(`${tree.hash}::${targets[idx]}`, { bounds: conv.bounds, center: conv.center, identity });
      seeded++;
    }
    if (seeded && !flags.quiet) console.warn(`[engine] 批量视觉接地：一次看图预取 ${seeded}/${targets.length} 个目标坐标`);
    return seeded;
  }

  // 步骤上下文窗口（docs/CONTEXT-COMPRESSION-RESEARCH.md）：优先级 CLI > YAML 顶层 context: > 默认 3。
  // 'all'/'全部' = 不折叠（保留全部历史步原文）。窗口折叠每步在 finally 执行：
  // 保留最近 N 个"有内容步"的原文，更早的删除并替换为一条确定性整体描述（0 额外 LLM 轮次）。
  const contextCfgRaw = flags['context-steps'] ?? caseObj.context ?? 3;
  const contextAll = /^(all|全部)$/i.test(String(contextCfgRaw).trim());
  const ctxNum = Number(contextCfgRaw);
  const contextKeep = contextAll ? Infinity : (Number.isFinite(ctxNum) ? Math.max(1, Math.trunc(ctxNum)) : 3);
  if (!contextAll && Number.isFinite(ctxNum) && ctxNum < 1) console.warn(`[warn] --context-steps ${contextCfgRaw} 非法（<1），已回退 3`);
  if (!contextAll && Number.isFinite(ctxNum) && !Number.isInteger(ctxNum)) console.warn(`[warn] --context-steps ${contextCfgRaw} 非整数，已取整为 ${contextKeep}`);
  if (flags['context-steps'] === true) console.warn('[warn] --context-steps 需要一个值（n 或 all），已回退 3');
  // SDK 消息数组双路径兼容（旧版 SDK 挂 session.messages）：取不到时 delta 记账为 0，须有告警。
  // 治理执行已迁 governor（读投影），本闭包只服务步间 delta 记账；每步 finally 治理后
  // refreshContext 把投影同步回 state.messages，记账与请求侧视图一致。
  let _msgsWarned = false;
  const getMsgs = () => {
    const m = session?.agent?.state?.messages ?? session?.messages ?? null;
    if (!Array.isArray(m) && !_msgsWarned) { _msgsWarned = true; console.warn('[warn] 未取到会话消息数组（SDK 路径变更？），步骤 delta 记账本轮全部跳过'); }
    return Array.isArray(m) ? m : null;
  };
  ctx.stepMsgCounts = []; // 每步产生的消息数（delta），供 pruneStepHistory 分段（delta 跨多轮剪枝稳定）
  const pushStepMsgDelta = () => {
    try { ctx.stepMsgCounts.push(Math.max(0, (getMsgs()?.length ?? 0) - (ctx._msgStart ?? 0))); } catch { /* 记账失败不阻断 */ }
  };

  // --continue/--session 恢复的历史可能含 role:tool 轮（网关 400）：主循环前先折叠一次
  try { gov.foldToolHistory(); session.refreshContext?.(); } catch { /* 折叠失败不阻断 */ }

  // 逐步骤执行。ai/aiQuery/aiAssert 的设备动作由工具记账包装自动写入 steps[]（§14.1），
  // 这里只记用例级的 net/sleep/aiWaitFor（它们不走工具层）。
  // ${var} 逐步插值（§7.5 执行期插值）：data_extract 运行期写入的变量对后续步骤生效。
  // 不做整体预插值——那样运行期变量永远取不到（C2 验证暴露）。
  for (let i = 0; i < steps.length; i++) {
    // 整 run 时间预算（--timeout）：到点即止，剩余步骤跳过——实测 run 曾超预算 2 倍仍不退出
    if (runDeadline && Date.now() > runDeadline) {
      console.warn(`[timeout] 已超 --timeout 预算（${Math.round((ctx.opts?.timeoutMs ?? 0) / 1000)}s），剩余 ${steps.length - i} 步跳过`);
      status = 'timeout';
      break;
    }
    const step = steps[i];
    ctx.currentStepIndex = i;
    // 坐标缓存键（§2.1）：步骤身份 + 该步骤内定位序号；每步重置 ordinal
    ctx.currentStepKey = { caseId: caseObj.source || caseObj.name || 'case', stepIndex: i };
    ctx.locateOrdinal = 0;
    ctx._msgStart = getMsgs()?.length ?? 0; // 本步开始时的消息数（上下文窗口分段用）
    try {
      if (step.type === 'sleep') {
        const handle = recorder.startStep('sleep', `${step.seconds}s`);
        await new Promise((r) => setTimeout(r, (step.seconds || 0) * 1000));
        handle.end({ result: 'ok' });
        attachStepShot(handle.index); // 报告取证：sleep 后的画面状态
        continue;
      }
      if (step.type === 'net') {
        const handle = recorder.startStep('net', step.profile);
        // 切网前记录（§2.6）：收尾/中断时据此还原到改动前的档位
        try {
          const { recordNetMutation } = await import('../state-mutations.js');
          await recordNetMutation(ctx, device, step.profile);
        } catch { /* 记账失败不阻断切网 */ }
        const nr = await device.netSetProfile(step.profile);
        recorder.addNetworkEvent({ at: Date.now() - ctx.runStartMs, profile: step.profile });
        handle.end({ result: nr.ok ? 'ok' : 'failed', error: nr.ok ? null : (nr.error || 'net 命令失败') });
        continue;
      }
      // 引擎直执行步骤（§2.4 混合执行）：aiTap/aiInput/aiLongPress/aiKeyboardPress/aiScroll/launch/terminate
      // 直接调对应工具（复用工具层记账），不经 agent 选工具；执行后把结果注入上下文，保持 agent 不失忆。
      if (ENGINE_TYPES.has(step.type) || COORD_TYPES.has(step.type)) {
        // 坐标步运行期门控（装载期已按 YAML allowCoords 拒绝过；此处兜住 --allow-coords 与
        // 手改 caseObj 的路径）：未开启则拒绝执行，绝不让坐标点击"悄悄发生/悄悄不发生"。
        if (COORD_TYPES.has(step.type) && !(caseObj.allowCoords || flags['allow-coords'])) {
          const msg = `坐标步骤 ${step.type}: { x: ${step.x}, y: ${step.y} } 被拒绝执行：未开启 allowCoords（用例顶层加 allowCoords: true，或传 --allow-coords）`;
          console.warn(`[warn] ${msg}`);
          const h = recorder.startStep(step.type, `(${step.x},${step.y})`);
          h.end({ result: 'failed', error: msg });
          attachStepShot(h.index);
          continue;
        }
        // 引擎步全部字符串参数做 ${var} 插值（此前仅 text/value，rows/tap/until 里的
        // 变量引用会原样进 selector 静默 MISS）
        const interpStep = { ...step };
        for (const k of Object.keys(interpStep)) {
          if (typeof interpStep[k] === 'string') interpStep[k] = interpolate(interpStep[k], ctx.vars);
        }
        const call = buildToolCall(interpStep);
        if (call) {
          const tool = toolMap.get(call.tool);
          if (tool) {
            // 引擎直执行：0 轮模型往返（这正是拆分粗粒度 ai: 的收益来源）。
            // 结果**不进 session**（那会多一轮 LLM 请求）；记录到 ctx.engineLog 供 run 内排查，
            // 收尾时 setEngineLog 落 run.json（引擎步的 steps[] 记录来自 withRecording 包装）。
            // engineStepsBefore：本步执行前的记账步数，视觉降级轮据此判断模型是否真调了动作工具。
            // engineFailedBefore：进入本步前已有的失败标记——降级成功只撤销**本步**的标记，
            // 不能把更早步骤的失败一并抹掉（否则前面引擎步失败的 run 又恒 pass）。
            const engineStepsBefore = recorder.stepCount;
            const engineFailedBefore = engineFailed;
            const res = await tool.execute(`engine-${i}`, call.params, null, null, {});
            const d = res?.details ?? {};
            ctx.engineLog.push({ step: i, type: step.type, tool: call.tool, ok: d.ok !== false, error: d.error ?? null });
            if (d.ok === false) console.warn(`[engine] ${step.type}「${step.text ?? ''}」失败：${d.error || ''}`);
            // 引擎步失败（含降级后仍失败）必须影响终态——零断言用例的 exit 0 不代表任务完成
            if (d.ok === false) {
              engineFailed = true;
            }
            // 视觉接地降级（外部框架兼容）：aiTap/aiLongPress 的定位目标是**描述性视觉短语**
            // （如"屏幕最底部导航栏中的'生活'标签"）时，引擎文本/资源定位必然 MISS。
            // 此时花**一轮** agent 往返让模型看屏接地并点击，避免整步失败。
            // 注意 locateMiss 把标记放在 details.code（details.error 可能为 undefined）。
            const missText = `${d.code ?? ''} ${d.error ?? ''}`;
            const isLocateMiss = d.ok === false && /LOCATE_MISS|未找到目标/i.test(missText);
            const isTapFamily = call.tool === 'tap' || call.tool === 'long_press';
            if (isLocateMiss && isTapFamily) {
              // busy 态（提交动画/转场）下 WebView a11y 会把目标元素拒之门外，且 dump 单次
              // 40-55s——与其立刻 VLM/视觉轮盲试（实测 6×380s 全 MISS），先等 idle 窗口过去
              // （有界 90s），树稳定后目标自然出现在 a11y 树里
              try { await device.waitIdle({ quiet: 1, timeoutMs: LOCATE_DEGRADE_POLICY.busyWaitIdleMs }); } catch { /* 等待失败不阻断降级 */ }
            }
            if (isLocateMiss && isTapFamily && ctx.vlm) {
              // 先批量接地：一次看图为当前步+后续连续 tap 步预取坐标（写 vlmCache，
              // 键 tree.hash::target，屏幕一变自动失效）。随后单目标 locate 直接命中缓存。
              try { await batchGround(i); } catch { /* 批量失败不阻断单目标降级 */ }
              // 一级降级：VLM 视觉接地（确定性：截图→坐标→family 策略转像素→tap）
              try {
                const vres = await device.locate(interpStep.text ?? step.text, { vlm: ctx.vlm });
                if (vres?.ok && vres.bounds) {
                  const tr = call.tool === 'long_press'
                    ? await device.longPress(vres.bounds, Number(step.durationMs) || 800)
                    : await device.tap(vres.bounds);
                  ctx.engineLog.push({ step: i, type: step.type + '+vlm-fallback', tool: call.tool, ok: tr?.ok !== false, error: tr?.error ?? null });
                  // VLM 降级成功 = 本步最终完成，只撤销本步的失败标记；降级仍失败则保留（终态判 fail）
                  if (tr?.ok !== false) engineFailed = engineFailedBefore;
                  if (!flags.quiet) console.warn('[engine] ' + step.type + ' 引擎 MISS → VLM 接地 ' + (tr?.ok !== false ? '成功' : '失败'));
                  continue;
                }
              } catch { /* VLM 失败 → 落 agent 轮降级 */ }
            }
            if (isLocateMiss && isTapFamily) {
              const verb = call.tool === 'long_press' ? '长按' : '点击';
              if (!flags.quiet) console.warn(`[engine] ${step.type} 定位失败，降级一轮视觉接地`);
              // 随降级 prompt 附当前屏压缩图，免模型再花一轮调 screen
              let fbImages = [];
              try {
                const { compressForContext } = await import('../image/png.js');
                const shot = await device.screencap();
                const cc = await compressForContext(shot.buffer, { maxWidth: 540, quality: 70 });
                fbImages = [{ type: 'image', data: cc.buffer.toString('base64'), mimeType: cc.mimeType }];
              } catch { /* 取图失败则模型自行 screen */ }
              foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
              await session.prompt(
                `引擎定位失败，改用视觉接地：请在随附截屏对应的当前屏幕上找到并${verb}以下目标。**必须调用 ${call.tool} 工具完成${verb}**——只调 locate/uitree 查看不算完成本步。只这一次操作，做完即止，不要滚动/返回/做其它事：${step.text}\n若确实找不到，回复"未找到"并说明原因。`,
                { images: fbImages },
              );
              // 如实记录降级结果：检查本轮是否真产生了**成功的**动作类工具步。
              // 只算 result==='ok'：engineStepsBefore 起算的范围里含引擎自身那条失败步
              // （type 同为 tap/long_press），不过滤会把失败步误当"模型完成了动作"。
              const acted = recorder.stepsSince(engineStepsBefore)
                .some((s) => REPLAY_ACTION_TYPES.includes(s.type) && s.result === 'ok');
              ctx.engineLog.push({ step: i, type: `${step.type}+visual-fallback`, tool: 'agent', ok: acted, error: acted ? null : '降级轮未产生成功的动作步' });
              // 有动作步 = 降级完成本步，只撤销本步的失败标记；无动作步 = 降级后仍失败，终态判 fail
              engineFailed = acted ? engineFailedBefore : true;
            }
            continue;
          }
          console.warn(`[warn] 引擎步骤 ${step.type} 找不到工具 ${call.tool}`);
        }
      }

      // ai / aiQuery → agent prompt；aiAssert → 断言判定；aiWaitFor → 等稳定(+条件)
      // 引擎直执行步骤（aiTap/aiInput/…/launch/terminate）已在上方分支处理
      const stepText = interpolate(step.text, ctx.vars);

      if (step.type === 'aiWaitFor') {
        // 等待（§21）：**优先"等具体元素出现"**（语义化、通常更快：首次 dump 命中即返回），
        // 无法解析出具体元素时退回"等树稳定"（quiet 可配，默认 2；quiet=1 更快但无稳定性校验）。
        // 纯引擎，不调模型。
        const handle = recorder.startStep('aiWaitFor', stepText ? stepText.slice(0, 40) : '');
        const timeout = Number(step.timeout) || 10000;
        const quiet = step.quiet != null ? Number(step.quiet) : 2;
        // 显式 selector 参数行优先（评审 #10）；散文解析仅作未声明时的兜底
        const sel = (step.selector && String(step.selector).trim())
          ? (waitSelectorFromText(String(step.selector)) || String(step.selector).trim())
          : waitSelectorFromText(stepText);
        let r;
        if (sel) {
          // 有具体元素 → 等它出现（比等树不变更语义、通常更快）。
          // WebView 壳 App（uni-app 等）会把未打开的页面预渲染进 accessibility 树
          // （bounds 在屏内但不可见）→ 树等待误报 appeared。命中节点在 WebView 容器内时
          // 加一轮视觉确认（附截图问模型目标是否真可见），最多 3 轮、轮间睡 3s。
          const t0 = Date.now();
          let confirmed = false;
          let confirms = 0;
          while (Date.now() - t0 < timeout) {
            r = await device.waitForElement(sel, { timeoutMs: Math.max(1500, timeout - (Date.now() - t0)) });
            if (!r?.appeared) break;
            if (!r.inWebView) { confirmed = true; break; }
            if (confirms >= 3) break;
            confirms++;
            let shot = [];
            try {
              const { compressForContext } = await import('../image/png.js');
              const s2 = await device.screencap();
              const cc = await compressForContext(s2.buffer, { maxWidth: 540, quality: 70 });
              shot = [{ type: 'image', data: cc.buffer.toString('base64'), mimeType: cc.mimeType }];
            } catch { confirmed = true; break; /* 取图失败按命中处理，不卡流程 */ }
            foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
            await session.prompt(
              `视觉确认（不要调用任何工具）：随附截屏中，目标元素「${sel}」当前是否真实可见？若可见回复 VISIBLE；若不可见（隐藏层/未打开的页面/不在屏上）回复 NOT_VISIBLE。只回复这一个词。`,
              { images: shot },
            );
            let ans = lastAssistantText(session);
            if (!ans) {
              // 空响应（网关偶发）：重问一次再判，降低"隐藏层+空响应"漏检概率
              foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
              await session.prompt('只回复一个词：VISIBLE 或 NOT_VISIBLE。', { images: shot });
              ans = lastAssistantText(session);
            }
            // 否定优先：仅当模型**明确**答 NOT_VISIBLE/不可见 才判未确认；空响应或肯定一律放行。
            // 全 WebView 壳 App 的每次树命中都要过确认，若把网关空响应当"不可见"，
            // 会把在屏元素误判为隐藏层（真机事故：导航栏在屏却等满 91s）。
            const explicitNo = ans && /(NOT_VISIBLE|不可见|未见|未出现|不存在|隐藏|预渲染)/i.test(ans);
            if (!explicitNo) { confirmed = true; break; }
            if (Date.now() - t0 >= timeout) break;
            await new Promise((res2) => setTimeout(res2, 5000)); // WebView 壳 App 页面加载慢，确认间隔放宽到 5s
          }
          r = { ...(r ?? {}), appeared: confirmed };
          handle.end({ result: confirmed ? 'ok' : 'failed' });
          attachStepShot(handle.index); // 报告取证：aiWaitFor 步没有工具层截图钩子，这里补终态截图
          if (!confirmed && !flags.quiet) console.warn(`[warn] aiWaitFor「${stepText}」未见真实可见元素（${sel}，视觉确认 ${confirms} 轮）`);
        } else {
          r = await device.waitIdle({ quiet, timeoutMs: timeout });
          handle.end({ result: 'ok' });
          attachStepShot(handle.index);
        }
        continue;
      }

      // 断言附图（性能）：旧实现 prompt 不带图，模型必须先调一次 screen 工具
      // （= 额外一整轮模型往返 ~10s + 工具执行 ~3s）才能作答。这里直接随 prompt
      // 附当前屏压缩图，断言一轮完成。取图失败则退回无图（模型仍可自行调 screen）。
      // 同时注入前台包名事实：截图无法表达"前台是哪个包"，不注入会诱导模型调工具核实，
      // 导致断言步无文本输出（曾误判"模型无输出"）。
      let promptImages = [];
      // 断言判定输入截图的原始压缩 buffer（Task 14）：promptImages 里是 base64 字符串，
      // 判定段需要 buffer 本身落盘为 assert-<i>.png（JPEG 也按魔数处理），故单独保留。
      let assertShotBuffer = null;
      let fgNote = '';
      if (step.type === 'aiAssert') {
        try {
          const { compressForContext } = await import('../image/png.js');
          const shot = await device.screencap();
          const c = await compressForContext(shot.buffer, { maxWidth: 540, quality: 70 });
          assertShotBuffer = c.buffer;
          promptImages = [{ type: 'image', data: c.buffer.toString('base64'), mimeType: c.mimeType }];
        } catch { /* 取图失败不阻断断言 */ }
        try {
          const fg = await device.foreground();
          if (fg?.package) fgNote = `\n（系统事实：当前前台包名为 ${fg.package}，Activity 为 ${fg.activity ?? '未知'}）`;
        } catch { /* 前台事实缺失不阻断 */ }
      }
      // 数据类断言分流（C-P2）：文本引用数据集时注入行数与样本事实，
      // 不再让模型只凭屏幕截图猜测"数据集 X 至少 N 条"（系统性误判源）。
      // collectDatasetFacts 必须显式声明——原 bin/ask.js 漏声明导致 ESM 严格模式解构赋值
      // 抛 ReferenceError 被 catch 吞掉，数据集事实注入从未生效（本次下沉顺带修复）。
      let datasetFacts = null;
      let buildAssertPrompt = null;
      let collectDatasetFacts = null;
      if (step.type === 'aiAssert') {
        try {
          ({ buildAssertPrompt, collectDatasetFacts } = await import('./assert-prompt.js'));
          datasetFacts = await collectDatasetFacts(stepText, ctx.datasetWrites, ctx.store);
        } catch { /* 事实采集失败不阻断断言（含模块加载失败，下方回退旧屏幕口径模板） */ }
      }
      const text = (step.type === 'aiAssert')
        ? (buildAssertPrompt
          ? buildAssertPrompt({ stepText, fgNote, datasetFacts })
          : `【断言】${stepText}${fgNote}\n只依据随附的当前屏幕截图与上述系统事实判断，不要调用任何工具。只输出一行 JSON：{"passed": true/false, "reason": "不超过30字"}。`)
        : (step.type === 'aiQuery' && step.name)
          ? `${stepText}\n（把结果用 data_extract 或 data_store 落到数据集「${step.name}」）`
          : stepText;
      // ai/aiQuery 步附当前屏压缩图：模型无需先调 screen 就能看到画面（省一轮往返），
      // 且避免"历史有图、本轮无图"诱发网关空响应（实测 ai 步曾返回全空 assistant 消息）。
      let aiImages = [];
      if (step.type !== 'aiAssert') {
        try {
          const { compressForContext } = await import('../image/png.js');
          const s0 = await device.screencap();
          const c0 = await compressForContext(s0.buffer, { maxWidth: 540, quality: 70 });
          aiImages = [{ type: 'image', data: c0.buffer.toString('base64'), mimeType: c0.mimeType }];
        } catch { /* 取图失败不阻断 */ }
      }
      // —— 动作计划缓存回放（0 模型往返，业界调研落地）——
      // 命中即按序回放缓存的调用序列；任一失败删条目并落回模型规划（重新学习后重写）。
      const curPlanKey = (step.type === 'ai' || step.type === 'aiAct') ? planKeyOf(i, stepText) : null;
      if (curPlanKey) {
        const cached = planCache.get(curPlanKey);
        const plan = Array.isArray(cached?.plan) && cached.plan.length ? cached.plan : (cached ? [cached] : null);
        if (plan) {
          if (!flags.quiet) console.warn(`[plan-cache] 步骤 ${i} 命中缓存，回放 ${plan.length} 个调用（省模型往返）`);
          let allOk = true;
          lastTool.calls = [];
          for (const c of plan) {
            const tool = toolMap.get(c.tool);
            if (!tool) { allOk = false; break; }
            const r = await tool.execute(`plan-${i}`, c.params);
            if (r?.details?.ok === false) { allOk = false; break; }
          }
          if (allOk) {
            // M6：recorder.stepCount 是"下一个"索引，_steps[stepCount] 不存在会让截图落盘
            // 但不挂任何步骤（孤儿 PNG）。回放产生的最后一步索引是 stepCount-1。
            attachStepShot(recorder.stepCount - 1); // 回放步终态取证
            continue;
          }
          if (!flags.quiet) console.warn('[plan-cache] 回放未成功，回退模型规划');
          planCache.delete(curPlanKey);
          lastTool.calls = []; // 丢弃回放期的半程调用，模型路径重新记账
        }
      }
      lastTool.calls = []; // 模型路径重新记账（清掉此前引擎步/回放步的调用）
      const stepsBefore = recorder.stepCount;
      await session.prompt(text, { images: step.type === 'aiAssert' ? promptImages : aiImages });
      let answer = lastAssistantText(session);
      // 续作循环（ai/aiAct 步）：长任务步模型常做一两个动作就收尾（如 27 题只答 1 题）。
      // 触发与参数见 case.js resolveLoopPlan：步级显式 until/maxRounds/batch 优先，
      // 散文关键词（直到/重复/逐题/每一题/依次）为存量用例兼容路径。每轮先查完成自报
      // （短回复含”完成”/BLOCKED）与终止标记确定性检测，最多 plan.maxRounds 轮。
      const loopPlan = (step.type === 'ai' || step.type === 'aiAct')
        ? resolveLoopPlan(step, stepText)
        : null;
      let marathonRan = false; // 是否发生过续作催促（发生了则该步不写计划缓存）
      if (loopPlan) {
        const { marker: marathonMarker, batch: loopBatch, maxRounds: loopMaxRounds } = loopPlan;
        for (let resume = 0; resume < loopMaxRounds; resume++) {
          if (runDeadline && Date.now() > runDeadline) { console.warn('[timeout] 步内催促超 --timeout 预算，提前收束'); break; }
          // 完成自报（2026-11-04 评审修复）：催促词让模型”终止条件已满足回复'完成'”，但旧
          // 循环从不检查 answer——模型每轮回"完成"仍被逼答满轮数上限（实测单步空耗 24-88 分钟）。
          // 仅认”短回复含完成”（防长篇散文里 incidental 完成二字误判）；BLOCKED 同义结束。
          const selfDone = answer && answer.length <= 20 && /完成/i.test(answer);
          if (answer && (/BLOCKED/i.test(answer) || selfDone)) break;
          // 确定性终止检测：终止标记元素已可见 → 任务完成，结束循环
          if (marathonMarker) {
            try {
              const done = await device.waitForElement(marathonMarker, { timeoutMs: MARATHON_MARKER_WAIT_MS });
              if (done?.appeared) break;
            } catch { /* 检测失败继续催 */ }
          }
          marathonRan = true;
          if (!flags.quiet) console.warn(`[warn] 马拉松步未完成（终止标记未满足），催促继续 ${resume + 1}/${loopMaxRounds}`);
          // 每轮取新截图：题目推进后屏幕已变，步首旧图会误导模型
          let freshImgs = [];
          try {
            const { compressForContext } = await import('../image/png.js');
            const s5 = await device.screencap();
            const c5 = await compressForContext(s5.buffer, { maxWidth: 540, quality: 70 });
            freshImgs = [{ type: 'image', data: c5.buffer.toString('base64'), mimeType: c5.mimeType }];
          } catch { /* 取图失败不阻断 */ }
          foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
          // 催促话术按形态分流（评审 #1①：批量话术曾把"依次逐个"类任务催成整屏并行点击）：
          // batch=true 维持历史并行话术；false（显式缺省）= 逐个处理。
          const nudge = loopBatch
            ? `任务尚未完成（终止条件未满足）。继续执行：${text}\n（高效做法：一次 uitree 看清当前屏全部待处理项，然后**一轮并行 tap** 处理完本屏所有项，再滚动看下一屏；若终止条件已满足回复”完成”，无法继续回复”BLOCKED: 原因”）`
            : `任务尚未完成（终止条件未满足）。继续执行：${text}\n（逐个处理：每轮只处理**一个**待办项——先 uitree 看清当前屏，定位并操作下一项，完成即结束本轮回复；需要看更多内容就滚动后下一轮再处理；若终止条件已满足回复”完成”，无法继续回复”BLOCKED: 原因”）`;
          await session.prompt(nudge, { images: freshImgs });
          answer = lastAssistantText(session);
        }
      }
      // 空轮检测：无文本且无工具调用 = 模型空转（网关/模型偶发空响应）→ 附屏重试。
      // 第 2 次重试要求显式 BLOCKED 回复：把"静默空转"变成可观测结果（进报告 thought），
      // 否则 ai 步静默无操作会让后续步骤在错误页面上连锁失败（真机事故根因）。
      if (!answer && recorder.stepCount === stepsBefore && step.type !== 'aiAssert') {
        for (let retry = 0; retry < 3 && !answer; retry++) {
          if (runDeadline && Date.now() > runDeadline) { console.warn('[timeout] 空轮重试超 --timeout 预算，停止重试'); break; }
          // 第 2 次重试去图：网关对"带图+短文本"偶发空响应，去图可绕开该触发面
          const imgs = retry === 0 ? aiImages : [];
          if (!flags.quiet) console.warn(`[warn] 模型空轮（无文本无工具），重试 ${retry + 1}/3（${retry === 0 ? '附屏' : retry === 1 ? '去图' : '换措辞去图'}）`);
          const extra = retry === 0
            ? '（随附当前屏幕截图；直接调用工具执行，不要只描述意图）'
            : retry === 1
            ? '（第二次重试。你必须现在调用至少一个工具执行上述任务；若确实无法执行，回复一行：BLOCKED: <原因>）'
            : '（第三次重试，换一种说法）请执行：' + text + '。直接调用工具；无法执行则回复 BLOCKED: 原因';
          foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
          await session.prompt(`${text}\n${extra}`, { images: imgs });
          answer = lastAssistantText(session);
        }
      }
      let assertNudges = 0; // aiAssert 催答轮数（含 chat 兜底），落 assertions[].nudges 供报告排查
      if (!answer && step.type === 'aiAssert') {
        // 断言步：模型以纯 toolCall 或空消息收尾（网关/模型偶发空响应）→ 最多催答 3 轮
        for (let nudge = 0; nudge < 3 && !answer; nudge++) {
          assertNudges = nudge + 1;
          // 第 2 轮起附当前屏图：空响应多发生在"长上下文+无图"轮，附图可显著降低空响应率
          let imgs = [];
          if (nudge >= 1) {
            try {
              const { compressForContext } = await import('../image/png.js');
              const s3 = await device.screencap();
              const c3 = await compressForContext(s3.buffer, { maxWidth: 540, quality: 70 });
              imgs = [{ type: 'image', data: c3.buffer.toString('base64'), mimeType: c3.mimeType }];
            } catch { /* 取图失败不阻断 */ }
          }
          foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
          await session.prompt('不要再调用工具。直接输出一行 JSON：{"passed": true/false, "reason": "不超过30字"}', { images: imgs });
          answer = lastAssistantText(session);
        }
        if (!answer && ctx.chat) {
          // 会话催答耗尽仍空（长上下文空响应）：无状态单发 chat 兜底判定（不依赖会话历史）
          assertNudges++; // 兜底也是一次催答，计入轮数
          try {
            let shot2 = [];
            try {
              const { compressForContext } = await import('../image/png.js');
              const s4 = await device.screencap();
              const c4 = await compressForContext(s4.buffer, { maxWidth: 540, quality: 70 });
              shot2 = [{ data: c4.buffer.toString('base64'), mimeType: c4.mimeType }];
            } catch { /* 无图也判 */ }
            answer = await ctx.chat(
              `【断言】${stepText}
只依据随附截图判断。只输出一行 JSON：{"passed": true/false, "reason": "不超过30字"}`,
              { images: shot2 },
            );
          } catch { /* 兜底失败维持无输出 */ }
        }
      } else if (!answer && step.type === 'aiQuery' && recorder.stepCount > stepsBefore) {
        // 查询步已执行工具但无收尾文本：催一句结果汇报（1 轮）。
        // 带 name 的落库形态若还没调 data_extract/data_store，先放行落库再汇报——
        // 一刀切"不要再调用工具"会把落库也掐死（实测 c3_summary 数据集 0 条即此因）。
        const needStore = step.name && !recorder.stepsSince(stepsBefore).some((s) => /data_extract|data_store/.test(s.type || ''));
        foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
        await session.prompt(
          needStore
            ? `还没把结果落到数据集「${step.name}」。现在就调用一次 data_extract（或 data_store）完成落库，然后用一句话报告结果。`
            : '不要再调用工具。用一句话报告你刚才查询/提取到的结果。',
          { images: [] },
        );
        answer = lastAssistantText(session);
      }
      // —— 计划缓存写入：全部工具调用成功、且不含非幂等工具的 ai/aiAct 步记完整 plan；
      // 马拉松步不缓存（其续作依赖逐轮页面状态，整段回放不安全——Midscene 同款取舍）。
      // 非幂等工具（写库/切网/终止进程/读凭据/读短信）的调用若被整段回放，会在错误时机
      // 重复产生副作用或读不到当次数据，故一律不进计划缓存。
      if (curPlanKey && !marathonRan
        && lastTool.calls.length >= 1
        && lastTool.calls.every((c) => c.ok)
        && lastTool.calls.every((c) => !NON_IDEMPOTENT.has(c.tool))) {
        planCache.put(curPlanKey, {
          tool: lastTool.calls[0].tool,
          params: lastTool.calls[0].params,
          plan: lastTool.calls.map((c) => ({ tool: c.tool, params: c.params })),
        });
      }
      // ai 步无文本属正常（工具调用即交付），不催答
      ctx.lastThought = answer;
      if (step.type === 'aiAssert') {
        // 断言判定独立记账（评审 C-P2）：此前只落 assertions[]，steps[]/报告时间线无该步——
        // 耗时、终态截图、催答轮数全部不可见。这里补 startStep/end + 终态取证截图。
        const ah = recorder.startStep('aiAssert', stepText.slice(0, 40));
        const { parseVerdict } = await import('../tools/ai.js');
        const verdict = parseVerdict(answer);
        ah.end({ result: verdict.passed ? 'ok' : 'failed', error: verdict.passed ? null : verdict.reason, thought: answer });
        attachStepShot(ah.index); // 报告取证：判定后的画面状态（走既有 step 索引机制）
        // 判定输入截图独立落盘（Task 14）：assertIndex 用判定前已记账的断言数，
        // 文件名 assert-<i>.png。取图失败（assertShotBuffer 为 null）时不传 screenshotId。
        let shotRel = null;
        if (assertShotBuffer) {
          shotRel = recorder.attachAssertionShot(ctx.assertions.length, assertShotBuffer);
        }
        // evidenceSource：注入了数据集事实 → dataset 口径；否则屏幕口径。
        recorder.addAssertion({ text: step.text, passed: verdict.passed, reason: verdict.reason, evidenceSource: datasetFacts ? 'dataset' : 'screen', nudges: assertNudges, screenshotId: shotRel });
        ctx.assertions.push({ text: step.text, passed: verdict.passed, reason: verdict.reason });
      }
    } catch (e) {
      // 步骤级异常不能静默吞掉（曾致 run 静默判 error 无任何线索）
      console.error(`[step ${i}] ${step?.type ?? '?'} 异常: ${e?.stack || e?.message || e}`);
      status = 'error';
      break;
    } finally {
      pushStepMsgDelta();
      // 会话历史截图治理（§16）：保留最近 N 张图（--keep-images，默认 3），更早的替换为
      // 文字占位符，避免 prompt tokens 随历史线性膨胀（实测 20 张图 → 67k tokens / 单轮 26s）。
      // 三层剪枝**必须先于窗口折叠**执行：折叠删除消息段时，被删段与保留段都已是纯文本，
      // 不依赖"两段在同一同步 finally 内执行"的顺序巧合（role:'tool' 残留会触发网关 400）。
      // 评审 C-A1：全部经 governor 落 appendContextEdit（对实际请求生效，持久化历史留原文）。
      try {
        const keepN = Number(flags['keep-images']); const pr = gov.pruneImages({ keepRecent: Number.isFinite(keepN) && keepN >= 1 ? keepN : 3 });
        if (pr.replaced > 0) ctx.imagesPruned = (ctx.imagesPruned || 0) + pr.replaced;
        // 旧工具结果截断：uitree/screen_diff 单条 20-40KB，长 run 累积数 MB 进上下文，
        // 实测诱发模型空响应；只保留最近 1 条完整（当前步所需），更早截断为 300 字符摘要
        const pr2 = gov.pruneToolResults({ keepRecent: 1, keepChars: 300 });
        if (pr2.replaced > 0) ctx.toolResultsPruned = (ctx.toolResultsPruned || 0) + pr2.replaced;
        // 旧工具轮折叠为纯文本：网关对 role:tool 历史返回 400（对照实验实证），
        // 步间全折叠为纯文本（keepRecent=0）：网关对 role:tool 历史偶发 400/空响应；
        const pr3 = gov.pruneToolHistory({ keepRecent: 0 });
        if (pr3.folded > 0) ctx.toolHistoryFolded = (ctx.toolHistoryFolded || 0) + pr3.folded;
      } catch { /* 剪枝失败不阻断 */ }
      // 步骤上下文窗口（第四道治理，调研 docs/CONTEXT-COMPRESSION-RESEARCH.md）：
      // 超过 keepSteps 个"有内容步"时，把最旧步骤的原文整体删除，替换为一条确定性
      // 整体描述（进度/最近步骤行/断言计数/数据集/变量），只保留最近 N 步原文。0 额外 LLM 轮次。
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
          const pr = gov.pruneStepHistory(ctx.stepMsgCounts, { keepSteps: contextKeep, digest });
          if (pr.changed && !flags.quiet) console.warn(`[context] 窗口折叠：移除最旧 ${pr.removed} 条消息，保留最近 ${contextKeep} 步原文 + 整体描述`);
        }
      } catch { /* 窗口治理失败不阻断 */ }
      // 治理后同步 state.messages ← 投影（SDK 公开 API refreshContext，即 _refreshFinalizedContext）。
      // appendContextEdit 不触发刷新，state 会滞后于投影：delta 记账（pushStepMsgDelta/_msgStart）
      // 与 lastAssistantText 都读 state，不同步则窗口分段错位、回答读取取到旧数组。
      // 实验实证：refresh 后八步序列 delta 恒 2、digest 恒 1 条、answer 每步正确。
      try { session.refreshContext?.(); } catch { /* 刷新失败不阻断（下轮 prompt 请求侧仍用投影） */ }
    }
  }

  // 断言失败判定（exit code 1）；断言优先于引擎失败标记
  if (ctx.assertions.some((a) => !a.passed)) status = 'fail';
  else if (engineFailed && status === 'pass') status = 'fail';

  return { status, engineFailed };
}
