#!/usr/bin/env node
// ask CLI（§13）：run/do/ask/data/lint/doctor/mcp
// 退出码（§13.1）：0 通过 | 1 用例断言失败（lint：有 error）| 2 环境/配置错误
//                 | 3 ask 问答得到空回答（本机扩展，契约未定义该值）
// 设备独占锁 .ask/locks/<serial>.lock（PID+时间戳，存活拒绝、死进程 10min 自动清，§13.2.1）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgv } from '../src/cli/argv.js';
import { acquireLock, releaseLock } from '../src/cli/lock.js';
import { collectDeviceFacts } from '../src/cli/device-facts.js';
import { resolveWorkspace, ensureWorkspace } from '../src/cli/workspace.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..');
// 运行时产物与源码分离（见 src/cli/workspace.js）：用例/运行记录/报告/数据集/私有状态落工作区，
// 设备锁与 family 探测缓存落全局（跨实例共享）。
const WORKSPACE = resolveWorkspace();

// 进程级信号处理（§2.6.2 ④）：还原设备状态 + 释放锁，再退出。
// 必须注册在进程作用域（非 runOne 内，避免多 case/并行时累积处理器）。
// 在册集合而非单指针：--parallel 组间并发（Promise.all）时多个 runOne 同时在跑，
// 单指针会互相覆盖——信号处理只能看到最后一个，先结束的 run 还会把别人的 ctx 清掉（复审发现）。
const activeRuns = new Set();   // 每项 { ctx, device, bridge, serial }，runOne 开始时在册、finally 注销
let cleaningUp = false;
let sharedBridgeRef = null;      // cmdRun 级共享 MCP 桥：信号退出时也要能关（runOne 不持有）

async function gracefulExit(sig) {
  if (cleaningUp) return;                 // 防重入（信号 + finally 双触发）
  cleaningUp = true;
  console.error(`\n收到 ${sig}，正在还原设备状态…`);
  try {
    if (activeRuns.size) {
      const { restoreNetwork } = await import('../src/state-mutations.js');
      for (const run of activeRuns) {
        await restoreNetwork(run.device, run.ctx).catch(() => {});
        try { await run.ctx?.locateWithCache?.flush?.(); } catch { /* ignore */ }
        try { await run.ctx?.recorder?.flushPending?.(); } catch { /* ignore */ }
        try { await run.bridge?.close?.(); } catch { /* ignore */ }
        try { await run.device?.close?.(); } catch { /* ignore */ }
        if (run.serial) releaseLock(WORKSPACE.lockRoot, run.serial);
      }
    }
    try { await sharedBridgeRef?.close?.(); } catch { /* ignore */ }
  } finally {
    process.exit(130);
  }
}
process.once('SIGINT', () => gracefulExit('SIGINT'));
process.once('SIGTERM', () => gracefulExit('SIGTERM'));

function fail(msg, code = 2) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

const usage = `ask — 安卓场景测试 agent

用法: ask <command> [args] [flags]

子命令:
  run <file...>        执行 YAML 用例（--parallel N --devices a,b,c 批量并发）
  do "<task>"          自然语言任务（agent 自主决策）
  ask "<question>"     只读问答（读屏、查数据，不点击）
  data list|show|query|export|diff|clear   数据集操作
  lint <file...>       YAML 静态校验（--strict 把 warn 当 error）
  doctor               环境自检（--device / --model / --cache-report runs/x.json）
  mcp list|check|call  MCP 工具管理

全局参数:
  --device <serial>    adb 设备序列号（默认首个在线设备）
  --model-url/--model-key/--model-name/--model-family   覆盖 ASK_MODEL_* 环境变量
  --prompt <t> --prompt-file <f> --prompt-mode append|replace|none
  --vlm-locate --yes --timeout <sec> --fresh-locate --json --quiet --pregrant
  --keep-images <n>   会话历史保留最近 n 张截图（默认 3；断言密集用例可设 2 省 token）
  会话保留: --keep(默认) --fresh --continue --session <file> --keep-data
`;

// —— 输出辅助 ——
function out(flags, data, human) {
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else if (human !== undefined) console.log(human);
}

// —— 默认设备（§13.3：--device 缺省取首个在线设备） ——
async function firstOnlineSerial() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(process.env.ASK_ADB || 'adb', ['devices'], { timeout: 5000 });
    const line = stdout.split('\n').map((l) => l.trim()).find((l, i) => i > 0 && l.endsWith('\tdevice'));
    return line ? line.split('\t')[0] : null;
  } catch {
    return null;
  }
}

async function resolveSerials(flags) {
  if (flags.devices) return String(flags.devices).split(',').map((s) => s.trim()).filter(Boolean);
  if (flags.device) return [flags.device];
  if (process.env.ASK_DEVICE) return [process.env.ASK_DEVICE];
  const s = await firstOnlineSerial();
  return s ? [s] : [];
}

// 用例文件解析：给定路径优先（cwd 相对/绝对），不存在再回退工作区 case 目录的同名文件。
// 便于 `ask run s1.yaml` 直接引用工作区用例，也兼容显式相对路径。
function resolveCasePath(p) {
  const direct = path.resolve(p);
  if (fs.existsSync(direct)) return direct;
  const inWs = path.join(WORKSPACE.caseDir, p);
  if (fs.existsSync(inWs)) return inWs;
  return direct; // 交给调用方报错，错误信息里带上已尝试路径
}

// —— 交互确认（§13.3：未 --yes 且 TTY 时写操作/MCP 需确认） ——
async function makeConfirm(message) {
  process.stdout.write(`${message} (y/N) `);
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question('')).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

// 取会话里最近一条**含文本**的 assistant 消息（thought 归因 + ask 回答回显共用）
// 兼容两种读取路径：SDK 新版的 session.agent.state.messages 与旧版 session.messages。
// 注意：assistant 消息可能是纯 toolCall（无 text）——必须继续往前扫，
// 否则模型用工具回应断言时会把"无文本"误判成"模型无输出"。
function lastAssistantText(session) {
  try {
    const msgs = session?.agent?.state?.messages ?? session?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      // 只在本轮（最后一次 user 消息之后）内找文本，避免取到上一步的陈旧 thought
      if (m?.role === 'user') break;
      if (m?.role !== 'assistant') continue;
      const parts = Array.isArray(m.content)
        ? m.content.filter((c) => c?.type === 'text').map((c) => c.text ?? '')
        : (typeof m.content === 'string' ? [m.content] : []);
      const text = parts.join('\n').trim();
      if (text) return text;
    }
  } catch { /* 会话不可读则无 thought */ }
  return null;
}

// —— 设备事实采集见 src/cli/device-facts.js（已抽出以便单测） ——

// —— 子命令实现 ——

async function cmdRun({ positional, flags }) {
  const targets = positional.filter((p) => !p.startsWith('-'));
  if (!targets.length) fail('run 需要至少一个用例文件或任务文本');
  const parallel = Number(flags.parallel || 1);

  // 设备清单与 --parallel 校验（§13.2.1）
  const serials = await resolveSerials(flags);
  if (!serials.length) fail('未找到在线设备（adb devices），请用 --device <serial> 或 --devices 指定');
  if (parallel > serials.length) {
    fail(`--parallel ${parallel} requires ${parallel} devices, but only ${serials.length} available.`);
  }

  // 装载 Case：文件 → parseCaseText；纯文本（无 .yaml/.yml 后缀）→ 单步 do
  // 路径解析：先按给定路径（cwd 相对），找不到再回退工作区 case 目录的同名文件
  const { parseCaseText, caseFromText } = await import('../src/session/case.js');
  const cases = [];
  for (const t of targets) {
    if (/\.(ya?ml)$/i.test(t)) {
      const resolved = resolveCasePath(t);
      let text;
      try { text = fs.readFileSync(resolved, 'utf8'); } catch { fail(`用例文件不可读：${t}（已尝试 ${resolved}）`); }
      cases.push(parseCaseText(text, { source: t }));
    } else {
      cases.push(caseFromText(t, { source: t }));
    }
  }

  // 设备分组（§13.2.1）：round-robin 分配用例到设备，组内串行、组间并发；同设备靠锁互斥
  const groups = serials.map((serial) => ({ serial, cases: [] }));
  cases.forEach((c, i) => groups[i % serials.length].cases.push(c));
  const active = groups.filter((g) => g.cases.length);
  let aborted = false;

  // MCP 桥提升到 cmdRun 级（性能）：旧实现每条用例都重建连接（stdio 子进程冷启动
  // 1-5s/server + listTools），N 条用例付 N 次握手税。这里建一次、跨用例共享、收尾统一关。
  let sharedBridge = null;
  try {
    const { loadMcpConfig } = await import('../src/mcp/config.js');
    const { createMcpBridge } = await import('../src/mcp/bridge.js');
    const mcpConfig = loadMcpConfig(path.join(PROJECT_ROOT, 'mcp.json'));
    if (!mcpConfig.missing && Object.keys(mcpConfig.servers).length) {
      sharedBridge = await createMcpBridge({ config: mcpConfig, logger: (m) => !flags.quiet && console.warn(m) });
      sharedBridgeRef = sharedBridge; // 供信号退出路径关闭
    }
  } catch (e) {
    console.warn(`[mcp] 桥创建失败（不阻断）：${e?.message ?? e}`);
  }

  let results = [];
  try {
    const settled = await Promise.all(active.map(async (g) => {
      const perGroup = [];
      for (const caseObj of g.cases) {
        if (aborted) { perGroup.push({ case: caseObj.name, exitCode: 2, skipped: true }); continue; }
        const lock = acquireLock(WORKSPACE.lockRoot, g.serial);
        if (!lock.ok) { aborted = true; perGroup.push({ case: caseObj.name, exitCode: 2, error: lock.reason }); continue; }
        try {
          const exitCode = await runOne(caseObj, { flags, serial: g.serial, bridge: sharedBridge });
          perGroup.push({ case: caseObj.name, exitCode });
          if (exitCode === 2) aborted = true; // 环境错误立即终止
        } finally {
          releaseLock(WORKSPACE.lockRoot, g.serial);
        }
      }
      return perGroup;
    }));
    results = settled.flat();
  } finally {
    try { await sharedBridge?.close?.(); } catch { /* ignore */ }
  }
  if (!flags.quiet && parallel > 1) {
    for (const r of results) console.log(`run ${r.case} → exit ${r.exitCode}${r.skipped ? '（已跳过）' : ''}`);
  }
  if (results.some((r) => r.exitCode === 2)) return 2;
  const hasFail = results.some((r) => r.exitCode === 1);
  return hasFail ? 1 : 0;
}

// 单条用例执行：锁 → createDevice → RunRecorder → createAskSession → 逐步 prompt → finish
async function runOne(caseObj, { flags, serial, bridge: sharedBridge = null }) {
  const { createDevice } = await import('../src/device/index.js');
  const { RunRecorder } = await import('../src/recorder/index.js');
  const { openDataset } = await import('../src/store/dataset.js');
  const { createRunContext, createAskSession } = await import('../src/session/create.js');
  const { assemblePrompt } = await import('../src/session/prompt.js');
  const { resolveModelConfig, createModel, baseUrlHash: hashUrl } = await import('../src/session/model.js');
  const { resolveStrategy, createSessionManager } = await import('../src/session/persist.js');
  const { interpolate, buildToolCall, ENGINE_TYPES, waitSelectorFromText } = await import('../src/session/case.js');
  const { loadMcpConfig } = await import('../src/mcp/config.js');
  const { createMcpBridge } = await import('../src/mcp/bridge.js');
  const { createChatClient } = await import('../src/tools/ai.js');

  const opts = {
    yes: !!flags.yes,
    timeoutMs: Number(flags.timeout || 60) * 1000,
    vlmLocate: !!flags['vlm-locate'],
    freshLocate: !!flags['fresh-locate'],
    rollback: flags.rollback || 'on',
  };

  let device;
  let bridge = null;
  let ctx = null;        // 提到 try 外：finally 的网络还原用本 run 自己的 ctx（不用共享指针）
  let runHandle = null;  // 在 activeRuns 中占位的本 run 记录
  try {
    device = await createDevice({ serial, probeFile: WORKSPACE.probeFile });
  } catch (e) {
    console.error(`设备连接失败（${serial}）：${e.message}`);
    return 2;
  }

  try {
    const modelCfg = resolveModelConfig(flags);
    const store = openDataset({ dataDir: WORKSPACE.datasetDir });
    const recorder = new RunRecorder({
      runsDir: WORKSPACE.runDir,
      caseName: caseObj.name,
      device,
      model: { family: modelCfg.family || 'unknown', name: modelCfg.name || 'unknown', baseUrlHash: modelCfg.url ? hashUrl(modelCfg.url) : '' },
    });
    ctx = createRunContext({ device, recorder, store, opts }); ctx.stateDir = WORKSPACE.stateDir;
    ctx.runStartMs = Date.now();
    runHandle = { ctx, device, bridge: null, serial };  // 信号处理用（§2.6.2 ④）；Set 支持并行多 run
    activeRuns.add(runHandle);
    if (!opts.yes && process.stdin.isTTY) ctx.confirm = makeConfirm; // 交互确认钩子（§13.3）

    // MCP：复用 cmdRun 级共享桥（跨用例免重复握手）；未注入时退回自建（兼容 do/ask 直调）
    if (sharedBridge) {
      bridge = sharedBridge;
      ctx.mcp = bridge;
      runHandle.bridge = null; // 共享桥由 cmdRun 收尾关闭，runOne 不得关
    } else {
      const mcpConfig = loadMcpConfig(path.join(PROJECT_ROOT, 'mcp.json'));
      if (!mcpConfig.missing && Object.keys(mcpConfig.servers).length) {
        bridge = await createMcpBridge({ config: mcpConfig, logger: (m) => !flags.quiet && console.warn(m) });
        ctx.mcp = bridge;
        runHandle.bridge = bridge;
      }
    }

    // preflight 预授权（§2.7.2 一层）：**默认关闭**，`--pregrant` 显式开启。
    // ⚠️ 真机实测（2026-10-27）：对掘金 `pm grant` 批量授权后，App **启动即崩溃**
    //    （logcat: Application Error: com.daimajia.gold / Process has died），且 `pm grant` 会杀掉
    //    **正在运行**的 App。故默认不启用；确需消灭授权框时用 --pregrant（并先停止 App）。
    if (flags.pregrant === true) {
      try {
        const caseText = JSON.stringify(caseObj.steps || []);
        const pkg = (caseText.match(/com\.[a-zA-Z][\w]*(?:\.[\w]+)+/) || [])[0] || null;
        if (pkg) {
          const { pregrantPackage } = await import('../src/cli/pregrant.js');
          await device.terminate(pkg).catch(() => {});   // 先在停止态（grant 会杀运行进程）
          const pg = await pregrantPackage(device, pkg);
          if (pg.granted.length) console.warn(`[preflight] 预授权 ${pg.granted.length} 项（已先停止 App）：${pg.granted.join(', ')}`);
          else if (pg.failed.length) console.warn(`[preflight] 预授权 ${pg.failed.length} 项失败（不阻断）`);
        }
      } catch { /* 预授权失败不阻断 */ }
    }

    // 会话策略（§9.1）：secret 类静态预扫 + 运行期兜底删除
    const secretMentioned = /secret_get|sms_read/.test(JSON.stringify(caseObj.steps || []));
    const persist = resolveStrategy({ fresh: !!flags.fresh, cont: !!flags.continue, session: flags.session, keep: flags.keep === undefined ? true : !!flags.keep, hasSecretCalls: secretMentioned });
    if (persist.forcedBySecret) console.warn(persist.reason);
    const sessionManager = await createSessionManager({ strategy: persist.strategy, sessionFile: flags.session, cwd: PROJECT_ROOT });

    // 模型 + 小模型客户端（ai 提取 / VLM 兜底共用）
    let model = null;
    let modelRuntime = null;
    if (modelCfg.url && modelCfg.key) {
      const built = await createModel(modelCfg);
      model = built.model;
      modelRuntime = built.modelRuntime;
      ctx.chat = createChatClient({ url: modelCfg.url, key: modelCfg.key, model: modelCfg.name });
    } else {
      console.warn('未配置 ASK_MODEL_*，将以无模型模式执行（仅日志回放/干跑）');
    }

    // 设备事实采集（L2 占位符填充）：try/catch 包住，采集失败降级为不传
    let deviceFacts = null;
    try { deviceFacts = await collectDeviceFacts(device, { serial }); } catch { /* 降级 */ }

    // 启动自检（§2.6.2 ⑤）：上次 run 可能没还原干净。仅当设备支持 net 时才检查，避免噪音。
    // 复用 facts 已采的 netProfile（旧实现在 facts 内已查一次 netStatus，这里又查一次）。
    if (deviceFacts && deviceFacts.netSupported === true) {
      try {
        const profile = deviceFacts.netProfile ?? null;
        if (profile && profile !== 'off' && profile !== 'unknown') {
          console.warn(`[warn] 设备网络档位为 ${profile}（上次 run 未还原？），已自动恢复为 off`);
          await device.netSetProfile('off');
        }
      } catch { /* 自检失败不阻断 */ }
    }

    // 三层提示词（§6）
    const prompt = assemblePrompt({
      mode: flags['prompt-mode'] || 'append',
      prompt: flags.prompt || '',
      promptFile: flags['prompt-file'] || '',
      projectRoot: PROJECT_ROOT,
      facts: deviceFacts,
    });
    for (const w of prompt.warnings) console.warn(`[warn] ${w}`);

    // 工具实例只建一次（性能+一致性）：旧实现 createAskSession 内建一套、toolMap 又建一套，
    // screen_diff 的基线 hash 等闭包状态会分裂成两份。同一数组同时给 agent 与引擎直执行。
    const { buildTools } = await import('../src/tools/index.js');
    const runTools = buildTools(ctx);
    const session = await createAskSession(ctx, {
      systemPrompt: prompt.systemPrompt,
      sessionManager,
      model,
      modelRuntime,
      tools: runTools,
    });

    // 引擎直执行步骤用：工具名 → 工具（与 agent 共用同一批实例）
    const toolMap = new Map(runTools.map((t) => [t.name, t]));

    // 逐步骤执行。ai/aiQuery/aiAssert 的设备动作由工具记账包装自动写入 steps[]（§14.1），
    // 这里只记用例级的 net/sleep/aiWaitFor（它们不走工具层）。
    // ${var} 逐步插值（§7.5 执行期插值）：data_extract 运行期写入的变量对后续步骤生效。
    // 不做整体预插值——那样运行期变量永远取不到（C2 验证暴露）。
    const steps = caseObj.steps;
    let status = 'pass';
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      ctx.currentStepIndex = i;
      // 坐标缓存键（§2.1）：步骤身份 + 该步骤内定位序号；每步重置 ordinal
      ctx.currentStepKey = { caseId: caseObj.source || caseObj.name || 'case', stepIndex: i };
      ctx.locateOrdinal = 0;
      try {
        if (step.type === 'sleep') {
          const handle = recorder.startStep('sleep', `${step.seconds}s`);
          await new Promise((r) => setTimeout(r, (step.seconds || 0) * 1000));
          handle.end({ result: 'ok' });
          continue;
        }
        if (step.type === 'net') {
          const handle = recorder.startStep('net', step.profile);
          // 切网前记录（§2.6）：收尾/中断时据此还原到改动前的档位
          try {
            const { recordNetMutation } = await import('../src/state-mutations.js');
            await recordNetMutation(ctx, device, step.profile);
          } catch { /* 记账失败不阻断切网 */ }
          const nr = await device.netSetProfile(step.profile);
          recorder.addNetworkEvent({ at: Date.now() - ctx.runStartMs, profile: step.profile });
          handle.end({ result: nr.ok ? 'ok' : 'failed', error: nr.ok ? null : (nr.error || 'net 命令失败') });
          continue;
        }
        // 引擎直执行步骤（§2.4 混合执行）：aiTap/aiInput/aiLongPress/aiKeyboardPress/aiScroll/launch/terminate
        // 直接调对应工具（复用工具层记账），不经 agent 选工具；执行后把结果注入上下文，保持 agent 不失忆。
        if (ENGINE_TYPES.has(step.type)) {
          const call = buildToolCall({ ...step, text: interpolate(step.text, ctx.vars), value: interpolate(step.value, ctx.vars) });
          if (call) {
            const tool = toolMap.get(call.tool);
            if (tool) {
              // 引擎直执行：0 轮模型往返（这正是拆分粗粒度 ai: 的收益来源）。
              // 结果**不进 session**（那会多一轮 LLM 请求）；记录到 ctx.engineLog 仅作 run 内调试/排查用（recorder 不消费，引擎步的 run.json 记录来自 withRecording 包装）。
              const res = await tool.execute(`engine-${i}`, call.params, null, null, {});
              const d = res?.details ?? {};
              ctx.engineLog.push({ step: i, type: step.type, tool: call.tool, ok: d.ok !== false, error: d.error ?? null });
              if (d.ok === false) console.warn(`[engine] ${step.type}「${step.text ?? ''}」失败：${d.error || ''}`);
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
          const sel = waitSelectorFromText(stepText);
          let r;
          if (sel) {
            // 有具体元素 → 等它出现（比等树不变更语义、通常更快）
            r = await device.waitForElement(sel, { timeoutMs: timeout });
            handle.end({ result: 'ok' });
            if (!r.appeared && !flags.quiet) console.warn(`[warn] aiWaitFor「${stepText}」超时未见元素（${sel}，dump ${r.dumps} 次）`);
          } else {
            r = await device.waitIdle({ quiet, timeoutMs: timeout });
            handle.end({ result: 'ok' });
          }
          continue;
        }

        // 断言附图（性能）：旧实现 prompt 不带图，模型必须先调一次 screen 工具
        // （= 额外一整轮模型往返 ~10s + 工具执行 ~3s）才能作答。这里直接随 prompt
        // 附当前屏压缩图，断言一轮完成。取图失败则退回无图（模型仍可自行调 screen）。
        // 同时注入前台包名事实：截图无法表达"前台是哪个包"，不注入会诱导模型调工具核实，
        // 导致断言步无文本输出（曾误判"模型无输出"）。
        let promptImages = [];
        let fgNote = '';
        if (step.type === 'aiAssert') {
          try {
            const { compressForContext } = await import('../src/image/png.js');
            const shot = await device.screencap();
            const c = await compressForContext(shot.buffer, { maxWidth: 540, quality: 70 });
            promptImages = [{ type: 'image', data: c.buffer.toString('base64'), mimeType: c.mimeType }];
          } catch { /* 取图失败不阻断断言 */ }
          try {
            const fg = await device.foreground();
            if (fg?.package) fgNote = `\n（系统事实：当前前台包名为 ${fg.package}，Activity 为 ${fg.activity ?? '未知'}）`;
          } catch { /* 前台事实缺失不阻断 */ }
        }
        const text = (step.type === 'aiAssert')
          ? `【断言】${stepText}${fgNote}\n只依据随附的当前屏幕截图与上述系统事实判断，不要调用任何工具。只输出一行 JSON：{"passed": true/false, "reason": "不超过30字"}。`
          : (step.type === 'aiQuery' && step.name)
            ? `${stepText}\n（把结果用 data_extract 或 data_store 落到数据集「${step.name}」）`
            : stepText;
        await session.prompt(text, { images: promptImages });
        const answer = lastAssistantText(session);
        ctx.lastThought = answer;
        if (step.type === 'aiAssert') {
          const { parseVerdict } = await import('../src/tools/ai.js');
          const verdict = parseVerdict(answer);
          recorder.addAssertion({ text: step.text, passed: verdict.passed, reason: verdict.reason });
          ctx.assertions.push({ text: step.text, passed: verdict.passed, reason: verdict.reason });
        }
      } catch (e) {
        status = 'error';
        break;
      } finally {
        // 会话历史截图治理（§16）：保留最近 N 张图（--keep-images，默认 3），更早的替换为
        // 文字占位符，避免 prompt tokens 随历史线性膨胀（实测 20 张图 → 67k tokens / 单轮 26s）。
        try {
          const msgs = session.agent?.state?.messages;
          if (Array.isArray(msgs)) {
            const { pruneImages } = await import('../src/session/image-prune.js');
            const keepN = Number(flags['keep-images']); const pr = pruneImages(msgs, { keepRecent: Number.isFinite(keepN) && keepN >= 1 ? keepN : 3 });
            if (pr.replaced > 0) ctx.imagesPruned = (ctx.imagesPruned || 0) + pr.replaced;
          }
        } catch { /* 剪枝失败不阻断 */ }
      }
    }

    // 断言失败判定（exit code 1）
    if (ctx.assertions.some((a) => !a.passed)) status = 'fail';

    // 运行期兜底：secret 类调用发生过 → 会话文件不得留盘（§9.1 例外）
    if (ctx.secretCalls.length > 0 && persist.strategy !== 'fresh' && session.sessionFile) {
      try { fs.rmSync(session.sessionFile, { force: true }); console.warn('检测到 secret_get/sms_read 调用，已删除会话文件（凭据不落盘）'); } catch { /* ignore */ }
    }

    // 收尾：报告（网络还原已移至 finally，保证异常/中断路径也执行，§2.6.2 ①）
    await recorder.finish(status === 'pass' ? 'pass' : status, { exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : 2 });
    session.dispose?.();
    if (!flags.quiet) console.log(`run ${caseObj.name} → ${status}（报告: ${recorder.jsonPath}）`);
    if (flags.json) out(flags, { case: caseObj.name, status, runId: recorder.runId, report: recorder.jsonPath });
    return status === 'pass' ? 0 : status === 'fail' ? 1 : 2;
  } finally {
  // 网络还原（§2.6.2 ① + ③）：无条件执行；失败要 warn + 记 rollback，不静默。
  // 用本 run 局部的 ctx（并行时共享 activeRun 指针会串台——复审发现；ctx 在上方提到 try 外声明）
  try {
    const { restoreNetwork } = await import('../src/state-mutations.js');
    const r = await restoreNetwork(device, ctx ?? { stateMutations: [] });
    if (r && r.ok === false) {
      console.error(`[warn] 网络还原失败：设备可能仍处于异常档位，需人工恢复（${r.error}）`);
      try { ctx?.recorder?.addRollback?.({ stepIndex: null, reason: '网络还原失败', recovered: false }); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error(`[warn] 网络还原异常：${e?.message ?? e}`);
  }
    // 收尾：坐标缓存攒批 flush 放 finally——run 中途抛错（环境错误等）也要排空，
    // 否则去抖 timer 被 process.exit 掐掉，pending 缓存行丢失（旧实现即时 upsert 无此问题）
    try { await ctx?.locateWithCache?.flush?.(); } catch { /* 缓存 flush 失败不阻断收尾 */ }
    // 只关本 run 自建的桥；cmdRun 级共享桥由其收尾统一关闭（runHandle.bridge 为 null）
    try { if (runHandle?.bridge) await runHandle.bridge.close?.(); } catch { /* ignore */ }
    try { await device.close(); } catch { /* ignore */ }
    if (runHandle) activeRuns.delete(runHandle);
  }
}

// ask "<question>" — 只读问答：只放行感知/等待/数据查询类工具
async function cmdAsk({ positional, flags }) {
  const question = positional.join(' ');
  if (!question) fail('ask 需要一个问题文本');
  const { createDevice } = await import('../src/device/index.js');
  const { openDataset } = await import('../src/store/dataset.js');
  const { createRunContext, createAskSession } = await import('../src/session/create.js');
  const { assemblePrompt } = await import('../src/session/prompt.js');
  const { resolveModelConfig, createModel } = await import('../src/session/model.js');
  const { createSessionManager } = await import('../src/session/persist.js');
  const { buildTools } = await import('../src/tools/index.js');

  const READ_ONLY = new Set(['screen', 'uitree', 'locate', 'screen_diff', 'read', 'wait_idle', 'net_status', 'ui_dump', 'data_query']);
  const serialList = await resolveSerials(flags);
  if (!serialList.length) fail('未找到在线设备（adb devices），请用 --device <serial> 指定');
  const serial = serialList[0];
  let device;
  let ctx = null; // 提升到 try 外：finally 的坐标缓存 flush 需要可见
  try { device = await createDevice({ serial, probeFile: WORKSPACE.probeFile }); } catch (e) { fail(`设备连接失败（${serial}）：${e.message}`); }
  try {
    const store = openDataset({ dataDir: WORKSPACE.datasetDir });
    ctx = createRunContext({ device, recorder: null, store, opts: { yes: true, timeoutMs: Number(flags.timeout || 60) * 1000 } }); ctx.stateDir = WORKSPACE.stateDir;
    const modelCfg = resolveModelConfig(flags);
    let model = null;
    let modelRuntime = null;
    if (modelCfg.url && modelCfg.key) {
      const built = await createModel(modelCfg);
      model = built.model;
      modelRuntime = built.modelRuntime;
    } else {
      fail('ask 命令需要模型（ASK_MODEL_*），用于回答问题');
    }
    // 设备事实采集（L2 占位符填充）：try/catch 包住，采集失败降级为不传
    let deviceFacts = null;
    try { deviceFacts = await collectDeviceFacts(device, { serial }); } catch { /* 降级 */ }
    const prompt = assemblePrompt({
      // replace：跳过 L1 引擎层、保留 L2 安卓层，并把只读约束作为 L3 用户层注入；
      // 之前用 none 会把这段约束整个丢掉（评审发现：L3 在 none 模式下被跳过）
      mode: 'replace',
      prompt: '你是只读问答助手。只允许观察（screen/uitree/read/data_query），绝不点击或输入。回答要基于工具返回的事实。',
      projectRoot: PROJECT_ROOT,
      facts: deviceFacts,
    });
    for (const w of prompt.warnings) console.warn(`[warn] ${w}`);
    // 只读工具白名单过滤
    const filtered = buildTools(ctx).filter((t) => READ_ONLY.has(t.name));
    const session = await createAskSession(ctx, {
      systemPrompt: prompt.systemPrompt,
      sessionManager: await createSessionManager({ strategy: 'fresh', cwd: PROJECT_ROOT }),
      model,
      modelRuntime,
      tools: filtered,
    });
    await session.prompt(question);
    // 回显回答：复用 lastAssistantText（否则命令静默退出，用户看不到答案）
    const answer = lastAssistantText(session) ?? '';
    const messageCount = (session?.agent?.state?.messages ?? session?.messages ?? []).length;
    session.dispose?.();
    if (flags.json) out(flags, { answer, messageCount });
    else console.log(answer || '(无回答)');
    return answer ? 0 : 3;
  } finally {
    try { await ctx?.locateWithCache?.flush?.(); } catch { /* ignore */ }
    try { await device.close(); } catch { /* ignore */ }
  }
}

// data — 数据集子命令
async function cmdData({ positional, flags }) {
  const sub = positional[0] || 'list';
  const { openDataset } = await import('../src/store/dataset.js');
  const store = openDataset({ dataDir: WORKSPACE.datasetDir });
  const name = positional[1];

  if (sub === 'list') {
    const dir = WORKSPACE.datasetDir;
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
    const rows = files.map((f) => {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).length;
      return { name: f.replace(/\.jsonl$/, ''), rows: lines };
    });
    out(flags, rows, rows.map((r) => `${r.name}  ${r.rows} rows`).join('\n') || '(无数据集)');
    return 0;
  }
  if (!name) fail(`data ${sub} 需要数据集名`);
  if (sub === 'show') {
    const rows = (await store.read(name)).slice(0, Number(flags.limit || 5));
    out(flags, rows, JSON.stringify(rows, null, 2));
    return 0;
  }
  if (sub === 'query') {
    const rows = await store.query(name, {
      where: flags.where, select: flags.select ? String(flags.select).split(',') : undefined,
      limit: flags.limit ? Number(flags.limit) : undefined, orderBy: flags['order-by'] || flags.orderBy,
    });
    out(flags, rows, JSON.stringify(rows, null, 2));
    return 0;
  }
  if (sub === 'export') {
    const rows = await store.read(name);
    const fmt = flags.format || 'csv';
    // 默认导出到工作区 dataset 目录，不污染项目根/cwd
    const dest = flags.out || path.join(WORKSPACE.datasetDir, `${name}.${fmt === 'json' ? 'json' : 'csv'}`);
    if (fmt === 'json') {
      fs.writeFileSync(dest, JSON.stringify(rows, null, 2));
    } else {
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n');
      fs.writeFileSync(dest, csv);
    }
    if (!flags.quiet) console.log(`exported ${name} → ${dest}`);
    return 0;
  }
  if (sub === 'clear') {
    await store.clear(name);
    if (!flags.quiet) console.log(`cleared ${name}`);
    return 0;
  }
  if (sub === 'diff') {
    const rows = await store.read(name);
    const lastRun = rows.length ? rows[rows.length - 1]._run : null;
    const prev = rows.filter((r) => r._run !== lastRun);
    const cur = rows.filter((r) => r._run === lastRun);
    const summary = { dataset: name, lastRun, currentRows: cur.length, previousRows: prev.length, current: cur.slice(0, 5), previous: prev.slice(-5) };
    out(flags, summary, JSON.stringify(summary, null, 2));
    return 0;
  }
  fail(`未知 data 子命令：${sub}`);
}

// lint — 静态校验（§13.4）
async function cmdLint({ positional, flags }) {
  const files = positional.filter((p) => !p.startsWith('-'));
  if (!files.length) fail('lint 需要至少一个用例文件');
  const { lintCaseText } = await import('../src/lint/rules.js');
  const all = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.resolve(f), 'utf8'); } catch { fail(`用例文件不可读：${f}`); }
    for (const it of lintCaseText(text)) all.push({ file: f, ...it });
  }
  const strict = !!flags.strict;
  const errors = all.filter((i) => i.level === 'error' || (strict && i.level === 'warn'));
  if (!flags.quiet) {
    for (const it of all) console.log(`${it.file}:${it.line}  [${it.level}] ${it.rule}: ${it.message}`);
    console.log(`\n${all.length} finding(s), ${errors.length} error(s)${strict ? '（strict：warn 计入 error）' : ''}`);
  }
  out(flags, { findings: all, errors: errors.length });
  return errors.length ? 1 : 0;
}

// doctor — 环境自检
async function cmdDoctor({ flags }) {
  const checks = [];
  if (flags['cache-report']) {
    const p = path.resolve(flags['cache-report']);
    if (!fs.existsSync(p)) fail(`找不到 run 报告：${p}`);
    const run = JSON.parse(fs.readFileSync(p, 'utf8'));
    const locates = (run.steps || []).filter((s) => s.locate);
    const hits = locates.filter((s) => s.locate.treeCacheHit || s.locate.vlmCacheHit).length;
    const dumpMs = locates.reduce((n, s) => n + (s.locate.dumpMs || 0), 0);
    const summary = {
      locateCalls: locates.length, cacheHits: hits,
      hitRate: locates.length ? +(hits / locates.length).toFixed(3) : null,
      totalDumpMs: dumpMs,
    };
    out(flags, summary, `缓存命中: ${summary.cacheHits}/${summary.locateCalls} (${summary.hitRate})，累计 dump ${summary.totalDumpMs}ms`);
    return 0;
  }
  if (flags.device || !flags.model) {
    const { createDevice } = await import('../src/device/index.js');
    let entry = { item: 'device', ok: false };
    try {
      const serial = flags.device === true ? undefined : flags.device;
      const device = await createDevice(serial ? { serial } : {});
      const size = await device.screenSize().catch((e) => ({ error: e.message }));
      entry = { item: 'device', ok: !size.error, serial: serial || '(auto)', size };
      await device.close();
    } catch (e) {
      entry = { item: 'device', ok: false, error: e.message };
    }
    checks.push(entry);
  }
  if (flags.model || (!flags.device && !flags['cache-report'])) {
    const { resolveModelConfig } = await import('../src/session/model.js');
    const cfg = resolveModelConfig(flags);
    checks.push({ item: 'model', ok: !!(cfg.url && cfg.key && cfg.name), url: cfg.url || null, name: cfg.name || null, note: cfg.url ? undefined : '未配置 ASK_MODEL_*' });
  }
  const ok = checks.every((c) => c.ok);
  out(flags, { ok, checks }, checks.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.item}${c.error ? ' — ' + c.error : ''}`).join('\n'));
  return ok ? 0 : 2;
}

// mcp — MCP 管理子命令
async function cmdMcp({ positional, flags }) {
  const sub = positional[0] || 'list';
  const { loadMcpConfig } = await import('../src/mcp/config.js');
  const { createMcpBridge } = await import('../src/mcp/bridge.js');
  const cfg = loadMcpConfig(path.join(PROJECT_ROOT, 'mcp.json'));
  if (cfg.missing || !Object.keys(cfg.servers).length) {
    out(flags, { servers: [], note: 'mcp.json 无 server 配置' }, 'mcp.json 无 server 配置');
    return 0;
  }
  const bridge = await createMcpBridge({ config: cfg, logger: (m) => console.warn(m) });
  try {
    if (sub === 'list') {
      const rows = bridge.servers.map((s) => ({ server: s.name, status: s.status, tools: bridge.tools.filter((t) => t.server === s.name).map((t) => t.finalName) }));
      out(flags, rows, rows.map((r) => `${r.server} [${r.status}] ${r.tools.join(', ') || '(无放行工具)'}`).join('\n'));
      return 0;
    }
    if (sub === 'check') {
      const rows = bridge.servers.map((s) => ({ server: s.name, status: s.status, error: s.error }));
      out(flags, rows, rows.map((r) => `${r.status === 'ok' ? 'OK  ' : 'FAIL'} ${r.server}${r.error ? ' — ' + r.error : ''}`).join('\n'));
      return rows.every((r) => r.status === 'ok') ? 0 : 2;
    }
    if (sub === 'call') {
      const tool = positional[1];
      if (!tool) fail('mcp call 需要 tool 名');
      let args = {};
      // 参数来源：--args 优先，其次接受第三个位置参数的 JSON（ask mcp call tool '{"k":v}'）
      const rawArgs = flags.args !== undefined ? flags.args : positional[2];
      if (rawArgs !== undefined) { try { args = JSON.parse(rawArgs); } catch { fail('--args 不是合法 JSON'); } }
      try {
        const { text } = await bridge.callByName(tool, args);
        out(flags, { tool, result: text }, text);
        return 0;
      } catch (e) {
        fail(`MCP 调用失败：${e.message}`);
      }
    }
    fail(`未知 mcp 子命令：${sub}`);
  } finally {
    await bridge.close();
  }
}

async function main() {
  const { cmd, positional, flags } = parseArgv(process.argv.slice(2));
  if (flags.version) { console.log('ask 0.1.0'); return 0; }
  if (cmd === 'help' || flags.help) { console.log(usage); return 0; }
  // 需要落盘的子命令先确保工作区目录存在（lint 只读，跳过）
  if (cmd !== 'lint') {
    try { ensureWorkspace(WORKSPACE); } catch (e) { console.warn(`[warn] 工作区目录创建失败：${e?.message ?? e}`); }
  }
  switch (cmd) {
    case 'run': return cmdRun({ positional, flags });
    case 'do': return cmdRun({ positional: [positional.join(' ')], flags });
    case 'ask': return cmdAsk({ positional, flags });
    case 'data': return cmdData({ positional, flags });
    case 'lint': return cmdLint({ positional, flags });
    case 'doctor': return cmdDoctor({ flags });
    case 'mcp': return cmdMcp({ positional, flags });
    default:
      console.error(`未知命令：${cmd}\n`);
      console.log(usage);
      return 2;
  }
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(2);
});
