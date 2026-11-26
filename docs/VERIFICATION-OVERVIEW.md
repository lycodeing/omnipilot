# OmniPilot 验证工程总览

> 日期：2026-10-27 · 设备：emulator-5554（Android 15 / x86_64 / 1080×2400）· 被测应用：稀土掘金 `com.daimajia.gold`
> 本文是导航与结论汇总。细节见 [VERIFICATION-REPORT.md](./VERIFICATION-REPORT.md)（20 章，900+ 行）。

## 一、结论速览

| 维度 | 结果 |
|---|---|
| **真机 run 总数** | **45 个**（29 pass / 16 fail） |
| **C1 全站巡检耗时** | **3002s（50 分钟）→ 190s（3.2 分钟），降 94%** |
| 交付缺陷修复 | **14 项**（含 4 个真机专属 bug） |
| 单元测试 | **374 tests / 365 pass / 0 fail** |
| 用例 | YAML×6 + 自然语言×8，lint strict 全绿 |
| 模型推荐 | **deepseek-v4.1-flash**（比 glm-5.3-flash 单轮快 4.4×） |

## 二、C1 性能演进（最有价值的成果）

| 阶段 | 优化 | 模型 | 耗时 | 降幅 |
|---|---|---|---|---|
| ① 原始 | — | glm | **3002s** | — |
| ② 引擎直执行拆分 | 粗粒度 `ai:` → `aiTap`/`aiScroll`（模型往返 104→6 轮） | glm | 779s | −74% |
| ③ 换模型 + JPEG 压缩 | deepseek + 截图 340KB→75KB | deepseek | 349s | −55% |
| ④ 精简等待 + ui 提取 | 去 5 次冗余 `aiWaitFor`、间隔 600→200ms | deepseek | **190s** | −46% |
| **累计** | | | | **−94%** |

**核心洞察**：耗时主体是**模型往返**（原占 90%），不是设备操作。
→ 能用引擎确定性执行的绝不交给模型（§15）。

## 三、分类验证结果

### 3.1 用例（cases/）

| 用例 | 级别 | 声明步骤 | 最快实测 | 状态 |
|---|---|---|---|---|
| s1-hotlist | 简单 | 10 | 476s（qwen3.8） | pass |
| s2-profile | 简单 | 7 | 465s（glm） | pass |
| m1-search | 中等 | 11 | 525s（glm） | pass |
| m2-tabs-net | 中等 | 10 | 274s（deepseek） | pass |
| **c1-grand-tour** | 复杂 | 50 | **190s（deepseek）** | pass |
| c2-data-pipeline | 复杂 | 12 | 901s（glm） | fail（collection 采样不足） |

### 3.2 模型矩阵（实测单轮往返中位）

| 模型 | 延迟 | agent 循环可用 | 备注 |
|---|---|---|---|
| **deepseek-v4.1-flash** | **3688ms** | ✅ | **推荐**；对 `reasoning_effort` 敏感 |
| qwen3.8-flash | 3536ms | ✅ | 最快，但复杂用例步骤更细 |
| minimax-m3.1-flash | 4347ms | ✅（网关已修） | |
| glm-5.3-flash | **16157ms** | ✅ | 单轮 16s，94% 是自发 reasoning |
| glm-5.3 | 16931ms | ✅ | |
| kimi-k3 | 10819ms | ✅ | |
| glm-5.3-flashx / doubao-* / step-5 / qwen3.7-plus | — | ❌ | 网关「无可用账号」 |

### 3.3 截图像素与体积

| 形式 | 540×1200 | 说明 |
|---|---|---|
| PNG（原） | 194KB | |
| **JPEG(q70)** | **75KB** | 统一入口产出，省 61% |
| 原图 1080×2400 PNG | 340KB | 降采样+JPEG 后省 **78%** |

**模型可读性**：360×800 JPEG（38KB）仍能准确读出图内 3 个文章标题 → **质量不是瓶颈**。

## 四、交付缺陷修复清单（14 项）

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | dumpTree 100% 失败 | 新版 adb 需 exec-out 通道 | `dumpXmlRaw()` exec-out + 回退 |
| 2 | 截图 100% 失败 | `adb screencap` 无此子命令 | 走 `exec-out screencap` |
| 3 | Windows 启动崩溃 | `DefaultResourceLoader` 缺 `agentDir` | 传 `getAgentDir()` |
| 4 | `ask` 不回显答案 | 返回值被丢弃 | 从 `state.messages` 取 |
| 5 | `${var}` 插值失效 | 循环外整体预插值 | 循环内逐步插值 |
| 6 | `assert_no_crash` 无参必失败 | `pidof null` | 退化为"当前前台存活" |
| 7 | 冷启动 `wm size` 卡死 | 异常逃出 locate + 无设备就绪等待 | try 包裹 + `waitForBoot` |
| 8 | **切网假成功** | `adb.shell` 丢弃 stderr | `withStderr` + 合并判定 |
| 9 | 网络状态泄漏 | 还原在 try 内、无信号处理 | 移入 `finally` + SIGINT/SIGTERM |
| 10 | 权限弹窗打断用例 | 零处理机制 | `popup.js` 侦测 + L2 提示词 |
| 11 | **`pm grant` 破坏 App** | 批量授权致 Cronet 崩溃 | 改 opt-in（`--pregrant`） |
| 12 | 坐标缓存命中率 3% | 动作工具绕过缓存 + pageId 无区分度 | 统一 `locateWithCache` + 步骤身份键 |
| 13 | JPEG 编码出彩色噪点 | 4:2:0 MCU 顺序错（全部Y→Cb→Cr） | 改为按 MCU 交错 |
| 14 | 等待冗余/过慢 | 切 tab 后无谓等待 + 间隔 600ms | 去冗余 + 200ms |

## 五、环境与约束（重要事实）

| 事实 | 影响 |
|---|---|
| `net` 命令不存在（非 redroid） | `net_profile` 返回 `ok=false`，用例按容错设计 |
| 单 Activity 架构（首页/热榜/发现都叫 `MainActivity`） | 旧缓存键 `pageId:target` 无区分度 → 已改步骤身份键 |
| **`MainActivity` 非 exported** | `am start -n` 抛 `SecurityException`，须用 launcher intent |
| **Cronet 不支持 x86_64** | 掘金间歇崩溃（App 自身问题） |
| **`uiautomator` idle 态超时** | 页面动画期间 dump 失败（`could not get idle state`）→ 见 §20.4 |
| 无图像库、禁 npm install | PNG/JPEG 编解码用 Node 内置 `zlib` 纯 JS 实现 |

## 六、文档索引

| 文档 | 内容 |
|---|---|
| [VERIFICATION-REPORT.md](./VERIFICATION-REPORT.md) | 主报告（20 章）：环境准备 → 14 项修复 → 用例与矩阵 → 性能分析与优化全记录 |
| [DESIGN.md](./DESIGN.md) | 主设计稿（§18-20 报告系统、附录 A 评审） |
| [CONTRACT-CORE.md](./CONTRACT-CORE.md) | 三方开发契约（签名/数据形状） |
| [superpowers/specs/2026-10-27-locate-cache-key-design.md](./superpowers/specs/2026-10-27-locate-cache-key-design.md) | 缓存键 + 状态回滚 + 弹窗 + 滚动能力设计（含评审记录） |
| [superpowers/plans/2026-10-27-reliability-popup-scroll-cache.md](./superpowers/plans/2026-10-27-reliability-popup-scroll-cache.md) | P0-P4 实施计划（TDD 步骤） |
| [../cases/README.md](../cases/README.md) | 用例集说明 + 步骤命令（Midscene 命名） |

## 七、已知未完成/待决策

| 项 | 现状 | 建议 |
|---|---|---|
| `uiautomator` idle 失败容错 | `waitIdle` 内 dump 异常未 catch | 加 try/catch 当作"未稳定"继续等 |
| `aiWaitFor` 等具体元素 | 未实现（需用例显式指定元素） | 可做，但受 dump 稳定性影响 |
| `quiet=1` | 未启用 | **不建议**（等于取消稳定性判断） |
| C2 collection 采样 | 每屏仅 1 条（容器粒度） | 内建逐卡片容器发现 |
| WebP | 未做（VP8 无库不可行） | 已用 JPEG 替代 |
| MCP 桥接 | 已验证 list/check/call + 真机实战 | 完成 |
| `--vlm-locate` | 无 VLM 端点 | 未覆盖 |

## 八、复现方式

```bash
# 环境
export ASK_ADB=/path/to/adb
export ASK_MODEL_URL=https://your-gateway/v1
export ASK_MODEL_KEY=<your-key>
export ASK_MODEL_NAME=deepseek-v4.1-flash   # 推荐
export ASK_MODEL_FAMILY=deepseek

# 自检
node bin/ask.js doctor --device --model

# 单测
node --test                                  # 374 tests

# 跑用例（工作区 <ASK_HOME>/<日期>/<instance>/case/）
node bin/ask.js run c1-grand-tour.yaml --yes --timeout 900

# 查看结果
node bin/ask.js data list                    # 数据集
ls $ASK_HOME/*/instance/run/                 # run 报告
```
