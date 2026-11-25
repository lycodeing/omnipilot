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
import { createContextGovernor } from '../src/session/context-governor.js';
import { REPLAY_ACTION_TYPES } from '../src/tools/vocab.js';
import { createPlanCache, planKey } from '../src/session/plan-cache.js';
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

// --vlm-locate 的视觉定位函数工厂（runOne / cmdAsk 共用）。
// 坐标约定用 model family 的 describeForPrompt 描述，返回交给 locate 的 toPixels 解析；
// 截图先经 compressForContext 降采样（全尺寸 PNG base64 ~570KB/次太贵，终审 Minor #7）。
async function buildVlmLocate(ctx, modelCfg) {
  const { resolveStrategy } = await import('../src/device/coord/registry.js');
  const { compressForContext } = await import('../src/image/png.js');
  const cs = resolveStrategy(modelCfg.family);
  return async ({ png, target, instruction }) => {
    let img = { data: png.toString('base64'), mimeType: 'image/png' };
    try {
      const c = await compressForContext(png, { maxWidth: 720, quality: 70 });
      img = { data: c.buffer.toString('base64'), mimeType: c.mimeType };
    } catch { /* 压缩失败用原图 */ }
    const fmt = cs?.describeForPrompt?.() || 'Return coordinates normalized to 0-1000.';
    // 必须给"找不到"的出口：否则目标不在屏上时模型会被迫编造坐标（真机事故：
    // 编造坐标点中无关卡片 → 进入错误页面）。toNumbers 对无数字回复返回空 →
    // locate 走"VLM 返回无法解析"失败路径，安全。
    const raw = await ctx.chat(
      `Locate the UI element described as: ${target}. ${instruction || ''} ${fmt} If the target is NOT visible on this screen, reply with exactly: NOT_FOUND. Otherwise reply with ONLY the numbers.`,
      { images: [img] },
    );
    return { raw, family: modelCfg.family };
  };
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
                      （--timeout：整 run 时间预算秒数，主循环/马拉松/重试各处生效；缺省不限）
  --allow-coords      放行坐标步骤（tap: { x, y }）。默认禁止把坐标写进用例（2026-09-24 裁定）；
                      用例顶层 allowCoords: true 等效，CLI 优先级更高
  --keep-images <n>   会话历史保留最近 n 张截图（默认 3；断言密集用例可设 2 省 token）
  --context-steps <n|all> 步骤上下文窗口：保留最近 n 步原文 + 整体描述（默认 3；all=全部保留；
                      优先级高于用例 YAML 顶层 context: 键）
  --rollback <on|off> 网络档位改动收尾自动还原（默认 on）
  会话保留: --keep(默认) --fresh --continue --session <file> --keep-data（历史 flag，当前 no-op）
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

// 步内/轮内追加 prompt 前的网关防护（同步）：把历史里的 role:'tool' 轮全折叠为纯文本。
// 网关对含 role:tool 的历史返回 400（对照实验实证）；每步 finally 的步间折叠覆盖不到
// "同一步/同一问答内第 2 轮 prompt"，催答/续作/视觉确认轮必须自带本折叠。
// 评审 C-A1：折叠经 governor 落 appendContextEdit（对实际请求生效）；旧原地改写版
// foldToolHistoryForFollowup 已删除——SDK 每次请求前重建投影，原地改写从未到达模型。

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
      const parsed = parseCaseText(text, { source: t, allowCoords: flags['allow-coords'] ? true : null });
      // 装载期告警（外部框架兼容提示：sleep 毫秒换算、被忽略的 timeout 等）
      for (const w of parsed.warnings || []) console.warn(`[warn] ${w}`);
      cases.push(parsed);
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
        if (!lock.ok) { aborted = true; perGroup.push({ case: caseObj.name, exitCode: 2, error: lock.reason }); console.error(`[lock] ${lock.reason}`); continue; }
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
  const { interpolate, buildToolCall, ENGINE_TYPES, COORD_TYPES, waitSelectorFromText, resolveLoopPlan } = await import('../src/session/case.js');
  const { LOCATE_DEGRADE_POLICY, MARATHON_MARKER_WAIT_MS } = await import('../src/device/locate-policy.js');
  const { loadMcpConfig } = await import('../src/mcp/config.js');
  const { createMcpBridge } = await import('../src/mcp/bridge.js');
  const { createChatClient } = await import('../src/tools/ai.js');

  const opts = {
    yes: !!flags.yes,
    // 整 run 时间预算（cases/README："整 run 时长由 --timeout 控制"）。此前 opts.timeoutMs
    // 全仓零消费者是死配置（实测 run 超预算仍不退出）；现在 runDeadline 在主循环/马拉松/
    // 空轮重试各处生效。缺省 0 = 不限（兼容未传 flag 的既有调用），传了才生效。
    timeoutMs: flags.timeout != null ? Number(flags.timeout) * 1000 : 0,
    vlmLocate: !!flags['vlm-locate'],
    freshLocate: !!flags['fresh-locate'],
    rollback: flags.rollback || 'on',
  };
  const runDeadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : 0;

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
      reportDir: WORKSPACE.reportDir,   // HTML 报告落 <instance>/report/（与布局承诺一致）
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
        // 目标包名解析（评审 #4）：顶层 targetPackage > launch 步 appId > 正则兜底（历史
        // 行为——断言/URL 里任何 com.* 都可能抢先误中；兜底命中时显式 warn 提示声明）
        let pkg = caseObj.targetPackage || null;
        if (!pkg) {
          const launchStep = (caseObj.steps || []).find((s) => s.type === 'launch' && (s.appId || s.text));
          if (launchStep) pkg = String(launchStep.appId || launchStep.text).split('/')[0];
        }
        if (!pkg) {
          const caseText = JSON.stringify(caseObj.steps || []);
          pkg = (caseText.match(/com\.[a-zA-Z][\w]*(?:\.[\w]+)+/) || [])[0] || null;
          if (pkg) console.warn(`[warn] pregrant 未声明 targetPackage，从步骤文本提取到 "${pkg}"（可能误中；建议用例顶层声明 targetPackage）`);
        }
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
      ctx.modelCfg = modelCfg; // 视觉作答（tap_each_row 缺省形态）需要坐标族

      // --vlm-locate：把 chat 客户端包装成视觉定位函数注入 locate 策略链第 5 环（§5.1）。
      // 旧实现该 flag 只被读去做统计、vlm 从未接线（定位失败无视觉兜底）。
      // 视觉定位默认启用：引擎定位 MISS 时做确定性视觉接地（截图→坐标→tap），不耗 agent 轮
      ctx.vlm = await buildVlmLocate(ctx, modelCfg);
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
    const { buildTools, buildEngineTools } = await import('../src/tools/index.js');
    const runTools = buildTools(ctx);
    const session = await createAskSession(ctx, {
      systemPrompt: prompt.systemPrompt,
      sessionManager,
      model,
      modelRuntime,
      // buildTools 只含契约工具（25 个）；引擎专用工具（point_tap）不进模型面——
      // 模型仍被禁止给像素坐标（tap.description 即 2026-09-24 裁定原文）
      tools: runTools,
    });
    // 上下文治理执行后端（评审 C-A1）：四道治理经 appendContextEdit 对实际请求生效，
    // 持久化历史保留原文（append-only）。旧原地改写 state.messages 的版本被 SDK
    // 请求前投影重建覆盖，治理从未到达模型——governor 是唯一执行路径。
    const gov = createContextGovernor({ sessionManager });

    // 引擎直执行步骤用：工具名 → 工具。契约工具与引擎专用工具（point_tap）合并，
    // 使 buildToolCall 产出的坐标调用也能命中有记账包装的实例。
    const toolMap = new Map([...runTools, ...buildEngineTools(ctx)].map((t) => [t.name, t]));

    // —— 动作计划缓存（业界调研落地，Midscene caching 同款）——
    // 包装工具 execute 记录"本步实际使用的工具调用序列"（仅统计，不改行为）；ai/aiAct 步
    // 结束时若全部调用成功，则缓存完整调用序列（plan）。二次执行同一步骤时按序回放
    // （0 模型往返），任一调用失败即中止回放、删条目、回退模型规划。
    // 马拉松步（文本含终止条件的续作循环）不缓存：其后续动作依赖逐轮页面状态，整段
    // 回放不安全（Midscene 同款取舍）。
    const lastTool = { calls: [] };
    for (const t of runTools) {
      const orig = t.execute.bind(t);
      t.execute = async (id, params, ...rest) => {
        const r = await orig(id, params, ...rest);
        lastTool.calls.push({ tool: t.name, params, ok: r?.details ? r.details.ok !== false : true });
        return r;
      };
    }
    const planCache = createPlanCache(WORKSPACE.stateDir);
    const planKeyOf = (i, stepText) => planKey({
      caseId: caseObj.source || caseObj.name || 'case',
      stepIndex: i,
      stepText,
    });

    // 逐步骤执行。ai/aiQuery/aiAssert 的设备动作由工具记账包装自动写入 steps[]（§14.1），
    // 这里只记用例级的 net/sleep/aiWaitFor（它们不走工具层）。
    // ${var} 逐步插值（§7.5 执行期插值）：data_extract 运行期写入的变量对后续步骤生效。
    // 不做整体预插值——那样运行期变量永远取不到（C2 验证暴露）。
    const steps = caseObj.steps;
    let status = 'pass';
    let engineFailed = false; // 引擎步失败标记（含降级后仍失败）：零断言用例不能因 exit 0 恒判 pass

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
        const { compressForContext } = await import('../src/image/png.js');
        const raw = await device.screencap();
        const c = await compressForContext(raw.buffer, { maxWidth: 720, quality: 70 });
        shot = { data: c.buffer.toString('base64'), mimeType: c.mimeType };
      } catch { return 0; }
      const { resolveStrategy } = await import('../src/device/coord/registry.js');
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
        const { repairJson } = await import('../src/tools/ai.js');
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
    // 非 tool 路径（aiWaitFor 等 ask.js 直记账的步）的报告取证截图：fire-and-forget，
    // 与工具层同款模式（serial 队列保证时序、失败不阻断、finish 前统一排空）
    const attachStepShot = (stepIndex) => {
      try {
        const chain = device.screencap()
          .then((shot) => recorder.attachScreenshot(stepIndex, shot.buffer))
          .catch(() => { /* 取证截图失败不影响 */ });
        recorder.trackPending?.(chain);
      } catch { /* 截图失败不影响 */ }
    };
    // 步内第 2 轮起的 prompt（催答/续作/视觉确认）自带本轮原始 role:'toolResult' 历史，
    // 网关对 role:tool 历史返回 400（对照实验实证）→ 每次追加 prompt 前先同步全折叠为纯文本。
    // governor 落 appendContextEdit：SDK 请求前重建投影时折叠必然生效（旧原地改写被覆盖）。
    const foldForGateway = () => { try { gov.foldToolHistory(); } catch { /* 折叠失败不阻断 */ } };

    // --continue/--session 恢复的历史可能含 role:tool 轮（网关 400）：主循环前先折叠一次
    try { gov.foldToolHistory(); session.refreshContext?.(); } catch { /* 折叠失败不阻断 */ }

    for (let i = 0; i < steps.length; i++) {
      // 整 run 时间预算（--timeout）：到点即止，剩余步骤跳过——实测 run 曾超预算 2 倍仍不退出
      if (runDeadline && Date.now() > runDeadline) {
        console.warn(`[timeout] 已超 --timeout 预算（${Math.round(opts.timeoutMs / 1000)}s），剩余 ${steps.length - i} 步跳过`);
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
                  const { compressForContext } = await import('../src/image/png.js');
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
                const { compressForContext } = await import('../src/image/png.js');
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
        // 数据类断言分流（C-P2）：文本引用数据集时注入行数与样本事实，
        // 不再让模型只凭屏幕截图猜测"数据集 X 至少 N 条"（系统性误判源）。
        let datasetFacts = null;
        let buildAssertPrompt = null;
        if (step.type === 'aiAssert') {
          try {
            ({ buildAssertPrompt, collectDatasetFacts } = await import('../src/session/assert-prompt.js'));
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
            const { compressForContext } = await import('../src/image/png.js');
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
              attachStepShot(recorder.stepCount); // 回放步终态取证
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
            // 循环从不检查 answer——模型每轮回”完成”仍被逼答满轮数上限（实测单步空耗 24-88 分钟）。
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
              const { compressForContext } = await import('../src/image/png.js');
              const s5 = await device.screencap();
              const c5 = await compressForContext(s5.buffer, { maxWidth: 540, quality: 70 });
              freshImgs = [{ type: 'image', data: c5.buffer.toString('base64'), mimeType: c5.mimeType }];
            } catch { /* 取图失败不阻断 */ }
            foldForGateway(); // 步内追加 prompt：先折叠 role:tool 历史（网关 400 防护）
            // 催促话术按形态分流（评审 #1①：批量话术曾把”依次逐个”类任务催成整屏并行点击）：
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
                const { compressForContext } = await import('../src/image/png.js');
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
                const { compressForContext } = await import('../src/image/png.js');
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
        // —— 计划缓存写入：全部工具调用成功的 ai/aiAct 步记完整 plan；马拉松步不缓存
        //（其续作依赖逐轮页面状态，整段回放不安全——Midscene 同款取舍）——
        if (curPlanKey && !marathonRan && lastTool.calls.length >= 1 && lastTool.calls.every((c) => c.ok)) {
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
          const { parseVerdict } = await import('../src/tools/ai.js');
          const verdict = parseVerdict(answer);
          ah.end({ result: verdict.passed ? 'ok' : 'failed' });
          attachStepShot(ah.index); // 报告取证：判定后的画面状态（走既有 step 索引机制）
          // evidenceSource：注入了数据集事实 → dataset 口径；否则屏幕口径。
          // screenshotId（判定输入截图独立落盘）留待 Task 14 attachAssertionShot。
          recorder.addAssertion({ text: step.text, passed: verdict.passed, reason: verdict.reason, evidenceSource: datasetFacts ? 'dataset' : 'screen', nudges: assertNudges });
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
            const { buildStepDigest } = await import('../src/session/context-window.js');
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

    // 运行期兜底：secret 类调用发生过 → 会话文件不得留盘（§9.1 例外）
    if (ctx.secretCalls.length > 0 && persist.strategy !== 'fresh' && session.sessionFile) {
      try { fs.rmSync(session.sessionFile, { force: true }); console.warn('检测到 secret_get/sms_read 调用，已删除会话文件（凭据不落盘）'); } catch { /* ignore */ }
    }

    // 收尾：报告（网络还原已移至 finally，保证异常/中断路径也执行，§2.6.2 ①）
    recorder.setEngineLog(ctx.engineLog); // 引擎步记录落 run.json（失败排查依据；此前只留内存，run 结束即丢）
    await recorder.finish(status === 'pass' ? 'pass' : status, { exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : 2 });
    session.dispose?.();
    if (!flags.quiet) {
      const html = recorder.htmlPath;
      console.log(
        `run ${caseObj.name} → ${status}（报告: ${html ?? recorder.jsonPath}${html ? '；数据: ' + recorder.jsonPath : ''}）`,
      );
    }
    if (flags.json) {
      out(flags, {
        case: caseObj.name,
        status,
        runId: recorder.runId,
        report: recorder.htmlPath ?? recorder.jsonPath,
        data: recorder.jsonPath,
      });
    }
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

  const READ_ONLY = new Set(['screen', 'uitree', 'locate', 'screen_diff', 'read', 'wait_idle', 'wait_element', 'net_status', 'ui_dump', 'data_query']);
  const serialList = await resolveSerials(flags);
  if (!serialList.length) fail('未找到在线设备（adb devices），请用 --device <serial> 指定');
  const serial = serialList[0];
  let device;
  let ctx = null; // 提升到 try 外：finally 的坐标缓存 flush 需要可见
  try { device = await createDevice({ serial, probeFile: WORKSPACE.probeFile }); } catch (e) { fail(`设备连接失败（${serial}）：${e.message}`); }
  try {
    const store = openDataset({ dataDir: WORKSPACE.datasetDir });
    ctx = createRunContext({ device, recorder: null, store, opts: { yes: true, timeoutMs: Number(flags.timeout || 60) * 1000, vlmLocate: !!flags['vlm-locate'] } }); ctx.stateDir = WORKSPACE.stateDir;
    const modelCfg = resolveModelConfig(flags);
    let model = null;
    let modelRuntime = null;
    if (modelCfg.url && modelCfg.key) {
      const built = await createModel(modelCfg);
      model = built.model;
      modelRuntime = built.modelRuntime;
      // ask 的只读白名单含 locate：--vlm-locate 时同样接视觉兜底（与 run 一致，终审 Minor #5）
      if (ctx.opts.vlmLocate) {
        const { createChatClient } = await import('../src/tools/ai.js');
        ctx.chat = createChatClient({ url: modelCfg.url, key: modelCfg.key, model: modelCfg.name });
        ctx.vlm = await buildVlmLocate(ctx, modelCfg);
      }
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
    const askSessionManager = await createSessionManager({ strategy: 'fresh', cwd: PROJECT_ROOT });
    const session = await createAskSession(ctx, {
      systemPrompt: prompt.systemPrompt,
      sessionManager: askSessionManager,
      model,
      modelRuntime,
      tools: filtered,
    });
    // 治理执行后端（评审 C-A1，与 runOne 同款）：催答轮折叠经 appendContextEdit 对请求生效
    const gov = createContextGovernor({ sessionManager: askSessionManager });
    await session.prompt(question);
    // 回显回答：复用 lastAssistantText（否则命令静默退出，用户看不到答案）
    let answer = lastAssistantText(session) ?? '';
    for (let nudge = 0; nudge < 2 && !answer; nudge++) {
      // 模型以纯 toolCall 或空消息收尾：催答重试拿最终文本；催答前折叠 role:tool 历史（网关 400 防护，与 runOne 同款）
      try { gov.foldToolHistory(); } catch { /* 折叠失败不阻断 */ }
      await session.prompt('不要再调用工具。直接用一段文本回答上面的问题。', { images: [] });
      answer = lastAssistantText(session) ?? '';
    }
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

main().then((code) => process.exit(code ?? 0)).catch(async (e) => {
  console.error(e?.stack || e?.message || e);
  // 未捕获异常路径必须释放设备锁：否则设备被锁住直到 stale 超时（10 分钟）。
  // 信号退出走 gracefulExit（已释放），但纯异常路径此前是裸 exit —— 锁泄漏。
  try {
    for (const run of activeRuns) {
      if (run.serial) {
        try { releaseLock(WORKSPACE.lockRoot, run.serial); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  process.exit(2);
});
