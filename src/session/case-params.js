// 用例参数表与取值转换（从 case.js 抽出）。
//
// 抽出的理由：参数表（PARAM_KEYS_BY_TYPE 及其派生的 PARAM_KEYS）与取值转换
// （coerce / unquote）是一个独立单元——历史上两张表分处两处导致 maxScrolls
// 掉落、lint 放行但运行静默失效。让"参数表"成为显式模块，parseCaseText 专注解析。
//
// 单一事实源：PARAM_KEYS 由 PARAM_KEYS_BY_TYPE 的并集派生——两张表手工维护必然漂移
// （历史上 aiInput 的 clear 只在分类型表里，导致 "clear: true" 被当成文本拼进 text，
//  且因未进入 step 对象而完全绕过 warnUnknownParams 告警）。

// 步骤字段收哪些"参数行"（缩进续行）；不在表内且非命令名的续行仍按旧行为拼进 text。
export const PARAM_KEYS_BY_TYPE = {
  ai: ['timeout', 'until', 'maxRounds', 'batch', 'name'],
  aiAct: ['timeout', 'until', 'maxRounds', 'batch', 'name'],
  aiTap: ['timeout'],
  aiInput: ['value', 'clear', 'timeout'],
  aiLongPress: ['durationMs', 'timeout'],
  aiKeyboardPress: ['keyName', 'timeout'],
  // maxScrolls 是 aiScroll 的历史参数名（滚动轮数上限）；工具参数名是 max。
  // 曾在派生化改造中从全局 PARAM_KEYS 掉落（全局表由本表并集派生），导致
  // "maxScrolls: 5" 续行不被识别 → 被拼进 text → direction 被污染成
  // "向下滚动直到最后一个相册 maxScrolls: 5"，且 lint 因 maxScrolls 豁免而 0 error
  // ——即"lint 放行、运行期静默失效"。本表与 lint 规则必须同步。
  aiScroll: ['direction', 'distancePct', 'until', 'max', 'maxScrolls', 'timeout'],
  aiTapEach: ['rows', 'tap', 'stopWhen', 'maxRounds', 'verify', 'verifyColor', 'profile', 'timeout'],
  uiDump: ['path', 'timeout'],
  launch: ['appId', 'timeout'],
  terminate: ['package', 'packageName', 'timeout'],
  aiWaitFor: ['timeout', 'quiet', 'selector'],
  aiQuery: ['name', 'mode', 'quiet', 'timeout'],
  aiAssert: ['timeout'],
  sleep: [],
  net: ['profile'],
};
export const PARAM_KEYS = new Set(Object.values(PARAM_KEYS_BY_TYPE).flat());
export const NUMBER_KEYS = new Set(['seconds', 'max', 'timeout', 'maxScrolls', 'durationMs', 'distancePct']);
// 布尔型参数：只收工具 schema 明确声明 Type.Boolean 的那些（clear / verify）。
// 不收 batch —— 它在 resolveLoopPlan 里按 String(s.batch) 正则判定，字符串语义是既有契约。
export const BOOLEAN_KEYS = new Set(['clear', 'verify']);

export function unquote(v) {
  const t = String(v ?? '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

export function coerce(key, val) {
  const v = unquote(val);
  if (NUMBER_KEYS.has(key)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  // 布尔参数（clear / verify / batch 等）：工具 schema 声明的是 Type.Boolean，
  // 字符串 "true" 会被 typebox 校验拒绝——必须在此转成真布尔。
  if (BOOLEAN_KEYS.has(key)) {
    if (/^(true|yes|on|1)$/i.test(v)) return true;
    if (/^(false|no|off|0)$/i.test(v)) return false;
    return v;
  }
  return v;
}
