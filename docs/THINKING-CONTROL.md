# 模型思考控制定档（thinkingLevelMap）

> 依据：各家官方 API 文档 + 网关实测 `reasoning_tokens`。决策代码：`src/session/model.js` 的 `buildThinkingLevelMap(name)`。

## 一、结论：两类模型

| 类别 | 模型 | 默认最低档 | 网关收到的参数 |
|---|---|---|---|
| **可关闭思考** | DeepSeek / Qwen / MiniMax | `none`（关闭） | DeepSeek：`thinking={type:"disabled"}`；Qwen/MiniMax：`reasoning_effort="none"` |
| **不可关闭思考** | 智谱 GLM-5.3 / GLM-5.3-Flash / GLM-5.3-FlashX | `low`（最低有效档） | `reasoning_effort="low"` |

会话默认 `thinkingLevel='off'`（`src/session/create.js`），故 agent 循环默认即用到上表的最低档。

## 二、官方文档依据

| 厂商 | 能否关闭 | 有效参数 | 原文/依据 |
|---|---|---|---|
| **DeepSeek** | ✅ | `reasoning_effort: none`（=关闭）；`thinking.type: enabled/disabled` | api-docs.deepseek.com：`reasoning_effort` ∈ none/low/high/max，"none disables thinking mode" |
| **智谱 GLM-5.3 系** | ❌ **不能** | 仅 `low \| high \| max` | docs.bigmodel.cn：「GLM-5.3 会始终启用思考功能…**并不再支持禁用思考功能**」「仅支持开启思考，不支持禁用思考」；迁移说明：把 disabled 改为 enabled + `reasoning_effort=low`，**否则请求将失败** |
| GLM-5.2 及更早 / GLM-4.5+ | ✅ | `thinking.type: disabled` 或 `reasoning_effort: none/minimal` | docs.bigmodel.cn：GLM-4.5 及以上支持 `thinking`；GLM-5.2 传 none/minimal 会"放弃思考" |
| **阿里 Qwen3.x**（混合思考） | ✅ | `enable_thinking: false` | alibabacloud model-studio："set `enable_thinking` to `false`…the model responds directly" |
| Qwen3.8-2.4t-a95b / qwen3.7-max-preview / qwen3.7-max-2026-05-17 | ❌（thinking-only） | — | 同上 thinking-only 列表 |
| **MiniMax M 系列** | ✅（实测） | `reasoning_effort: none` | 文档页 404，以网关实测为准（关闭态 reasoning_tokens 归零） |

## 三、网关实测证据

数学题诱发、各取样 2 次的 `reasoning_tokens`：

| 模型 | 默认 | `none` | `low` | `thinking=disabled` |
|---|---|---|---|---|
| deepseek-v4.1-flash | 77,101 | 77,89 | 130,85 | **69,53** |
| **glm-5.3-flash** | 203,205 | **221,265（未降）** | 233,297 | 324,224 |
| glm-5.3 | 11 | **161（未降反升）** | **10** | — |
| qwen3.8-flash | 72,17 | 95,73 | 23,85 | 87,62 |
| qwen3.7-plus | 289,296 | 302,300 | 264,325 | 305,264 |
| minimax-m3.1-flash | 56,66 | 89,75 | 83,72 | **60,68** |

**关键**：网关对任何参数都不报错（宽松代理），**不能靠"是否报错"判断能力**，要看 `reasoning_tokens` 是否真降。
GLM-5.3 传 `none` 时推理 token 不降（glm-5.3 甚至 11→161）→ 说明 `none` 被忽略，与官方"不能关闭"一致；`low` 才是其最低有效档。

## 四、为什么不直接对所有模型发 `none`

- 对 GLM-5.3：`none` 被静默忽略（等于没配），且官方明示过渡期"请求将失败"；
- 用户要求：**能关的关掉，不能关的直接设 low**。故按模型能力分流。

## 五、维护

新增模型时判断其"能否关闭思考"：
- 能关 → 走 `none`（默认分支，无需改代码）；
- 不能关 → 在 `buildThinkingLevelMap` 的正则里加入（如未来 GLM-5.4 系若延续"不可关闭"，扩展正则）。
