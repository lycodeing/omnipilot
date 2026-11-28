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
import { runCaseLoop } from '../src/session/run-loop.js';
import { lastAssistantText } from '../src/session/run-loop-helpers.js';
import { createPlanCache } from '../src/session/plan-cache.js';
import { resolveWorkspace, ensureWorkspace } from '../src/cli/workspace.js';
import { diffByRun } from '../src/store/diff.js';
import { buildVlmLocate } from '../src/vlm/locate-factory.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..');

// —— 命名常量（消除魔法数字）——
/** 退出码：通过 */
const EXIT_PASS = 0;
/** 退出码：用例断言失败（lint：有 error） */
const EXIT_CASE_FAIL = 1;
/** 退出码：环境/配置错误 */
const EXIT_ENV_ERROR = 2;
/** 退出码：ask 问答得到空回答（本机扩展，契约未定义该值） */
const EXIT_EMPTY_ANSWER = 3;
/** 退出码：收到 SIGINT/SIGTERM 中断退出（128 + SIGINT(2)） */
const EXIT_INTERRUPTED = 130;
/** adb devices 探活超时（毫秒） */
const ADB_DEVICES_TIMEOUT_MS = 5000;
/** doctor --model 探活请求超时（毫秒） */
const MODEL_PING_TIMEOUT_MS = 15000;
/** ask 催答重试上限：模型以纯 toolCall/空消息收尾时最多再催几轮 */
const ASK_NUDGE_MAX_ROUNDS = 2;
/** ask 缺省时间预算（秒）：--timeout 未传时的兜底 */
const ASK_DEFAULT_TIMEOUT_SECONDS = 60;
/** data show 缺省展示行数 */
const DATA_SHOW_DEFAULT_LIMIT = 5;
/** 诊断快照目录里 caseName slug 的最大长度（防路径过长） */
const CASE_SLUG_MAX_LENGTH = 60;
/** locate 缓存命中率保留小数位 */
const CACHE_HIT_RATE_DECIMALS = 3;

/**
 * .env 加载（零依赖）：cwd/.env 逐行 KEY=VALUE，不覆盖已有环境变量。
 * 须在 WORKSPACE 解析前调用；无 .env 文件属正常情况，静默跳过。
 */
function loadEnvFile() {
  try {
    const envText = fs.readFileSync(path.resolve('.env'), 'utf8');
    for (const line of envText.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || line.trim().startsWith('#')) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  } catch { /* 无 .env 正常 */ }
}
loadEnvFile();

// 运行时产物与源码分离（见 src/cli/workspace.js）：用例/运行记录/报告/数据集/私有状态落工作区，
// 设备锁与 family 探测缓存落全局（跨实例共享）。
const WORKSPACE = resolveWorkspace();

// 进程级信号处理（§2.6.2 ④）：还原设备状态 + 释放锁，再退出。
// 必须注册在进程作用域（非 runOne 内，避免多 case/并行时累积处理器）。
// 在册集合而非单指针：--parallel 组间并发（Promise.all）时多个 runOne 同时在跑，
// 单指针会互相覆盖——信号处理只能看到最后一个，先结束的 run 还会把别人的 ctx 清掉。
const activeRuns = new Set();   // 每项 { ctx, device, bridge, serial }，runOne 开始时在册、finally 注销
let cleaningUp = false;
let sharedBridgeRef = null;      // cmdRun 级共享 MCP 桥：信号退出时也要能关（runOne 不持有）
let heldSharedLock = null;       // cmdAsk 持有的 shared 读锁：fail() 同步退出前据此自行释放（finally 不执行）

/**
 * 还原单个在册 run 的设备状态并释放其资源（信号退出路径专用）。
 * 顺序：网络还原 → 坐标缓存 flush → recorder 落盘 → cancelled 终态 → 关桥/设备 → 释放锁。
 * 每步独立 try/catch：任一失败不阻断后续清理。
 * @param {{ctx: object, device: object, bridge: object|null, serial: string}} activeRun 在册 run 记录
 */
async function cleanupActiveRun(activeRun) {
  const { restoreNetwork } = await import('../src/state-mutations.js');
  await restoreNetwork(activeRun.device, activeRun.ctx).catch(() => {});
  try { await activeRun.ctx?.locateWithCache?.flush?.(); } catch { /* ignore */ }
  try { await activeRun.ctx?.recorder?.flushPending?.(); } catch { /* ignore */ }
  // 中断也落终态 cancelled（而非留 _partial 增量快照残留）：还原/flush 后、close 前写。
  // 已正常 finish 的 recorder 会抛「不能重复调用」，忽略即可。
  try { await activeRun.ctx?.recorder?.finish?.('cancelled', { exitCode: EXIT_INTERRUPTED }); } catch { /* ignore */ }
  try { await activeRun.bridge?.close?.(); } catch { /* ignore */ }
  try { await activeRun.device?.close?.(); } catch { /* ignore */ }
  if (activeRun.serial) releaseLock(WORKSPACE.lockRoot, activeRun.serial);
}

/**
 * 释放 cmdAsk 持有的 shared 读锁（若有）。
 * cmdAsk 不登记 activeRuns；fail() 同步退出与信号退出都须走这里，否则残留死 pid 锁文件。
 */
function releaseHeldSharedLock() {
  if (!heldSharedLock) return;
  try { releaseLock(heldSharedLock.root, heldSharedLock.serial, { mode: 'shared' }); } catch { /* ignore */ }
  heldSharedLock = null;
}

/**
 * 进程级信号处理（§2.6.2 ④）：还原所有在册 run 的设备状态 + 释放锁，再退出。
 * 防重入（信号 + finally 双触发时只执行一次）。
 * @param {string} signalName 收到的信号名（SIGINT/SIGTERM）
 */
async function gracefulExit(signalName) {
  if (cleaningUp) return;                 // 防重入（信号 + finally 双触发）
  cleaningUp = true;
  console.error(`\n收到 ${signalName}，正在还原设备状态…`);
  try {
    for (const activeRun of activeRuns) {
      await cleanupActiveRun(activeRun);
    }
    try { await sharedBridgeRef?.close?.(); } catch { /* ignore */ }
  } finally {
    releaseHeldSharedLock();
    process.exit(EXIT_INTERRUPTED);
  }
}
process.once('SIGINT', () => gracefulExit('SIGINT'));
process.once('SIGTERM', () => gracefulExit('SIGTERM'));

/**
 * 同步报错退出：打印 Error 后尽力关闭共享桥、释放 shared 读锁，再以指定退出码结束进程。
 * fail 是同步函数、多处同步调用，而 MCP bridge.close 是 async：不 await，进程退出前尽力关闭
 * 共享桥子进程（不改成 async 以免波及全部调用方）；尽力关闭优于完全不关。
 * fail 同步 process.exit，Node 不展开调用栈、cmdAsk 的 finally 不会执行：取锁后若走到 fail
 * （createDevice 失败 / 缺模型配置等），必须在此主动释放 shared 读锁，否则残留死 pid 锁文件，
 * PID 复用时会被误判为存活 shared 而误拒 exclusive（最长 staleMs）。
 * @param {string} message 错误信息
 * @param {number} [exitCode=EXIT_ENV_ERROR] 退出码
 */
function fail(message, exitCode = EXIT_ENV_ERROR) {
  console.error(`Error: ${message}`);
  try { sharedBridgeRef?.close?.()?.catch?.(() => {}); } catch { /* ignore */ }
  releaseHeldSharedLock();
  process.exit(exitCode);
}

// buildVlmLocate 已迁移至 src/vlm/locate-factory.js（顶部 import），三个调用点直接复用。
const usage = `ask — 跨端场景测试 agent（当前落地：Android）

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
  --vlm-locate         视觉定位兜底（run 默认启用；ask 需显式开启）
  --yes --timeout <sec> --fresh-locate --json --quiet --pregrant --clean-data
                      （--timeout：整 run 时间预算秒数；--clean-data：初始化时清空应用数据）
  --allow-coords      放行坐标步骤（tap: { x, y }）。默认禁止把坐标写进用例（2026-09-24 裁定）；
                      用例顶层 allowCoords: true 等效，CLI 优先级更高
  --keep-images <n>   会话历史保留最近 n 张截图（默认 3；断言密集用例可设 2 省 token）
  --context-steps <n|all> 步骤上下文窗口：保留最近 n 步原文 + 整体描述（默认 3；all=全部保留；
                      优先级高于用例 YAML 顶层 context: 键）
  会话保留: --keep(默认) --fresh --continue --session <file> --keep-data（历史 flag，当前 no-op）
`;

// —— 输出辅助 ——
/**
 * 双形态输出：--json 时打印结构化 JSON，否则打印人类可读文本（若提供）。
 * @param {object} flags CLI flags（读 json 位）
 * @param {*} data 结构化数据
 * @param {string} [human] 人类可读文本
 */
function out(flags, data, human) {
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else if (human !== undefined) console.log(human);
}

// —— 默认设备（§13.3：--device 缺省取首个在线设备） ——
/**
 * 执行 adb devices，返回首个在线设备的序列号；adb 不可用/无设备时返回 null。
 * @returns {Promise<string|null>}
 */
async function firstOnlineSerial() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(process.env.ASK_ADB || 'adb', ['devices'], { timeout: ADB_DEVICES_TIMEOUT_MS });
    const deviceLine = stdout.split('\n').map((line) => line.trim()).find((line, index) => index > 0 && line.endsWith('\tdevice'));
    return deviceLine ? deviceLine.split('\t')[0] : null;
  } catch {
    return null;
  }
}

/**
 * 解析目标设备清单，优先级：--devices > --device > ASK_DEVICE 环境变量 > 首个在线设备。
 * @param {object} flags CLI flags
 * @returns {Promise<string[]>} 设备序列号数组（可能为空）
 */
async function resolveSerials(flags) {
  if (flags.devices) return String(flags.devices).split(',').map((serial) => serial.trim()).filter(Boolean);
  if (flags.device) return [flags.device];
  if (process.env.ASK_DEVICE) return [process.env.ASK_DEVICE];
  const onlineSerial = await firstOnlineSerial();
  return onlineSerial ? [onlineSerial] : [];
}

/**
 * 用例文件路径解析：给定路径优先（cwd 相对/绝对），不存在再回退工作区 case 目录的同名文件。
 * 便于 `ask run s1.yaml` 直接引用工作区用例，也兼容显式相对路径。
 * @param {string} casePathArg 用户给定的用例路径
 * @returns {string} 解析后的绝对路径（都不存在时返回 direct，交给调用方报错并带上已尝试路径）
 */
function resolveCasePath(casePathArg) {
  const directPath = path.resolve(casePathArg);
  if (fs.existsSync(directPath)) return directPath;
  const workspacePath = path.join(WORKSPACE.caseDir, casePathArg);
  if (fs.existsSync(workspacePath)) return workspacePath;
  return directPath; // 交给调用方报错，错误信息里带上已尝试路径
}

// —— 交互确认（§13.3：未 --yes 且 TTY 时写操作/MCP 需确认） ——
/**
 * 终端 y/N 交互确认：仅接受 y/yes（大小写不敏感）为确认。
 * @param {string} message 提示语
 * @returns {Promise<boolean>} 用户是否确认
 */
async function makeConfirm(message) {
  process.stdout.write(`${message} (y/N) `);
  const readline = await import('node:readline/promises');
  const readlineInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readlineInterface.question('')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    readlineInterface.close();
  }
}

// 取会话里最近一条**含文本**的 assistant 消息：已下沉到 src/session/run-loop-helpers.js
// （runCaseLoop 与 cmdAsk 共用，cmdAsk 直接 import 复用）。

// 步内/轮内追加 prompt 前的网关防护（同步）：把历史里的 role:'tool' 轮全折叠为纯文本。
// 网关对含 role:tool 的历史返回 400；每步 finally 的步间折叠覆盖不到
// "同一步/同一问答内第 2 轮 prompt"，催答/续作/视觉确认轮必须自带本折叠。
// 折叠经 governor 落 appendContextEdit（对实际请求生效）；SDK 每次请求前重建投影，
// 原地改写不会到达模型。

// —— 设备事实采集见 src/cli/device-facts.js（已抽出以便单测） ——

// —— 子命令实现 ——

/**
 * 装载用例：文件（.yaml/.yml）→ parseCaseText；纯文本 → caseFromText 单步 do。
 * 路径解析先按给定路径（cwd 相对），找不到再回退工作区 case 目录的同名文件。
 * 装载期告警（外部框架兼容提示：sleep 毫秒换算、被忽略的 timeout 等）直接 console.warn。
 * @param {string[]} targets 位置参数中的用例文件路径或任务文本
 * @param {object} flags CLI flags（读 allow-coords）
 * @returns {Promise<object[]>} 解析后的 case 对象数组
 */
async function loadCases(targets, flags) {
  const { parseCaseText, caseFromText } = await import('../src/session/case.js');
  const cases = [];
  for (const target of targets) {
    if (/\.(ya?ml)$/i.test(target)) {
      const resolvedPath = resolveCasePath(target);
      let caseText;
      try { caseText = fs.readFileSync(resolvedPath, 'utf8'); } catch { fail(`用例文件不可读：${target}（已尝试 ${resolvedPath}）`); }
      const parsedCase = parseCaseText(caseText, { source: target, allowCoords: flags['allow-coords'] ? true : null });
      // 装载期告警（外部框架兼容提示：sleep 毫秒换算、被忽略的 timeout 等）
      for (const warning of parsedCase.warnings || []) console.warn(`[warn] ${warning}`);
      cases.push(parsedCase);
    } else {
      cases.push(caseFromText(target, { source: target }));
    }
  }
  return cases;
}

/**
 * 设备分组（§13.2.1）：round-robin 分配用例到设备，组内串行、组间并发；同设备靠锁互斥。
 * aborted 按组隔离（Task 10）：环境错误（exitCode 2）/取锁失败只终止本组后续用例，不跨组传播。
 * @param {object[]} cases 已装载的用例
 * @param {string[]} serials 在线设备序列号清单
 * @returns {{serial: string, cases: object[], aborted: boolean}[]} 有用例的设备组（空组已滤除）
 */
function distributeCasesToDevices(cases, serials) {
  const groups = serials.map((serial) => ({ serial, cases: [], aborted: false }));
  cases.forEach((caseObj, index) => groups[index % serials.length].cases.push(caseObj));
  return groups.filter((group) => group.cases.length);
}

/**
 * 创建 cmdRun 级共享 MCP 桥（性能）：每条用例都重建连接会付 N 次 stdio 子进程冷启动
 * （1-5s/server + listTools）握手税。这里建一次、跨用例共享、收尾统一关。
 * 创建失败仅告警不阻断；成功后登记 sharedBridgeRef 供信号退出路径关闭。
 * @param {object} flags CLI flags（读 quiet 控制日志）
 * @returns {Promise<object|null>} MCP 桥实例；无配置或创建失败时为 null
 */
async function createSharedMcpBridge(flags) {
  try {
    const { loadMcpConfig } = await import('../src/mcp/config.js');
    const { createMcpBridge } = await import('../src/mcp/bridge.js');
    const mcpConfig = loadMcpConfig(path.join(PROJECT_ROOT, 'mcp.json'));
    if (!mcpConfig.missing && Object.keys(mcpConfig.servers).length) {
      const bridge = await createMcpBridge({ config: mcpConfig, logger: (message) => !flags.quiet && console.warn(message) });
      sharedBridgeRef = bridge; // 供信号退出路径关闭
      return bridge;
    }
  } catch (error) {
    console.warn(`[mcp] 桥创建失败（不阻断）：${error?.message ?? error}`);
  }
  return null;
}

/**
 * 执行单个设备组内的用例序列（组内串行）：逐条取独占锁 → runOne → 释放锁。
 * 取锁失败或环境错误（exitCode 2）置 aborted，本组后续用例标记 skipped。
 * @param {{serial: string, cases: object[], aborted: boolean}} group 设备组
 * @param {object} flags CLI flags
 * @param {object|null} sharedBridge cmdRun 级共享 MCP 桥
 * @returns {Promise<object[]>} 本组每条用例的结果 { case, exitCode, skipped?, error? }
 */
async function runDeviceGroup(group, flags, sharedBridge) {
  const groupResults = [];
  for (const caseObj of group.cases) {
    if (group.aborted) { groupResults.push({ case: caseObj.name, exitCode: EXIT_ENV_ERROR, skipped: true }); continue; }
    const lock = acquireLock(WORKSPACE.lockRoot, group.serial);
    if (!lock.ok) {
      group.aborted = true;
      groupResults.push({ case: caseObj.name, exitCode: EXIT_ENV_ERROR, error: lock.reason });
      console.error(`[lock] ${lock.reason}`);
      continue;
    }
    try {
      const exitCode = await runOne(caseObj, { flags, serial: group.serial, bridge: sharedBridge });
      groupResults.push({ case: caseObj.name, exitCode });
      if (exitCode === EXIT_ENV_ERROR) group.aborted = true; // 环境/预算错误只终止本组后续用例
    } finally {
      releaseLock(WORKSPACE.lockRoot, group.serial);
    }
  }
  return groupResults;
}

/**
 * run/do 子命令：装载用例 → 设备分组 → 共享 MCP 桥 → 组间并发执行 → 汇总退出码。
 * @param {{positional: string[], flags: object}} args 解析后的 CLI 参数
 * @returns {Promise<number>} 退出码（任一环境错误 2 > 任一断言失败 1 > 全通过 0）
 */
async function cmdRun({ positional, flags }) {
  const targets = positional.filter((argument) => !argument.startsWith('-'));
  if (!targets.length) fail('run 需要至少一个用例文件或任务文本');
  const parallelCount = Number(flags.parallel || 1);

  // 设备清单与 --parallel 校验（§13.2.1）
  const serials = await resolveSerials(flags);
  if (!serials.length) fail('未找到在线设备（adb devices），请用 --device <serial> 或 --devices 指定');
  if (parallelCount > serials.length) {
    fail(`--parallel ${parallelCount} 需要 ${parallelCount} 台设备，当前仅 ${serials.length} 台在线`);
  }

  const cases = await loadCases(targets, flags);
  const activeGroups = distributeCasesToDevices(cases, serials);
  const sharedBridge = await createSharedMcpBridge(flags);

  let results = [];
  try {
    const settledGroups = await Promise.all(activeGroups.map((group) => runDeviceGroup(group, flags, sharedBridge)));
    results = settledGroups.flat();
  } finally {
    try { await sharedBridge?.close?.(); } catch { /* ignore */ }
  }
  if (!flags.quiet && parallelCount > 1) {
    for (const result of results) console.log(`run ${result.case} → exit ${result.exitCode}${result.skipped ? '（已跳过）' : ''}`);
  }
  if (results.some((result) => result.exitCode === EXIT_ENV_ERROR)) return EXIT_ENV_ERROR;
  const hasCaseFailure = results.some((result) => result.exitCode === EXIT_CASE_FAIL);
  return hasCaseFailure ? EXIT_CASE_FAIL : EXIT_PASS;
}

/**
 * 从 CLI flags 构建 run 级执行选项与整 run 截止时间。
 * timeoutMs：整 run 时间预算（cases/README："整 run 时长由 --timeout 控制"），runDeadline 在
 * 主循环/马拉松/空轮重试各处生效。缺省 0 = 不限（兼容未传 flag 的既有调用），传了才生效。
 * @param {object} flags CLI flags
 * @returns {{opts: object, runDeadline: number}} opts 供 createRunContext；runDeadline 为 0 表示不限
 */
function buildRunOptions(flags) {
  const opts = {
    yes: !!flags.yes,
    timeoutMs: flags.timeout != null ? Number(flags.timeout) * 1000 : 0,
    vlmLocate: !!flags['vlm-locate'],
    freshLocate: !!flags['fresh-locate'],
  };
  const runDeadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : 0;
  return { opts, runDeadline };
}

/**
 * 连接目标设备，按 case 隔离诊断快照目录：避免 workspace 级共享导致长马拉松后上限静默失效，
 * 也避免 --parallel 多 run 并发计数竞态。caseName sanitize 防路径注入。
 * 连接失败打印错误并返回 null（调用方以退出码 2 结束本条用例）。
 * @param {object} caseObj 用例对象（取 name 生成 slug）
 * @param {string} serial 设备序列号
 * @returns {Promise<object|null>} 设备实例；连接失败为 null
 */
async function assembleDevice(caseObj, serial) {
  const { createDevice } = await import('../src/device/index.js');
  const caseSlug = String(caseObj.name ?? 'unknown').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, CASE_SLUG_MAX_LENGTH);
  try {
    return await createDevice({ serial, probeFile: WORKSPACE.probeFile, missDumpDir: path.join(WORKSPACE.runDir, 'locate-miss', caseSlug) });
  } catch (error) {
    console.error(`设备连接失败（${serial}）：${error.message}`);
    return null;
  }
}

/**
 * 创建运行记录器（RunRecorder）：run.json / HTML 报告落工作区对应目录。
 * @param {object} caseObj 用例对象
 * @param {object} device 已连接的设备
 * @param {object} modelConfig 模型配置（family/name/url 摘要入档）
 * @returns {Promise<object>} RunRecorder 实例
 */
async function assembleRecorder(caseObj, device, modelConfig) {
  const { RunRecorder } = await import('../src/recorder/index.js');
  const { baseUrlHash: hashUrl } = await import('../src/session/model.js');
  return new RunRecorder({
    runsDir: WORKSPACE.runDir,
    reportDir: WORKSPACE.reportDir,   // HTML 报告落 <instance>/report/（与布局承诺一致）
    caseName: caseObj.name,
    device,
    model: { family: modelConfig.family || 'unknown', name: modelConfig.name || 'unknown', baseUrlHash: modelConfig.url ? hashUrl(modelConfig.url) : '' },
  });
}

/**
 * 解析本 run 的 MCP 桥：复用 cmdRun 级共享桥（跨用例免重复握手）；未注入时退回自建
 * （兼容 do/ask 直调）。共享桥由 cmdRun 收尾关闭，runOne 不得关（ownedBridge 为 null）。
 * @param {object|null} sharedBridge cmdRun 级共享桥
 * @param {object} flags CLI flags（读 quiet 控制日志）
 * @returns {Promise<{bridge: object|null, ownedBridge: object|null}>} bridge 挂到 ctx.mcp；
 *          ownedBridge 仅自建时非空，供 runHandle 登记与 finally 关闭
 */
async function resolveRunMcpBridge(sharedBridge, flags) {
  if (sharedBridge) return { bridge: sharedBridge, ownedBridge: null };
  const { loadMcpConfig } = await import('../src/mcp/config.js');
  const { createMcpBridge } = await import('../src/mcp/bridge.js');
  const mcpConfig = loadMcpConfig(path.join(PROJECT_ROOT, 'mcp.json'));
  if (!mcpConfig.missing && Object.keys(mcpConfig.servers).length) {
    const bridge = await createMcpBridge({ config: mcpConfig, logger: (message) => !flags.quiet && console.warn(message) });
    return { bridge, ownedBridge: bridge };
  }
  return { bridge: null, ownedBridge: null };
}

/**
 * 目标包名解析（单一真源）：YAML targetPackage > ASK_APP_PACKAGE > launch 步 appId > 正则兜底。
 * pregrant / initializeApp / collectAppVersion 三处统一复用，避免逻辑漂移。
 * @param {object} caseObj 用例对象
 * @returns {string|null} 包名或 null
 */
function resolveTargetPackage(caseObj) {
  if (caseObj.targetPackage) return String(caseObj.targetPackage);
  if (process.env.ASK_APP_PACKAGE) return process.env.ASK_APP_PACKAGE;
  const launchStep = (caseObj.steps || []).find((step) => step.type === 'launch' && (step.appId || step.text));
  if (launchStep) return String(launchStep.appId || launchStep.text).split('/')[0];
  const caseText = JSON.stringify(caseObj.steps || []);
  const inferred = (caseText.match(/com\.[a-zA-Z][\w]*(?:\.[\w]+)+/) || [])[0] || null;
  if (inferred) console.warn(`[warn] 未声明 targetPackage，从步骤文本提取到 "${inferred}"（可能误中；建议用例顶层声明 targetPackage 或设置 ASK_APP_PACKAGE）`);
  return inferred;
}

/**
 * preflight 预授权（§2.7.2 一层）：**默认关闭**，`--pregrant` 显式开启。
 * `pm grant` 会杀掉**正在运行**的 App，部分 App（如掘金）批量授权后启动即崩溃
 * （logcat: Application Error ... / Process has died）。故默认不启用；确需消灭授权框时
 * 用 --pregrant（并先停止 App）。任何失败均不阻断用例执行。
 * 目标包名解析：顶层 targetPackage > launch 步 appId > 正则兜底（断言/URL 里任何
 * com.* 都可能抢先误中；兜底命中时显式 warn 提示声明）。
 * @param {object} caseObj 用例对象
 * @param {object} device 已连接的设备
 * @param {object} flags CLI flags（读 pregrant）
 */
async function applyPregrant(caseObj, device, flags) {
  if (flags.pregrant !== true) return;
  try {
    const packageName = resolveTargetPackage(caseObj);
    if (packageName) {
      const { pregrantPackage } = await import('../src/cli/pregrant.js');
      // terminate 内含 assertSafePackage：非法包名抛错时不再吞掉后继续 grant，
      // 显式告警并跳过整段预授权（否则会对着一个未停止/非法的包执行 pm grant）。
      let terminated = true;
      try { await device.terminate(packageName); }
      catch (error) { console.warn(`[pregrant] 终止 ${packageName} 失败（${error.message}），跳过预授权`); terminated = false; }
      if (terminated) {
        const pregrantResult = await pregrantPackage(device, packageName);
        if (pregrantResult.granted.length) console.warn(`[preflight] 预授权 ${pregrantResult.granted.length} 项（已先停止 App）：${pregrantResult.granted.join(', ')}`);
        else if (pregrantResult.failed.length) console.warn(`[preflight] 预授权 ${pregrantResult.failed.length} 项失败（不阻断）`);
      }
    }
  } catch { /* 预授权失败不阻断 */ }
}

/**
 * plan-cache 跨设备/跨版本失效键：采一次目标 App 的 versionName。
 * 目标包来源与 pregrant 一致（顶层 targetPackage > launch 步 appId）；无目标包时
 * 不查设备、appVersion=null（planKey 缺省 'unknown'）。采集失败一律降级为 null。
 * @param {object} caseObj 用例对象
 * @param {object} device 已连接的设备
 * @returns {Promise<string|null>} 目标 App 版本号
 */
async function collectAppVersion(caseObj, device) {
  const targetPackage = resolveTargetPackage(caseObj);
  return targetPackage
    ? await device.packageVersion(targetPackage).catch(() => null)
    : null;
}

/**
 * 会话保留策略（§9.1）：secret 类静态预扫 + 运行期兜底删除。
 * 步骤文本含 secret_get/sms_read 时强制 fresh（forcedBySecret 时打印原因）。
 * @param {object} caseObj 用例对象
 * @param {object} flags CLI flags（fresh/continue/session/keep）
 * @returns {Promise<{persist: object, sessionManager: object}>} persist 供运行期兜底判断
 */
async function assembleSessionPersistence(caseObj, flags) {
  const { resolveStrategy, createSessionManager } = await import('../src/session/persist.js');
  const secretMentioned = /secret_get|sms_read/.test(JSON.stringify(caseObj.steps || []));
  const persist = resolveStrategy({ fresh: !!flags.fresh, cont: !!flags.continue, session: flags.session, keep: flags.keep === undefined ? true : !!flags.keep, hasSecretCalls: secretMentioned });
  if (persist.forcedBySecret) console.warn(persist.reason);
  const sessionManager = await createSessionManager({ strategy: persist.strategy, sessionFile: flags.session, cwd: PROJECT_ROOT });
  return { persist, sessionManager };
}

/**
 * 装配模型 + 小模型客户端（ai 提取 / VLM 兜底共用），并把 chat/vlm/modelCfg 注入 ctx。
 * --vlm-locate：把 chat 客户端包装成视觉定位函数注入 locate 策略链第 5 环（§5.1）。
 * 视觉定位默认启用：引擎定位 MISS 时做确定性视觉接地（截图→坐标→tap），不耗 agent 轮。
 * @param {object} ctx 运行上下文
 * @param {object} modelConfig 已通过完整性校验的模型配置
 * @returns {Promise<{model: object|null, modelRuntime: object|null}>}
 */
async function assembleModelClient(ctx, modelConfig) {
  const { createModel } = await import('../src/session/model.js');
  const { createChatClient } = await import('../src/tools/ai.js');
  if (!modelConfig.url || !modelConfig.key) return { model: null, modelRuntime: null };
  const built = await createModel(modelConfig);
  ctx.chat = createChatClient({ url: modelConfig.url, key: modelConfig.key, model: modelConfig.name });
  ctx.modelCfg = modelConfig; // 视觉作答（tap_each_row 缺省形态）需要坐标族
  ctx.vlm = await buildVlmLocate(ctx, modelConfig);
  return { model: built.model, modelRuntime: built.modelRuntime };
}

/**
 * 设备事实采集（L2 占位符填充）+ 启动自检（§2.6.2 ⑤）。
 * 采集失败降级为 null（不传 facts）。上次 run 可能没还原干净：仅当设备支持 net 时才检查，
 * 避免噪音；复用 facts 已采的 netProfile（避免重复查一次 netStatus）。
 * @param {object} device 已连接的设备
 * @param {string} serial 设备序列号
 * @returns {Promise<object|null>} 设备事实；采集失败为 null
 */
async function collectFactsAndSelfCheck(device, serial) {
  let deviceFacts = null;
  try { deviceFacts = await collectDeviceFacts(device, { serial }); } catch { /* 降级 */ }
  if (deviceFacts && deviceFacts.netSupported === true) {
    try {
      const netProfile = deviceFacts.netProfile ?? null;
      if (netProfile && netProfile !== 'off' && netProfile !== 'unknown') {
        console.warn(`[warn] 设备网络档位为 ${netProfile}（上次 run 未还原？），已自动恢复为 off`);
        await device.netSetProfile('off');
      }
    } catch { /* 自检失败不阻断 */ }
  }
  return deviceFacts;
}

/**
 * 装配三层提示词（§6）+ agent 会话 + 工具表 + 上下文治理后端 + 动作计划缓存。
 * 工具实例只建一次（性能+一致性）：建两套会让 screen_diff 的基线 hash 等闭包状态分裂成两份。
 * 同一数组同时给 agent 与引擎直执行；buildTools 只含契约工具（25 个），引擎专用工具
 * （point_tap）不进模型面——模型仍被禁止给像素坐标（DESIGN.md:978 禁裸坐标约束）。
 * @param {object} params 装配所需上下文
 * @param {object} params.ctx 运行上下文
 * @param {object} params.flags CLI flags（prompt/prompt-file/prompt-mode）
 * @param {object|null} params.deviceFacts 设备事实（L2 占位符）
 * @param {object} params.sessionManager 会话持久化管理器
 * @param {object|null} params.model 模型实例
 * @param {object|null} params.modelRuntime 模型运行时
 * @returns {Promise<{session: object, toolMap: Map<string, object>, governor: object, planCache: object}>}
 */
async function assembleAgentSession({ ctx, flags, deviceFacts, sessionManager, model, modelRuntime }) {
  const { assemblePrompt } = await import('../src/session/prompt.js');
  const { createAskSession } = await import('../src/session/create.js');
  const { buildTools, buildEngineTools } = await import('../src/tools/index.js');

  const prompt = assemblePrompt({
    mode: flags['prompt-mode'] || 'append',
    prompt: flags.prompt || '',
    promptFile: flags['prompt-file'] || '',
    projectRoot: PROJECT_ROOT,
    facts: deviceFacts,
  });
  for (const warning of prompt.warnings) console.warn(`[warn] ${warning}`);

  const runTools = buildTools(ctx);
  const session = await createAskSession(ctx, {
    systemPrompt: prompt.systemPrompt,
    sessionManager,
    model,
    modelRuntime,
    tools: runTools,
  });
  // 上下文治理执行后端（评审 C-A1）：四道治理经 appendContextEdit 对实际请求生效，
  // 持久化历史保留原文（append-only）。旧原地改写 state.messages 的版本被 SDK
  // 请求前投影重建覆盖，治理从未到达模型——governor 是唯一执行路径。
  const governor = createContextGovernor({ sessionManager });

  // 引擎直执行步骤用：工具名 → 工具。契约工具与引擎专用工具（point_tap）合并，
  // 使 buildToolCall 产出的坐标调用也能命中有记账包装的实例。
  const toolMap = new Map([...runTools, ...buildEngineTools(ctx)].map((tool) => [tool.name, tool]));

  // —— 动作计划缓存（Midscene caching 同款）——
  // 只建缓存实例；工具调用记账包装与 planKey 构造已下沉到 runCaseLoop（toolMap 与
  // session 共享实例，run-loop 内就地包装 execute 即可记录模型路径的调用序列）。
  const planCache = createPlanCache(WORKSPACE.stateDir);
  return { session, toolMap, governor, planCache };
}

/**
 * 运行收尾：secret 兜底删会话文件 → recorder 终态落盘 → 人类可读/JSON 输出 → 映射退出码。
 * 网络还原不在此处（已移至 runOne 的 finally，保证异常/中断路径也执行，§2.6.2 ①）。
 * @param {object} params 收尾所需上下文
 * @returns {number} 退出码（pass 0 / fail 1 / 其他 2）
 */
async function finalizeRun({ ctx, session, recorder, persist, status, caseObj, flags }) {
  // 运行期兜底：secret 类调用发生过 → 会话文件不得留盘（§9.1 例外）
  if (ctx.secretCalls.length > 0 && persist.strategy !== 'fresh' && session.sessionFile) {
    try { fs.rmSync(session.sessionFile, { force: true }); console.warn('检测到 secret_get/sms_read 调用，已删除会话文件（凭据不落盘）'); } catch { /* ignore */ }
  }
  recorder.setEngineLog(ctx.engineLog); // 引擎步记录落 run.json（失败排查依据）
  await recorder.finish(status === 'pass' ? 'pass' : status, { exitCode: status === 'pass' ? EXIT_PASS : status === 'fail' ? EXIT_CASE_FAIL : EXIT_ENV_ERROR });
  session.dispose?.();
  if (!flags.quiet) {
    const htmlPath = recorder.htmlPath;
    console.log(
      `run ${caseObj.name} → ${status}（报告: ${htmlPath ?? recorder.jsonPath}${htmlPath ? '；数据: ' + recorder.jsonPath : ''}）`,
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
  return status === 'pass' ? EXIT_PASS : status === 'fail' ? EXIT_CASE_FAIL : EXIT_ENV_ERROR;
}

/**
 * runOne 的 finally 清理：网络还原（§2.6.2 ① + ③，无条件执行，失败要 warn + 记 rollback，
 * 不静默）→ 坐标缓存攒批 flush（run 中途抛错也要排空，否则去抖 timer 被 process.exit 掐掉，
 * pending 缓存行丢失）→ 关本 run 自建桥（共享桥由 cmdRun 收尾统一关闭）→ 关设备 → 注销在册记录。
 * @param {object} params 清理所需上下文（ctx/runHandle 可能为 null：装配早期失败）
 */
async function cleanupRun({ device, ctx, runHandle }) {
  try {
    const { restoreNetwork } = await import('../src/state-mutations.js');
    const restoreResult = await restoreNetwork(device, ctx ?? { stateMutations: [] });
    if (restoreResult && restoreResult.ok === false) {
      console.error(`[warn] 网络还原失败：设备可能仍处于异常档位，需人工恢复（${restoreResult.error}）`);
      try { ctx?.recorder?.addRollback?.({ stepIndex: null, reason: '网络还原失败', recovered: false }); } catch { /* ignore */ }
    }
  } catch (error) {
    console.error(`[warn] 网络还原异常：${error?.message ?? error}`);
  }
  try { await ctx?.locateWithCache?.flush?.(); } catch { /* 缓存 flush 失败不阻断收尾 */ }
  // 只关本 run 自建的桥；cmdRun 级共享桥由其收尾统一关闭（runHandle.bridge 为 null）
  try { if (runHandle?.bridge) await runHandle.bridge.close?.(); } catch { /* ignore */ }
  try { await device.close(); } catch { /* ignore */ }
  if (runHandle) activeRuns.delete(runHandle);
}

// 单条用例执行：锁 → createDevice → RunRecorder → createAskSession → 逐步 prompt → finish
/**
 * 单条用例执行的装配编排：设备/记录器/上下文/MCP/预授权/会话策略/模型/提示词逐项装配后，
 * 把循环编排交给 runCaseLoop（Task 8 下沉）；本函数只保留收尾（finalizeRun）与
 * finally 的设备还原（cleanupRun）。status 由 runCaseLoop 判定（断言失败 > 引擎失败 > timeout/error）。
 * @param {object} caseObj 用例对象
 * @param {{flags: object, serial: string, bridge?: object|null}} params 执行参数
 * @returns {Promise<number>} 退出码（0 通过 / 1 断言失败 / 2 环境错误）
 */
async function runOne(caseObj, { flags, serial, bridge: sharedBridge = null }) {
  const { openDataset } = await import('../src/store/dataset.js');
  const { createRunContext } = await import('../src/session/create.js');
  const { resolveModelConfig } = await import('../src/session/model.js');

  const { opts, runDeadline } = buildRunOptions(flags);

  const device = await assembleDevice(caseObj, serial);
  if (!device) return EXIT_ENV_ERROR;

  let ctx = null;        // 提到 try 外：finally 的网络还原用本 run 自己的 ctx（不用共享指针）
  let runHandle = null;  // 在 activeRuns 中占位的本 run 记录
  try {
    const modelConfig = resolveModelConfig(flags);
    // 配置缺失早失败：若继续跑完整条用例只打一条 warn，会浪费真机时间且
    // agent 轮全程无模型可用。缺 url/key/name 任一即退出码 2（环境/配置错误）。
    if (!modelConfig.url || !modelConfig.key || !modelConfig.name) {
      console.error('模型配置缺失：需 ASK_MODEL_URL / ASK_MODEL_KEY / ASK_MODEL_NAME（或用 --model-* 覆盖）；可复制 .env.example 为 .env 后由 CLI 自动加载');
      return EXIT_ENV_ERROR;
    }
    const store = openDataset({ dataDir: WORKSPACE.datasetDir });
    const recorder = await assembleRecorder(caseObj, device, modelConfig);
    ctx = createRunContext({ device, recorder, store, opts }); ctx.stateDir = WORKSPACE.stateDir;
    ctx.runStartMs = Date.now();
    runHandle = { ctx, device, bridge: null, serial };  // 信号处理用（§2.6.2 ④）；Set 支持并行多 run
    activeRuns.add(runHandle);
    if (!opts.yes && process.stdin.isTTY) ctx.confirm = makeConfirm; // 交互确认钩子（§13.3）

    const { bridge, ownedBridge } = await resolveRunMcpBridge(sharedBridge, flags);
    if (bridge) ctx.mcp = bridge;
    runHandle.bridge = ownedBridge; // 共享桥时为 null：由 cmdRun 收尾关闭，runOne 不得关

    await applyPregrant(caseObj, device, flags);

    // APP 初始化：确保目标应用在首页干净状态（force-stop → 可选 pm clear → launch → 等待 → 清弹窗）
    const initPackageName = resolveTargetPackage(caseObj);
    if (initPackageName) {
      const { initializeApp } = await import('../src/device/app-init.js');
      const appInitConfig = caseObj.appInit || {};
      const shouldClearData = flags['clean-data'] === true || appInitConfig.clearData === true;
      const initResult = await initializeApp(device, {
        packageName: initPackageName,
        clearData: shouldClearData,
        launchWaitMs: appInitConfig.launchWaitMs,
        dismissPopups: async () => {
          const { cleanLaunchPopups } = await import('../src/tools/action.js');
          await cleanLaunchPopups(ctx, device);
        },
      });
      if (!initResult.ok) {
        console.warn(`[app-init] 初始化失败: ${initResult.error}（继续执行用例）`);
      } else if (!flags.quiet) {
        console.log(`[app-init] ${initPackageName} 初始化完成 (${initResult.steps.join(' → ')})`);
      }
      // force-stop 会连带杀掉 uia2 server（instrumentation 注入在目标 App 进程），
      // 必须重置退避状态并重新探测，否则后续所有 dump/VLM 定位都因 a11y 树不可用而失败。
      await device.resetUia2();
    }

    ctx.appVersion = await collectAppVersion(caseObj, device);

    const { persist, sessionManager } = await assembleSessionPersistence(caseObj, flags);
    const { model, modelRuntime } = await assembleModelClient(ctx, modelConfig);
    const deviceFacts = await collectFactsAndSelfCheck(device, serial);
    const { session, toolMap, governor, planCache } = await assembleAgentSession({ ctx, flags, deviceFacts, sessionManager, model, modelRuntime });

    // —— 逐步执行编排（Task 8 下沉）——
    const { status } = await runCaseLoop({
      ctx, session, recorder, toolMap, planCache, gov: governor, flags, caseObj, runDeadline, modelCfg: modelConfig,
    });

    return await finalizeRun({ ctx, session, recorder, persist, status, caseObj, flags });
  } finally {
    await cleanupRun({ device, ctx, runHandle });
  }
}

// ask "<question>" — 只读问答：只放行感知/等待/数据查询类工具
/** ask 只读工具白名单：感知/等待/数据查询类，绝不点击或输入 */
const ASK_READ_ONLY_TOOLS = new Set(['screen', 'uitree', 'locate', 'screen_diff', 'read', 'wait_idle', 'wait_element', 'net_status', 'ui_dump', 'data_query']);

/**
 * 装配 ask 的模型与视觉兜底：缺配置直接 fail（ask 必须有模型才能回答）。
 * --vlm-locate 时同样接视觉兜底（只读白名单含 locate，与 run 一致）。
 * @param {object} ctx 运行上下文
 * @param {object} flags CLI flags
 * @returns {Promise<{model: object, modelRuntime: object}>}
 */
async function assembleAskModel(ctx, flags) {
  const { resolveModelConfig, createModel } = await import('../src/session/model.js');
  const modelConfig = resolveModelConfig(flags);
  if (!modelConfig.url || !modelConfig.key) {
    fail('ask 命令需要模型（ASK_MODEL_*），用于回答问题');
  }
  const built = await createModel(modelConfig);
  if (ctx.opts.vlmLocate) {
    const { createChatClient } = await import('../src/tools/ai.js');
    ctx.chat = createChatClient({ url: modelConfig.url, key: modelConfig.key, model: modelConfig.name });
    ctx.vlm = await buildVlmLocate(ctx, modelConfig);
  }
  return { model: built.model, modelRuntime: built.modelRuntime };
}

/**
 * 装配 ask 的只读会话：replace 模式提示词（跳过 L1 引擎层、保留 L2 安卓层，并把只读约束
 * 作为 L3 用户层注入；之前用 none 会把这段约束整个丢掉——评审发现 L3 在 none 模式下被跳过）
 * + 白名单过滤后的工具 + fresh 会话管理器 + 治理执行后端（评审 C-A1，与 runOne 同款）。
 * @param {object} params 装配所需上下文（ctx/device/serial/model/modelRuntime）
 * @returns {Promise<{session: object, governor: object}>}
 */
async function assembleAskSession({ ctx, device, serial, model, modelRuntime }) {
  const { assemblePrompt } = await import('../src/session/prompt.js');
  const { createAskSession } = await import('../src/session/create.js');
  const { createSessionManager } = await import('../src/session/persist.js');
  const { buildTools } = await import('../src/tools/index.js');

  // 设备事实采集（L2 占位符填充）：try/catch 包住，采集失败降级为不传
  let deviceFacts = null;
  try { deviceFacts = await collectDeviceFacts(device, { serial }); } catch { /* 降级 */ }
  const prompt = assemblePrompt({
    mode: 'replace',
    prompt: '你是只读问答助手。只允许观察（screen/uitree/read/data_query），绝不点击或输入。回答要基于工具返回的事实。',
    projectRoot: PROJECT_ROOT,
    facts: deviceFacts,
  });
  for (const warning of prompt.warnings) console.warn(`[warn] ${warning}`);
  // 只读工具白名单过滤
  const readOnlyTools = buildTools(ctx).filter((tool) => ASK_READ_ONLY_TOOLS.has(tool.name));
  const sessionManager = await createSessionManager({ strategy: 'fresh', cwd: PROJECT_ROOT });
  const session = await createAskSession(ctx, {
    systemPrompt: prompt.systemPrompt,
    sessionManager,
    model,
    modelRuntime,
    tools: readOnlyTools,
  });
  // 治理执行后端：催答轮折叠经 appendContextEdit 对请求生效
  const governor = createContextGovernor({ sessionManager });
  return { session, governor };
}

/**
 * 提问并取最终文本回答：模型以纯 toolCall 或空消息收尾时催答重试（上限 ASK_NUDGE_MAX_ROUNDS）。
 * 催答前折叠 role:tool 历史（网关 400 防护，与 runOne 同款）。
 * @param {object} session agent 会话
 * @param {object} governor 上下文治理后端
 * @param {string} question 用户问题
 * @returns {Promise<string>} 最终回答文本（可能为空串）
 */
async function askWithNudge(session, governor, question) {
  await session.prompt(question);
  // 回显回答：复用 lastAssistantText（否则命令静默退出，用户看不到答案）
  let answer = lastAssistantText(session) ?? '';
  for (let nudgeRound = 0; nudgeRound < ASK_NUDGE_MAX_ROUNDS && !answer; nudgeRound++) {
    try { governor.foldToolHistory(); } catch { /* 折叠失败不阻断 */ }
    await session.prompt('不要再调用工具。直接用一段文本回答上面的问题。', { images: [] });
    answer = lastAssistantText(session) ?? '';
  }
  return answer;
}

/**
 * ask 子命令：只读问答。shared 读锁（与 run 的 exclusive 互斥，多个 ask 可并发读同设备）→
 * 设备/模型/只读会话装配 → 提问（含催答）→ 输出回答。空回答退出码 3（本机扩展）。
 * @param {{positional: string[], flags: object}} args 解析后的 CLI 参数
 * @returns {Promise<number>} 退出码（有回答 0 / 空回答 3）
 */
async function cmdAsk({ positional, flags }) {
  const question = positional.join(' ');
  if (!question) fail('ask 需要一个问题文本');
  const { createDevice } = await import('../src/device/index.js');
  const { openDataset } = await import('../src/store/dataset.js');
  const { createRunContext } = await import('../src/session/create.js');

  const serialList = await resolveSerials(flags);
  if (!serialList.length) fail('未找到在线设备（adb devices），请用 --device <serial> 指定');
  const serial = serialList[0];
  // ask 是只读问答：用 shared 读锁，与 run 的 exclusive 锁互斥，但多个 ask 可并发读同设备
  const lock = acquireLock(WORKSPACE.lockRoot, serial, { mode: 'shared' });
  if (!lock.ok) fail(lock.reason);
  heldSharedLock = { root: WORKSPACE.lockRoot, serial };
  let device;
  let ctx = null; // 提升到 try 外：finally 的坐标缓存 flush 需要可见
  try { device = await createDevice({ serial, probeFile: WORKSPACE.probeFile }); } catch (error) { fail(`设备连接失败（${serial}）：${error.message}`); }
  try {
    const store = openDataset({ dataDir: WORKSPACE.datasetDir });
    ctx = createRunContext({ device, recorder: null, store, opts: { yes: true, timeoutMs: Number(flags.timeout || ASK_DEFAULT_TIMEOUT_SECONDS) * 1000, vlmLocate: !!flags['vlm-locate'] } }); ctx.stateDir = WORKSPACE.stateDir;
    const { model, modelRuntime } = await assembleAskModel(ctx, flags);
    const { session, governor } = await assembleAskSession({ ctx, device, serial, model, modelRuntime });
    const answer = await askWithNudge(session, governor, question);
    const messageCount = (session?.agent?.state?.messages ?? session?.messages ?? []).length;
    session.dispose?.();
    if (flags.json) out(flags, { answer, messageCount });
    else console.log(answer || '(无回答)');
    return answer ? EXIT_PASS : EXIT_EMPTY_ANSWER;
  } finally {
    try { await ctx?.locateWithCache?.flush?.(); } catch { /* ignore */ }
    try { await device?.close?.(); } catch { /* ignore */ }
    releaseLock(WORKSPACE.lockRoot, serial, { mode: 'shared' });
    heldSharedLock = null; // 正常路径已释放，避免后续 fail() 再重复释放
  }
}

// data — 数据集子命令
/**
 * data list：扫描工作区 dataset 目录的 .jsonl 文件，统计各数据集行数。
 * @param {object} flags CLI flags
 * @returns {number} 退出码（恒 0）
 */
function listDatasets(flags) {
  const datasetDir = WORKSPACE.datasetDir;
  const datasetFiles = fs.existsSync(datasetDir) ? fs.readdirSync(datasetDir).filter((fileName) => fileName.endsWith('.jsonl')) : [];
  const datasetRows = datasetFiles.map((fileName) => {
    const lineCount = fs.readFileSync(path.join(datasetDir, fileName), 'utf8').split('\n').filter((line) => line.trim()).length;
    return { name: fileName.replace(/\.jsonl$/, ''), rows: lineCount };
  });
  out(flags, datasetRows, datasetRows.map((dataset) => `${dataset.name}  ${dataset.rows} rows`).join('\n') || '(无数据集)');
  return EXIT_PASS;
}

/**
 * 把数据行序列化为 CSV 文本：列取所有行键的并集（保持首次出现顺序），单元格 JSON 转义。
 * @param {object[]} rows 数据行
 * @returns {string} CSV 文本（首行为表头）
 */
function rowsToCsv(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [columns.join(','), ...rows.map((row) => columns.map((column) => JSON.stringify(row[column] ?? '')).join(','))].join('\n');
}

/**
 * data export：导出数据集为 json/csv。默认导出到工作区 dataset 目录，不污染项目根/cwd。
 * @param {object} store 数据集存储
 * @param {string} datasetName 数据集名
 * @param {object} flags CLI flags（format/out/quiet）
 * @returns {Promise<number>} 退出码（恒 0）
 */
async function exportDataset(store, datasetName, flags) {
  const rows = await store.read(datasetName);
  const format = flags.format || 'csv';
  const destPath = flags.out || path.join(WORKSPACE.datasetDir, `${datasetName}.${format === 'json' ? 'json' : 'csv'}`);
  if (format === 'json') {
    fs.writeFileSync(destPath, JSON.stringify(rows, null, 2));
  } else {
    fs.writeFileSync(destPath, rowsToCsv(rows));
  }
  if (!flags.quiet) console.log(`exported ${datasetName} → ${destPath}`);
  return EXIT_PASS;
}

/**
 * data 子命令分发：list/show/query/export/diff/clear。除 list 外均需数据集名。
 * @param {{positional: string[], flags: object}} args 解析后的 CLI 参数
 * @returns {Promise<number>} 退出码（恒 0；参数错误 fail 退出 2）
 */
async function cmdData({ positional, flags }) {
  const subCommand = positional[0] || 'list';
  const { openDataset } = await import('../src/store/dataset.js');
  const store = openDataset({ dataDir: WORKSPACE.datasetDir });
  const datasetName = positional[1];

  if (subCommand === 'list') {
    return listDatasets(flags);
  }
  if (!datasetName) fail(`data ${subCommand} 需要数据集名`);
  if (subCommand === 'show') {
    const rows = (await store.read(datasetName)).slice(0, Number(flags.limit || DATA_SHOW_DEFAULT_LIMIT));
    out(flags, rows, JSON.stringify(rows, null, 2));
    return EXIT_PASS;
  }
  if (subCommand === 'query') {
    const rows = await store.query(datasetName, {
      where: flags.where, select: flags.select ? String(flags.select).split(',') : undefined,
      limit: flags.limit ? Number(flags.limit) : undefined, orderBy: flags['order-by'] || flags.orderBy,
    });
    out(flags, rows, JSON.stringify(rows, null, 2));
    return EXIT_PASS;
  }
  if (subCommand === 'export') {
    return exportDataset(store, datasetName, flags);
  }
  if (subCommand === 'clear') {
    await store.clear(datasetName);
    if (!flags.quiet) console.log(`cleared ${datasetName}`);
    return EXIT_PASS;
  }
  if (subCommand === 'diff') {
    const rows = await store.read(datasetName);
    // 按 _run 分组取最近两个 distinct run：cur=最近 run，prev=次近 run（"与上一次 run 对比"）。
    const summary = { dataset: datasetName, ...diffByRun(rows) };
    out(flags, summary, JSON.stringify(summary, null, 2));
    return EXIT_PASS;
  }
  fail(`未知 data 子命令：${subCommand}`);
}

// lint — 静态校验（§13.4）
/**
 * lint 子命令：逐文件静态校验，--strict 把 warn 当 error。有 error 退出码 1。
 * @param {{positional: string[], flags: object}} args 解析后的 CLI 参数
 * @returns {Promise<number>} 退出码（无 error 0 / 有 error 1）
 */
async function cmdLint({ positional, flags }) {
  const caseFiles = positional.filter((argument) => !argument.startsWith('-'));
  if (!caseFiles.length) fail('lint 需要至少一个用例文件');
  const { lintCaseText } = await import('../src/lint/rules.js');
  const findings = [];
  for (const caseFile of caseFiles) {
    let caseText;
    try { caseText = fs.readFileSync(path.resolve(caseFile), 'utf8'); } catch { fail(`用例文件不可读：${caseFile}`); }
    for (const finding of lintCaseText(caseText)) findings.push({ file: caseFile, ...finding });
  }
  const strict = !!flags.strict;
  const errors = findings.filter((finding) => finding.level === 'error' || (strict && finding.level === 'warn'));
  if (!flags.quiet) {
    for (const finding of findings) console.log(`${finding.file}:${finding.line}  [${finding.level}] ${finding.rule}: ${finding.message}`);
    console.log(`\n${findings.length} finding(s), ${errors.length} error(s)${strict ? '（strict：warn 计入 error）' : ''}`);
  }
  out(flags, { findings, errors: errors.length });
  return errors.length ? EXIT_CASE_FAIL : EXIT_PASS;
}

// doctor — 环境自检
/**
 * 在设备上找"返回箭头"类已知位置元素的 bounds：优先 locate('返回')，
 * 否则从 UI 树找 contentDesc 含"返回"的节点 bounds。找不到返回 null。
 * @param {object} device 已连接的设备
 * @returns {Promise<object|null>} 元素 bounds
 */
async function findKnownBackBounds(device) {
  const { flattenNodes } = await import('../src/device/uitree.js');
  const locateHit = await device.locate('返回', { vlm: null }).catch(() => null);
  let bounds = locateHit?.bounds ?? null;
  if (!bounds) {
    const uiTree = await device.dumpTree({ fresh: true }).catch(() => null);
    const backNode = uiTree?.nodes?.length
      ? flattenNodes(uiTree.nodes).find((node) => /返回/.test(node.contentDesc || '') && node.bounds)
      : null;
    bounds = backNode?.bounds ?? null;
  }
  return bounds;
}

/**
 * doctor --probe-family：用一次 VLM 调用探测模型坐标 family，结果落 probe 缓存供坐标策略复用。
 * 需要屏幕上有"返回箭头"类已知位置元素，且已配置 ASK_MODEL_*。
 * @param {object} flags CLI flags
 * @returns {Promise<object>} 检查结果条目 { item: 'probe-family', ok, ... }
 */
async function checkProbeFamily(flags) {
  const { resolveModelConfig } = await import('../src/session/model.js');
  const modelConfig = resolveModelConfig(flags);
  if (!modelConfig.url || !modelConfig.key || !modelConfig.name) {
    return { item: 'probe-family', ok: false, error: '未配置 ASK_MODEL_*，无法探测 family' };
  }
  let device = null;
  try {
    const { createDevice } = await import('../src/device/index.js');
    const { createChatClient } = await import('../src/tools/ai.js');
    const { probeFamily } = await import('../src/device/coord/probe.js');
    const serials = await resolveSerials(flags);
    const serial = serials[0];
    device = await createDevice(serial ? { serial, probeFile: WORKSPACE.probeFile } : { probeFile: WORKSPACE.probeFile });
    const screenSize = await device.screenSize();
    const screenshot = await device.screencap();
    const bounds = await findKnownBackBounds(device);
    if (!bounds) {
      return { item: 'probe-family', ok: false, error: '未找到已知位置元素（返回箭头），请把屏幕停在含"返回"按钮的页面后重试' };
    }
    const knownElement = { target: '返回箭头', bounds };
    // 复用 runOne/cmdAsk 的视觉定位工厂：chat 客户端 + 截图压缩 + 策略提示词
    const chatCtx = { chat: createChatClient({ url: modelConfig.url, key: modelConfig.key, model: modelConfig.name }) };
    const vlmLocate = await buildVlmLocate(chatCtx, modelConfig);
    const probeResult = await probeFamily({ vlm: vlmLocate, png: screenshot.buffer, size: screenSize, known: knownElement, file: WORKSPACE.probeFile });
    if (probeResult.family) return { item: 'probe-family', ok: true, family: probeResult.family, note: `已写入 ${WORKSPACE.probeFile}` };
    return { item: 'probe-family', ok: false, raw: probeResult.raw, error: '探测失败：无唯一命中策略' };
  } catch (error) {
    return { item: 'probe-family', ok: false, error: `探测异常：${error.message}` };
  } finally {
    try { await device?.close?.(); } catch { /* ignore */ }
  }
}

/**
 * doctor --cache-report：读 run 报告统计 locate 缓存命中率与累计 dump 耗时。
 * @param {object} flags CLI flags（读 cache-report 路径）
 * @returns {number} 退出码（恒 0；报告不存在时 fail 退出 2）
 */
function reportCacheStats(flags) {
  const reportPath = path.resolve(flags['cache-report']);
  if (!fs.existsSync(reportPath)) fail(`找不到 run 报告：${reportPath}`);
  const runReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const locateSteps = (runReport.steps || []).filter((step) => step.locate);
  const cacheHits = locateSteps.filter((step) => step.locate.treeCacheHit || step.locate.vlmCacheHit).length;
  const totalDumpMs = locateSteps.reduce((sum, step) => sum + (step.locate.dumpMs || 0), 0);
  const summary = {
    locateCalls: locateSteps.length, cacheHits,
    hitRate: locateSteps.length ? +(cacheHits / locateSteps.length).toFixed(CACHE_HIT_RATE_DECIMALS) : null,
    totalDumpMs,
  };
  out(flags, summary, `缓存命中: ${summary.cacheHits}/${summary.locateCalls} (${summary.hitRate})，累计 dump ${summary.totalDumpMs}ms`);
  return EXIT_PASS;
}

/**
 * doctor 设备检查项：连接设备并读屏幕尺寸；--device 为布尔（未给值）时自动选设备。
 * @param {object} flags CLI flags（读 device）
 * @returns {Promise<object>} 检查结果条目 { item: 'device', ok, serial?, size?, error? }
 */
async function checkDevice(flags) {
  const { createDevice } = await import('../src/device/index.js');
  try {
    const serial = flags.device === true ? undefined : flags.device;
    const device = await createDevice(serial ? { serial } : {});
    const screenSize = await device.screenSize().catch((error) => ({ error: error.message }));
    const entry = { item: 'device', ok: !screenSize.error, serial: serial || '(auto)', size: screenSize };
    await device.close();
    return entry;
  } catch (error) {
    return { item: 'device', ok: false, error: error.message };
  }
}

/**
 * doctor 模型检查项：发一次真实请求探活——只校验配置非空无法判断网关是否可达。
 * @param {object} flags CLI flags（--model-* 覆盖）
 * @returns {Promise<object>} 检查结果条目 { item: 'model', ok, url?, name?, note?, error? }
 */
async function checkModel(flags) {
  const { resolveModelConfig } = await import('../src/session/model.js');
  const modelConfig = resolveModelConfig(flags);
  if (!modelConfig.url || !modelConfig.key || !modelConfig.name) {
    return { item: 'model', ok: false, note: '未配置 ASK_MODEL_*' };
  }
  try {
    const { createChatClient } = await import('../src/tools/ai.js');
    const chat = createChatClient({ url: modelConfig.url, key: modelConfig.key, model: modelConfig.name, timeoutMs: MODEL_PING_TIMEOUT_MS });
    await chat('ping', { maxRetries: 0 });
    return { item: 'model', ok: true, url: modelConfig.url, name: modelConfig.name, note: '探活通过' };
  } catch (error) {
    return { item: 'model', ok: false, url: modelConfig.url, name: modelConfig.name, error: `探活失败：${error.message}` };
  }
}

/**
 * doctor 子命令分发：--probe-family / --cache-report 各自独立出口；
 * 否则按 flags 组合执行设备/模型检查项，全部 ok 才返回 0。
 * @param {{flags: object}} args 解析后的 CLI 参数
 * @returns {Promise<number>} 退出码（全通过 0 / 任一失败 2）
 */
async function cmdDoctor({ flags }) {
  if (flags['probe-family']) {
    const checks = [await checkProbeFamily(flags)];
    const allOk = checks.every((check) => check.ok);
    const humanText = checks.map((check) => `${check.ok ? 'OK  ' : 'FAIL'} ${check.item}${check.error ? ' — ' + check.error : (check.family ? ` — ${check.family}${check.note ? '（' + check.note + '）' : ''}` : '')}`).join('\n');
    out(flags, { ok: allOk, checks }, humanText);
    return allOk ? EXIT_PASS : EXIT_ENV_ERROR;
  }
  if (flags['cache-report']) {
    return reportCacheStats(flags);
  }
  const checks = [];
  if (flags.device || !flags.model) {
    checks.push(await checkDevice(flags));
  }
  if (flags.model || (!flags.device && !flags['cache-report'])) {
    checks.push(await checkModel(flags));
  }
  const allOk = checks.every((check) => check.ok);
  out(flags, { ok: allOk, checks }, checks.map((check) => `${check.ok ? 'OK  ' : 'FAIL'} ${check.item}${check.error ? ' — ' + check.error : ''}`).join('\n'));
  return allOk ? EXIT_PASS : EXIT_ENV_ERROR;
}

// mcp — MCP 管理子命令
/**
 * mcp call：解析工具参数（--args 优先，其次第三个位置参数的 JSON）并调用桥上的工具。
 * @param {object} bridge MCP 桥
 * @param {string[]} positional 位置参数（[call, toolName, jsonArgs?]）
 * @param {object} flags CLI flags（读 args）
 * @returns {Promise<number>} 退出码（成功 0；参数/调用错误 fail 退出 2）
 */
async function callMcpTool(bridge, positional, flags) {
  const toolName = positional[1];
  if (!toolName) fail('mcp call 需要 tool 名');
  let toolArgs = {};
  // 参数来源：--args 优先，其次接受第三个位置参数的 JSON（ask mcp call tool '{"k":v}'）
  const rawArgs = flags.args !== undefined ? flags.args : positional[2];
  if (rawArgs !== undefined) { try { toolArgs = JSON.parse(rawArgs); } catch { fail('--args 不是合法 JSON'); } }
  try {
    const { text } = await bridge.callByName(toolName, toolArgs);
    out(flags, { tool: toolName, result: text }, text);
    return EXIT_PASS;
  } catch (error) {
    fail(`MCP 调用失败：${error.message}`);
  }
}

/**
 * mcp 子命令分发：list/check/call。无 server 配置时输出提示并返回 0；
 * 桥在 finally 统一关闭。
 * @param {{positional: string[], flags: object}} args 解析后的 CLI 参数
 * @returns {Promise<number>} 退出码（check 有失败 server 时 2，其余成功路径 0）
 */
async function cmdMcp({ positional, flags }) {
  const subCommand = positional[0] || 'list';
  const { loadMcpConfig } = await import('../src/mcp/config.js');
  const { createMcpBridge } = await import('../src/mcp/bridge.js');
  const mcpConfig = loadMcpConfig(path.join(PROJECT_ROOT, 'mcp.json'));
  if (mcpConfig.missing || !Object.keys(mcpConfig.servers).length) {
    out(flags, { servers: [], note: 'mcp.json 无 server 配置' }, 'mcp.json 无 server 配置');
    return EXIT_PASS;
  }
  const bridge = await createMcpBridge({ config: mcpConfig, logger: (message) => console.warn(message) });
  try {
    if (subCommand === 'list') {
      const serverRows = bridge.servers.map((server) => ({ server: server.name, status: server.status, tools: bridge.tools.filter((tool) => tool.server === server.name).map((tool) => tool.finalName) }));
      out(flags, serverRows, serverRows.map((row) => `${row.server} [${row.status}] ${row.tools.join(', ') || '(无放行工具)'}`).join('\n'));
      return EXIT_PASS;
    }
    if (subCommand === 'check') {
      const serverRows = bridge.servers.map((server) => ({ server: server.name, status: server.status, error: server.error }));
      out(flags, serverRows, serverRows.map((row) => `${row.status === 'ok' ? 'OK  ' : 'FAIL'} ${row.server}${row.error ? ' — ' + row.error : ''}`).join('\n'));
      return serverRows.every((row) => row.status === 'ok') ? EXIT_PASS : EXIT_ENV_ERROR;
    }
    if (subCommand === 'call') {
      return await callMcpTool(bridge, positional, flags);
    }
    fail(`未知 mcp 子命令：${subCommand}`);
  } finally {
    await bridge.close();
  }
}

/**
 * CLI 入口：解析 argv → help/version 短路 → 确保工作区目录 → 分发子命令。
 * do 是 run 的单文本形态（合成一条任务文本用例）。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const { cmd: command, positional, flags } = parseArgv(process.argv.slice(2));
  if (flags.version) { console.log('ask 0.1.0'); return EXIT_PASS; }
  if (command === 'help' || flags.help) { console.log(usage); return EXIT_PASS; }
  // 需要落盘的子命令先确保工作区目录存在（lint 只读，跳过）
  if (command !== 'lint') {
    try { ensureWorkspace(WORKSPACE); } catch (error) { console.warn(`[warn] 工作区目录创建失败：${error?.message ?? error}`); }
  }
  switch (command) {
    case 'run': return cmdRun({ positional, flags });
    case 'do': return cmdRun({ positional: [positional.join(' ')], flags });
    case 'ask': return cmdAsk({ positional, flags });
    case 'data': return cmdData({ positional, flags });
    case 'lint': return cmdLint({ positional, flags });
    case 'doctor': return cmdDoctor({ flags });
    case 'mcp': return cmdMcp({ positional, flags });
    default:
      console.error(`未知命令：${command}\n`);
      console.log(usage);
      return EXIT_ENV_ERROR;
  }
}

main().then((exitCode) => process.exit(exitCode ?? EXIT_PASS)).catch(async (error) => {
  console.error(error?.stack || error?.message || error);
  // 未捕获异常路径必须释放设备锁：否则设备被锁住直到 stale 超时（10 分钟）。
  // 信号退出走 gracefulExit（已释放），纯异常路径也须释放，否则锁泄漏。
  try {
    for (const activeRun of activeRuns) {
      if (activeRun.serial) {
        try { releaseLock(WORKSPACE.lockRoot, activeRun.serial); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  process.exit(EXIT_ENV_ERROR);
});
