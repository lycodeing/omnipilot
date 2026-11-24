// 传输/通道错误分类（2026-11-10 评审 #6）：此前控制流靠匹配引擎**自己生成的中文报错串**
//（/超时|连接|中断/、/建会话失败: 500/）——文案一改分类即静默失效。统一为结构化：
//   e.kind  —— 本引擎错误源显式标注（uia2.js httpRaw/建会话等）：'timeout'|'connection'|'protocol'
//   e.code  —— node 原生错误码（ETIMEDOUT/ECONNRESET/…）与 adb.js 的 ETIMEDOUT 约定
// message 正则仅作兜底（测试注入执行器/历史错误对象无结构时仍可分类），标注为 deprecation。
// 分类语义与旧正则逐位对齐，调用方（dumpXmlRaw 退避、槽判定）行为不变。

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
