// 数据与扩展工具（§7 / §10 末二行 / §19.7）：
//   data_extract（ui / ai / collection 三模式）、data_query、data_store、secret_get、sms_read
// 数据落 ctx.store（§1.3 openDataset），凭据即取即用不落盘。

import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { flattenNodes, findBySelector, findAllBySelector, matchSelector, textResult } from './perception.js';
import { isZeroAreaBounds } from '../device/uitree.js';
import { denied, confirmWrite } from './action.js';
import { repairJson } from './ai.js';
import { compressForContext } from '../image/png.js';

// —— 命名常量（消除魔法数字，语义见各处注释） ——
/** 上下文回显的样本行数上限（sampleForContext / data_extract.sample）。 */
const CONTEXT_SAMPLE_ROWS = 3;
/** data_query 单次返回的行数上限（防止大结果撑爆上下文）。 */
const QUERY_RESULT_ROW_LIMIT = 20;
/** 结构化错误文本的最大长度（超长异常消息截断，避免刷屏）。 */
const ERROR_MESSAGE_MAX_LENGTH = 200;
/** collection 模式默认收集条数上限（params.max 缺省值）。 */
const DEFAULT_COLLECTION_MAX_ITEMS = 20;
/** collection 模式默认滚动轮数上限（params.maxRounds 缺省值）。 */
const DEFAULT_COLLECTION_MAX_ROUNDS = 20;
/** collection 每轮滚动的屏数（一屏一停，靠树 hash 判无变化）。 */
const SCROLL_SCREENS_PER_ROUND = 1;
/** ai 截图压缩目标宽度（像素）：图像 token 随像素数计，降采样省 token。 */
const AI_SCREENSHOT_MAX_WIDTH = 540;
/** ai 截图 JPEG 压缩质量（0-100）。 */
const AI_SCREENSHOT_JPEG_QUALITY = 70;
/** 自动发现认定"重复卡片结构"所需的最少同构容器数。 */
const MIN_REPEATED_CARD_CONTAINERS = 2;

/**
 * 构造写入结果在上下文中的摘要：写入计数 + 总行数 + 前几行样本。
 * @param {object[]} rows 本次涉及的行数据
 * @param {number|null} written store 实际写入条数
 * @returns {{written: number|null, count: number, sample: object[]}}
 */
function sampleForContext(rows, written) {
  return { written, count: rows.length, sample: rows.slice(0, CONTEXT_SAMPLE_ROWS) };
}

// —— ui 模式几何判定原语（零面积特判统一走 isZeroAreaBounds） ——

/**
 * 计算节点 bounds 的矩形面积（宽或高为负时按 0 计）。
 * @param {object} node 含 bounds=[left,top,right,bottom] 的扁平节点
 * @returns {number} 非负面积
 */
function boundsArea(node) {
  return Math.max(0, node.bounds[2] - node.bounds[0]) * Math.max(0, node.bounds[3] - node.bounds[1]);
}

/**
 * 判断 parent 的 bounds 是否几何包含 child 的 bounds。
 * WebView 零面积节点不参与几何包含判断（bounds=[0,0,0,0] 会被任何 [0,0] 容器「包含」，
 * 且 area=0 排序时反而被优选为最小祖先 → 误聚组），任一方零面积直接判不包含。
 * @param {object} parentNode 候选父容器节点
 * @param {object} childNode 候选子节点
 * @returns {boolean} 是否包含
 */
function boundsContains(parentNode, childNode) {
  if (isZeroAreaBounds(parentNode) || isZeroAreaBounds(childNode)) return false;
  return Array.isArray(parentNode.bounds) && Array.isArray(childNode.bounds)
    && parentNode.bounds[0] <= childNode.bounds[0] && parentNode.bounds[1] <= childNode.bounds[1]
    && parentNode.bounds[2] >= childNode.bounds[2] && parentNode.bounds[3] >= childNode.bounds[3];
}

/**
 * 判断两个节点的 bounds 是否重叠（边界相接不算重叠）。
 * 零面积节点不参与重叠判断（理由同 boundsContains）。
 * @param {object} firstNode 节点一
 * @param {object} secondNode 节点二
 * @returns {boolean} 是否重叠
 */
function boundsOverlap(firstNode, secondNode) {
  if (isZeroAreaBounds(firstNode) || isZeroAreaBounds(secondNode)) return false;
  return !(firstNode.bounds[2] <= secondNode.bounds[0] || secondNode.bounds[2] <= firstNode.bounds[0]
    || firstNode.bounds[3] <= secondNode.bounds[1] || secondNode.bounds[3] <= firstNode.bounds[1]);
}

/**
 * 在扁平节点表中找 target 的最小包含祖先：面积最小的那个包含节点（排除自身）。
 * 不依赖 parent 引用——某些 device 的 makeNode 不挂 parent，只能靠 bounds 反推。
 * @param {object[]} flatNodes 扁平节点表
 * @param {object} targetNode 目标节点
 * @returns {object|undefined} 最小包含祖先；不存在时为 undefined
 */
function findSmallestContainingAncestor(flatNodes, targetNode) {
  return flatNodes.filter((candidate) => candidate !== targetNode && boundsContains(candidate, targetNode))
    .sort((first, second) => boundsArea(first) - boundsArea(second))[0];
}

/**
 * 判断容器节点内部是否命中任一字段 selector（用于确认"重复卡片"确实承载字段内容）。
 * 无 selector 的字段（如 from:'index' 位置字段）不参与判定，避免 undefined selector。
 * @param {object[]} flatNodes 扁平节点表
 * @param {object} containerNode 候选容器节点
 * @param {object[]} fields 字段定义列表
 * @returns {boolean} 容器内是否存在字段命中节点
 */
function containerHasFieldHit(flatNodes, containerNode, fields) {
  for (const field of fields) {
    if (!field.selector) continue;
    if (flatNodes.some((node) => node !== containerNode && boundsContains(containerNode, node)
      && matchSelector(node, field.selector))) return true;
  }
  return false;
}

/**
 * 把字段命中节点按"最小包含祖先的 cls+resourceId"聚成同构容器组。
 * @param {object[]} flatNodes 扁平节点表
 * @param {object[]} fields 字段定义列表
 * @returns {Map<string, Set<object>>} key 为 `cls::resourceId`，value 为该组的祖先容器集合
 */
function groupContainersByStructure(flatNodes, fields) {
  const groups = new Map();
  for (const field of fields) {
    if (!field.selector) continue;
    for (const node of flatNodes) {
      if (!matchSelector(node, field.selector)) continue;
      const ancestor = findSmallestContainingAncestor(flatNodes, node);
      if (!ancestor || !ancestor.cls) continue;
      const groupKey = `${ancestor.cls}::${ancestor.resourceId ?? ''}`;
      if (!groups.has(groupKey)) groups.set(groupKey, new Set());
      groups.get(groupKey).add(ancestor);
    }
  }
  return groups;
}

/**
 * 剔除同组内 bounds 互相重叠的候选容器，重叠对中保留面积较小者。
 * 评审 Minor 1：嵌套父子容器会被聚到同组、误当成"重复卡片"撑出多行；
 * 两两判重叠后只留最小卡片再判数量阈值。
 * @param {object[]} candidates 同组候选容器
 * @returns {object[]} 去重叠后保留的容器（保持原相对顺序）
 */
function removeOverlappingContainers(candidates) {
  const removed = new Set();
  for (let firstIndex = 0; firstIndex < candidates.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex++) {
      const firstNode = candidates[firstIndex];
      const secondNode = candidates[secondIndex];
      if (boundsOverlap(firstNode, secondNode)) {
        removed.add(boundsArea(firstNode) >= boundsArea(secondNode) ? firstNode : secondNode);
      }
    }
  }
  return candidates.filter((node) => !removed.has(node));
}

/**
 * 自动发现"重复结构"容器（无 container 参数时的卡片列表识别）：
 * 按字段 selector 找命中节点，对每个命中节点用 bounds 包含关系向上找最小祖先，
 * 把同 cls+resourceId 的兄弟聚成组；某组去重叠后 ≥MIN_REPEATED_CARD_CONTAINERS 个
 * 且各自含字段命中，即认定为卡片列表，返回这组兄弟作为 scopes。
 * 无重复结构时返回空数组（调用方回退整屏 1 行）。
 * @param {object[]} flatNodes 扁平节点表
 * @param {object[]} fields 字段定义列表
 * @returns {object[]} 发现的容器 scope 列表；未发现时为空数组
 */
function discoverCardContainers(flatNodes, fields) {
  const groups = groupContainersByStructure(flatNodes, fields);
  for (const containerSet of groups.values()) {
    const kept = removeOverlappingContainers([...containerSet]);
    // 剩余 ≥2 且各自含字段命中才认作重复卡片结构
    if (kept.length >= MIN_REPEATED_CARD_CONTAINERS
      && kept.every((container) => containerHasFieldHit(flatNodes, container, fields))) {
      return kept;
    }
  }
  return [];
}

/**
 * 解析显式 container 参数为 scope 列表。
 * 容器可出现多次（列表卡片）：按 selector 找全部匹配节点，每个容器为一个 scope。
 * 统一走 selector 匹配器：自造 class= 相等比较会让其它选择器方言（text=、
 * resourceId=、re:）静默失配，'#index=' 语义也被忽略。
 * @param {object[]} flatNodes 扁平节点表
 * @param {string|undefined} containerSelector 容器 selector；未传时返回空数组
 * @returns {object[]} 匹配到的容器节点列表
 */
function resolveContainerScopes(flatNodes, containerSelector) {
  if (!containerSelector) return [];
  if (containerSelector.startsWith('index=')) {
    const node = findBySelector(flatNodes, containerSelector);
    return node ? [node] : [];
  }
  return findAllBySelector(flatNodes, containerSelector);
}

/**
 * 过滤出落在 scope 容器内的节点（bounds 几何包含）。
 * WebView 零面积 container 无法做几何包含 → 退化为全文档提取（避免只拿到 [0,0,0,0] 节点）。
 * 零面积子节点在正常 container 内也放行（几何未知，由文本匹配保证归属）。
 * @param {object[]} flatNodes 扁平节点表
 * @param {object|null} scope 容器节点；null 表示整屏（不过滤）
 * @returns {object[]} scope 内节点列表（不含 scope 自身）
 */
function filterNodesInScope(flatNodes, scope) {
  if (!(scope && Array.isArray(scope.bounds) && !isZeroAreaBounds(scope))) return flatNodes;
  return flatNodes.filter((node) => node !== scope && Array.isArray(node.bounds)
    && (isZeroAreaBounds(node) || (
      node.bounds[0] >= scope.bounds[0] && node.bounds[1] >= scope.bounds[1]
      && node.bounds[2] <= scope.bounds[2] && node.bounds[3] <= scope.bounds[3])));
}

/**
 * 从单个字段定义提取值：按 selector 找节点，再按 from（text|attr|index，默认 text）取值。
 * 未命中节点时值为 null。
 * @param {object[]} innerNodes scope 内节点列表
 * @param {object} field 字段定义 {name, from?, selector, attr?}
 * @returns {*} 字段值（字符串 / 序号 / null）
 */
function extractFieldValue(innerNodes, field) {
  const node = findBySelector(innerNodes, field.selector);
  if (!node) return null;
  if (field.from === 'text') return node.text;
  if (field.from === 'attr') return node[field.attr || 'contentDesc'] ?? null;
  if (field.from === 'index') return innerNodes.indexOf(node);
  return node.text;
}

/**
 * 对一组 scope 内节点按字段定义提取一行数据。
 * @param {object[]} innerNodes scope 内节点列表
 * @param {object[]} fields 字段定义列表
 * @returns {object} 以字段 name 为键的行对象
 */
function extractFieldsFromNodes(innerNodes, fields) {
  const row = {};
  for (const field of fields) {
    row[field.name] = extractFieldValue(innerNodes, field);
  }
  return row;
}

/**
 * ui 模式主编排：dump UI 树 → 解析/发现容器 scopes → 逐 scope 过滤节点并提取字段行。
 * 确定性提取，零模型调用。
 * 评审 I1：显式传了 container 但 selector 失配（scopes 仍空）时不得自动发现——
 * 否则会把本应"整屏 1 行"的回退改成多行，改变存量用例行为。
 * @param {object} device 设备层（提供 dumpTree）
 * @param {object} params data_extract 参数（fields / container）
 * @returns {Promise<{rows: object[], hash: string}>} 提取行与树 hash
 */
async function extractUi(device, params) {
  const tree = await device.dumpTree({});
  const flatNodes = flattenNodes(tree.nodes);
  const fields = params.fields || [];

  let scopes = resolveContainerScopes(flatNodes, params.container);
  if (!params.container && !scopes.length && fields.length) {
    scopes = discoverCardContainers(flatNodes, fields);
  }

  const rows = [];
  const scopeList = scopes.length ? scopes : [null];
  for (const scope of scopeList) {
    const innerNodes = filterNodesInScope(flatNodes, scope);
    rows.push(extractFieldsFromNodes(innerNodes, fields));
  }
  return { rows, hash: tree.hash };
}

// —— collection 模式：边滚边抽、按主键去重（§7.1 / §7.3） ——

/**
 * 计算一行的去重键：有主键字段时取该字段值（缺失回退整行 JSON），否则整行 JSON。
 * @param {object} row 行数据
 * @param {string|undefined} keyField 去重主键字段名
 * @returns {string} 去重键
 */
function rowDeduplicationKey(row, keyField) {
  return keyField ? String(row[keyField] ?? JSON.stringify(row)) : JSON.stringify(row);
}

/**
 * 把一轮提取的行并入已见集合（按去重键先到先得），达到条数上限即停止并入。
 * @param {Map<string, object>} seenRows 去重键 → 行 的已见集合（原地更新）
 * @param {object[]} rows 本轮提取的行
 * @param {string|undefined} keyField 去重主键字段名
 * @param {number} maxItems 收集条数上限
 */
function deduplicateRows(seenRows, rows, keyField, maxItems) {
  for (const row of rows) {
    const dedupKey = rowDeduplicationKey(row, keyField);
    if (!seenRows.has(dedupKey)) seenRows.set(dedupKey, row);
    if (seenRows.size >= maxItems) break;
  }
}

/**
 * 执行一轮提取：ai+query 走小模型截图提取，否则走 ui 确定性提取。
 * @param {object} ctx 工具上下文（device / chat）
 * @param {object} params data_extract 参数（mode / query / fields / container）
 * @returns {Promise<object[]>} 本轮提取的行（非数组结果归一为空数组）
 */
async function extractOneRound(ctx, params) {
  if (params.mode === 'ai' && params.query) {
    const result = await extractAiOnce(ctx, params.query);
    return Array.isArray(result) ? result : [];
  }
  return (await extractUi(ctx.device, { fields: params.fields, container: params.container })).rows;
}

/**
 * collection 模式主编排：循环"提取一轮 → 去重并入 → 滚动一屏"，
 * 直到条数够、轮数尽或页面无变化（树 hash 判定）。
 * 两个上限语义不同，不能混用一个参数：
 *   max      —— 收集**条数**上限（真正截断已收集行数）
 *   maxRounds—— 滚动**轮数**上限（防止无限滚动）
 * 原实现把 max 当轮数用，写 "max: 50" 期望"最多收 50 条"，实际是"最多滚 50 屏"
 * ——可能收 500 条，也可能因页面早早到底而只收几条。
 * @param {object} ctx 工具上下文（device / chat）
 * @param {object} params data_extract 参数（fields / container / key / max / maxRounds / mode / query）
 * @returns {Promise<object[]>} 去重后的行（截断到条数上限）
 */
async function extractCollection(ctx, params) {
  const seenRows = new Map();
  const maxItems = Math.max(1, params.max ?? DEFAULT_COLLECTION_MAX_ITEMS);
  const maxRounds = Math.max(1, params.maxRounds ?? DEFAULT_COLLECTION_MAX_ROUNDS);

  for (let round = 0; round < maxRounds; round++) {
    const rows = await extractOneRound(ctx, params);
    deduplicateRows(seenRows, rows, params.key, maxItems);
    if (seenRows.size >= maxItems) break;   // 条数已够，不必再滚
    // 滚动一屏看后续内容（direction 内容语义：down=前进）；无变化即停（树 hash 判定）
    const scrollResult = await ctx.device.scroll('down', { max: SCROLL_SCREENS_PER_ROUND, stopWhenNoChange: true });
    if (!scrollResult.changed) break;
  }
  return [...seenRows.values()].slice(0, maxItems);
}

// —— ai 模式：截图 + 小模型抽 JSON（§7.1） ——

/**
 * 截图编码为模型可用的图像载荷：先经 compressForContext 降采样+JPEG
 * （1080×2400 PNG ~427KB → 540×1200 q70 ~64KB）：图像 token 随像素数计，
 * 原图直发每次 ai 提取多花约 3 倍图像 token；collection 每轮滚动都重发，放大更甚。
 * 压缩失败（如非标准 PNG）降级发原图，保证 ai 提取不因编码问题整体失败。
 * @param {Buffer} screenshotBuffer 原始截图 PNG buffer
 * @returns {Promise<{data: string, mimeType: string}>} base64 图像载荷
 */
async function encodeScreenshotForModel(screenshotBuffer) {
  try {
    const compressed = await compressForContext(screenshotBuffer, {
      maxWidth: AI_SCREENSHOT_MAX_WIDTH,
      quality: AI_SCREENSHOT_JPEG_QUALITY,
    });
    return { data: compressed.buffer.toString('base64'), mimeType: compressed.mimeType };
  } catch {
    return { data: screenshotBuffer.toString('base64'), mimeType: 'image/png' };
  }
}

/**
 * ai 模式单轮提取：截图 → 压缩 → 小模型抽 JSON（repairJson 容错）。
 * 未注入 chat 或过程抛错时返回 {error} 结构化失败，不向上抛。
 * @param {object} ctx 工具上下文（device / chat）
 * @param {string} query 提取要求（自然语言）
 * @returns {Promise<object|object[]|{error: string}>} 提取结果或结构化错误
 */
async function extractAiOnce(ctx, query) {
  const chat = ctx.chat;
  if (!chat) return { error: 'ai 模式需要模型配置（ASK_MODEL_*）或注入 ctx.chat' };
  try {
    const screenshot = await ctx.device.screencap();
    const image = await encodeScreenshotForModel(screenshot.buffer);
    const text = await chat(
      `从截图提取结构化数据。要求：${query}\n只输出 JSON。`,
      { images: [image] },
    );
    return repairJson(text);
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/**
 * 把异常转为截断后的错误文本（结构化失败响应用）。
 * @param {unknown} error 捕获的异常
 * @returns {string} 最长 ERROR_MESSAGE_MAX_LENGTH 字符的错误描述
 */
function errorMessageText(error) {
  return String(error?.message ?? error).slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

/**
 * 登记数据集写入计数留痕（Manus"结果留进上下文"教训）：整体描述（buildStepDigest）
 * 引用此表，让窗口折叠后远处的书断言仍能看到"数据集 X=N 条"的证据。
 * 口径 = 回读数据集现状（append 去重/upsert 合并后的真实行数），不是本次抽取数；
 * 无 store 时按传入行数记。
 * @param {object} ctx 工具上下文（datasetWrites / store）
 * @param {string} datasetName 数据集名
 * @param {number} fallbackCount 无 store 时的回退计数
 */
async function recordDatasetWriteCount(ctx, datasetName, fallbackCount) {
  ctx.datasetWrites = ctx.datasetWrites ?? new Map();
  const currentCount = ctx.store ? (await ctx.store.read(datasetName)).length : fallbackCount;
  ctx.datasetWrites.set(datasetName, currentCount);
}

export function buildDataTools(ctx) {
  const { device, store, recorder, opts } = ctx;

  const dataExtract = defineTool({
    name: 'data_extract',
    label: 'data_extract',
    description: '页面数据提取。mode=ui：从 UI 树确定性提取（推荐，零模型调用）；mode=ai：小模型从截图提取；mode=collection：边滚边抽按主键去重。结果写入变量表供 ${var} 引用。',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: '数据集名；缺省不落库' })),
      mode: Type.String({ description: 'ui|ai|collection' }),
      fields: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        from: Type.Optional(Type.String({ description: 'text|attr|index，默认text' })),
        selector: Type.String(),
        attr: Type.Optional(Type.String({ description: 'from=attr 的属性名' })),
      }), { description: 'ui 字段定义' })),
      container: Type.Optional(Type.String({ description: '容器 selector（列表卡片 class）' })),
      query: Type.Optional(Type.String({ description: 'ai 提取要求' })),
      key: Type.Optional(Type.String({ description: 'collection 去重主键' })),
      max: Type.Optional(Type.Number({ description: 'collection 最多收集条数，默认20' })),
      maxRounds: Type.Optional(Type.Number({ description: 'collection 最多滚动轮数，默认20' })),
    }),
    execute: async (_id, params) => {
      let rows = [];
      if (params.mode === 'ui') {
        rows = (await extractUi(device, params)).rows;
      } else if (params.mode === 'ai') {
        if (!params.query) return textResult({ ok: false, error: 'ai 模式需要 query 参数' });
        const result = await extractAiOnce(ctx, params.query);
        if (result && result.error) return textResult({ ok: false, error: result.error });
        rows = Array.isArray(result) ? result : [result];
      } else if (params.mode === 'collection') {
        // collection 模式会滚动设备（写操作：改变屏幕状态），须走确认闸
        const gate = await confirmWrite(ctx, 'data_extract', `collection 模式将滚动设备采集数据${params.name ? ` 到数据集 ${params.name}` : ''}`);
        if (!gate.allowed) return denied('data_extract');
        rows = await extractCollection(ctx, params);
      } else {
        return textResult({ ok: false, error: `未知模式 ${params.mode}` });
      }

      let written = null;
      if (params.name && store) {
        written = await store.append(params.name, rows, { run: recorder?.runId ?? null, step: ctx.currentStepIndex ?? null });
      }
      // 写入运行时变量表（§7.5）：data_extract 写入，后续步骤 ${var} 引用
      if (params.name) {
        ctx.vars.set(params.name, rows);
        await recordDatasetWriteCount(ctx, params.name, rows.length);
      }
      const lastRow = rows[rows.length - 1];
      return textResult({
        ok: true,
        mode: params.mode,
        count: rows.length,
        dataset: params.name || null,
        written: written ? written.written : null,
        sample: rows.slice(0, CONTEXT_SAMPLE_ROWS),
        lastRowVars: lastRow
          ? Object.fromEntries(Object.entries(lastRow).map(([fieldName, fieldValue]) => [`${params.name}.${fieldName}`, fieldValue]))
          : {},
      });
    },
  });

  const dataQuery = defineTool({
    name: 'data_query',
    label: 'data_query',
    description: '查询已存数据集（where 支持 field>lit / field=lit / field!=lit 与 &&，orderBy 字段前加 - 表示倒序）。',
    parameters: Type.Object({
      name: Type.String(),
      where: Type.Optional(Type.String()),
      select: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Number()),
      orderBy: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      if (!store) return textResult({ ok: false, error: 'store 未注入' });
      // 同 data_store：store.query 会抛（非法 where/orderBy/数据集名），必须转结构化
      // 失败，否则无 recorder 的 ask 路径会以未捕获异常中断
      try {
        const rows = await store.query(params.name, {
          where: params.where || undefined,
          select: params.select,
          limit: params.limit,
          orderBy: params.orderBy || undefined,
        });
        return textResult({ ok: true, name: params.name, count: rows.length, rows: rows.slice(0, QUERY_RESULT_ROW_LIMIT) });
      } catch (error) {
        return textResult({ ok: false, error: `数据集查询失败: ${errorMessageText(error)}` });
      }
    },
  });

  const dataStore = defineTool({
    name: 'data_store',
    label: 'data_store',
    description: '把行数据写入数据集（append 追加 / clear 清空 / upsert 按主键去重）。',
    parameters: Type.Object({
      name: Type.String(),
      action: Type.Optional(Type.String({ description: 'append（默认）| upsert | clear' })),
      rows: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { description: '要写入的行' })),
      key: Type.Optional(Type.String({ description: 'upsert 主键字段' })),
    }),
    execute: async (_id, params) => {
      if (!store) return textResult({ ok: false, error: 'store 未注入' });
      const action = params.action || 'append';
      // store 层会抛（非法数据集名、非法 where/orderBy、缺主键字段）。必须就地转成
      // 结构化失败：withRecording 的兜底 try/catch **只在有 recorder 时生效**，而
      // bin/ask.js 的 ask 直答路径恰恰是 recorder: null —— 异常会逃出工具层、
      // 以未捕获异常中断整条问答链路，模型也拿不到可自纠的错误文本。
      try {
        if (action === 'clear') {
          await store.clear(params.name);
          // clear 也要更新留痕：否则整体描述继续宣称旧计数（"以此为准"口径下的陈旧权威证据）
          ctx.datasetWrites = ctx.datasetWrites ?? new Map();
          ctx.datasetWrites.set(params.name, 0);
          return textResult({ ok: true, action, name: params.name });
        }
        const rows = params.rows || [];
        let writeResult;
        if (action === 'upsert') {
          if (!params.key) return textResult({ ok: false, error: 'upsert 需要 key 主键字段' });
          writeResult = await store.upsert(params.name, params.key, rows, { run: recorder?.runId ?? null, step: ctx.currentStepIndex ?? null });
        } else {
          writeResult = await store.append(params.name, rows, { run: recorder?.runId ?? null, step: ctx.currentStepIndex ?? null });
        }
        // 数据集写入计数留痕（供整体描述引用，见 recordDatasetWriteCount 注释）；
        // 口径 = 回读数据集现状（upsert 全量合并时 written=0，按 written 记会"回退"成 0 条）
        await recordDatasetWriteCount(ctx, params.name, rows.length);
        return textResult({ ok: true, action, name: params.name, ...sampleForContext(rows, writeResult.written) });
      } catch (error) {
        return textResult({ ok: false, error: `数据集写入失败: ${errorMessageText(error)}` });
      }
    },
  });

  // —— secret_get（§19.7）：provider+key → 返回值仅入上下文；ctx.secretCalls 记账 ——
  const secretGet = defineTool({
    name: 'secret_get',
    label: 'secret_get',
    description: '获取登录凭据（密码等）。值只在上下文中使用，绝不写入用例/数据集/日志。',
    parameters: Type.Object({
      provider: Type.String({ description: '凭据提供方标识' }),
      key: Type.String({ description: '凭据键名' }),
    }),
    execute: async (_id, params) => {
      ctx.secretCalls.push({ tool: 'secret_get', provider: params.provider, key: params.key, stepIndex: ctx.currentStepIndex ?? null });
      // 凭据读取与 sms_read 同属 §19.7 敏感操作，同样走确认闸，保持两类敏感操作待遇一致。
      const gate = await confirmWrite(ctx, 'secret_get', `读取凭据 ${params.provider}/${params.key}`, { kind: 'sensitive' });
      if (!gate.allowed) return denied('secret_get');
      // 来源 1：工作区私有状态目录下的 secrets.json（用户自管，不入库不入 git）；
      // 未注入 stateDir 时回退 cwd/.ask（保持既有行为）
      const secretsDir = ctx.stateDir || path.resolve('.ask');
      const localPath = path.join(secretsDir, 'secrets.json');
      try {
        const secretsJson = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        const secretValue = secretsJson?.[params.provider]?.[params.key];
        if (typeof secretValue === 'string' && secretValue.length > 0) {
          // 值仅入上下文；登记给 recorder 做全文兜底脱敏（§19.7），绝不落 run.json 明文
          const secretCallRecord = ctx.secretCalls[ctx.secretCalls.length - 1];
          if (secretCallRecord) secretCallRecord.value = secretValue;
          try { recorder?.registerSecret?.({ provider: params.provider, key: params.key, value: secretValue }); } catch { /* ignore */ }
          return textResult({ ok: true, provider: params.provider, key: params.key, value: secretValue, source: 'local' });
        }
      } catch { /* 文件不存在则走失败 */ }
      return textResult({
        ok: false,
        code: 'SECRET_UNAVAILABLE',
        provider: params.provider,
        key: params.key,
        error: `凭据不可用：${localPath} 缺少该条目（也可通过 MCP secret 服务提供）`,
      });
    },
  });

  // —— sms_read（§19.7）：读本机短信/通知验证码，敏感操作需 --yes 或确认 ——
  const smsRead = defineTool({
    name: 'sms_read',
    label: 'sms_read',
    description: '读取本机短信/通知栏验证码（敏感操作）。返回值仅入上下文。',
    parameters: Type.Object({
      sender: Type.Optional(Type.String({ description: '按发送方过滤' })),
      contains: Type.Optional(Type.String({ description: '按内容关键字过滤' })),
    }),
    execute: async (_id, params) => {
      ctx.secretCalls.push({ tool: 'sms_read', provider: 'device', key: 'sms', stepIndex: ctx.currentStepIndex ?? null });
      // 走 confirmWrite（与所有写操作同一套语义）：--yes 直通、ctx.confirm 征求
      // 同意、两者都无时告警一次后放行，保证非交互场景也不静默丢掉这道安全门。
      const gate = await confirmWrite(ctx, 'sms_read', '读取设备短信/通知', { kind: 'sensitive' });
      if (!gate.allowed) return denied('sms_read'); // details.denied=true，记账标 cancelled（与操作工具一致）
      // 设备层若提供扩展能力（content://sms / notification listener）则使用
      if (typeof device.readSms === 'function') {
        const smsResult = await device.readSms(params);
        return textResult({ ok: true, ...smsResult, redact: true });
      }
      if (typeof device.readNotifications === 'function') {
        const notificationResult = await device.readNotifications(params);
        return textResult({ ok: true, ...notificationResult, redact: true });
      }
      return textResult({
        ok: false,
        code: 'SECRET_UNAVAILABLE',
        error: '当前设备层未提供短信/通知读取能力（src/device 未实现 readSms/readNotifications）',
      });
    },
  });

  // —— test_account（§19.7）：非密级测试账号（手机号等），来自 ASK_TEST_ACCOUNTS ——
  // 手机号非密级（DESIGN §19.7 明确"非密级可配置"）：不走确认闸、不进 secretCalls、
  // 不脱敏。密钥类凭据一律走 secret_get。
  const testAccount = defineTool({
    name: 'test_account',
    label: 'test_account',
    description: '读取非密级测试账号（手机号等），来自环境变量 ASK_TEST_ACCOUNTS（JSON）。密钥类一律走 secret_get。',
    parameters: Type.Object({ key: Type.Optional(Type.String({ description: '账号组名（缺省返回全部）' })) }),
    execute: async (_id, params) => {
      const rawAccountsJson = process.env.ASK_TEST_ACCOUNTS;
      if (!rawAccountsJson) return textResult({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: '未配置 ASK_TEST_ACCOUNTS 环境变量' });
      let accounts;
      try { accounts = JSON.parse(rawAccountsJson); } catch { return textResult({ ok: false, error: 'ASK_TEST_ACCOUNTS 不是合法 JSON' }); }
      if (params.key) {
        const accountGroup = accounts?.[params.key];
        if (accountGroup == null) return textResult({ ok: false, error: `账号组 ${params.key} 不存在` });
        return textResult({ ok: true, accounts: accountGroup });
      }
      return textResult({ ok: true, accounts });
    },
  });

  return [dataExtract, dataQuery, dataStore, secretGet, smsRead, testAccount];
}