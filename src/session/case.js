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

// 已废弃的旧名 → 新名（仅用于给出清晰的迁移报错）
const RENAMED = {
  do: 'ai',
  ask: 'aiQuery',
  assert: 'aiAssert',
};

export const AGENT_TYPES = new Set(['ai', 'aiAct']);
export const ASSERT_TYPES = new Set(['aiAssert']);
export const QUERY_TYPES = new Set(['aiQuery']);
export const WAIT_TYPES = new Set(['aiWaitFor']);
export const ENGINE_TYPES = new Set(['aiTap', 'aiInput', 'aiLongPress', 'aiKeyboardPress', 'aiScroll', 'aiTapEach', 'launch', 'terminate', 'uiDump']);
export const SPECIAL_TYPES = new Set(['net', 'sleep']);

const ALL_TYPES = new Set([...AGENT_TYPES, ...ASSERT_TYPES, ...QUERY_TYPES, ...WAIT_TYPES, ...ENGINE_TYPES, ...SPECIAL_TYPES]);

// 步骤字段收哪些"参数行"（缩进续行）；不在表内且非命令名的续行仍按旧行为拼进 text
const PARAM_KEYS = new Set([
  'value', 'direction', 'distancePct', 'until', 'keyName', 'name', 'timeout',
  'max', 'maxScrolls', 'durationMs', 'appId', 'package', 'packageName', 'mode', 'path', 'quiet',
  'rows', 'tap', 'stopWhen', 'maxRounds', 'verify', 'verifyColor',
]);
const NUMBER_KEYS = new Set(['seconds', 'max', 'timeout', 'maxScrolls', 'durationMs', 'distancePct']);

export class CaseParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CaseParseError';
  }
}

// 命令名归一化（仅 aiAct → ai）；旧名不再兼容，返回 null 表示非法命令
export function normalizeType(raw) {
  const t = String(raw ?? '').trim();
  if (t === 'aiAct') return 'ai';
  return t;
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

function unquote(v) {
  const t = String(v ?? '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function coerce(key, val) {
  const v = unquote(val);
  if (NUMBER_KEYS.has(key)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

export function parseCaseText(text, { source = 'text' } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const caseObj = { name: source, source, steps: [], warnings: [] };
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
  return caseObj;
}

// 自然语言任务文本 → 单步 Case（run "<文本>" / do "<文本>"）
export function caseFromText(text, { source = 'inline' } = {}) {
  return { name: text.slice(0, 40), source, steps: [{ type: 'ai', text: String(text) }] };
}

// 统一装载入口：文件路径内容 / 纯文本
export function loadCase(text, { asFile = true, source } = {}) {
  if (!asFile) return caseFromText(text, { source });
  return parseCaseText(text, { source });
}

// 引擎直执行步骤 → 工具调用（纯函数，可单测）：{ tool, params } | null
export function buildToolCall(step) {
  const t = step?.type;
  const num = (v) => (v == null || v === '' ? undefined : Number(v));
  if (t === 'aiTap') return { tool: 'tap', params: { target: step.text } };
  if (t === 'aiInput') return { tool: 'input', params: { target: step.text, value: step.value ?? '' } };
  if (t === 'aiLongPress') return { tool: 'long_press', params: { target: step.text, ...(num(step.durationMs) != null ? { durationMs: num(step.durationMs) } : {}) } };
  if (t === 'aiKeyboardPress') return { tool: 'key', params: { name: step.keyName || step.text } };
  if (t === 'aiScroll') {
    return {
      tool: 'scroll',
      params: {
        direction: step.direction || step.text || 'down',
        ...(num(step.distancePct) != null ? { distancePct: num(step.distancePct) } : {}),
        ...(step.until ? { until: step.until } : {}),
        ...(num(step.max) != null ? { max: num(step.max) } : {}),
      },
    };
  }
  if (t === 'aiTapEach') return { tool: 'tap_each_row', params: { rows: step.rows ?? '', tap: step.tap ?? '', ...(step.stopWhen ? { stopWhen: step.stopWhen } : {}), ...(step.maxRounds != null ? { maxRounds: Number(step.maxRounds) } : {}), ...(step.verify != null ? { verify: /^(false|no|off)$/i.test(String(step.verify)) ? false : true } : {}), ...(step.verifyColor ? { verifyColor: String(step.verifyColor) } : {}) } };
  if (t === 'uiDump') return { tool: 'ui_dump', params: { ...(step.path ? { path: step.path } : {}) } };
  if (t === 'launch') return { tool: 'launch', params: { appId: step.appId || step.text } };
  if (t === 'terminate') return { tool: 'terminate', params: { packageName: step.packageName || step.package || step.text } };
  return null;
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

// 遍历用例中需要插值的字段（text + 参数值）
export function interpolateCase(caseObj, vars) {
  return {
    ...caseObj,
    steps: caseObj.steps.map((s) => {
      const out = { ...s };
      if (typeof out.text === 'string') out.text = interpolate(out.text, vars);
      for (const k of PARAM_KEYS) {
        if (typeof out[k] === 'string') out[k] = interpolate(out[k], vars);
      }
      return out;
    }),
  };
}

// 从"等待"文本里解析出可定位的元素 selector（§21）：
//   '热榜列表第一项出现' → 无明确文本 → null（退回等树稳定）
//   '等「加载完毕」出现' → text=加载完毕
//   '等 text=提交 出现' → text=提交（显式 selector 原样用）
// 返回 selector 字符串或 null（null = 无法解析，调用方退回 waitIdle）。
export function waitSelectorFromText(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // 已是显式 selector（text=/text*=/resourceId=/class=）
  const explicit = /(?:^|\s)((?:text|resourceId|resource-id|id|class|type|desc|re)=[^\s，。]+)/.exec(t);
  if (explicit) return explicit[1];
  // 引号里的文本：「xxx」/'xxx'/“xxx”/直引号 'xxx'（外部框架常用直引号）
  const quoted = /[「“"']([^」”"']{1,40})[」”"']/.exec(t);
  if (quoted) return quoted[1]; // 裸文本（device 层 auto 链：精确→包含）
  // 形如 '等 XXX 出现' / '等 XXX 加载' / 'XXX 可见'
  const m = /(?:等|等待)\s*([^\s，。]{1,30}?)\s*(?:出现|加载|显示|可见|就绪|完成)/.exec(t);
  if (m) {
    const kw = m[1].replace(/^(页面|界面|列表|元素)/, '').trim();
    if (kw) return kw; // 裸文本（device 层 auto 链）
  }
  return null;
}
