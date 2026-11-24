# 架构总览：Agent / ADB / 模型 的调用关系

> 依据实际代码（`bin/ask.js`、`src/{session,tools,device,mcp,store,recorder}/`）整理，2026-10-27。
> 校验：`npm run docs:check` 会验证本文 mermaid 图可渲染。

## 1. 分层全貌（严格单向依赖）

```mermaid
flowchart TD
  subgraph L0["CLI 入口层"]
    CLI["bin/ask.js<br/>run / do / ask / data / lint / doctor / mcp"]
    CLISUP["src/cli/<br/>argv · lock · workspace · device-facts · pregrant"]
  end

  subgraph L1["会话层（Pi 装配）"]
    SESS["src/session/create.js<br/>createRunContext · createAskSession"]
    PROMPT["prompt.js<br/>三层提示词 L1/L2/L3"]
    MODELF["model.js<br/>ModelRuntime.registerProvider"]
    PERSIST["persist.js<br/>keep/fresh/continue/session"]
    CASE["case.js<br/>YAML 解析 · 引擎直执行映射"]
  end

  subgraph L2["工具层（23 个 agent 工具）"]
    TOOLS["src/tools/index.js<br/>buildTools(ctx) + 记账包装"]
    TOOLFILES["perception · action · env · data · mcp<br/>+ locate-cache · ai"]
  end

  subgraph L3["数据/报告层"]
    STORE["src/store/<br/>dataset · query"]
    REC["src/recorder/index.js<br/>RunRecorder → run.json"]
  end

  subgraph L4["设备层（自研 adb）"]
    DEV["src/device/index.js<br/>createDevice 门面"]
    DEVMOD["adb · screen · uitree · cache · locate<br/>action · input · rollout · state · popup · coord/"]
  end

  subgraph L5["外部依赖"]
    PI["@earendil-works/pi-coding-agent<br/>agent 循环 + 模型客户端"]
    ADBEXE["adb.exe"]
    DEVICE["Android 设备/模拟器"]
    GATEWAY["模型网关<br/>u2a.lycodeing.cn（OpenAI 兼容）"]
    MCP["MCP server（stdio/http）"]
  end

  CLI --> CLISUP
  CLI --> SESS
  CLI --> CASE
  CLI --> STORE
  CLI --> REC
  CLI --> DEV
  SESS --> PROMPT
  SESS --> MODELF
  SESS --> PERSIST
  SESS --> TOOLS
  TOOLS --> TOOLFILES
  TOOLFILES --> DEV
  TOOLFILES --> STORE
  TOOLFILES --> REC
  DEV --> DEVMOD

  SESS -.->|装配 agent 循环| PI
  MODELF -.->|注册 provider| PI
  PI -.->|HTTP chat/completions| GATEWAY
  DEVMOD -.->|spawn| ADBEXE
  ADBEXE -.->|shell / exec-out| DEVICE
  TOOLFILES -.->|MCP 桥| MCP
```

**依赖方向铁律**（契约 §2.2）：`bin/ask.js → session → tools → {device, net, store, mcp}`。
下层不认识上层；`tools` 内**只调 `ctx.device` 门面，禁止直接跑 adb**。

## 2. 一次 `ask run <case>` 的完整调用时序

```mermaid
sequenceDiagram
  autonumber
  participant U as 用户
  participant CLI as bin/ask.js
  participant Lock as 设备锁
  participant Dev as 设备门面 createDevice
  participant Adb as adb.exe
  participant Rec as RunRecorder
  participant Case as case.js 解析器
  participant Sess as createAskSession
  participant PI as Pi agent 循环
  participant GW as 模型网关
  participant Tool as 工具层 buildTools
  participant Store as dataset

  U->>CLI: ask run c1.yaml --yes
  CLI->>Lock: acquireLock(lockRoot, serial)
  CLI->>Dev: createDevice({serial, probeFile})
  Dev->>Adb: get-state / waitForBoot（sys.boot_completed + wm size）
  Adb-->>Dev: 设备就绪
  CLI->>Rec: new RunRecorder(runsDir, caseName, model)
  CLI->>Case: parseCaseText(yaml)
  Case-->>CLI: steps[]（ai/aiTap/aiAssert/aiWaitFor/net/sleep…）
  CLI->>Sess: createAskSession({systemPrompt, model, customTools})

  rect rgb(240,245,255)
  note over Sess,GW: ① 主模型链路：agent 自主决策（ai / aiAssert / aiQuery）
  Sess->>PI: createAgentSession(customTools, noTools:'builtin')
  PI->>GW: POST /chat/completions（含 23 工具定义）
  GW-->>PI: assistant 消息 + tool_calls
  end

  rect rgb(245,255,240)
  note over CLI,Adb: ② 引擎直执行链路：0 轮模型往返（aiTap/aiScroll/uiDump/launch…）
  CLI->>Tool: buildToolCall(step) → tool.execute(params)
  end

  loop 每个 step
    Tool->>Dev: locate / tap / scroll / screencap / dumpTree
    Dev->>Adb: adb -s <serial> shell|exec-out <cmd>
    Adb-->>Dev: stdout/Buffer
    Dev-->>Tool: {ok, bounds, strategy, …}
    Tool->>Store: data_extract/data_store → 落 dataset
    Tool->>Rec: startStep/end（含截图、locate 透传）
    Tool-->>CLI: 结构化结果
    opt 模型步骤（ai/aiAssert）
      CLI->>Sess: session.prompt(stepText)
      Sess->>PI: 继续 agent 循环
      PI->>GW: 下一轮 chat/completions
    end
  end

  Note over CLI,Rec: 收尾：restoreNetwork（finally）→ recorder.finish → run.json + 截图
  CLI->>Lock: releaseLock
  CLI-->>U: exit code（0 pass / 1 fail / 2 环境错误）
```

## 3. 三个模型调用点（都在 Pi SDK 内部，本 kit 只做装配）

```mermaid
flowchart LR
  subgraph KIT["OmniPilot（本仓库，曾用名 OmniScene / android-scene-kit）"]
    A["session/model.js<br/>registerProvider(baseUrl, apiKey, models)"]
    B["session/create.js<br/>createAgentSession(customTools)"]
    C["tools/ai.js<br/>createChatClient（小模型，注入式）"]
  end

  subgraph PI["Pi SDK"]
    D["agent 循环<br/>（工具调用 → 结果回传 → 续轮）"]
    E["OpenAI 兼容客户端"]
  end

  GW["模型网关<br/>u2a.lycodeing.cn/v1"]

  A -->|"注册 family/baseUrl/key"| E
  B -->|"装配循环 + 23 工具"| D
  D --> E
  C -->|"直接 fetch /chat/completions"| GW
  E -->|"HTTP"| GW

  C -.->|"data_extract(mode=ai) 提取页面数据<br/>VLM 兜底定位"| GW
```

**三个调用点**：

| # | 位置 | 用途 | 触发 |
|---|---|---|---|
| 1 | Pi agent 循环（`createAgentSession`） | **主模型**，决定调哪个工具 | `ai` / `aiAssert` / `aiQuery` 步骤 |
| 2 | `createChatClient`（`src/tools/ai.js`） | **小模型**：AI 数据提取 | `data_extract(mode=ai)` |
| 3 | 同上（VLM 注入 `ctx.vlm`） | **VLM 兜底定位** | 定位链末端（`--vlm-locate`） |

> 实测：主模型单轮往返 **deepseek-v4.1-flash 3.7s** vs **glm-5.3-flash 16.2s**（差 4.4×）。
> `thinkingLevelMap` 把 `off` 映射为 `reasoning_effort: 'none'`（deepseek 敏感：14.8s → 1.7s）。

## 4. 设备层内部（`createDevice` 门面之下）

```mermaid
flowchart TD
  F["createDevice 门面<br/>src/device/index.js"]
  subgraph CORE["感知"]
    SC["screen.js<br/>screencap(exec-out) · wm size"]
    UT["uitree.js<br/>parseXmlDump · flattenNodes · treeHash"]
    CA["cache.js<br/>树缓存三态 fresh/dirty/void TTL 4000ms"]
    LO["locate.js<br/>策略链：exact_text→regex→resource_id→class_index→vlm<br/>R2 identity 校验"]
    CO["coord/<br/>strategy×4 · registry · probe"]
  end
  subgraph ACT["操作"]
    AC["action.js<br/>tap/longPress/swipe/key（bounds 中心）"]
    IN["input.js<br/>yadb 中文输入 + 回读校验"]
    RO["rollout.js<br/>定位失败回退 + 步骤回滚"]
  end
  subgraph ENV["环境"]
    ST["state.js<br/>ResumedActivity 判前台 · pidof"]
    PO["popup.js<br/>系统弹窗侦测/关闭"]
  end
  AD["adb.js<br/>串行队列 · 单命令超时 · 断连重连<br/>shell(文本) / exec-out(二进制)"]

  F --> SC & UT & CA & LO & AC & IN & RO & ST & PO
  LO --> CO
  SC & UT & CA & AC & IN & ST --> AD
  AD -->|"spawn"| EXE["adb.exe"]
  EXE -->|"shell / exec-out"| DV["Android 设备"]
```

## 5. 产物落点（运行时产物与源码分离）

```mermaid
flowchart LR
  CLI["bin/ask.js"]
  WS["<ASK_HOME>/<日期>/<实例>/<br/>（默认 C:/opt/omni-pilot）"]
  G["<ASK_HOME>/.ask/<br/>全局（跨实例）"]

  CLI -->|"case/ 用例"| WS
  CLI -->|"run/ run.json + step-*.png"| WS
  CLI -->|"dataset/ *.jsonl"| WS
  CLI -->|"report/ HTML"| WS
  CLI -->|"locks/ 设备锁（必须全局）"| G
  CLI -->|"family-probe.json 坐标探测缓存"| G
```

## 6. 单次定位（`locate`）的内部策略链

```mermaid
flowchart TD
  T["target 文本"] --> P["parseTarget<br/>exact_text/regex/resource_id/class_index/auto"]
  P --> H{"有 hint（坐标缓存）？"}
  H -->|是| R2["R2 校验<br/>nodeAtBounds + sameIdentity"]
  R2 -->|通过| CACHE["strategy=cache ✅ 命中"]
  R2 -->|不通过| CHAIN
  H -->|否| CHAIN["策略链逐个尝试"]
  CHAIN --> S1["exact_text"]
  S1 -->|未命中| S2["regex / contains"]
  S2 -->|未命中| S3["resource_id"]
  S3 -->|未命中| S4["class_index"]
  S4 -->|未命中| S5{"注入了 vlm？"}
  S5 -->|是| VLM["VLM 兜底（截图→模型→坐标换算）"]
  S5 -->|否| MISS["LOCATE_MISS + 候选列表"]
  S1 & S2 & S3 & S4 --> CK["resolveClickable<br/>不可点节点 → 向上找可点祖先/子孙"]
```

## 7. 关键设计约束（来自 CONTRACT-CORE.md）

| 约束 | 内容 |
|---|---|
| 依赖方向 | `bin → session → tools → {device, net, store, mcp}` 严格单向 |
| 工具边界 | 工具**只调 `ctx.device` 门面**，禁止直接跑 adb（保证可 mock、可替换） |
| 23 个工具 | 感知 5 · 操作 8 · 环境 5 · 数据 5（+MCP 动态） |
| 设备锁 | **全局**（`<ASK_HOME>/.ask/locks/`），跨实例共享——否则锁失效 |
| 产物分离 | 用例/记录/数据/报告落工作区，不污染源码树 |
| 截图双份 | 报告用**原图**（取证）；进模型上下文用 **JPEG 压缩**（省 78% tokens） |
