// 用例装载器（§13.2）：Midscene 命名。
//
// 步骤命令集（不再兼容旧名 do/ask/assert——用旧名会报错并提示新名）：
//   agent  : ai / aiAct                    自主决策
//   assert : aiAssert                      模型判定
//   query  : aiQuery                       数据/问答；带 name 时提示落库
//   wait   : aiWaitFor                     等画面稳定（+可选条件判定）
//   engine : aiTap / aiInput / aiLongPress / aiKeyboardPress / aiScroll / launch / terminate
//                                          引擎直执行（直接调对应工具，不经 agent 选工具）
//   special: net / sleep                   原样保留
//
// 多行参数：`- aiInput: 输入框` 后跟缩进的 `value: xxx` 等行，按参数写入步骤字段。
// ${var} 执行期插值（§7.5）。

import { PARAM_KEYS_BY_TYPE, PARAM_KEYS, coerce, unquote } from './case-params.js';
import {
  AGENT_TYPES, ASSERT_TYPES, QUERY_TYPES, WAIT_TYPES,
  ENGINE_TYPES, COORD_TYPES, SPECIAL_TYPES, ALL_TYPES,
  normalizeType, buildToolCall,
} from './case-steps.js';
import { waitSelectorFromText, resolveLoopPlan } from './case-loop.js';
export { waitSelectorFromText, resolveLoopPlan };
// 转口导出：只保留有外部消费者的（bin/ask.js、src/tools/、test/ 引用
// QUERY_TYPES / ENGINE_TYPES / COORD_TYPES / normalizeType / buildToolCall）。
// AGENT_TYPES / ASSERT_TYPES / WAIT_TYPES / SPECIAL_TYPES 全仓零外部消费者，不再转口。
export {
  QUERY_TYPES, ENGINE_TYPES, COORD_TYPES,
  normalizeType, buildToolCall,
};

// 已废弃的旧名 → 新名（仅用于给出清晰的迁移报错）
const RENAMED = {
  do: 'ai',
  ask: 'aiQuery',
  assert: 'aiAssert',
};

// 类型集合与 buildToolCall 见 case-steps.js。

// 坐标字面量：`{ x: 135, y: 2115 }` / `{x:135,y:2115}` / `135, 2115` / `135 2115`
// 反引号包裹的 JSON 形态也认（`{"x":135,"y":2115}`）。返回 {x,y} 或 null。
export function parseCoords(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  // 显式键名形态（x/y 或缺省 w/h 混写都不认，只要 x 与 y）
  const kx = /["']?x["']?\s*[:：]\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  const ky = /["']?y["']?\s*[:：]\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  if (kx && ky) return { x: Math.round(Number(kx[1])), y: Math.round(Number(ky[1])) };
  // 裸数字对形态（"135, 2115" / "135 2115"）
  const bare = /^\s*\{?\s*(-?\d+(?:\.\d+)?)\s*[,，]?\s+(-?\d+(?:\.\d+)?)\s*\}?\s*$/.exec(s.replace(/["']/g, ''));
  if (bare) return { x: Math.round(Number(bare[1])), y: Math.round(Number(bare[2])) };
  return null;
}

// 参数表与取值转换见 case-params.js（单一事实源模块）。

export class CaseParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CaseParseError';
  }
}



// 判断某行是不是"步骤命令行"（用于续行判断）：返回 { ok, error }
function classifyCommand(name) {
  const t = String(name ?? '').trim();
  if (ALL_TYPES.has(t) || t === 'aiAct') return { ok: true };
  if (RENAMED[t]) {
    return { ok: false, error: `步骤命令 "${t}:" 已废弃，请改用 "${RENAMED[t]}:"（旧名 do/ask/assert 不再兼容）` };
  }
  return { ok: false, error: null };
}

function stripComment(line) {
  // 去掉行尾注释（引号内的 # 不算）
  let out = '';
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD) break;
    out += ch;
  }
  return out;
}

export function parseCaseText(text, { source = 'text', allowCoords = null } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const caseObj = { name: source, source, steps: [], warnings: [] };
  // CLI --allow-coords 覆盖（true=强制放行 / false=强制拒绝 / null=按 YAML 顶层键）
  if (allowCoords === true) caseObj.allowCoords = true;
  let inSteps = false;
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]);
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const trimmed = raw.trim();

    if (!inSteps && /^name\s*[:：]/.test(trimmed)) {
      caseObj.name = unquote(trimmed.replace(/^name\s*[:：]/, ''));
      continue;
    }
    // 顶层 context 键：步骤上下文窗口（正整数=保留最近 N 步原文；all=保留全部；缺省 3）。
    // CLI --context-steps 优先于本值（设计依据 docs/CONTEXT-COMPRESSION-RESEARCH.md）。
    if (!inSteps && /^context\s*[:：]/.test(trimmed)) {
      const v = unquote(trimmed.replace(/^context\s*[:：]/, '')).trim();
      if (/^(all|全部)$/i.test(v)) caseObj.context = 'all';
      else if (Number(v) >= 1) caseObj.context = Number(v);
      else caseObj.warnings.push(`${source}:${i + 1} context 值 "${v}" 无法解析（应为正整数或 all），忽略`);
      continue;
    }
    // 顶层 allowCoords 键：坐标步开关（DESIGN.md:449 的逃生口）。必须先于 steps: 声明。
    // CLI --allow-coords（allowCoords===true）优先，YAML 里的 false 不能把它关掉。
    if (!inSteps && /^allowCoords\s*[:：]/i.test(trimmed)) {
      if (allowCoords === true) continue; // CLI 已强制开启，忽略 YAML 值
      const v = unquote(trimmed.replace(/^allowCoords\s*[:：]/i, '')).trim();
      caseObj.allowCoords = /^(true|yes|on|1)$/i.test(v);
      continue;
    }
    // 顶层 targetPackage：目标 App 显式声明（评审 #4）。--pregrant 此前从步骤 JSON 正则抓
    // 第一个 com.*，断言/URL 文本可能抢先误中——声明后精确授权。
    if (!inSteps && /^targetPackage\s*[:：]/.test(trimmed)) {
      caseObj.targetPackage = unquote(trimmed.replace(/^targetPackage\s*[:：]/, '')).trim();
      continue;
    }
    // 步骤区起始：steps: 或 flow:（外部框架别名，兼容健康自测类用例）
    if (/^(?:steps|flow)\s*[:：]?\s*$/.test(trimmed)) { inSteps = true; continue; }
    if (!inSteps) continue;

    const item = trimmed.match(/^-\s*(.*)$/);
    if (item) {
      const body = item[1];
      const kv = body.match(/^([\w-]+)\s*[:：]\s*(.*)$/);
      if (kv) {
        const cls = classifyCommand(kv[1]);
        if (cls.error) throw new CaseParseError(`${source}:${i + 1} ${cls.error}`);
        if (cls.ok) {
          const type = normalizeType(kv[1]);
          // —— 坐标步（tap/swipe）：默认拒绝，需 allowCoords 显式开启 ——
          if (COORD_TYPES.has(type)) {
            const raw = unquote(kv[2]);
            const pt = parseCoords(raw);
            if (!pt) {
              throw new CaseParseError(
                `${source}:${i + 1} 步骤命令 "${type}:" 只接受坐标（如 { x: 135, y: 2115 }）；` +
                `语义点击请用 "aiTap: <可见文本>"（DESIGN.md 禁止把坐标写进用例，除 allowCoords 逃生口）`,
              );
            }
            if (!caseObj.allowCoords) {
              throw new CaseParseError(
                `${source}:${i + 1} 坐标步骤 "${type}: { x: ${pt.x}, y: ${pt.y} }" 被拒绝：` +
                '把坐标写进用例违反 2026-09-24 裁定（DESIGN.md:978）。' +
                '如确有需要，在用例顶层（steps: 之前）加 "allowCoords: true"，或运行时传 --allow-coords',
              );
            }
            current = { type, x: pt.x, y: pt.y };
            caseObj.steps.push(current);
            continue;
          }
          current = { type };
          if (type === 'sleep') {
            // 兼容毫秒写法（外部框架 sleep: 3000 = 3s）：>100 一律视为毫秒换算，
            // 否则 3000 会被当 3000 秒（静默睡 50 分钟的灾难）
            const rawV = Number(unquote(kv[2])) || 0;
            if (rawV > 100) {
              current.seconds = rawV / 1000;
              caseObj.warnings.push(`${source}:${i + 1} sleep 值 ${rawV} 按毫秒解释为 ${current.seconds}s（外部框架写法）`);
            } else {
              current.seconds = rawV;
            }
          } else if (type === 'net') current.profile = unquote(kv[2]);
          else current.text = unquote(kv[2]);
          caseObj.steps.push(current);
          continue;
        }
        // 已知参数名（如误缩进的 value:）不当作步骤；其余未知 "key: value" 视为任务文本
        // —— 但**未知命令名**必须报错**：
        // 旧行为把 "aiTapp: 点击登录"（拼写错误）整行当自然语言任务喂给 agent，
        // 命令语义静默降级、断言全灭且无任何告警（与坐标形态的历史事故同源）。
        // 命令名是 ASCII 标识符（形如 "name: value"）时，几乎必然是"写了个不受支持/
        // 拼错的步骤命令"，必须响亮报错并给出可用命令表。
        if (/^[A-Za-z][\w-]*$/.test(kv[1])) {
          const isCoordLike = parseCoords(kv[2]) || /^\{.*\}$/.test(String(kv[2]).trim());
          const hint = isCoordLike
            ? `看起来是坐标/对象形态的步骤，但 DSL 只支持坐标 "tap: { x, y }"（且需顶层 allowCoords: true）。`
            : `可用命令见 cases/README.md 步骤命令表（aiTap/aiScroll/aiInput/aiAct/assert/sleep 等）；` +
              `纯文本任务请直接写 "- <描述>"（不带冒号）。`;
          throw new CaseParseError(
            `${source}:${i + 1} 未知步骤命令 "${kv[1]}: ${unquote(kv[2])}"。${hint}`,
          );
        }
      }
      if (body) {
        // 纯文本任务行 "- <文本>" → agent 任务
        current = { type: 'ai', text: unquote(body) };
        caseObj.steps.push(current);
      }
      continue;
    }

    // 缩进续行：参数行（value/direction/…）或文本换行拼接
    if (current && indent > 0 && caseObj.steps.length > 0) {
      const p = trimmed.match(/^([\w-]+)\s*[:：]\s*(.*)$/);
      if (p && PARAM_KEYS.has(p[1])) {
        current[p[1]] = coerce(p[1], p[2]);
        // timeout 仅 aiWaitFor 支持；外部框架常给 ai/aiTap 步挂 timeout（毫秒），
        // 静默忽略会让作者误以为生效——装载期显式 warn（整 run 时长由 --timeout 控制）
        if (p[1] === 'timeout' && !WAIT_TYPES.has(current.type)) {
          caseObj.warnings.push(`${source}:${i + 1} ${current.type} 步骤的 timeout 参数被忽略（仅 aiWaitFor 支持）；单步/整 run 时长由 --timeout 控制`);
        }
        continue;
      }
      if (p && (ALL_TYPES.has(p[1]) || p[1] === 'aiAct')) {
        throw new CaseParseError(`${source}:${i + 1} 步骤命令 "${p[1]}:" 缩进错误（应与同级步骤对齐，前面用 "- ${p[1]}:"）`);
      }
      current.text = (current.text ? current.text + ' ' : '') + trimmed;
    }
  }
  warnUnknownParams(caseObj, source);
  return caseObj;
}

// 每命令消费的参数表（2026-11-10 评审 #12）：全局 PARAM_KEYS 收集保持宽容，但装载期对
// "该命令不认的参数"显式 warn——写错位的参数（aiScroll 挂 value:）此前被静默收下、毫无
// 作用。校准依据：bin/ask.js 与 buildToolCall 的实际消费点 + 全部存量用例（0 误报）。
// 注：batch 是 ai/aiAct 长任务步的续作形态（false=逐个处理 / true=每轮并行处理本屏全部项），
// 与 until/maxRounds 一起构成显式 loop 声明（见 resolveLoopPlan）；
// selector 是 aiWaitFor 的显式等待 selector（评审 #10：散文解析只作未声明时的兜底）。
function warnUnknownParams(caseObj, source) {
  caseObj.steps.forEach((s, i) => {
    const known = PARAM_KEYS_BY_TYPE[s.type];
    if (!known) return;
    for (const k of Object.keys(s)) {
      if (k === 'type' || k === 'text' || k === 'seconds') continue;
      if (!known.includes(k)) {
        caseObj.warnings.push(`${source}: 步骤 ${i + 1}（${s.type}）的参数 "${k}" 不被该命令消费（已忽略），检查是否拼写错位`);
      }
    }
  });
}

// 自然语言任务文本 → 单步 Case（run "<文本>" / do "<文本>"）
export function caseFromText(text, { source = 'inline' } = {}) {
  return { name: text.slice(0, 40), source, steps: [{ type: 'ai', text: String(text) }] };
}



// ${var} 执行期插值：已知变量替换，未知变量原样保留（不抛错，§7.5）
export function interpolate(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(/\$\{\s*([A-Za-z_][\w]*)\s*\}/g, (orig, name) => {
    if (vars && typeof vars.has === 'function' && vars.has(name)) {
      const v = vars.get(name);
      if (v === null || v === undefined) return '';
      // 数组/对象（data_extract 存的 rows）JSON 序列化，避免 "[object Object]"
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return orig;
  });
}

// 注：原 interpolateCase（整例插值）已删除——它无生产消费者（bin/ask.js 在主循环
// 里自行对每个步骤的字符串字段调 interpolate），且只插 PARAM_KEYS 里的键，与生产
// 路径"插所有字符串字段"的行为已分叉。两份实现并存即两份语义，留一份即可。
