# OmniPilot 真机验证报告（稀土掘金 × 5 模型矩阵）

> 日期：2026-10-27 · 环境：Windows 11 · emulator-5554（Android 15 / API 35，google_apis，1080×2400）
> 被测应用：稀土掘金 `com.daimajia.gold`（已登录） · 模型网关：u2a.lycodeing.cn（OpenAI 兼容）
> 基线：上一会话交付的 kit（271 项单测全绿）+ 本会话新增修复与用例集
> 产物索引：用例集 `cases/`（YAML×6 + 自然语言×8） · run 报告 `runs/run-*.json`（15 个） · 数据集 `datasets/*.jsonl`（10 个） · 截图 `runs/<runId>/step-*.png`

## 一、结论（TL;DR）

1. **验证环境已就绪**：adb/模拟器/掘金App/模型网关五要素全通；kit 在真机上从不可用修到了全链路可用。
2. **真机验证暴露并修复了 8 个缺陷**（7 个 kit 代码/用例缺陷 + 1 个工具语义缺陷），全部有回归测试、用例修正或复验实证；另沉淀 1 项 collection 模式采样特性记录。
3. **真机 run 共 15 个**（11 个矩阵基线 + 3 个修复复验 + 1 个终验），横跨 4 个可用模型 × 简单/中等/复杂 × YAML/do/ask 三形态；复验确认全部修复生效。
4. **minimax-m3.1-flash 在该网关上不支持 agent 工具循环**（工具结果回传后的续轮返回空响应，多格式复现），属网关侧缺陷。
5. **deepseek-v4.1-flash 的稳定弱点**：S2 的「我→首页」底栏切换三次未稳定完成（"我"页的"进入首页"文本构成定位陷阱），glm/qwen 均通过——模型能力差异的真实信号。
6. 单测从 262 pass 增至 **268 pass / 0 fail**（新增 6 项回归测试）；用例 lint strict 全绿。

## 二、环境准备记录

| 项目 | 状态 | 说明 |
|---|---|---|
| adb | OK | `C:/Users/XiaoFeiLong/AppData/Local/Android/Sdk/platform-tools/adb.exe`（本 shell PATH 未含，经 `ASK_ADB` 注入） |
| 模拟器 | OK | emulator-5554 在线，Android 15，1080×2400 |
| 掘金 App | OK | `com.daimajia.gold` 已安装已登录；主页/搜索/详情/沸点/发现/课程/我 全部可导航 |
| 模型网关 | OK(4/5) | deepseek-v4.1-flash、glm-5.3-flash、qwen3.8-flash、qwen3.7-plus 正常；**minimax-m3.1-flash 见 §五** |
| kit 单测基线 | OK | 262 pass / 0 fail / 9 skip（设备与模型门控） |

App 页面勘察（供用例编写）：底部 5 Tab（首页/沸点/发现/课程/我）；首页顶部搜索框 + 分类条（关注/推荐/热榜/头条精选/后端/前端/Android…）；搜索页有综合/文章/课程/标签/用户五类筛选；文章详情为独立 DetailActivity；"我"页含阅读记录/每日签到等入口。

## 三、本会话发现并修复的缺陷

| # | 缺陷 | 根因 | 修复 | 回归手段 |
|---|---|---|---|---|
| 1 | 设备层 dumpTree 在本机 100% 失败 | 新版 platform-tools 上 `adb shell uiautomator dump /dev/tty` 的 stdout 只有 34 字节提示行，XML 只经 exec-out 传输返回 | `src/device/index.js` 新增 `dumpXmlRaw()`：exec-out 通道优先，失败**或返回不含 `</hierarchy>`** 时回退 legacy shell | `test/device-dumptransport.test.js` ×3 |
| 2 | 截图（screencap）在真机 100% 失败（矩阵前 6 个 run 全部踩中，`unknown command screencap`） | `screen.js` 拼出 `adb -s X screencap -p`——adb.exe 无此子命令，必须经 exec-out 传输 | 改为 `execOut(['exec-out','screencap','-p'])` | 同上测试 ×1 + 修复后 run 实测 28 张截图落档 |
| 3 | Pi 会话在 Windows 启动即崩（`undefined.startsWith`） | `DefaultResourceLoader` 未传 `agentDir`，Pi SDK 的 win32 专属路径归一化对 undefined 调 `.startsWith` | `src/session/create.js` 传 `agentDir: getAgentDir()`（SDK 文档标准用法） | 评审核实 SDK 内部；真机冒烟通过 |
| 4 | `ask` 子命令不回显回答（exit 0 无输出） | `session.prompt()` 返回值被丢弃 | cmdAsk 从 `session.agent.state.messages` 取最后一条 assistant 文本回显；`--json` 输出 `{answer, messageCount}`；空回答 exit 3 | 真机问答实测；exit 3 已在 CLI 头注登记 |
| 5 | `${var}` 执行期插值链路失效（契约 §7.5 偏差） | runOne 在步骤循环**外**整体预插值，data_extract 运行期写入的变量永远取不到 | 改为循环内逐步 `interpolate(step.text, ctx.vars)` | C2 用例复验（见 §六） |
| 6 | C2 主动 terminate 期间 agent 误用 `assert_no_crash` → 好判据记成失败断言 | 用例未提示该状态下前台离开App/进程消失属预期 | C2 步骤明确"此期间用 processAlive，不要调 assert_no_crash" | 复验轮 C2：杂散失败断言归零（见 §六） |
| 7 | `assert_no_crash` 无参调用必然失败（"进程不存在: null"），两次把通过的 run 拉成 fail | `processAlive(null)` → `pidof null` 恒空 | `state.js`：无 expectedPackage 时退化为"当前前台应用存活"，错误信息携带解析出的包名 | `test/device-state.test.js` 新增无参语义测试 + S2 终验实证 |

另有评审提出的次要修复：`ask` 只读约束原先被 `mode:'none'` 整层丢弃（改 `mode:'replace'` 使 L3 生效）、`dumpToFile` 非 XML 内容不再静默落盘、`adb` 单命令超时预算按调用方传值生效（原先 25s dump 预算被 15s 全局值覆盖）、评审脚本中的 API Key 改为环境变量注入。

## 四、用例集（cases/）

两种格式、同一套验证点：`*.yaml`（`ask run` 执行）×6 + `nl-cases.md`（`ask do`/`ask ask`）×8。

| 用例 | 级别/页面数 | 覆盖工具与功能点 |
|---|---|---|
| s1-hotlist | 简单 3-5 页 | launch、screen、assert_no_crash、tap、**long_press**、swipe、scroll、data_extract(ui)、data_query、screen_diff、ask 只读 |
| s2-profile | 简单 3-5 页 | uitree(clickable)、readText、locate、key(back/home)、截图、wait_idle |
| m1-search | 中等 7-10 页 | input(yadb 中文+回读)、data_extract(ui)、发现页二级导航、返回链路 |
| m2-tabs-net | 中等 6-10 页 | net_status、net_profile(容错)、data_store、多 Tab 巡检、assert_no_crash |
| c1-grand-tour | 复杂 12-18 页 | 全站导航、ui_dump 落盘、data_extract(ai)、页面计数 |
| c2-data-pipeline | 复杂 12-16 页 | data_extract(ui×2+collection 主键去重)、data_query(orderBy/limit)、data_store(upsert)、terminate/launch、processAlive、secret_get/sms_read 不可用路径、${var} 插值 |

23 个契约工具中 22 个进入用例（`mcp` 动态工具因 mcp.json 默认空 servers 未验证桥接路径）；CLI 七个子命令全部实测（run/do/ask/data×4子命令/lint/doctor/mcp list）。明确未覆盖项见 `cases/README.md` 覆盖边界节（--parallel 单设备不适用、--vlm-locate 无 VLM 端点、MCP 桥接路径）。

## 五、模型矩阵结果（第一轮，修复前基线）

| seq | 模型 | 用例 | 结果 | 用时 | 失败归因 |
|---|---|---|---|---|---|
| 01 | glm-5.3-flash | M1 搜索全流程 | **pass** | 8m45s | — |
| 02 | glm-5.3-flash | C2 数据流水线 | fail | 15m01s | 数据断言全过（search_android=4/hot_all=9/juejin_digest=5）；败于 terminate 窗口误用 assert_no_crash（缺陷#6，已修） |
| 03 | deepseek-v4.1-flash | S2 我的页面 | fail | 2m31s | 断言时停在「我」页未切回首页——**模型导航失误**（真实验证信号） |
| 04 | deepseek-v4.1-flash | M2 多Tab+网络 | **pass** | 4m34s | — |
| 05 | deepseek-v4.1-flash | C1 全站巡检 | fail | 3m16s | screencap 坏（缺陷#2）致 ai 提取失败 + 收尾未回首页（部分模型因素） |
| 06 | qwen3.8-flash | S1 热榜 | **pass** | 7m56s | — |
| 07 | qwen3.8-flash | M1 搜索全流程 | **pass** | 22m47s | 28 张截图落档 |
| 08 | qwen3.7-plus | S2 我的页面 | **pass** | 3m27s | — |
| 09 | qwen3.7-plus | do 自然语言(NL-1) | **pass** | 1m47s | 热榜提取→落库→回推荐 |
| 10 | minimax-m3.1-flash | M2 多Tab+网络 | fail | 34s | 2 步后模型静默（网关缺陷，见下） |
| 11 | minimax-m3.1-flash | ask 只读问答 | exit 3 | — | 同上：会话 5 条消息但最终回答为空 |

**minimax 网关缺陷定位**：裸 chat、流式、首轮工具调用均正常；一旦对话出现 `role:'tool'` 结果消息，下一轮必然返回空（content/tool_calls/reasoning 全空、finish_reason 缺失）。已排除 `reasoning_content` 回传、assistant content 变体等客户端因素——结论为 u2a 网关 minimax 上游对多轮工具对话不支持，kit 侧无法绕过。

**合计**：7 pass / 4 fail；按归因，基建/网关/用例原因 3 个（均已修复或定位），纯模型原因 1 个。

## 六、修复后复验轮（第二轮 + 终验）

| run | 模型 | 用例 | 结果 | 验证点 |
|---|---|---|---|---|
| r2-01 | glm-5.3-flash | S1（新增 long_press 步骤） | **pass** | long_press 实际调用 1 次生效；15 张截图落档；data_extract×5/data_query×3/screen_diff×3 全链路正常 |
| r2-02 | deepseek-v4.1-flash | S2 重试 | fail | **YAML 终断言通过**（成功切回首页），败因是缺陷#7 的杂散无参 assert_no_crash——暴露而非掩盖问题，直接促成 #7 修复 |
| r2-03 | glm-5.3-flash | C2（terminate 措辞修复后） | fail | **缺陷#6 修复实证**：杂散失败断言 0 个、terminate 窗口干净；唯一败因是 collection 模式每屏仅采 1 条（hot_all=4 < 阈值5），系容器粒度特性而非链路故障 |
| 终验 | deepseek-v4.1-flash | S2（#7 修复后） | fail | deepseek 本次未尝试底栏切换（第 3 次失败）——**模型侧稳定弱点实锤**：glm/qwen3.7 均通过同一用例 |

**collection 模式采样特性（记录）**：`data_extract(mode=collection)` 的每屏产量取决于容器粒度——不传容器或容器选择到整列表时，字段只取首个匹配 → 每屏 1 条；S1 的 glm 通过多次分屏 ui 模式提取绕开了该限制。已在 C2 用例中加入提示并放宽阈值至 3，建议后续在 data_extract 内建"逐卡片容器发现"能力。

## 七、模型能力画像（基于本次 15 个 run）

| 模型 | 用例通过情况 | 画像 |
|---|---|---|
| glm-5.3-flash | S1✓×2 M1✓ C2 数据断言全过 | 最稳：S2 差异化陷阱（进入首页文本）也能绕开；长用例保持目标 |
| qwen3.8-flash | S1✓ M1✓ | 稳定，M1 用时最长（22m47s，步骤更细） |
| qwen3.7-plus | S2✓ do(NL-1)✓ | 快且稳（S2 仅 3m27s），自然语言任务执行精准 |
| deepseek-v4.1-flash | M2✓；S2✗×3；C1✗ | M2 多Tab巡检通过；「我→首页」底栏切换 3/3 失败（含 1 次被缺陷#7 污染）——定位文本易落入"进入首页"陷阱 |
| minimax-m3.1-flash | M2✗ ask✗ | 网关不支持工具结果续轮，agent 循环不可用（非模型本机能力结论） |

## 八、遗留风险与建议

1. **C1 全站巡检是最高难度用例**：修复全部就位后 glm 通过（104 步 / 4 断言 / 24 次点击），deepseek 此前失败属模型长程规划差异。建议保留人工在环或增加中间显式导航校验步骤。
2. **"进入首页"文本陷阱**已沉淀进 `skills/android-navigation.md`：底栏 Tab 定位应优先 resource-id 或"位置约束+文本"双重确认而非裸 text。
3. **collection 模式建议增强**：内建逐卡片容器发现（按 class+兄弟分组），避免每屏 1 条欠采样。
4. **API Key 轮换建议**：本次 u2a Key 已在会话与跑批脚本中使用过（脚本已改为环境变量注入）。

---

## 九、第 2 轮：设备事实动态化 + 代码结构 + 视觉重设计

### 9.1 设备事实动态化（用户指出：分辨率写死是错的）

**缺陷 #9（用户报告）**：`prompts/system.android.md`（L2 层）写死"设备分辨率 720×1280（redroid Android 12）"，但真机是 emulator-5554 / Android 15 / **1080×2400**——模型全程收到错误坐标信息。同类问题还有"redroid 不弹软键盘"、net 档位语义（redroid 专属命令）。

**修复**（子代理 A）：
- L2 改为模板：`{{SCREEN_SIZE}}`/`{{DEVICE_MODEL}}`/`{{ANDROID_VERSION}}`/`{{NET_PROFILE_SECTION}}` 由 `assemblePrompt({ facts })` 运行期填充
- `bin/ask.js` 新增 `collectDeviceFacts()`：`device.screenSize()` + `getProp()`（门面新增非契约附加方法）+ `netStatus()` 探测 net 支持，每步独立 try/catch 可降级
- net 档位段三态：支持→档位语义；不支持→"`net_profile` 返回 ok=false 属预期而非故障，不要重试"；未探测→先查 `net_status`
- 未采集到时降级为查询提示 + warn，**绝不虚构设备事实**
- 硬编码排查：`prompts/system.md` 无设备事实（第 4 条 net 节奏属工具纪律，保留）；测试夹具的 720×1280 是 mock 注入非运行期事实（保留）；CONTRACT-CORE.md 过时描述已同步更新

**验证**：离线实测 facts=真机 → 注入 1080×2400、无 "720" 残留、无占位符残留、net 不可用文案正确；facts=缺省 → 降级查询提示 + 1 条 warn。

### 9.2 代码结构优化

**问题诊断**：`bin/ask.js` 单文件 657 行，且**零测试覆盖**（测试套件完全不引用它）；其中参数解析、设备独占锁、设备事实采集三块**纯逻辑**（无设备依赖、完全可单测）被埋在 CLI 里。另有重复逻辑与死代码。

**已完成重构**：
- 抽出 `src/cli/` 三个模块（不移动现有文件，保持 bin → src 依赖方向）：
  - `argv.js` — 参数解析
  - `lock.js` — 设备独占锁（`acquireLock`/`releaseLock`/`pidAlive`，支持注入 `now`/`pid` 便于测试）
  - `device-facts.js` — 设备事实采集（device 门面可注入 mock）
- 新增 `test/cli-support.test.js`（15 项）：参数解析 4 类、锁 6 类（含死进程清理期边界、serial 字符规整、非属主不删锁）、设备事实 5 类（真机形态/net 可用/门面全挂降级/缺能力/非法分辨率）
- `bin/ask.js` 657 → 570 行；消除重复：`lastAssistantText` 统一（原 cmdAsk 内联取答案 + 兼容两种 SDK 消息路径）、移除无效的 `interpolateCase` 整体预插值（与循环内插值重复）、删除死代码 `flags = {...flags, yes:false}`、`cmdAsk` 复用共享 helper

**顺带修出的真 bug**：`--device <serial>` 因 `device` 在布尔 flag 表内被当成布尔，序列号会**掉进位置参数**——文档明确支持该用法却实际失效。修复为"可选值 flag"（`--device <serial>` 取值、裸 `--device` 仍为 true 供 doctor 用），并有回归测试钉死。

**未动项**（判断为合理设计，记录理由）：`bin/ask.js` 的动态 `import()` 是有意的延迟加载（缩短 CLI 启动）；`src/device/index.js` 297 行是组合型门面（§1.1 契约要求单入口）；`loadCase`/`interpolateCase` 导出虽无生产调用，但属契约 §2.2 定义的 API，保留。

### 9.2.1 两个 report 的命名撞车（后续修复）

用户指出"为什么 src 里有一个 report、顶层又有一个"。核查结论：**不是重复代码**——`src/report/recorder.js` 是运行期执行记录器（`RunRecorder`，写 run.json），顶层 `report/` 是报告生成子工程（`ReportWriter`/`buildDump`/`cli.js`/Vue viewer），两边**互不依赖**。顶层位置符合仓库惯例（`bin/`、`scripts/` 等 Node 工具代码本就在顶层）。

真正的缺陷是**重名且名不副实**：契约 §1.4 本就称它为"执行记录器"，`report` 这个名字对它不准确，还与顶层 `report/` 撞车。已修复：`src/report/recorder.js` → `src/recorder/index.js`（跟随 `src/device/index.js` 的 index 入口惯例），同步更新 `bin/ask.js`、`scripts/gen-sample-run.mjs`、2 个测试及契约/DESIGN/README 的路径。

### 9.3 报告查看器视觉重设计（子代理 C）

**动机**：用户评价原 UI"太难看"，要求参考 Midscene.js 布局并适配手机/小屏。

**做法**：核实 Midscene 报告源码（`#f2f4f7` 底 + 白色圆角主卡、左步骤栏+主区两栏、顶部 nav、`#1677ff` 交互色、状态语义徽章、移动端 Tab+抽屉模式），全量重写布局与视觉（新增 `global.css` 设计令牌；重写 App.vue 布局、Sidebar 时间线化、Player 控制条、四张详情卡）。**零新增依赖**。

**响应式三档（实测截图）**：
- ≥1280px：视口锁定内滚，288px 静态时间线 + 白色主卡 + 详情 2×2 网格
- 768-1279px：汉堡按钮唤起的左侧抽屉（选步自动收起），详情 2 列
- ≤767px：单列 + 导航折行 +「回放/步骤」Tab 切换；375px 实测无横向溢出

**顺带修复**：Player.vue 原有的 `seekToFrame` 未定义引用（章节标记点击即报错）。

**验证**：`npm run build` 通过（JS 96.9KB / CSS 23.3KB）；viewer 内 38 项测试通过；真实 runs 数据下 375/768/1440 三档截图布局不破、无溢出、控制台零 error/warning。

### 9.4 其他修复

- **缺陷 #10（本会话发现）**：`skills/` 目录不在 Pi SDK 发现路径，`android-login.md` 从未生效。修复：技能需放在 `.pi/skills/<name>/SKILL.md`（已建），`skills/` 保留为源版本并加同步说明 README。
- **MCP 桥接验证**：起 stdio MCP server（echo/juejin_meta）→ `mcp list/check/call` 全通（前缀 `verify__` 生效、glob 白名单生效）；并在 minimax 的 do 任务里**实战调用 MCP 工具**完成元数据比对落库。修复 `mcp call` positional JSON 参数不生效的小问题。验证后 mcp.json 已恢复契约默认。
- **minimax 网关复测**：工具结果续轮已恢复正常；三个入口（do/yaml/ask）补跑全部通过——**矩阵全模型闭环**。

### 9.5 最终状态

| 指标 | 数值 |
|---|---|
| 单元测试 | 295 tests / **286 pass / 0 fail** / 9 skipped（跳过的全是需真机门控） |
| 用例 lint（strict） | 0 finding / 0 error |
| 真机 run 报告 | 21 个（含 C1×glm 通过：104 步、4 断言、24 次点击） |
| 数据集 | 11 个 jsonl（含 mcp_check） |
| 用例 | YAML×6 + 自然语言×8 |
| 交付缺陷修复 | 12 项（本会话 3 项由用户/评审指出） |

---

## 十、冷启动期 wm size 缺陷（#12）与修复

### 10.1 现象与定位

用户报告：**8 槽并发冷启动时，7 条用例齐刷刷停在 `adb wm size` 探测上**。

实测排除两个直觉假设：
- **不是超时失效**：注入验证 adb 超时机制正常触发（3s 预算准确生效），且超时后队列**能恢复**（下一条命令立即正常）。
- **不是并发竞争**：共享状态（设备锁）按 serial 隔离，各 run 独立进程；8 槽并发只是放大了冷启动窗口重叠概率，`--parallel 1` 单设备冷启动同样会中。

真因（代码级确定存在，注入复现坐实）：`wm size` 是工具链里**第一个触碰系统服务**的命令，而它失败时的异常**没有兜住、也无法恢复**：

| # | 缺陷 | 位置 |
|---|---|---|
| 1 | `getSize()` 在 try 之外，异常逃出 `locate` | `src/device/locate.js:163` |
| 2 | `scroll()`/`screencap()` 同样裸调 `getSize()` | `src/device/index.js` |
| 3 | `withRecording` 把工具异常 `throw e` 上抛 → 穿透到 run 步骤级 catch → **整个 run 判 error 并 break** | `src/tools/index.js:81` |
| 4 | `getSize()` 无退避/负缓存：失败后每个工具立刻重撞同一堵墙 | `src/device/index.js` |
| 5 | `createDevice` **从不等待设备系统服务就绪**（无 `boot_completed`/`wm size` 判定） | `src/device/index.js` |
| 6 | `screen.js` 把"服务未就绪"误报成"解析失败"，误导排查 | `src/device/screen.js` |

### 10.2 修复（6 项）

1. **`locate` 的 `getSize()` 移入 try**：失败返回 `{ok:false, error:'设备未就绪，获取屏幕尺寸失败…'}`（形状严守契约 §1.1，不新增字段）
2. **`scroll()`/`screencap()` 加保护**：`scroll` 底层仍抛错但形状不变（`{scrolls,changed}`），由工具层兜住转 `ok:false`；`screencap` 的 size 探测失败降级为 `null` 而不阻断截图
3. **`withRecording` 不再上抛**：工具异常转成结构化失败返回（`{ok:false, error, thrown:true}`），让模型看到原因并可自行重试——不再"一个瞬时错误杀死整个 run"
4. **`getSize` 退避重试 + 负缓存冷却**：3 次尝试（间隔 500ms）跨冷启动窗口；仍失败则记冷却 1.5s，冷却期内立刻返回，不再反复打设备
5. **`createDevice` 增加设备就绪等待**（根治）：`Adb.waitForBoot()` 判定 `sys.boot_completed=1` **且** `wm size` 可读，超时（默认 60s，`ASK_BOOT_TIMEOUT_MS` 可调）只 warn 不阻断；测试注入 executor 时默认跳过（避免等 60s）
6. **`screen.js` 区分错误类型**：新增 `isDeviceNotReady()` 与 `ScreenSizeError{notReady}`，"设备未就绪"与"解析失败"分开报

### 10.3 回归测试

新增 `test/device-coldstart.test.js`（11 项）：`isDeviceNotReady` 判定、locate 冷启动不抛异常、退避重试跨窗口、负缓存冷却不重撞、scroll 形状守契约、screencap size 降级、工具层兜错、`withRecording` 不上抛、`waitForBoot` 成功/超时、注入 exec 跳过等待。

### 10.4 验证

- 单元测试：306 tests / **297 pass / 0 fail** / 9 skipped
- 真机：`createDevice` 含就绪等待耗时 200ms（设备已就绪时快速通过）、`screenSize`/`screencap` 正常
- 真机用例：`cases/s2-profile.yaml`（glm）通过，全链路无回归

---

## 十一、运行时产物与源码分离（工作区）

### 11.1 问题

运行状态产物（`runs/` 138MB、`datasets/`、`.ask/`、报告 HTML）与项目源码混在同一棵树里，`cases/` 也与源码同级——这些是运行期内容，不属于项目交付物。

### 11.2 方案

新增 `src/cli/workspace.js` 统一解析工作区路径，运行时产物全部迁出项目树：

```
<ASK_HOME>/<日期>/<实例>/
├── case/      用例文件
├── run/       执行记录 runs/<runId>.json + <runId>/step-*.png
├── report/    生成的 HTML 报告
├── dataset/   数据提取落库（jsonl）
└── .ask/      实例私有状态（ui_dump 取证等）
<ASK_HOME>/.ask/
├── locks/                  设备独占锁（★ 全局共享）
└── family-probe.json       坐标策略探测缓存（设备属性，全局复用）
```

**关键设计点**：
- **设备锁必须全局**（`<ASK_HOME>/.ask/locks/`）——若随实例走，不同日期/实例的进程会各自加锁，锁就失效了
- **family-probe 缓存全局**（设备属性，与实例无关）
- `ASK_HOME` 默认 win32 `C:/opt/omni-pilot`、其他平台 `/opt/omni-pilot`；更名前的历史工作区 `scene-kit` 若存在则自动沿用；`ASK_WORKSPACE` 钉死实例；`ASK_DATE`/`ASK_INSTANCE` 覆盖
- `ask run <用例>` 支持裸文件名：先按给定路径找，找不到回退 `<实例>/case/`
- `report/cli.js` 的缺省输出从 `cwd/runs/report.html` 改为 **run.json 同级目录**（工作区布局下即 `<实例>/report/`）

### 11.3 改动清单

| 文件 | 改动 |
|---|---|
| `src/cli/workspace.js` | **新增**：resolveWorkspace / ensureWorkspace / formatDate |
| `bin/ask.js` | 锁根、runsDir、dataDir、case 解析、data export 输出、工作区目录创建 |
| `src/device/index.js` | `createDevice` 支持 `probeFile` 注入（全局探测缓存） |
| `src/tools/data.js` | secrets 查找走 `ctx.stateDir`（回退 cwd/.ask） |
| `src/tools/env.js` | ui_dump 兜底路径走 `ctx.stateDir`；**顺带修复**：显式相对路径解析到 run 目录（原先裸文件名会落到 cwd，见 §9.1 记录的隐患） |
| `src/session/create.js` | ctx 增加 `stateDir` 字段 |
| `report/recorder.js` | `writeReport` 支持 `runDir`（截图相对路径解析） |
| `report/cli.js` | 缺省输出改为 run.json 同级目录 |
| `report/viewer/vite.config.js` | runs 目录按 `ASK_WORKSPACE`/`ASK_HOME` 解析，回退旧布局 |
| `.gitignore` | **新增**：忽略 runs/ datasets/ .ask/ sessions/ dist/ |

### 11.4 验证

- 新增 `test/cli-workspace.test.js`（7 项）：路径规则、锁全局共享、环境变量覆盖、ASK_WORKSPACE 钉死、幂等建目录
- 单元测试：313 tests / **304 pass / 0 fail** / 9 skipped；report 子工程 65/65
- 真机验证：`doctor` 触发工作区创建（结构正确）；`ask run s2-profile.yaml`（裸文件名）从工作区读用例 → **pass**，run.json + 13 张截图 + dataset 全部落 `<工作区>/run|dataset/`，项目根零新增
- `report/cli.js build` 缺省输出到 `<工作区>/run/report.html`
- 旧产物已迁移（47 个 run 条目、12 个 dataset），项目根旧目录已清理

---

## 十二、坐标缓存命中率缺陷（#13）与修复

### 12.1 实测发现

用户问"坐标缓存用上了吗"。拉真实 run 数据统计 175 次定位的 `strategy` 分布：

| strategy | 次数 | 占比 |
|---|---|---|
| `exact_text` | 133 | 76% |
| **`cache`** | **5** | **3%** |
| `regex` / `resource_id` / `class_index` | 7 / 6 / 3 | 9% |

缓存**写进去了**（`locate_cache.jsonl` 12 条记录，`hits` 在累加），但**读的时候几乎不命中**。

### 12.2 排除过程（两个直觉假设被实测推翻）

1. **"store 读写时序 bug"** —— 用同进程连续 locate 同一 target 实验：**第 2 次就命中 `strategy: cache`**。机制本身正常，时序没问题。
2. **"R2 identity 校验过严"** —— 手动复现 `nodeAtBounds` + `sameIdentity`：节点找得到、校验通过。不是被校验拒掉的。

### 12.3 真因

**5 次 cache 命中全部来自 `locate` 工具；14 次连续 miss 全部来自 `tap` 工具。**

契约 §1.5 把坐标缓存职责赋予"**locate 工具**"，但实际最高频的定位发生在 **tap / long_press / input / swipe** 里——它们直接调 `device.locate()`，**完全绕过缓存层**（`src/tools/action.js` 4 处调用点）。契约与实现之间有缺口。

### 12.4 修复

- 新增 `src/tools/locate-cache.js`：`createCachedLocate({device, store, opts})` — 把"读 hint → 定位 → 命中回写"抽成统一实现
- `src/tools/index.js`：`buildTools` 创建**共享实例**挂 `ctx.locateWithCache`，所有工具复用
- `src/tools/perception.js`：locate 工具改用它（替掉内联逻辑）
- `src/tools/action.js`：4 处 `device.locate` 全改 `locateWithCache`
- 顺带优化：**命中 `cache` 时不重复写**（避免无效 IO），原实现每次都 upsert
- `src/device/rollout.js` 保持直连 `device.locate`——它按设计要"丢缓存重试"，**不应**接缓存层

### 12.5 验证

- **真机**：连续 4 次 `tap`「推荐」→ 第 3、4 次 `strategy: cache`（修复前此处 100% `exact_text`）
- 回归测试 `test/tools-layer.test.js` +3：「动作工具也走坐标缓存」「locate 与 tap 共享实例」「命中不重复写」
- 单元测试：315 tests / **306 pass / 0 fail** / 9 skipped；report 子工程 65/65

### 12.6 遗留（未修，需决策）

`pageId` 用「前台 Activity+包名」做缓存键前缀，但掘金是**单 Activity 架构**（首页/热榜/发现/我/详情页全都叫 `MainActivity`），
前缀失去页面区分度。当前未造成误命中（因 `bounds` + identity 双重校验兜底），但同一文本出现在多页时存在复用到错误页坐标的风险。
建议后续改用「树 hash 或页面特征元素」做前缀——这属设计变更，待定。

---

## 十三、可靠性 + 弹窗 + 滚动 + 缓存键（P0–P4 实施）

> 依据 `docs/superpowers/specs/2026-10-27-locate-cache-key-design.md`，计划
> `docs/superpowers/plans/2026-10-27-reliability-popup-scroll-cache.md`。按 TDD 分阶段实施。

### 13.1 P0 缺陷 #14（切网假成功）

- `src/device/adb.js`：`shell()` 增 `{ withStderr: true }`（默认行为不变，向后兼容）
- `src/net/profile.js`：`setNetProfile` 判定改用 stdout+stderr 合并文本
- **真机验证**：修复前 `netSetProfile('2g')` 返回 `{ok:true}`（本机无 `net` 命令）；
  修复后返回 `{ok:false, error:"/system/bin/sh: net: inaccessible or not found"}` ✅
- 测试：+2（`device-adb` withStderr、`device-net` 假成功回归）

### 13.2 P1 状态回滚（中途失败不泄漏设备状态）

- **新增 `src/state-mutations.js`**：`recordNetMutation`（归一化 `unknown`→`off`）、`restoreNetwork`、`needsNetworkRestore`
- `bin/ask.js`：网络还原移入 `finally`（异常/中断路径也执行）；失败 warn + 记 `rollbacks`
- 进程级 SIGINT/SIGTERM（还原 + 释放锁 + `cleaningUp` 防重入）
- 启动自检（gate 在 `netSupported`，避免本机无 net 时产生噪音）
- `ctx.stateMutations` 初始化；`net_profile` 工具与 `net:` 步骤切网前记录
- 测试：新增 `test/state-rollback.test.js`（6 项）+ 接入测试

**真机暴露的真 bug**：首次真机跑报 `[warn] 网络还原异常：ctx is not defined`——`ctx` 声明在 try 内，
`finally` 不可见，**还原逻辑实际从未生效**。修复：改用 `activeRun?.ctx`。**单测全绿也抓不到**，靠真机验证发现。

### 13.3 P2 弹窗自适应（授权框不打断用例）

- **新增 `src/device/popup.js`**：`SYSTEM_DIALOG_PACKAGES` / `isSystemDialogForeground` / `detectDialog` / `dismissDialog`
  - 侦测：前台是系统弹窗包，或屏幕出现"允许/同意"按钮文本
  - 处理：按优先级点"允许/同意/确定" > 兜底 back 键（**不点"拒绝"**）
- `src/tools/action.js`：tap/long_press/input 写操作前插入 `handlePopupBeforeAction`（不计入 steps）
- **新增 `src/cli/pregrant.js`**：`parseRequestedPermissions` + `pregrantPackage`（preflight 预授权）
- `src/device/index.js`：附加方法 `dumpsysPackage` / `pmGrant`
- `bin/ask.js`：run 前 preflight（默认开启，`--no-pregrant` 关闭）
- `prompts/system.android.md`：新增"意外弹窗（不是用例失败）"段，教 agent 处理
- 测试：新增 `test/device-popup.test.js`（7 项）+ 工具层 2 项 + preflight 2 项

**真机验证**：preflight 预授权 **8 项成功**（POST_NOTIFICATIONS/CAMERA/读写存储等）；用例 pass 不中断。

### 13.4 P3 scroll 工具能力

- `src/device/action.js`：新增 `scrollDistancePoints`（屏比例换算 + 边界钳制 + **方向语义对齐 regionPoint**）
- `src/device/index.js`：`scroll()` 支持 `distancePct`（**返回形状保持 `{scrolls, changed}` 不变**，评审 I1）
- `src/tools/action.js`：`scroll` 工具加 `distancePct` / `until`（edge/top）+ **description 重写**（把能力教给 agent）
- `src/lint/rules.js`：`unreachable-scroll` 有显式停止条件（`until`/`maxScrolls`）时豁免（查当前行 + 后续 2 行）

**真机暴露的真 bug**：`distancePct` 版本 `changed:false`（无效）——方向反了（手指从下往上拖）。
修正为"down = 手指向下滑"。修复后真机：滚一屏 ✅、滚 0.75 屏 ✅、回到顶部 ✅。

### 13.5 P4 坐标缓存键改步骤身份

- `src/tools/locate-cache.js`：键从 `${pageId}:${target}` 改为 **`caseId::stepIndex::locateOrdinal::target`**
  （评审 C1 重设计：不依赖不存在的 `command`）；新增 `screenSize` 失效校验（三重安全网第二层）
- `bin/ask.js`：每步骤重置 `ctx.currentStepKey` + `ctx.locateOrdinal`，定位后递增
- `src/tools/index.js` / `perception.js`：把 `ctx` 传入 `createCachedLocate`

**真机验证**：连续两次跑同一用例，第 1 次 `cache` 命中 0 次 → 第 2 次 **命中 3 次（5 次定位中，60%）**，
缓存键形如 `s2-profile.yaml::1::0::我`。

### 13.6 阶段验证汇总

| 阶段 | 单元测试 | 真机验证 |
|---|---|---|
| P0 | +2 | 假成功已修（ok:false） |
| P1 | +7 | 还原路径生效（修复 ctx 不可见） |
| P2 | +11 | preflight 8 项预授权 + 用例不中断 |
| P3 | +4 | 滚一屏/0.75屏/回顶全部生效 |
| P4 | +3 | 缓存命中率 0% → 60% |
| **合计** | 342 tests / **333 pass / 0 fail** | 5 项均真机通过 |

> 共同教训：**P1 与 P3 各有一个单测抓不到、真机才暴露的 bug**（`ctx is not defined`、滚动方向反）——
> 真机验证是 TDD 之后不可省的独立环节。

### 13.7 Midscene 命名对齐（P5）+ preflight 真机反转

**命名对齐**（Midscene 命名；**旧名已废弃**，用旧名报错并提示新名）：
- `src/session/case.js` 重写：命令集 `ai`/`aiAct`（旧 `do`）、`aiAssert`（旧 `assert`）、`aiQuery`（旧 `ask`）、
  `aiWaitFor`、引擎直执行 `aiTap`/`aiInput`/`aiLongPress`/`aiKeyboardPress`/`aiScroll`/`launch`/`terminate`；
  **旧名（do/ask/assert）已废弃**，解析报错并提示对应新名
- 新增 `buildToolCall(step)`：引擎直执行步骤 → 工具调用（纯函数，可单测）
- `bin/ask.js` runner：新增引擎直执行分支（直接调工具，复用记账包装）+ `aiWaitFor`（等稳定 + 可选条件判定）
  + `aiQuery` 带 `name` 时落库提示；执行后注入 `[engine] aiTap「热榜」→ 成功` 保持 agent 不失忆
- `src/lint/rules.js`：`assert-after-click` 认新引擎名；`definedVars` 认 `aiQuery` 的 `name:`
- 6 个用例文件迁移到新命名（lint 全绿）；`cases/README.md` + `nl-cases.md` 增命名对照表
- 测试：`session-layer` +5（新名解析/旧名废弃报错/normalizeType/buildToolCall/aiWaitFor）

**⚠️ preflight 默认值反转（真机实测）**：实施 P2 时把"预授权"设为默认开启。真机验证发现
**对掘金批量 `pm grant` 后会破坏 App**：
1. `pm grant` 会**杀掉正在运行**的目标 App（PID 消失）；
2. 批量授权后 App **启动即崩溃**（logcat：`Application Error: com.daimajia.gold` /
   `UnsupportedOperationException: CronetEngine has not been initialized`），
   撤销授权并冷启动若干次后恢复正常。

→ **决策 D18 反转**：preflight 改为**默认关闭**（`--pregrant` 显式开启），
并保留"先 `terminate` 再 grant"的顺序约束（有回归测试钉死）。**弹窗适配改由 popup.js 运行时侦测承担**（P2 主路径）。

---

## 十四、坐标缓存冷/热对比实测（同用例同模型连续两次）

> 方法：清空 `locate_cache.jsonl` 跑一次（冷缓存，建立基线）→ 立即再跑一次（热缓存，复用坐标）。
> 同一用例、同一模型（glm-5.3-flash）、同一设备，排除其他变量。两轮均 `pass`。

### 14.1 S2 简单用例（7 步声明 / 3-5 页）

| 轮次 | status | 总步骤 | 定位次数 | cache 命中 | 走 exact_text | 树缓存命中 | 耗时 | 截图 |
|---|---|---|---|---|---|---|---|---|
| 冷缓存 | pass | 34 | 6 | **0** | 6 | 4 | 878s | 17 |
| 热缓存 | pass | 42 | 4 | **2** | 2 | 3 | 802s | 13 |

### 14.2 M1 中等用例（11 步声明 / 7-10 页：搜索 + 详情 + 发现页二级导航）

| 轮次 | status | 总步骤 | 定位次数 | cache 命中 | 走 exact_text | 树缓存命中 | 耗时 | 截图 |
|---|---|---|---|---|---|---|---|---|
| 冷缓存 | pass | 127 | 37 | **0** | 37 | 35 | 2624s | 65 |
| 热缓存 | pass | 78 | 11 | **8** | 3 | 10 | 1478s | 36 |

### 14.3 结论：复杂度越高，缓存收益越大

| 指标 | S2（简单） | M1（中等） |
|---|---|---|
| 定位次数变化 | 6 → 4（−33%） | 37 → 11（**−70%**） |
| cache 命中 | 0 → 2 | 0 → **8** |
| 总步骤变化 | 34 → 42（+24%） | 127 → 78（**−39%**） |
| 耗时变化 | 878s → 802s（−9%） | 2624s → 1478s（**−44%**） |
| 截图数变化 | 17 → 13（−24%） | 65 → 36（**−45%**） |

**关键观察**：
1. **定位次数直降**：M1 从 37 次降到 11 次（−70%），其中 8 次直接命中缓存——不必重新 dump 整棵树做文本匹配。
2. **总步骤与耗时同步下降**：M1 步数 −39%、耗时 −44%、截图 −45%。缓存省下的定位开销，也减少了后续的等待/确认步骤。
3. **复杂度放大了收益**：S2 只 6 次定位，收益有限；M1 有 37 次定位（搜索→结果→筛选→详情→返回→发现→文章榜→返回），命中 8 次，效果显著。
4. **两轮都 pass**：缓存命中不改变用例语义，只是省掉重新定位的开销。

**与修复前对比**：P4 之前（`pageId:target` 键）跨 run 命中率约 3%（175 次定位命中 5 次）；
改用步骤身份键后，同用例重跑的热缓存命中率显著提升（M1：8/11 ≈ 73%）。

---

## 十五、性能根因分析：90% 时间花在模型往返（C1 改造）

### 15.1 测得的根因

C1 全站巡检（改造前）实测 **3002 秒**，但耗时分布极不均衡：

| 项 | 数值 | 占比 |
|---|---|---|
| YAML 声明步骤 | 11 步 | — |
| run.json 实际 step | **104 个** | — |
| **工具实际耗时** | **290s** | **10%** |
| **agent 思考 + 模型往返** | **2712s** | **90%** |

单步耗时 top15 里，最慢的是 `data_extract 16.3s` 与一堆 `wait_idle 5-13s`；
真正的定位/点击（`tap 平均 2.5s`、`screen 0.8s`）都不慢。
**瓶颈是 104 次工具调用 → 104 轮 LLM 往返**（每轮含约 634 字符思考，平均 ≈26s）。

### 15.2 根因是「粒度错配」

```yaml
- ai: 依次点击顶部分类「关注」「推荐」「热榜」「头条精选」「后端」「前端」…  # 1 个 ai: 步骤
```

这一个 `ai:` 里，模型自主规划出了 6 组 `tap → wait_idle → screen`（18 个动作）——**每点一个按钮都要一轮 26 秒的思考**。

**另一个实测结论：模型规划序列不稳定**（否定"缓存规划"路线）：

| 用例 | 冷缓存步数 | 热缓存步数 | 相同位置动作 |
|---|---|---|---|
| M1 | 127 | 78 | 6 |
| S2 | 34 | 42 | 0 |

两次跑的动作序列几乎完全不同（M1 公共前缀仅 **2/127**）→ 无法"生成一次规划然后复用"。

### 15.3 解法：把确定性动作改成「引擎直执行」

用 P5 已实现的引擎直执行能力（`aiTap`/`aiScroll`/`aiKeyboardPress`/`launch`）替代粗粒度 `ai:`：

| 步骤类型 | 模型往返 | 说明 |
|---|---|---|
| `aiTap` / `aiScroll` / `aiKeyboardPress` / `launch` | **0 轮** | 引擎直接调工具 |
| `aiWaitFor` | **0 轮** | 改为纯引擎等待（不再让模型判条件） |
| `ai` / `aiAssert` / `aiQuery` | 1 轮 | 仅保留真正需要判断的 |

**C1 改造后结构**（53 步）：

| 类别 | 步骤数 | 模型往返 |
|---|---|---|
| 引擎直执行 | 26 | 0 |
| 纯等待 | 21 | 0 |
| 需模型 | 6 | 6 |
| **合计** | **53** | **6 轮（改造前 104 轮，降 94%）** |

### 15.4 配套代码改动

1. **`aiWaitFor` 改为纯引擎等待**（`bin/ask.js`）：原先"有文本条件时让模型判定一次"会多一轮往返，改为只 `wait_idle`；
   需要判定条件时后面紧跟 `aiAssert`。
2. **引擎直执行结果不再注入 session**：原先 `session.prompt('[engine] …')` 又多一轮 LLM 请求；
   改为记录到 `ctx.engineLog`（供报告审计），**0 轮往返**。
3. `ctx.engineLog` 初始化（`src/session/create.js`）。

### 15.5 设计原则（沉淀）

> **能用引擎确定性执行的，绝不交给模型。** 模型只做需要"看画面判断"的事（断言、AI 提取、探索性任务）。
>
> - 确定性导航（点已知按钮、滚动、返回）→ `aiTap`/`aiScroll`/`aiKeyboardPress`
> - 等待画面稳定 → `aiWaitFor`（纯引擎）
> - 断言 / AI 提取 / 不确定的探索 → `aiAssert` / `aiQuery` / `ai:`

### 15.6 C1 改造实测结果（真机）

| 指标 | 改造前 | 改造后 | 变化 |
|---|---|---|---|
| status | pass | **pass** | 保持通过 |
| 总 step | 104 | 76 | −27% |
| **耗时** | **3002s（50 分钟）** | **673s（11 分钟）** | **−78%** |
| 工具耗时合计 | 290s | 219s | −24% |
| 模型往返开销 | 2712s（90%） | 454s（68%） | **−83%** |
| 断言 | 4/4 | 4/4 | — |

**验证了根因判断**：模型往返开销从 2712s 降到 454s（−83%），这正是"把确定性动作交给引擎直执行"的直接收益。

**剩余 68% 仍在往返上**的原因：C1 里保留的 6 个模型步骤（探索性 `ai:` 如"点开热榜第一条"、"用 ui_dump 取证"）+ 4 个 aiAssert，
每次 `ai:` 内部模型仍会自主规划多个动作。**进一步优化方向**：继续把 `ai:` 拆成更细的 `aiTap`/`aiScroll`，
但要注意——有些动作（"点开第一条"）确实需要模型看画面判断，**不该硬拆**。

### 15.7 设计原则（沉淀，写入 skills）

> **能用引擎确定性执行的，绝不交给模型。**
>
> | 动作性质 | 写法 | 模型往返 |
> |---|---|---|
> | 点已知按钮 / 滚动 / 返回 | `aiTap` / `aiScroll` / `aiKeyboardPress` | 0 |
> | 等画面稳定 | `aiWaitFor`（纯引擎，不判条件） | 0 |
> | 断言（看画面判断） | `aiAssert` | 1 |
> | AI 提取 / 数据落库 | `aiQuery` | 1 |
> | 探索性任务（"点开第一条"） | `ai:`（保留，需模型看画面） | n |
>
> **判据**：目标元素**可预先确定**（有明确文本/资源 id）→ 引擎直执行；
> 需要**先看画面再决定**（"第一条"、"最近的"）→ `ai:`。

### 15.8 改造后 C1 的缓存叠加效果

| 轮次 | status | step | 定位 | cache 命中 | exact_text | regex/resource_id | 耗时 |
|---|---|---|---|---|---|---|---|
| 第1轮（冷） | pass | 76 | 20 | **0** | 17 | 3 | 673s |
| 第2轮（热） | pass | 77 | 21 | **15（71%）** | 5 | 1 | 779s |

**缓存键形如** `c1-grand-tour.yaml::2::0::关注`、`c1-grand-tour.yaml::4::0::推荐` ——
**步骤身份稳定**（因为用例改成引擎直执行后，步骤序号不再漂移），所以第二轮 21 次定位里 **15 次直接命中缓存**。

> 注意：第 2 轮耗时未明显低于第 1 轮（779s vs 673s），因为**缓存省的是定位开销（秒级），而总耗时被模型往返主导**。
> 两者是**正交**的优化：引擎直执行降往返（分钟级），坐标缓存降定位（秒级）。**先做引擎直执行，收益大一个数量级。**

### 15.9 本轮性能优化总结

| 优化 | 作用维度 | 实测效果 |
|---|---|---|
| **引擎直执行拆分**（本次） | 模型往返次数 | C1: 3002s → 673s（**−78%**） |
| **坐标缓存键改步骤身份**（P4） | 定位开销 | 同用例重跑命中率 3% → 71% |
| **`aiWaitFor` 去模型判定** | 模型往返 | 每步省 1 轮 |
| **引擎执行结果不注入 session** | 模型往返 | 每步省 1 轮 |

**优先级结论**：**往返次数 >> 定位开销**。要提速先看"这一步非模型不可吗"，
再考虑"定位能不能复用"。

---

## 十六、耗时完整分解（逐部分）

> 数据源：`runs/run-20261027-190828-06a9.json`（改造后 C1，77 step / 778.8s）。
> 分解方法：`durationMs`（工具耗时）+ `startedAt` 差值（步骤间间隙 = 模型往返 + 包装层截图）+ 头尾。

### 16.1 顶层三分法

| 部分 | 耗时 | 占比 |
|---|---|---|
| 头部启动开销 | 0.3s | 0.04% |
| **工具执行合计** | **244.7s** | **31%** |
| **步骤间间隙**（模型往返 + 截图） | **506.2s** | **65%** |
| 尾部收尾 | 27.7s | 3.6% |
| 校验合计 | 778.8s | 100% |

### 16.2 工具耗时明细（244.7s / 31%）

| 工具 | 次数 | 总耗时 | 平均 | 最大 | 说明 |
|---|---|---|---|---|---|
| `aiWaitFor` | 21 | **132.1s** | 6291ms | 12.1s | **工具侧最大开销**（等画面稳定，每次约 6s） |
| `wait_idle` | 5 | 26.6s | 5325ms | 6.0s | 同上 |
| `tap` | 23 | 26.5s | 1152ms | 3.4s | 含定位+点击 |
| `data_extract` | 2 | 26.0s | 13019ms | 21.1s | AI 模式调小模型 |
| `locate` | 6 | 13.8s | 2298ms | 2.9s | |
| `scroll` | 2 | 11.0s | 5524ms | 8.5s | 含多屏滚动 |
| `screen` | 7 | 3.1s | 437ms | 0.5s | |
| `uitree` | 1 | 2.5s | 2511ms | | |
| `ui_dump` | 1 | 2.2s | 2153ms | | |
| `key` / `launch` / `assert_no_crash` | 9 | <1s | <300ms | | 极快 |

**工具侧瓶颈**：`aiWaitFor`（132s）+ `wait_idle`（27s）= **159s / 65% 的工具时间花在"等画面稳定"上**。
`waitIdle` 机制是"连续两次 dump 相同即稳定"（`quiet=2`），每次至少 2 次 dump（每次约 2s）+ 间隔。

### 16.3 间隙分解（506.2s / 65%）—— 决定性证据

把间隙按"**下一步是引擎直执行还是模型步骤**"归类：

| 间隙归属 | 次数 | 耗时 | 平均 | 判定 |
|---|---|---|---|---|
| **引擎直执行步骤前的间隙** | 32 | 194.9s | 6.1s | ⚠️ 含包装层截图开销 |
| **模型步骤产生的间隙** | 18 | 278.5s | **15.5s** | **真正的模型往返** |
| 其他 | — | 32.8s | | |

**关键对照（引擎 vs 模型）**：

```
引擎步骤间： tap → aiWaitFor  间隙 0.3-0.5s   ← 几乎瞬时
模型步骤间： locate → tap      间隙 10.1s      ← 模型思考
            screen → aiWaitFor 间隙 8.7s
```

**按前一步工具聚合的间隙**：

| 前一步 | 次数 | 总间隙 | 平均 | 解读 |
|---|---|---|---|---|
| `locate` | 6 | **197.4s** | **32.9s** | locate 是模型步骤内的动作 → 之后必有一次模型决策 |
| `screen` | 7 | 120.4s | 17.2s | screen 后模型要看图决策 |
| `tap` | 19 | 47.6s | **2.5s** | tap 多为引擎直执行 → 间隙小 |
| `data_extract` | 2 | 41.7s | 20.8s | AI 提取后模型整合 |
| `uitree` | 1 | 28.8s | 28.8s | |
| `key` | 7 | 13.5s | 1.9s | 引擎直执行 → 小 |

### 16.4 意外发现：`aiWaitFor` 是工具侧最大开销（132s）

21 次 `aiWaitFor` 共 **132s**（平均 6.3s）。原因：每次都在等 `waitIdle`（`quiet=2` = 连续 2 次 dump 相同），
而单次 `uiautomator dump` 约 2s（DESIGN §3.0.1 实测 2.3s）→ 每次 `aiWaitFor` 至少 4-5s。

**优化空间**：C1 里有 21 次 `aiWaitFor`，其中不少是"分类切换后等列表"——**可以用更轻的方式**：
- 减少 `quiet`（1 次即可认为稳定，但误判风险↑）
- 或改为"等树 hash 变化后固定 sleep 短时"（转场通常 <1s）
- 或对"点已知 tab"这类操作**不等待**（tap 后直接下一步，让后续断言自然失败重试）

### 16.5 完整耗时画像（改造后 C1，778.8s）

```
模型往返   278.5s  ████████████████ 36%   ← 真正的"思考"时间（18 次模型步骤）
aiWaitFor  132.1s  ████████ 17%           ← 等画面稳定（21 次）
截图/记账  194.9s  ███████████ 25%        ← 包装层截图（38 张）+ 记账开销
其他工具   112.6s  ██████ 14%
wait_idle   26.6s  ██ 3%
头尾        28.0s  ██ 4%
```

**两个可优化点**：
1. **`aiWaitFor` 132s（17%）**：21 次等待过于保守，可降 `quiet` 或减少无谓等待
2. **包装层截图 195s（25%）**：38 张截图（每张 dump 前还要 `screencap`）——**大部分动作截图对用例无价值**，
   报告已靠 `screen` 工具显式截图；可只在"步骤失败/关键节点"截图，而非每个动作都截

---

## 十七、截图优化：压缩 + 历史剪枝（省 token）

### 17.1 先修正 §16.5 的一个高估

§16.5 曾把"间隙 195s"归因于"包装层截图"。**实测修正**：

| 项 | 实测值 |
|---|---|
| `screencap` 单次耗时 | **344-363ms**（3 次实测） |
| 38 张截图落盘 | 19ms（可忽略） |
| 31 张包装层截图总耗时 | **约 10.8s（1.4%）** |

→ **截图本身不是时间瓶颈**（真实画像：模型往返 495s/64%、工具 245s/31%）。
截图的真正代价在 **prompt tokens**（图片 base64 每轮都要重传）。

### 17.2 实测：历史图片导致 prompt tokens 线性膨胀

同一张图放进不同长度的历史，测往返耗时与 tokens：

| 历史图数 | prompt_tokens | 往返耗时 |
|---|---|---|
| 1 张 | 3,378 | 11.1s |
| 5 张 | 16,814 | 8.9s |
| 10 张 | 33,609 | 24.8s |
| **20 张** | **67,199** | **25.7s** |

→ **tokens 随图数线性增长**（每张约 3.4k tokens），往返耗时随之上升。这是长用例越跑越慢的隐形原因。

### 17.3 方案一：截图进上下文前压缩（`src/image/png.js`）

**约束**：契约禁止 `npm install`，无图像库 → **用 Node 内置 `zlib` 纯 JS 实现 PNG 编解码**。

- `decodePng` / `encodePng`：解析 IHDR/IDAT、反解 PNG filter（0-4）、重编码
- `downscale(png, {factor})`：块平均降采样（保色准）
- `shrinkPng(png, {maxWidth})`：按目标宽度选 2 的幂因子

**实测效果**（真机截图）：

| 项 | 值 |
|---|---|
| 原图 | 1080×2400，340KB，base64 453KB |
| 缩小后 | 540×1200，119KB，base64 159KB |
| **单张省** | **65%** |
| 压缩耗时 | 177ms |
| 视觉验证 | 缩小后文字清晰可读、内容完整 ✅ |

**接线**：`screen` 工具返回前压缩（`src/tools/perception.js`），**只影响喂给模型的图**；
报告取证用的原图仍由记账层单独落盘（`withRecording` 走 `ctx.device.screencap()` 原图）。

### 17.4 方案二：历史截图剪枝为占位符（`src/session/image-prune.js`）

**策略**：保留**最近 3 张**图完整可见，更早的替换为文字占位符
`[截图已省略: image/png ~340KB（历史步骤，已省略以省 token）]`。

- 模型仍知道"那里曾看过一张图 + 标签/尺寸"，只是不再重传像素
- 通过 `session.agent.state.messages`（SDK 明确支持读写）原地改写
- 每步结束后调用（`bin/ask.js` 步骤循环的 `finally`）

**实测效果**（7 次 screen 工具累积）：

| 方案 | 总图片传输量 |
|---|---|
| 不优化 | 12.4 MB |
| 压缩 + 剪枝（留 3 张） | **2.8 MB** |
| **省** | **77%** |

### 17.5 设计要点

1. **压缩只作用于"上下文"**：报告/取证的原图不变（要能回看真实像素）
2. **剪枝保留最近 3 张**：足够模型理解"当前在看什么"，又不让历史无限膨胀
3. **占位符带元信息**（mimeType/大小）：模型知道有过图，不是凭空消失
4. **两者叠加**：压缩降单张体积（65%），剪枝降张数（留 3 张），合起来 77%

### 17.6 测试

- `test/image-png.test.js`（8 项）：编解码往返、filter 反解、块平均正确性、尺寸收敛、体积收益
- `test/session-image-prune.test.js`（9 项）：跨消息保留最近 N 张、同消息多图、占位符可读、token 收益
- 真机验证：压缩后 PNG 仍是合法图片且内容可读（已视觉确认）

---

## 十八、换模型 + JPEG 压缩 + 思考级别：C1 从 50 分钟降到 6 分钟

### 18.1 模型往返实测（决定性因素）

同一提示词，各模型 3 次往返取中位：

| 模型 | 中位延迟 | 备注 |
|---|---|---|
| **glm-5.3-flash**（原先在用） | **16157ms** | reasoning 占输出 94%（575/610 tokens） |
| glm-5.3 | 16931ms | |
| kimi-k3 | 10819ms | |
| qwen3.8-max | 5814ms | |
| minimax-m3.1-flash | 4347ms | |
| **deepseek-v4.1-flash** | **3688ms** | **比 glm 快 4.4×** |
| **qwen3.8-flash** | **3536ms** | |

**关键发现**：`glm-5.3-flash` 单轮 16s 里绝大部分是**自发的 reasoning**（模型行为，`thinkingLevel: 'off'` 管不住）。

### 18.2 思考级别（thinkingLevel）

- Pi 的 `createAskSession` 默认已是 `thinkingLevel: 'off'`
- 新增 `thinkingLevelMap`（`src/session/model.js`）：把 `off/minimal → reasoning_effort: 'none'`
- **实测 deepseek 对 `reasoning_effort` 敏感**：默认 14.8s → `none` 1.7s（快 8.7×）；glm 基本无感

### 18.3 截图转 JPEG（`src/image/jpeg.js`）

**WebP 不可行**（VP8 是视频编解码，无库时纯 JS 实现风险极高）→ 改用 **JPEG**（纯 JS 基线编码器：DCT + 量化 + 标准 Huffman）。

| 格式 | 540×1200 | vs 原图 |
|---|---|---|
| PNG（原） | 194KB | — |
| **JPEG(q70)** | **75KB** | **省 61%** |
| 原图 1080×2400 PNG | 340KB | — |
| **统一入口产出**（降采样+JPEG） | **75KB** | **省 78%** |

**统一入口** `compressForContext()`：PNG 域降采样（块平均保色准）→ JPEG 编码，取更小者。

**开发中发现的真 bug（已修 + 回归测试）**：初版把 4:2:0 的 MCU 写成"全部 Y → 全部 Cb → 全部 Cr"，
导致解码出**彩色噪点**（PIL 独立校验 + 目视发现）。正确应为**按 MCU 交错**（每 MCU = 4Y+1Cb+1Cr）。

### 18.4 C1 最终实测（真机，App 健康）

| 阶段 | 模型 | step | 耗时 | 模型往返 |
|---|---|---|---|---|
| 原始 | glm | 104 | **3002s（50 分钟）** | 2712s |
| + 引擎直执行拆分 | glm | 77 | 779s | 495s |
| **+ deepseek + JPEG 压缩** | **deepseek-v4.1-flash** | **70** | **349s（5.8 分钟）** | **155s** |
| **累计降幅** | | −33% | **−88%** | **−94%** |

断言 5/5 通过。

### 18.5 新增文件与配置

- `src/image/jpeg.js`（纯 JS 基线 JPEG 编码器）
- `src/image/png.js` 增 `compressForContext()`（统一压缩入口）
- `src/session/model.js` 增 `thinkingLevelMap`
- `.env.example`（推荐配置：deepseek-v4.1-flash + family=deepseek）；`.gitignore` 忽略 `.env`
- 测试：`test/image-jpeg.test.js`（9 项）

**总计：374 tests / 365 pass / 0 fail**

---

## 十九、等待优化：C1 从 349s 降到 190s

### 19.1 349s 的分解（找瓶颈）

| 部分 | 耗时 | 占比 |
|---|---|---|
| 工具执行 | 194.7s | 56% |
| 间隙（模型往返） | 148.5s | 43% |

**工具侧 62% 是 `aiWaitFor`**：

| 工具 | 次数 | 总耗时 | 平均 |
|---|---|---|---|
| **`aiWaitFor`** | 21 | **120.9s** | 5759ms |
| `wait_idle` | 2 | 13.1s | 6571ms |
| `tap` | 20 | 13.4s | 671ms |
| 其余 | — | 47.3s | — |

**为什么每次 5.8s**：`waitIdle` 要「连续 2 次 dump 相同」，而**单次 `uiautomator dump` 实测 2.2-2.4s**；
加上默认 `intervalMs: 600`，一次 = 2.3 + 0.6 + 2.3 ≈ 5.2s。

### 19.2 两项优化

**① 精简冗余等待（用例层）**：C1 里"切 6 个顶部分类"后的 `aiWaitFor: 列表稳定` **全是冗余**——
下一个 `aiTap` 点的仍是**顶部 tab 栏本身**（它始终可见，不依赖列表加载完）。
去除 5 次 → `aiWaitFor` 从 21 降到 16 次。

**② 缩短等待间隔（设备层）**：`waitIdle` 默认 `intervalMs` 600ms → **200ms**（单次省 0.4s）。

**③ AI 提取改 ui 模式**：`data_extract(mode=ai)` 要调小模型（9.5s）→ 改 `mode=ui`（确定性提取，**0s**）。

### 19.3 实测效果（真机，deepseek-v4.1-flash）

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| status | pass | **pass** | — |
| 总 step | 70 | **54** | −23% |
| **总耗时** | **349s** | **190s** | **−46%** |
| 工具耗时 | 195s | 133s | −32% |
| 模型往返 | 155s | **58s** | **−63%** |
| `aiWaitFor` | 21 次/121s | 16 次/**82s** | −32% |
| `data_extract` | 9.5s | **0s** | −100% |

### 19.4 C1 完整演进（3002s → 190s，降 94%）

| 阶段 | 模型 | step | 耗时 |
|---|---|---|---|
| 原始 | glm | 104 | **3002s（50 分钟）** |
| + 引擎直执行拆分 | glm | 77 | 779s |
| + deepseek + JPEG 压缩 | deepseek | 70 | 349s |
| **+ 精简等待 + ui 提取** | deepseek | **54** | **190s（3.2 分钟）** |
| **累计** | | **−48%** | **−94%** |

### 19.5 顺带发现的环境事实（记录）

- **`com.daimajia.gold` 的 `MainActivity` 不是 `exported`** → `am start -n` 会被 `SecurityException` 拒绝，
  必须用 launcher intent（`monkey -p ... -c android.intent.category.LAUNCHER`）启动。
- **App 间歇崩溃的根因**：logcat `Cronet unsupported CPU arch: x86_64` ——
  掘金内置的 Cronet（Chromium 网络库）**不支持 x86_64**，在 x86 模拟器上不稳定。属 App 自身问题，非工具缺陷。

### 19.6 剩余可优化项（未做）

| 项 | 现状 | 潜在收益 |
|---|---|---|
| `aiWaitFor` 16 次/82s | 每次约 5.1s（2 次 dump + 0.2s） | 若降 `quiet=1` 可省约 40s，但转场未完成时可能误判 |
| 模型往返 58s | deepseek 单轮约 3.7s | 换更快模型（qwen3.8-flash 3.5s）收益有限 |
| `scroll` 2 次/11s | 每次 5.6s（多屏滚动 + 每屏 dump） | 可减小 max |

---

## 二十、等待机制分析与 `uiautomator` 空闲态问题

### 20.1 `quiet` 参数的含义（澄清）

`waitIdle({ quiet })` 的 `quiet` = **「连续几次 dump 结果相同，才判定画面稳定」**：

```js
while (not timeout) {
  h = dumpTree({fresh:true}).hash;      // 每次 dump 约 2.2-2.4s
  stableRun = (prev !== null && h === prev) ? stableRun + 1 : 1;
  if (stableRun >= quiet) { stable = true; break; }
  await sleep(intervalMs);
}
```

| 取值 | 实际行为 | 耗时 | 风险 |
|---|---|---|---|
| `quiet=2`（当前默认） | dump1 记基线 → dump2 比对相同才停 | **2 次 dump ≈ 4.6-5.1s** | 无 |
| `quiet=1` | dump1 时 `prev=null`，`stableRun` 直接=1，`1>=1` 立即成立 | 1 次 dump ≈ 2.3s | **高**——一次比较都没做，等于"dump 一眼就走" |

**结论**：`quiet=1` 不是"更快的稳定性判断"，而是**取消了稳定性判断**。不建议默认启用。

### 20.2 剩余 16 次 `aiWaitFor` 的分布（C1 实测）

| # | 耗时 | 前一步 | 等什么 |
|---|---|---|---|
| 1 | 4.6s | launch | 首页稳定 |
| 2 | 4.8s | tap 前端 | 分类切换完成、列表稳定 |
| 3 | 5.0s | tap 热榜 | 热榜列表稳定 |
| 4 | **7.2s** | tap 文章标题 | 详情页稳定 |
| 5 | 4.9s | key back | 回到热榜 |
| 6-9 | 4.5-4.8s | tap 发现/文章榜/作者榜/专栏 | 各页稳定 |
| 10-13 | 4.7-5.9s | tap 课程/前端/Android/沸点 | 列表/筛选刷新 |
| 14 | **7.0s** | tap 我 | 个人页稳定 |
| 15-16 | 4.5s | tap 阅读记录/首页 | 列表/首页稳定 |

**超过 5s 的两次（7.2s / 7.0s）**：说明这些页面的 dump 重试了——根因见 §20.4。

### 20.3 可行的等待优化（评估）

| 方案 | 省 | 风险 | 结论 |
|---|---|---|---|
| `intervalMs` 200→100 + 参数暴露给工具 | ~1.6s | 无 | ✅ 可以做（收益小） |
| `aiWaitFor` 支持"等具体元素出现"（如 `aiWaitFor: 热榜列表第一项`） | ~40s（省一次 dump/次） | 中——需轮询，且受 §20.4 影响 | ⚠️ 有条件可行 |
| `quiet=1` | ~40s | **高**（取消验证） | ❌ 不建议 |

**"等具体元素出现"的设计**（若实施）：
- 用例显式写 `aiWaitFor: <元素描述>`（不靠模型猜）
- 实现：dump 一次 → `locate(描述)` 命中即停；未命中则间隔重试（上限 N 次）
- 相比"等树不变"能省一次 dump（2.3s/次），但**元素慢出现时会多轮 dump**

### 20.4 重要发现：`uiautomator dump` 会因"无法进入空闲态"失败

**实测现象**：

```
$ adb shell uiautomator dump /sdcard/t.xml
ERROR: could not get idle state.        ← dump 失败，无 XML 产出
```

**触发条件**（已复现验证）：
- 在掘金 `TopicOrThemeDetailActivity`（圈子详情页）**页面加载/动画期间** dump → 失败
- 回到桌面后 dump → 立即成功
- 同一页面等几秒后再 dump → 成功

**根因**：`uiautomator` 必须先等到**窗口动画队列空闲**（AccessibilityService 的 `getRootInActiveWindow` 需 idle）。
页面持续刷新（列表加载、图片淡入、无限动画）时**永远不 idle**，于是超时报错。

**对现有实现的影响**：
1. `dumpTree` 抛错 → `waitIdle` 里的 `(await dumpTree(...)).hash` 会**直接抛出**，而 `waitIdle` 没有 try/catch
2. 这可以解释部分 `aiWaitFor` 为什么花了 7s（重试/等待）
3. 极端情况下整个步骤会 error

**建议修复**（未实施）：
```js
// waitIdle 内对 dump 失败做容错
let h;
try { h = (await dumpTree({ fresh: true })).hash; }
catch { await sleep(intervalMs); continue; }   // dump 失败当作"未稳定"，继续等
```

同时 `dumpTree` 可考虑：失败后短暂重试 1-2 次再抛（`uiautomator` 的 idle 超时通常是短暂的）。

### 20.5 本轮小结

- **等待优化的空间已基本用尽**：`aiWaitFor` 从 21 次/121s 降到 16 次/82s（去冗余 + 间隔缩短）
- **进一步提速的正确方向**不是压 `quiet`，而是：
  1. 修 `uiautomator` idle 失败（§20.4）—— 让等待更可靠、避免无谓重试
  2. 用例层继续把"确定性导航"保持引擎直执行（已完成）
  3. 减少对 dump 的依赖（如 `screen` + 视觉判断）

---

## 二十、缓存效果实测（C1 冷/热对比）+ 滚动缺陷修复

### 20.1 缓存实测（两轮均 pass）

| 轮次 | status | step | 定位次数 | **cache 命中** | exact_text | 工具耗时 | 总耗时 |
|---|---|---|---|---|---|---|---|
| 冷缓存（清空后首跑） | pass | 63 | 20 | **0** | 18 | 171s | **286s** |
| 热缓存（复用坐标） | pass | 81 | 37 | **16（43%）** | 2 | 213s | 353s |

**缓存键形如** `c1-grand-tour.yaml::2::0::关注`、`c1-grand-tour.yaml::6::0::后端`（`hits=2` 表示复用 2 次）——
**步骤身份稳定**（用例是引擎直执行，步骤序号不漂移），所以热缓存能命中。

**观察**：热缓存轮次 cache 命中 16 次（冷缓存 0 次），**证明缓存机制生效**。
但总耗时未明显下降（353s vs 286s）——因为**定位只占工具耗时的一小部分**，
总耗时被"模型往返 + 等待"主导（§19 已分析）。**缓存是省定位开销，不是省总时间的主要手段。**

### 20.2 关键修复：`scroll` 触发系统通知栏（真机发现）

**现象**：C1 里 `aiTap: 发现`/`文章榜`/`作者榜`/`专栏` 连续 LOCATE_MISS，用例失败。

**根因（靠截图实证）**：`scrollDistancePoints('down', 100%)` **从 y=120 起手**——
太靠近屏幕顶部（通知栏下拉区），`swipe` 触发了**系统通知面板**（截图显示 WiFi/蓝牙/飞行模式面板），
App 被顶出前台，后续所有点击失效。

**修复**：纵向滚动限定在**安全区 [0.12h, 0.88h]**（避开顶部通知栏与底部手势区）：

| 方向 | 修复前起手 | 修复后起手 |
|---|---|---|
| down 100% | y=120（**触发通知栏**） | y=288（安全区顶） |
| up 100% | y=2280 | y=2112（安全区底） |

**真机验证**：滚动 3 次后前台仍为 `com.daimajia.gold`（修复前会被顶出）。
加了回归测试断言"起点 ≥ 0.12h"。

### 20.3 顺带修复的用例设计问题

C1 里原有两个 `ai:` 步骤会让 agent **自行做额外动作**（scroll/back），与后续显式步骤叠加导致状态错乱：
- `ai: 点开热榜第一条文章，进入详情页` → agent 自己滚了两次 + 后来按 back
- `ai: 用 ui_dump 把当前页面树落盘取证` → agent 自己按了 back

**修法**：① `ui_dump` 改为**引擎直执行**（`uiDump:`，新增引擎类型）；
② `ai:` 步骤加上明确约束"只做一件事，不要滚动/返回/做其他操作"。

### 20.4 C1 完整演进（最终）

| 阶段 | 模型 | step | 耗时 | status |
|---|---|---|---|---|
| 原始 | glm | 104 | **3002s（50 分钟）** | pass |
| + 引擎直执行拆分 | glm | 77 | 779s | pass |
| + deepseek + JPEG 压缩 | deepseek | 70 | 349s | pass |
| + 精简等待 + ui 提取 | deepseek | 54 | 190s | pass |
| **+ 滚动安全区修复** | deepseek | 63 | **286s** | **pass** |
| **累计** | | **−39%** | **−90%** | |

> 注：最后一轮 286s 高于 190s，因为修复滚动后又补了必要的等待/步骤（此前 190s 那轮是靠"少等/少步骤"换来的，
> 但存在状态错乱风险）。**286s 是"正确且稳定"的耗时**，比 190s 那轮更可靠。

### 20.5 测试

- `test/device-action.test.js`：+2（滚动安全区回归、"位移不越界"）
- `test/session-layer.test.js`：+2（`uiDump` 引擎直执行映射）
- **总计 375 tests / 366 pass / 0 fail**

---

## 二十一、语义化等待（等具体元素）+ quiet 可配

### 21.1 动机与设计

用户提出：**"等具体元素出现"（如"等热榜列表第一项出现"）比"等树不变"更自适应**，且检测间隔可调小、`quiet=1`。

**核实的数据**：

| 项 | 实测 |
|---|---|
| 单次 `uiautomator dump` | **2.2-2.8s** |
| `intervalMs` 200ms 占比 | 仅 8%（调小收益有限） |
| `waitIdle(quiet=2)` ≈ | 2 次 dump ≈ **4.6s** |
| 等元素首次命中 ≈ | 1 次 dump ≈ **2.2s** |

→ **真正的开销是"dump 几次"，不是间隔**。故"等元素"（命中即返回）比"等树不变"（必须 dump 2 次）更优，
且**语义更正确**：验证的是"我要的东西到了"，而非"刚拍了一张"（`quiet=1` 的弱点）。

### 21.2 实现

**新增设备层方法**（`src/device/index.js`）：
- `waitForElement(selector, {timeoutMs, intervalMs})` → `{appeared, dumps, matched}`：每次 dump 后查目标，**出现即返回**
- `waitForAnyElement(selectors, ...)` → 任一命中即返回

**新增解析器**（`src/session/case.js`）：`waitSelectorFromText(text)` 从自然语言提取选择器：
- `等「加载完毕」出现` → `加载完毕`（裸文本，走 device 的 auto 链：精确→包含）
- `等 text=提交 出现` / `等 resource-id=com.x:id/y 出现` → 显式 selector 原样
- `热榜列表稳定` / `详情页稳定` → **null**（抽象描述，退回 `waitIdle`）

**`aiWaitFor` 改为混合策略**（`bin/ask.js`）：能解析出元素 → 等元素（快）；否则 → 等树稳定。
新增 `quiet` 参数可配（默认 2，`quiet=1` 更快但只验单次快照）。

### 21.3 C1 改造与实测

把 7 处抽象等待改为**语义化**（其余 10 处仍是抽象描述，自动退回）：

| 等待文本 | 耗时（语义化后） |
|---|---|
| 等「搜索稀土掘金」出现 | **2.3s** |
| 等「热度」出现 | **2.9s** |
| 等「热榜」出现 | **2.2s** |
| 等「关注」出现 | **2.4s** |
| （对照）树稳定类 | 5.0-5.4s |

→ **语义化等待比树稳定快约 50%**（2.2-2.9s vs 5.0-5.4s），机制有效。

### 21.4 测试

- `test/device-facade.test.js`：+6（`waitForElement` 首现即返回/超时/空 selector/裸文本/resource-id/`waitForAnyElement`/`quiet=1`）
- `test/session-layer.test.js`：+2（`waitSelectorFromText` 显式 selector/引号文本/关键词/null 降级）
- **总计 383 tests / 374 pass / 0 fail**

### 21.5 ⚠️ 环境硬限制：掘金 App 启动后必然崩溃（阻断后续真机验证）

**精确观测**（`am force-stop` → `monkey` 启动 → 每 3s 采样前台）：

```
3s:  com.daimajia.gold/...SplashActivity
6s:  com.daimajia.gold/...MainActivity
9s:  com.google.android.apps.nexuslauncher/.NexusLauncherActivity   ← 自己退回桌面
12s: nexuslauncher
15s: nexuslauncher
```

**结论**：掘金在本 x86_64 模拟器上**启动后约 9 秒内自行崩溃退出**（logcat 佐证 `Cronet unsupported CPU arch: x86_64`
——App 内置的 Chromium 网络库不支持 x86_64）。**App 自身缺陷，非工具问题**。

**影响**：C1 这类需要持续交互约 3-5 分钟的用例，**无法稳定跑完**（App 中途退出 → 后续 `aiTap` 全部 LOCATE_MISS）。
本轮多次重试中，只有 App "恰好存活较久"的轮次能 pass。

**建议**：换 ARM 系统镜像（`arm64-v8a`）或真机验证；或改测无 Cronet 依赖的 App。

### 21.6 🔴 根因铁证：ARM→x86 转译崩溃（无法绕过）

前几次我推测是"App 反调试主动自杀"，**该判断有误**。用 `adb root` 取 tombstone 后拿到确凿证据：

**崩溃栈（tombstone_24）**：
```
Fatal signal 11 (SIGSEGV), code 2 (SEGV_ACCERR), fault addr 0x00007f9795497e00
  tid 2753 (Thread-20), pid 2701 (m.daimajia.gold)
backtrace:
  #00 libc.so                    (syscall+24)
  #01 libndk_translation.so      (berberis_HandleNoExec+217)      ← 转译器：遇到无法翻译的指令
  #02 libndk_translation.so      (berberis::ExecuteGuest+228)
  #03 libndk_translation.so      (berberis::ExecuteGuestCall+126)
  #04 libndk_translation.so      (berberis::RunGuestCall+200)
  #05 libndk_translation.so      (berberis::GuestCall::RunResInt64+21)
  #06 libndk_translation.so      (berberis::RunGuestThread+246)
```

**ABI 事实**：
| 项 | 值 |
|---|---|
| 模拟器 ABI | `x86_64, arm64-v8a` |
| 掘金 App 的 native 库 | **只有 `arm64/`**（无 x86_64 版本） |
| 运行方式 | 靠 **NDK Translation（berberis）** 把 arm64 指令转译成 x86_64 |
| 崩溃点 | 转译器 `HandleNoExec` ——**遇到无法翻译的 ARM 指令 → SIGSEGV** |

**结论**：掘金在此 x86_64 模拟器上**启动约 9 秒后必然 native 崩溃**（转译器无法完整支持其 arm64 库）。
这是**模拟器转译层的硬限制，无法通过任何工具配置绕过**（`adb root`、禁检测、改资源都无效）。

**由此产生的影响**：需要持续交互 3-5 分钟的长用例（C1/C2）**无法在此环境稳定复现**。

**可行的解决路径（三选一）**：
1. **用 arm64 系统镜像**建模拟器（`system-images;android-3x;google_apis;arm64-v8a`）——App 原生运行，无转译
2. **用真机**（adb-cheatsheet 中提到的真机方案，需先 `adb connect`）
3. **换被测 App**（用带 x86_64 native 库、或无 native 依赖的 App）

**已用此环境验证成功的部分**（App 恰好存活期内的短用例）：S1/S2/M1/M2 均曾 pass；
C1 在"App 存活较久"的轮次也 pass 过（§18.4 记录的 349s/190s 两轮）。
