// 传输/通道错误分类：控制流用结构化标注，避免依赖中文报错串匹配（文案一改即静默失效）。
//   e.kind  —— 本引擎错误源显式标注（uia2.js httpRaw/建会话等）：'timeout'|'connection'|'protocol'|'unavailable'
//   e.code  —— node 原生错误码（ETIMEDOUT/ECONNRESET/…）与 adb.js 的 ETIMEDOUT 约定
// message 正则仅作兜底（测试注入执行器/历史错误对象无结构时仍可分类），标注为 deprecation。
// 调用方（dumpXmlRaw 退避、槽判定）依赖分类语义。

export function classifyTransportError(e) {
  if (!e) return 'unknown';
  if (e.kind) return e.kind;
  if (e.code === 'ETIMEDOUT' || e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'timeout';
  if (typeof e.code === 'string' && /^(ECONN|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_|EPROTO)/.test(e.code)) return 'connection';
  // 兜底（deprecation）：新错误源请在上游挂 e.kind，不要依赖这里
  const msg = String(e?.message ?? e);
  if (/超时|timeout|ETIMEDOUT|abort/i.test(msg)) return 'timeout';
  if (/连接|中断|ECONN|socket|reset|closed/i.test(msg)) return 'connection';
  return 'unknown';
}

// 就地补 kind（不改变错误对象其余语义）：uia2.js 等错误源用它标注后继续抛
export function withKind(e, kind) {
  if (e && !e.kind) e.kind = kind;
  return e;
}
