# 开源项目上下文压缩方案调研

> 目的：为 android-scene-kit 的"步骤上下文保留"特性（默认前 3 步 + 整体描述，范围可配置）提供设计依据。
> 调研时间：2026-10-30。来源均为公开文档/博客/论文/issue。

## 一、各项目做法

### 1. OpenHands（原 OpenDevin）—— 系统侧 Condenser 流水线
- 架构：Condenser 在事件流（event stream）进 LLM 前做**有界视图**（condensed view），事件历史本身仍完整落盘。
- 默认 `LLMSummarizingCondenser`：把旧事件用一次 LLM 调用总结成摘要；另有滚动截断（rolling truncation）、关键细节提取器等，可组合成流水线。
- 要点：**压缩是确定性的系统组件，不是模型自觉**；策略可插拔、可组合。
- 参考：[Condenser 架构](https://docs.openhands.dev/sdk/arch/condenser) · [Context Condenser 指南](https://docs.openhands.dev/sdk/guides/context-condenser) · [官方博客](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents)

### 2. MemGPT / Letta —— 模型自管内存（分页）
- 把 LLM 上下文当"主存"，外部存储当"磁盘"，**模型自己通过 function calling 在两者间换页**（类似操作系统虚拟内存）。
- 优点：语义级取舍最准；代价：额外轮次与不稳定性——不适合我们这种"每步 0 往返"的引擎化定位。
- 参考：[MemGPT 论文](https://arxiv.org/abs/2310.08560) · [研究站](https://research.memgpt.ai)

### 3. Claude Code —— 阈值触发全量摘要（auto-compact）
- 接近上下文上限时把**整段对话总结成一段 prose** 替换历史。
- 社区最大抱怨（issue #22467）：**最近若干轮被一并摘要、无原文保留**，模型丢失近期细节——"保留最近 N 轮原文 + 摘要"正是社区在要的方向。
- 参考：[auto-compact 行为讨论](https://github.com/cline/cline/issues/9599)（同类现象）；Claude Code compaction 相关 issue #22467/#6123/#66144。

### 4. Manus —— KV-cache 优先的上下文工程
- 核心论断：**KV-cache 命中率是 agent 第一指标**（prefill 远贵于 decode）。
- 规则：上下文**只追加不修改**（append-only，前缀稳定才有缓存）；"**mask, don't remove**"——用 logit mask 控制动作空间而不是删历史；状态卸载到文件系统；目标前置复述（todo.md）；错误留在上下文里供自愈。
- 对我们的启示：**剪枝只能动历史尾部，不能动前缀**（system prompt + 用例开头一旦变了，整轮缓存全失效）。
- 参考：[Manus 博客](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) · [Anthropic: Effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)

### 5. Cline —— 阈值触发"保近摘要远"
- ~85% 窗口时自动 condense：**最近消息原文保留，更早的总结**（"summarize half the conversation"）。
- 已知问题：condense 仍有信息损失（issue #9599）；大 stdout 直接撑爆窗口（issue #4419）——与我们"uitree 结果截断"同构。
- 参考：[issue #9599](https://github.com/cline/cline/issues/9599) · [discussion #1788（可配置窗口）](https://github.com/cline/cline/discussions/1788)

### 6. browser-use —— 历史消息摘要版发送 + hooks
- 提案：发给 LLM 的是**历史的摘要版**而非全量（issue #780）；提供 hooks 在执行各阶段注入自定义裁剪逻辑。
- 参考：[issue #780](https://github.com/browser-use/browser-use/issues/780) · [hooks 文档](https://docs.browser-use.com/open-source/customize/hooks)

### 7. 生态位参照
- LangChain `summarizationMiddleware`：现成的"保近摘要远"中间件。
- 行业综述共识：**截断省 token 但丢上下文快，LLM 摘要保语义但贵一轮**；生产主流是两者结合 + 阈值触发。
- 参考：[MachineLearningMastery 综述](https://machinelearningmastery.com/context-window-management-for-long-running-agents-strategies-and-tradeoffs)

## 二、共性模式提炼

| 模式 | 采用者 | 对我们的适用性 |
|---|---|---|
| 保留最近 N 步原文 + 更早折叠为摘要 | Claude Code 社区诉求、Cline、LangChain | ✅ 直接采用（默认 N=3） |
| 阈值触发 vs 每步常开 | Cline/CC 用阈值；OpenHands 可常开 | 我们步数少（10-40 步）且单步载荷大，**每步常开**更简单可预测 |
| LLM 摘要 vs 确定性摘要 | OpenHands/MemGPT 用 LLM；Manus 用结构化文件 | ✅ **确定性摘要**（0 额外轮次，结果可复现；引擎步本就 0 往返） |
| 前缀稳定（append-only） | Manus | ✅ 折叠只动历史中后段，system + 首部不动 |
| 错误/断言结果留在上下文 | Manus | ✅ 摘要中显式保留断言通过与失败 |
| 模型自管内存 | MemGPT | ❌ 与引擎化定位冲突，不采用 |

## 三、我们的设计（结论）

1. **分段**：以步骤为"帧"——每步结束时（finally，唯一记账点）记录该步产生的消息数增量，一段 = 一步产生的全部消息（引擎步产生 0 条，但出现在摘要里）。
2. **窗口**：默认保留**最近 3 步**的原文（prompt/回答/已折叠的工具文本）；更早步骤从历史中移除，替换为一条**确定性"整体描述"**（用例名、进度、最近步骤行、断言通过数、已落库数据集计数、变量）。
3. **可配置**：用例 YAML 顶层 `context: all | <N>`；CLI `--context-steps=<N|all>`；CLI > YAML > 默认 3。
4. **确定性摘要**：不用 LLM 总结（省一轮往返、结果可复现、UI 测试步骤语义本就窄，一行 `#12 tap_each_row 27题全答 ✓` 足够）。
5. **前缀不动**：system prompt 与摘要消息都只追加/替换中后段，保 KV-cache。
