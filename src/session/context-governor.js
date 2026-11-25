// 上下文治理执行后端（评审 C-A1）：四道治理经 appendContextEdit 对 Pi 1.6.0 的
// **实际请求上下文**生效——SDK 每次请求前用 buildSessionProjection() 重建消息数组
// （agent-session._installAgentRequestProjection），原地改写 state.messages 会被覆盖，
// 旧版 prune* 的治理因此从未到达模型。本模块把同样的决策落到会话树的 context_edit /
// custom_message entry 上：投影可见、持久化历史保留原文（append-only，不污染取证）。
//
// 三语义（均已运行时验证）：
//   - 删除：appendContextEdit(id, null) → 该 entry 不再贡献模型可见消息
//   - 替换：appendContextEdit(id, {content}) → 只换 content，role/metadata 不动
//     （toolResult 的 role 不可改 → 折叠须"null 删除 + custom user 摘要注入"两步）
//   - 注入：appendCustomMessageEntry(type, [{type:'text',text}], false) → LLM 侧转 user
// system 消息不可 edit（SDK 抛错）→ 治理跳过；重复 edit 同一 target 最新生效（幂等）。

import { countImages, placeholderFor, TOOLRESULT_PLACEHOLDER } from './image-prune.js';
import { STEP_DIGEST_PREFIX } from './context-window.js';

export function createContextGovernor({ sessionManager }) {
  function projection() { return sessionManager.buildSessionProjection(); }

  // message → entryId：投影 entries 的 messages 与源 entry.message 引用共享（无 edit 时），
  // 有 edit 时是 {...message, content} 新对象 → 按引用找不到，返回 null（调用方视为已治理，跳过）。
  function entryIdOf(message) {
    const proj = projection();
    for (const entry of proj.entries) {
      for (const m of entry.messages) {
        if (m === message) return entry.sourceEntry.id;
      }
    }
    return null;
  }

  function editContent(message, content) {
    const id = entryIdOf(message);
    if (!id) return false;
    try { sessionManager.appendContextEdit(id, { content }); return true; }
    catch { return false; }
  }

  function omit(message) {
    const id = entryIdOf(message);
    if (!id) return false;
    try { sessionManager.appendContextEdit(id, null); return true; }
    catch { return false; }
  }

  function injectUserText(customType, text) {
    sessionManager.appendCustomMessageEntry(customType, [{ type: 'text', text }], false);
  }

  // 清理投影里仍可见的同类 custom 注入（digest/折叠摘要）。治理是"替换"语义：
  // 每步重放时旧注入必须先删，否则窗口折叠每次执行都追加一条新 digest（实验实证：
  // 8 步后 5 条 digest 累积、tail 计数错位把保留段原文也删光）。已 null 删除的
  // entry 投影 messages 为空，天然跳过 → 重复执行幂等。
  function omitCustomType(customType) {
    for (const entry of projection().entries) {
      if (entry.sourceEntry.type === 'custom_message' && entry.sourceEntry.customType === customType && entry.messages.length > 0) {
        try { sessionManager.appendContextEdit(entry.sourceEntry.id, null); } catch { /* 不可 edit 则跳过 */ }
      }
    }
  }

  function pruneImages({ keepRecent = 3 } = {}) {
    const msgs = projection().messages;
    const total = countImages(msgs);
    if (total <= keepRecent) return { total, kept: total, replaced: 0, changed: false };
    const keep = new Set();
    let seen = 0;
    for (let mi = msgs.length - 1; mi >= 0 && seen < keepRecent; mi--) {
      const c = msgs[mi]?.content;
      if (!Array.isArray(c)) continue;
      for (let bi = c.length - 1; bi >= 0 && seen < keepRecent; bi--) {
        if (c[bi]?.type === 'image') { keep.add(`${mi}:${bi}`); seen++; }
      }
    }
    let replaced = 0;
    for (let mi = 0; mi < msgs.length; mi++) {
      const c = msgs[mi]?.content;
      if (!Array.isArray(c)) continue;
      let changed = false;
      const next = c.map((b, bi) => {
        if (b?.type === 'image' && !keep.has(`${mi}:${bi}`)) { changed = true; replaced++; return placeholderFor(b); }
        return b;
      });
      if (changed) editContent(msgs[mi], next);
    }
    return { total, kept: total - replaced, replaced, changed: replaced > 0 };
  }

  function pruneToolResults({ keepRecent = 6, keepChars = 300 } = {}) {
    const msgs = projection().messages;
    let replaced = 0;
    let seen = 0;
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const m = msgs[mi];
      if (m?.role !== 'toolResult') continue;
      seen++;
      if (seen <= keepRecent) continue;
      const c = m.content;
      if (typeof c === 'string') {
        if (c.length > keepChars && !c.startsWith(TOOLRESULT_PLACEHOLDER)) {
          if (editContent(m, `${TOOLRESULT_PLACEHOLDER}: 原 ${c.length} 字符] ${c.slice(0, keepChars)}…`)) replaced++;
        }
      } else if (Array.isArray(c)) {
        let changed = false;
        const next = c.map((b) => {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > keepChars && !b.text.startsWith(TOOLRESULT_PLACEHOLDER)) {
            changed = true;
            return { ...b, text: `${TOOLRESULT_PLACEHOLDER}: 原 ${b.text.length} 字符] ${b.text.slice(0, keepChars)}…` };
          }
          return b;
        });
        if (changed && editContent(m, next)) replaced++;
      }
    }
    return { replaced, changed: replaced > 0 };
  }

  // 工具轮折叠：assistant toolCall → 纯文本 content（toolCall 块消失 → 请求侧无 tool_calls）；
  // toolResult → null 删除 + user 摘要注入（role 不可改，只能删后补）。
  function foldToolRound(msgs, fromIdx, toIdx) {
    let folded = 0;
    const summaries = [];
    for (let i = fromIdx; i < toIdx; i++) {
      const m = msgs[i];
      if (m?.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'toolCall')) {
        const calls = m.content.filter((b) => b?.type === 'toolCall')
          .map((b) => `[调用工具 ${b.name ?? b.toolName ?? '?'} ${JSON.stringify(b.arguments ?? b.input ?? {}).slice(0, 120)}]`)
          .join(' ');
        const texts = m.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '');
        if (editContent(m, [{ type: 'text', text: [...texts, calls].filter(Boolean).join(' ') || calls }])) folded++;
      } else if (m?.role === 'toolResult') {
        const c = m.content;
        const txt = Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ') : String(c ?? '');
        summaries.push(`[工具结果] ${txt.slice(0, 300)}${txt.length > 300 ? '…' : ''}`);
        if (omit(m)) folded++;
      }
    }
    // 摘要按原顺序注入（每条 toolResult 一条 custom user 消息，保持时序）。
    // 先清旧摘要再注入：步间/催答轮反复折叠时旧摘要不累积（替换语义）。
    if (folded > 0) {
      omitCustomType('ask-folded-tool-result');
      for (const s of summaries) injectUserText('ask-folded-tool-result', s);
    }
    return folded;
  }

  function pruneToolHistory({ keepRecent = 1 } = {}) {
    const msgs = projection().messages;
    const assistantToolIdx = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'toolCall')) assistantToolIdx.push(i);
    }
    const keepFrom = keepRecent === 0 ? msgs.length
      : (assistantToolIdx.length > keepRecent ? assistantToolIdx[assistantToolIdx.length - keepRecent] : 0);
    const folded = foldToolRound(msgs, 0, keepFrom);
    return { folded, changed: folded > 0 };
  }

  function foldToolHistory() { return pruneToolHistory({ keepRecent: 0 }); }

  function pruneStepHistory(stepCounts, { keepSteps = 3, digest = '' } = {}) {
    const proj = projection();
    // digest 是治理注入的占位消息，不属于任何步的原文 delta。分段计算前先把它
    // 从视图里剔除（等价于旧原地版 splice 后的数组形态），否则旧 digest 占一格
    // 使 tail 错位，重复执行会把保留段原文误删（幂等测试 3→2 抖动的根因）。
    const isDigest = (m) => m?.role === 'custom' && m?.customType === 'ask-step-digest';
    const msgs = proj.messages.filter((m) => !isDigest(m));
    if (!Array.isArray(stepCounts)) return { removed: 0, changed: false };
    const k = stepCounts.length;
    if (k <= keepSteps) return { removed: 0, changed: false };
    let tail = 0;
    for (let i = k - keepSteps; i < k; i++) {
      const c = Number(stepCounts[i]);
      if (!Number.isFinite(c) || c < 0) return { removed: 0, changed: false };
      tail += c;
    }
    const keepFrom = msgs.length - tail;
    const start = msgs[0]?.role === 'system' ? 1 : 0;
    if (keepFrom >= msgs.length || keepFrom <= start) return { removed: 0, changed: false };
    let removed = 0;
    for (let i = start; i < keepFrom; i++) {
      if (omit(msgs[i])) removed++;
    }
    // 替换语义：先删旧 digest 再注入新 digest（整体描述每步更新，只保留最新一条）
    const hadDigest = proj.messages.some(isDigest);
    omitCustomType('ask-step-digest');
    // 幂等守卫：无原文可删且无旧 digest 可换（同一参数重复执行）→ 不注入，消息数稳定
    if (removed === 0 && !hadDigest) return { removed: 0, changed: false };
    const text = String(digest || '').trim() || `${STEP_DIGEST_PREFIX}更早步骤的原文已按上下文窗口策略省略。`;
    injectUserText('ask-step-digest', text);
    return { removed, keptSteps: keepSteps, changed: removed > 0 || hadDigest };
  }

  return { pruneImages, pruneToolResults, pruneToolHistory, pruneStepHistory, foldToolHistory };
}