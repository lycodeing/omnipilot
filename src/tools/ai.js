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

export function createChatClient({ url, key, model, fetchImpl = fetch, timeoutMs = 60_000, transcriptWriter = null } = {}) {
  if (!url || !model) throw new Error('createChatClient 需要 url 与 model');
  const endpoint = url.replace(/\/+$/, '') + '/chat/completions';
  // reasoning：思考控制参数对象（由 coord/reasoning.js 按 family+端点翻译好），直接展开进请求体；
  // maxTokens：可选 max_tokens 上限；system：非空时覆盖默认 JSON 提示词。三者均不影响既有调用方。
  // transcriptWriter：可选落盘钩子，每次 HTTP 尝试（含重试）记一条完整交互；写入失败不阻断请求。
  return async function chat(prompt, { system = SYSTEM_HINT, temperature = 0, maxRetries = 1, images = [], reasoning = null, maxTokens } = {}) {
    // images: base64 字符串（默认 PNG，向后兼容）或 { data, mimeType } 对象（压缩后 JPEG 用）
    const toPart = (img) => {
      const isObj = img && typeof img === 'object';
      const data = isObj ? img.data : img;
      const mime = isObj && img.mimeType ? img.mimeType : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
    };
    const userContent = images.length
      ? [
          { type: 'text', text: prompt },
          ...images.map(toPart),
        ]
      : prompt;
    const effectiveSystem = (typeof system === 'string' && system.trim().length > 0) ? system : SYSTEM_HINT;
    const requestBody = {
      model,
      temperature,
      messages: [
        { role: 'system', content: effectiveSystem },
        { role: 'user', content: userContent },
      ],
    };
    if (maxTokens !== undefined && maxTokens !== null) requestBody.max_tokens = maxTokens;
    // 思考参数放最后展开：允许适配器方言字段（reasoning_effort/thinking/enable_thinking 等）直达网关
    if (reasoning && typeof reasoning === 'object') Object.assign(requestBody, reasoning);
    const body = JSON.stringify(requestBody);
    // transcript 公共字段：图片只记 mime 与估算字节数（base64 长度 ×0.75），不落原图避免文件爆炸
    const imageSummaries = images.map((img) => {
      const isObjectImage = img && typeof img === 'object';
      const base64Data = isObjectImage ? (img.data || '') : (img || '');
      return {
        mimeType: (isObjectImage && img.mimeType) || 'image/png',
        sizeBytes: Math.round(base64Data.length * 0.75),
      };
    });
    const writeTranscriptEntry = (extraFields, attemptStartMs) => {
      if (!transcriptWriter) return;
      try {
        transcriptWriter({
          timestamp: new Date().toISOString(),
          model,
          prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
          system: effectiveSystem,
          images: imageSummaries,
          reasoning: reasoning || null,
          durationMs: Date.now() - attemptStartMs,
          ...extraFields,
        });
      } catch { /* transcript 写入失败不阻断请求 */ }
    };
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const attemptStartMs = Date.now();
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
        // 成功：记完整响应文本与 token 用量（网关未回 usage 时为 null）
        writeTranscriptEntry({ attempt, response: text, usage: data?.usage || null, error: null }, attemptStartMs);
        return text;
      } catch (e) {
        lastErr = e;
        // 失败：每次尝试都记一条，error 填错误信息；重试链在文件里可完整回放
        writeTranscriptEntry({ attempt, response: null, usage: null, error: e.message }, attemptStartMs);
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
