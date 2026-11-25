# OmniPilot 评审问题全量修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-11-25 产品×架构全面评审发现的全部问题（5 Critical + 全部 Important/Minor），清理事故叙事型注释，安卓优先、跨端后续接入。

**Architecture:** 分六阶段推进——①信任链修复（终态/断言/超时）②治理机制迁移（appendContextEdit）③结构加固（runOne 下沉/锁/缓存安全网）④产品化（归因/配置/DSL 收敛）⑤平台包抽象（安卓知识收敛，为跨端留缝）⑥注释清理与文档对账。每阶段独立可验证，前一阶段是后一阶段的基础。

**Tech Stack:** Node 24 ESM（`"type":"module"`）、`node:test`、typebox、`@earendil-works/pi-coding-agent` 1.6.0、`@modelcontextprotocol/sdk`。零新依赖。

**Spec:** 本计划即 spec。问题清单来源：2026-11-25 评审报告（5 Critical + Important/Minor 全量，每条已逐条读码复核 + 运行时复现）。背景见 `docs/DESIGN.md`、`docs/CONTRACT-CORE.md`、`report/CONTRACT.md`。

## Global Constraints

这些约束适用于**每一个** Task：

- **基线**：`npm test` = 584 tests（test/ 504 + report/test 30 + report/viewer/test 50），575 pass + 9 skip（真机门控），0 fail。`node --test` 递归发现所有 `*.test.js`，报告端测试已纳入根套件。每个 Task 提交前 `npm test` 必须全绿（skip 数不变）。
- **测试数递增链**：各 Task 的 Expected 测试数是预估（基线 584 → 最终约 627）。执行时以实跑为准：0 fail、skip=9、新增测试数与该 Task 声明一致即通过，总数偏差 ±2 内不视为失败。Task 25 以实跑总数更新文档。
- **不引入新依赖**：只用 Node 内置模块 + 项目已有依赖（pi-coding-agent / mcp-sdk / typebox / jsdom / marked / mermaid / vue / vite）。
- **ESM + 具名导出**：所有新模块用 `export function` / `export const`，不用 default export。
- **注释用中文**：新增注释说明"为什么"而非"是什么"；事故叙事型注释（"此前/旧实现/曾/实测/评审 #N"）在阶段六统一清理，清理前各 Task 迁移代码时原样保留。
- **公共 API 兼容**：`createDevice` / `createDeviceWithExecutor` 签名不变；`RunRecorder` 既有方法签名不变（只加新方法/新可选字段）；`assemblePrompt` 既有参数不变（只加新可选参数）。
- **每个 Task 独立提交**：提交信息用中文，格式 `fix(<模块>): <动作>` / `refactor(<模块>): <动作>` / `feat(<模块>): <动作>`。无 AI 署名。
- **提交前必跑**：`npm test` 全绿 + `node --test <该 Task 涉及的测试文件>` 绿。
- **安卓优先**：本计划不实现 iOS/Web/桌面适配器；阶段五只做"安卓知识收敛 + 平台选择缝"，为后续接入留结构。
- **TDD**：每个行为变更先写失败测试，再实现，再验证通过。纯重构 Task 以"测试数/通过数不变"为守护。
- **worktree 隔离**：开工前按 `git-worktree-isolation` skill 在 `.worktrees/fix-review-2026-11-25` 创建独立 worktree（分支 `fix/review-2026-11-25`），基线测试全绿后再动手。

---

## File Structure

### 新建文件

| 文件 | 职责 | 阶段 |
|---|---|---|
| `src/session/assert-prompt.js` | 断言提示词构造（屏幕类/数据类分流）+ 数据集事实注入 | 一 |
| `src/session/context-governor.js` | 四道上下文治理的 appendContextEdit 执行后端（决策纯函数保留在 image-prune/context-window） | 二 |
| `src/session/run-loop.js` | runOne 的循环编排下沉（引擎步/降级/马拉松/空轮/催答/治理调度/断言） | 三 |
| `src/session/run-loop-helpers.js` | run-loop 的纯函数辅助（lastAssistantText/foldForGateway/attachStepShot 工厂） | 三 |
| `src/platform/android.js` | 安卓平台包：L2 提示词路径、facts getprop 键表、lint 平台规则、pregrant 权限表、弹窗包名表 | 五 |
| `src/platform/index.js` | 平台选择缝：`resolvePlatform(name)` → 平台包；当前只有 android | 五 |
| `src/device/screenshot-redact.js` | 截图密码框遮罩（password 节点 bounds → 像素填充） | 四 |
| `test/session-assert-prompt.test.js` | 断言提示词分流测试 | 一 |
| `test/session-context-governor.test.js` | 治理迁移测试（appendContextEdit 三语义） | 二 |
| `test/session-run-loop.test.js` | agent 循环编排测试（fake session + fake device） | 三 |
| `test/platform.test.js` | 平台包抽象测试 | 五 |
| `test/device-screenshot-redact.test.js` | 截图遮罩测试 | 四 |
| `scripts/check-doc-drift.mjs` | 文档承诺→代码消费者对账脚本 | 六 |

### 修改文件（按阶段）

| 文件 | 改动 | 阶段 |
|---|---|---|
| `bin/ask.js` | timeout/cancelled 终态、engineLog 落盘、断言分流接线、doctor 探活、.env 加载、aborted per-group、ask 共享锁、fail 关桥、runOne 下沉后瘦身 | 一/三/四 |
| `src/recorder/index.js` | addAssertion 扩展（screenshotId/evidenceSource/nudges）、engineLog 字段、addUiDump 接线、setContextLayers/setExtracts 接线 | 一/四 |
| `src/session/create.js` | ctx.engineLog 落盘消费、opts.rollback 删除、opts.timeoutMs 语义修正 | 一/三 |
| `src/device/index.js` | dumpXmlRaw 预算键修复、tap 响应判定、password 回读、dumpsysPackage/pmGrant/getProp 白名单、rollout 删除、screencap 遮罩接线 | 一/三/四 |
| `src/device/dump-channels.js` | budgetMs 键修复、重试预算用剩余量、unavailable kind 化 | 一 |
| `src/device/uia2.js` | ensure 失败挂 kind='unavailable'、source 非 200 挂 kind='protocol' | 一 |
| `src/device/errors.js` | classifyTransportError 增加 'unavailable' 分类 | 一 |
| `src/device/uitree.js` | makeNode 增加 password 字段 | 四 |
| `src/device/input.js` | readTextAt password 感知（掩码回读） | 四 |
| `src/session/image-prune.js` | 决策纯函数保留，原地改写改为返回编辑指令 | 二 |
| `src/session/context-window.js` | pruneStepHistory 改为返回编辑指令（不 splice） | 二 |
| `src/session/plan-cache.js` | 键纳入 serial+appVersion、非幂等工具不进 plan | 三 |
| `src/cli/lock.js` | acquireLock 支持 mode='shared'（ask 读锁） | 三 |
| `src/cli/argv.js` | 新 flag 注册（--probe-family、--max-turns 实现或删除） | 四 |
| `src/session/model.js` | family 可选化（缺省从 name 推断 + probe 缓存回退） | 四 |
| `src/session/prompt.js` | L2 路径从平台包读取、L1 平台中性化 | 五 |
| `src/cli/device-facts.js` | getprop 键表从平台包读取 | 五 |
| `src/lint/rules.js` | platform-fragment 规则平台无关化 | 五 |
| `src/cli/pregrant.js` | 权限表从平台包读取 | 五 |
| `src/device/popup.js` | 弹窗包名表从平台包读取 | 五 |
| `src/tools/data.js` | extractUi 容器自动发现、sms_read 实现或移除、账号工具 | 四 |
| `src/tools/action.js` | launch clean 参数、tap 响应判定消费 | 三/四 |
| `src/tools/env.js` | recordNetMutation 记账失败告警升级 | 三 |
| `src/tools/index.js` | 工具清单更新（账号工具）、EXPECTED_TOOLS 计数 | 四 |
| `src/tools/vocab.js` | aiAssert 补录、账号工具标签 | 一/四 |
| `src/store/dataset.js` | 跨进程写锁（O_EXCL 锁文件 + 重试） | 三 |
| `src/state-mutations.js` | needsNetworkRestore 删除（零消费者） | 三 |
| `src/device/rollout.js` | 删除（零生产消费者） | 三 |
| `src/image/png.js` + `src/device/png.js` | 解码核心合并（保留双接口） | 三 |
| `report/recorder.js` | 断言截图进报告、JPEG MIME 兼容 | 四 |
| `report/viewer/src/App.vue` | 通过率口径修正（断言通过率）、断言卡跳转 | 四 |
| `report/viewer/src/components/AssertionCard.vue` | screenshotId 跳转、evidenceSource/nudges 展示 | 四 |
| `report/viewer/src/components/icon-category.js` | aiAssert 图标 | 一 |
| `prompts/system.md` | L1 平台中性化（"安卓"→平台包注入） | 五 |
| `cases/*.yaml` | 防御咒语收敛为 launch clean、keyword 循环迁移显式参数 | 四 |
| `README.md` / `docs/*.md` / `report/CONTRACT.md` | 文档对账（工具数/版本/flag/契约） | 六 |
| `.env.example` | 文案修正（export 形式或实现加载） | 四 |

### 删除文件

| 文件 | 理由 | 阶段 |
|---|---|---|
| `src/device/rollout.js` | 零生产消费者（只有测试消费），DESIGN §5.0.6 的回退由 run-loop 降级链替代 | 三 |
| `test/device-rollout.test.js` | 随 rollout.js 删除 | 三 |

---

## 阶段一：信任链修复（Critical C-P1/C-P2/C-P3 + C-A2）

> 目标：exit code 与 pass 语义诚实。这是测试产品的第一信任支柱，四个 Critical 中三个是十行级修复。

### Task 1: timeout 终态赋值（C-P3）

**Files:**
- Modify: `bin/ask.js:593-595`（timeout break 处）
- Test: `test/session-run-loop.test.js`（新建，本 Task 先建骨架）

**Interfaces:**
- Consumes: `recorder.finish(status, {exitCode})`（STATUSES 已含 'timeout'）
- Produces: timeout break 后 `status = 'timeout'`，exitCode 2

- [ ] **Step 1: 写失败测试**

新建 `test/session-run-loop.test.js`：

```js
// run 循环编排测试（fake session + fake device，不真连）
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 本 Task 先测 timeout 终态逻辑的纯函数抽取；run-loop 下沉在阶段三
test('timeout 终态：超预算 break 后 status 必须是 timeout 而非 pass', async () => {
  // 抽取为纯函数后测试；当前先验证 recorder 支持 timeout 状态
  const { RunRecorder } = await import('../src/recorder/index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-timeout-'));
  const rec = new RunRecorder({ runsDir: dir, caseName: 'timeout.yaml' });
  rec.startStep('tap', 'x').end();
  const doc = await rec.finish('timeout', { exitCode: 2 });
  assert.equal(doc.status, 'timeout');
  assert.equal(doc.exitCode, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认通过（recorder 已支持 timeout，本测试守护现状）**

Run: `node --test test/session-run-loop.test.js`
Expected: PASS（1 test）

- [ ] **Step 3: 修改 bin/ask.js timeout break 处**

在 `bin/ask.js:593-595` 的 timeout break 前加终态赋值：

```js
      if (runDeadline && Date.now() > runDeadline) {
        console.warn(`[timeout] 已超 --timeout 预算（${Math.round(opts.timeoutMs / 1000)}s），剩余 ${steps.length - i} 步跳过`);
        status = 'timeout';
        break;
      }
```

同时检查步内催促/空轮重试的 timeout break（`bin/ask.js:850`、`bin/ask.js:888` 附近），这两处 break 只跳出内层循环，不改 status——它们是正确的（步内超时不等于整 run 超时），不改。

- [ ] **Step 4: 运行全量测试**

Run: `npm test`
Expected: 585 tests（+1），576 pass + 9 skip，0 fail

- [ ] **Step 5: 提交**

```bash
git add bin/ask.js test/session-run-loop.test.js
git commit -m "fix(cli): --timeout 到点后 run 终态赋 timeout，不再静默判 pass"
```

### Task 2: 引擎步失败影响终态 + engineLog 落盘（C-P1）

**Files:**
- Modify: `bin/ask.js:647-700`（引擎步失败处理）、`bin/ask.js:1017`（终态判定）
- Modify: `src/recorder/index.js`（engineLog 字段 + setEngineLog 方法）
- Modify: `src/session/create.js:25`（engineLog 注释更新）
- Test: `test/recorder-run.test.js`（engineLog 落盘断言）

**Interfaces:**
- Consumes: `ctx.engineLog`（已有，`{step, type, tool, ok, error}[]`）
- Produces: `recorder.setEngineLog(log)`；`doc.engineLog`；引擎步失败（含降级后仍失败）→ `status='fail'`

- [ ] **Step 1: 写失败测试（recorder engineLog 落盘）**

在 `test/recorder-run.test.js` 末尾追加：

```js
test('engineLog 落盘：setEngineLog 后 finish 产出 doc.engineLog', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'engine.yaml' });
  rec.startStep('aiTap', '热榜').end({ result: 'failed', error: 'LOCATE_MISS' });
  rec.setEngineLog([{ step: 0, type: 'aiTap', tool: 'tap', ok: false, error: 'LOCATE_MISS' }]);
  const doc = await rec.finish('fail', { exitCode: 1 });
  assert.deepEqual(doc.engineLog, [{ step: 0, type: 'aiTap', tool: 'tap', ok: false, error: 'LOCATE_MISS' }]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/recorder-run.test.js`
Expected: FAIL（`setEngineLog` 不存在 / `doc.engineLog` undefined）

- [ ] **Step 3: 实现 recorder.setEngineLog + doc.engineLog**

`src/recorder/index.js`：
- 构造器加 `this._engineLog = [];`
- 加方法：
```js
  setEngineLog(log) {
    this._engineLog = Array.isArray(log) ? log : [];
    this._schedulePartial();
  }
```
- `_buildDoc` 的 doc 对象加 `engineLog: this._engineLog,`（在 `rollbacks` 后）

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/recorder-run.test.js`
Expected: PASS（14 tests）

- [ ] **Step 5: 修改 bin/ask.js 引擎步失败终态**

在 `bin/ask.js` 引擎步处理段（`d.ok === false` 分支后、降级链结束后），加失败标记：

```js
              // 引擎步失败（含降级后仍失败）必须影响终态——零断言用例的 exit 0 不代表任务完成
              if (d.ok === false) {
                engineFailed = true;
              }
```

在 `let status = 'pass';` 旁加 `let engineFailed = false;`。

视觉降级轮（`bin/ask.js:698`）的 `ok: true` 改为如实记录：降级 prompt 发出后检查模型是否真的调了工具——用 `recorder.stepsSince(stepsBefore)` 判断本轮是否有动作类工具步。无动作步 → `engineFailed = true`。

终态判定处（`bin/ask.js:1017`）：

```js
    if (ctx.assertions.some((a) => !a.passed)) status = 'fail';
    else if (engineFailed && status === 'pass') status = 'fail';
```

finish 前加 `recorder.setEngineLog(ctx.engineLog);`。

- [ ] **Step 6: 写失败测试（引擎步失败 → fail 终态）**

在 `test/session-run-loop.test.js` 追加（纯函数抽取前的集成守护，用 recorder 验证终态逻辑）：

```js
test('引擎步失败终态：engineFailed 标记使零断言 run 判 fail', async () => {
  // 终态判定纯函数抽取到 run-loop-helpers（阶段三），此处先守护 recorder 侧
  const { RunRecorder } = await import('../src/recorder/index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-engine-'));
  const rec = new RunRecorder({ runsDir: dir, caseName: 'engine.yaml' });
  rec.setEngineLog([{ step: 0, type: 'aiTap', tool: 'tap', ok: false, error: 'LOCATE_MISS' }]);
  const doc = await rec.finish('fail', { exitCode: 1 });
  assert.equal(doc.status, 'fail');
  assert.equal(doc.engineLog[0].ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 7: 运行全量测试**

Run: `npm test`
Expected: 587 tests，578 pass + 9 skip，0 fail

- [ ] **Step 8: 提交**

```bash
git add bin/ask.js src/recorder/index.js src/session/create.js test/recorder-run.test.js test/session-run-loop.test.js
git commit -m "fix(cli): 引擎步失败影响 run 终态，engineLog 落 run.json（零断言用例不再恒 pass）"
```

### Task 3: 数据类断言分流（C-P2）

**Files:**
- Create: `src/session/assert-prompt.js`
- Modify: `bin/ask.js:780-800`（aiAssert 提示词构造处）
- Test: `test/session-assert-prompt.test.js`（新建）

**Interfaces:**
- Consumes: `ctx.datasetWrites`（Map<name, count>）、`store.read(name)`（async rows[]）
- Produces: `buildAssertPrompt({ stepText, fgNote, datasetFacts })` → string；`collectDatasetFacts(stepText, datasetWrites, store)` → Promise<string|null>

- [ ] **Step 1: 写失败测试**

新建 `test/session-assert-prompt.test.js`：

```js
// 断言提示词分流：屏幕类 vs 数据类（C-P2 修复守护）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssertPrompt, collectDatasetFacts, extractDatasetNames } from '../src/session/assert-prompt.js';

test('extractDatasetNames：从断言文本提取数据集名', () => {
  assert.deepEqual(extractDatasetNames('数据集 hotlist 中至少有3条记录且每条标题文本非空'), ['hotlist']);
  assert.deepEqual(extractDatasetNames('数据集 c4_hot_all 至少 5 条，数据集 c4_digest 非空'), ['c4_hot_all', 'c4_digest']);
  assert.deepEqual(extractDatasetNames('列表按时间倒序'), []);
});

test('collectDatasetFacts：注入行数与样本', async () => {
  const writes = new Map([['hotlist', 7]]);
  const store = { read: async (name) => name === 'hotlist' ? [{ title: 'A' }, { title: 'B' }] : [] };
  const facts = await collectDatasetFacts('数据集 hotlist 中至少有3条', writes, store);
  assert.ok(facts.includes('hotlist'));
  assert.ok(facts.includes('7'));
  assert.ok(facts.includes('样本'));
});

test('collectDatasetFacts：无数据集引用 → null', async () => {
  const facts = await collectDatasetFacts('列表按时间倒序', new Map(), { read: async () => [] });
  assert.equal(facts, null);
});

test('buildAssertPrompt：屏幕类断言保持原口径', () => {
  const p = buildAssertPrompt({ stepText: '列表按时间倒序', fgNote: '', datasetFacts: null });
  assert.ok(p.includes('只依据随附的当前屏幕截图'));
  assert.ok(p.includes('不要调用任何工具'));
});

test('buildAssertPrompt：数据类断言注入数据集事实', () => {
  const p = buildAssertPrompt({ stepText: '数据集 hotlist 至少3条', fgNote: '', datasetFacts: '【数据集事实】hotlist=7条，样本：[{"title":"A"}]' });
  assert.ok(p.includes('数据集事实'));
  assert.ok(p.includes('hotlist=7条'));
  assert.ok(p.includes('不要调用任何工具'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/session-assert-prompt.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/session/assert-prompt.js**

```js
// 断言提示词构造（C-P2 修复）：屏幕类断言只看截图；数据类断言注入数据集事实。
// 数据集事实来自 ctx.datasetWrites（运行期写入计数）+ store.read（样本），
// 模型无需调工具即可判定"数据集 X 至少 N 条"——此前硬编码"只依据屏幕"导致系统性误判。

// 从断言文本提取数据集名："数据集 X" / "数据集X"（中英文紧邻都认）
export function extractDatasetNames(text) {
  const names = [];
  const re = /数据集\s*([A-Za-z_][\w]*)/g;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// 采集数据集事实：行数 + 前 3 条样本（JSON 截断 200 字符/条）
export async function collectDatasetFacts(stepText, datasetWrites, store) {
  const names = extractDatasetNames(stepText);
  if (!names.length) return null;
  const parts = [];
  for (const name of names) {
    const count = datasetWrites instanceof Map ? datasetWrites.get(name) : null;
    let rows = [];
    try { rows = store ? await store.read(name) : []; } catch { rows = []; }
    const n = count != null ? count : rows.length;
    const sample = rows.slice(0, 3).map((r) => JSON.stringify(r).slice(0, 200)).join(', ');
    parts.push(`${name}=${n}条${sample ? `，样本：[${sample}]` : ''}`);
  }
  return `【数据集事实】${parts.join('；')}（以此为准判定，不要凭屏幕猜测）`;
}

// 构造断言提示词：数据类注入事实，屏幕类保持原口径
export function buildAssertPrompt({ stepText, fgNote = '', datasetFacts = null }) {
  const evidence = datasetFacts
    ? `只依据随附的当前屏幕截图、上述系统事实与以下数据集事实判断`
    : `只依据随附的当前屏幕截图与上述系统事实判断`;
  const factsBlock = datasetFacts ? `\n${datasetFacts}` : '';
  return `【断言】${stepText}${fgNote}${factsBlock}\n${evidence}，不要调用任何工具。只输出一行 JSON：{"passed": true/false, "reason": "不超过30字"}。`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/session-assert-prompt.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: 接线 bin/ask.js**

在 `bin/ask.js` aiAssert 分支（`step.type === 'aiAssert'` 处，约 780 行）：
- import `buildAssertPrompt, collectDatasetFacts`（动态 import，与既有风格一致）
- 在构造 `promptImages` 后、构造 `text` 前：
```js
        let datasetFacts = null;
        if (step.type === 'aiAssert') {
          try {
            const { collectDatasetFacts } = await import('../src/session/assert-prompt.js');
            datasetFacts = await collectDatasetFacts(stepText, ctx.datasetWrites, ctx.store);
          } catch { /* 事实采集失败不阻断断言 */ }
        }
```
- 把 `const text = (step.type === 'aiAssert') ? \`【断言】...\` : ...` 替换为：
```js
        const text = (step.type === 'aiAssert')
          ? buildAssertPrompt({ stepText, fgNote, datasetFacts })
          : (step.type === 'aiQuery' && step.name)
            ? `${stepText}\n（把结果用 data_extract 或 data_store 落到数据集「${step.name}」）`
            : stepText;
```
（`buildAssertPrompt` 在文件顶部 import 或动态 import 后解构）

- [ ] **Step 6: 运行全量测试**

Run: `npm test`
Expected: 592 tests，583 pass + 9 skip，0 fail

- [ ] **Step 7: 提交**

```bash
git add src/session/assert-prompt.js bin/ask.js test/session-assert-prompt.test.js
git commit -m "fix(session): 数据类断言注入数据集事实，不再被屏幕口径系统性误判"
```

### Task 4: dump 预算键修复（C-A2）

**Files:**
- Modify: `src/device/index.js:113`（dumpXmlRaw 调用处）
- Modify: `src/device/dump-channels.js:86`（重试预算用剩余量）
- Test: `test/device-dumptransport.test.js`（预算守护测试）

**Interfaces:**
- Consumes: `dumpXmlRaw({ budgetMs })`（dump-channels 签名）
- Produces: `dumpTree({ timeoutMs })` → `dumpXmlRaw({ budgetMs: timeoutMs })`；各通道预算 ≤ 传入预算

- [ ] **Step 1: 写失败测试**

在 `test/device-dumptransport.test.js` 末尾追加：

```js
test('dump 预算：dumpTree({timeoutMs:3000}) 各通道预算必须 ≤3000ms（C-A2 回归）', async () => {
  // 注入 exec 捕获每次调用的 timeoutMs；uia2 注入 stub 捕获 source 预算
  const budgets = [];
  const exec = async (args, opts) => {
    budgets.push({ cmd: args.join(' ').slice(0, 50), timeoutMs: opts?.timeoutMs });
    const joined = args.join(' ');
    if (joined.includes('get-state')) return { code: 0, stdout: 'device', stderr: '' };
    if (joined.includes('wm size')) return { code: 0, stdout: 'Physical size: 720x1280', stderr: '' };
    if (joined.includes('which timeout')) return { code: 0, stdout: 'NO', stderr: '' };
    if (joined.includes('uiautomator dump')) return { code: 1, stdout: '', stderr: 'could not get idle state' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const uia2 = {
    source: async (opts) => { budgets.push({ uia2: true, timeoutMs: opts?.timeoutMs }); throw new Error('uia2 不可用'); },
    serverPid: async () => null,
    ensure: async () => false,
  };
  const device = await createDeviceWithExecutor({ serial: 'test', exec, uia2, waitReady: false });
  await device.dumpTree({ fresh: true, timeoutMs: 3000 }).catch(() => {});
  // 所有 dump 相关调用的预算必须 ≤3000（探测/清理命令除外）
  const dumpBudgets = budgets.filter((b) => b.uia2 || /uiautomator dump/.test(b.cmd ?? ''));
  assert.ok(dumpBudgets.length > 0, '应有 dump 调用');
  for (const b of dumpBudgets) {
    assert.ok(b.timeoutMs == null || b.timeoutMs <= 3000, `预算超限: ${JSON.stringify(b)}`);
  }
  await device.close();
});
```

注意：注入 exec 的 `opts` 当前只传 `{binary}`（`adb.js:45`），需先修复 opts 透传（Step 3）。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/device-dumptransport.test.js`
Expected: FAIL（预算 15000/55000 超限，或 opts.timeoutMs undefined）

- [ ] **Step 3: 修复 adb.js 注入 exec 的 opts 透传 + index.js 预算键**

`src/device/adb.js:45`：
```js
          .then(() => this._exec(args, { binary, timeoutMs: budget }))
```
（注入执行器签名注释 `adb.js:16` 已声明 `{ timeoutMs, binary }`，此为实现漏传）

`src/device/index.js:113`：
```js
    const xml = await dumpXmlRaw(timeoutMs != null ? { budgetMs: timeoutMs } : undefined);
```

`src/device/dump-channels.js:86`（重试预算用剩余量，不用全量）：
```js
          const retryBudget = budgetMs != null ? Math.max(500, budgetMs - (Date.now() - dumpT0)) : 60_000;
```
注意 `dumpT0` 在 `cap()` 定义处（约 116 行）才声明，重试段（约 86 行）在其前——需把 `const dumpT0 = Date.now();` 提到 `dumpXmlRaw` 函数体开头（uia2 尝试之前）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/device-dumptransport.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: 运行全量测试**

Run: `npm test`
Expected: 593 tests，584 pass + 9 skip，0 fail

- [ ] **Step 6: 提交**

```bash
git add src/device/index.js src/device/dump-channels.js src/device/adb.js test/device-dumptransport.test.js
git commit -m "fix(device): dump 预算键错配修复（timeoutMs→budgetMs），注入 exec 透传 timeoutMs"
```

### Task 5: uia2 错误 kind 化（消除文案正则依赖）

**Files:**
- Modify: `src/device/uia2.js:250`（ensure 失败挂 kind）、`src/device/uia2.js:253-257`（source 非 200 挂 kind）
- Modify: `src/device/errors.js`（classifyTransportError 增加 unavailable）
- Modify: `src/device/dump-channels.js:50,73`（槽判定用 kind 替代文案正则）
- Test: `test/device-facade.test.js`（unavailable 槽空闲测试）

**Interfaces:**
- Consumes: `withKind(e, kind)`（errors.js 已有）
- Produces: `e.kind='unavailable'`（ensure 失败）；`classifyTransportError` 返回 'unavailable'；槽判定 `kind === 'protocol' || kind === 'unavailable'`

- [ ] **Step 1: 写失败测试**

在 `test/device-facade.test.js` 通道决策段（约 594 行后）追加：

```js
test('通道决策：uia2 ensure 失败（unavailable，槽空闲）→ 正常走 legacy', async () => {
  const exec = makeExec({});
  const stub = makeUia2Stub({ sourceImpl: async () => { const e = new Error('uia2 不可用'); e.kind = 'unavailable'; throw e; }, pid: null });
  const device = await createDeviceWithExecutor({ serial: 'test', exec, uia2: stub, waitReady: false });
  const r = await device.dumpTree({ fresh: true });
  assert.ok(r.nodes.length > 0, 'unavailable（服务没起来，槽空闲）应走 legacy 拿到树');
  assert.ok(exec.calls.some((c) => c.includes('uiautomator dump')), '应触碰 legacy 通道');
  await device.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/device-facade.test.js`
Expected: FAIL（当前靠 `/uia2 不可用/` 文案正则判定，e.kind='unavailable' 但 message 不含"不可用"时槽判定错误——本测试 message 含"不可用"所以当前会过；改为 message 不含"不可用"的形态才真正失败）

修正测试：`sourceImpl` 抛 `new Error('service not installed')` + `e.kind='unavailable'`（message 不含中文"不可用"，当前文案正则失配 → 槽被占误判 → 不碰 legacy → 失败）。

- [ ] **Step 3: 实现 kind 化**

`src/device/uia2.js:250`：
```js
    if (!(await ensure())) throw withKind(new Error('uia2 不可用'), 'unavailable');
```

`src/device/uia2.js:253-257`（source 非 200）：
```js
        const e = new Error(`uia2 source 失败: ${r.status}`);
        e.status = r.status;
        throw withKind(e, 'protocol');
```

`src/device/errors.js` classifyTransportError 在 `if (e.kind) return e.kind;` 后无需改（kind 直接透传）；但兜底正则段加 unavailable 识别（可选，保持向后兼容）。

`src/device/dump-channels.js:50`：
```js
        lastUia2SlotFree = kind === 'protocol' || kind === 'unavailable';
```
`src/device/dump-channels.js:73`：
```js
    const slotHeldError = lastUia2Error && !lastUia2SlotFree;
```
（删除 `/uia2 不可用/` 文案正则——kind 化后 lastUia2SlotFree 已正确标记）

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/device-facade.test.js`
Expected: PASS（43 tests）

- [ ] **Step 5: 运行全量测试**

Run: `npm test`
Expected: 594 tests，585 pass + 9 skip，0 fail

- [ ] **Step 6: 提交**

```bash
git add src/device/uia2.js src/device/errors.js src/device/dump-channels.js test/device-facade.test.js
git commit -m "fix(device): uia2 错误 kind 化（unavailable/protocol），槽判定不再依赖中文文案正则"
```

### Task 6: aiAssert 词表补录 + 断言步骤记账

**Files:**
- Modify: `src/tools/vocab.js`（aiAssert 标签）
- Modify: `report/viewer/src/components/icon-category.js`（aiAssert 图标）
- Modify: `bin/ask.js:961-965`（aiAssert 加 startStep/end + attachStepShot）
- Modify: `src/recorder/index.js:289`（addAssertion 扩展 screenshotId/evidenceSource/nudges 可选字段）
- Test: `test/tools-vocab.test.js`（aiAssert 标签守护）、`test/recorder-run.test.js`（断言新字段）

**Interfaces:**
- Consumes: `recorder.startStep(type, target)`、`recorder.attachScreenshot(index, buf)`
- Produces: `addAssertion({ text, passed, reason, screenshotId, evidenceSource, nudges })`（后三个可选，向后兼容）

- [ ] **Step 1: 写失败测试**

`test/recorder-run.test.js` 追加：

```js
test('addAssertion 扩展字段：screenshotId/evidenceSource/nudges 可选落盘', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'assert.yaml' });
  rec.addAssertion({ text: '数据集 hotlist 至少3条', passed: true, reason: '7条', screenshotId: 'runs/x/assert-0.png', evidenceSource: 'dataset', nudges: 1 });
  rec.addAssertion({ text: '列表倒序', passed: false, reason: '白屏' });
  const doc = await rec.finish('fail', { exitCode: 1 });
  assert.equal(doc.assertions[0].screenshotId, 'runs/x/assert-0.png');
  assert.equal(doc.assertions[0].evidenceSource, 'dataset');
  assert.equal(doc.assertions[0].nudges, 1);
  assert.equal(doc.assertions[1].screenshotId, undefined);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/recorder-run.test.js`
Expected: FAIL（新字段被丢弃）

- [ ] **Step 3: 实现**

`src/recorder/index.js:289`：
```js
  addAssertion({ text, passed, reason = null, screenshotId = null, evidenceSource = null, nudges = 0 } = {}) {
    const a = { text, passed, reason };
    if (screenshotId != null) a.screenshotId = screenshotId;
    if (evidenceSource != null) a.evidenceSource = evidenceSource;
    if (nudges > 0) a.nudges = nudges;
    this._assertions.push(a);
    this._schedulePartial();
  }
```

`src/tools/vocab.js` STEP_LABELS 加 `aiAssert: '断言判定',`（在 aiWaitFor 后）；ENGINE_STEP_TYPES 加 `'aiAssert'`。

`report/viewer/src/components/icon-category.js` 加 `aiAssert: 'assert',`。

`bin/ask.js` aiAssert 分支（约 961 行）：在 `parseVerdict` 前加 `const ah = recorder.startStep('aiAssert', stepText.slice(0, 40));`，判定后 `ah.end({ result: verdict.passed ? 'ok' : 'failed' });`，`attachStepShot(ah.index);`（终态截图，走既有 step 索引机制）。

本 Task 最小接线：aiAssert startStep/end + attachStepShot + addAssertion 传 `evidenceSource: datasetFacts ? 'dataset' : 'screen'`、`nudges`（催答轮数，从 aiAssert 催答循环计数）。判定输入截图（压缩 JPEG）的独立落盘（assert-<i> 文件名 + screenshotId 回填）在阶段四 Task 14 做（需 recorder.attachAssertionShot 新方法）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/recorder-run.test.js test/tools-vocab.test.js`
Expected: PASS

- [ ] **Step 5: 运行全量测试**

Run: `npm test`
Expected: 595 tests，586 pass + 9 skip，0 fail

- [ ] **Step 6: 提交**

```bash
git add src/recorder/index.js src/tools/vocab.js report/viewer/src/components/icon-category.js bin/ask.js test/recorder-run.test.js test/tools-vocab.test.js
git commit -m "feat(recorder): aiAssert 步骤记账 + 断言扩展字段（evidenceSource/nudges），词表补录"
```

---

## 阶段二：上下文治理迁移（Critical C-A1）

> 目标：四道治理对 Pi 1.6.0 的实际请求上下文生效，且不污染持久化会话历史。
> 已运行时验证：`appendContextEdit(targetId, null)` 删除、`{content}` 替换、`appendCustomMessageEntry` 注入 digest 三语义均正确；toolResult 的 role 不可改（edit 只换 content），折叠须用 null 删除 + custom user 摘要。

### Task 7: 治理执行后端迁移（appendContextEdit）

**Files:**
- Create: `src/session/context-governor.js`
- Modify: `src/session/image-prune.js`（pruneImages/pruneToolResults/pruneToolHistory 改为返回编辑指令）
- Modify: `src/session/context-window.js`（pruneStepHistory 改为返回编辑指令）
- Modify: `bin/ask.js`（getMsgs/foldForGateway/治理调度改用 governor）
- Test: `test/session-context-governor.test.js`（新建）
- Test: `test/session-image-prune.test.js`、`test/session-context-window.test.js`（改造为编辑指令断言）

**Interfaces:**
- Consumes: `sessionManager.appendContextEdit(targetId, replacement)`、`sessionManager.appendCustomMessageEntry(customType, content, display)`、`sessionManager.buildSessionProjection()`（entries[].sourceEntry.id + messages[]）
- Produces: `createContextGovernor({ sessionManager })` → `{ pruneImages(opts), pruneToolResults(opts), pruneToolHistory(opts), pruneStepHistory(stepCounts, opts), foldToolHistory() }`；各方法返回 `{replaced/folded/removed, changed}`

**关键设计（已运行时验证）：**
1. message→entryId 映射：`buildSessionProjection().entries` 的 `sourceEntry.id` 与 `messages[]` 按序对应；`entry.message === message` 引用共享（已验证）。
2. toolResult 折叠：role 不可改（appendContextEdit 只换 content），用 `appendContextEdit(tid, null)` 删除 + `appendCustomMessageEntry('ask-folded-tool-result', [{type:'text',text:'[工具结果] ...'}], false)` 注入 user 摘要（custom→LLM 转 user，已验证）。
3. assistant toolCall 折叠：`appendContextEdit(aid, {content: '[调用工具 tap {...}]'})`（纯文本 content，toolCall 块消失 → 请求侧无 tool_calls，已验证）。
4. 图片替换：`appendContextEdit(mid, {content: [占位文本块 + 保留的 image 块]})`（content 数组替换，保留最近 N 张）。
5. 窗口折叠：对最旧段每条消息 `appendContextEdit(id, null)` + 一条 `appendCustomMessageEntry('ask-step-digest', digest, false)`。
6. system 消息不可 edit（已验证抛错），治理跳过。
7. 幂等：重复 edit 同一 target 最新生效（已验证），治理可重复执行。

- [ ] **Step 1: 写失败测试**

新建 `test/session-context-governor.test.js`：

```js
// 上下文治理执行后端（appendContextEdit）：删除/替换/digest 注入三语义
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createContextGovernor } from '../src/session/context-governor.js';

function makeSession() {
  const sm = SessionManager.inMemory('/tmp');
  return sm;
}
const u = (t) => ({ role: 'user', content: [{ type: 'text', text: t }], timestamp: Date.now() });
const a = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }], timestamp: Date.now() });
const tc = { type: 'toolCall', id: 'c1', name: 'tap', arguments: { target: 'x' } };
const atc = () => ({ role: 'assistant', content: [tc], timestamp: Date.now(), provider: 'p', model: 'm', api: 'openai-completions', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: 'toolUse' });
const tr = () => ({ role: 'toolResult', toolCallId: 'c1', toolName: 'tap', content: [{ type: 'text', text: '{"ok":true}' }], isError: false, timestamp: Date.now() });

test('governor.foldToolHistory：旧工具轮折叠后投影无 toolCall 块、无 toolResult role', () => {
  const sm = makeSession();
  sm.appendMessage(u('q1'));
  sm.appendMessage(atc());
  sm.appendMessage(tr());
  sm.appendMessage(u('q2'));
  const gov = createContextGovernor({ sessionManager: sm });
  const r = gov.foldToolHistory();
  assert.ok(r.folded >= 2);
  const proj = sm.buildSessionProjection();
  assert.ok(!proj.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'toolCall')), '折叠后无 toolCall 块');
  assert.ok(!proj.messages.some((m) => m.role === 'toolResult'), '折叠后无 toolResult role');
});

test('governor.pruneStepHistory：超窗口删除最旧段 + digest 注入', () => {
  const sm = makeSession();
  sm.appendMessage(u('s1')); sm.appendMessage(a('r1'));
  sm.appendMessage(u('s2')); sm.appendMessage(a('r2'));
  sm.appendMessage(u('s3')); sm.appendMessage(a('r3'));
  sm.appendMessage(u('s4')); sm.appendMessage(a('r4'));
  const gov = createContextGovernor({ sessionManager: sm });
  const r = gov.pruneStepHistory([2, 2, 2, 2], { keepSteps: 3, digest: 'DIGEST' });
  assert.equal(r.changed, true);
  assert.equal(r.removed, 2);
  const proj = sm.buildSessionProjection();
  const texts = proj.messages.map((m) => Array.isArray(m.content) ? m.content.map((b) => b.text ?? '').join('') : String(m.content ?? ''));
  assert.ok(texts.some((t) => t.includes('DIGEST')), 'digest 已注入');
  assert.ok(!texts.includes('s1'), '最旧段已删除');
  assert.ok(texts.includes('s4'), '最近段保留');
});

test('governor.pruneImages：保留最近 N 张，更早替换为占位符', () => {
  const sm = makeSession();
  const img = (kb) => ({ type: 'image', mimeType: 'image/png', data: 'A'.repeat(kb * 1024) });
  sm.appendMessage({ role: 'user', content: [img(10), { type: 'text', text: 'q1' }], timestamp: Date.now() });
  sm.appendMessage({ role: 'user', content: [img(10), { type: 'text', text: 'q2' }], timestamp: Date.now() });
  sm.appendMessage({ role: 'user', content: [img(10), { type: 'text', text: 'q3' }], timestamp: Date.now() });
  sm.appendMessage({ role: 'user', content: [img(10), { type: 'text', text: 'q4' }], timestamp: Date.now() });
  const gov = createContextGovernor({ sessionManager: sm });
  const r = gov.pruneImages({ keepRecent: 3 });
  assert.equal(r.replaced, 1);
  const proj = sm.buildSessionProjection();
  const images = proj.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === 'image') : []);
  assert.equal(images.length, 3, '只保留最近 3 张');
});

test('governor 幂等：重复执行不重复删除/注入', () => {
  const sm = makeSession();
  sm.appendMessage(u('s1')); sm.appendMessage(a('r1'));
  sm.appendMessage(u('s2')); sm.appendMessage(a('r2'));
  const gov = createContextGovernor({ sessionManager: sm });
  gov.pruneStepHistory([2, 2], { keepSteps: 1, digest: 'D' });
  const n1 = sm.buildSessionProjection().messages.length;
  gov.pruneStepHistory([2, 2], { keepSteps: 1, digest: 'D' });
  const n2 = sm.buildSessionProjection().messages.length;
  assert.equal(n1, n2, '重复执行消息数不变');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/session-context-governor.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/session/context-governor.js**

完整实现（ESM import；`placeholderFor` 需在 image-prune.js 加 export，`countImages`/`TOOLRESULT_PLACEHOLDER` 已导出）：

```js
import { countImages, placeholderFor, TOOLRESULT_PLACEHOLDER } from './image-prune.js';
import { STEP_DIGEST_PREFIX } from './context-window.js';

export function createContextGovernor({ sessionManager }) {
  function projection() { return sessionManager.buildSessionProjection(); }

  function entryIdOf(message) {
    const proj = projection();
    for (const entry of proj.entries) {
      for (const m of entry.messages) {
        if (m === message) return entry.sourceEntry.id;
      }
    }
    return null;
  }

  function editContent(message, content) {
    const id = entryIdOf(message);
    if (!id) return false;
    try { sessionManager.appendContextEdit(id, { content }); return true; }
    catch { return false; }
  }

  function omit(message) {
    const id = entryIdOf(message);
    if (!id) return false;
    try { sessionManager.appendContextEdit(id, null); return true; }
    catch { return false; }
  }

  function injectUserText(customType, text) {
    sessionManager.appendCustomMessageEntry(customType, [{ type: 'text', text }], false);
  }

  function pruneImages({ keepRecent = 3 } = {}) {
    const msgs = projection().messages;
    const total = countImages(msgs);
    if (total <= keepRecent) return { total, kept: total, replaced: 0, changed: false };
    const keep = new Set();
    let seen = 0;
    for (let mi = msgs.length - 1; mi >= 0 && seen < keepRecent; mi--) {
      const c = msgs[mi]?.content;
      if (!Array.isArray(c)) continue;
      for (let bi = c.length - 1; bi >= 0 && seen < keepRecent; bi--) {
        if (c[bi]?.type === 'image') { keep.add(`${mi}:${bi}`); seen++; }
      }
    }
    let replaced = 0;
    for (let mi = 0; mi < msgs.length; mi++) {
      const c = msgs[mi]?.content;
      if (!Array.isArray(c)) continue;
      let changed = false;
      const next = c.map((b, bi) => {
        if (b?.type === 'image' && !keep.has(`${mi}:${bi}`)) { changed = true; replaced++; return placeholderFor(b); }
        return b;
      });
      if (changed) editContent(msgs[mi], next);
    }
    return { total, kept: total - replaced, replaced, changed: replaced > 0 };
  }

  function pruneToolResults({ keepRecent = 6, keepChars = 300 } = {}) {
    const msgs = projection().messages;
    let replaced = 0;
    let seen = 0;
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const m = msgs[mi];
      if (m?.role !== 'toolResult') continue;
      seen++;
      if (seen <= keepRecent) continue;
      const c = m.content;
      if (typeof c === 'string') {
        if (c.length > keepChars && !c.startsWith(TOOLRESULT_PLACEHOLDER)) {
          if (editContent(m, `${TOOLRESULT_PLACEHOLDER}: 原 ${c.length} 字符] ${c.slice(0, keepChars)}…`)) replaced++;
        }
      } else if (Array.isArray(c)) {
        let changed = false;
        const next = c.map((b) => {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > keepChars && !b.text.startsWith(TOOLRESULT_PLACEHOLDER)) {
            changed = true;
            return { ...b, text: `${TOOLRESULT_PLACEHOLDER}: 原 ${b.text.length} 字符] ${b.text.slice(0, keepChars)}…` };
          }
          return b;
        });
        if (changed && editContent(m, next)) replaced++;
      }
    }
    return { replaced, changed: replaced > 0 };
  }

  // 工具轮折叠：assistant toolCall → 纯文本 content；toolResult → null 删除 + user 摘要注入
  function foldToolRound(msgs, fromIdx, toIdx) {
    let folded = 0;
    const summaries = [];
    for (let i = fromIdx; i < toIdx; i++) {
      const m = msgs[i];
      if (m?.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'toolCall')) {
        const calls = m.content.filter((b) => b?.type === 'toolCall')
          .map((b) => `[调用工具 ${b.name ?? b.toolName ?? '?'} ${JSON.stringify(b.arguments ?? b.input ?? {}).slice(0, 120)}]`)
          .join(' ');
        const texts = m.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '');
        if (editContent(m, [{ type: 'text', text: [...texts, calls].filter(Boolean).join(' ') || calls }])) folded++;
      } else if (m?.role === 'toolResult') {
        const c = m.content;
        const txt = Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ') : String(c ?? '');
        summaries.push(`[工具结果] ${txt.slice(0, 300)}${txt.length > 300 ? '…' : ''}`);
        if (omit(m)) folded++;
      }
    }
    // 摘要按原顺序注入（每条 toolResult 一条 custom user 消息，保持时序）
    for (const s of summaries) injectUserText('ask-folded-tool-result', s);
    return folded;
  }

  function pruneToolHistory({ keepRecent = 1 } = {}) {
    const msgs = projection().messages;
    const assistantToolIdx = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'toolCall')) assistantToolIdx.push(i);
    }
    const keepFrom = keepRecent === 0 ? msgs.length
      : (assistantToolIdx.length > keepRecent ? assistantToolIdx[assistantToolIdx.length - keepRecent] : 0);
    const folded = foldToolRound(msgs, 0, keepFrom);
    return { folded, changed: folded > 0 };
  }

  function foldToolHistory() { return pruneToolHistory({ keepRecent: 0 }); }

  function pruneStepHistory(stepCounts, { keepSteps = 3, digest = '' } = {}) {
    const msgs = projection().messages;
    if (!Array.isArray(stepCounts)) return { removed: 0, changed: false };
    const k = stepCounts.length;
    if (k <= keepSteps) return { removed: 0, changed: false };
    let tail = 0;
    for (let i = k - keepSteps; i < k; i++) {
      const c = Number(stepCounts[i]);
      if (!Number.isFinite(c) || c < 0) return { removed: 0, changed: false };
      tail += c;
    }
    const keepFrom = msgs.length - tail;
    const start = msgs[0]?.role === 'system' ? 1 : 0;
    if (keepFrom >= msgs.length || keepFrom <= start) return { removed: 0, changed: false };
    let removed = 0;
    for (let i = start; i < keepFrom; i++) {
      if (omit(msgs[i])) removed++;
    }
    const text = String(digest || '').trim() || `${STEP_DIGEST_PREFIX}更早步骤的原文已按上下文窗口策略省略。`;
    injectUserText('ask-step-digest', text);
    return { removed, keptSteps: keepSteps, changed: removed > 0 };
  }

  return { pruneImages, pruneToolResults, pruneToolHistory, pruneStepHistory, foldToolHistory };
}
```

注意：`placeholderFor` 当前未导出（image-prune.js 内部函数），需加 export。`countImages` 已导出。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/session-context-governor.test.js`
Expected: PASS（4 tests）

- [ ] **Step 5: 改造 image-prune.js / context-window.js 为纯决策函数（保留原测试兼容）**

原 `pruneImages/pruneToolResults/pruneToolHistory/pruneStepHistory` 的原地改写版本**保留**（供既有测试与无 sessionManager 的回退路径），但标记为 deprecated 注释。governor 是新的执行后端。原测试不改（守护决策逻辑的正确性）。

- [ ] **Step 6: 接线 bin/ask.js**

- `getMsgs` 保留（lastAssistantText 仍读 state.messages——投影后 state.messages 已同步，已验证 `_refreshFinalizedContext`）。
- `foldForGateway` 改为 `gov.foldToolHistory()`（gov 在 createAskSession 后创建：`const gov = createContextGovernor({ sessionManager });`）。
- 步间治理（finally 段）改用 `gov.pruneImages/pruneToolResults/pruneToolHistory/pruneStepHistory`。
- `foldToolHistoryForFollowup(session)` 导出函数改为接受 gov 或删除（cmdAsk 也改用 gov）。
- 主循环前的恢复历史折叠（`bin/ask.js:589`）改用 `gov.foldToolHistory()`。

- [ ] **Step 7: 运行全量测试**

Run: `npm test`
Expected: 599 tests，590 pass + 9 skip，0 fail

- [ ] **Step 8: 提交**

```bash
git add src/session/context-governor.js src/session/image-prune.js src/session/context-window.js bin/ask.js test/session-context-governor.test.js
git commit -m "fix(session): 上下文治理迁移到 appendContextEdit，对 Pi 1.6.0 实际请求生效且不污染持久化历史"
```

---

## 阶段三：结构加固

> 目标：runOne 下沉可测、锁/缓存安全网补齐、死代码清理。

### Task 8: runOne 循环编排下沉

**Files:**
- Create: `src/session/run-loop.js`、`src/session/run-loop-helpers.js`
- Modify: `bin/ask.js`（runOne 瘦身为装配 + 调用 run-loop）
- Test: `test/session-run-loop.test.js`（扩展）

**Interfaces:**
- Consumes: `ctx`（createRunContext）、`session`（createAskSession）、`recorder`、`toolMap`、`planCache`、`gov`（context-governor）、`flags`、`caseObj`、`runDeadline`
- Produces: `runCaseLoop({ ctx, session, recorder, toolMap, planCache, gov, flags, caseObj, runDeadline, modelCfg })` → Promise<{ status, engineFailed }>（attachStepShot/foldForGateway 在 run-loop 内部构造，不作为参数——foldForGateway 用 gov.foldToolHistory，attachStepShot 用 recorder+device 闭包）

**下沉范围（bin/ask.js:470-1017 的循环体）：**
- batchGround（同屏批量视觉接地）
- 引擎步执行 + 降级链（waitIdle → batchGround → VLM → agent 轮）
- aiWaitFor（等元素 + WebView 视觉确认）
- ai/aiQuery/aiAssert 的 prompt + 催答 + 空轮重试 + 马拉松续作
- plan-cache 回放/写入
- 步间治理调度（gov 四道）
- 断言判定 + 终态

**留在 bin/ask.js 的装配：**
- 设备/recorder/store/ctx 创建、模型装配、提示词装配、session 创建、MCP 桥、pregrant、网络还原 finally、锁

- [ ] **Step 1: 写失败测试（fake session + fake device 驱动 runCaseLoop）**

`test/session-run-loop.test.js` 追加（fake device 参照 test/tools-layer.test.js 的 makeFakeDevice，此处内联最小形态）：

```js
import { runCaseLoop } from '../src/session/run-loop.js';
import { createRunContext } from '../src/session/create.js';
import { RunRecorder } from '../src/recorder/index.js';
import { buildTools, buildEngineTools } from '../src/tools/index.js';
import { createContextGovernor } from '../src/session/context-governor.js';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fakeSession({ answers = [] } = {}) {
  let i = 0;
  const messages = [];
  const prompts = [];
  return {
    prompts,
    agent: { state: { messages } },
    async prompt(text, opts) {
      prompts.push(text);
      messages.push({ role: 'user', content: [{ type: 'text', text }] });
      const ans = answers[Math.min(i++, answers.length - 1)] ?? '';
      messages.push({ role: 'assistant', content: [{ type: 'text', text: ans }] });
    },
    dispose() {},
  };
}

function fakeDevice(over = {}) {
  return {
    serial: 'fake-001',
    screencap: async () => ({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), size: { w: 720, h: 1280 } }),
    dumpTree: async () => ({ nodes: [], hash: 'h1', dumpMs: 1, fromCache: false }),
    locate: async () => ({ ok: true, bounds: [0, 0, 100, 100], center: [50, 50], strategy: 'exact_text', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: null }),
    tap: async () => ({ ok: true, latencyMs: 10, error: null }),
    longPress: async () => ({ ok: true, latencyMs: 10, error: null }),
    inputText: async (b, t) => ({ ok: true, readBack: t, error: null }),
    scroll: async () => ({ scrolls: 1, changed: true }),
    key: async () => ({ ok: true }),
    launch: async () => ({ ok: true, error: null }),
    terminate: async () => ({ ok: true }),
    waitIdle: async () => ({ stable: true, dumps: 1 }),
    waitForElement: async () => ({ appeared: true, dumps: 1 }),
    screenSize: async () => ({ w: 720, h: 1280 }),
    foreground: async () => ({ package: 'com.demo', activity: '.Main', resumedActivity: '.Main' }),
    netStatus: async () => ({ profile: 'off' }),
    netSetProfile: async (p) => ({ ok: true, profile: p, error: null }),
    vlmCache: new Map(),
    invalidateCache() {}, markDirty() {},
    close: async () => {},
    ...over,
  };
}

function setup(t, { device, answers, caseObj, flags = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorder = new RunRecorder({ runsDir: path.join(dir, 'runs'), caseName: caseObj?.name ?? 'test' });
  const ctx = createRunContext({ device: device ?? fakeDevice(), recorder, store: null, opts: { yes: true, ...flags } });
  ctx.stateDir = dir;
  const session = fakeSession({ answers });
  const sm = SessionManager.inMemory(dir);
  const gov = createContextGovernor({ sessionManager: sm });
  const toolMap = new Map([...buildTools(ctx), ...buildEngineTools(ctx)].map((tool) => [tool.name, tool]));
  return { ctx, recorder, session, gov, toolMap, dir };
}

test('runCaseLoop：纯引擎步用例（aiTap）零模型往返，终态 pass', async (t) => {
  const { ctx, recorder, session, gov, toolMap } = setup(t, { caseObj: { name: 'engine', steps: [{ type: 'aiTap', text: '热榜' }] } });
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true }, caseObj: { name: 'engine', steps: [{ type: 'aiTap', text: '热榜' }] }, runDeadline: 0, modelCfg: {}, planCache: { get: () => null, put() {}, delete() {} } });
  assert.equal(status, 'pass');
  assert.equal(session.prompts.length, 0, '引擎步零模型往返');
});

test('runCaseLoop：引擎步失败（降级也失败）→ 终态 fail', async (t) => {
  const device = fakeDevice({ locate: async () => ({ ok: false, bounds: null, center: null, strategy: 'none', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: 'LOCATE_MISS' }) });
  const caseObj = { name: 'engine-fail', steps: [{ type: 'aiTap', text: '不存在' }] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { device, caseObj, answers: ['未找到'] });
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true, quiet: true }, caseObj, runDeadline: 0, modelCfg: {}, planCache: { get: () => null, put() {}, delete() {} } });
  assert.equal(status, 'fail');
});

test('runCaseLoop：aiAssert 数据类断言注入数据集事实', async (t) => {
  const caseObj = { name: 'assert', steps: [{ type: 'aiAssert', text: '数据集 hotlist 中至少有3条记录' }] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { caseObj, answers: ['{"passed": true, "reason": "7条"}'] });
  ctx.datasetWrites = new Map([['hotlist', 7]]);
  ctx.store = { read: async () => [{ title: 'A' }, { title: 'B' }, { title: 'C' }] };
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true }, caseObj, runDeadline: 0, modelCfg: {}, planCache: { get: () => null, put() {}, delete() {} } });
  assert.equal(status, 'pass');
  assert.ok(session.prompts[0].includes('数据集事实'), '断言提示词应注入数据集事实');
});

test('runCaseLoop：timeout 到点 → 终态 timeout', async (t) => {
  const caseObj = { name: 'timeout', steps: [{ type: 'aiTap', text: '热榜' }, { type: 'aiTap', text: '推荐' }] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { caseObj });
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true }, caseObj, runDeadline: Date.now() - 1000, modelCfg: {}, planCache: { get: () => null, put() {}, delete() {} } });
  assert.equal(status, 'timeout');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/session-run-loop.test.js`
Expected: FAIL（runCaseLoop 不存在）

- [ ] **Step 3: 抽取 run-loop-helpers.js（纯函数）**

从 bin/ask.js 迁移：`lastAssistantText`、`attachStepShot` 工厂、`foldForGateway` 工厂。保持签名不变。

- [ ] **Step 4: 抽取 run-loop.js（循环编排）**

把 bin/ask.js:470-1017 的循环体迁入 `runCaseLoop`，参数化所有外部依赖（ctx/session/recorder/toolMap/planCache/gov/flags/caseObj/runDeadline/modelCfg）。bin/ask.js 的 runOne 改为装配后调用 `const { status } = await runCaseLoop({...});`。

**随下沉修复 M6（回放截图索引越界）**：plan-cache 回放成功后的 `attachStepShot(recorder.stepCount)`（bin/ask.js:827）传的是"下一个"索引，`_steps[stepCount]` 不存在 → 截图落盘但不挂任何步骤（孤儿 PNG）。改为 `attachStepShot(recorder.stepCount - 1)`（挂到回放产生的最后一步）。加守护测试：

```js
test('runCaseLoop：plan-cache 回放截图挂到最后一步（M6 回归）', async (t) => {
  const caseObj = { name: 'replay', steps: [{ type: 'ai', text: '点击热榜' }] };
  const { ctx, recorder, session, gov, toolMap } = setup(t, { caseObj, answers: [''] });
  const planCache = {
    get: () => ({ tool: 'tap', params: { target: '热榜' }, plan: [{ tool: 'tap', params: { target: '热榜' } }] }),
    put() {}, delete() {},
  };
  const { status } = await runCaseLoop({ ctx, session, recorder, toolMap, gov, flags: { yes: true }, caseObj, runDeadline: 0, modelCfg: {}, planCache });
  assert.equal(status, 'pass');
  const doc = await recorder.finish('pass');
  const last = doc.steps[doc.steps.length - 1];
  assert.ok(last.screenshot, '回放最后一步应有截图（不再孤儿）');
});
```

（本测试使 Task 8 新增测试数为 5 而非 4——全量测试数链相应 +1：Task 8 后 604，后续各 Task 顺延。为保持链一致，本测试计入 Task 8 的 +4 之外额外 +1，即 Task 8 实际 +5 → 604 tests。下方 Expected 已按 604 修正，后续 Task 9-25 的测试数在各自 Expected 中已含此偏移——**执行时以实跑为准，Expected 数字是预估，偏差 ±2 内不视为失败，只要 0 fail 且 skip=9**。）

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/session-run-loop.test.js`
Expected: PASS

- [ ] **Step 6: 运行全量测试（纯重构守护：既有测试数/通过数不变 + 新增 5 测试）**

Run: `npm test`
Expected: 604 tests（+5），595 pass + 9 skip，0 fail

**测试数链说明**：本计划各 Task 的 Expected 测试数是预估递增链（基线 584 → 最终约 627）。执行时以实跑为准：只要 0 fail、skip=9、且新增测试数与该 Task 声明一致，总数偏差 ±2 内不视为失败。最终 Task 25 以实跑总数为准更新文档。

- [ ] **Step 7: 提交**

```bash
git add src/session/run-loop.js src/session/run-loop-helpers.js bin/ask.js test/session-run-loop.test.js
git commit -m "refactor(session): runOne 循环编排下沉 run-loop，agent 循环可单测（fake session 驱动）"
```

### Task 9: plan-cache 安全网（键扩展 + 非幂等排除）

**Files:**
- Modify: `src/session/plan-cache.js`（planKey 纳入 serial+appVersion）
- Modify: `src/session/run-loop.js`（非幂等工具不进 plan、回放前页面校验）
- Modify: `src/device/index.js`（packageVersion 方法）
- Modify: `src/device/package-guard.js`（parsePackageVersion 解析函数，设备层纯函数避免 device→cli 环）
- Modify: `src/cli/pregrant.js`（re-export parsePackageVersion 保持测试 import 路径）
- Test: `test/plan-cache.test.js`（键扩展）、`test/cli-support.test.js`（版本解析）

**Interfaces:**
- Produces: `planKey({ caseId, stepText, serial, appVersion })`；`device.packageVersion(pkg)` → Promise<string|null>；`parsePackageVersion(dumpsysText)` → string|null

- [ ] **Step 1: 写失败测试**

`test/plan-cache.test.js` 追加：

```js
test('planKey：serial/appVersion 变化换键（跨设备/跨版本失效）', () => {
  const a = planKey({ caseId: 'c1', stepText: '点击热榜', serial: 'dev1', appVersion: '1.0' });
  assert.notEqual(a, planKey({ caseId: 'c1', stepText: '点击热榜', serial: 'dev2', appVersion: '1.0' }));
  assert.notEqual(a, planKey({ caseId: 'c1', stepText: '点击热榜', serial: 'dev1', appVersion: '2.0' }));
  assert.equal(a, planKey({ caseId: 'c1', stepText: '点击热榜', serial: 'dev1', appVersion: '1.0' }));
});
```

`test/cli-support.test.js` 追加：

```js
test('parsePackageVersion：从 dumpsys 文本提取 versionName', async () => {
  const { parsePackageVersion } = await import('../src/cli/pregrant.js');
  assert.equal(parsePackageVersion('versionName=9.31.0\nversionCode=931'), '9.31.0');
  assert.equal(parsePackageVersion('no version here'), null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/plan-cache.test.js test/cli-support.test.js`
Expected: FAIL（planKey 忽略 serial/appVersion；parsePackageVersion 不存在）

- [ ] **Step 3: 实现**

`planKey` 加 serial/appVersion 段（缺省 'unknown'，向后兼容旧键自然 miss）：
```js
export function planKey({ caseId, stepText, serial = 'unknown', appVersion = 'unknown' } = {}) {
  const h = createHash('sha1').update(String(stepText ?? '')).digest('hex').slice(0, 10);
  return `${caseId}::${serial}::${appVersion}::${h}`;
}
```

`src/device/package-guard.js` 加：

```js
// 从 dumpsys package 输出提取 versionName（plan-cache 跨版本失效用）
export function parsePackageVersion(dumpsysText) {
  const m = /versionName=(\S+)/.exec(String(dumpsysText ?? ''));
  return m ? m[1] : null;
}
```

`src/cli/pregrant.js` 加 re-export（保持测试 import 路径 `../src/cli/pregrant.js` 可用）：

```js
export { parsePackageVersion } from '../device/package-guard.js';
```

`src/device/index.js` 加（import parsePackageVersion from package-guard，无环）：

```js
    async packageVersion(pkg) {
      const text = await this.dumpsysPackage(pkg);
      return parsePackageVersion(text);
    },
```

依赖方向说明：parsePackageVersion 放设备层 package-guard（纯函数），cli/pregrant re-export——避免 device→cli 反向依赖。

run-loop 写 plan 时排除非幂等工具：`const NON_IDEMPOTENT = new Set(['data_store', 'net_profile', 'terminate', 'secret_get', 'sms_read']);`，`lastTool.calls.every(c => !NON_IDEMPOTENT.has(c.tool))` 才写。planKeyOf 调用处传 `serial: device.serial, appVersion: ctx.appVersion`（runOne 装配时采一次 `ctx.appVersion = await device.packageVersion(targetPackage).catch(() => null)`，targetPackage 来自 caseObj.targetPackage 或 launch 步）。

- [ ] **Step 4: 运行确认通过 + 全量**

Run: `node --test test/plan-cache.test.js test/cli-support.test.js && npm test`
Expected: plan-cache 6 tests、cli-support 24 tests PASS；全量 605 tests，596 pass + 9 skip，0 fail

- [ ] **Step 5: 提交**

```bash
git add src/session/plan-cache.js src/session/run-loop.js src/device/index.js src/device/package-guard.js src/cli/pregrant.js test/plan-cache.test.js test/cli-support.test.js
git commit -m "fix(session): plan-cache 键纳入 serial+appVersion，非幂等工具不进计划缓存"
```

### Task 10: 设备锁共享模式 + ask 加锁 + aborted per-group

**Files:**
- Modify: `src/cli/lock.js`（acquireLock mode='shared'、releaseLock 支持 shared）
- Modify: `bin/ask.js`（cmdAsk 加共享锁、cmdRun aborted per-group、fail 关 sharedBridge）
- Test: `test/cli-support.test.js`（共享锁）

**Interfaces:**
- Consumes: `acquireLock(root, serial, { staleMs, now, pid })`（既有）
- Produces: `acquireLock(root, serial, { mode: 'exclusive'|'shared', pid })`；shared 锁文件 `<serial>.shared-<pid>.lock`（同设备多 shared 共存）；exclusive 获取前扫描存活 shared 锁，有则拒绝；`releaseLock(root, serial, { mode, pid })` 只删本进程的 shared 锁

**设计**：exclusive 锁文件名不变（`<serial>.lock`，向后兼容）；shared 锁独立文件（`<serial>.shared-<pid>.lock`），内容 `{pid, ts, serial, mode:'shared'}`。exclusive 获取时先扫 `lockDir` 下该 serial 的全部 shared 锁文件，任一属主存活即拒绝（stale 判定同 exclusive：死进程超 staleMs 自动清）。shared 获取时检查 exclusive 锁是否存在且属主存活，有则拒绝。

- [ ] **Step 1: 写失败测试**

`test/cli-support.test.js` 追加（import 行补 `lockDir`）：

```js
test('acquireLock shared：同设备多个 shared 共存；exclusive 与 shared 互斥', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  const s1 = acquireLock(root, 'dev', { mode: 'shared', pid: process.pid });
  assert.equal(s1.ok, true);
  // 模拟另一进程的 shared 锁（直接写文件，pid 用本进程保证存活判定）
  const sharedPath = join(lockDir(root), 'dev.shared-99999999.lock');
  writeFileSync(sharedPath, JSON.stringify({ pid: process.pid, ts: Date.now(), serial: 'dev', mode: 'shared' }));
  const ex = acquireLock(root, 'dev', { mode: 'exclusive', pid: process.pid });
  assert.equal(ex.ok, false, '有存活 shared 锁时 exclusive 应被拒');
  assert.match(ex.reason, /shared|读锁/);
  // 清理 shared 后 exclusive 可获取
  fs.rmSync(sharedPath);
  const ex2 = acquireLock(root, 'dev', { mode: 'exclusive', pid: process.pid });
  assert.equal(ex2.ok, true);
});

test('acquireLock shared：exclusive 存活时 shared 被拒', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  acquireLock(root, 'dev', { pid: process.pid }); // exclusive
  const sh = acquireLock(root, 'dev', { mode: 'shared', pid: process.pid });
  assert.equal(sh.ok, false);
});

test('releaseLock shared：只删本进程的 shared 锁，不动他人', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-lock-'));
  acquireLock(root, 'dev', { mode: 'shared', pid: process.pid });
  const otherPath = join(lockDir(root), 'dev.shared-99999999.lock');
  writeFileSync(otherPath, JSON.stringify({ pid: 99999999, ts: Date.now(), serial: 'dev', mode: 'shared' }));
  releaseLock(root, 'dev', { mode: 'shared', pid: process.pid });
  assert.ok(existsSync(otherPath), '他人 shared 锁不得删除');
});
```

注意：`fs` 需在 import 行补（当前 cli-support.test.js 已 import `mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync`，需加 `rmSync` 或用 `fs` 命名空间——按既有风格用具名 import 补 `rmSync`）。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/cli-support.test.js`
Expected: FAIL（mode 参数被忽略，shared 锁不存在）

- [ ] **Step 3: 实现 lock.js 共享模式**

```js
// lockPath 不变；新增 sharedLockPath
export function sharedLockPath(root, serial, pid) {
  return path.join(lockDir(root), `${String(serial).replace(/[^\w.-]/g, '_')}.shared-${pid}.lock`);
}

// acquireLock 签名加 mode（缺省 'exclusive'，向后兼容）
export function acquireLock(root, serial, { staleMs = 10 * 60_000, now = Date.now, pid = process.pid, mode = 'exclusive' } = {}) {
  fs.mkdirSync(lockDir(root), { recursive: true });
  if (mode === 'shared') {
    // exclusive 存活 → 拒绝
    const exPath = lockPath(root, serial);
    try {
      const rec = JSON.parse(fs.readFileSync(exPath, 'utf8'));
      if (rec && Number.isFinite(rec.pid) && pidAlive(rec.pid)) {
        return { ok: false, reason: `设备 ${serial} 正被 PID ${rec.pid} 独占（exclusive 锁）` };
      }
    } catch { /* 无 exclusive 锁 */ }
    const p = sharedLockPath(root, serial, pid);
    let fd;
    try { fd = fs.openSync(p, 'wx'); }
    catch (e) {
      if (e.code === 'EEXIST') return { ok: true, path: p }; // 本进程已持有
      throw e;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid, ts: now(), serial, mode: 'shared' })); }
    finally { fs.closeSync(fd); }
    return { ok: true, path: p };
  }
  // exclusive：先扫存活 shared 锁
  const prefix = `${String(serial).replace(/[^\w.-]/g, '_')}.shared-`;
  let files = [];
  try { files = fs.readdirSync(lockDir(root)); } catch { files = []; }
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const fp = path.join(lockDir(root), f);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { rec = null; }
    if (rec && Number.isFinite(rec.pid) && pidAlive(rec.pid)) {
      return { ok: false, reason: `设备 ${serial} 正被 PID ${rec.pid} 以 shared 读锁占用` };
    }
    // 死进程 shared 锁：超 staleMs 清理
    let age;
    if (rec && Number.isFinite(rec.ts)) age = now() - rec.ts;
    else { try { age = now() - fs.statSync(fp).mtimeMs; } catch { age = 0; } }
    if (age >= staleMs) { try { fs.rmSync(fp); } catch { /* ignore */ } }
  }
  // exclusive 既有逻辑原样保留（O_EXCL 'wx' 创建 <serial>.lock → 写 {pid,ts,serial} → 返回 {ok:true,path}）：
  const p = lockPath(root, serial);
  let fd;
  try {
    fd = fs.openSync(p, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { rec = null; }
    if (rec && Number.isFinite(rec.pid) && pidAlive(rec.pid)) {
      return { ok: false, reason: `设备 ${serial} 正被 PID ${rec.pid} 占用（lock: ${p}）` };
    }
    let age;
    if (rec && Number.isFinite(rec.ts)) age = now() - rec.ts;
    else { try { age = now() - fs.statSync(p).mtimeMs; } catch { age = 0; } }
    if (Number.isFinite(age) && age < staleMs) {
      return { ok: false, reason: `设备 ${serial} 的锁属主已退出但未到清理期（${Math.ceil((staleMs - age) / 1000)}s 后可自动清理）` };
    }
    try { fs.rmSync(p); } catch { /* 删不掉 → 下面的 wx 会再失败并拒绝 */ }
    try { fd = fs.openSync(p, 'wx'); }
    catch (e2) {
      if (e2.code === 'EEXIST') return { ok: false, reason: `设备 ${serial} 的锁正被其它进程接管（lock: ${p}）` };
      throw e2;
    }
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid, ts: now(), serial })); }
  finally { fs.closeSync(fd); }
  return { ok: true, path: p };
}

// releaseLock 加 mode/pid（缺省 exclusive 行为不变）
export function releaseLock(root, serial, { mode = 'exclusive', pid = process.pid } = {}) {
  if (mode === 'shared') {
    try { fs.rmSync(sharedLockPath(root, serial, pid)); } catch { /* ignore */ }
    return;
  }
  const p = lockPath(root, serial);
  try {
    const { pid: owner } = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (owner === process.pid) fs.rmSync(p);
  } catch { /* ignore */ }
}
```

- [ ] **Step 4: 接线 bin/ask.js**

- `cmdAsk`（约 1084 行 createDevice 前）：`const lock = acquireLock(WORKSPACE.lockRoot, serial, { mode: 'shared' }); if (!lock.ok) fail(lock.reason);`，finally 加 `releaseLock(WORKSPACE.lockRoot, serial, { mode: 'shared' });`
- `cmdRun` 的 `aborted` 改为 per-group：`groups` 每项加 `aborted: false`，组内循环用 `g.aborted`，不再跨组传播。环境错误（exitCode 2）只终止本组后续用例。
- `fail()` 函数（约 56 行）：exit 前关 sharedBridgeRef：
```js
function fail(msg, code = 2) {
  console.error(`Error: ${msg}`);
  try { sharedBridgeRef?.close?.(); } catch { /* ignore */ }
  process.exit(code);
}
```
（sharedBridgeRef 是同步关闭——MCP bridge.close 是 async，fail 是同步函数；改用 `sharedBridgeRef?.close?.().catch(() => {})` 不 await，进程退出前尽力关。若需严格等待，fail 改 async 并让调用方 await——但 fail 在多处同步调用，改 async 影响面大；取尽力关方案，子进程泄漏风险低于现状。）

- [ ] **Step 5: 运行确认通过 + 全量**

Run: `node --test test/cli-support.test.js && npm test`
Expected: cli-support 26 tests PASS；全量 608 tests，599 pass + 9 skip，0 fail

- [ ] **Step 6: 提交**

```bash
git add src/cli/lock.js bin/ask.js test/cli-support.test.js
git commit -m "fix(cli): ask 加共享设备锁，--parallel 故障隔离 per-group，fail 路径关闭共享 MCP 桥"
```

### Task 11: 死代码清理（rollout / needsNetworkRestore / 假 flag）

**Files:**
- Delete: `src/device/rollout.js`、`test/device-rollout.test.js`
- Modify: `src/device/index.js:11`（import 删除）、`src/device/index.js:637-640`（rollout 门面删除）
- Modify: `src/state-mutations.js:15-17`（needsNetworkRestore 删除）
- Modify: `test/state-rollback.test.js:4`（import 删 needsNetworkRestore）、`test/state-rollback.test.js:23-27`（测试删除）
- Modify: `bin/ask.js:109`（usage 删 --rollback 行）、`bin/ask.js:305`（opts.rollback 删除）
- Modify: `src/session/create.js:19`（opts.rollback 删除）
- Modify: `src/cli/argv.js`（--rollback 不在 BOOL_FLAGS，是取值型，无需改表；usage 删除即可）
- Modify: `bin/ask.js:394-397`（--vlm-locate 语义统一：run 路径也检查 flag，缺省启用改为显式 `--vlm-locate` 或保留默认启用但 usage 说明）

**--vlm-locate 决策**：run 路径视觉接地默认启用是性能优化（引擎 MISS 时确定性接地，不耗 agent 轮），保留默认启用；usage 改为 `--vlm-locate  视觉定位兜底（run 默认启用；ask 需显式开启）`，消除"flag 近乎 no-op"的误导。ask 路径保持需 flag。

**--max-turns 决策**：DESIGN.md:2011 承诺但零实现。本计划**删除文档承诺**（阶段六 Task 24），不实现——单步轮次上限已由 marathon maxRounds（步级）与空轮重试 3 次（硬编码）覆盖，全局 --max-turns 语义与现有机制重叠，实现收益低。

**守护**：纯删除，测试数减少 8（rollout）+ 1（needsNetworkRestore）= 9。

- [ ] **Step 1: 确认零消费者**

Run: `grep -rn 'rollout\|needsNetworkRestore\|opts.rollback' src bin --include='*.js' | grep -v 'src/device/rollout.js\|src/device/index.js\|src/state-mutations.js\|bin/ask.js:305'`
Expected: 无输出（零外部消费者）

- [ ] **Step 2: 删除文件与代码**

```bash
git rm src/device/rollout.js test/device-rollout.test.js
```

- `src/device/index.js`：删 `import { withLocateRetry, StepRollout } from './rollout.js';` 与 `rollout: { withRetry..., createStepRollout... },` 块
- `src/state-mutations.js`：删 `export function needsNetworkRestore(ctx) {...}`
- `test/state-rollback.test.js`：删 import 中的 needsNetworkRestore 与对应测试
- `bin/ask.js`：删 usage 的 `--rollback <on|off>` 行、opts 的 `rollback: flags.rollback || 'on',`
- `src/session/create.js`：删 opts 的 `rollback: 'on',`
- `bin/ask.js` usage 的 --vlm-locate 行改为说明文字

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: 599 tests（-9），590 pass + 9 skip，0 fail

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "refactor: 删除零消费者死代码（rollout/needsNetworkRestore/--rollback 假 flag），--vlm-locate 语义说明统一"
```

### Task 12: 数据集跨进程写锁

**Files:**
- Modify: `src/store/dataset.js:233-240`（withFileLock 加跨进程 O_EXCL 锁）
- Test: `test/store-dataset.test.js`（跨进程并发测试，child_process fork）

**Interfaces:**
- Consumes: `withFileLock(file, fn)`（既有进程内链式锁）
- Produces: 跨进程锁文件 `<file>.lock`（O_EXCL），获取失败重试退避（50ms×20 次），超时抛错；写操作（append/upsert/clear）在跨进程锁内执行

**设计**：进程内链式锁保留（同进程串行）；跨进程锁包在链式锁内层——`withFileLock(file, async () => { await acquireCrossProcessLock(file); try { return await fn(); } finally { releaseCrossProcessLock(file); } })`。锁文件内容 `{pid, ts}`，死进程锁（pidAlive false 且超 10s）自动清理。append 的增量追加也需锁（读快照→写 的原子性）。

- [ ] **Step 1: 写失败测试**

`test/store-dataset.test.js` 追加（import 补 `fork`）：

```js
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('跨进程并发 upsert：两进程同时写同一数据集，行零丢失', async (t) => {
  const dir = tmpDir(t, 'ds-xproc-');
  // 子进程脚本：openDataset 后 upsert 50 行（主键 k 各异）
  const childScript = path.join(dir, 'writer.mjs');
  fs.writeFileSync(childScript, `
    import { openDataset } from ${JSON.stringify(fileURLToPath(new URL('../src/store/dataset.js', import.meta.url)))};
    const store = openDataset({ dataDir: ${JSON.stringify(dir)} });
    const tag = process.argv[2];
    for (let i = 0; i < 50; i++) {
      await store.upsert('t', 'k', [{ k: tag + '-' + i, v: i }]);
    }
  `);
  // 注意：子脚本的 import 路径需用绝对路径指向项目 src/store/dataset.js
  const projStore = fileURLToPath(new URL('../src/store/dataset.js', import.meta.url));
  fs.writeFileSync(childScript, `
    import { openDataset } from ${JSON.stringify(projStore)};
    const store = openDataset({ dataDir: ${JSON.stringify(dir)} });
    const tag = process.argv[2];
    for (let i = 0; i < 50; i++) {
      await store.upsert('t', 'k', [{ k: tag + '-' + i, v: i }]);
    }
  `);
  const run = (tag) => new Promise((resolve, reject) => {
    const c = fork(childScript, [tag], { stdio: 'ignore' });
    c.on('exit', (code) => code === 0 ? resolve() : reject(new Error('child exit ' + code)));
  });
  await Promise.all([run('a'), run('b')]);
  const store = openDataset({ dataDir: dir });
  const rows = await store.read('t');
  assert.equal(rows.length, 100, '两进程各 50 行零丢失');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/store-dataset.test.js`
Expected: FAIL（行丢失，<100）

- [ ] **Step 3: 实现跨进程锁**

`src/store/dataset.js` 加（import 补 `openSync, closeSync, rmSync, statSync, readdirSync` 与 `pidAlive`——pidAlive 在 cli/lock.js，store 不应依赖 cli 层；内联一个 `process.kill(pid, 0)` 判定）：

```js
const XPROC_STALE_MS = 10_000;
const XPROC_RETRY_MS = 50;
const XPROC_RETRIES = 40; // 2s 上限

function pidAliveLocal(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function acquireCrossProcessLock(file) {
  const lockPath = `${file}.lock`;
  for (let i = 0; i < XPROC_RETRIES; i++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() })); }
      finally { closeSync(fd); }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 死进程锁清理
      try {
        const rec = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (rec && Number.isFinite(rec.pid) && !pidAliveLocal(rec.pid) && Date.now() - rec.ts > XPROC_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* 损坏锁：按 mtime 判定 */ 
        try { if (Date.now() - statSync(lockPath).mtimeMs > XPROC_STALE_MS) { rmSync(lockPath, { force: true }); continue; } } catch { /* ignore */ }
      }
      await new Promise((r) => setTimeout(r, XPROC_RETRY_MS));
    }
  }
  throw new Error(`数据集写锁获取超时（2s）：${lockPath}`);
}

function releaseCrossProcessLock(file) {
  try {
    const rec = JSON.parse(readFileSync(`${file}.lock`, 'utf8'));
    if (rec && rec.pid === process.pid) rmSync(`${file}.lock`, { force: true });
  } catch { /* ignore */ }
}
```

`withFileLock` 改为：

```js
function withFileLock(file, fn) {
  const prev = FILE_LOCKS.get(file) ?? Promise.resolve();
  const run = prev.then(async () => {
    await acquireCrossProcessLock(file);
    try { return await fn(); }
    finally { releaseCrossProcessLock(file); }
  }, async () => {
    await acquireCrossProcessLock(file);
    try { return await fn(); }
    finally { releaseCrossProcessLock(file); }
  });
  FILE_LOCKS.set(file, run.then(() => {}, () => {}));
  return run;
}
```

注意：`readFileSync` 需 import（当前 dataset.js 用 `readFile` async 版）；跨进程锁用同步 IO（锁获取在 async 函数内但用同步 fs 简化，阻塞时间 <1ms 可接受）。

- [ ] **Step 4: 运行确认通过 + 全量**

Run: `node --test test/store-dataset.test.js && npm test`
Expected: dataset 14 tests PASS；全量 600 tests，591 pass + 9 skip，0 fail

- [ ] **Step 5: 提交**

```bash
git add src/store/dataset.js test/store-dataset.test.js
git commit -m "fix(store): 数据集跨进程写锁（O_EXCL + 重试），并行 run 不再丢行"
```

### Task 13: PNG 解码核心合并 + 灰度支持

**Files:**
- Modify: `src/image/png.js`（unfilter 已支持任意 bpp；decodePng 加 colorType=0 灰度支持）
- Modify: `src/device/png.js`（decodePng 委托 image/png 核心，返回 {channels, data} 适配）
- Test: `test/image-png.test.js`（灰度往返）、`test/device-png.test.js`（接口兼容守护）

**Interfaces:**
- Consumes: `image/png.decodePng(buf)` → `{width, height, bpp, colorType, pixels}`
- Produces: `device/png.decodePng(buf)` → `{width, height, channels, data}`（channels=bpp，data=pixels，灰度 channels=1）；pixelAt/screenSignature 等消费方不变

**设计**：image/png 的 decodePng 当前只支持 colorType 6/2（bpp 4/3），加 colorType 0（bpp 1）。device/png 的 decodePng 改为调用 image/png 核心 + 字段映射（`{width, height, channels: bpp, data: pixels}`）。device/png 的 chunk 越界校验（`off + 12 + len > buf.length`）比 image/png 更严格——合并时把该校验移入 image/png 核心（保留防护）。错误文案统一：image/png 用"不是合法 PNG"，device/png 测试断言 `/不是 PNG/`——合并后 device/png 委托核心，文案变为"不是合法 PNG"，仍匹配 `/不是 PNG/`（"不是合法 PNG" 含 "不是"+"PNG" 但正则 `/不是 PNG/` 要求"不是 PNG"连续——"不是合法 PNG"不匹配！需保留 device/png 的文案或改测试断言）。决策：image/png 核心错误文案改为"不是 PNG 文件"（兼容两边测试：image-png 测试断言 `/不是合法 PNG/` 需同步改为 `/不是 PNG/`）。

- [ ] **Step 1: 写灰度测试**

`test/image-png.test.js` 追加：

```js
test('decodePng：灰度（colorType=0）支持，bpp=1', () => {
  // 构造 2×2 灰度 PNG（filter 0）
  const w = 2, h = 2;
  const raw = Buffer.from([0, 10, 20, 0, 30, 40]); // 每行 filter byte + 2 灰度像素
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[12] = 0; // colorType 0
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  const dec = decodePng(png);
  assert.equal(dec.bpp, 1);
  assert.equal(dec.colorType, 0);
  assert.deepEqual([...dec.pixels], [10, 20, 30, 40]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/image-png.test.js`
Expected: FAIL（colorType 0 抛"仅支持 RGBA(6)/RGB(2)"）

- [ ] **Step 3: 实现合并**

`src/image/png.js` decodePng：
- `const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;`
- 错误文案 `不是合法 PNG` → `不是 PNG 文件`
- chunk 循环加越界校验：`if (off + 12 + len > buf.length) throw new Error(\`PNG chunk 越界: ${type}\`);`
- IHDR 长度校验（`len < 13` 抛错，从 device/png 移入）

`src/device/png.js` decodePng 改为：

```js
import { decodePng as decodeCore } from '../image/png.js';
export function decodePng(buf) {
  const { width, height, bpp, pixels } = decodeCore(buf);
  return { width, height, channels: bpp, data: pixels };
}
```

删除 device/png 的原 decodePng 实现（约 18-87 行）与 PNG_SIG/readUInt32/MAX_PIXELS（核心已有）。保留 pixelAt/isBlueish/isColorish/parseHexColor/screenSignature。

`test/image-png.test.js:33-34` 断言 `/不是合法 PNG/` → `/不是 PNG/`。

- [ ] **Step 4: 运行确认通过 + 全量**

Run: `node --test test/image-png.test.js test/device-png.test.js && npm test`
Expected: image-png 11 tests、device-png 10 tests PASS；全量 601 tests，592 pass + 9 skip，0 fail

- [ ] **Step 5: 提交**

```bash
git add src/image/png.js src/device/png.js test/image-png.test.js
git commit -m "refactor(image): PNG 解码核心合并（image/png 单实现），device/png 接口适配，补灰度支持"
```

---

## 阶段四：产品化（归因/配置/DSL 收敛/安全）

### Task 14: 断言归因证据链（判定截图落盘 + 报告联动）

**Files:**
- Modify: `src/recorder/index.js`（attachAssertionShot 方法：非 step 索引截图，文件名 `assert-<i>.png`）
- Modify: `src/session/run-loop.js`（aiAssert 判定用的压缩 JPEG 落盘 + screenshotId 传 addAssertion）
- Modify: `report/recorder.js`（buildDump 断言截图进 screenshots map、writeReport 读断言截图、toDataURL 支持 JPEG MIME）
- Modify: `report/viewer/src/components/AssertionCard.vue`（emit select-task + evidenceSource/nudges 展示）
- Modify: `report/viewer/src/App.vue`（断言卡 @select-task 接 onSelectTask）
- Test: `test/recorder-run.test.js`（attachAssertionShot）、`report/test/recorder.test.js`（断言截图进报告）

**Interfaces:**
- Produces: `recorder.attachAssertionShot(assertIndex, buffer)` → 相对路径（`runs/<runId>/assert-<i>.png`，JPEG 也落 .png 名——MIME 由 dataURL 头表达，文件名统一 .png 简化消费方）；`addAssertion({..., screenshotId})`；dump.assertions[].screenshotId → screenshots map 有对应 id

**设计**：断言判定输入是 540px 压缩 JPEG（run-loop 构造 promptImages 时已有），落盘为 `assert-<i>.<ext>`（ext 按 mimeType：jpeg→.jpg，png→.png）。报告端 writeReport 遍历 assertions，有 screenshotId 的读文件嵌 dataURL（MIME 按扩展名）。viewer 断言卡点击 → emit('select-task', execIndex, taskId)——但断言无 taskId；改为 emit('seek-screenshot', screenshotId)，App.vue 接住后在播放器定位到该截图对应帧（若截图不在任何 task 上，则显示独立断言截图预览）。简化方案：断言卡展示截图缩略图（img src = screenshots[screenshotId]），点击放大——不做帧跳转（断言截图与步骤截图是不同画面，帧跳转语义不成立）。

- [ ] **Step 1: 写失败测试（recorder）**

`test/recorder-run.test.js` 追加：

```js
test('attachAssertionShot：断言截图落盘 assert-<i>，路径回填 addAssertion', async (t) => {
  const runsDir = tmpRuns(t);
  const rec = new RunRecorder({ runsDir, caseName: 'assert.yaml' });
  const rel = rec.attachAssertionShot(0, PNG);
  assert.ok(rel.endsWith('assert-0.png'));
  rec.addAssertion({ text: '列表倒序', passed: true, reason: 'ok', screenshotId: rel });
  const doc = await rec.finish('pass');
  assert.equal(doc.assertions[0].screenshotId, rel);
  assert.ok(fs.existsSync(path.resolve(runsDir, rel)));
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 attachAssertionShot**

```js
  attachAssertionShot(assertIndex, buffer) {
    const file = `assert-${assertIndex}.png`;
    const abs = path.join(this._dir, file);
    const rel = toPosix(path.join(this._runsDir, this.runId, file));
    this._pendingWrites.push(fsp.writeFile(abs, buffer).catch(() => {}));
    return rel;
  }
```

- [ ] **Step 4: run-loop 接线**

aiAssert 分支：构造 promptImages 时保留压缩结果 `cc`（当前只取 base64），判定前 `const shotRel = recorder.attachAssertionShot(assertIdx, cc.buffer);`（assertIdx = ctx.assertions.length），addAssertion 传 `screenshotId: shotRel`。取图失败时 screenshotId 不传。

- [ ] **Step 5: 报告端接线**

`report/recorder.js` buildDump：assertions 透传时保留 screenshotId；writeReport 遍历 `run.assertions`，有 screenshotId 的生成 uuid、读文件（resolveScreenshotFile）、`writer.appendScreenshot(uuid, dataURL)`（MIME 按文件头：JPEG 魔数 FFD8 → image/jpeg，否则 image/png），screenshots map 加 uuid，assertion.screenshotId 替换为 uuid。

`toDataURL` 已支持 data: 前缀直通；Buffer 路径当前硬编码 image/png——改为按魔数判定：

```js
function toDataURL(data) {
  if (data instanceof Uint8Array) {
    const mime = data[0] === 0xFF && data[1] === 0xD8 ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${Buffer.from(data).toString('base64')}`;
  }
  const s = String(data);
  return s.startsWith('data:') ? s : `data:image/png;base64,${s}`;
}
```

- [ ] **Step 6: viewer 断言卡缩略图**

`AssertionCard.vue`：props 加 `screenshots: { type: Object, default: () => ({}) }`；有 screenshotId 的断言行渲染 `<img :src="screenshots[a.screenshotId]" class="assertion-shot">`（点击放大用既有全屏机制或简单 title 提示）；evidenceSource 显示为小标签（屏幕/数据集）；nudges>0 显示"催答 N 轮"。App.vue 传 `:screenshots="data.screenshots"`。

- [ ] **Step 7: 报告端测试**

`report/test/recorder.test.js` 追加：

```js
test('writeReport：断言截图嵌入报告（screenshotId → screenshots map）', async (t) => {
  const dir = tmpDir(t);
  const run = clone(FIXTURE);
  const shotPath = path.join(dir, 'assert-0.png');
  fs.writeFileSync(shotPath, PNG);
  run.assertions = [{ text: '列表倒序', passed: true, reason: 'ok', screenshotId: shotPath }];
  const out = await writeReport(run, { outPath: path.join(dir, 'r.html') });
  const html = fs.readFileSync(out, 'utf8');
  const [{ dump }] = extractDumps(html);
  const sid = dump.assertions[0].screenshotId;
  assert.ok(sid, '断言应有 screenshotId');
  assert.ok(dump.screenshots[sid] !== undefined, 'screenshots map 应含断言截图');
  assert.equal(countTag(html, IMAGE_TAG_TYPE), 1);
});
```

- [ ] **Step 8: 运行全量 + 提交**

Run: `npm test`
Expected: 603 tests，594 pass + 9 skip，0 fail

```bash
git add src/recorder/index.js src/session/run-loop.js report/recorder.js report/viewer/src/components/AssertionCard.vue report/viewer/src/App.vue test/recorder-run.test.js report/test/recorder.test.js
git commit -m "feat(report): 断言判定截图落盘 + 报告断言卡缩略图，evidenceSource/nudges 可复核"
```

### Task 15: 通过率口径修正

**Files:**
- Create: `report/viewer/src/utils/pass-rate.js`（纯函数，可 Node 测试）
- Modify: `report/viewer/src/App.vue`（passRate 改用纯函数，双指标）
- Test: `report/viewer/test/pass-rate.test.js`（新建）

**Interfaces:**
- Produces: `computePassRate({ executions, assertions })` → `{ assertionText, stepText }`；assertionText = "断言 x/y · N%"（无断言时 "—"）；stepText = "步骤 m/n 完成"（finished/total，原口径降级为辅助指标）

- [ ] **Step 1: 写失败测试**

新建 `report/viewer/test/pass-rate.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { computePassRate } from '../src/utils/pass-rate.js'

test('computePassRate：断言通过率为主指标', () => {
  const r = computePassRate({
    executions: [{ tasks: [{ status: 'finished' }, { status: 'failed' }] }],
    assertions: [{ passed: true }, { passed: false }, { passed: true }],
  })
  assert.equal(r.assertionText, '断言 2/3 · 67%')
  assert.equal(r.stepText, '步骤 1/2 完成')
})

test('computePassRate：无断言 → 断言指标 —', () => {
  const r = computePassRate({ executions: [{ tasks: [{ status: 'finished' }] }], assertions: [] })
  assert.equal(r.assertionText, '—')
  assert.equal(r.stepText, '步骤 1/1 完成')
})

test('computePassRate：空输入不抛错', () => {
  const r = computePassRate({ executions: [], assertions: [] })
  assert.equal(r.assertionText, '—')
  assert.equal(r.stepText, '—')
})
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 pass-rate.js**

```js
// 通过率口径（评审 M5 修复）：断言通过率为主指标（测试产品的本体），
// 步骤完成率降级为辅助指标——sleep/截图等无关步骤不再稀释"通过率"语义。
export function computePassRate({ executions = [], assertions = [] } = {}) {
  let total = 0
  let finished = 0
  for (const exec of executions) {
    const tasks = exec && Array.isArray(exec.tasks) ? exec.tasks : []
    for (const t of tasks) {
      if (!t) continue
      total++
      if (t.status === 'finished') finished++
    }
  }
  const stepText = total ? `步骤 ${finished}/${total} 完成` : '—'
  const a = Array.isArray(assertions) ? assertions.filter(Boolean) : []
  if (!a.length) return { assertionText: '—', stepText }
  const passed = a.filter((x) => x.passed).length
  const pct = Math.round((passed / a.length) * 100)
  return { assertionText: `断言 ${passed}/${a.length} · ${pct}%`, stepText }
}
```

- [ ] **Step 4: App.vue 接线**

`passRate` computed 改为 `computePassRate({ executions, assertions: data.assertions })`；顶部摘要条显示 `passRate.assertionText`（主）+ `passRate.stepText`（辅，小字）。原 `通过率` label 改为 `断言通过率`。

- [ ] **Step 5: 运行全量 + 提交**

Run: `npm test`
Expected: 606 tests，597 pass + 9 skip，0 fail

```bash
git add report/viewer/src/utils/pass-rate.js report/viewer/src/App.vue report/viewer/test/pass-rate.test.js
git commit -m "fix(viewer): 通过率口径修正——断言通过率为主指标，步骤完成率不再误导"
```

### Task 16: 配置体验（doctor 探活 + .env 加载 + family 可选 + probe 入口）

**Files:**
- Modify: `bin/ask.js`（顶部 .env 加载、doctor --model 探活、cmdDoctor --probe-family、runOne 缺模型配置 exit 2）
- Modify: `src/session/model.js`（validateModelConfig family 可选、inferFamilyFromName）
- Modify: `src/cli/argv.js`（OPTIONAL_VALUE_FLAGS 加 'probe-family'）
- Modify: `.env.example`（文案修正）
- Test: `test/session-layer.test.js`（family 推断）、`test/cli-support.test.js`（probe flag）

**Interfaces:**
- Produces: `inferFamilyFromName(name)` → string|null（从模型名推断 family：glm/qwen/deepseek/kimi/gemini/gpt 前缀）；`validateModelConfig` 只要求 url/key/name（family 可选）；`createModel` family 缺省时用 inferFamilyFromName + loadProbeFamily 回退，仍无则 family='custom'（坐标策略走 probe 缓存或报错）

**family 可选化设计**：family 在 createModel 里是 provider 注册名（任意字符串都行），坐标策略才需要真实 family。故 validateModelConfig 删 family 必填；createModel 的 `cfg.family || inferFamilyFromName(cfg.name) || 'custom'`；buildVlmLocate 的 resolveStrategy(modelCfg.family) 未命中时回退 loadProbeFamily(WORKSPACE.probeFile)，仍无则 VLM 定位返回结构化错误（locate.js:470 文案改为"请设置 ASK_MODEL_FAMILY 或运行 ask doctor --probe-family"）。

**.env 加载设计**：bin/ask.js 顶部（WORKSPACE 解析前）读 cwd/.env（Node fs，零依赖）：逐行 `KEY=VALUE`，跳过注释/空行，`process.env[KEY] ??= VALUE`（不覆盖已有环境变量）。支持引号包裹值。

- [ ] **Step 1: 写失败测试**

`test/session-layer.test.js` model describe 追加：

```js
  test('inferFamilyFromName：模型名推断 family', async () => {
    const { inferFamilyFromName } = await import('../src/session/model.js');
    assert.equal(inferFamilyFromName('glm-5.3-flash'), 'glm');
    assert.equal(inferFamilyFromName('deepseek-v4.1-flash'), 'deepseek');
    assert.equal(inferFamilyFromName('qwen3.8-flash'), 'qwen');
    assert.equal(inferFamilyFromName('kimi-k3'), 'kimi');
    assert.equal(inferFamilyFromName('gemini-2.0-flash'), 'gemini');
    assert.equal(inferFamilyFromName('gpt-4o'), 'gpt');
    assert.equal(inferFamilyFromName('unknown-model'), null);
  });

  test('validateModelConfig：family 可选（url/key/name 必填）', () => {
    assert.doesNotThrow(() => validateModelConfig({ url: 'u', key: 'k', name: 'n', family: '' }));
    assert.throws(() => validateModelConfig({ url: '', key: 'k', name: 'n', family: '' }), ModelConfigError);
  });
```

`test/cli-support.test.js` 追加：

```js
test('parseArgv：--probe-family 可选值 flag', () => {
  assert.equal(parseArgv(['doctor', '--probe-family']).flags['probe-family'], true);
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 model.js**

```js
// 模型名 → family 推断（registry FAMILY_ALIASES 的键前缀匹配）
export function inferFamilyFromName(name = '') {
  const n = String(name).toLowerCase();
  for (const fam of ['glm', 'qwen', 'deepseek', 'doubao', 'kimi', 'gemini', 'gpt', 'openai']) {
    if (n.startsWith(fam)) return fam === 'openai' ? 'gpt' : fam;
  }
  return null;
}
```

validateModelConfig：`const missing = ['url', 'key', 'name'].filter(...)`。
createModel：`const family = cfg.family || inferFamilyFromName(cfg.name) || 'custom';` 后续用 family 替代 cfg.family。

- [ ] **Step 4: bin/ask.js .env 加载 + doctor 探活 + probe 入口**

顶部（import 后、WORKSPACE 前）：

```js
// .env 加载（零依赖）：cwd/.env 逐行 KEY=VALUE，不覆盖已有环境变量
try {
  const envText = fs.readFileSync(path.resolve('.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch { /* 无 .env 正常 */ }
```

doctor --model 探活（checks.push 前）：

```js
    if (cfg.url && cfg.key && cfg.name) {
      try {
        const { createChatClient } = await import('../src/tools/ai.js');
        const chat = createChatClient({ url: cfg.url, key: cfg.key, model: cfg.name, timeoutMs: 15000 });
        await chat('ping', { maxRetries: 0 });
        checks.push({ item: 'model', ok: true, url: cfg.url, name: cfg.name, note: '探活通过' });
      } catch (e) {
        checks.push({ item: 'model', ok: false, url: cfg.url, name: cfg.name, error: `探活失败：${e.message}` });
      }
    } else {
      checks.push({ item: 'model', ok: false, note: '未配置 ASK_MODEL_*' });
    }
```

cmdDoctor --probe-family（flags['probe-family'] 时）：createDevice → screencap + screenSize → 选已知元素（左上角返回箭头：用 locate('返回') 或 uitree 找 contentDesc 含"返回"的节点 bounds）→ buildVlmLocate 的 chat → probeFamily({vlm, png, size, known, file: WORKSPACE.probeFile}) → 输出 family 或"探测失败"。无已知元素时提示用户手动指定 `--probe-family` 需屏幕上有返回箭头类已知位置元素。

runOne 缺模型配置：`if (!modelCfg.url || !modelCfg.key || !modelCfg.name) { console.error('模型配置缺失...'); return 2; }`（删除"无模型模式"分支）。

- [ ] **Step 5: .env.example 文案**

首行改为：`# ask CLI 环境变量（复制为 .env 后 CLI 自动加载；或直接 export）。不提交真实密钥。`
ASK_ADB 示例改为跨平台注释：`# ASK_ADB=/path/to/adb  # Windows: C:/Users/<you>/AppData/Local/Android/Sdk/platform-tools/adb.exe`
ASK_MODEL_URL 示例改为 `https://your-gateway/v1`（去掉私有网关）。

- [ ] **Step 6: argv.js + 运行全量 + 提交**

OPTIONAL_VALUE_FLAGS 加 'probe-family'。

Run: `npm test`
Expected: 609 tests，600 pass + 9 skip，0 fail

```bash
git add bin/ask.js src/session/model.js src/cli/argv.js .env.example test/session-layer.test.js test/cli-support.test.js
git commit -m "fix(cli): doctor 模型探活、.env 自动加载、family 可选化 + probe CLI 入口，配置缺失早失败"
```

### Task 17: 截图密码框遮罩 + password 回读感知

**Files:**
- Modify: `src/device/uitree.js:34-50`（makeNode 加 password 字段）
- Modify: `test/fixtures/ui-dump.expected.json`（全部节点加 password:false）
- Modify: `src/device/input.js:84-88`（readTextAt password 感知）
- Modify: `src/device/index.js:201-255`（inputText 回读：password 节点用掩码长度比对）
- Create: `src/device/screenshot-redact.js`
- Modify: `src/tools/index.js:92-115`（withRecording 截图前遮罩）
- Test: `test/device-uitree.test.js`、`test/device-input.test.js`、`test/device-screenshot-redact.test.js`（新建）、`test/device-facade.test.js`（password 回读）

**Interfaces:**
- Produces: UiNode.password: boolean；`readTextAt(flat, point)` password 节点返回 `'•'.repeat(text.length)`（掩码串，不泄明文）；`redactScreenshot(pngBuffer, nodes)` → Buffer（password 节点 bounds 区域填充灰色）

**password 回读设计**：Android 密码框的 a11y text 通常是掩码串（•）或空。inputText 的 ok 判定当前是 `readBack === want`——密码框必然不等。改为：目标节点 password=true 时，ok 判定用 `readBack.length === want.length`（掩码长度一致即认为输入成功；空回读也放行——部分 ROM 密码框 text 恒空），readBack 返回掩码串（不泄明文），error 文案不含 want 明文（当前 `期望「${text}」` 会泄密——password 时改为"密码框回读长度不一致"）。

**截图遮罩设计**：withRecording 的动作后截图链中，若本步是 input 且 ctx.secretCalls 有新增（secret 值刚输入），或设备树有 password 节点——对截图做遮罩。简化：每次动作后截图前，用最近一次 dumpTree 的缓存树（cache.peek()）找 password=true 节点 bounds，调 redactScreenshot 填充。无缓存树时不遮罩（尽力而为，不额外 dump）。

- [ ] **Step 1: 写失败测试（uitree password 字段）**

`test/device-uitree.test.js` 真实样本测试的 expected.json 需同步——先改夹具再加断言。新增独立测试：

```js
test('makeNode：password 属性解析（true/false）', () => {
  const xml = '<hierarchy><node index="0" text="•••" class="android.widget.EditText" password="true" bounds="[0,0][100,50]"/></hierarchy>';
  const nodes = parseXmlDump(xml);
  assert.equal(nodes[0].password, true);
  const xml2 = '<hierarchy><node index="0" text="x" class="android.widget.EditText" password="false" bounds="[0,0][100,50]"/></hierarchy>';
  assert.equal(parseXmlDump(xml2)[0].password, false);
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 makeNode + 夹具同步**

makeNode 加 `password: attrs.password === 'true',`。
`test/fixtures/ui-dump.expected.json`：全部节点对象加 `"password": false`（夹具 XML 只有根节点有 password="false"，其余节点无该属性 → false）。用脚本批量加（node -e 遍历 JSON 递归加字段）。

- [ ] **Step 4: readTextAt password 感知 + inputText 掩码比对**

`src/device/input.js`：

```js
export function readTextAt(flat, point) {
  const n = findNodeAtPoint(flat, point);
  if (!n) return null;
  if (n.password) return '\u2022'.repeat(String(n.text ?? '').length); // 掩码串，不泄明文
  return n.text ?? '';
}
```

`src/device/index.js` inputText：回读后判定处：

```js
        const node = findNodeAtPoint(flattenNodes(tree.nodes), xy);
        const isPassword = !!node?.password;
        const ok = isPassword
          ? (readBack == null || readBack.length === want.length) // 掩码长度一致或恒空回读放行
          : readBack === want;
        const res = {
          ok,
          readBack,
          error: ok ? null
            : isPassword ? '密码框回读长度不一致（掩码比对）'
            : readBack == null ? '回读失败：未在输入位置找到节点'
            : `回读不一致: 期望「${text}」实际「${readBack}」`,
          ...(usedFallback ? { strategy: 'input-text-fallback' } : {}),
        };
```

ASCII 降级条件 `readBack !== want` 改为 `!ok && !isPassword`（密码框不走 input text 降级——降级会二次输入）。

- [ ] **Step 5: screenshot-redact.js**

```js
// 截图密码框遮罩：password 节点 bounds 区域填充灰色，防凭据明文进报告截图。
import { decodePng, encodePng } from '../image/png.js';

export function redactScreenshot(pngBuffer, nodes) {
  const pwd = (nodes ?? []).filter((n) => n?.password && Array.isArray(n.bounds));
  if (!pwd.length) return pngBuffer;
  let dec;
  try { dec = decodePng(pngBuffer); } catch { return pngBuffer; }
  const { width, height, bpp, pixels } = dec;
  for (const n of pwd) {
    const [l, t, r, b] = n.bounds;
    for (let y = Math.max(0, t); y < Math.min(height, b); y++) {
      for (let x = Math.max(0, l); x < Math.min(width, r); x++) {
        const i = (y * width + x) * bpp;
        pixels[i] = 128; pixels[i + 1] = 128; pixels[i + 2] = 128;
        if (bpp === 4) pixels[i + 3] = 255;
      }
    }
  }
  return encodePng(width, height, pixels, dec.colorType);
}
```

注意：decodePng 返回的 pixels 是 Buffer（可写），encodePng 接受 pixels。灰度（bpp=1）时只填 pixels[i]=128。

- [ ] **Step 6: withRecording 遮罩接线**

`src/tools/index.js` 截图链（约 103-110 行）：

```js
                  const shot = await ctx.device.screencap();
                  let buf = shot.buffer;
                  try {
                    const cached = ctx.device.cachePeek?.();
                    if (cached?.nodes) {
                      const { redactScreenshot } = await import('../device/screenshot-redact.js');
                      const { flattenNodes } = await import('../device/uitree.js');
                      buf = redactScreenshot(buf, flattenNodes(cached.nodes));
                    }
                  } catch { /* 遮罩失败用原图（尽力而为） */ }
                  recorder.attachScreenshot(handle.index, buf);
```

设备门面加 `cachePeek: () => cache.peek()`（index.js device 对象）。

- [ ] **Step 7: 测试 + 全量 + 提交**

`test/device-screenshot-redact.test.js`（新建）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactScreenshot } from '../src/device/screenshot-redact.js';
import { encodePng, decodePng } from '../src/image/png.js';

test('redactScreenshot：password 节点区域被填充', () => {
  const w = 10, h = 10;
  const px = Buffer.alloc(w * h * 4, 255); // 全白 RGBA
  const png = encodePng(w, h, px, 6);
  const nodes = [{ password: true, bounds: [2, 2, 5, 5] }];
  const out = redactScreenshot(png, nodes);
  const dec = decodePng(out);
  const i = (3 * w + 3) * 4;
  assert.equal(dec.pixels[i], 128, '遮罩区像素应为灰');
  const j = (0 * w + 0) * 4;
  assert.equal(dec.pixels[j], 255, '非遮罩区不变');
});

test('redactScreenshot：无 password 节点原样返回', () => {
  const px = Buffer.alloc(4 * 4 * 4, 200);
  const png = encodePng(4, 4, px, 6);
  assert.equal(redactScreenshot(png, []), png);
});
```

`test/device-facade.test.js` 追加 password 回读测试（构造 FIXTURE_PASSWORD：search_input 节点加 password="true" text="••••"）：

```js
test('inputText：password 节点掩码回读，长度一致即 ok，不泄明文', async () => {
  const pwdFixture = FIXTURE.replace(
    '<node index="2" text="" resource-id="com.lgdg:id/search_input"',
    '<node index="2" text="••••" password="true" resource-id="com.lgdg:id/search_input"'
  );
  const exec = makeExec({ dumpScript: [pwdFixture] });
  const device = await createDeviceWithExecutor({ serial: 'test', exec });
  const r = await device.inputText([16, 1140, 704, 1220], 'abcd');
  assert.equal(r.ok, true, '掩码长度 4 = 输入长度 4 → ok');
  assert.equal(r.readBack, '••••');
  assert.ok(!JSON.stringify(r).includes('abcd'), '结果不得含明文');
  await device.close();
});
```

Run: `npm test`
Expected: 613 tests，604 pass + 9 skip，0 fail

```bash
git add src/device/uitree.js src/device/input.js src/device/index.js src/device/screenshot-redact.js src/tools/index.js test/fixtures/ui-dump.expected.json test/device-uitree.test.js test/device-screenshot-redact.test.js test/device-facade.test.js
git commit -m "feat(device): 密码框截图遮罩 + password 节点掩码回读，凭据图像面与回读面脱敏"
```

### Task 18: pregrant/dumpsys/getProp 白名单 + 记账失败告警

**Files:**
- Modify: `src/device/index.js:595-635`（dumpsysPackage/pmGrant/getProp/getProps 入口校验）
- Modify: `src/device/package-guard.js`（assertSafePropName 新增）
- Modify: `bin/ask.js:355-372`（pregrant terminate 异常不再吞掉后继续）
- Modify: `src/tools/env.js:27-30` + `src/session/run-loop.js`（recordNetMutation 失败告警）
- Modify: `src/device/index.js:28`（ensureConnected 首连失败 warn）
- Test: `test/device-action.test.js`（prop 白名单）、`test/tools-layer.test.js`（记账告警）

**Interfaces:**
- Produces: `assertSafePropName(name)`（只允许 `[\w.]`，拒绝 shell 元字符）；dumpsysPackage/pmGrant 入口 assertSafePackage；getProp/getProps 入口 assertSafePropName；recordNetMutation 失败 → console.warn + recorder.addRollback

- [ ] **Step 1: 写失败测试**

`test/device-action.test.js` 追加：

```js
test('assertSafePropName：合法属性名放行，shell 元字符拒绝', () => {
  const { assertSafePropName } = await import('../src/device/package-guard.js');
  assert.equal(assertSafePropName('ro.build.version.release'), 'ro.build.version.release');
  for (const bad of ['ro.x; id', 'ro.x$(id)', 'ro.x|cat', '']) {
    assert.throws(() => assertSafePropName(bad), /属性名非法/);
  }
});
```

（注意：test 回调需 async——改为 `test('...', async () => {...})`）

`test/tools-layer.test.js` 追加：

```js
test('net_profile：记账失败（netStatus 抛错）→ 告警 + addRollback，不静默', async () => {
  const rollbacks = [];
  const device = makeFakeDevice();
  device.netStatus = async () => { throw new Error('net status boom'); };
  const recorder = { ...makeFakeRecorder(), addRollback: (r) => rollbacks.push(r) };
  const ctx = makeCtx({ device, recorder });
  ctx.stateMutations = [];
  const tool = buildTools(ctx).find((t) => t.name === 'net_profile');
  await tool.execute('id1', { profile: '2g' }, undefined, undefined, {});
  assert.equal(rollbacks.length, 1, '记账失败应记 rollback');
  assert.match(rollbacks[0].reason, /记账|netStatus/);
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现白名单**

`src/device/package-guard.js` 加：

```js
const PROP_RE = /^[A-Za-z_][\w.]*$/;
export function assertSafePropName(name) {
  const n = String(name ?? '').trim();
  if (!PROP_RE.test(n)) throw new Error(`属性名非法: "${name}"（只允许字母/数字/下划线与点）`);
  return n;
}
```

`src/device/index.js`：
- dumpsysPackage：`assertSafePackage(pkg);` 在 try 内首行（非法抛错 → catch 返回 ''，调用方 pregrant 拿到空文本不 grant——安全）
- pmGrant：`assertSafePackage(pkg);` + permission 也需校验（`/^android\.permission\.[A-Z_]+$/`，pregrant 已过滤但设备层兜底）
- getProp：`assertSafePropName(name);`
- getProps：`list.forEach(assertSafePropName)`（非法抛错 → catch 返回空数组）

- [ ] **Step 4: pregrant terminate 异常处理**

`bin/ask.js:370`：`await device.terminate(pkg).catch(() => {});` 改为：

```js
          try { await device.terminate(pkg); }
          catch (e) { console.warn(`[pregrant] 终止 ${pkg} 失败（${e.message}），跳过预授权`); continue; }
```
（terminate 内含 assertSafePackage，非法包名抛错 → 跳过 pregrant，不再继续 grant）

- [ ] **Step 5: 记账失败告警**

`src/tools/env.js` net_profile 的 recordNetMutation catch：

```js
      } catch (e) {
        console.warn(`[warn] 切网记账失败（${e.message}）：设备可能无法自动还原档位`);
        try { ctx.recorder?.addRollback?.({ stepIndex: ctx.currentStepIndex ?? null, reason: `切网记账失败：${e.message}`, recovered: false }); } catch { /* ignore */ }
      }
```

run-loop 的 net 步同理。

`src/device/index.js:28`：`await adb.ensureConnected().catch(() => {});` 改为：

```js
  await adb.ensureConnected().catch((e) => { console.warn(`[warn] 设备首连失败（${e.message}），命令期仍有重连机会`); });
```

- [ ] **Step 6: 运行全量 + 提交**

Run: `npm test`
Expected: 615 tests，606 pass + 9 skip，0 fail

```bash
git add src/device/package-guard.js src/device/index.js bin/ask.js src/tools/env.js src/session/run-loop.js test/device-action.test.js test/tools-layer.test.js
git commit -m "fix(device): dumpsys/pmGrant/getProp 补白名单，切网记账失败显式告警，首连失败不再静默"
```

### Task 19: DSL 收敛（launch clean + 容器自动发现 + sleep 显式毫秒 + keyword 循环迁移）

**Files:**
- Modify: `src/tools/action.js:363-383`（launch clean 参数）
- Modify: `src/session/case-params.js:27`（launch 加 clean）、`sleep` 加 ms
- Modify: `src/session/case-steps.js:73`（buildToolCall launch 透传 clean）
- Modify: `src/session/case.js:166-175`（sleep ms 显式参数；steps 形态 >100 报错）
- Modify: `src/tools/data.js:19-58`（extractUi 容器自动发现）
- Modify: `src/tools/action.js`（launch 工具 parameters 加 clean）
- Modify: `cases/*.yaml`（防御咒语 → launch clean:true；keyword 循环 → 显式参数）
- Modify: `src/session/case-loop.js`（keyword 路径标记 deprecated）
- Test: `test/tools-layer.test.js`（launch clean、容器发现）、`test/session-layer.test.js`（sleep ms）

**Interfaces:**
- Produces: launch 工具 `clean?: boolean`（启动后 detectDialog+dismissDialog 循环最多 3 次）；extractUi 无 container 时自动发现重复结构容器；sleep `ms?: number` 显式毫秒参数

**容器自动发现设计**：无 container 时，找"重复结构"节点组——同 cls 同 resourceId 模式、bounds 不重叠、各自含 ≥1 个字段 selector 可命中子节点的节点，作为 scopes。算法：按字段 selector 找全部命中节点 → 对每个命中节点向上找最近祖先，该祖先的同 cls 兄弟节点 ≥2 个且各自含字段命中 → 取这些兄弟为 scopes。无重复结构时回退整屏 1 行（现状）。

**sleep 语义决策**：steps 形态 `sleep: 3000` 当前猜毫秒（>100）——改为：steps 形态 >100 报解析错（提示用 `ms: 3000` 显式毫秒或 `sleep: 3` 秒）；flow 形态保留毫秒兼容（外部框架资产）。新增 `ms` 参数行：`- sleep:\n    ms: 3000`。存量 cases 无 steps 形态 >100 的 sleep（已 grep 确认），compat 示例是 flow 形态不受影响。

**keyword 循环迁移**：cases 中 3 处 keyword 循环（c3:123、m1:19、compat 示例）迁移为显式 until/maxRounds/batch。resolveLoopPlan 的 keyword 路径保留但标记 deprecated（存量用户用例兼容），新用例 lint 加 warn（keyword-loop-deprecated 规则，阶段五 lint 平台无关化时一并加——本 Task 只迁移交付用例 + 注释标记）。

- [ ] **Step 1: 写失败测试（launch clean）**

`test/tools-layer.test.js` 追加：

```js
test('launch clean:true：启动后清弹窗（detectDialog → dismissDialog）', async () => {
  let dismissed = 0;
  const device = makeFakeDevice();
  device.foreground = async () => ({ package: 'com.google.android.permissioncontroller', activity: 'Grant' });
  device.locate = async (t) => t === '允许'
    ? { ok: true, bounds: [0, 0, 10, 10], center: [5, 5], strategy: 'exact_text', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: null }
    : { ok: false, bounds: null, center: null, strategy: 'none', treeCacheHit: false, vlmCacheHit: false, dumpMs: 1, identity: null, error: 'miss' };
  device.tap = async () => { dismissed++; return { ok: true, latencyMs: 1, error: null }; };
  device.dumpTree = async () => ({ nodes: [], hash: 'h', dumpMs: 1, fromCache: false });
  const ctx = makeCtx({ device });
  const tool = buildTools(ctx).find((t) => t.name === 'launch');
  const r = await tool.execute('id1', { appId: 'com.demo', clean: true }, undefined, undefined, {});
  assert.equal(getContent(r).ok, true);
  assert.ok(dismissed >= 1, 'clean 应触发弹窗关闭');
});
```

- [ ] **Step 2: 写失败测试（容器自动发现）**

```js
test('extractUi 无 container：重复卡片结构自动发现，多行提取', async () => {
  const device = makeFakeDevice();
  device.dumpTree = async () => ({
    nodes: [makeNode(0, 'page', 'android.widget.FrameLayout', '', [0, 0, 720, 1280], true, '', [
      makeNode(1, 'card1', 'android.view.ViewGroup', 'com.x:id/card', [0, 0, 720, 200], true, '', [
        makeNode(2, '春游', 'android.widget.TextView', 'com.x:id/title', [0, 0, 300, 60]),
      ]),
      makeNode(3, 'card2', 'android.view.ViewGroup', 'com.x:id/card', [0, 200, 720, 400], true, '', [
        makeNode(4, '秋游', 'android.widget.TextView', 'com.x:id/title', [0, 200, 300, 260]),
      ]),
    ])],
    hash: 'h1', dumpMs: 2, fromCache: false,
  });
  const ctx = makeCtx({ device, store: makeFakeStore() });
  const tool = buildTools(ctx).find((t) => t.name === 'data_extract');
  const r = await tool.execute('id1', { name: 'list', mode: 'ui', fields: [{ name: 'title', from: 'text', selector: 'resourceId=com.x:id/title' }] }, undefined, undefined, {});
  const body = getContent(r);
  assert.equal(body.count, 2, '无 container 也应发现 2 张卡片');
});
```

- [ ] **Step 3: 写失败测试（sleep ms）**

`test/session-layer.test.js` 追加：

```js
test('sleep ms 显式参数：steps 形态 >100 报错，ms 参数行生效', () => {
  assert.throws(() => parseCaseText('steps:\n  - sleep: 3000'), /毫秒|ms/);
  const c = parseCaseText('steps:\n  - sleep:\n    ms: 3000');
  assert.equal(c.steps[0].seconds, 3);
  const c2 = parseCaseText('steps:\n  - sleep: 2');
  assert.equal(c2.steps[0].seconds, 2);
});
```

- [ ] **Step 4: 运行确认失败**
- [ ] **Step 5: 实现 launch clean**

`src/tools/action.js` launch：parameters 加 `clean: Type.Optional(Type.Boolean(...))`；execute 在 `device.launch` 成功后：

```js
      if (params.clean && r.ok) {
        for (let i = 0; i < 3; i++) {
          await handlePopupBeforeAction(ctx, device);
          const fg = await device.foreground().catch(() => null);
          if (!fg?.package || !/permissioncontroller|packageinstaller/.test(fg.package)) break;
        }
      }
```

`case-params.js` launch 加 'clean'；BOOLEAN_KEYS 加 'clean'；`case-steps.js` buildToolCall launch 透传 `...(step.clean != null ? { clear: ... } : {})`——注意参数名是 clean 不是 clear：`...(step.clean != null ? { clean: coerce('clean', step.clean) } : {})`。

- [ ] **Step 6: 实现容器自动发现**

`src/tools/data.js` extractUi 的 scopes 构造后、scopeList 前：

```js
  if (!scopes.length && fields.length) {
    // 自动发现：字段命中节点的最近祖先，其同 cls+resourceId 兄弟 ≥2 且各含字段命中
    const hits = [];
    for (const f of fields) {
      for (const n of flat) {
        if (matchSelector(n, f.selector)) hits.push(n);
      }
    }
    const ancestorOf = (n) => { let p = n.parent; while (p && !p.cls) p = p.parent; return p; };
    const groups = new Map();
    for (const h of hits) {
      const a = ancestorOf(h);
      if (!a) continue;
      const key = `${a.cls}::${a.resourceId}`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(a);
    }
    for (const [, set] of groups) {
      if (set.size >= 2) { scopes.push(...set); break; }
    }
  }
```

注意：flat 节点有 parent 非枚举属性（uitree.js makeNode 挂的），perception.js 的 flattenNodes 保留 parent 引用。makeFakeDevice 的 makeNode 无 parent——测试需补 parent 或用 device/uitree 的 flattenNodes。决策：extractUi 改用 `import { flattenNodes } from '../device/uitree.js'`（有 parent），或自动发现用 bounds 包含关系找祖先（不依赖 parent）。取后者（更稳健）：

```js
    const ancestorOf = (n) => flat.filter((p) => p !== n && Array.isArray(p.bounds) && Array.isArray(n.bounds)
      && p.bounds[0] <= n.bounds[0] && p.bounds[1] <= n.bounds[1] && p.bounds[2] >= n.bounds[2] && p.bounds[3] >= n.bounds[3])
      .sort((a, b) => area(a) - area(b))[0]; // 最小包含祖先
```

- [ ] **Step 7: 实现 sleep ms + 用例迁移**

`case.js` sleep 分支：

```js
          if (type === 'sleep') {
            const rawV = Number(unquote(kv[2])) || 0;
            if (isFlow) {
              // flow 形态（外部框架）：>100 按毫秒兼容
              if (rawV > 100) { current.seconds = rawV / 1000; caseObj.warnings.push(...); }
              else current.seconds = rawV;
            } else {
              if (rawV > 100) throw new CaseParseError(`${source}:${i + 1} sleep 值 ${rawV} 歧义（秒还是毫秒？）：秒请直接写 ≤100，毫秒请用参数行 ms: ${rawV}`);
              current.seconds = rawV;
            }
          }
```

isFlow 标记：步骤区起始处 `if (/^flow\s*[:：]?\s*$/.test(trimmed)) { inSteps = true; isFlow = true; continue; }`。

续行参数 ms：`case-params.js` sleep 加 'ms'，NUMBER_KEYS 加 'ms'；case.js 续行处理后 `if (current.type === 'sleep' && current.ms != null) current.seconds = Number(current.ms) / 1000;`。

cases 迁移：c3:123、m1:19 的 keyword 循环加显式 until/maxRounds/batch 参数行；6 处防御咒语（m3/s3/s4/m4/c3/c4）替换为 `- launch: com.daimajia.gold\n    clean: true` + `- aiWaitFor: 等「搜索稀土掘金」出现`（保留原有等待）。

- [ ] **Step 8: 运行全量 + 提交**

Run: `npm test`
Expected: 618 tests，609 pass + 9 skip，0 fail

```bash
git add src/tools/action.js src/tools/data.js src/session/case-params.js src/session/case-steps.js src/session/case.js src/session/case-loop.js cases/ test/tools-layer.test.js test/session-layer.test.js
git commit -m "feat(dsl): launch clean 清弹窗、extractUi 容器自动发现、sleep 显式 ms、交付用例 keyword 循环迁移"
```

### Task 20: 账号工具 + sms_read 实现 + data diff 语义

**Files:**
- Modify: `src/tools/data.js`（test_account 工具、sms_read 走 device.readSms）
- Modify: `src/device/index.js`（readSms 方法）
- Create: `src/device/sms.js`（content://sms 读取）
- Modify: `src/cli/pregrant.js`（GRANTABLE 加 READ_SMS）
- Modify: `src/tools/index.js`（EXPECTED_TOOLS 加 test_account，26 个）
- Modify: `src/tools/vocab.js`（test_account 标签）
- Modify: `report/viewer/src/components/icon-category.js`（test_account 图标）
- Modify: `skills/android-login.md`（账号获取指引）
- Modify: `bin/ask.js:1196-1203`（data diff 按 _run 分组取最近两个 run）
- Test: `test/tools-layer.test.js`（test_account、sms_read）、`test/tools-vocab.test.js`、`test/device-sms.test.js`（新建）

**Interfaces:**
- Produces: `test_account` 工具 `{ key?: string }` → `{ ok, accounts }`（读 ASK_TEST_ACCOUNTS JSON，非密级，不走确认闸）；`device.readSms({ contains, limit })` → `{ ok, messages, error }`；`parseSmsContent(contentOutput)` → messages[]

**sms_read 设计**：`adb shell content query --uri content://sms/inbox --projection address,body,date --sort "date DESC"`（需 READ_SMS 权限）。解析 content query 输出（`Row: 0 address=..., body=..., date=...`）。contains 过滤 body。limit 默认 5。无权限时 content query 抛 SecurityException → ok:false + 提示 pregrant。设备层 readSms 走 adb.shell（withStderr 判定错误）。

**test_account 设计**：ASK_TEST_ACCOUNTS 是 JSON（`{"juejin":{"phone":"138..."}}`）或纯文本。工具参数 key 可选（缺省返回全部）。非密级（手机号）不走确认闸、不进 secretCalls。值进上下文但不落 run.json 明文？——手机号非密级，可落盘（DESIGN §19.7 明确"非密级可配置"）。但为稳妥，test_account 结果也登记 redact（可选）——决策：不脱敏（非密级，DESIGN 原文允许）。

**data diff 语义修正**：当前 `lastRun = rows[rows.length-1]._run`，prev = 所有非 lastRun 行（多次 run 混在一起）。改为：按 _run 分组，取最近两个 distinct run（按行 _ts 最大值排序），cur=最近 run 行，prev=次近 run 行。`--against last` 语义即"与上一次 run 对比"。

- [ ] **Step 1: 写失败测试（test_account）**

`test/tools-layer.test.js` 追加：

```js
test('test_account：读 ASK_TEST_ACCOUNTS，非密级不走确认闸', async () => {
  const old = process.env.ASK_TEST_ACCOUNTS;
  process.env.ASK_TEST_ACCOUNTS = JSON.stringify({ juejin: { phone: '13800000000' } });
  try {
    let confirmCalls = 0;
    const ctx = makeCtx({ opts: { yes: false }, confirm: async () => { confirmCalls++; return false; } });
    const tool = buildTools(ctx).find((t) => t.name === 'test_account');
    assert.ok(tool, 'test_account 应注册');
    const r = await tool.execute('id1', { key: 'juejin' }, undefined, undefined, {});
    const body = getContent(r);
    assert.equal(body.ok, true);
    assert.equal(body.accounts.phone, '13800000000');
    assert.equal(confirmCalls, 0, '非密级不走确认闸');
    assert.equal(ctx.secretCalls.length, 0);
  } finally {
    if (old === undefined) delete process.env.ASK_TEST_ACCOUNTS; else process.env.ASK_TEST_ACCOUNTS = old;
  }
});
```

- [ ] **Step 2: 写失败测试（sms 解析）**

新建 `test/device-sms.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmsContent } from '../src/device/sms.js';

test('parseSmsContent：解析 content query 输出', () => {
  const out = 'Row: 0 address=10690000, body=【掘金】验证码 123456，5分钟内有效, date=1750000000000\nRow: 1 address=10086, body=余额提醒, date=1749999999999';
  const msgs = parseSmsContent(out);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].address, '10690000');
  assert.ok(msgs[0].body.includes('123456'));
});

test('parseSmsContent：空输出/错误输出 → 空数组', () => {
  assert.deepEqual(parseSmsContent(''), []);
  assert.deepEqual(parseSmsContent('SecurityException'), []);
});
```

- [ ] **Step 3: 写失败测试（data diff）**

`test/store-query.test.js` 或新建 diff 纯函数测试——diff 逻辑抽取为 `src/store/diff.js` 纯函数：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffByRun } from '../src/store/diff.js';

test('diffByRun：取最近两个 distinct run 对比', () => {
  const rows = [
    { _run: 'r1', _ts: 100, v: 'old' },
    { _run: 'r2', _ts: 200, v: 'mid' },
    { _run: 'r3', _ts: 300, v: 'new' },
  ];
  const d = diffByRun(rows);
  assert.equal(d.lastRun, 'r3');
  assert.equal(d.currentRows, 1);
  assert.equal(d.previousRows, 1);
  assert.equal(d.previous[0].v, 'mid');
});
```

- [ ] **Step 4: 运行确认失败**
- [ ] **Step 5: 实现 sms.js + readSms**

```js
// src/device/sms.js
// content://sms/inbox 读取（需 READ_SMS 权限，pregrant 白名单已加）。
export function parseSmsContent(out) {
  const msgs = [];
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const m = /^Row:\s*\d+\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const fields = {};
    // key=value 逗号分隔，body 可能含逗号——用"下一个 key="边界切分
    const re = /(address|body|date)=([\s\S]*?)(?=,\s*(?:address|body|date)=|$)/g;
    let f;
    while ((f = re.exec(m[1]))) fields[f[1]] = f[2].trim();
    if (fields.body != null) msgs.push({ address: fields.address ?? '', body: fields.body, date: Number(fields.date) || 0 });
  }
  return msgs;
}

export async function readSms(adb, { contains = null, limit = 5 } = {}) {
  try {
    const { stdout, stderr } = await adb.shell(
      'content query --uri content://sms/inbox --projection address,body,date --sort "date DESC"',
      { timeoutMs: 10000, withStderr: true },
    );
    const out = `${stdout ?? ''}\n${stderr ?? ''}`;
    if (/SecurityException|Permission Denial/i.test(out)) {
      return { ok: false, messages: [], error: '无 READ_SMS 权限（用 --pregrant 预授权或手动授予）' };
    }
    let msgs = parseSmsContent(stdout);
    if (contains) msgs = msgs.filter((m) => m.body.includes(contains));
    return { ok: true, messages: msgs.slice(0, limit), error: null };
  } catch (e) {
    return { ok: false, messages: [], error: String(e?.message ?? e) };
  }
}
```

`src/device/index.js` 加 `async readSms(params) { return sms.readSms(adb, params); }`（import sms.js）。

- [ ] **Step 6: 实现 test_account + sms_read 接线 + diff**

`src/tools/data.js` 加 test_account 工具（buildDataTools 内）：

```js
  const testAccount = defineTool({
    name: 'test_account',
    label: 'test_account',
    description: '读取非密级测试账号（手机号等），来自环境变量 ASK_TEST_ACCOUNTS（JSON）。密钥类一律走 secret_get。',
    parameters: Type.Object({ key: Type.Optional(Type.String({ description: '账号组名（缺省返回全部）' })) }),
    execute: async (_id, params) => {
      const raw = process.env.ASK_TEST_ACCOUNTS;
      if (!raw) return textResult({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: '未配置 ASK_TEST_ACCOUNTS 环境变量' });
      let accounts;
      try { accounts = JSON.parse(raw); } catch { return textResult({ ok: false, error: 'ASK_TEST_ACCOUNTS 不是合法 JSON' }); }
      if (params.key) {
        const v = accounts?.[params.key];
        if (v == null) return textResult({ ok: false, error: `账号组 ${params.key} 不存在` });
        return textResult({ ok: true, accounts: v });
      }
      return textResult({ ok: true, accounts });
    },
  });
```

sms_read 的 device.readSms 分支已存在（data.js:317），设备层实现后自动生效。sms_read 的 `contains` 参数当前 schema 无——检查并加 `contains: Type.Optional(Type.String())`。

EXPECTED_TOOLS 加 'test_account'（26 个）；vocab 加 `test_account: '测试账号'`；icon-category 加 `test_account: 'extract'`；tools-layer 测试的 `EXPECTED_TOOLS.length, 25` → 26；tools-recording 测试标题 "23 个" → "26 个"（标题文字，断言用 EXPECTED_TOOLS.length 不变）。

`src/store/diff.js`：

```js
export function diffByRun(rows) {
  const byRun = new Map();
  for (const r of rows ?? []) {
    const run = r?._run ?? null;
    if (!byRun.has(run)) byRun.set(run, []);
    byRun.get(run).push(r);
  }
  const runs = [...byRun.entries()].map(([run, rs]) => ({ run, rs, maxTs: Math.max(...rs.map((r) => r._ts ?? 0)) }));
  runs.sort((a, b) => b.maxTs - a.maxTs);
  const cur = runs[0] ?? { run: null, rs: [] };
  const prev = runs[1] ?? { run: null, rs: [] };
  return { lastRun: cur.run, previousRun: prev.run, currentRows: cur.rs.length, previousRows: prev.rs.length, current: cur.rs.slice(0, 5), previous: prev.rs.slice(-5) };
}
```

bin/ask.js data diff 改用 diffByRun。

skills/android-login.md 第 3 步改为：`手机号来自 test_account 工具（读 ASK_TEST_ACCOUNTS）；用 input 输入。`

- [ ] **Step 7: 运行全量 + 提交**

Run: `npm test`
Expected: 622 tests，613 pass + 9 skip，0 fail

```bash
git add src/tools/data.js src/tools/index.js src/tools/vocab.js src/device/index.js src/device/sms.js src/cli/pregrant.js src/store/diff.js bin/ask.js skills/android-login.md report/viewer/src/components/icon-category.js test/tools-layer.test.js test/device-sms.test.js test/store-query.test.js
git commit -m "feat(tools): test_account 落地 ASK_TEST_ACCOUNTS，sms_read 实现 content://sms，data diff 按 run 分组"
```

### Task 21: 弱网/uia2 前置条件文档 + 错误文案中英统一

**Files:**
- Modify: `README.md`（弱网 net 脚本前置、uia2 Appium APK 前置、多机并发未实测标注）
- Modify: `bin/ask.js:210`（--parallel 错误文案中文化）
- Modify: `docs/VERIFICATION-OVERVIEW.md`（复现环境变量更新）

- [ ] **Step 1: README 加前置条件段**

在"远程设备"段后加：

```markdown
## 能力前置条件（重要）

- **弱网档位（net_profile）**：依赖设备侧 `/system/bin/net` 脚本（redroid 镜像自带）。普通模拟器/真机无此脚本时 `net_profile` 返回 `ok=false`（属预期，用例按容错设计），报告网络时间线为空。
- **uia2 快通道**：依赖设备预装 Appium uiautomator2 server APK（`io.appium.uiautomator2.server` + `.test`）。未预装时自动降级 legacy dump 通道（慢但可用）。安装方式：`adb install appium-uiautomator2-server.apk`（APK 从 Appium 发布页获取）。
- **多机并发（--parallel）**：实现已落地但**未在真实多机环境实测**（开发环境仅单设备）。设备农场接入前请先小规模验证。
```

- [ ] **Step 2: 错误文案中文化**

`bin/ask.js:210`：

```js
    fail(`--parallel ${parallel} 需要 ${parallel} 台设备，当前仅 ${serials.length} 台在线`);
```

- [ ] **Step 3: VERIFICATION-OVERVIEW 复现段更新**

`ASK_ADB=C:/Users/XiaoFeiLong/...` → `ASK_ADB=/path/to/adb`；`ASK_MODEL_URL=https://u2a.lycodeing.cn/v1` → `https://your-gateway/v1`。

- [ ] **Step 4: 全量测试 + 提交**

Run: `npm test`
Expected: 622 tests，613 pass + 9 skip，0 fail（纯文档/文案，测试数不变）

```bash
git add README.md bin/ask.js docs/VERIFICATION-OVERVIEW.md
git commit -m "docs: 弱网/uia2 前置条件声明，多机并发未实测标注，错误文案中文化"
```

---

## 阶段五：平台包抽象（安卓知识收敛，跨端留缝）

### Task 22: 平台包 + 选择缝

**Files:**
- Create: `src/platform/android.js`、`src/platform/index.js`
- Modify: `src/session/prompt.js:91-97`（L2 路径从平台包读）
- Modify: `src/cli/device-facts.js:20-27`（getprop 键表从平台包读）
- Modify: `src/lint/rules.js:45-49`（platform-fragment 平台无关化）
- Modify: `src/cli/pregrant.js:15-29`（GRANTABLE 从平台包读）
- Modify: `src/device/popup.js:15-31`（弹窗包名表从平台包读）
- Modify: `prompts/system.md:3`（L1 平台中性化）
- Modify: `src/tools/perception.js:162`（read description 示例从平台包读）
- Modify: `bin/ask.js:85`（usage 首行"安卓场景测试 agent" → "跨端场景测试 agent（当前：Android）"）
- Test: `test/platform.test.js`（新建）、`test/session-layer.test.js`（L1 中性化断言更新）、`test/lint-rules.test.js`（platform-fragment 扩展）

**Interfaces:**
- Consumes: 各模块当前的 Android 硬编码
- Produces: `resolvePlatform(name = 'android')` → 平台包对象；`androidPlatform` 含 l2PromptFile/factsProps/factsKeys/lintPlatformFragments/grantablePermissions/systemDialogPackages/residentSystemPackages/toolDescriptionExamples

**平台包形状（完整）：**

```js
// src/platform/android.js
// 安卓平台包：把散落各层的 Android 知识收敛为单一描述对象。
// 新增平台 = 新增一个平台包文件 + resolvePlatform 注册，引擎逻辑零改。
export const androidPlatform = {
  name: 'android',
  displayName: 'Android',
  l2PromptFile: 'prompts/system.android.md',
  // facts 采集：getprop 键 → facts 字段名
  factsProps: [
    { prop: 'ro.build.version.release', key: 'androidVersion' },
    { prop: 'ro.product.model', key: 'deviceModel' },
  ],
  // lint 平台片段规则：顶层出现这些键判 error（平台拼装冲突）
  lintPlatformFragments: ['android:', 'ios:', 'web:', 'desktop:', 'tasks:'],
  grantablePermissions: [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_AUDIO',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.READ_PHONE_STATE',
    'android.permission.READ_CONTACTS',
    'android.permission.CALL_PHONE',
    'android.permission.READ_SMS',
  ],
  systemDialogPackages: [
    'com.google.android.permissioncontroller',
    'com.android.permissioncontroller',
    'com.google.android.packageinstaller',
    'com.android.packageinstaller',
    'com.android.systemui',
  ],
  residentSystemPackages: ['com.android.systemui'],
  toolDescriptionExamples: {
    read: 'class=android.widget.TextView#index=1',
  },
};
```

```js
// src/platform/index.js
import { androidPlatform } from './android.js';

const PLATFORMS = { android: androidPlatform };

// 平台选择缝：当前只有 android；后续 iOS/Web/桌面在此注册。
// 缺省 android（向后兼容）；未知平台名报错（不静默回退）。
export function resolvePlatform(name = 'android') {
  const p = PLATFORMS[String(name).toLowerCase()];
  if (!p) throw new Error(`未知平台: ${name}（当前支持: ${Object.keys(PLATFORMS).join(', ')}）`);
  return p;
}

export function listPlatforms() { return Object.keys(PLATFORMS); }
```

**各消费点改造：**

1. `src/session/prompt.js`：`assemblePrompt` 加可选参数 `platform = null`（缺省 resolvePlatform('android')）；L2 读取 `path.join(projectRoot, platform.l2PromptFile)`；层名 `L2-android` 改为 `L2-${platform.name}`（**注意**：test/session-layer.test.js:31,49 断言层名 'L2-android'——保持 android 平台层名不变，其他平台才用新名；即 `name: platform.name === 'android' ? 'L2-android' : \`L2-${platform.name}\``）。facts 占位符填充（fillDeviceFacts）的 androidVersion 字段名保持（android 平台 factsKeys 映射）。

2. `src/cli/device-facts.js`：getProps 键表从 `platform.factsProps.map(f => f.prop)` 读；结果映射回 facts 字段用 `f.key`。函数签名加 `platform = null` 可选参数（缺省 android）。既有测试（cli-support.test.js:141-176）不传 platform → 缺省 android → 行为不变。

3. `src/lint/rules.js` platform-fragment：`test: (line) => new RegExp(\`^\\s*(${platform.lintPlatformFragments.map(escapeRe).join('|')})\`).test(line)`——RULES 是模块级常量，platform 在模块加载时 resolvePlatform('android') 取（lint 当前只服务 android 用例；跨平台 lint 后续按用例 platform 键动态选）。message 改为"顶层出现平台片段模式（平台拼装冲突）"。test/lint-rules.test.js:41-47 断言 android:/tasks: 仍命中（androidPlatform.lintPlatformFragments 含这两项）；新增 ios:/web: 命中测试。

4. `src/cli/pregrant.js`：`export const GRANTABLE = new Set(resolvePlatform('android').grantablePermissions);`（import platform）。

5. `src/device/popup.js`：`export const SYSTEM_DIALOG_PACKAGES = new Set(resolvePlatform('android').systemDialogPackages);` RESIDENT 同理。**注意依赖方向**：device 层 import platform 层——platform 是纯数据描述（零 import device），不构成循环。platform/index.js 只 import android.js（纯数据），安全。

6. `prompts/system.md:3`："你是安卓 UI 测试 agent" → "你是 UI 测试 agent"（平台身份由 L2 注入：system.android.md 首行加"当前平台：Android"）。test/session-layer.test.js:25 断言 `includes('UI 测试 agent')` 仍匹配。

7. `src/tools/perception.js:162` read description：`class=android.widget.TextView#index=1` 改为从平台包读——但 buildPerceptionTools(ctx) 无 platform 参数；ctx.opts 加 platform（createRunContext 缺省 android）。description 用 `ctx.platform?.toolDescriptionExamples?.read ?? 'class=android.widget.TextView#index=1'`。简化：ctx 加 `platform` 字段（createRunContext 里 `platform: resolvePlatform(opts.platform ?? 'android')`）。

8. `bin/ask.js:85` usage 首行改"ask — 跨端场景测试 agent（当前落地：Android）"。

- [ ] **Step 1: 写失败测试**

新建 `test/platform.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlatform, listPlatforms } from '../src/platform/index.js';
import { androidPlatform } from '../src/platform/android.js';

test('resolvePlatform：缺省 android，未知平台报错', () => {
  assert.equal(resolvePlatform().name, 'android');
  assert.equal(resolvePlatform('android').name, 'android');
  assert.throws(() => resolvePlatform('ios'), /未知平台/);
});

test('androidPlatform：知识表完整', () => {
  assert.ok(androidPlatform.l2PromptFile.includes('system.android.md'));
  assert.ok(androidPlatform.factsProps.some((f) => f.prop === 'ro.build.version.release'));
  assert.ok(androidPlatform.grantablePermissions.includes('android.permission.CAMERA'));
  assert.ok(androidPlatform.systemDialogPackages.includes('com.android.permissioncontroller'));
  assert.ok(androidPlatform.lintPlatformFragments.includes('android:'));
});

test('listPlatforms：当前只有 android', () => {
  assert.deepEqual(listPlatforms(), ['android']);
});
```

`test/lint-rules.test.js` E2 测试扩展：

```js
  test('E2 platform-fragment：顶层 android:/ios:/web:/tasks: 均拦', () => {
    const r = lintCaseText('steps:\n  - ai: x\nandroid: 1\nios: 1\nweb: 1\ntasks: []');
    const hits = r.filter((i) => i.rule === 'platform-fragment');
    assert.equal(hits.length, 4);
  });
```
（原 E2 测试断言 2 处命中——替换为 4 处，或保留原测试另加新测试。取另加新测试，原测试不动。）

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/platform.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现平台包 + 各消费点改造**

按上述 8 点逐一改造。每改一处跑相关测试确认不回归。

- [ ] **Step 4: 运行全量**

Run: `npm test`
Expected: 626 tests（+4：platform 3 + lint 1），617 pass + 9 skip，0 fail

- [ ] **Step 5: 提交**

```bash
git add src/platform/ src/session/prompt.js src/cli/device-facts.js src/lint/rules.js src/cli/pregrant.js src/device/popup.js src/tools/perception.js src/session/create.js prompts/system.md prompts/system.android.md bin/ask.js test/platform.test.js test/lint-rules.test.js
git commit -m "refactor(platform): 安卓知识收敛为平台包 + 选择缝，L1 提示词平台中性化（跨端留缝）"
```

---

## 阶段六：注释清理与文档对账

### Task 23: 注释清理（事故叙事 → 简洁 why）

**Files:** 全部 src/ + bin/ + report/（非测试）+ test/（回归意图简化）

**清理标准（可判定）：**
- **删除**：含"此前/旧实现/曾/实测/评审 #N/复审/终审/事故/回归用例："的叙事句（历史已在 git log 与 docs/VERIFICATION-REPORT.md）。例：`// 旧实现外层再包 _withTimeout 的 race：到点只 reject 不 kill，泄漏的 adb.exe 子进程会在设备侧与下一条命令交错（低概率高危害）。` → 删除整句。
- **保留**：当前行为的原因（"为什么这样做"）、平台约束（"Android 11 UiAutomation 槽排他"）、安全边界（"adb shell 是设备端 sh -c"）、契约引用（"§N"）、性能数据（"单次 dump 4-155s"——这是当前设计依据，保留但去掉"实测"前缀）。
- **压缩**：多行事故复盘 → 一行 why。例：dump-channels.js 的 11 行槽判定复盘 → `// Android 11 UiAutomation 槽排他：uia2 持槽时 legacy dump 必 rc=137，只能等退避后重试 uia2。`
- **测试注释**："回归用例：……（事故描述）" → "守护：……（当前行为）"。删除事故叙事，保留断言意图。
- **禁止**：清理时改任何代码逻辑。每文件清理后跑该文件相关测试，测试数/通过数必须不变。

**执行方式：** 逐文件清理，按模块分批提交（device/session/tools+cli+store+mcp+recorder+image+lint/bin+report/test 注释）。

- [ ] **Step 1: 清理 src/device/（28 文件）**

逐文件：读注释 → 按标准删/留/压 → 跑 `node --test test/device-*.test.js` 确认不变。

```bash
git add src/device/
git commit -m "refactor(device): 注释清理——事故叙事收敛为简洁 why"
```

- [ ] **Step 2: 清理 src/session/（12 文件）**

```bash
git add src/session/
git commit -m "refactor(session): 注释清理——事故叙事收敛为简洁 why"
```

- [ ] **Step 3: 清理 src/tools/ + src/cli/ + src/store/ + src/mcp/ + src/recorder/ + src/image/ + src/lint/ + src/state-mutations.js**

```bash
git add src/tools/ src/cli/ src/store/ src/mcp/ src/recorder/ src/image/ src/lint/ src/state-mutations.js
git commit -m "refactor: 注释清理——tools/cli/store/mcp/recorder/image/lint"
```

- [ ] **Step 4: 清理 bin/ask.js + report/recorder.js + report/cli.js + report/tools.js**

```bash
git add bin/ask.js report/recorder.js report/cli.js report/tools.js
git commit -m "refactor(cli,report): 注释清理——事故叙事收敛为简洁 why"
```

- [ ] **Step 5: 清理 test/ 注释（回归意图简化，不改断言）**

```bash
git add test/ report/test/ report/viewer/test/
git commit -m "refactor(test): 注释清理——回归叙事简化为守护意图"
```

- [ ] **Step 6: 全量测试守护**

Run: `npm test`
Expected: 626 tests，617 pass + 9 skip，0 fail（与 Task 22 后一致）

### Task 24: 文档对账 + 漂移守护脚本

**Files:**
- Create: `scripts/check-doc-drift.mjs`
- Modify: `README.md`（工具数 23→26、Node 版本声明、flag 清单）
- Modify: `docs/ARCHITECTURE.md`（工具数 23→26、门面方法清单补全）
- Modify: `docs/CONTRACT-CORE.md`（旧名 do/ask/assert → 新名说明、lint 规则数 8→9、src/net/profile.js → device/net-profile.js、门面签名补全 scrollUntil/waitForElement/tapEachRow/getProps 等）
- Modify: `docs/DESIGN.md`（底座版本 v0.84.4→1.6.0、标题"待确认"→已拍板、rollout 章节标记已移除、--max-turns 承诺删除、ASK_DEBUG 承诺删除、§13.1 退出码表补登 3=ask 空回答）
- Modify: `report/CONTRACT.md`（断言新字段 screenshotId/evidenceSource/nudges、截图 JPEG MIME、偏差登记 §7 追加）
- Modify: `package.json`（scripts 加 `"docs:drift": "node scripts/check-doc-drift.mjs"`）

**对账脚本检查项（可判定）：**
1. README/ARCHITECTURE 的"N 个工具"数字 === EXPECTED_TOOLS.length（运行时 import）
2. CONTRACT-CORE 的 lint 规则数 === ruleIds.length
3. usage 里的每个 flag 在 argv.js BOOL_FLAGS/OPTIONAL_VALUE_FLAGS 或取值型解析中有消费（grep flags.<name>）
4. DESIGN 的底座版本号 === package.json dependencies 版本
5. CONTRACT-CORE 的文件路径存在（src/net/profile.js 这类漂移）

- [ ] **Step 1: 写对账脚本（先跑确认当前漂移）**

```js
// scripts/check-doc-drift.mjs
// 文档承诺 → 代码消费者对账（评审 I5/M1 修复守护）。
// 检查项：工具数/lint 规则数/底座版本/契约文件路径。漂移即 exit 1。
import { readFileSync, existsSync } from 'node:fs';
import { EXPECTED_TOOLS } from '../src/tools/index.js';
import { ruleIds } from '../src/lint/rules.js';

const errors = [];
const readme = readFileSync('README.md', 'utf8');
const arch = readFileSync('docs/ARCHITECTURE.md', 'utf8');
const contract = readFileSync('docs/CONTRACT-CORE.md', 'utf8');
const design = readFileSync('docs/DESIGN.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// 1. 工具数
for (const [name, text] of [['README.md', readme], ['docs/ARCHITECTURE.md', arch]]) {
  const m = /(\d+)\s*个(?:\s*agent)?\s*工具/.exec(text);
  if (m && Number(m[1]) !== EXPECTED_TOOLS.length) {
    errors.push(`${name}: 工具数 ${m[1]} ≠ 实际 ${EXPECTED_TOOLS.length}`);
  }
}
// 2. lint 规则数
const lintM = /(\d+)\s*条规则|八条规则|九条规则/.exec(contract);
if (contract.includes('八条规则') && ruleIds.length !== 8) errors.push(`CONTRACT-CORE: lint "八条规则" ≠ 实际 ${ruleIds.length}`);
// 3. 底座版本
const piVer = pkg.dependencies['@earendil-works/pi-coding-agent'].replace(/[\^~]/, '');
const designM = /v(\d+\.\d+\.\d+)/.exec(design);
if (designM && designM[1] !== piVer) errors.push(`DESIGN.md: 底座版本 v${designM[1]} ≠ package.json ${piVer}`);
// 4. 契约文件路径
for (const m of contract.matchAll(/`src\/[\w/.-]+\.js`/g)) {
  const p = m[0].slice(1, -1);
  if (!existsSync(p)) errors.push(`CONTRACT-CORE: 文件路径不存在 ${p}`);
}

if (errors.length) {
  console.error('文档漂移：\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`文档对账通过（工具 ${EXPECTED_TOOLS.length}，lint 规则 ${ruleIds.length}，底座 ${piVer}）`);
```

Run: `node scripts/check-doc-drift.mjs`
Expected: exit 1（当前漂移：工具数 23≠26、八条规则≠9、v0.84.4≠1.6.0、src/net/profile.js 不存在）

- [ ] **Step 2: 修文档使对账通过**

- README.md:111 "23 个 agent 工具" → "26 个 agent 工具"；环境段 "Node 24" 保留（package.json 无 engines——加 `"engines": { "node": ">=22" }` 或改 README 为 "Node 22+（ESM）"，决策：README 改 "Node 22+"，因本机 Node 22 全绿且无 24 专属 API）
- ARCHITECTURE.md:23,242 "23 个" → "26 个"；门面方法清单补 scrollUntil/waitForElement/waitForAnyElement/tapEachRow/getProp/getProps/dumpsysPackage/pmGrant/packageVersion/readSms/cachePeek
- CONTRACT-CORE.md:201 "八条规则" → "九条规则"；:205 旧名 do/ask/assert 改为"旧名已废弃，新名 ai/aiQuery/aiAssert"；:16 `src/net/profile.js` → `src/device/net-profile.js`；§1.1 门面签名补全
- DESIGN.md:4 "v0.84.4" → "v1.6.0"；:1 标题"（全自研，待确认）" → "（全自研，已拍板）"；§5.0.6 rollout 段加"【已移除】rollout 状态机零生产消费者，已删除；失败回退由 run-loop 降级链承担"；:2011 --max-turns 行删除；:3094 ASK_DEBUG 行删除（零实现）；§13 退出码表补登 `3 = ask 问答空回答（本机扩展）`（bin/ask.js:1138 现状登记，保留语义）
- report/CONTRACT.md §2 assertions 形状加 screenshotId/evidenceSource/nudges 可选字段；§7 偏差登记追加本计划各 Task 的契约扩展

- [ ] **Step 3: 对账通过 + 全量测试 + docs:check**

Run: `node scripts/check-doc-drift.mjs && npm run docs:check && npm test`
Expected: 对账 exit 0；mermaid 34 图全绿；626 tests，617 pass + 9 skip，0 fail

- [ ] **Step 4: 提交**

```bash
git add scripts/check-doc-drift.mjs package.json README.md docs/ARCHITECTURE.md docs/CONTRACT-CORE.md docs/DESIGN.md report/CONTRACT.md
git commit -m "docs: 全量文档对账（工具数/版本/flag/契约），新增漂移守护脚本 docs:drift"
```

### Task 25: 收尾验证与合并

- [ ] **Step 1: 全量验证**

```bash
npm test                          # 626 tests，617 pass + 9 skip，0 fail
npm run docs:check                # mermaid 34 图全绿
node scripts/check-doc-drift.mjs  # 文档对账通过
npm run skills:sync               # 技能同步
npm --prefix report/viewer test   # viewer 50+ tests 全绿
npm --prefix report/viewer run build  # 报告壳构建
```

- [ ] **Step 2: 真机冒烟（如有设备）**

```bash
ASK_TEST_DEVICE=1 ASK_SERIAL=<serial> node --test test/integration-device.test.js
node bin/ask.js doctor --device --model
node bin/ask.js run cases/s1-hotlist.yaml --yes --timeout 900
```

- [ ] **Step 3: 评审问题清单逐条勾掉**

对照本计划"评审问题 → Task 映射"表，35 项 + 注释清理全部完成。

- [ ] **Step 4: 合并回 main**

按 `superpowers:finishing-a-development-branch` skill：worktree 分支 `fix/review-2026-11-25` → PR 或直接 merge（用户决策）。合并后删除 worktree。

---

## 评审问题 → Task 映射（覆盖度自查）

| 评审问题 | 严重度 | Task |
|---|---|---|
| C-P1 do/引擎步失败恒 pass | Critical | 2 |
| C-P2 数据断言系统性误判 | Critical | 3 |
| C-P3 timeout 仍 pass | Critical | 1 |
| C-A1 上下文治理半失效 | Critical | 7 |
| C-A2 dump 预算键错配 | Critical | 4 |
| I1 认知链 Android 泄漏 | Important | 22 |
| I2 runOne 上帝模块零测试 | Important | 8 |
| I3 plan-cache 脏缓存 | Important | 9 |
| I4 锁只覆盖 run / ask 无锁 | Important | 10 |
| I5 死代码/假 flag/契约漂移 | Important | 11, 24 |
| I6 pregrant 注入面 | Important | 18 |
| 产品 I1 配置体验断裂 | Important | 16 |
| 产品 I2 .env 不加载 | Important | 16 |
| 产品 I3 rollout 死代码 | Important | 11 |
| 产品 I4 并发故障不隔离 | Important | 10 |
| 产品 I5 归因缺位 | Important | 14, 15 |
| 产品 I6 断言无截图锚点 | Important | 6, 14 |
| 产品 I7 DSL 咒语 | Important | 19 |
| 产品 I8 collection 每屏1行 | Important | 19 |
| M1 PNG 双实现 | Minor | 13 |
| M2 YAML 子集/sleep 猜测 | Minor | 19 |
| M3 数据集跨进程竞争 | Minor | 12 |
| M4 uia2 APK 前置无文档 | Minor | 21 |
| M5 错误文案正则残留 | Minor | 5 |
| M6 静默降级不一致 | Minor | 18 |
| M7 截图脱敏盲区 | Minor | 17 |
| 产品 M1 文档数字漂移 | Minor | 24 |
| 产品 M2 死 flag | Minor | 11 |
| 产品 M3 --vlm-locate 语义 | Minor | 11 |
| 产品 M4 probe 无门 | Minor | 16 |
| 产品 M5 通过率口径 | Minor | 15 |
| 产品 M6 回放截图越界 | Minor | 8（下沉时修复 attachStepShot(recorder.stepCount) → 最后一步索引） |
| 产品 M7 错误文案/exit 3 | Minor | 21（文案）, 24（exit 3 契约登记：bin/ask.js:1138 的 `return answer ? 0 : 3` 是本机扩展，DESIGN §13.1 退出码表补登 3=ask 空回答，或改为 2 统一——决策：补登契约，保留 3 语义） |
| 产品 M8 弱网绑定 redroid | Minor | 21 |
| 产品 M9 ASK_TEST_ACCOUNTS 无消费 | Minor | 20 |
| 注释清理 | 用户要求 | 23 |

**全部 35 项问题 + 注释清理均有对应 Task，无遗漏。**

---

## 执行注意事项

1. **阶段依赖**：一→二→三→四→五→六 顺序执行。阶段三 Task 8（run-loop 下沉）依赖阶段一 Task 2/3 的终态/断言逻辑已就位；阶段四 Task 14 依赖阶段三 Task 8 的 run-loop 结构。
2. **纯重构守护**：Task 8/11/13/23 以"测试数/通过数变化符合预期"为守护，任何意外失败即回退重做。
3. **真机验证**：本计划全部测试用注入 fake（无真机依赖）；真机冒烟在 Task 25 可选执行。C-A2 的预算修复已用注入 stub 运行时复现确认。
4. **appendContextEdit 已验证**：三语义（null 删除/content 替换/custom 注入）+ toolResult role 保持 + 幂等 + system 不可 edit，均已运行时验证（见阶段二关键设计）。
5. **注释清理时机**：阶段六统一清理，之前各 Task 迁移代码时原样保留注释（避免清理与逻辑变更混在一个提交）。
