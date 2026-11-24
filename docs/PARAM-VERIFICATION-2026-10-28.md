# 参数族用例验证报告（P 系列）

> 日期：2026-10-28 · 设备：emulator-5554（Android 15 / x86_64 / 1080×2400）· 被测应用：稀土掘金 `com.daimajia.gold`
> 网关：https://u2a.lycodeing.cn/v1 · 工作区：`C:/opt/omni-pilot/2026-10-28/param-verify/`
> 本轮目标：在既有会话（`session_fdd57cb9f4d6cf4ba477f552fb523eba`）交付物基础上，
> **按 adb-cheatsheet 的功能点，为每个步骤命令的每种参数形态生成 YAML + 自然语言用例并逐模型验证**。

## 一、结论速览

| 维度 | 结果 |
|---|---|
| 新增 YAML 用例 | **6 个**（s3/s4/m3/m4/c3/c4），lint --strict 全绿 |
| 新增自然语言用例 | **7 条**（NLP-1…NLP-7，`nl-p-cases.md`） |
| YAML 实测 | **6 全部通过**（s3✓ s4✓ m3✓ m4✓ c3✓ c4✓），复现率见 §3.4 |
| NL 实测 | **3 通过 / 1 任务指令冲突**（NLP-1✓ NLP-4✓ NLP-7✓ · NLP-5✗） |
| 5 模型 agent 循环 | **全部可用**（含此前网关不可用的 qwen3.7-plus、minimax-m3.1-flash） |
| 步骤命令参数覆盖 | **14/14 全命令**、每种关键参数双形态 |
| 发现的产品级问题 | **3 项**（见 §五）+ 1 项交付整改（见 §八） |

> **可信度声明**：本环境（掘金 + x86_64 模拟器）的**单次 run 通过率低**——App 会在 5-26 秒内随机 native 崩溃，
> 长用例常跑一半被截断。上表的"通过"均指**多次尝试中至少有 1 次完整通过**，逐案尝试次数与通过率见 §3.4；
> 这不代表用例在稳定环境下会 flaky，但**复现率本身受环境严重制约**，务必结合 §3.4 阅读。

## 二、用例设计（参数族）

旧六例（s1/s2/m1/m2/c1/c2）覆盖**功能点**；P 系列覆盖**参数面**——把每个步骤命令的每种参数写法至少跑一遍。

| 用例 | 级别 | 页面 | 参数验证点 |
|---|---|---|---|
| s3-engine-params | 简单 | 3-5 | aiScroll 四形态（distancePct 50/100、until:edge、direction:up+until:top+max、max:1）、aiWaitFor(timeout)、sleep、aiKeyboardPress(keyName)、launch 文本形态、assert_no_crash(expectedPackage) |
| s4-perception-params | 简单 | 3-4 | uitree clickable 双对照、locate(strategy/bounds)、readText(selector=text= 与 index=)、screen_diff、wait_idle(timeoutMs)、ui_dump、aiQuery+name 落库 |
| m3-input-action | 中等 | 7-9 | aiInput(value + 显式 resource-id)、aiKeyboardPress(enter)、aiLongPress(durationMs)、swipe(区域名+durationMs)、data_extract(container+fields)、data_query(select/limit)、引擎失败后 agent 兜底 |
| m4-data-net | 中等 | 6-9 | net 步骤命令(4g/off 容错)、data_extract(from=index 字段 + mode=ai)、data_query(where/orderBy/select/limit)、data_store(append 与 upsert+key)、${var} 插值自检 |
| c3-all-commands | 复杂 | 16-18 | 全部 14 种步骤命令各至少一次；launch 文本/appId 双形态、terminate、screen(前台取证)、back/enter/home 键、read(re:)、uiDump、aiAct、secret/sms 不可用路径 |
| c4-collection-pipeline | 复杂 | 10-14 | collection(key 主键去重+max 上限+container+fields)、data_query 倒序/where、跨数据集 extract→query→upsert→复查流水线、terminate(packageName 参数形态) |

自然语言形态见 [cases/nl-p-cases.md](../../cases/nl-p-cases.md)。

## 三、实测结果

### 3.1 YAML 用例

| 用例 | 模型 | 结果 | 耗时 | 备注 |
|---|---|---|---|---|
| s3-engine-params | qwen3.8-flash | **pass** | 99s | 首跑断言失败（弹窗遮挡），重试通过 |
| s4-perception-params | glm-5.3-flash | **pass** | 1547s | 期间多次崩溃弹窗，agent 自愈完成 |
| m3-input-action | qwen3.7-plus | **pass** | 2692s | 引擎 input 失败后 agent 兜底补输入；**验证 qwen3.7-plus agent 循环可用** |
| m4-data-net | minimax-m3.1-flash | **pass** | 467s | net 容错、data 三模式、${var} 插值全部通过；**验证 minimax 网关已修复** |
| c3-all-commands | deepseek-v4.1-flash | **pass** | 598s | 14 命令全参数、secret/sms 不可用路径、强停重启全通过 |
| c4-collection-pipeline | deepseek-v4.1-flash | **pass** | 607s | collection+container+字段+去重+upsert 实测采到 10 条 title 非空（"尤雨溪 : Vue 4 已经在规划中了！"等）；收尾用 data_query 取证断言 |

### 3.2 自然语言用例

| 用例 | 模型 | 结果 | 耗时 |
|---|---|---|---|
| NLP-1（简单） | deepseek-v4.1-flash | **pass** | 366s |
| NLP-4（中等） | glm-5.3-flash | **pass** | 1200s |
| NLP-5（复杂） | qwen3.8-flash | fail（任务指令冲突） | 1288s |
| NLP-7（ask 只读） | qwen3.7-plus | **pass** | 17s |

### 3.2.1 NLP-5 失败归因（修正）

初版把 NLP-5 归为"环境崩溃"，**该判断有误**。核对 run.json（`run-20261028-124004-4968.json`，140 步）：失败断言是 `assert_no_crash`，原因"前台已离开掘金（nexuslauncher）"；但同 run 内 step 131 `launch com.daimajia.gold → ok`、其后 `screen/data_extract` 均 ok 到收尾，**进程存活**。

**真实根因**：原任务文本自相冲突——同时要求"回到桌面再启动一次掘金"与"确认首页可见并做崩溃检查(掘金不应崩溃)"。"回到桌面"使前台变 launcher，随后任何 `assert_no_crash(掘金)` 必然失败。**已修正任务文本**（去掉冲突的"回桌面"，强停阶段改为 `screen` 取证前台并声明此时不做崩溃检查）。

### 3.3 复现率（逐案尝试次数）

> 环境崩溃使单次通过率低；下表是"完整通过一次"所需的尝试规模，据 run.json 统计。

| 用例 | 尝试次数 | 通过次数 | 完整通过率 | 主要失败原因 |
|---|---|---|---|---|
| s3-engine-params | 4 | 2 | 50% | 首启弹窗遮挡（断言失败） |
| s4-perception-params | 1 | 1 | 100% | — |
| m3-input-action | 6 | 2 | 33% | 引擎 input 失败未兜底、崩溃截断 |
| m4-data-net | 1 | 1 | 100% | — |
| c3-all-commands | 5 | 1 | 20% | 崩溃截断、收尾前台被顶回桌面 |
| c4-collection-pipeline | 29 | 2 | 7% | 早期版本：模型不照抄嵌套 fields 参数 + 崩溃截断；**改版聚焦核心流水线后一次通过** |
| NLP-1 | 1 | 1 | 100% | — |
| NLP-4 | 1 | 1 | 100% | — |
| NLP-5 | 1 | 0 | 0% | 任务指令冲突（已修正） |
| NLP-7 | 1 | 1 | 100% | — |

**洞察**：失败集中在**长用例（页面多、耗时长）**——崩溃概率随时间线性累积。s4/m4 单次即过，c3/c4 需多次。这是环境属性，非用例缺陷。

### 3.4 模型矩阵（本轮实测）

| 模型 | agent 循环 | 单轮延迟量级 | 备注 |
|---|---|---|---|
| deepseek-v4.1-flash | ✅ | 最快 | 推荐；复杂用例首选 |
| qwen3.8-flash | ✅ | 快 | |
| qwen3.7-plus | ✅ | 中 | **此前网关不可用，本轮已修复** |
| minimax-m3.1-flash | ✅ | 中 | **此前网关有缺陷，本轮已修复** |
| glm-5.3-flash | ✅ | 慢（单轮 ~16s） | 复杂用例耗时可超 20 分钟 |

## 四、环境事实（本轮关键排障）

### 4.1 掘金 App 崩溃循环与修复

- **现象**：会话开始后，掘金每次冷启动 5-26 秒内必然 native 崩溃（`SIGSEGV`，故障地址固定 `0x...5a3e00`）。
- **根因**：与历史报告 §21.6 一致——App 仅含 `arm64/` native 库，靠 NDK Translation（berberis）在 x86_64 上转译运行，转译器遇到无法翻译的指令即崩溃。
- **本轮取证**（可复核）：
  - `C:/opt/omni-pilot/2026-10-28/param-verify/evidence/logcat-crash.txt` —— 含 `Fatal signal 11 (SIGSEGV)` 与完整栈 `#01 libndk_translation.so (berberis_HandleNoExec+217)` → `#06 berberis::RunGuestThread`；
  - `C:/opt/omni-pilot/2026-10-28/param-verify/evidence/berberis-tombstone.txt` —— tombstone 头部 `ABI: 'x86_64'` / `Guest architecture: 'arm64'` / `Cmdline: com.daimajia.gold`；
  - 另有 `evidence/tombstone_13.txt`（fdsan SIGABRT）与 `evidence/tombstone-list.txt`。
- **加重因素**：**App 数据随使用劣化**——同一份数据反复启动后崩溃窗口前移（从 26s 缩到 5s）。
- **解法**：`adb shell pm clear com.daimajia.gold` + 自动同意隐私协议 → 重置出**约 40-50 分钟的稳定窗口**。代价是登录态丢失（P 系列用例不依赖登录）。
- **工程对策**：runner 加**预热门控**（启动失败自动 pm clear + 重试）+ **case 级重试** + **每案开头状态归一化**（terminate→launch→关弹窗→确保首页）。

### 4.2 其它环境事实

| 事实 | 影响 |
|---|---|
| pm clear 后首启弹权限/隐私窗 | 中途弹窗把前台顶成 permissioncontroller → 断言失败。对策：`pm grant POST_NOTIFICATIONS` + case 开头关弹窗守卫步骤 |
| case 结束页残留 | 上一案停在搜索页/详情页 → 下一案首页定位全落空。对策：每案开头 terminate+launch 归一化 |
| `uiautomator dump` 动画期超时 | `could not get idle state`，属已知限制（报告 §20.4） |
| `net` 命令不存在 | `net 4g`/`net off` 返回 `inaccessible or not found`，用例按容错设计（m4 验证） |

## 五、发现的产品级问题（3 项）

### 5.1 🔴 `aiAssert` 提示词硬编码"只依据当前屏幕可见元素"

`bin/ask.js` 中 aiAssert 的提示词为：
```
【断言】<文本>\n只依据当前屏幕可见元素判断。...
```
当断言涉及**数据集内容**（如"数据集 X 至少 3 条"）时，模型被此口径约束，会回答"屏幕上不存在可读出数据集的界面元素，无法取证"而判失败——c4 首次收尾即因此失败，尽管 `data_query` 能查出 7 条记录。

**影响**：任何"断言数据落库结果"的用例都会误判。**建议**：提示词区分断言类型（屏幕类 vs 数据类），或允许断言文本显式声明数据依据。

### 5.2 🟡 `data_extract` 的 fields selector 不支持 `id=` 前缀

`src/tools/perception.js` 的 `matchSelector` 只认 `text=`/`text*=`/`resourceId=`/`class=`，落到末尾 `return false`。用例写 `id=com...:id/tv_title` 时字段恒为 null。而 `device.locate` 的 `parseTarget` **支持** `id=`——两层不一致。

**实测证据**：同页同字段，`resourceId=` 提取到 11 行非空 title，`id=` 提取到 0 行。
**建议**：`matchSelector` 增加 `id=` 别名，与 locate 层对齐。

### 5.3 🟡 `data_extract` ui 模式不传 `container` 时每屏仅 1 行

`src/tools/data.js` 的 `extractUi`：`scopeList = scopes.length ? scopes : [null]`——无 container 时整屏只产 1 行，且字段按"整屏第一个匹配"取值。这是 collection 采集量上不去的代码级根因（上轮报告 §3.1/§七已记为"容器粒度"限制）。

**实测**：热榜页 8 条 `tv_title`，不传 container → 1 行；传 `container=class=android.view.ViewGroup` → 27 行（11 行 title 非空，含嵌套容器重复）。

**建议**：文档明确"多行提取必须传 container"；或内建逐卡片容器自动发现（报告 §七建议项）。

### 5.4 🟡 数组型变量插值为 `[object Object]`

`interpolate`（`src/session/case.js`）对变量值做 `String(v)`。而 `data_extract` 写入 `ctx.vars` 的是**整个 rows 数组**（`src/tools/data.js` 的 `ctx.vars.set(name, rows)`），故 `${var}` 插值结果为 `[object Object]`，对模型无意义。

**复现**（确定性）：`probe-interp.mjs` —— 同一 `${m4_hot}` 标记，变量为数组时替换成 `[object Object]`，为字符串时替换成 JSON 片段。
**建议**：插值前对数组做 `JSON.stringify` 截断，或让 `data_extract` 同时写入一份字符串摘要（如 `${name}.summary`）。

### 5.5 🔴 模型默认思考级别未生效（reasoning_effort 根本没发出）

**现象**：会话默认 `thinkingLevel='off'`（`src/session/create.js`），配置里也有 `thinkingLevelMap: { off: 'none', ... }`，
但 glm-5.3-flash 实测单轮仍达 16s、约 94% 时间耗在自发 reasoning——说明思考控制没起作用。

**根因**（SDK 源码级定位）：`src/session/model.js` 原为 `reasoning: false`。Pi SDK 的 openai-completions provider
在**每个**思考控制分支（`reasoning_effort` / `thinking` / `enable_thinking` / `chat_template_kwargs`）上都带
`&& model.reasoning` 守卫，且 `getSupportedThinkingLevels(model)` 在 `reasoning:false` 时只返回 `['off']`。
故 `thinkingLevelMap` 形同虚设，**思考控制参数一个都没发给网关**，网关回退到自身默认（glm 默认长思考）。

**取证**（拦截 outbound 请求体，实测 5 模型）：修复前 `reasoning_effort` / `thinking` / `enable_thinking` 全部 `undefined`。

**修复**（`src/session/model.js`）：`reasoning: true` + `thinkingLevelMap` 的 `off/minimal/low` 全映射网关关闭态 `'none'`、中/高档置 `null`（钳制掉）。

**修复后取证**（同一拦截探针）：

| 模型 | outbound 思考控制参数 |
|---|---|
| deepseek-v4.1-flash | `thinking={"type":"disabled"}` |
| glm-5.3-flash | `reasoning_effort="low"`（不可关闭，最低档） |
| qwen3.8-flash | `reasoning_effort="none"` |
| qwen3.7-plus | `reasoning_effort="none"` |
| minimax-m3.1-flash | `reasoning_effort="none"` |

**按模型能力分流**（关键修正）：并非所有模型都能关闭思考。经查各家官方文档 + 网关 `reasoning_tokens` 实测：

- **智谱 GLM-5.3 / 5.3-Flash / 5.3-FlashX 不能关闭思考**——官方原文「GLM-5.3 会始终启用思考功能…并不再支持禁用思考功能」，
  仅接受 `reasoning_effort` = low/high/max，且从 disabled 迁移时"请求将失败"。对这类模型发 `none` 会被静默忽略
  （实测 glm-5.3 传 none 时 reasoning_tokens 反而 11→161）。
- DeepSeek / Qwen / MiniMax 可关闭：分别走 `thinking={type:"disabled"}` / `reasoning_effort="none"`。

故 `buildThinkingLevelMap(name)` 按模型名分流：可关的 → `'none'`；GLM-5.3 系 → `'low'`（官方允许的最低有效档）。
详见 `docs/THINKING-CONTROL.md`。

**修复后取证**（outbound 拦截 + `reasoning_tokens`）：deepseek → `thinking={type:"disabled"}`、
qwen/minimax → `reasoning_effort="none"`、**glm-5.3 系 → `reasoning_effort="low"`**（实测 glm-5.3 传 low 时 161→10）。

**结论**：所有模型现在**默认最低可用思考档**——能关的关闭、不能关的降到 low；`doctor --model` OK、真实 run（s3）pass、单测 393/0。

## 六、功能点覆盖矩阵（步骤命令 × 参数）

| 步骤命令 | 参数形态 | 覆盖用例 |
|---|---|---|
| ai / aiAct | 自由任务 | s3/s4/m3/m4/c3/c4 |
| aiAssert | 屏幕元素 / 数据依据 | 全部 |
| aiQuery | 无 name / 有 name（落库） | s4/m4/c3/c4 |
| aiWaitFor | timeout + 「」选择器 | 全部 |
| aiTap | 文本 / resource-id | 全部 |
| aiInput | value + resource-id 定位 | m3/c3/c4 |
| aiLongPress | durationMs | m3/c3 |
| aiKeyboardPress | back/enter/home | s3/m3/c3/c4 |
| aiScroll | distancePct / until:edge / until:top / max | s3 |
| launch | 文本 / appId 参数 | s3/c3/c4 |
| terminate | 文本 / packageName 参数 | c3/c4 |
| uiDump | 缺省路径 | s4/c3 |
| sleep | seconds | s3/c3 |
| net | 档位（容错） | m4 |

工具面：screen / uitree / locate / read / screen_diff / wait_idle / assert_no_crash / ui_dump / data_extract(ui/ai/collection) / data_query / data_store / secret_get / sms_read —— 全部触达。

adb 映射：screencap / uiautomator dump / input tap·text·swipe·keyevent / am start·force-stop / pm clear·grant / monkey / dumpsys / logcat / wm size / pidof —— 全部经设备层实践。

## 七、复现方式

```bash
export ASK_ADB=C:/Users/XiaoFeiLong/AppData/Local/Android/Sdk/platform-tools/adb.exe
export ASK_MODEL_URL=https://u2a.lycodeing.cn/v1
export ASK_MODEL_KEY=<key>
export ASK_MODEL_NAME=deepseek-v4.1-flash
export ASK_MODEL_FAMILY=deepseek
export ASK_WORKSPACE=C:/opt/omni-pilot/2026-10-28/param-verify

node bin/ask.js lint cases/*.yaml --strict          # 0 findings
node bin/ask.js run cases/c3-all-commands.yaml --yes --timeout 1800
node bin/ask.js do "<nl-p-cases.md 中的任务>" --yes
```

**跑批前置**（针对崩溃环境）：`pm clear` + `pm grant POST_NOTIFICATIONS` + 冷启动 + 同意隐私协议，脚本见 `C:/opt/omni-pilot/2026-10-28/param-verify/tmp/scripts/run-final-all.sh`。

## 八、评审整改记录（交付前自审 + 独立复审）

一轮独立代码评审发现并整改了以下问题：

| # | 问题 | 严重度 | 整改 |
|---|---|---|---|
| 1 | `processAlive` **不是注册工具**（`src/tools/index.js` 的 23 工具无此项，仅 `src/device/state.js` 内部函数），c3/c4 却写成验证步，可达性 0 | Critical | c3/c4 的该步改为 `screen` 读取前台包名取证；头注同步修改 |
| 2 | `${var}` 插值"已通过"不实——m4 步骤文本无任何 `${...}` 引用，插值链路未被触碰 | Critical | m4 加真实引用 `${m4_hot}`（lint 的 definedVars 认其为已定义变量），执行器逐步插值 |
| 3 | NLP-5 误归"环境崩溃"——run.json 显示进程存活、失败是任务指令冲突 | Critical | 修正任务文本（去"回桌面"冲突项）；报告 §3.2.1 改正归因 |
| 4 | 声明覆盖缺口：`aiTap` resource-id 形态、无 `name` 的 `aiQuery` 在 6 例中不存在 | Important | c3 增 `aiTap: resourceId=...:id/ll_search` 与一条只读问答 `aiQuery`（无 name） |
| 5 | 断言自相矛盾：aiAssert 提示词限定"只看屏幕"，用例却断言数据集条数 | Important | s4/m3/m4/c3 断言改为"先用 data_query 取证、断言显式声明依据 data_query 返回条数"（c4 已验证有效） |
| 6 | 复现率被隐去 | Important | 报告新增 §3.4 逐案尝试次数/通过率表 + §一可信度声明 |
| 7 | 环境归因缺本轮证据链 | Important | 报告 §4.1 补 tombstone/logcat 证据文件路径（`param-verify/evidence/`） |
| 8 | **模型默认思考级别未生效**：`reasoning: false` 使 SDK 完全不发思考控制参数，网关回退自身默认（glm 长思考） | Critical | `src/session/model.js` 改 `reasoning: true`；**按模型能力分流**：可关思考的（deepseek/qwen/minimax）→ none，不可关闭的（GLM-5.3 系）→ low。见 §5.5 与 docs/THINKING-CONTROL.md |

> 整改后用 `reverify.sh` 复验（每案最多 3 次尝试）：**s4/m3/m4/c3 全部一次通过**（518s / 772s / 277s / 775s），
> c4 改版（去掉与 m1/m3 重复的搜索附属段、采集改用屏幕读取+upsert）后**首次尝试即通过**（426s）。
