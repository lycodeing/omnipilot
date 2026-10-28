// 小模型助手（§7.1 ai 模式）：OpenAI 兼容 chat/completions + JSON 容错（jsonrepair）。
// 注入式设计：createChatClient({ fetchImpl, url, key }) 便于测试 mock，不真连。

const SYSTEM_HINT = '只输出 JSON，不要输出任何其他文字或代码块标记。';

export class JsonParseError extends Error {}

// 容错解析：剥代码块围栏、截取首尾大括号、修正尾逗号
export function repairJson(text) {
  if (typeof text !== 'string') throw new JsonParseError('响应不是文本');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const first = Math.min(...['{', '['].map((c) => { const i = t.indexOf(c); return i === -1 ? Infinity : i; }));
  if (first !== Infinity) t = t.slice(first);
  const lastBrace = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (lastBrace !== -1) t = t.slice(0, lastBrace + 1);
  t = t.replace(/,\s*([}\]])/g, '$1'); // 尾逗号
  try { return JSON.parse(t); } catch (e) {
    throw new JsonParseError(`JSON 解析失败：${e.message}`);
  }
}

export function createChatClient({ url, key, model, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  if (!url || !model) throw new Error('createChatClient 需要 url 与 model');
  const endpoint = url.replace(/\/+$/, '') + '/chat/completions';
  return async function chat(prompt, { system = SYSTEM_HINT, temperature = 0, maxRetries = 1, images = [] } = {}) {
    // images: base64 PNG 数组（data_extract ai 模式把截图交给模型，§7.1）
    const userContent = images.length
      ? [
          { type: 'text', text: prompt },
          ...images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })),
        ]
      : prompt;
    const body = JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    });
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key || ''}` },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content ?? '';
        if (!text) throw new Error('模型返回空内容');
        return text;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  };
}

// 提取结构化数据：chat → repairJson，失败重试 1 次，仍失败标 partial
export async function extractJson(chat, prompt) {
  try {
    return { data: repairJson(await chat(prompt)), partial: false, error: null };
  } catch (e1) {
    try {
      return { data: repairJson(await chat(prompt + '\n上次输出不是合法 JSON，请严格只输出 JSON。')), partial: false, error: null };
    } catch (e2) {
      return { data: null, partial: true, error: e2.message };
    }
  }
}

// 断言判词解析（§13.1 退出码 1 的依据）：优先 JSON {passed, reason}，退化按关键词。
// 判不通过时含"通过"字样不会误判——fail 模式先匹配"不通过/未通过"，二者同时命中保守判失败。
export function parseVerdict(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { passed: false, reason: '(模型无输出)' };
  try {
    const j = repairJson(raw);
    if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.passed === 'boolean') {
      return { passed: j.passed, reason: String(j.reason ?? raw) };
    }
    if (typeof j === 'boolean') return { passed: j, reason: raw };
  } catch { /* 非 JSON，走关键词 */ }
  const fail = /(不通过|未通过|不成立|未出现|未找到|失败|fail(?:ed)?\b|\bfalse\b)/i.test(raw);
  const pass = /(通过|成立|正确|正常|pass(?:ed)?\b|\btrue\b)/i.test(raw);
  if (fail) return { passed: false, reason: raw };
  if (pass) return { passed: true, reason: raw };
  return { passed: false, reason: raw.slice(0, 500) };
}
