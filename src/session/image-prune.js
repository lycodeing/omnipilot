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
