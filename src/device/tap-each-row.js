// 逐行作答状态机（§5.4.6）：问卷/表单一行一行作答。
//
// 职责拆分：每个子函数只做一件事，主循环只负责编排。
// 依赖以参数注入，避免与 index.js 形成循环依赖。
import { decodePng, parseHexColor, isBlueish, isColorish, pixelAt } from './png.js';
import { flattenNodes, isZeroAreaBounds, hasWebViewContainer } from './uitree.js';
import * as action from './action.js';
import { matchNodeSelector as matchNode } from './locate.js';
import { resolveTiming } from './profiles/index.js';

// ─── 常量 ──────────────────────────────────────────────────────────────────
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 120_000;
const HANG_THRESHOLD = 2;          // 连续 tap 无响应次数 → 判渲染器挂死
const TAP_FAIL_THRESHOLD = 2;      // 连续 tap 抛错次数 → 报错退出
const NO_PROGRESS_THRESHOLD = 2;   // 连续转向无进展轮数 → 判到底
const PIXEL_SAMPLE_RADIUS_PCT = 0.02; // 无 bounds 时采样半径占屏宽比例
const PIXEL_HIT_RATIO = 0.6;      // 像素验证命中比例阈值
const BAND_FALLBACK_RATIO = 400 / 2340; // 末行选项带回退高度占屏高比例

// ─── 1. 配置解析 ───────────────────────────────────────────────────────────
/**
 * 校验参数、加载 profile、解析时序与颜色配置。
 * 返回 { config, error }，error 非空时调用方应直接返回错误结果。
 */
async function resolveAnswerConfig({ rows, tap, maxRounds, verifyColor, profile }) {
  if (!rows || !tap) return { config: null, error: 'tapEachRow 需要 rows 与 tap 参数' };

  let prof = null;
  if (profile) {
    try {
      const { loadProfile } = await import('./profiles/index.js');
      prof = await loadProfile(profile);
    } catch (e) {
      return { config: null, error: `profile 加载失败: ${e?.message ?? e}` };
    }
  }

  const timing = resolveTiming({ maxRounds, verifyColor }, prof);
  const expectedColor = timing.verifyColor === 'auto' || timing.verifyColor == null
    ? null
    : (Array.isArray(timing.verifyColor) ? timing.verifyColor : parseHexColor(timing.verifyColor));

  if (timing.verifyColor !== 'auto' && timing.verifyColor != null && !expectedColor) {
    return { config: null, error: `verifyColor 无法解析: ${timing.verifyColor}（应为 '#RRGGBB' 或 [r,g,b] 或 'auto'）` };
  }

  const readyWaitMs = Math.max(0, Math.min(MAX_READY_TIMEOUT_MS, Number(prof?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) || 0));

  return {
    config: {
      maxRounds: timing.maxRounds,
      settleMs: timing.settleMs,
      expectedColor,
      verifyEnabled: true,
      readyDeadline: Date.now() + readyWaitMs,
      tapSelectors: String(tap).split('|').map((s) => s.trim()).filter(Boolean),
      rowSelectors: String(rows).split('|').map((s) => s.trim()).filter(Boolean),
    },
    error: null,
  };
}

// ─── 2. 节点过滤器工厂 ─────────────────────────────────────────────────────
/**
 * 创建面积有效性检查与在屏可见性检查函数。
 * WebView 壳内零面积 bounds 是渲染器特性 → 放行；纯原生树零面积 = 隐藏 → 排除。
 */
function createNodeFilters(flatNodes, screenSize) {
  const webViewPresent = hasWebViewContainer(flatNodes);

  const isAreaValid = (node) => {
    if (!Array.isArray(node.bounds) || node.bounds.length !== 4) return false;
    const zeroArea = node.bounds[2] <= node.bounds[0] || node.bounds[3] <= node.bounds[1];
    return zeroArea ? webViewPresent : true;
  };

  const isVisibleOnScreen = (node) => {
    if (!isAreaValid(node)) return false;
    if (isZeroAreaBounds(node)) return true; // 零面积已放行，不做 center 在屏检查
    if (!screenSize) return true;
    return node.center[0] >= 0 && node.center[0] <= screenSize.w
      && node.center[1] >= 0 && node.center[1] <= screenSize.h;
  };

  return { isAreaValid, isVisibleOnScreen };
}

// ─── 3. 行节点聚类 ─────────────────────────────────────────────────────────
/**
 * 从扁平节点中筛选行节点、排序、聚类、分配唯一身份 key。
 * 零面积行按文档序排在有 bounds 行之后，保持题目顺序不乱。
 */
function clusterRowNodes(flatNodes, rowSelectors, isAreaValid) {
  const rowNodes = flatNodes.filter((node) =>
    rowSelectors.some((sel) => matchNode(node, sel)) && isAreaValid(node) && (node.text || node.contentDesc),
  );

  // 排序：有 bounds 按 y 坐标；零面积按文档序排后
  const sortedRows = rowNodes.sort((a, b) => {
    const aZero = isZeroAreaBounds(a) ? 1 : 0;
    const bZero = isZeroAreaBounds(b) ? 1 : 0;
    if (aZero !== bZero) return aZero - bZero;
    if (aZero && bZero) return (a.index ?? 0) - (b.index ?? 0);
    return a.center[1] - b.center[1];
  });

  // 聚类：y 坐标相近的行归为一组（同一题的多行文本）
  const clusters = [];
  for (const node of sortedRows) {
    const lastCluster = clusters[clusters.length - 1];
    const proximityThreshold = Math.max(40, (node.bounds[3] - node.bounds[1]) / 2);
    if (lastCluster && Math.abs(node.center[1] - lastCluster.centerY) < proximityThreshold) {
      lastCluster.nodes.push(node);
      lastCluster.centerY = lastCluster.nodes.reduce((sum, n) => sum + n.center[1], 0) / lastCluster.nodes.length;
    } else {
      clusters.push({ centerY: node.center[1], nodes: [node], text: String(node.text || node.contentDesc || '') });
    }
  }

  // 身份 key：文本 + 同文本出现序号（防重复行文本误判为同一行）
  const textOccurrence = new Map();
  for (const cluster of clusters) {
    const count = (textOccurrence.get(cluster.text) ?? 0) + 1;
    textOccurrence.set(cluster.text, count);
    cluster.key = count === 1 ? cluster.text : `${cluster.text}#${count}`;
  }

  return clusters;
}

// ─── 4. 选项查找 ───────────────────────────────────────────────────────────
/**
 * 为指定行集群查找其选项节点。
 * 选项带下界 = 下一行的 centerY；零面积选项跳过几何带划分直接放行。
 */
function findOptionsForCluster(cluster, clusters, flatNodes, tapSelectors, isAreaValid, screenSize) {
  const clusterIndex = clusters.indexOf(cluster);
  const nextCluster = clusters[clusterIndex + 1];
  const bandFallback = Math.round((screenSize?.h ?? 2340) * BAND_FALLBACK_RATIO);
  const bandEnd = nextCluster
    ? Math.max(nextCluster.centerY - 8, cluster.centerY + 40)
    : cluster.centerY + bandFallback;

  return flatNodes
    .filter((node) => {
      if (!tapSelectors.some((sel) => matchNode(node, sel)) || !isAreaValid(node)) return false;
      if (isZeroAreaBounds(node)) return true; // 零面积选项由文本匹配保证归属
      return node.center[1] > cluster.centerY && node.center[1] <= bandEnd;
    })
    .sort((a, b) => {
      const aZero = isZeroAreaBounds(a) ? 1 : 0;
      const bZero = isZeroAreaBounds(b) ? 1 : 0;
      if (aZero !== bZero) return aZero - bZero;
      if (aZero && bZero) return (a.index ?? 0) - (b.index ?? 0);
      return a.center[0] - b.center[0]; // 左→右 = 第一个选项优先
    });
}

// ─── 5. 目标选择与转向决策 ─────────────────────────────────────────────────
/**
 * 从待答行中选第一个在屏可答行；无可答行时决定转向方向。
 * 返回 { target, scrollDirection, shouldSkip }。
 */
function pickNextAnswerTarget(pendingClusters, clusters, flatNodes, tapSelectors, isAreaValid, isVisibleOnScreen, screenSize) {
  // 优先找在屏可答行
  for (const cluster of pendingClusters) {
    const options = findOptionsForCluster(cluster, clusters, flatNodes, tapSelectors, isAreaValid, screenSize);
    const visibleOption = options.find((node) => isVisibleOnScreen(node));
    if (visibleOption) return { target: { cluster, option: visibleOption }, scrollDirection: null, shouldSkip: false };
  }

  // 无可答行：决定转向
  const firstPending = pendingClusters[0];
  if (!firstPending) return { target: null, scrollDirection: 'down', shouldSkip: false };

  const options = findOptionsForCluster(firstPending, clusters, flatNodes, tapSelectors, isAreaValid, screenSize);
  if (!options.length && firstPending.centerY >= 0 && (!screenSize || firstPending.centerY <= screenSize.h)) {
    return { target: null, scrollDirection: null, shouldSkip: true }; // 在屏但无匹配选项 → 跳过
  }

  const lowestOption = options.reduce((lowest, node) => (!lowest || node.center[1] > lowest.center[1] ? node : lowest), null);
  const direction = (firstPending.centerY < 0 && (!lowestOption || lowestOption.center[1] < 0)) ? 'up' : 'down';
  return { target: null, scrollDirection: direction, shouldSkip: false };
}

// ─── 6. tap 效果验证 ───────────────────────────────────────────────────────
/**
 * 验证上一次 tap 是否生效（双信号：树 hash 变化 OR 像素变为选中色）。
 * 返回 { verified, screenshotBuffer, screencapFailed }。
 */
async function verifyTapEffect(pendingTap, currentTreeHash, { dumpTree, screencap, getSize, expectedColor, verifyEnabled }) {
  if (!pendingTap) return { verified: true, screenshotBuffer: null, screencapFailed: false };

  // 信号 1：树 hash 变化（滚动/换页都算响应）
  let treeHash = currentTreeHash;
  if (treeHash === undefined) {
    try { treeHash = (await dumpTree({ fresh: true })).hash; } catch { treeHash = null; }
  }
  let verified = treeHash != null && treeHash !== pendingTap.preHash;
  let screenshotBuffer = null;

  // 信号 2：像素验证（仅当树未变且启用验证时）
  if (!verified && verifyEnabled) {
    try {
      const { buffer } = await screencap();
      screenshotBuffer = buffer;
      const png = decodePng(buffer);
      const centerX = pendingTap.center[0];
      const centerY = pendingTap.center[1];
      const screenSize = await getSize().catch(() => null);
      const fallbackRadius = Math.max(4, Math.round((screenSize?.w ?? 1080) * PIXEL_SAMPLE_RADIUS_PCT));
      const radiusX = pendingTap.bounds ? Math.max(4, Math.round((pendingTap.bounds[2] - pendingTap.bounds[0]) * 0.2)) : fallbackRadius;
      const radiusY = pendingTap.bounds ? Math.max(4, Math.round((pendingTap.bounds[3] - pendingTap.bounds[1]) * 0.2)) : fallbackRadius;

      let hitCount = 0;
      let sampleCount = 0;
      for (const offsetX of [-1, 0, 1]) {
        for (const offsetY of [-1, 0, 1]) {
          const pixel = pixelAt(png, centerX + offsetX * radiusX, centerY + offsetY * radiusY);
          if (!pixel) continue;
          sampleCount++;
          if (expectedColor ? isColorish(pixel, expectedColor) : isBlueish(pixel)) hitCount++;
        }
      }
      verified = sampleCount > 0 && hitCount >= Math.min(5, Math.max(3, Math.ceil(sampleCount * PIXEL_HIT_RATIO)));
    } catch {
      verified = true; // screencap 故障时放行，但计数暴露
      return { verified, screenshotBuffer: null, screencapFailed: true };
    }
  }

  return { verified, screenshotBuffer, screencapFailed: false };
}

// ─── 7. 主循环编排 ─────────────────────────────────────────────────────────
export function createTapEachRow({ adb, dumpTree, getSize, screencap, scroll }) {
  return async function tapEachRow({ rows, tap, stopWhen = null, maxRounds = null, verify = true, verifyColor = null, profile = null, onQuestion = null } = {}) {
    const result = { rounds: 0, taps: 0, verified: 0, unverified: 0, done: false, bottom: false, error: null, skipped: [] };

    // 1. 配置解析
    const { config, error: configError } = await resolveAnswerConfig({ rows, tap, maxRounds, verifyColor, profile });
    if (configError) { result.error = configError; return result; }

    // 状态变量
    const answeredKeys = new Set();
    const skippedKeys = new Set();
    let previousScrollKey = null;
    let noProgressRounds = 0;
    let hangRounds = 0;
    let tapFailCount = 0;
    let pendingTap = null;
    let readyBumps = 0;

    // 验证回调封装
    const finishPendingTap = async (treeHash) => {
      const { verified, screenshotBuffer, screencapFailed } = await verifyTapEffect(pendingTap, treeHash, {
        dumpTree, screencap, getSize, expectedColor: config.expectedColor, verifyEnabled: verify,
      });
      if (!pendingTap) return;
      const tap = pendingTap;
      pendingTap = null;

      if (screencapFailed) result.screencapFailed = (result.screencapFailed ?? 0) + 1;

      if (verified) {
        result.verified++;
        hangRounds = 0;
        if (tap.rowText) answeredKeys.add(tap.rowKey || tap.rowText);
      } else {
        result.unverified++;
        hangRounds++;
      }

      if (onQuestion) {
        try { await onQuestion({ row: tap.rowText, option: tap.optionText, ok: verified, buffer: screenshotBuffer }); } catch { /* 回调失败不阻断 */ }
      }
    };

    // 2. 主循环
    for (let round = 0; round < config.maxRounds + readyBumps; round++) {
      result.rounds = round + 1;

      // 取树
      let flatNodes = [];
      let treeHash = null;
      try {
        const tree = await dumpTree({ fresh: true });
        flatNodes = flattenNodes(tree.nodes);
        treeHash = tree.hash;
      } catch (e) {
        result.error = `dump 失败: ${e?.message ?? e}`;
        result.skipped = [...skippedKeys];
        return result;
      }

      // 延迟验证上一轮 tap
      await finishPendingTap(treeHash);
      if (hangRounds >= HANG_THRESHOLD) {
        result.error = `renderer_unresponsive: 连续${HANG_THRESHOLD}次 tap 后页面无响应，渲染器疑似挂死`;
        result.skipped = [...skippedKeys];
        return result;
      }

      // 构建过滤器与聚类
      const screenSize = await getSize().catch(() => null);
      const { isAreaValid, isVisibleOnScreen } = createNodeFilters(flatNodes, screenSize);
      const clusters = clusterRowNodes(flatNodes, config.rowSelectors, isAreaValid);

      // 就绪门：页面还没加载完时等待，不消耗 maxRounds
      if (clusters.length === 0 && result.taps === 0 && Date.now() < config.readyDeadline) {
        const napMs = Math.min(1000, Math.max(200, Math.round((config.readyDeadline - Date.now()) / 10)));
        await new Promise((resolve) => setTimeout(resolve, napMs));
        readyBumps++;
        result.rounds--;
        continue;
      }

      // 终止判定
      const pendingClusters = clusters.filter((c) => !(c.text && (answeredKeys.has(c.key) || skippedKeys.has(c.key))));
      if (stopWhen) {
        const stopNode = flatNodes.find((n) => matchNode(n, stopWhen) && isVisibleOnScreen(n));
        if (stopNode && pendingClusters.length === 0) {
          result.done = true;
          result.skipped = [...skippedKeys];
          return result;
        }
      }

      // 选目标
      const { target, scrollDirection, shouldSkip } = pickNextAnswerTarget(
        pendingClusters, clusters, flatNodes, config.tapSelectors, isAreaValid, isVisibleOnScreen, screenSize,
      );

      if (shouldSkip) {
        const firstPending = pendingClusters[0];
        if (firstPending) skippedKeys.add(firstPending.key ?? firstPending.text);
        continue;
      }

      if (!target) {
        // 转向滚动
        const scrollKey = `${pendingClusters[0]?.text ?? ''}@${scrollDirection}`;
        if (scrollKey === previousScrollKey && ++noProgressRounds >= NO_PROGRESS_THRESHOLD) {
          result.bottom = true;
          break;
        }
        previousScrollKey = scrollKey;
        try { await scroll(scrollDirection, { max: 1, stopWhenNoChange: true }); } catch { /* 转向失败仅损失一轮 */ }
        continue;
      }

      // 执行 tap
      noProgressRounds = 0;
      previousScrollKey = null;
      try {
        await action.tap(adb, target.option.center);
      } catch (e) {
        tapFailCount++;
        if (tapFailCount >= TAP_FAIL_THRESHOLD) {
          result.error = `连续 tap 失败: ${e?.message ?? e}`;
          result.skipped = [...skippedKeys];
          return result;
        }
        continue;
      }
      tapFailCount = 0;
      result.taps++;

      // settle 等待 + 挂起验证
      await new Promise((resolve) => setTimeout(resolve, config.settleMs));
      pendingTap = {
        preHash: treeHash,
        center: target.option.center,
        bounds: Array.isArray(target.option.bounds) ? target.option.bounds : null,
        rowText: target.cluster.text ?? '',
        rowKey: target.cluster.key ?? target.cluster.text ?? '',
        optionText: String(target.option.text || target.option.contentDesc || ''),
      };
    }

    // 3. 收尾
    if (pendingTap && !result.error) await finishPendingTap();
    if (!result.done && !result.bottom && !result.error) result.exhausted = true;
    result.skipped = [...skippedKeys];
    return result;
  };
}
