// 步骤上下文窗口（上下文治理第四道）：以"步"为帧，保留最近 N 步原文 + 整体描述。
//
// 调研依据（docs/CONTEXT-COMPRESSION-RESEARCH.md）：
//   - Cline/Claude Code 社区共识 = "保近摘要远"（keep recent N verbatim + summarize older）；
//     Claude Code 全量摘要丢近期细节是 top 抱怨（issue #22467）。
//   - Manus：前缀稳定（append-only）保 KV-cache → 折叠只动历史中后段，system 首位不动。
//   - OpenHands：压缩是确定性系统组件，不是模型自觉 → 我们用**确定性摘要**（0 额外 LLM 轮次，
//     结果可复现；UI 测试步骤语义窄，一行 "#12 tap_each_row ✓" 足够，不需要 LLM 总结）。
//
// 分段模型：调用方（bin/ask.js）每步结束时记录该步产生的消息数（delta），形成 stepCounts。
//   段 k 的原文 = 倒数计 stepCounts 的尾部若干条消息。用 delta 而非绝对下标，跨多轮剪枝稳定。
//   引擎步产生 0 条消息 → 空段（不出现在原文里，但出现在 digest 的一行结果里）。
// 行为：段数 > keepSteps 时，删除最旧（段数-keepSteps）段的全部消息，
//   在删除处插入一条 user 消息 = digest（整体描述）。
// 幂等/安全：段数不足、keepFrom 落在 system 消息上、尾部计数与数组长度不符（异常）→ 不动。

export const STEP_DIGEST_PREFIX = '【整体进展】';

export function pruneStepHistory(messages, stepCounts, { keepSteps = 3, digest = '' } = {}) {
  if (!Array.isArray(messages) || !Array.isArray(stepCounts)) return { removed: 0, changed: false };
  const k = stepCounts.length;
  if (k <= keepSteps) return { removed: 0, changed: false }; // 未超窗口
  let tail = 0;
  for (let i = k - keepSteps; i < k; i++) {
    const c = Number(stepCounts[i]);
    if (!Number.isFinite(c) || c < 0) return { removed: 0, changed: false }; // 计数异常 → 保守不动
    tail += c;
  }
  const keepFrom = messages.length - tail;
  const start = messages[0]?.role === 'system' ? 1 : 0; // system 永远首位（前缀稳定）
  if (keepFrom <= start) return { removed: 0, changed: false };
  const removed = keepFrom - start;
  const text = String(digest || '').trim() || `${STEP_DIGEST_PREFIX}更早步骤的原文已按上下文窗口策略省略。`;
  messages.splice(start, removed, { role: 'user', content: [{ type: 'text', text }] });
  return { removed, keptSteps: keepSteps, changed: true };
}

// 确定性"整体描述"构造（bin/ask.js 每步调一次）：进度 + 最近步骤行 + 断言计数。
// steps: recorder.stepsSince(0) 形状（{index,type,target,result,error}）；caseName/caseTotal 步数。
export function buildStepDigest({ caseName, caseTotal, steps = [], assertions = [], vars = {}, datasets = null, keepLines = 8 } = {}) {
  const done = steps.length;
  const lines = steps.slice(-keepLines).map((s) => {
    const ok = s.result === 'ok' || s.result === undefined;
    return `#${s.index ?? '?'} ${s.type ?? '?'} ${String(s.target ?? '').slice(0, 24)} ${ok ? '✓' : `✗ ${String(s.error ?? '').slice(0, 40)}`}`;
  });
  const passed = assertions.filter((a) => a.passed).length;
  const failedList = assertions.filter((a) => !a.passed).map((a) => `「${String(a.text).slice(0, 24)}」`);
  const varLines = Object.entries(vars).filter(([, v]) => v != null && v !== '').map(([k2, v]) => `${k2}=${String(v).slice(0, 30)}`);
  // 数据集写入计数（ctx.datasetWrites）：书断言（"数据集 X 至少3条"）的证据必须能越过窗口折叠
  const dsLines = datasets instanceof Map ? [...datasets.entries()].map(([k2, n]) => `${k2}=${n}条`) : [];
  const parts = [
    `${STEP_DIGEST_PREFIX}用例《${caseName ?? '?'}》${caseTotal ? `共 ${caseTotal} 步，` : ''}已完成 ${done} 步`,
    lines.length ? `最近：${lines.join('；')}` : null,
    assertions.length ? `断言 ${passed}/${assertions.length} 通过${failedList.length ? `（失败：${failedList.join('、')}）` : ''}` : null,
    dsLines.length ? `已落库数据集：${dsLines.join('、')}（后续数据集断言以此为准）` : null,
    varLines.length ? `变量：${varLines.join(' ')}` : null,
    '以下仅保留最近步骤的完整上下文，更早步骤细节已省略。',
  ];
  return parts.filter(Boolean).join('\n');
}
