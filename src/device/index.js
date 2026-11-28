// 设备门面（契约 §1.1）：工具层只认 createDevice，不直接 import device 内部模块
import { writeFile } from 'node:fs/promises';
import { Adb } from './adb.js';
import * as screen from './screen.js';
import { truncateAtHierarchyEnd, parseXmlDump, flattenNodes, treeHash, isZeroAreaBounds, hasWebViewContainer } from './uitree.js';
import { TreeCache } from './cache.js';
import { createLocator, matchSelector, inScreen, matchNodeSelector as matchNode } from './locate.js';

import * as action from './action.js';
import { Yadb, readTextAt, findNodeAtPoint } from './input.js';
import * as state from './state.js';
import * as net from './net-profile.js';
import { screenSignature } from './png.js';

// uia2 退避预算：时序常量命名成组，不再散落字面量
import { createUia2 } from './uia2.js';
import { createTapEachRow } from './tap-each-row.js';
import { createDumpChannels } from './dump-channels.js';
import { createSizeProbe } from './size-probe.js';
import { assertSafePackage, assertSafeActivity, assertSafePropName, parsePackageVersion } from './package-guard.js';
import * as sms from './sms.js';

// ─── 命名常量（原散落字面量集中于此，语义见各处注释） ──────────────────────
/** 冷启动等待设备系统服务就绪的默认超时（毫秒），可被 ASK_BOOT_TIMEOUT_MS 覆盖 */
const DEFAULT_BOOT_TIMEOUT_MS = 60_000;
/** 长按默认时长（毫秒） */
const DEFAULT_LONG_PRESS_DURATION_MS = 800;
/** swipe / scroll 单次滑动的默认时长（毫秒） */
const DEFAULT_SWIPE_DURATION_MS = 300;
/** scroll 默认最大滚动次数 */
const DEFAULT_SCROLL_MAX = 5;
/** scrollUntil 默认最大滚动次数 */
const DEFAULT_SCROLL_UNTIL_MAX = 12;
/** scrollUntil 默认单步距离（屏高百分比）：小步抗 WebView fling 过冲 */
const DEFAULT_SCROLL_UNTIL_DISTANCE_PCT = 30;
/** waitIdle 默认连续相同 hash 次数（quiet） */
const DEFAULT_WAIT_IDLE_QUIET = 2;
/** waitIdle / waitFor* 默认轮询间隔（毫秒） */
const DEFAULT_POLL_INTERVAL_MS = 50;
/** waitIdle / waitFor* 默认总预算（毫秒） */
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
/** 传给 dumpTree 的单次 dump 预算下限（毫秒）：剩余预算再小也至少给 1s */
const MIN_DUMP_BUDGET_MS = 1_000;
/** dump 连续失败时的退避步长（毫秒/次） */
const FAILURE_BACKOFF_STEP_MS = 200;
/** dump 连续失败时的退避上限（毫秒） */
const FAILURE_BACKOFF_CAP_MS = 500;
/** dump 失败 / 非 XML 输出时错误消息里截取的预览长度（字符） */
const ERROR_PREVIEW_LENGTH = 120;
/** launch / pmGrant 失败时错误消息截取长度（字符） */
const SHELL_ERROR_PREVIEW_LENGTH = 200;
/** getProps 批量读取的属性值分隔符（getprop 对不存在属性输出空行，按行拆会错位） */
const PROP_VALUE_SEPARATOR = '__ASK_SEP__';
/** bounds 数组的标准长度 [left, top, right, bottom] */
const BOUNDS_LENGTH = 4;
/** readText 等值 MISS 后的包含兜底：识别 text=xx（可带 #index=N 后缀） */
const TEXT_EQUALS_SELECTOR_PATTERN = /^text=(.+?)(?:#index=\d+)?$/;
/** ASCII 降级判定：纯可打印 ASCII 才允许走原生 input text（中文会静默失败，§5.4.5） */
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/;
/** launch 输出中的失败信号 */
const LAUNCH_FAILURE_PATTERN = /error|exception|failure|no activities/i;
/** pm grant 输出中的失败信号 */
const PM_GRANT_FAILURE_PATTERN = /error|exception|not found|unknown|inaccessible/i;
/** 合法权限名：只允许 android.permission.* 大写权限 */
const ANDROID_PERMISSION_PATTERN = /^android\.permission\.[A-Z0-9_]+$/;
/** 内容语义方向 → 手指滑动区域对（from, to）。down=看下方内容=手指上滑 */
const SCROLL_REGION_MOVES = { down: ['bottom', 'top'], up: ['top', 'bottom'], right: ['right', 'left'], left: ['left', 'right'] };
/** 内容语义方向 → 手指方向（scrollDistancePoints 吃手指方向，与内容语义相反） */
const CONTENT_TO_FINGER_DIRECTION = { down: 'up', up: 'down', left: 'right', right: 'left' };

// ─── 通用小工具 ────────────────────────────────────────────────────────────

/**
 * 统一异常转文案：优先取 message，无 message 时字符串化。
 * @param {unknown} error - 捕获到的异常
 * @returns {string} 错误文案
 */
function errorMessage(error) {
  return String(error?.message ?? error);
}

/**
 * 睡眠指定毫秒（轮询循环用）。
 * @param {number} milliseconds - 睡眠时长
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 计算轮询循环的睡眠时长：dump 连续失败时线性退避（200ms×连败次数，封顶 500ms），
 * 避免设备离线期每个 intervalMs 白 spawn 一次 adb；正常时用调用方给的间隔。
 * @param {number} failureStreak - dump 连续失败次数
 * @param {number} intervalMs - 正常轮询间隔（毫秒）
 * @returns {number} 本轮应睡眠的毫秒数
 */
function pollSleepMs(failureStreak, intervalMs) {
  return failureStreak > 0
    ? Math.min(FAILURE_BACKOFF_CAP_MS, FAILURE_BACKOFF_STEP_MS * failureStreak)
    : intervalMs;
}

/**
 * 把"剩余等待预算"裁剪成单次 dump 的预算下限保护值：
 * 一次 fresh dump 可能耗时 4-155s（uia2 退避/重试路径），不设上限会突破
 * 调用方"最多等 N 毫秒"的契约；剩余预算再小也至少给 MIN_DUMP_BUDGET_MS。
 * @param {number} timeoutMs - 调用方总预算（毫秒）
 * @param {number} startedAt - 计时起点（Date.now()）
 * @returns {number} 本次 dump 可用的预算（毫秒）
 */
function remainingDumpBudgetMs(timeoutMs, startedAt) {
  return Math.max(MIN_DUMP_BUDGET_MS, timeoutMs - (Date.now() - startedAt));
}

// ─── 感知：文本读取与可见性匹配 ────────────────────────────────────────────

/**
 * readText 的包含兜底：text= 严格等值 MISS 时按包含匹配。
 * WebView 树的文本节点粒度随版本/渲染波动（"热度"↔"热度榜"），只查等值会假报"未匹配"。
 * 注意不能把 'text*=xx' 再喂回 matchSelector——parseTarget 不认识该前缀，会搜字面量。
 * @param {object[]} flatNodes - 扁平节点列表
 * @param {string} selector - 原始 selector（仅识别 text=xx[#index=N] 形态）
 * @returns {{value: string}|null} 包含命中的节点文本；不适用/未命中返回 null
 */
function containsFallbackMatch(flatNodes, selector) {
  const equalsMatch = TEXT_EQUALS_SELECTOR_PATTERN.exec(String(selector));
  if (!equalsMatch) return null;
  const needle = equalsMatch[1];
  const node = flatNodes.find((candidate) =>
    String(candidate.text || '').includes(needle) || String(candidate.contentDesc || '').includes(needle));
  if (!node) return null;
  return { value: node.text || node.contentDesc || '' };
}

/**
 * readText 实现：先严格匹配，MISS 后走包含兜底；异常一律结构化返回不抛出。
 * @param {Function} dumpTree - 门面的取树函数（可吃缓存）
 * @param {string} selector - 目标 selector
 * @returns {Promise<{ok: boolean, value: string|null, error: string|null, strategy?: string}>}
 */
async function readTextFromTree(dumpTree, selector) {
  try {
    const tree = await dumpTree();
    const flatNodes = flattenNodes(tree.nodes);
    const matched = matchSelector(flatNodes, selector);
    if (matched) return { ok: true, value: matched.value, error: null };
    const fallback = containsFallbackMatch(flatNodes, selector);
    if (fallback) return { ok: true, value: fallback.value, error: null, strategy: 'contains-fallback' };
    return { ok: false, value: null, error: `未匹配: ${selector}` };
  } catch (error) {
    return { ok: false, value: null, error: errorMessage(error) };
  }
}

/**
 * 判断节点 bounds 是否完全落在容器 bounds 内（四边包含）。
 * @param {number[]|undefined} bounds - 待判定节点 bounds
 * @param {number[]} containerBounds - 容器 bounds
 * @returns {boolean}
 */
function boundsInsideContainer(bounds, containerBounds) {
  return Array.isArray(bounds)
    && bounds[0] >= containerBounds[0] && bounds[1] >= containerBounds[1]
    && bounds[2] <= containerBounds[2] && bounds[3] <= containerBounds[3];
}

/**
 * waitFor* 专用匹配：matchSelector + 在屏过滤 + WebView 标记。
 * uni-app/WebView 壳会把未打开的页面预渲染进 accessibility 树（bounds 在屏内但不可见），
 * 不过滤会让 aiWaitFor 对"尚未到达的页面"误报 appeared；但**可见元素也可能报零面积
 * bounds**（首页导航栏 [0,0][0,0]），一律按 inScreen 过滤会永远匹配不到。
 * 故：零面积 = 几何未知 → 放行并标记 inWebView 交视觉确认；非零面积才做在屏过滤。
 * 零面积放行仅限 WebView 壳 App（其可见元素常报 [0,0][0,0]，且由视觉确认把关）；
 * 纯原生树里零面积 = 隐藏节点，保持严格过滤，避免 aiWaitFor 对隐藏元素误报。
 * @param {object[]} flatNodes - 扁平节点列表
 * @param {string} selector - 目标 selector
 * @param {Function} getSize - 屏幕尺寸探测（自带会话级缓存，命中时零开销）
 * @returns {Promise<object|null>} 命中时返回 { ...matchSelector 结果, inWebView }；未命中 null
 */
async function matchOnScreen(flatNodes, selector, getSize) {
  const matched = matchSelector(flatNodes, selector);
  if (!matched?.node) return null;
  let size;
  try { size = await getSize(); } catch { return { ...matched, inWebView: false }; }
  const bounds = matched.node.bounds;
  const webViewContainer = flatNodes.find((candidate) => /WebView/i.test(candidate.cls || ''));
  const zeroArea = !Array.isArray(bounds) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1];
  if (zeroArea && !webViewContainer) return null;
  if (!zeroArea && !inScreen(bounds, size)) return null;
  const inWebView = !!(webViewContainer && Array.isArray(webViewContainer.bounds)
    && (zeroArea || boundsInsideContainer(bounds, webViewContainer.bounds)));
  return { ...matched, inWebView };
}

// ─── 等待：轮询骨架（waitForElement / waitForAnyElement 共用） ─────────────

/**
 * 在扁平树上按序尝试多个 selector，任一命中即返回。
 * @param {object[]} flatNodes - 扁平节点列表
 * @param {string[]} selectors - 候选 selector（按序尝试）
 * @param {Function} getSize - 屏幕尺寸探测
 * @param {boolean} prefixedMatched - matched 文案是否带 "selector → " 前缀（多 selector 场景）
 * @returns {Promise<{matched: string, inWebView: boolean}|null>}
 */
async function matchAnySelectorOnScreen(flatNodes, selectors, getSize, prefixedMatched) {
  for (const selector of selectors) {
    const matched = await matchOnScreen(flatNodes, selector, getSize);
    if (matched?.node) {
      return {
        matched: prefixedMatched ? `${selector} → ${matched.value || ''}` : (matched.value || selector),
        inWebView: !!matched.inWebView,
      };
    }
  }
  return null;
}

/**
 * 等待元素出现的轮询骨架（waitForElement / waitForAnyElement 共用）：
 * 首轮吃缓存（调用前刚 dump 过且无动作置脏时目标可能已在树上，省一次 fresh dump）；
 * 未命中进入 fresh 轮询循环，每轮把剩余预算传给 dumpTree，dump 失败退避继续等，
 * 命中即返回，超时返回 appeared=false（不抛错）。
 * @param {string[]} selectors - 候选 selector（已 trim、去空）
 * @param {object} options
 * @param {number} options.timeoutMs - 总预算（毫秒），计时覆盖全程含首轮 cacheable dump
 * @param {number} options.intervalMs - 正常轮询间隔（毫秒）
 * @param {Function} options.dumpTree - 门面取树函数
 * @param {Function} options.getSize - 屏幕尺寸探测
 * @param {boolean} options.prefixedMatched - matched 文案是否带 selector 前缀
 * @returns {Promise<{appeared: boolean, dumps: number, matched: string|null, inWebView?: boolean}>}
 */
async function pollUntilAnyVisible(selectors, { timeoutMs, intervalMs, dumpTree, getSize, prefixedMatched }) {
  let dumps = 0;
  const startedAt = Date.now();
  try {
    const cachedTree = await dumpTree(); // cacheable：首轮吃缓存
    dumps++;
    const hit = await matchAnySelectorOnScreen(flattenNodes(cachedTree.nodes), selectors, getSize, prefixedMatched);
    if (hit) return { appeared: true, dumps, matched: hit.matched, inWebView: hit.inWebView };
  } catch { /* 缓存不可用 → 进入 fresh 循环 */ }
  let failureStreak = 0;
  while (Date.now() - startedAt < timeoutMs) {
    let flatNodes = [];
    try {
      // 强制新树（缓存命中会让"等待"失去意义），剩余预算下传防单次 dump 超契约
      const tree = await dumpTree({ fresh: true, timeoutMs: remainingDumpBudgetMs(timeoutMs, startedAt) });
      flatNodes = flattenNodes(tree.nodes);
      failureStreak = 0;
    } catch { failureStreak++; /* dump 失败（转场中）→ 继续等 */ }
    dumps++;
    if (flatNodes.length) {
      const hit = await matchAnySelectorOnScreen(flatNodes, selectors, getSize, prefixedMatched);
      if (hit) return { appeared: true, dumps, matched: hit.matched, inWebView: hit.inWebView };
    }
    // dump 之后重新检查 deadline：单次 dump 可能已超出预算，不该再睡一轮
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(pollSleepMs(failureStreak, intervalMs));
  }
  return { appeared: false, dumps, matched: null };
}

/**
 * waitForElement 实现：空 selector 结构化报错（不 dump），否则单 selector 轮询。
 * @param {string} selector - 目标 selector
 * @param {object} options - { timeoutMs, intervalMs }
 * @param {object} deps - { dumpTree, getSize }
 * @returns {Promise<object>} { appeared, dumps, matched, inWebView? , error? }
 */
async function waitForElementImpl(selector, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}, { dumpTree, getSize }) {
  const trimmedSelector = String(selector ?? '').trim();
  if (!trimmedSelector) return { appeared: false, dumps: 0, matched: null, error: 'selector 为空' };
  return pollUntilAnyVisible([trimmedSelector], { timeoutMs, intervalMs, dumpTree, getSize, prefixedMatched: false });
}

/**
 * waitForAnyElement 实现：多 selector 归一化后任一命中即返回。
 * @param {string|string[]} selectors - 候选 selector（数组或单值）
 * @param {object} options - { timeoutMs, intervalMs }
 * @param {object} deps - { dumpTree, getSize }
 * @returns {Promise<object>} { appeared, dumps, matched, inWebView? , error? }
 */
async function waitForAnyElementImpl(selectors, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}, { dumpTree, getSize }) {
  const normalizedSelectors = (Array.isArray(selectors) ? selectors : [selectors])
    .map((selector) => String(selector ?? '').trim()).filter(Boolean);
  if (!normalizedSelectors.length) return { appeared: false, dumps: 0, matched: null, error: 'selectors 为空' };
  return pollUntilAnyVisible(normalizedSelectors, { timeoutMs, intervalMs, dumpTree, getSize, prefixedMatched: true });
}

/**
 * waitIdle 实现：连续 quiet 次 dump 的树 hash 相同即稳定。
 * dump 失败（转场中/uiautomator idle 超时，§20.4 已知）当作"未稳定"继续等，
 * 不让异常逃出（否则整条用例会在 aiWaitFor 步判 error 中断，VERIFICATION-OVERVIEW §7）。
 * @param {object} options - { quiet, intervalMs, timeoutMs }
 * @param {Function} dumpTree - 门面取树函数（每轮强制 fresh，缓存命中会使判定失真）
 * @returns {Promise<{stable: boolean, dumps: number}>}
 */
async function waitIdleImpl({ quiet = DEFAULT_WAIT_IDLE_QUIET, intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = {}, dumpTree) {
  const startedAt = Date.now();
  let dumps = 0;
  let stableRun = 0;
  let previousHash = null;
  let stable = false;
  let failureStreak = 0; // dump 连续失败退避（设备离线期避免每 intervalMs 白 spawn 一次 adb）
  while (Date.now() - startedAt < timeoutMs) {
    let currentHash = null;
    try {
      currentHash = (await dumpTree({ fresh: true, timeoutMs: remainingDumpBudgetMs(timeoutMs, startedAt) })).hash;
    } catch { /* 未稳定，继续等 */ }
    dumps++;
    if (currentHash !== null) {
      failureStreak = 0;
      stableRun = previousHash !== null && currentHash === previousHash ? stableRun + 1 : 1;
      previousHash = currentHash;
      if (stableRun >= quiet) {
        stable = true;
        break;
      }
    } else {
      stableRun = 0;
      previousHash = null;
      failureStreak++;
    }
    // 单次 dump 本身 ~2.2s，轮间 sleep 对静默判定无增益：默认 50ms；
    // dump 连续失败时退避 200→500ms，避免空转打设备
    await sleep(pollSleepMs(failureStreak, intervalMs));
  }
  return { stable, dumps };
}

// ─── 操作：点位动作与输入回读 ──────────────────────────────────────────────

/**
 * 点位类动作（tap / longPress / swipe）的统一执行骨架：
 * 计时 → 执行 → 成功置脏缓存（§5.0.6 R1）→ 结构化返回；异常不抛出。
 * @param {Function} performAction - 实际动作（异步）
 * @param {Function} beforeAction - 动作成功后的缓存置脏回调
 * @returns {Promise<{ok: boolean, latencyMs: number, error: string|null}>}
 */
async function runPointAction(performAction, beforeAction) {
  const startedAt = Date.now();
  try {
    await performAction();
    beforeAction();
    return { ok: true, latencyMs: Date.now() - startedAt, error: null };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
  }
}

/**
 * 条件清空判定（性能）：聚焦 tap **之前**读定位阶段的缓存树取输入框当前文本；
 * 已为空则跳过 keyboardClear（省一次设备侧 app_process JVM 冷启动 ~300-600ms）。
 * tap 会置脏缓存，故必须在 tap 前读；缓存不可用时保守清空。
 * @param {object} cache - TreeCache 实例
 * @param {number[]} point - 输入框坐标 [x, y]
 * @param {boolean} clearRequested - 调用方是否要求清空
 * @returns {boolean} 是否真的需要清空
 */
function shouldClearBeforeInput(cache, point, clearRequested) {
  if (!clearRequested) return false;
  const preTree = cache.peek();
  if (!preTree) return true;
  const currentText = readTextAt(flattenNodes(preTree.nodes), point);
  return currentText !== '';
}

/**
 * 回读校验判定：普通输入框逐字等值；密码框 a11y text 通常是掩码串或恒空，
 * 逐字比对必然失败，改用「掩码长度一致或恒空回读放行」。
 * @param {string|null} readBack - 回读文本（密码框已由 readTextAt 脱敏为等长掩码）
 * @param {string} expectedText - 期望输入的文本
 * @param {boolean} isPassword - 输入位置节点是否 password=true
 * @returns {boolean} 回读是否通过
 */
function readBackMatches(readBack, expectedText, isPassword) {
  return isPassword
    ? (readBack == null || readBack.length === expectedText.length)
    : readBack === expectedText;
}

/**
 * 构造原生 `input text` 降级命令的参数（ASCII 降级路径专用）。
 * 转义集贴合 AOSP `input text` 的真实协议（Input.sendText 的 escapeFlag 机制）：
 *   - 空格 → `%s`（设备端 %s 解码为空格）
 *   - 字面 `%`：AOSP **不支持**转义它——% 后跟 's' 才被吞成空格，其它情况
 *     % 与后一字符都保留。故 "%%" 会解成两个 %（更糟），反斜杠转义则设备端
 *     原样送出（多出反斜杠）。正确做法是**原样保留**，让回读校验发现不符
 *     并如实报错——这是平台限制，不是可修的 bug。
 *     （主路径 yadb 无此限制，仅 vendor 二进制 ABI 不符时的降级路径受影响）
 *   - 其余 shell 元字符用单引号包裹（引号内 shell 不做展开）
 * @param {string} text - 纯 ASCII 输入文本
 * @returns {string} 单引号包裹、空格已编码的 shell 参数
 */
function buildInputTextArgument(text) {
  const spaceEncoded = text.replace(/ /g, '%s');
  return `'${spaceEncoded.replace(/'/g, `'\\''`)}'`;
}

/**
 * 生成 inputText 的失败文案。密码框报错不得带输入明文（凭据回读面脱敏，Task 17）。
 * @param {string|null} readBack - 回读文本
 * @param {string} originalText - 调用方传入的原始文本（用于普通框报错展示）
 * @param {boolean} isPassword - 是否密码框
 * @returns {string} 错误文案
 */
function inputReadBackError(readBack, originalText, isPassword) {
  if (isPassword) return '密码框回读长度不一致（掩码比对）';
  if (readBack == null) return '回读失败：未在输入位置找到节点';
  return `回读不一致: 期望「${originalText}」实际「${readBack}」`;
}

/**
 * inputText 实现：聚焦 tap → 条件清空+输入（yadb 合并单条 shell）→ fresh 树回读校验；
 * 纯 ASCII 且非密码框时回读失败可走原生 input text 降级重试一次（§5.4.5）。
 * @param {object} adb - Adb 实例
 * @param {object} yadb - Yadb 实例（中文输入主路径）
 * @param {Function} getSize - 屏幕尺寸探测
 * @param {object} cache - TreeCache（条件清空读 tap 前缓存）
 * @param {Function} dumpTree - 门面取树函数（回读强制 fresh）
 * @param {Function} beforeAction - 动作成功后的缓存置脏回调
 * @param {number[]|string} bounds - 输入框 bounds / 坐标 / 区域名
 * @param {string} text - 待输入文本
 * @param {object} options - { clear }
 * @returns {Promise<{ok: boolean, readBack: string|null, error: string|null, strategy?: string}>}
 */
async function inputTextImpl({ adb, yadb, getSize, cache, dumpTree, beforeAction }, bounds, text, { clear = true } = {}) {
  try {
    const point = action.resolvePoint(bounds, await getSize());
    const expectedText = String(text ?? '');
    const doClear = shouldClearBeforeInput(cache, point, clear);
    await action.tap(adb, point); // 点击聚焦
    // 清空+输入合并为一条 adb shell（省一次 spawn+队列等待）；回读校验保留
    // （input text 对中文静默失败的防线，§5.4.5）
    if (doClear) await yadb.clearAndType(expectedText);
    else await yadb.type(expectedText);
    beforeAction();
    let tree = await dumpTree({ fresh: true }); // 回读校验强制用新树（§5.4.5）
    let flatNodes = flattenNodes(tree.nodes);
    let readBack = readTextAt(flatNodes, point);
    const nodeAtPoint = findNodeAtPoint(flatNodes, point);
    const isPassword = !!nodeAtPoint?.password;
    // ASCII 降级：yadb 依赖设备 ABI/app_process，vendor 二进制与设备 ABI
    // 不符时 inputText 全挂且无替代路径。纯 ASCII 可走原生 `input text` 重试一次；
    // 非 ASCII 不降级（input text 对中文静默失败）。密码框不走降级：降级会二次输入，
    // 且掩码回读无法证伪，反而把凭据重放一遍。
    let usedFallback = false;
    if (!readBackMatches(readBack, expectedText, isPassword) && !isPassword && PRINTABLE_ASCII_PATTERN.test(expectedText)) {
      await adb.shell(`input text ${buildInputTextArgument(expectedText)}`).catch(() => {});
      usedFallback = true;
      beforeAction();
      tree = await dumpTree({ fresh: true });
      flatNodes = flattenNodes(tree.nodes);
      readBack = readTextAt(flatNodes, point);
    }
    const ok = readBackMatches(readBack, expectedText, isPassword);
    return {
      ok,
      readBack,
      error: ok ? null : inputReadBackError(readBack, text, isPassword),
      ...(usedFallback ? { strategy: 'input-text-fallback' } : {}),
    };
  } catch (error) {
    return { ok: false, readBack: null, error: errorMessage(error) };
  }
}

// ─── 操作：滚动与变化检测 ──────────────────────────────────────────────────

/**
 * 归一化滚动方向：非法 direction 统一兜底 down（内容语义），
 * 两条路径（regionPoint/distancePct）必须一致。
 * @param {string} direction - 调用方给的方向（内容语义）
 * @returns {string} 合法方向键（down/up/left/right）
 */
function normalizeScrollDirection(direction) {
  const directionKey = String(direction ?? 'down').toLowerCase();
  return SCROLL_REGION_MOVES[directionKey] ? directionKey : 'down';
}

/**
 * 截图像素签名（scroll 变化检测快通道）：截图失败返回 null，走树 hash 判定。
 * @param {Function} screencap - 门面截图函数
 * @returns {Promise<string|null>} 像素签名；失败 null
 */
async function captureScreenSignature(screencap) {
  try {
    const { buffer } = await screencap();
    return screenSignature(buffer);
  } catch {
    return null;
  }
}

/**
 * 执行一次滚动手势：distancePct 给定走定量距离（手指方向），否则走区域对 swipe。
 * @param {object} adb - Adb 实例
 * @param {string} direction - 已归一化的内容语义方向
 * @param {{w:number,h:number}} size - 屏幕尺寸
 * @param {number|null} distancePct - 屏高百分比距离；null 走区域对
 * @returns {Promise<void>}
 */
async function performScrollSwipe(adb, direction, size, distancePct) {
  if (distancePct != null) {
    // scrollDistancePoints 吃手指方向：内容语义取反后传入
    const fingerDirection = CONTENT_TO_FINGER_DIRECTION[direction] ?? 'up';
    const [startPoint, endPoint] = action.scrollDistancePoints(fingerDirection, size, distancePct);
    await action.swipe(adb, startPoint, endPoint, DEFAULT_SWIPE_DURATION_MS);
  } else {
    const [fromRegion, toRegion] = SCROLL_REGION_MOVES[direction];
    await action.swipe(adb, action.regionPoint(fromRegion, size), action.regionPoint(toRegion, size), DEFAULT_SWIPE_DURATION_MS);
  }
}

/**
 * scroll 实现：小步多次滚动 + 双信号变化检测（像素签名快通道 + 树 hash 兜底）。
 * 动机：整树 dump 在 busy WebView 上要 4-30s（uia2）/ 38-55s（legacy），scroll
 * 因此 170s/次；截图+解码+采样 0.5-1s，快 1-2 个数量级。
 * 但不能只用签名：WebView 会**停止出帧**（screencap 连续返回逐字节相同的陈旧画面）
 * 而 a11y 树仍在更新——签名恒等时单靠它会误判"到底"。所以签名只作**单向判据**：
 * 签名变了 ⇒ 一定变了（不问树）；签名没变 ⇒ 必须树确认。
 * 树基线用 lastTreeHash（swipe **前**的状态）——不能"降级后现取"（那时已 swipe 过，
 * 本轮变化会被算到下一轮，max=1 的调用方会误判"到底"）。基线缺失才在首次 swipe 前补 dump。
 * 形状严守契约 §1.1 { scrolls, changed }；getSize 失败时抛出，由工具层转 ok:false。
 * @param {object} deps
 * @param {object} deps.adb - Adb 实例
 * @param {Function} deps.getSize - 屏幕尺寸探测
 * @param {Function} deps.dumpTree - 门面取树函数
 * @param {Function} deps.screencap - 门面截图函数
 * @param {Function} deps.beforeAction - 动作后置脏回调
 * @param {Function} deps.getLastTreeHash - 读最近一次成功 dump 的树 hash（跨调用基线）
 * @param {string} direction - 内容语义方向（down=前进）
 * @param {object} options - { max, stopWhenNoChange, distancePct }
 * @returns {Promise<{scrolls: number, changed: boolean}>}
 */
async function scrollImpl({ adb, getSize, dumpTree, screencap, beforeAction, getLastTreeHash }, direction, { max = DEFAULT_SCROLL_MAX, stopWhenNoChange = true, distancePct = null } = {}) {
  const size = await getSize();
  const normalizedDirection = normalizeScrollDirection(direction);
  const hashNow = async () => (await dumpTree({ fresh: true })).hash;
  let previousSignature = await captureScreenSignature(screencap);
  // 树基线：优先复用跨调用基线 lastTreeHash（0 dump，调用方通常刚 dump 过）。
  // 没有基线时必须**在首次 swipe 之前**补一次——否则"签名没变"无法证明"没动"，
  // 会把真实滚动误报成到底（scrollUntil / tapEachRow 转向都用 max=1）。
  let previousHash = getLastTreeHash() ?? (await hashNow());
  let scrolls = 0;
  let changed = false;
  while (scrolls < max) {
    await performScrollSwipe(adb, normalizedDirection, size, distancePct);
    beforeAction();
    scrolls++;
    const currentSignature = await captureScreenSignature(screencap);
    // ① 快通道：签名变了 ⇒ 有变化。树基线随之失效（当前树未取，置 null 等下次确认时重建）
    if (currentSignature && previousSignature && currentSignature !== previousSignature) {
      changed = true;
      previousSignature = currentSignature;
      previousHash = null;
      continue;
    }
    // ② 签名不变/不可用（冻帧或截图失败）：树 hash 判定。
    // 基线可能已被快通道轮置 null——此时无法证伪"没动"，保守按 moved=true 处理
    // （判 false 会让冻帧切换点跳过树确认误判"到底"）。代价仅一轮多滚，下轮基线恢复。
    const currentHash = await hashNow();
    const moved = previousHash == null ? true : currentHash !== previousHash;
    previousHash = currentHash; // 无论是否 moved 都推进基线（下轮与当前状态比）
    previousSignature = currentSignature;
    if (moved) {
      changed = true;
    } else if (stopWhenNoChange) {
      break;
    }
  }
  return { scrolls, changed };
}

/**
 * scrollUntil 的可见性判定：节点中心在屏内（尺寸未知时放行）。
 * 零面积 bounds 是 WebView 渲染器特性 → 放行；纯原生树零面积 = 隐藏 → 排除。
 * @param {object} node - 扁平节点
 * @param {{w:number,h:number}|null} size - 屏幕尺寸；null 表示探测失败，跳过在屏过滤
 * @param {boolean} webViewPresent - 树上是否存在 WebView 壳容器
 * @returns {boolean}
 */
function isNodeCenterOnScreen(node, size, webViewPresent) {
  if (isZeroAreaBounds(node)) return webViewPresent;
  return !size || (node.center[0] >= 0 && node.center[0] <= size.w && node.center[1] >= 0 && node.center[1] <= size.h);
}

/**
 * scrollUntil 的面积有效性判定：bounds 必须是标准四元组；
 * 零面积仅在 WebView 壳内放行（几何未知），纯原生树视为隐藏排除。
 * @param {object} node - 扁平节点
 * @param {boolean} webViewPresent - 树上是否存在 WebView 壳容器
 * @returns {boolean}
 */
function hasUsableBounds(node, webViewPresent) {
  if (!Array.isArray(node.bounds) || node.bounds.length !== BOUNDS_LENGTH) return false;
  return isZeroAreaBounds(node) ? webViewPresent : true;
}

/**
 * scrollUntil 实现：小步滚动直到 selector 在屏可见（内容语义 direction，默认 down 前进）。
 * WebView fling 惯性大：单次大距离 swipe 会过冲整段，定量距离不可靠；
 * 小步（30% 屏）+ 每步树检可见才停，天然抗过冲。
 * 任一匹配节点可见即算 found（WebView 零面积放行，纯原生隐藏排除）。
 * @param {object} deps - { getSize, dumpTree, scroll }（scroll 为门面方法，单步 max=1）
 * @param {string} selector - 目标 selector
 * @param {object} options - { direction, max, distancePct }
 * @returns {Promise<{scrolls: number, found: boolean, changed: boolean, error: string|null}>}
 */
async function scrollUntilImpl({ getSize, dumpTree, scroll }, selector, { direction = 'down', max = DEFAULT_SCROLL_UNTIL_MAX, distancePct = DEFAULT_SCROLL_UNTIL_DISTANCE_PCT } = {}) {
  const result = { scrolls: 0, found: false, changed: false, error: null };
  if (!selector) { result.error = 'scrollUntil 需要 selector'; return result; }
  const size = await getSize().catch(() => null);
  for (let stepIndex = 0; stepIndex < max; stepIndex++) {
    let flatNodes = [];
    try { flatNodes = flattenNodes((await dumpTree({ fresh: true })).nodes); } catch (error) { result.error = `dump 失败: ${errorMessage(error)}`; return result; }
    const webViewPresent = hasWebViewContainer(flatNodes);
    const isVisibleTarget = (node) => matchNode(node, selector)
      && hasUsableBounds(node, webViewPresent)
      && isNodeCenterOnScreen(node, size, webViewPresent);
    if (flatNodes.some(isVisibleTarget)) { result.found = true; return result; }
    const scrollResult = await scroll(direction, { max: 1, stopWhenNoChange: true, distancePct });
    result.scrolls++;
    result.changed = result.changed || scrollResult.changed;
    if (!scrollResult.changed) return result; // 到底仍未见 → found=false 由调用方判定
  }
  return result;
}

// ─── 环境：应用启停与系统属性 ──────────────────────────────────────────────

/**
 * launch 实现：包名/Activity 白名单校验后 am start 或 monkey 拉起；
 * 换 App/重启使旧树基线作废。输出含失败信号时 ok=false。
 * @param {object} adb - Adb 实例
 * @param {Function} invalidateTreeBaseline - 清空 lastTreeHash 的回调
 * @param {Function} beforeAction - 动作后置脏回调
 * @param {string} appId - 包名或 包名/Activity
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
async function launchAppImpl(adb, invalidateTreeBaseline, beforeAction, appId) {
  try {
    const trimmedId = String(appId ?? '').trim();
    const [packageName, activityName] = trimmedId.split('/');
    // 包名白名单：adb shell 走设备端 /bin/sh -c，未校验的包名可携带
    // "; rm -rf /sdcard" 之类的 shell 元字符。Android 包名只允许字母数字下划线点。
    assertSafePackage(packageName);
    if (activityName) assertSafeActivity(activityName);
    const output = await adb.shell(activityName
      ? `am start -n ${packageName}/${activityName}`
      : `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    invalidateTreeBaseline(); // 换 App/重启：旧树基线作废
    beforeAction();
    const failed = LAUNCH_FAILURE_PATTERN.test(output);
    return { ok: !failed, error: failed ? output.trim().slice(0, SHELL_ERROR_PREVIEW_LENGTH) : null };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * terminate 实现：白名单校验后 am force-stop；旧树基线作废。
 * @param {object} adb - Adb 实例
 * @param {Function} invalidateTreeBaseline - 清空 lastTreeHash 的回调
 * @param {Function} beforeAction - 动作后置脏回调
 * @param {string} packageName - 目标包名
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function terminateAppImpl(adb, invalidateTreeBaseline, beforeAction, packageName) {
  try {
    const trimmedPackage = String(packageName ?? '').trim();
    assertSafePackage(trimmedPackage);
    await adb.shell(`am force-stop ${trimmedPackage}`);
    invalidateTreeBaseline();
    beforeAction();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * pmGrant 实现：包名与权限名双重白名单校验后 pm grant；
 * 输出含失败信号时 ok=false（错误文案截断）。
 * @param {object} adb - Adb 实例
 * @param {string} permission - 权限名（只允许 android.permission.* 大写）
 * @param {string} packageName - 目标包名
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
async function pmGrantImpl(adb, permission, packageName) {
  try {
    assertSafePackage(packageName);
    if (!ANDROID_PERMISSION_PATTERN.test(String(permission ?? '').trim())) {
      throw new Error(`权限名非法: "${permission}"（只允许 android.permission.* 大写权限）`);
    }
    const { stdout, stderr } = await adb.shell(`pm grant ${packageName} ${permission}`, { timeoutMs: adb.timeouts.command, withStderr: true });
    const combinedOutput = `${stdout}\n${stderr}`;
    const failed = PM_GRANT_FAILURE_PATTERN.test(combinedOutput);
    return { ok: !failed, error: failed ? combinedOutput.trim().slice(0, SHELL_ERROR_PREVIEW_LENGTH) : null };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * getProps 实现：一次 shell 读多个属性（避免每属性各 spawn 一次 adb）。
 * 必须用分隔符而非按行拆：getprop 对**不存在的属性**会输出空行，按行拆会让
 * 后续所有属性值整体前移一位——数据静默损坏，且会污染整轮运行的提示词。
 * 非法属性名抛错 → 返回等长空串数组，绝不拼进 shell。
 * @param {object} adb - Adb 实例
 * @param {string|string[]} names - 属性名（数组或单值）
 * @returns {Promise<string[]>} 与入参等长的属性值数组；失败全空串
 */
async function getPropsImpl(adb, names) {
  const nameList = (Array.isArray(names) ? names : [names]).map((name) => String(name).trim());
  if (!nameList.length) return [];
  try {
    nameList.forEach(assertSafePropName);
    const output = await adb.shell(
      nameList.map((name) => `getprop ${name}`).join(`; echo ${PROP_VALUE_SEPARATOR}; `),
      { timeoutMs: adb.timeouts.command },
    );
    // 末尾多一个分隔符，便于切分最后一段
    const parts = String(output).split(PROP_VALUE_SEPARATOR);
    return nameList.map((unusedName, index) => String(parts[index] ?? '').trim());
  } catch {
    return nameList.map(() => '');
  }
}

// ─── 取证 ──────────────────────────────────────────────────────────────────

/**
 * dumpToFile 实现：取原始 XML 去杂质后落盘。
 * 取证文件不能静默落非 XML 内容（失败 dump 落盘提示行会误导取证）。
 * @param {Function} dumpXmlRaw - 原始 dump 通道函数
 * @param {string} path - 落盘路径
 * @returns {Promise<string>} 原样返回 path
 */
async function dumpToFileImpl(dumpXmlRaw, path) {
  const xml = await dumpXmlRaw();
  const text = truncateAtHierarchyEnd(xml);
  if (!text.includes('</hierarchy>')) {
    throw new Error(`uiautomator dump 未返回 XML: ${text.trim().slice(0, ERROR_PREVIEW_LENGTH)}`);
  }
  await writeFile(path, text, 'utf8');
  return path;
}

// ─── 门面组装 ──────────────────────────────────────────────────────────────

// exec 仅测试注入用；契约入口 createDevice 不暴露该参数
// waitReady 控制是否等待设备系统服务就绪（冷启动场景）；空 exec/测试注入时可传 false 跳过
// probeFile：模型家族坐标探测缓存路径（默认 cwd/.ask/family-probe.json；工作区模式下由 CLI 传全局路径）
export async function createDeviceWithExecutor({ serial, adbPath = process.env.ASK_ADB || 'adb', timeouts = {}, exec, waitReady = null, probeFile = null, missDumpDir = null, uia2: uia2Inject = null } = {}) {
  const adb = new Adb({ serial, adbPath, timeouts, exec });
  await adb.ensureConnected().catch((error) => { console.warn(`[warn] 设备首连失败（${error.message}），命令期仍有重连机会`); });

  // 设备就绪等待（冷启动窗口）：默认在真实设备上启用；测试注入 exec 时默认跳过（避免等 60s）
  const shouldWait = waitReady === null ? !exec : Boolean(waitReady);
  let bootSize = null;
  if (shouldWait) {
    try {
      const bootResult = await adb.waitForBoot({ timeoutMs: Number(process.env.ASK_BOOT_TIMEOUT_MS) || DEFAULT_BOOT_TIMEOUT_MS });
      if (!bootResult.ready) console.warn(`[warn] ${bootResult.reason}`);
      if (bootResult?.size) bootSize = bootResult.size; // waitForBoot 已解析 wm size，seed 进尺寸探测缓存免重复往返
    } catch (error) {
      console.warn(`[warn] 等待设备就绪失败：${error?.message ?? error}`);
    }
  }

  const cache = new TreeCache();
  const vlmCache = new Map();
  const yadb = new Yadb(adb);
  // 注：原 pendingPreHash / lastActionChanged（"动作后画面是否变化"的懒校验）已删除——
  // 全仓零消费者（device.lastActionChanged getter 无人读），是死代码。

  // 屏幕尺寸探测（见 size-probe.js）：会话级缓存 + 负缓存冷却，状态随模块内聚。
  const getSize = createSizeProbe({ adb, bootSize });

  // /dev/tty dump 在新版 platform-tools 上 shell 通道 stdout 只有提示行，XML 须走 exec-out 通道；
  // exec-out 失败或返回不含 </hierarchy> 时回退 legacy shell（旧镜像/redroid 兼容）。
  // 通道粘性（性能）：记住上次成功的通道，后续直走；失败再重置重探，
  // 避免在 exec-out 不可用的设备上每次 dump 都付双倍成本。
  // 第三级回退：文件形式 dump + cat。API 30 x86 + uni-app 模态弹窗下 tty 两通道全部
  // 返回无 hierarchy（UI busy / pipe 限制），文件形式稳定可用——没有它，弹窗态整个引擎失明。
  // 测试注入 exec 时跳过 uia2（单测走 legacy 路径保持确定性；真机不受影响）；
  // 显式传 uia2 stub 即可测通道决策（槽守卫/瞬态分类/busy 重试），与 exec 注入的 adb stub 组合使用。
  const uia2 = uia2Inject ?? (exec ? null : createUia2({ adb, serial, log: (message) => console.warn('[uia2] ' + message) }));

  // UI 树抓取（通道策略见 dump-channels.js）：uia2 退避状态、粘性通道与
  // timeout 可用性探测随模块内聚，index.js 不再持有。
  const dumpXmlRaw = createDumpChannels({ adb, uia2 });
  // 最近一次成功 dump 的树 hash：scroll 等只做**变化检测**的场景用它当对比基线，
  // 免掉一次 38-55s 的慢 dump（动画不改 a11y 树，跨时间复用安全；换 App 的动作清空）
  let lastTreeHash = null;

  // budgetMs：本次 dump 的总预算（毫秒）。waitFor* 传入剩余预算，避免单次 dump
  // 远超调用方的"最多等 N 毫秒"契约。
  // timeoutMs：本次 dump 的预算上限（毫秒）。waitFor* 用它把"剩余预算"传下来——
  // 一次 fresh dump 可能耗时 4-155s（uia2 退避/重试路径），不设上限会让
  // waitForElement({timeoutMs:10000}) 实际跑 165s，超出调用方契约。
  async function dumpTree({ fresh = false, timeoutMs = null } = {}) {
    if (!fresh) {
      const hit = cache.peek();
      if (hit) {
        cache.recordHit();
        // cachedAt：缓存条目生成时刻，供调用方做新鲜度判定（popup 前台派生用）
        return { nodes: hit.nodes, hash: hit.hash, dumpMs: 0, fromCache: true, cachedAt: hit.ts };
      }
    }
    cache.recordMiss();
    const startedAt = Date.now();
    const xml = await dumpXmlRaw(timeoutMs != null ? { budgetMs: timeoutMs } : undefined);
    const dumpMs = Date.now() - startedAt;
    cache.recordDump();
    const text = truncateAtHierarchyEnd(xml);
    const nodes = parseXmlDump(text);
    if (!nodes.length) throw new Error(`uiautomator dump 失败: ${text.trim().slice(0, ERROR_PREVIEW_LENGTH)}`);
    const hash = treeHash(nodes);
    lastTreeHash = hash;
    cache.set({ nodes, hash });
    return { nodes, hash, dumpMs, fromCache: false };
  }

  function beforeAction() {
    cache.markDirty();   // 动作后强制下次 dump 取新树（缓存失效）
  }

  // 换 App/重启：旧树基线作废（launch/terminate 共用）
  function invalidateTreeBaseline() {
    lastTreeHash = null;
  }

  const locate = createLocator({ getTree: dumpTree, getSize, screencap: () => screen.screencap(adb, { timeoutMs: adb.timeouts.screencap }), vlmCache, missDumpDir, ...(probeFile ? { probeFile } : {}) });

  // 逐行作答状态机（从本文件抽出，见 tap-each-row.js）
  const tapEachRowImpl = createTapEachRow({
    adb,
    dumpTree,
    getSize,
    screencap: () => device.screencap(),
    scroll: (direction, options) => device.scroll(direction, options),
  });

  const device = {
    serial: serial ?? null, // RunRecorder 落 run.json 的 device.serial（§14.1）
    // —— 感知 ——
    async screencap() {
      const buffer = await screen.screencap(adb, { timeoutMs: adb.timeouts.screencap });
      // size 探测失败不阻断截图（冷启动期 wm size 可能未就绪）；size 为 null 时调用方自行降级
      let size = null;
      try { size = await getSize(); } catch { size = null; }
      return { buffer, size };
    },
    dumpTree,
    locate,
    vlmCache, // 暴露 VLM 接地缓存：批量预取接地写入此 Map（键 tree.hash::target）
    async readText(selector) {
      return readTextFromTree(dumpTree, selector);
    },
    async screenDiffHash() {
      return (await dumpTree()).hash;
    },

    // —— 操作 ——（动作成功后一律 markDirty，§5.0.6 R1）
    async tap(bounds) {
      return runPointAction(async () => {
        const point = action.resolvePoint(bounds, await getSize());
        await action.tap(adb, point);
      }, beforeAction);
    },
    async longPress(bounds, durationMs = DEFAULT_LONG_PRESS_DURATION_MS) {
      return runPointAction(async () => {
        const point = action.resolvePoint(bounds, await getSize());
        await action.longPress(adb, point, durationMs);
      }, beforeAction);
    },
    async inputText(bounds, text, { clear = true } = {}) {
      return inputTextImpl({ adb, yadb, getSize, cache, dumpTree, beforeAction }, bounds, text, { clear });
    },
    async swipe(from, to, { durationMs = DEFAULT_SWIPE_DURATION_MS } = {}) {
      return runPointAction(async () => {
        const size = await getSize();
        const startPoint = action.resolvePoint(from, size);
        const endPoint = action.resolvePoint(to, size);
        await action.swipe(adb, startPoint, endPoint, durationMs);
      }, beforeAction);
    },
    // 无变化判定用树 hash（禁止截图 hash，§5.0.1）；实现见 scrollImpl
    async scroll(direction, { max = DEFAULT_SCROLL_MAX, stopWhenNoChange = true, distancePct = null } = {}) {
      return scrollImpl(
        { adb, getSize, dumpTree, screencap: () => device.screencap(), beforeAction, getLastTreeHash: () => lastTreeHash },
        direction, { max, stopWhenNoChange, distancePct },
      );
    },
    // 小步滚动直到 selector 在屏可见；实现见 scrollUntilImpl
    async scrollUntil(selector, { direction = 'down', max = DEFAULT_SCROLL_UNTIL_MAX, distancePct = DEFAULT_SCROLL_UNTIL_DISTANCE_PCT } = {}) {
      return scrollUntilImpl(
        { getSize, dumpTree, scroll: (dir, options) => device.scroll(dir, options) },
        selector, { direction, max, distancePct },
      );
    },
    // 逐行作用域批量点击（引擎确定性，0 模型往返）：表单/问卷作答场景。App 无关：
    // 行/选项/终止标记全部由 selector 表达；选项带按邻行几何推导；选中色可配。
    // 关键事实：① WebView 选中态不进 a11y 树，adb tap 无回执；② 选中会触发
    // scroll-into-view，**tap 后整页滚动**，同轮内后续行的坐标立即失效。
    // 因此每轮只 tap 一行：dump → 取文档序第一个未答行 → tap 其行内最左在屏选项 → 等渲染 →
    // 双信号验证（树 hash 变化=页面响应；或原坐标像素变为选中色）→ 记 answered；
    // 双信号皆无 = 渲染器挂死计数（连续 2 次报错退出，不再空转记假已答）。
    // verifyColor：'auto'（蓝色启发式）| '#RRGGBB' | [r,g,b]；verify=false 关闭像素校验。
    // 转向：无在屏可答行时按第一个未答行几何：选项在屏下 → down 前进；行与选项都在屏上 → up 回退。
    // stopWhen 可见**且**全文档无未答行才 done。零面积节点（隐藏预渲染层）一律排除。
    async tapEachRow(opts = {}) {
      return tapEachRowImpl(opts);
    },
    async key(name) {
      try {
        await action.key(adb, name);
        beforeAction();
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
    async launch(appId) {
      return launchAppImpl(adb, invalidateTreeBaseline, beforeAction, appId);
    },
    async terminate(packageName) {
      return terminateAppImpl(adb, invalidateTreeBaseline, beforeAction, packageName);
    },
    /** 清空应用数据（pm clear）：全量重置含登录态/缓存/数据库。需包名白名单校验 + 输出失败信号检测。 */
    async clearAppData(packageName) {
      try {
        const trimmedPackage = String(packageName ?? '').trim();
        assertSafePackage(trimmedPackage);
        const output = await adb.shell(`pm clear ${trimmedPackage}`);
        // pm clear 对不存在的包输出 "Failed" / "Error: ..." 且 exit 0，必须检查输出内容
        const failed = /failed|error|exception|unknown/i.test(output);
        invalidateTreeBaseline();
        beforeAction();
        return { ok: !failed, error: failed ? output.trim().slice(0, SHELL_ERROR_PREVIEW_LENGTH) : null };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    // —— 环境 ——
    async foreground() {
      return state.foreground(adb);
    },
    async screenSize() {
      return getSize();
    },
    async processAlive(packageName) {
      return state.processAlive(adb, packageName);
    },
    // 等待画面稳定：连续 quiet 次 dump 的树 hash 相同即稳定。
    // quiet=2（默认，稳）＝ 需 2 次 dump（约 2.2s/dump → 4.6s）；quiet=1（快）＝ 1 次即返回（约 2.2s，但只是单次快照）。
    async waitIdle({ quiet = DEFAULT_WAIT_IDLE_QUIET, intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = {}) {
      return waitIdleImpl({ quiet, intervalMs, timeoutMs }, dumpTree);
    },
    // 等元素出现（§21）：比"等树不变"更语义、通常更快——每次 dump 后查目标是否已出现，出现即返回。
    // 返回 { appeared, dumps, matched: <文本> | null }。
    // selector 支持 'text=xx' | 'text*=xx' | 'resourceId=xx' | 'class=...#index=N'（同 readText 的匹配器）。
    async waitForElement(selector, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
      return waitForElementImpl(selector, { timeoutMs, intervalMs }, { dumpTree, getSize });
    },
    // 等任一元素出现（多 selector，命中其一即返回）
    async waitForAnyElement(selectors, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
      return waitForAnyElementImpl(selectors, { timeoutMs, intervalMs }, { dumpTree, getSize });
    },
    async assertNoCrash(expectedPackage) {
      return state.assertNoCrash(adb, expectedPackage);
    },
    async netSetProfile(name) {
      const profileResult = await net.setNetProfile(adb, name);
      if (profileResult.ok) beforeAction();
      return profileResult;
    },
    async netStatus() {
      return net.netStatus(adb);
    },

    // —— 缓存与取证 ——
    markDirty() {
      cache.markDirty();
    },
    invalidateCache() {
      cache.invalidate();
      vlmCache.clear();
    },
    /** 重置 uia2 退避状态并重新探测（APP 初始化 force-stop 后 uia2 进程被杀时需调用） */
    async resetUia2() {
      if (uia2 && typeof uia2.resetAndEnsure === 'function') {
        return uia2.resetAndEnsure();
      }
      return false;
    },
    cacheStats() {
      return cache.stats();
    },
    // 只读取最近一次缓存树（{nodes,hash} 或 null），不触发 dump；供 withRecording
    // 动作后截图前找 password 节点做遮罩（Task 17，凭据图像面脱敏，尽力而为）。
    cachePeek() {
      return cache.peek();
    },
    async dumpToFile(path) {
      return dumpToFileImpl(dumpXmlRaw, path);
    },
    // 释放 uia2 资源：设备端会话（DELETE /wd/hub/session/:id）+ host 侧 adb forward。
    // 不释放会占住 Android 11 独占的 UiAutomation 注册槽，使 legacy dump 通道以
    // rc=137 死掉（本模块依赖的兜底路径）；adb forward 也会在 host 侧累积绑定。
    async close() {
      if (uia2 && typeof uia2.dispose === 'function') {
        await uia2.dispose().catch(() => {});
      }
    },

    // —— 附加（非契约方法，B 可选用；不影响 §1.1 既定签名） ——
    // preflight 用（§2.7）：读包信息 / 授予权限；失败返回 ''/ok:false，不抛错
    async dumpsysPackage(pkg) {
      try {
        assertSafePackage(pkg); // 非法包名抛错 → catch 返回 ''，调用方 pregrant 拿不到请求权限、不会 grant
        return await adb.shell(`dumpsys package ${String(pkg).trim()}`, { timeoutMs: adb.timeouts.command });
      } catch { return ''; }
    },
    // 目标 App 的 versionName（plan-cache 跨版本失效键用）：复用 dumpsysPackage，
    // 再由设备层纯函数解析；失败/无 versionName 一律返回 null，调用方按 'unknown' 处理。
    // 注：dumpsysPackage 已在入口做包名白名单，packageVersion 复用即自动受益。
    async packageVersion(pkg) {
      const text = await this.dumpsysPackage(pkg);
      return parsePackageVersion(text);
    },
    async pmGrant(permission, pkg) {
      return pmGrantImpl(adb, permission, pkg);
    },
    // getprop 读取（L2 设备事实采集用，bin/ask.js）：失败返回 '' 不抛错，调用方自行降级
    async getProp(name) {
      try {
        assertSafePropName(name);
        const output = await adb.shell(`getprop ${String(name).trim()}`, { timeoutMs: adb.timeouts.command });
        return String(output).trim();
      } catch {
        return '';
      }
    },
    // 一次 shell 读多个属性（性能）；实现见 getPropsImpl
    async getProps(names) {
      return getPropsImpl(adb, names);
    },
    // 短信读取（§19.7）：content://sms/inbox 走固定串命令，contains/limit 过滤在结果侧做，
    // 绝不把用户输入拼进 adb shell。失败（含无权限）以结构化 { ok:false, error } 返回。
    async readSms(params) {
      return sms.readSms(adb, params);
    },
  };

  return device;
}

export async function createDevice({ serial, adbPath = process.env.ASK_ADB || 'adb', timeouts, probeFile = null, missDumpDir = null } = {}) {
  // probeFile 必须转发：CLI 传入的是全局探测缓存路径（<ASK_HOME>/.ask/family-probe.json），
  // 而 locate 的默认是 cwd/.ask/…——不转发则工作区模式下探测结果永远读不到，
  // VLM 定位在未指定 family 时必然失败。
  // missDumpDir：LOCATE_MISS 时把当次 UI 树落盘供排查（见 locate.js dumpMissTree）。
  return createDeviceWithExecutor({ serial, adbPath, timeouts, probeFile, missDumpDir });
}