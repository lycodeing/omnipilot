// 断言提示词构造：屏幕类断言只看截图；数据类断言注入数据集事实。
// 数据集事实来自 ctx.datasetWrites（运行期写入计数）+ store.read（样本），
// 使模型无需调工具即可判定"数据集 X 至少 N 条"。

// 从断言文本提取数据集名："数据集 X" / "数据集X"（中英文紧邻都认）
export function extractDatasetNames(text) {
  const names = [];
  const re = /数据集\s*([A-Za-z_][\w-]*)/g;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// 采集数据集事实：行数 + 前 3 条样本（JSON 截断 200 字符/条）
export async function collectDatasetFacts(stepText, datasetWrites, store) {
  const names = extractDatasetNames(stepText);
  if (!names.length) return null;
  const parts = [];
  for (const name of names) {
    const count = datasetWrites instanceof Map ? datasetWrites.get(name) : null;
    let rows = [];
    try { rows = store ? await store.read(name) : []; } catch { rows = []; }
    const n = count != null ? count : rows.length;
    const sample = rows.slice(0, 3).map((r) => JSON.stringify(r).slice(0, 200)).join(', ');
    parts.push(`${name}=${n}条${sample ? `，样本：[${sample}]` : ''}`);
  }
  return `【数据集事实】${parts.join('；')}（以此为准判定，不要凭屏幕猜测）`;
}

// 构造断言提示词：数据类注入事实，屏幕类保持原口径
export function buildAssertPrompt({ stepText, fgNote = '', datasetFacts = null }) {
  const evidence = datasetFacts
    ? `只依据随附的当前屏幕截图、上述系统事实与以下数据集事实判断`
    : `只依据随附的当前屏幕截图与上述系统事实判断`;
  const factsBlock = datasetFacts ? `\n${datasetFacts}` : '';
  return `【断言】${stepText}${fgNote}${factsBlock}\n${evidence}，不要调用任何工具。只输出一行 JSON：{"passed": true/false, "reason": "不超过30字"}。`;
}
