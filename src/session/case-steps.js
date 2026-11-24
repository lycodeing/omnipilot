// 步骤类型集合与工具调用映射（从 case.js 抽出）。
//
// 抽出的理由：buildToolCall 是步骤语义到工具调用的唯一映射点，类型集合
// （ENGINE_TYPES / COORD_TYPES 等）与之同属一个单元。case.js 的解析器
// 经 import 消费这些集合；对外 API 由 case.js 重新导出保持不变。

// 步骤命令集（不再兼容旧名 do/ask/assert——用旧名会报错并提示新名）：
//   agent  : ai / aiAct                    自主决策
//   assert : aiAssert                      模型判定
//   query  : aiQuery                       数据/问答；带 name 时提示落库
//   wait   : aiWaitFor                     等画面稳定（+可选条件判定）
//   engine : aiTap / aiInput / aiLongPress / aiKeyboardPress / aiScroll / launch / terminate
//                                          引擎直执行（直接调对应工具，不经 agent 选工具）
//   special: net / sleep                   原样保留
export const AGENT_TYPES = new Set(['ai', 'aiAct']);
export const ASSERT_TYPES = new Set(['aiAssert']);
export const QUERY_TYPES = new Set(['aiQuery']);
export const WAIT_TYPES = new Set(['aiWaitFor']);
export const ENGINE_TYPES = new Set(['aiTap', 'aiInput', 'aiLongPress', 'aiKeyboardPress', 'aiScroll', 'aiTapEach', 'launch', 'terminate', 'uiDump']);
// 坐标步（tap 带 {x,y}）：**默认禁用**，需用例顶层 allowCoords: true 或 CLI --allow-coords。
// 依据 docs/DESIGN.md:978「禁止把坐标写进用例文件」（2026-09-24 裁定）——故这里不是"支持新语法"，
// 而是把这个裁定早设计好的 allowCoords 逃生口（DESIGN.md:449）落地为**显式、可审计**的开关。
// 未开启时坐标步报解析错（此前静默降级成 ai 任务，把 "tap: { x: 405, y: 2115 }" 当自然语言喂给模型，
// 12 条断言因没点到目标而全灭且无任何告警——静默失效是最坏的失败模式）。
// 仅收 tap：swipe 需要两个点而 DSL 无既定双点语法，与其臆造不如让它落进
// "未知步骤命令"报错（写清可用形态），避免又一个"看起来能跑其实静默失效"的入口。
export const COORD_TYPES = new Set(['tap']);
export const SPECIAL_TYPES = new Set(['net', 'sleep']);

export const ALL_TYPES = new Set([
  ...AGENT_TYPES, ...ASSERT_TYPES, ...QUERY_TYPES, ...WAIT_TYPES,
  ...ENGINE_TYPES, ...COORD_TYPES, ...SPECIAL_TYPES,
]);

// 命令名归一化（仅 aiAct → ai）；旧名不再兼容，返回 null 表示非法命令
export function normalizeType(raw) {
  const t = String(raw ?? '').trim();
  if (t === 'aiAct') return 'ai';
  return t;
}

import { coerce } from './case-params.js';

// 引擎直执行步骤 → 工具调用（纯函数，可单测）：{ tool, params } | null
export function buildToolCall(step) {
  const t = step?.type;
  const num = (v) => (v == null || v === '' ? undefined : Number(v));
  // 坐标步（需 allowCoords 已在装载期放行）：直连坐标工具，跳过语义定位
  if (t === 'tap' && Number.isFinite(Number(step.x)) && Number.isFinite(Number(step.y))) {
    return { tool: 'point_tap', params: { x: Number(step.x), y: Number(step.y) } };
  }
  if (t === 'aiTap') return { tool: 'tap', params: { target: step.text } };
  // aiInput 的 clear 必须转发：src/tools/action.js 的 input 工具支持 clear（先清空再输入），
  // 但此前 buildToolCall 不带 clear → 用例里写 "clear: true" 永远不生效。
  if (t === 'aiInput') return { tool: 'input', params: { target: step.text, value: step.value ?? '', ...(step.clear != null ? { clear: coerce('clear', step.clear) } : {}) } };
  if (t === 'aiLongPress') return { tool: 'long_press', params: { target: step.text, ...(num(step.durationMs) != null ? { durationMs: num(step.durationMs) } : {}) } };
  if (t === 'aiKeyboardPress') return { tool: 'key', params: { name: step.keyName || step.text } };
  if (t === 'aiScroll') {
    // maxScrolls 是用例侧历史别名，工具参数名是 max（两个都接受，max 优先）
    const maxVal = num(step.max) ?? num(step.maxScrolls);
    return {
      tool: 'scroll',
      params: {
        direction: step.direction || step.text || 'down',
        ...(num(step.distancePct) != null ? { distancePct: num(step.distancePct) } : {}),
        ...(step.until ? { until: step.until } : {}),
        ...(maxVal != null ? { max: maxVal } : {}),
      },
    };
  }
  if (t === 'aiTapEach') return { tool: 'tap_each_row', params: { ...(step.rows ? { rows: step.rows } : {}), ...(step.tap ? { tap: step.tap } : {}), ...(step.stopWhen ? { stopWhen: step.stopWhen } : {}), ...(step.maxRounds != null && Number.isFinite(Number(step.maxRounds)) ? { maxRounds: Math.max(1, Math.trunc(Number(step.maxRounds))) } : {}), ...(step.verify != null ? { verify: /^(false|no|off)$/i.test(String(step.verify)) ? false : true } : {}), ...(step.verifyColor ? { verifyColor: String(step.verifyColor) } : {}), ...(step.profile ? { profile: String(step.profile) } : {}) } };
  if (t === 'uiDump') return { tool: 'ui_dump', params: { ...(step.path ? { path: step.path } : {}) } };
  if (t === 'launch') return { tool: 'launch', params: { appId: step.appId || step.text } };
  if (t === 'terminate') return { tool: 'terminate', params: { packageName: step.packageName || step.package || step.text } };
  return null;
}
