// 会话历史截图治理（§16）：旧截图替换为文字占位符，避免 prompt tokens 随历史线性膨胀。
//
// 实测背景：20 张 1080×2400 历史图 → prompt_tokens 达 67k、单轮往返 26s（1 张时仅 3.4k / 11s）。
// 策略：**只保留最近 N 张图**完整可见，更早的替换为 `[截图已省略: <标签> <尺寸>]` 文本。
//   - 模型仍知道"那里曾看过一张图 + 当时的标签"，只是不再重传像素
//   - 报告里的截图文件**不受影响**（原图仍落盘取证）
//
// 依赖：Pi 的 session.agent.state.messages（SDK 文档明确支持读写该数组）。

export const PLACEHOLDER_PREFIX = '[截图已省略';

// 占位符构造（唯一来源）：pruneImages 与 replaceImagesWithPlaceholder 共用
function placeholderFor(block) {
  const kb = block?.data ? Math.round(String(block.data).length * 3 / 4 / 1024) : 0;
  return { type: 'text', text: `${PLACEHOLDER_PREFIX}: ${block?.mimeType || 'image'}${kb ? ' ~' + kb + 'KB' : ''}（历史步骤，已省略以省 token）]` };
}

// 把一条消息里的 image block 换成文字占位符；返回是否发生替换
export function replaceImagesWithPlaceholder(msg) {
  if (!msg || !Array.isArray(msg.content)) return { changed: false, count: 0 };
  let count = 0;
  const next = msg.content.map((block) => {
    if (block && block.type === 'image') {
      count++;
      return placeholderFor(block);
    }
    return block;
  });
  if (count === 0) return { changed: false, count: 0 };
  return { changed: true, count, content: next };
}

// 统计消息数组里的图片总数
export function countImages(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (Array.isArray(m?.content)) n += m.content.filter((b) => b?.type === 'image').length;
  }
  return n;
}

// 主入口：保留最近 keepRecent 张图，其余替换为占位符（原地改写传入的消息对象）。
// 返回 { total, kept, replaced, changed }。
export function pruneImages(messages, { keepRecent = 3 } = {}) {
  const total = countImages(messages);
  if (total <= keepRecent) return { total, kept: total, replaced: 0, changed: false };

  // 从后往前数，标记"保留"的图片位置（msgIdx, blockIdx）
  const keep = new Set();
  let seen = 0;
  for (let mi = messages.length - 1; mi >= 0 && seen < keepRecent; mi--) {
    const c = messages[mi]?.content;
    if (!Array.isArray(c)) continue;
    for (let bi = c.length - 1; bi >= 0 && seen < keepRecent; bi--) {
      if (c[bi]?.type === 'image') { keep.add(`${mi}:${bi}`); seen++; }
    }
  }

  let replaced = 0;
  for (let mi = 0; mi < messages.length; mi++) {
    const c = messages[mi]?.content;
    if (!Array.isArray(c)) continue;
    for (let bi = 0; bi < c.length; bi++) {
      if (c[bi]?.type === 'image' && !keep.has(`${mi}:${bi}`)) {
        c[bi] = placeholderFor(c[bi]);
        replaced++;
      }
    }
  }
  return { total, kept: total - replaced, replaced, changed: replaced > 0 };
}

// —— 旧工具结果截断（上下文治理第二道）——
// uitree/screen_diff/read 等工具结果单条可达 20-40KB；长 run（百步）累积数 MB 进上下文，
// 实测 deepseek 在长上下文下对部分轮次返回空消息（无文本无 toolCall）。图片已有 pruneImages，
// 工具结果此前无治理。策略：保留最近 keepRecent 条 toolResult 完整，更早的截断为前 N 字符摘要。
// 模型仍知道"该步调用过、返回过大意"，只是不再重传全文。
export const TOOLRESULT_PLACEHOLDER = '[工具结果已截断';

export function pruneToolResults(messages, { keepRecent = 6, keepChars = 300 } = {}) {
  let replaced = 0;
  // 从后往前数 toolResult，前 keepRecent 条保留
  let seen = 0;
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const m = messages[mi];
    if (m?.role !== 'toolResult') continue;
    seen++;
    if (seen <= keepRecent) continue;
    const c = m.content;
    if (typeof c === 'string') {
      if (c.length > keepChars && !c.startsWith(TOOLRESULT_PLACEHOLDER)) {
        m.content = `${TOOLRESULT_PLACEHOLDER}: 原 ${c.length} 字符] ${c.slice(0, keepChars)}…`;
        replaced++;
      }
    } else if (Array.isArray(c)) {
      for (let bi = 0; bi < c.length; bi++) {
        const b = c[bi];
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > keepChars && !b.text.startsWith(TOOLRESULT_PLACEHOLDER)) {
          b.text = `${TOOLRESULT_PLACEHOLDER}: 原 ${b.text.length} 字符] ${b.text.slice(0, keepChars)}…`;
          replaced++;
        }
      }
    }
  }
  return { replaced, changed: replaced > 0 };
}
