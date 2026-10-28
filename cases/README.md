# cases/ — 稀土掘金验证用例集

> 目标设备：emulator-5554（Android 15，1080×2400），掘金包名 `com.daimajia.gold`（已登录）。
> 两种格式：`*.yaml`（`ask run` 执行）与 `nl-cases.md`（`ask do` / `ask ask` 执行）。
> 分级：简单 3-5 页（S1/S2）、中等 5-10 页（M1/M2）、复杂 10-20 页（C1/C2）。

## 步骤命令（Midscene 命名）

本 kit 采用 Midscene 风格的步骤命名。**旧名（do/ask/assert）已废弃**——用旧名会解析报错并提示对应新名。

| 命令 | 执行方式 | 说明 |
|---|---|---|
| `ai` / `aiAct` | agent 自主 | 自由任务，agent 自己决定用哪些工具 |
| `aiAssert` | 模型判定 | 断言，只看当前屏幕可见元素 |
| `aiQuery` + `name:` | agent + 落库提示 | 查询/提取；带 `name:` 时提示写入数据集 |
| `aiWaitFor` + `timeout:` | 引擎 + 可选判定 | 等画面稳定；有文本条件时再让模型判一次 |
| `aiTap` | **引擎直执行** | 定位并点击（等价 tap 工具） |
| `aiInput` + `value:` | **引擎直执行** | 定位输入框并输入（等价 input 工具） |
| `aiLongPress` + `durationMs:` | **引擎直执行** | 长按 |
| `aiKeyboardPress` + `keyName:` | **引擎直执行** | 按键（enter/back/home/recent） |
| `aiScroll` + `direction:`/`distancePct:`/`until:` | **引擎直执行** | 滚动（距离/边界，见下） |
| `launch` / `terminate` | **引擎直执行** | 启动/强停 App |
| `net` / `sleep` | 特殊 | 网络档位 / 等待秒数 |

> 旧名迁移：`do:` → `ai:`，`ask:` → `aiQuery:`，`assert:` → `aiAssert:`。

**混合执行的意义**：`aiTap` 这类显式命令由引擎直接调用对应工具（不经 agent 选工具），更快、更省 token、
结果可复现；`ai:` 保留 agent 自主决策能力。执行后会把 `[engine] aiTap「热榜」→ 成功` 注入上下文，保持 agent 不失忆。

多行参数写法（缩进续行）：

```yaml
steps:
  - aiInput: 搜索框
    value: Android          # 参数
  - aiScroll: down
    distancePct: 75         # 0.75 屏
  - aiScroll:
    until: edge             # 滚到最底部
  - aiQuery: 提取热榜前3名标题
    name: hotlist           # 落库到数据集 hotlist
```

## 用例一览

| 用例 | 级别 | 页面数 | 主验证点 |
|---|---|---|---|
| s1-hotlist.yaml | 简单 | 3-5 | launch、screen、assert_no_crash、tap、swipe、scroll、data_extract(ui)、data_query、screen_diff |
| s2-profile.yaml | 简单 | 3-5 | uitree(clickable)、readText、locate、key(back/home)、截图 |
| m1-search.yaml | 中等 | 7-10 | input(yadb 中文输入+回读)、data_extract(ui)、发现页二级导航、返回链路 |
| m2-tabs-net.yaml | 中等 | 6-10 | net_status、net_profile(容错)、data_store、多Tab巡检、签到区查看 |
| c1-grand-tour.yaml | 复杂 | 12-18 | 全站导航、ui_dump 落盘、data_extract(ai)、页面计数、崩溃监控 |
| c2-data-pipeline.yaml | 复杂 | 12-16 | collection 采集、data_query(orderBy/limit)、data_store(upsert)、terminate/launch、processAlive、secret_get/sms_read 不可用路径、${var} 插值 |
| nl-cases.md | 同上 | 同上 | 同上功能点的自然语言形态（do ×6 + ask ×2） |

## P 系列（参数族用例，2026-10-28 追加）

> 目标：把**每个步骤命令的每种参数形态**至少跑一遍（旧系列覆盖功能点，P 系列覆盖参数面）。
> 对应自然语言形态见 `nl-p-cases.md`（NLP-1…NLP-7）。

| 用例 | 级别 | 页面数 | 参数验证点 |
|---|---|---|---|
| s3-engine-params.yaml | 简单 | 3-5 | aiScroll 四形态（distancePct 50/100、until:edge、direction:up+until:top+max、max:1）、aiWaitFor(timeout)、sleep、aiKeyboardPress(keyName)、launch 文本形态、assert_no_crash(expectedPackage) |
| s4-perception-params.yaml | 简单 | 3-4 | uitree clickable 双对照、locate(strategy/bounds)、readText(selector=text= 与 index=)、screen_diff、wait_idle(timeoutMs)、ui_dump、aiQuery+name 落库 |
| m3-input-action.yaml | 中等 | 7-9 | aiInput(value + 显式 resource-id 定位)、aiKeyboardPress(enter)、aiLongPress(durationMs)、swipe(区域名+durationMs)、data_extract(container+fields)、data_query(select/limit)、引擎失败后 agent 兜底自愈 |
| m4-data-net.yaml | 中等 | 6-9 | net 步骤命令(4g/off 容错)、data_extract(from=index 字段 + mode=ai)、data_query(where/orderBy/select/limit)、data_store(append 与 upsert+key)、${var} 已定义变量插值自检 |
| c3-all-commands.yaml | 复杂 | 16-18 | 全部 14 种步骤命令各至少一次；launch 文本/appId 双形态、terminate、screen(前台取证)、home/enter/back 键、read(re: 匹配)、uiDump、aiAct、secret/sms 不可用路径 |
| c4-collection-pipeline.yaml | 复杂 | 10-14 | collection(key 主键去重+max 上限+容器粒度退化补采)、data_query 倒序/精确 where、跨数据集 extract→query→upsert→复查流水线、terminate(packageName 参数形态) |

## P 系列验证矩阵（2026-10-28）

| Case | 模型 | 结果 | 耗时 |
|---|---|---|---|
| s3-engine-params | qwen3.8-flash | **pass** | 99s |
| s4-perception-params | glm-5.3-flash | **pass** | 1547s |
| m3-input-action | qwen3.7-plus | **pass** | 2692s |
| m4-data-net | minimax-m3.1-flash | **pass** | 467s |
| c3-all-commands | deepseek-v4.1-flash | **pass** | 598s |
| c4-collection-pipeline | deepseek-v4.1-flash | **pass** | 426s |
| NLP-1（简单） | deepseek-v4.1-flash | **pass** | 366s |
| NLP-4（中等） | glm-5.3-flash | **pass** | 1200s |
| NLP-5（复杂） | qwen3.8-flash | fail（环境崩溃） | 1288s |
| NLP-7（ask 只读） | qwen3.7-plus | **pass** | 17s |

> 详细报告：[docs/PARAM-VERIFICATION-2026-10-28.md](../docs/PARAM-VERIFICATION-2026-10-28.md)
> 注：s4/m3 耗时偏长是掘金 App 在 x86_64 上的 native 崩溃（转译层硬限制）导致，agent 靠自愈完成。


## 环境注意事项

- 本模拟器为 google_apis 镜像，**没有 redroid 的 `net` 命令**：`net_profile` 返回 `ok=false` 属预期，用例按容错设计。
- `secret_get` 未配置 `.ask/secrets.json` 时走 `SECRET_UNAVAILABLE` 路径（C2 验证该安全边界）；
  `sms_read` 设备层未实现 readSms/readNotifications，同样优雅降级。
- 断言遵循 lint 规则：不写"已进入XX页"、不用全称量词/颜色词，点击后先等稳定再断言。

## 覆盖边界（明确不适用/未覆盖的功能点）

- `--parallel N`：本机仅 1 台设备（emulator-5554），并发跑批不适用；设备独占锁 `.ask/locks/` 已在矩阵跑批中实际生效。
- `--vlm-locate` / VLM 定位：需要独立 VLM 端点，本轮未配置，属未覆盖项。
- 会话策略 `--keep/--fresh/--continue/--session`：矩阵用默认 `--keep`；secret 强制不落盘（§9.1）已由 C2 实测触发。
- MCP 桥：`mcp.json` 交付默认空 servers，`mcp list/check` 已验证命令路径，桥接工具注册/调用路径未验证。
- minimax 模型：网关（u2a/uni2api）的 minimax-m3.1-flash 在工具结果回传后的续轮返回空响应（多种消息格式均复现），
  属网关侧缺陷，agent 循环不可用；纯对话与首轮工具调用正常。

## CLI 功能点验证记录（2026-10-27 本机实测）

```bash
node bin/ask.js doctor --device --model     # OK device / OK model
node bin/ask.js lint cases/*.yaml --strict  # 0 findings
node bin/ask.js mcp list                    # mcp.json 无 server 配置
node bin/ask.js data list                   # 数据集清单（hotlist/search_android/...）
node bin/ask.js data show hotlist           # 行级数据 + _id/_ts/_run/_step 元数据
node bin/ask.js data query hotlist --where "rank>5" --limit 2   # where 过滤
node bin/ask.js data export hotlist --format csv                # CSV 导出
node bin/ask.js ask "..."                   # 只读问答（真模型+真设备）
```
