# 大文件拆分实施计划（device/index.js 与 session/case.js）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把两个"god-object"拆成职责单一的模块，同时删除零消费者的死导出，**不改变任何运行时行为**。

**Architecture:** 纯结构重构——每个新模块接收显式依赖（函数/对象），不引入新抽象层。两个文件各自独立成一个 PR，互不依赖。

**Tech Stack:** Node 24 ESM（`"type": "module"`）、`node:test`、typebox。零新依赖。

**Spec:** 本计划即 spec。背景见 `docs/superpowers/plans/` 下同类计划与本文件末尾「背景与证据」。

---

## Global Constraints

这些约束适用于**每一个** Task：

- **纯重构，零行为变更** —— 重构前后 `npm test` 的用例数、通过数、跳过数必须完全一致。若某 Task 改变了任何测试的期望值，说明它不是纯重构，需回退重做。
- **不引入新依赖** —— 只用 Node 内置模块 + 项目已有依赖。
- **ESM + 具名导出** —— 所有新模块用 `export function` / `export const`，不用 default export。
- **注释用中文** —— 迁移代码时**原样保留**原有注释（它们承载了实测数据与事故复盘，是项目资产）。新增注释说明"为什么拆"而非"是什么"。
- **公共 API 不变** —— `src/session/case.js` 的导出名与 `src/device/index.js` 的 `createDevice` / `createDeviceWithExecutor` 签名保持不变；外部调用方（`bin/ask.js`、`src/tools/`、`src/cli/`、`test/`）**不因拆分而改动**，除非该 Task 明确要求。
- **每个 Task 独立提交** —— 提交信息用中文，格式 `refactor(<模块>): <动作>`。
- **提交前必跑**：`npm test` 全绿 + `node --test <该 Task 涉及的测试文件>` 绿。

---

## File Structure

### Task 1–4：`src/device/index.js` 拆分

| 文件 | 职责 | 来源 |
|---|---|---|
| `src/device/tap-each-row.js` | 问卷/表单逐行作答状态机 | `index.js` 的 `tapEachRow` 方法（547–781 行，235 行） |
| `src/device/dump-channels.js` | UI 树抓取的通道策略（uia2 / execout / shell / file） | `index.js` 的 `dumpXmlRaw`（122–280 行） |
| `src/device/size-probe.js` | 屏幕尺寸探测与负缓存 | `index.js` 的 `getSize` + `SIZE_RETRY` |
| `src/device/index.js` | 设备门面（保留 `createDevice` / `createDeviceWithExecutor` 与 device 对象） | 其余 |

### Task 5–7：`src/session/case.js` 拆分

| 文件 | 职责 | 来源 |
|---|---|---|
| `src/session/case-params.js` | 参数表与取值转换（`PARAM_KEYS_BY_TYPE` / `PARAM_KEYS` / `NUMBER_KEYS` / `BOOLEAN_KEYS` / `coerce`） | `case.js` 58–148 行 |
| `src/session/case-steps.js` | 步骤类型集合与工具调用映射（`buildToolCall`） | `case.js` 22–44、319–351 行 |
| `src/session/case-loop.js` | 循环计划与 selector 文本提取（`resolveLoopPlan` / `waitSelectorFromText`） | `case.js` 375–430 行 |
| `src/session/case.js` | 用例文本解析（`parseCaseText`）+ 重新导出（保持外部 API 不变） | 其余 |

### 删除的零消费者导出

| 符号 | 位置 | 证据 |
|---|---|---|
| `loadCase` | `case.js:313` | 全仓 0 处外部引用 |
| `AGENT_TYPES` | `case.js:22` | 全仓 0 处外部引用 |
| `ASSERT_TYPES` | `case.js:23` | 全仓 0 处外部引用 |
| `WAIT_TYPES` | `case.js:25` | 全仓 0 处外部引用 |
| `SPECIAL_TYPES` | `case.js:35` | 全仓 0 处外部引用 |

> `QUERY_TYPES`（1 处）、`ENGINE_TYPES`（1 处）、`COORD_TYPES`（2 处）**保留**——有外部消费者。

---

## Task 1: 抽取 `tapEachRow` 为独立模块

**Files:**
- Create: `src/device/tap-each-row.js`
- Modify: `src/device/index.js`（删除 547–781 行的方法体，改为调用新模块）
- Test: `test/device-facade.test.js`（现有用例应**无改动**通过）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  ```js
  // src/device/tap-each-row.js
  export function createTapEachRow({ adb, dumpTree, getSize, decodePng, parseHexColor, isBlueish, isColorish, pixelAt, matchNode }) {
    // 返回 async ({ rows, tap, stopWhen, maxRounds, verify, verifyColor, profile, onQuestion }) => result
  }
  ```

**背景（必读）**：`tapEachRow` 内部只用到三个外部能力——`adb`（shell 命令）、`dumpTree`（取 UI 树）、`getSize`（屏幕尺寸）。其余（`decodePng` / `parseHexColor` / `isBlueish` / `isColorish` / `pixelAt`）来自 `src/device/png.js`，`matchNode` 来自 `src/device/locate.js`。**必须以参数注入，不得从 `index.js` import**（会造成循环依赖：`index.js` 要 import 新模块，新模块又 import `index.js`）。

- [ ] **Step 1: 记录重构前的测试基线**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
```

记录到 scratchpad：`BASE_TESTS=523 BASE_PASS=514 BASE_FAIL=0 BASE_SKIP=9`（以实际输出为准）。

- [ ] **Step 2: 抽取方法体到新模块**

创建 `src/device/tap-each-row.js`，把 `index.js` 547–781 行的方法体**逐字**搬进 `createTapEachRow` 工厂函数：

```js
// 逐行作答状态机（§5.4.6）：问卷/表单一行一行作答。
//
// 从 device/index.js 抽出（原为 235 行的方法体，是该文件最大的单体）——
// 抽出的理由：它是**自包含的状态机**，只依赖 adb / dumpTree / getSize 三个能力，
// 与门面的其余职责（树缓存、定位、动作分发）无关。依赖以参数注入，
// 避免与 index.js 形成循环依赖。
import { decodePng, parseHexColor, isBlueish, isColorish, pixelAt } from './png.js';
import { matchNodeSelector } from './locate.js';

export function createTapEachRow({ adb, dumpTree, getSize }) {
  return async function tapEachRow({ rows, tap, stopWhen = null, maxRounds = null, verify = true, verifyColor = null, profile = null, onQuestion = null } = {}) {
    // ↓↓↓ 原 547–781 行方法体逐字搬入（保留全部原注释）↓↓↓
  };
}
```

搬入时对原方法体做**一处**必要改写（仅限标识符作用域适配，不改逻辑）：

1. `index.js` 里 `matchNode` 是 `matchNodeSelector` 的别名 import
   （`import { matchNodeSelector as matchNode } from './locate.js'`，index.js:7）。
   新模块直接用原名 import：`import { matchNodeSelector as matchNode } from './locate.js';`
   ——方法体内的 `matchNode(...)` 调用**无需改动**。
   `pixelAt` / `isBlueish` / `isColorish` / `decodePng` / `parseHexColor` 同理，
   从 `./png.js` import 同名函数即可。

**不要**改任何条件判断、循环边界、计数器增减或注释内容。

- [ ] **Step 3: 改 `index.js` 调用新模块**

在 `index.js` 中，把 547–781 行替换为：

```js
    async tapEachRow(opts = {}) {
      return tapEachRowImpl(opts);
    },
```

并在 `createDeviceWithExecutor` 内（`const device = {` 之前）加：

```js
  // 逐行作答状态机（从本文件抽出，见 tap-each-row.js）
  const tapEachRowImpl = createTapEachRow({ adb, dumpTree, getSize });
```

在 `index.js` 顶部加 import：

```js
import { createTapEachRow } from './tap-each-row.js';
```

- [ ] **Step 4: 验证测试无改动且通过**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail|skipped)"
```

Expected：**PASS 0 fail**，且用例数/通过数/跳过数与 Step 1 的基线**完全一致**。

```bash
node --test test/device-facade.test.js 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"
```

Expected：0 fail。

- [ ] **Step 5: 确认无循环依赖**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
grep -n "^import" src/device/tap-each-row.js
```

Expected：**不含** `from './index.js'`。

```bash
node --input-type=module -e "import('./src/device/index.js').then(()=>console.log('index.js 加载 OK'))"
```

Expected：`index.js 加载 OK`。

- [ ] **Step 6: 提交**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git add src/device/tap-each-row.js src/device/index.js
git commit -m "refactor(device): 抽取 tapEachRow 状态机为独立模块

tapEachRow 是 index.js 中最大的单体（235 行方法体），但它是自包含的状态机，
只依赖 adb / dumpTree / getSize 三个能力，与门面的其余职责无关。依赖以参数
注入，避免与 index.js 形成循环依赖。

纯结构重构：测试用例数/通过数/跳过数不变。"
```

---

## Task 2: 抽取 UI 树抓取通道策略

**Files:**
- Create: `src/device/dump-channels.js`
- Modify: `src/device/index.js`（删除 `dumpXmlRaw` 122–280 行，改为调用新模块）
- Test: `test/device-dumptransport.test.js`（现有用例应无改动通过）

**Interfaces:**
- Consumes: Task 1 的 `createTapEachRow`（无直接依赖，两者独立）
- Produces:
  ```js
  // src/device/dump-channels.js
  export function createDumpChannels({ adb, getUia2, uia2DeadUntil, setUia2DeadUntil, getLastUia2Error, setLastUia2Error, getLastUia2SlotFree, setLastUia2SlotFree, isTimeoutSupported, getTimeoutSupported, setTimeoutSupported, log }) {
    // 返回 async ({ budgetMs = null } = {}) => xml
  }
  ```

**背景（必读）**：`dumpXmlRaw` 混合了三类关注点——(a) uia2 通道与退避状态机、(b) legacy 三通道（execout / shell / file）的尝试顺序、(c) 预算裁剪。抽出后 `index.js` 只负责"调通道拿 XML"与"解析成树"。

由于 uia2 退避状态（`uia2DeadUntil` / `lastUia2Error` / `lastUia2SlotFree` / `timeoutSupported`）在 `index.js` 里是闭包变量，抽取时用 **getter/setter 回调**注入，避免把状态整体搬走。

- [ ] **Step 1: 记录基线**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
```

- [ ] **Step 2: 抽取 `dumpXmlRaw`**

创建 `src/device/dump-channels.js`，把 122–280 行逐字搬入 `createDumpChannels` 工厂：

```js
// UI 树抓取的通道策略：uia2（快）/ legacy 三通道 execout→shell→file（耐久）。
//
// 从 device/index.js 抽出——原函数混合了通道顺序、uia2 退避状态机与预算裁剪
// 三类关注点，是该文件第二大单体。退避状态仍由 index.js 持有，
// 通过 getter/setter 回调注入（不整体搬走状态，避免状态所有权漂移）。
export function createDumpChannels({ adb, uia2, budgetOf, onUia2Error, getTimeoutSupported }) {
  return async function dumpXmlRaw({ budgetMs = null } = {}) {
    // ↓↓↓ 原 122–280 行逐字搬入 ↓↓↓
  };
}
```

搬入时的改写（仅作用域适配）：

- `uia2DeadUntil = 0` → `budgetOf.setUia2DeadUntil(0)`
- `uia2DeadUntil = Date.now() + UIA2_BACKOFF.fatalMs` → `budgetOf.setUia2DeadUntil(Date.now() + UIA2_BACKOFF.fatalMs)`
- `lastUia2Error = ...` → `onUia2Error(...)`
- `lastUia2SlotFree = ...` → `budgetOf.setLastUia2SlotFree(...)`
- `timeoutSupported`（局部 let）→ 通过 `getTimeoutSupported()` 读取

**不要**改任何通道顺序、重试次数、超时常量或条件判断。

- [ ] **Step 3: 改 `index.js`**

删除 122–280 行的 `dumpXmlRaw` 定义，改为：

```js
  // UI 树抓取（通道策略见 dump-channels.js）
  const dumpXmlRaw = createDumpChannels({
    adb,
    uia2,
    budgetOf: {
      setUia2DeadUntil: (v) => { uia2DeadUntil = v; },
      setLastUia2SlotFree: (v) => { lastUia2SlotFree = v; },
    },
    onUia2Error: (msg) => { lastUia2Error = msg; },
    getTimeoutSupported: () => timeoutSupported,
  });
```

并加 import：

```js
import { createDumpChannels } from './dump-channels.js';
```

**注意**：`dumpXmlRaw` 必须在 `uia2` / `uia2DeadUntil` / `lastUia2Error` / `lastUia2SlotFree` / `timeoutSupported` **声明之后**才创建（保持原有声明顺序，否则 TDZ 报错）。

- [ ] **Step 4: 验证**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail|skipped)"
node --test test/device-dumptransport.test.js 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"
```

Expected：全部 0 fail，用例数与基线一致。

- [ ] **Step 5: 提交**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git add src/device/dump-channels.js src/device/index.js
git commit -m "refactor(device): 抽取 UI 树抓取通道策略为独立模块

dumpXmlRaw 混合了通道顺序（uia2/execout/shell/file）、uia2 退避状态机与
预算裁剪三类关注点。抽出后门面只负责调通道拿 XML 与解析成树；退避状态仍由
index.js 持有，通过 getter/setter 注入。

纯结构重构：测试用例数/通过数/跳过数不变。"
```

---

## Task 3: 抽取屏幕尺寸探测

**Files:**
- Create: `src/device/size-probe.js`
- Modify: `src/device/index.js`（删除 `getSize` 与 `SIZE_RETRY`）
- Test: `test/device-facade.test.js`（现有用例应无改动通过）

**Interfaces:**
- Consumes: 无（独立任务）
- Produces:
  ```js
  // src/device/size-probe.js
  export function createSizeProbe({ adb, bootSize }) {
    // 返回 async () => { w, h } | null
  }
  ```

**背景（必读）**：`getSize` 带负缓存（失败后冷却，避免每个工具立刻重复撞墙），逻辑自包含，只依赖 `adb` 与可选的 `bootSize`（waitForBoot 已探测过 wm size 时直接复用，省一次往返）。

- [ ] **Step 1: 记录基线**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
```

- [ ] **Step 2: 抽取 `getSize`**

创建 `src/device/size-probe.js`：

```js
// 屏幕尺寸探测：带负缓存（失败后冷却，避免每个工具立刻重复撞墙）。
//
// 从 device/index.js 抽出——尺寸探测是独立关注点（重试/冷却策略），
// 与门面的树抓取/定位/动作分发无关。
export function createSizeProbe({ adb, bootSize = null }) {
  const SIZE_RETRY = { attempts: 3, delayMs: 500, cooldownMs: 1500 };
  // ↓↓↓ 原 getSize 逻辑逐字搬入（含全部注释）↓↓↓
  return async function getSize() { /* ... */ };
}
```

`sizeCache` / `sizeFailedAt` 两个状态变量随函数一并搬入（它们**只**服务于尺寸探测，搬走不破坏其它逻辑）。

- [ ] **Step 3: 改 `index.js`**

删除 `const SIZE_RETRY = ...`、`let sizeCache = bootSize;`、`let sizeFailedAt = 0;` 与 `async function getSize() {...}`，改为：

```js
  // 屏幕尺寸探测（见 size-probe.js）
  const getSize = createSizeProbe({ adb, bootSize });
```

并加 import：

```js
import { createSizeProbe } from './size-probe.js';
```

- [ ] **Step 4: 验证**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail|skipped)"
```

Expected：0 fail，与基线一致。

- [ ] **Step 5: 提交**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git add src/device/size-probe.js src/device/index.js
git commit -m "refactor(device): 抽取屏幕尺寸探测为独立模块

getSize 带负缓存（失败后冷却，避免每个工具立刻重复撞墙），是独立关注点。
状态变量 sizeCache / sizeFailedAt 只服务于尺寸探测，随之一并搬出。

纯结构重构：测试用例数/通过数/跳过数不变。"
```

---

## Task 4: 清理 device 层的零消费者导出

**Files:**
- Modify: `src/device/index.js`
- Test: 无新增（删除死代码，测试应无改动通过）

**Interfaces:**
- Consumes: Task 1–3 的产物
- Produces: 无新接口

- [ ] **Step 1: 核实零消费者**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
for s in lastActionChanged pendingPreHash; do
  echo "--- $s ---"
  grep -rn "\b$s\b" --include="*.js" --exclude-dir=node_modules src/ bin/ test/ report/
done
```

Expected：仅在 `src/device/index.js` 内部出现（`lastActionChanged` / `pendingPreHash` 已在上一轮删除，此步仅作复核——**若已不存在则跳过本 Task**）。

- [ ] **Step 2: 复核 `index.js` 行数下降**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
wc -l src/device/index.js
```

Expected：从 ~1000 行降到 **700 行以下**。

- [ ] **Step 3: 验证**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail|skipped)"
```

- [ ] **Step 4: 提交（仅在有改动时）**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git add src/device/index.js
git commit -m "refactor(device): 清理 device 层残留死代码"
```

---

## Task 5: 抽取用例参数表与取值转换

**Files:**
- Create: `src/session/case-params.js`
- Modify: `src/session/case.js`（删除参数表与 `coerce`，改为 import + 重新导出）
- Test: `test/session-layer.test.js`（现有用例应无改动通过）

**Interfaces:**
- Consumes: 无（独立任务）
- Produces:
  ```js
  // src/session/case-params.js
  export const PARAM_KEYS_BY_TYPE = { ... };
  export const PARAM_KEYS = new Set(...);
  export const NUMBER_KEYS = new Set([...]);
  export const BOOLEAN_KEYS = new Set([...]);
  export function coerce(key, val) { ... }
  export function unquote(v) { ... }
  ```

**背景（必读）**：`PARAM_KEYS` 由 `PARAM_KEYS_BY_TYPE` 的并集派生（单一事实源，2026-11-24 的修复引入）。两张表**必须同处一个模块**——历史上它们分处两处导致 `maxScrolls` 掉落、lint 放行但运行静默失效。拆分的目的是让"参数表"成为显式的独立单元，而 `parseCaseText` 专注解析。

- [ ] **Step 1: 记录基线**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
```

- [ ] **Step 2: 抽取参数表**

创建 `src/session/case-params.js`，把 `case.js` 58–148 行（`PARAM_KEYS_BY_TYPE` / `PARAM_KEYS` / `NUMBER_KEYS` / `BOOLEAN_KEYS` / `coerce` / `unquote`）逐字搬入，**保留全部注释**。

`unquote` 与 `coerce` 也搬入——它们是参数取值的配套逻辑（`coerce` 依赖 `NUMBER_KEYS` / `BOOLEAN_KEYS`）。

- [ ] **Step 3: 改 `case.js`**

删除搬走的定义，改为：

```js
import { PARAM_KEYS_BY_TYPE, PARAM_KEYS, NUMBER_KEYS, BOOLEAN_KEYS, coerce, unquote } from './case-params.js';
```

`case.js` 若需对外暴露 `PARAM_KEYS`（当前无外部消费者），用 `export { PARAM_KEYS } from './case-params.js';` 保持 API 面。

- [ ] **Step 4: 验证**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail|skipped)"
node --test test/session-layer.test.js 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"
```

- [ ] **Step 5: 提交**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git add src/session/case-params.js src/session/case.js
git commit -m "refactor(session): 抽取用例参数表与取值转换为独立模块

参数表（PARAM_KEYS_BY_TYPE 及其派生的 PARAM_KEYS）与取值转换（coerce /
unquote）此前与用例解析混在同一文件。两张表必须同处一模块——历史上它们
分处两处导致 maxScrolls 掉落，出现 lint 放行但运行静默失效。

纯结构重构：测试用例数/通过数/跳过数不变。"
```

---

## Task 6: 抽取步骤类型集合与工具调用映射

**Files:**
- Create: `src/session/case-steps.js`
- Modify: `src/session/case.js`
- Test: `test/session-layer.test.js`

**Interfaces:**
- Consumes: Task 5 的 `case-params.js`（`buildToolCall` 用到 `num` 转换，不需要 params 模块；若无依赖则本 Task 可并行）
- Produces:
  ```js
  // src/session/case-steps.js
  export const AGENT_TYPES = new Set([...]);
  export const ASSERT_TYPES = new Set([...]);
  export const QUERY_TYPES = new Set([...]);
  export const WAIT_TYPES = new Set([...]);
  export const ENGINE_TYPES = new Set([...]);
  export const COORD_TYPES = new Set([...]);
  export const SPECIAL_TYPES = new Set([...]);
  export const ALL_TYPES = new Set([...]);
  export function normalizeType(raw) { ... }
  export function buildToolCall(step) { ... }
  ```

- [ ] **Step 1: 记录基线**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
```

- [ ] **Step 2: 抽取类型集合与 `buildToolCall`**

创建 `src/session/case-steps.js`，把 `case.js` 的 22–44 行（类型集合）与 319–351 行（`buildToolCall`）逐字搬入，保留注释。

`buildToolCall` 若引用 `COORD_TYPES` 等常量，改为同模块内引用。

- [ ] **Step 3: 改 `case.js`**

```js
import {
  AGENT_TYPES, ASSERT_TYPES, QUERY_TYPES, WAIT_TYPES,
  ENGINE_TYPES, COORD_TYPES, SPECIAL_TYPES, ALL_TYPES,
  normalizeType, buildToolCall,
} from './case-steps.js';
```

并**重新导出**保持外部 API 不变（`bin/ask.js` 与 `src/tools/` 引用了 `buildToolCall` / `normalizeType` / `ENGINE_TYPES` / `COORD_TYPES` / `QUERY_TYPES`）：

```js
export {
  AGENT_TYPES, ASSERT_TYPES, QUERY_TYPES, WAIT_TYPES,
  ENGINE_TYPES, COORD_TYPES, SPECIAL_TYPES,
  normalizeType, buildToolCall,
};
```

- [ ] **Step 4: 验证外部调用方未受影响**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail|skipped)"
node bin/ask.js lint cases/*.yaml 2>&1 | tail -2
```

Expected：测试 0 fail；lint 0 error。

- [ ] **Step 5: 提交**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git add src/session/case-steps.js src/session/case.js
git commit -m "refactor(session): 抽取步骤类型集合与工具调用映射为独立模块

buildToolCall 是步骤语义到工具调用的唯一映射点，类型集合（ENGINE_TYPES /
COORD_TYPES 等）与之同属一个单元。case.js 通过重新导出保持外部 API 不变，
bin/ask.js 与 src/tools/ 无需改动。

纯结构重构：测试用例数/通过数/跳过数不变。"
```

---

## Task 7: 抽取循环计划与 selector 文本提取

**Files:**
- Create: `src/session/case-loop.js`
- Modify: `src/session/case.js`
- Test: `test/session-layer.test.js`

**Interfaces:**
- Consumes: 无（独立任务）
- Produces:
  ```js
  // src/session/case-loop.js
  export function waitSelectorFromText(text) { ... }
  export function resolveLoopPlan(step, stepText) { ... }
  ```

**背景（必读）**：`resolveLoopPlan` 处理显式 loop 声明（`until` / `maxRounds` / `batch`）与 legacy 关键词路径；`waitSelectorFromText` 从散文里提取 selector（`'等「加载完毕」出现'` → `text=加载完毕`）。两者是"步骤语义"的一部分，与"文本解析"分离。

- [ ] **Step 1: 记录基线**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
```

- [ ] **Step 2: 抽取两个函数**

创建 `src/session/case-loop.js`，把 `case.js` 375–430 行逐字搬入，保留注释。

若 `resolveLoopPlan` 用到 `PARAM_KEYS` 或其它常量，从 `./case-params.js` import。

- [ ] **Step 3: 改 `case.js` 并重新导出**

```js
import { waitSelectorFromText, resolveLoopPlan } from './case-loop.js';
export { waitSelectorFromText, resolveLoopPlan };
```

- [ ] **Step 4: 验证**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail|skipped)"
```

- [ ] **Step 5: 提交**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git add src/session/case-loop.js src/session/case.js
git commit -m "refactor(session): 抽取循环计划与 selector 提取为独立模块

resolveLoopPlan（显式 loop 声明 + legacy 关键词路径）与 waitSelectorFromText
（散文提取 selector）属步骤语义单元，与用例文本解析分离。

纯结构重构：测试用例数/通过数/跳过数不变。"
```

---

## Task 8: 删除 case.js 的零消费者导出

**Files:**
- Modify: `src/session/case.js`（及 `case-steps.js`）
- Test: 无新增

**Interfaces:**
- Consumes: Task 5–7
- Produces: 无新接口

- [ ] **Step 1: 再次核实零消费者（防止期间有新增使用）**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
for s in loadCase AGENT_TYPES ASSERT_TYPES WAIT_TYPES SPECIAL_TYPES; do
  n=$(grep -rn "\b$s\b" --include="*.js" --exclude-dir=node_modules src/ bin/ test/ report/ | grep -v "case-steps.js" | grep -v "src/session/case.js" | wc -l | tr -d ' ')
  echo "$s: $n 处外部引用"
done
```

Expected：全部为 `0`。**若任一不为 0，跳过该项并保留该导出**（不得破坏调用方）。

- [ ] **Step 2: 删除**

从 `case-steps.js` 去掉 `AGENT_TYPES` / `ASSERT_TYPES` / `WAIT_TYPES` / `SPECIAL_TYPES` / `ALL_TYPES` 的 `export` 关键字（定义保留为模块私有——`ALL_TYPES` 展开引用了它们，见上方注意）。同时从 `case.js` 的重新导出列表中移除这五个名字。

从 `case.js` 删除 `loadCase` 函数（约 313–317 行）。

**注意（已核实）**：`ALL_TYPES` **展开引用了全部 7 个集合**（`...AGENT_TYPES, ...ASSERT_TYPES, ...`，case.js:37-41）。因此这些集合**不能删除定义**——只能去掉 `export` 关键字，让它们成为 `case-steps.js` 的模块私有常量。`ALL_TYPES` 本身无外部消费者，同样只保留模块私有。

- [ ] **Step 3: 验证**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail|skipped)"
```

- [ ] **Step 4: 提交**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git add src/session/case.js src/session/case-steps.js
git commit -m "refactor(session): 删除零消费者的导出

loadCase / AGENT_TYPES / ASSERT_TYPES / WAIT_TYPES / SPECIAL_TYPES 全仓
0 处外部引用。删除前逐个复核（含模块内部依赖），确保不破坏调用方。"
```

---

## Task 9: 全量复核与文档同步

**Files:**
- Modify: `docs/DESIGN.md`（若提及了两个大文件的结构）
- Modify: `README.md`（目录结构段若列出这两个文件）

**Interfaces:**
- Consumes: Task 1–8
- Produces: 无新接口

- [ ] **Step 1: 最终验证**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail|skipped)"
npm --prefix report/viewer test 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"
node bin/ask.js lint cases/*.yaml 2>&1 | tail -2
```

Expected：全部 0 fail；lint 0 error。

- [ ] **Step 2: 确认行数下降**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
wc -l src/device/index.js src/session/case.js
```

Expected：`index.js` < 700 行；`case.js` < 300 行。

- [ ] **Step 3: 同步文档**

检查 `README.md` 的"目录结构"段与 `docs/DESIGN.md` 是否描述了这两个文件的内部结构。若有，补充新模块：

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
grep -n "device/index.js\|session/case.js" README.md docs/DESIGN.md
```

- [ ] **Step 4: 全新 clone 验证**

```bash
rm -rf /tmp/verify-split && mkdir -p /tmp/verify-split && cd /tmp/verify-split
git clone https://github.com/lycodeing/omnipilot.git 2>&1 | tail -1
cd omnipilot && npm ci 2>&1 | tail -1 && npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"
```

Expected：0 fail。（**注意**：本机 git 已配置全局代理 127.0.0.1:7890，clone 应能直连。）

- [ ] **Step 5: 推送**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git push origin main
```

- [ ] **Step 6: 提交（仅文档有改动时）**

```bash
cd /Users/lycodeing/ZCodeProject/自动化测试/omnipilot
git add README.md docs/DESIGN.md
git commit -m "docs: 同步大文件拆分后的模块结构"
```

---

## 背景与证据

### 为什么这两个文件值得拆

代码评审（5 位审查员并行，610+ 次工具调用）的一致结论：

- `src/device/index.js` ≈ 1000 行、31 个门面方法、3 个超大内部函数（`tapEachRow` 235 行、`dumpXmlRaw` 158 行、`scroll` 71 行）——「模块已达到下一个贡献者无法安全修改的程度」。
- `src/session/case.js` ≈ 420 行承担 4 类职责（行级 YAML-ish 解析 / 参数模式校验 / 引擎步骤→工具调用映射 / selector 文本提取与循环计划）。

评审员 B 原话：「`src/device/index.js` is a god-object」「The module is at the size where the next contributor will be unable to modify `index.js` safely.」

### 为什么必须独立 PR

两个文件的重构会**大幅改动 diff**，与 bug 修复混在一起会让评审者无法区分"行为变更"与"移动代码"——评审时被迫逐行核对，反而更慢且更易漏。本计划的每个 Task 都是**行为零变更**的纯移动，diff 可用 `git diff -M` 折叠识别。

### 已知的连带风险（执行时注意）

1. **循环依赖** —— `index.js` 要 import 新模块，新模块不能 import `index.js`。所有依赖必须**参数注入**。
2. **TDZ（暂时性死区）** —— `dumpXmlRaw` 依赖 `uia2` / `uia2DeadUntil` / `timeoutSupported` 等闭包变量，抽取后工厂调用点必须在这些变量声明**之后**。
3. **闭包状态所有权** —— `sizeCache` / `sizeFailedAt` 只服务于尺寸探测，可搬走；`uia2DeadUntil` / `lastUia2Error` / `lastUia2SlotFree` 被多处读，用 getter/setter 注入更安全。
4. **`matchNode` vs `matchNodeSelector`** —— `index.js` 内用的名字与 `locate.js` 的导出名可能不同，搬入时以实际导出名为准。
5. **`ALL_TYPES` 的构成** —— 删除零消费者集合前必须确认 `ALL_TYPES` 是否引用它们。
