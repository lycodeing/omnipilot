# VLM 模型适配层技术改造方案

> 日期：2026-11-27
> 状态：待评审
> 依据：hy4/hy4-flash 视觉定位评估报告 + Midscene v1.17+ 源码调研 + 现有架构分析

## 一、问题与动机

### 1.1 直接触发

问卷用例 step 56 `tap text=确认` 失败：deepseek-v4.1-flash VLM 定位 center=(537,1387)，实际按钮中心≈(541,1325)，**y 偏 +62px**，点到白色背景而非红色按钮。弹窗未关闭 → 后续结果页断言全 fail。

### 1.2 评估数据确认根因

| 模型 | Midscene 协议中位误差 | 最大误差 | 速度 | 判定 |
|---|---|---|---|---|
| deepseek-v4.1-flash | 49-52px | 849px | 1.2-6s | ❌ grounding 弱 |
| hy4-flash (关思考) | 1.6px | 25px* | 2-5s | ✅ 最优 |
| qwen3-vl-plus | 2.2px | 13px | 1.3-5.3s | ✅ 主力 |
| qwen3.8-flash | 1.6px | 26px* | 2.9-4.3s | ✅ 第一梯队 |
| qwen3.7-plus | 2.4px | ≤9px | 3.0-7.3s | ✅ 稳但略慢 |

*25/26px 为 GT 框定义差异，非模型错。

### 1.3 现有架构的 10 个问题

1. **双源 family 清单**：registry FAMILY_ALIASES vs model.js inferFamilyFromName，新增 family 必改两处
2. **思考控制双轨不对齐**：agent 路径有 thinkingLevelMap，VLM 定位/chat 路径零思考参数
3. **probe 缓存无模型标识**：换模型后旧 family 被静默复用
4. **AbsolutePixel × 图片压缩语义错位**：720px 压缩图的"绝对像素"与设备 size 不一致
5. **family 未知时 prompt 缺省(0-1000)与解析缺省(null→报错)不一致**
6. **buildVlmLocate 内联在 CLI**，4 处各自拼 VLM prompt，无统一组装层
7. **chat system("只输出 JSON") 与 locate user("ONLY the numbers") 指令冲突**
8. **toNumbers 盲抓数字**：含干扰数字的回复有污染风险
9. **registerStrategy 扩展点存在但无生产接入**
10. **MiniMax/hy4 等家族缺坐标协议登记**

## 二、设计原则（借鉴 Midscene）

### 2.1 核心模式：声明式适配器 + 解析器填默认

```
ModelAdapterDefinition（声明式，只写差异）
        │
        ▼
ResolvedModelAdapter（运行时，逐项 ?? 默认实现）
        │
        ├─ coordinateCodec    ← 坐标元数据单一真源
        ├─ locateProtocol     ← 提示词骨架 + 响应结构
        ├─ reasoningParams    ← 思考控制参数构建
        └─ chatCompletion     ← 请求参数构建
```

**适配器只写与默认不同的槽位**。新增 tencent-hy 在 Midscene 里仅 57 行。我们的目标：新增一个 family ≤ 30 行配置。

### 2.2 坐标元数据单一真源

一份 `CoordinateSpec` 同时驱动：
- 提示词文案（describeForPrompt）
- 示例值（prompt example）
- 解析校验（parseRawResponse）
- 像素换算（toPixels）

杜绝"提示词说 0-1000、解析按像素"的漂移。

### 2.3 protocol 与 codec 正交

- **protocol**：管提示词骨架与响应结构（JSON / XML 标签 / 纯数字）
- **codec**：管坐标语义与像素换算（bbox/point、xy/yx、归一化/像素）

换响应格式不动坐标换算；换坐标制式不动提示词骨架。

### 2.4 reasoning 三态 + 端点探测

- `true`：显式开启思考
- `false`：显式关闭思考
- `'default'`：不传参数，用服务端默认

同一 family 按 baseURL 切换参数方言（u2a OpenAI 风格 vs 腾讯官方 Anthropic 风格）。

## 三、架构设计

### 3.1 新增文件结构

```
src/device/coord/
├── strategy.js          ← 保留，重构为 CoordinateCodec（纯坐标换算）
├── registry.js          ← 保留，升级为 ModelAdapterRegistry
├── probe.js             ← 保留，修复缓存 key
├── adapters/            ← 新增：声明式适配器目录
│   ├── default.js       ← 默认适配器（OpenAI 兼容 + 0-1000 bbox）
│   ├── tencent-hy.js    ← hy4/hy4-flash（box_2d + thinking 控制）
│   ├── qwen-vl.js       ← qwen3-vl/qwen3.8（bbox_2d + enable_thinking）
│   ├── qwen-legacy.js   ← qwen2.5-vl（像素坐标 + padBlockSize=28）
│   ├── deepseek.js      ← deepseek（XML 标签协议 / 0-1000 point）
│   ├── kimi.js          ← kimi/kimi3（0-1 point + 动态判定）
│   ├── gemini.js        ← gemini（yx 序 + thinking_config）
│   ├── gpt.js           ← gpt-5/6（像素 + left-closed-right-open）
│   ├── doubao.js        ← doubao/seed（容错 parser）
│   └── minimax.js       ← minimax（reasoning_effort）
├── adapter-resolver.js  ← 新增：声明式 → 运行时解析器
├── locate-protocol.js   ← 新增：统一提示词组装 + 响应解析
└── reasoning.js         ← 新增：思考控制参数构建（per-family + per-endpoint）
```

### 3.2 CoordinateSpec（坐标元数据）

```js
/**
 * @typedef {Object} CoordinateSpec
 * @property {'bbox'|'point'} shape
 * @property {'xy'|'yx'} order
 * @property {number|null} normalizedBy - null=像素, 1000=千分比, 1=单位比
 * @property {'image-size'|'last-pixel'} normalizationBasis
 * @property {'round'|'trunc'|'none'} rounding
 * @property {'closed'|'left-closed-right-open'} boundsType
 * @property {string} resultKey - 主键名（进提示词）
 * @property {string[]} [resultKeyAliases] - 别名（仅解析容错）
 */
```

由同一份 spec 生成：
- `buildPromptInstructions()` → 提示词中的坐标描述 + 示例
- `parseCoordinates(raw)` → 从响应中提取坐标数组
- `toPixels(coords, preparedSize, contentSize)` → 像素换算

### 3.3 ModelAdapterDefinition（声明式适配器）

```js
/**
 * @typedef {Object} ModelAdapterDefinition
 * @property {CoordinateSpec} coordinates - 坐标元数据（必填）
 * @property {string} [systemPromptIntro] - 系统提示词前缀（缺省用通用）
 * @property {'json'|'xml-tags'|'raw-numbers'} [responseFormat] - 响应格式
 * @property {Function} [parseRawResponse] - 自定义响应解析（覆盖默认）
 * @property {Function} [buildReasoningParams] - 思考参数构建（覆盖默认）
 * @property {Object} [reasoningDefaults] - 思考默认配置
 * @property {number} [padBlockSize] - 图像 padding 块大小（qwen2.5-vl=28）
 * @property {number} [maxTokensMinimum] - 最低 max_tokens（hy4≥16k）
 * @property {boolean} [useReasoningAsContentFallback] - content 空时用 reasoning 兜底
 * @property {string[]} [reasoningContentKeys] - reasoning 字段名兼容列表
 * @property {Function} [buildChatParams] - 自定义请求参数（覆盖默认）
 * @property {string[]} [supportedEndpoints] - 支持的端点类型
 */
```

### 3.4 ResolvedModelAdapter（运行时接口）

```js
class ResolvedModelAdapter {
  constructor(definition) {
    this.codec = new CoordinateCodec(definition.coordinates);
    this.protocol = resolveProtocol(definition);
    this.reasoning = resolveReasoning(definition);
    this.chatParams = definition.buildChatParams ?? defaultBuildChatParams;
    this.padBlockSize = definition.padBlockSize ?? 0;
    this.maxTokensMinimum = definition.maxTokensMinimum ?? 4096;
    // ...其余槽位 ?? 默认
  }

  /** 构建完整的 VLM 定位请求 */
  buildLocateRequest({ target, png, size, endpoint }) {
    const systemPrompt = this.protocol.buildSystemPrompt(this.codec);
    const userPrompt = this.protocol.buildUserPrompt(target);
    const reasoningParams = this.reasoning.buildParams(endpoint);
    const imagePayload = this.prepareImage(png, size);
    return { systemPrompt, userPrompt, reasoningParams, imagePayload, ... };
  }

  /** 解析 VLM 响应为像素坐标 */
  parseLocateResponse(raw, preparedSize, contentSize) {
    const parsed = this.protocol.parseRawResponse(raw, this.codec.spec);
    if (!parsed) return { found: false };
    return this.codec.toPixels(parsed, preparedSize, contentSize);
  }
}
```

### 3.5 思考控制（reasoning.js）

```js
// 统一输入
// reasoningEnabled: true | false | 'default'
// reasoningEffort: 'none' | 'low' | 'medium' | 'high'
// reasoningBudget: number | undefined

// per-family 翻译表
const REASONING_TRANSLATORS = {
  'tencent-hy': (enabled, effort, endpoint) => {
    if (endpoint === 'anthropic') return { thinking: { type: enabled ? 'enabled' : 'disabled' } };
    return { reasoning_effort: enabled ? (effort ?? 'medium') : 'none' };
  },
  'qwen-vl': (enabled, effort) => ({
    enable_thinking: enabled,
    ...(effort ? { thinking_budget: mapEffortToBudget(effort) } : {}),
  }),
  'gpt': (enabled, effort) => ({
    reasoning_effort: enabled ? (effort ?? 'medium') : 'none',
  }),
  // ...
};

// 端点探测
function detectEndpoint(baseUrl) {
  if (/tokenhub\.tencentmaas/.test(baseUrl)) return 'anthropic';
  if (/openrouter/.test(baseUrl)) return 'openrouter';
  return 'openai'; // 默认
}
```

### 3.6 统一提示词组装（locate-protocol.js）

借鉴 Midscene 三段式：

```
System:
  {systemPromptIntro}           ← 适配器提供 or 通用默认
  {groundingRules}              ← 全局共享 7 条定位纪律
  {responseInstructions}        ← 由 CoordinateSpec 自动生成

User:
  Find: {targetDescription}
  [screenshot]
```

**关键改进**：
- responseInstructions 由 CoordinateSpec 自动生成（含 resultKey、坐标描述、示例），保证提示词与解析器永远一致
- NOT_FOUND 出口改为结构化 `{"box_2d": [], "error": "..."}`（而非纯文本 NOT_FOUND）
- grounding rules 包含 CJK 文本处理规则（跨行取前 2-4 字、紧贴可见文本区域）

### 3.7 createChatClient 改造

```js
export function createChatClient({ url, key, model, adapter, fetchImpl, timeoutMs }) {
  return async function chat(prompt, { system, images, reasoning, maxTokens, ...opts }) {
    const endpoint = detectEndpoint(url);
    const reasoningParams = adapter?.reasoning?.buildParams(endpoint, reasoning) ?? {};
    const body = {
      model,
      messages: [...],
      temperature: opts.temperature ?? 0,
      max_tokens: Math.max(maxTokens ?? 4096, adapter?.maxTokensMinimum ?? 0),
      ...reasoningParams,
      ...adapter?.chatParams?.(endpoint, opts),
    };
    // ...fetch + retry
  };
}
```

**关键变化**：
- 接受 `adapter` 参数，自动注入 reasoning 参数
- `max_tokens` 不低于适配器的 `maxTokensMinimum`（hy4 ≥ 16k）
- system prompt 不再硬编码"只输出 JSON"，由 adapter.protocol 决定
- 支持 `reasoning` 选项传入 VLM 定位路径

## 四、实施计划

### Phase 1：基础设施（不改行为）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| 1.1 | 新增 CoordinateSpec + CoordinateCodec | coord/strategy.js 重构 | 现有 4 策略测试全绿 |
| 1.2 | 新增 adapter-resolver.js | coord/adapter-resolver.js | 单元测试 |
| 1.3 | 新增 locate-protocol.js | coord/locate-protocol.js | 提示词生成测试 |
| 1.4 | 新增 reasoning.js | coord/reasoning.js | 参数构建测试 |
| 1.5 | 收敛 family 清单为单一真源 | registry.js + model.js | inferFamilyFromName 改为读 registry |
| 1.6 | probe 缓存 key 纳入 modelName+baseUrlHash | coord/probe.js | 换模型后 probe 失效测试 |

### Phase 2：适配器迁移

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| 2.1 | default 适配器（当前 xy1000 行为） | adapters/default.js | 现有测试全绿 |
| 2.2 | tencent-hy 适配器 | adapters/tencent-hy.js | box_2d + thinking disabled |
| 2.3 | qwen-vl 适配器 | adapters/qwen-vl.js | bbox_2d + enable_thinking |
| 2.4 | deepseek 适配器 | adapters/deepseek.js | XML 标签 / 0-1000 point |
| 2.5 | kimi/gemini/gpt/doubao/minimax | adapters/*.js | 各自协议测试 |
| 2.6 | buildVlmLocate 迁移到 src/ | src/vlm/locate-factory.js | 三个调用点无缝切换 |
| 2.7 | createChatClient 接受 adapter | tools/ai.js | reasoning 参数注入测试 |

### Phase 3：集成验证

| # | 任务 | 验收 |
|---|---|---|
| 3.1 | .env.example 推荐模型改为 hy4-flash | 文档更新 |
| 3.2 | 问卷用例 hy4-flash 跑通 | answer_row=27 + 确认按钮点击成功 |
| 3.3 | 问卷用例 qwen3-vl-plus 跑通 | 同上 |
| 3.4 | deepseek-v4.1-flash 降级为粗筛/备选 | 文档标注精度限制 |
| 3.5 | 全量测试 + 文档对账 | 663+ tests 全绿 |

## 五、风险与缓解

| 风险 | 缓解 |
|---|---|
| 重构期间行为回归 | Phase 1 不改行为，Phase 2 逐个适配器迁移+测试 |
| hy4 网关不可用 | qwen3-vl-plus 作为同等精度备选 |
| 思考参数端点差异 | detectEndpoint + per-endpoint translator，实测验证 |
| probe 缓存迁移 | 新 key 格式兼容旧文件（读时忽略旧格式，下次 probe 重写） |
| AbsolutePixel 压缩错位 | GPT 适配器强制 imageDetail='original' 或自动 rescale |

## 六、不做的事

- 不引入 TypeScript（项目纯 JS）
- 不改 Pi SDK agent 路径的思考控制（已有完整机制）
- 不做流式响应（VLM 定位不需要）
- 不做多候选/置信度协议（当前单元素定位够用）
- 不改 visual-answer.js 的问卷作答逻辑（它走独立的 VLM 路径，后续可复用 adapter）

## 七、参考源码

- Midscene: `packages/core/src/ai-model/models/{registry,tencent-hy,qwen,gpt}.ts`
- Midscene: `model-adapter/{types,resolve,locate}.ts`
- Midscene: `shared/model-locate-result/{types,factory,pixel-mapper,prompt-spec}.ts`
- Midscene: `prompt/locate/{element-system-prompt,grounding-rules}.ts`
- 本项目现状: `src/device/coord/{strategy,registry,probe}.js`
- 评估报告: 对话记录中的 hy4/hy4-flash 视觉定位评估（2026-11-27）
