# OmniPilot

跨端场景测试 agent：Pi coding-agent 循环 + 可插拔设备层 + MCP 桥。
用自然语言或 YAML 用例驱动 App / 网页 / 桌面程序，逐步落 run.json 报告（含截图、定位策略、断言、网络时间线）。

- 定位：**一套用例 DSL + agent 循环 + 报告流水线，跨 Android / iOS / Web / 桌面端**。平台差异只隔离在设备层适配器（契约 §1.1），当前已落地 Android（adb）适配器
- 环境：Node 24（ESM）
- 依赖：`@earendil-works/pi-coding-agent`、`@modelcontextprotocol/sdk`（其余为 Node 内置）
- 文档：[docs/DESIGN.md](./docs/DESIGN.md) 设计稿 · [docs/CONTRACT-CORE.md](./docs/CONTRACT-CORE.md) 开发契约 · [docs/VERIFICATION-REPORT.md](./docs/VERIFICATION-REPORT.md) 真机验证报告
- 曾用名：`android-scene-kit`（2026-10-28 起更名 OmniScene，2026-11-24 起再更名 OmniPilot）

## 快速上手

```bash
# 1. 环境与依赖
npm ci                       # 已提交 package-lock.json
export ASK_ADB=/path/to/adb  # 未在 PATH 时指定

# 2. 模型配置（OpenAI 兼容网关）
export ASK_MODEL_URL=https://your-gateway/v1
export ASK_MODEL_KEY=sk-...
export ASK_MODEL_NAME=glm-5.3-flash
export ASK_MODEL_FAMILY=glm   # 决定坐标策略族（glm/qwen/deepseek/…）

# 3. 自检
node bin/ask.js doctor --device --model

# 4. 跑用例：只读问答 / 自然语言任务 / YAML 用例
node bin/ask.js ask "现在屏幕上是什么页面？"
node bin/ask.js do "打开掘金看看热榜前3名，把标题存到数据集 hotlist"
node bin/ask.js run cases/s1-hotlist.yaml --yes
```

## 远程设备（adb over TCP）

设备不必插在本机。adb 原生支持 TCP 连接，OmniPilot 的 `--device <serial>` 直接吃 `host:port` 序列号：

```bash
# 1. 设备侧开启 TCP（一次性；5555 为常用端口）
adb -s <usb序列号> tcpip 5555

# 2. 控制机连接（可跨网段，需网络可达）
adb connect 192.168.1.50:5555

# 3. 用 TCP 序列号跑用例（锁、facts、报告均按该 serial 记账）
node bin/ask.js run cases/s3-engine-params.yaml --yes --device 192.168.1.50:5555
```

要点：

- **断连自愈**：设备层对 `device offline / connection reset` 等错误自动 `adb connect` 重连一次后重试（`src/device/adb.js` 的 `reconnect()` 对含 `:` 的序列号走 connect 分支）。
- **多机并发**：`--parallel N --devices a:5555,b:5556` 把用例轮转分给多台远程设备；设备独占锁按 serial 全局互斥（`.ask/locks/`）。
- **云真机/农场**：任何暴露 adb TCP 的设备池（云真机、CI 设备农场）都可作为 serial 源接入，用例与报告层零改动。
- 延迟提示：TCP 通道比 USB 多一次网络往返，screencap/dump 的大载荷传输受带宽影响；弱网环境建议给 `--timeout` 留余量。

## 运行时产物与源码分离

**用例、运行记录、报告、数据集等运行状态产物不落在项目里**，统一写入工作区：

```
<ASK_HOME>/<日期>/<实例>/
├── case/      用例文件（YAML / 自然语言）
├── run/       runs/<runId>.json + <runId>/step-*.png
├── report/    生成的 HTML 报告
├── dataset/   data_extract 落库（jsonl）
└── .ask/      实例私有状态（ui_dump 取证等）
<ASK_HOME>/.ask/
├── locks/     设备独占锁（★ 全局：跨实例共享，否则锁失效）
└── family-probe.json   模型家族坐标探测缓存（设备属性，全局复用）
```

- `ASK_HOME` 默认：Windows → `C:/opt/omni-pilot`（等价 `/c/opt/omni-pilot`）；其他平台 → `/opt/omni-pilot`
  （更名前的历史工作区 `scene-kit` 若已存在会自动沿用，保证历史 run / 设备锁 / 探测缓存连续）
- `ASK_WORKSPACE` 可直接钉死整个实例目录（CI/测试用）；`ASK_DATE` / `ASK_INSTANCE` 覆盖日期与实例名
- `ask run <用例>` 支持**裸文件名**：先按给定路径找，找不到再回退 `<实例>/case/` 目录
- 项目根的 `cases/` 是**用例模板/示例**（交付内容）；实际运行请用工作区目录

```bash
ASK_WORKSPACE=/tmp/my-run node bin/ask.js run s1-hotlist.yaml --yes   # 全部产物落该目录
```

## CLI 子命令

| 命令 | 用途 |
|---|---|
| `run <file...>` | 执行 YAML 用例（`--parallel N --devices a,b,c` 批量并发） |
| `do "<task>"` | 自然语言任务（agent 自主决策、可点击） |
| `ask "<question>"` | 只读问答（读屏/查数据，不点击） |
| `data list\|show\|query\|export\|diff\|clear` | 数据集操作 |
| `lint <file...>` | YAML 静态校验（`--strict` 把 warn 当 error） |
| `doctor` | 环境自检（`--device` / `--model` / `--cache-report <run.json>`） |
| `mcp list\|check\|call` | MCP 工具管理 |

全局参数：`--device <serial>`、`--model-url/-key/-name/-family`、`--prompt/--prompt-file/--prompt-mode`、
`--vlm-locate`、`--yes`、`--timeout <sec>`、`--fresh-locate`、`--json`、`--quiet`、
会话保留 `--keep/--fresh/--continue/--session <file> --keep-data`。

退出码：`0` 通过 · `1` 用例断言失败 · `2` 环境/配置错误 · `3` ask 得到空回答。

## 目录结构

见 [docs/DESIGN.md §4](./docs/DESIGN.md)。要点：

```
bin/ask.js              CLI 入口（参数解析/锁/设备事实采集/工作区解析已抽到 src/cli/）
src/device/             设备门面 + adb/树缓存/定位策略链/坐标兼容/输入/回退
src/session/            三层提示词装配、模型解析、会话持久化、用例装载
src/tools/              23 个 agent 工具（感知/操作/环境/数据/MCP）
src/store/  src/recorder/  数据集读写 + run.json 运行期执行记录器
src/cli/                CLI 支撑（argv / lock / device-facts / workspace）
prompts/  skills/       提示词与技能（技能生效路径 .pi/skills/）
cases/                  用例模板/示例（YAML × 12 + 自然语言 × 2 份）；运行时拷贝到工作区
report/                 报告生成端 + Vue 查看器（viewer/）
docs/                   设计/契约/验证/调研文档（索引见 docs/README.md）
scripts/                文档预览/校验等构建脚本
tmp/                    临时文件（调试取证 tmp/forensics/、一次性脚本、探针）；已 gitignore
```

> **运行时产物不在此树内**：runs / datasets / 报告等写入工作区 `<ASK_HOME>/<日期>/<实例>/`（见上节）。
> `.gitignore` 已忽略 `runs/`、`datasets/`、`.ask/`、`sessions/`、`dist/`、`tmp/`。
> **临时文件约定**：调试用的 UI dump、一次性脚本、验证探针一律放 `tmp/`（子目录 `tmp/forensics/` 存取证），不散落在项目根。

## 测试

```bash
npm test              # node --test，需真机的用例自动 skip（ASK_TEST_DEVICE=1 开启）
npm run docs:check    # 校验 DESIGN.md 的 mermaid 图表可渲染
```

## 设备事实而非硬编码

系统提示词 L2 层的分辨率/型号/Android 版本/net 命令支持一律**运行期读取**（`src/cli/device-facts.js`），
不写死具体设备；采集失败降级为查询提示。详见 [docs/VERIFICATION-REPORT.md](./docs/VERIFICATION-REPORT.md) §9.1。

## 多平台支持（路线图）

OmniPilot 的平台无关资产是**用例 DSL + agent 循环 + 报告流水线**；平台差异全部隔离在设备层适配器
（契约 §1.1 的 `createDevice` 门面：screencap / dumpTree / locate / tap / input / key / launch / …）。
新增一个平台 = 实现一个适配器，用例与报告零改动。

| 平台 | 适配器（规划） | 感知通道 | 操作通道 | 状态 |
|---|---|---|---|---|
| Android | adb（本机 USB / 远程 TCP） | `exec-out screencap` + `uiautomator dump` | `input tap/swipe/text`、`am`/`monkey` | ✅ 已落地（本仓库全部验证基于此） |
| Web | CDP / Playwright | 页面截图 + DOM/a11y 树 | `Page.dispatchMouseEvent`、`Input.insertText` | 规划中 |
| iOS | WebDriverAgent / Appium | XCUITest 截图 + 元素树 | W3C Actions | 规划中 |
| 桌面（Win/macOS/Linux） | UIA / AXAPI / AT-SPI（经 MCP 或本地桥） | 屏幕截图 + 控件树 | 键鼠事件注入 | 规划中 |

设计约束（保证可移植性）：

- 用例步骤命令（`aiTap`/`aiScroll`/`aiInput`/…）与定位 selector 语法（`text=`/`id=`/`class=`/`re:`）不携带平台语义；
- 坐标一律由设备层按当平台分辨率换算，用例不写像素（lint 规则 `pixel-coords` 强制）；
- 报告 run.json 形状（§14.1）与数据集（§14.2）平台无关，跨端结果可直接对比。
