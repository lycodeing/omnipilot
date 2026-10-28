# docs/ — 文档索引

> OmniScene（曾用名 android-scene-kit）的设计、契约、验证与调研文档集中于此（`report/CONTRACT.md` 属报告子工程，随代码在 `report/`）。

| 文档 | 内容 | 状态 |
|---|---|---|
| [**VERIFICATION-OVERVIEW.md**](./VERIFICATION-OVERVIEW.md) | **验证工程总览（推荐先读）**：结论速览、C1 性能演进 3002s→190s、模型矩阵、14 项缺陷清单、环境约束、复现方式 | 现行 |
| [**ARCHITECTURE.md**](./ARCHITECTURE.md) | **架构总览：Agent / ADB / 模型 的调用关系**（分层图、run 完整时序、三个模型调用点、定位策略链、产物落点，6 张 mermaid 图已校验） | 现行 |
| [DESIGN.md](./DESIGN.md) | 主设计稿 v3：设备层/缓存/定位/坐标兼容/会话/工具/数据/报告/MCP，含 §18 Midscene 报告源码解剖、§19 报告系统设计、§20 实施建议、附录 A 评审报告 | 现行 |
| [CONTRACT-CORE.md](./CONTRACT-CORE.md) | 三方（设备层/会话工具层/数据报告层）开发契约：跨层接口签名、UiNode 形状、RunRecorder/openDataset API、验收口径 | 现行 |
| [VERIFICATION-REPORT.md](./VERIFICATION-REPORT.md) | 真机验证主报告（20 章）：环境准备 → 14 项缺陷修复 → 用例与模型矩阵 → 性能分析与优化全记录（含 `uiautomator` idle 问题） | 现行 |
| [PARAM-VERIFICATION-2026-10-28.md](./PARAM-VERIFICATION-2026-10-28.md) | **参数族用例验证报告**（2026-10-28）：14 种步骤命令全参数覆盖、5 模型实测、复现率、4 项产品级发现、评审整改记录 | 现行 |
| [THINKING-CONTROL.md](./THINKING-CONTROL.md) | **模型思考控制定档**：哪些模型能关闭思考（none）、哪些不能（GLM-5.3 系降 low）；官方文档 + 网关实测依据 | 现行 |
| [REPORT_SYSTEM.md](./REPORT_SYSTEM.md) | 报告系统调研与设计建议（原稿，已并入 DESIGN.md §18–20） | 指路桩 |
| [REVIEW.md](./REVIEW.md) | DESIGN.md 评审报告（已完成修复，已并入 DESIGN.md 附录 A） | 指路桩 |

## 离线 HTML 预览

任意 docs 文档可转成**内嵌 mermaid 的单文件 HTML**（双击即看，无需服务器）：

```bash
node scripts/build-preview.mjs                          # docs/DESIGN.md → dist/design-preview.html
node scripts/build-preview.mjs docs/ARCHITECTURE.md      # → dist/architecture-preview.html
node scripts/build-preview.mjs docs/ARCHITECTURE.md out/x.html   # 自定义输出
```

生成物在 `dist/`（已 gitignore）。**架构图预览**：`dist/architecture-preview.html`。

## 设计与实施子目录

| 路径 | 内容 |
|---|---|
| [superpowers/specs/](./superpowers/specs/) | 设计文档：缓存键方案 + 状态回滚 + 弹窗自适应 + 滚动能力（含独立评审记录：14 组断言核实、2 Critical / 7 Important 处置） |
| [superpowers/plans/](./superpowers/plans/) | 实施计划：P0–P4 的 TDD 分步（含具体代码与验证命令） |

## 相关文档位置

- `report/CONTRACT.md` — 报告系统三方开发契约（v1）
- `cases/README.md` — 验证用例集说明与覆盖矩阵
- `skills/README.md` — 技能源文件与 `.pi/skills/` 生效路径说明
- `../README.md` — 项目总览与快速上手

## 两个"报告"相关目录的区别（易混淆）

| 位置 | 是什么 | 关键导出 |
|---|---|---|
| `src/recorder/index.js` | **运行期执行记录器**：agent 跑用例时写 `runs/<runId>.json` + 步骤截图 + 脱敏（契约 §1.4） | `RunRecorder` |
| `report/` | **报告生成子工程**：run.json → dump → HTML，含独立 CLI 与 Vue 查看器（契约 §5） | `ReportWriter`/`buildDump`/`writeReport` |

两者**互不依赖**，数据流单向：跑用例产生 run.json → 报告生成端消费 → 产出 HTML → viewer 展示。
（历史上两者分别叫 `src/report/recorder.js` 与 `report/recorder.js`，同名易混；运行期那个已改名 `src/recorder/`。）

## 文档维护提示

- 代码注释里对 DESIGN.md 的 §N 引用一律指本文档（`docs/DESIGN.md`）。
- `scripts/check-mermaid.mjs` / `scripts/build-preview.mjs` 读取 `docs/DESIGN.md`；`npm run docs:check` 校验图表可渲染。
- 移动本文档会断链，改动路径时同步 `scripts/*.mjs`、`report/CONTRACT.md`、`skills/README.md` 中的引用。
