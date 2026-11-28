# 等待机制改造方案：消除硬编码盲等，统一条件轮询 + 指数退避

> 日期：2026-11-28
> 状态：待审查
> 原则：**代码中不允许固定长时间等待。所有等待必须是「条件检查 + 短间隔轮询 + 指数退避 + 用例可配上限」。**

## 一、核心设计原则

### 1.1 禁止模式
```js
// ❌ 绝对禁止：固定盲等
await sleep(8000);
await sleep(90_000);
const TIMEOUT = 60_000; // 硬编码大超时
```

### 1.2 唯一允许的模式
```js
// ✅ 条件轮询 + 指数退避 + 用例可配上限
async function pollUntil(condition, { maxWaitMs = 5000, initialIntervalMs = 500 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let interval = initialIntervalMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(Math.min(interval, deadline - Date.now()));
    interval = Math.min(interval * 1.5, 3000); // 指数退避，封顶 3s
  }
  return false; // 超时返回 false，不抛错
}
```

### 1.3 关键约束
- **初始间隔 500ms**：首次检查后等 500ms 再查
- **指数退避 ×1.5**：500 → 750 → 1125 → 1687 → 2531 → 3000（封顶）
- **上限由用例配置**：YAML `timeout:` / `appInit.launchWaitMs` / 工具参数 `timeoutMs`
- **代码中的默认值 ≤ 5s**：仅作为用例未配置时的兜底，且必须可覆盖
- **每轮 dumpTree 必须带预算**：不允许无预算的 fresh dump

## 二、问题清单与改造方案

### A 级：固定长盲等（必须立即修）

| # | 位置 | 当前 | 改造 |
|---|---|---|---|
| A1 | app-init.js:67 | `sleep(8000)` 盲等首页 | 改为 `pollUntil(() => device.foreground().package === pkg && treeStable, { maxWaitMs })` |
| A2 | run-loop.js:497 | `sleep(5000)` 视觉确认轮间 | 改为 `sleep(500)` + 下轮立即重查树/截图 |
| A3 | dump-channels.js:68 | `sleep(min(remain, 10000))` 退避睡 | 改为每 1s ping uia2 status，就绪即返回 |
| A4 | uia2.js:137 | `sleep(1200)` force-stop 后 | 删除，直接 startServer + pollStatus |

### B 级：硬编码大超时（必须改可配 + 降默认值）

| # | 位置 | 当前 | 改造 |
|---|---|---|---|
| B1 | locate-policy.js | busyWaitIdleMs=15s, EscalatedMs=60s(死代码) | 删 EscalatedMs；busyWaitIdleMs 改为 3s；MISS 降级不再 waitIdle，直接 VLM |
| B2 | uia2.js:175 | ensure busyDeadline=60s | 改为接受上层传入的 remainingBudgetMs，默认 5s |
| B3 | uia2.js:161,191 | deadUntil=60s/600s | 改为指数退避半开探测：5s→10s→20s→40s→60s(cap)，每次半开试一次 status |
| B4 | uia2.js:241 | SOURCE_TIMEOUT_MS=30s | 保留但受上层 budgetMs 裁剪（已有），确保所有调用点传预算 |
| B5 | index.js/env.js/run-loop.js | DEFAULT_WAIT_TIMEOUT_MS=10s 三处重复 | 收敛为单一常量从 locate-policy.js 导出，默认 5s |
| B6 | tap-each-row.js | readyTimeoutMs=30s 不可用例直传 | 工具参数新增 timeoutMs，透传到 readyWaitMs |
| B7 | dump-channels.js | 无预算时 retryBudget=60s, file=55s | dumpTree 默认 timeoutMs=5s（不再是 null）；所有调用点显式传预算 |

### C 级：waitIdle 结构性问题

| # | 位置 | 当前 | 改造 |
|---|---|---|---|
| C1 | index.js waitIdle | quiet=2 × fresh dump（每轮 2-55s） | 改为「一次 dump + 截图签名比对」双信号；quiet 轮间用 screenSignature（~50ms）替代第二次 dump |
| C2 | index.js scrollUntil | 每步无预算 dumpTree | 加总墙钟预算（默认 10s，可配），每步 dump 带剩余预算 |

## 三、新增基础设施

### 3.1 `src/device/poll.js`（~40 行）

统一的條件轮询工具，全仓复用：

```js
/**
 * 条件轮询 + 指数退避。
 * @param {Function} condition - async () => boolean，返回 true 表示就绪
 * @param {object} options
 * @param {number} [options.maxWaitMs=5000] - 最大等待时间（用例可配）
 * @param {number} [options.initialIntervalMs=500] - 首次间隔
 * @param {number} [options.backoffFactor=1.5] - 退避因子
 * @param {number} [options.maxIntervalMs=3000] - 间隔封顶
 * @returns {Promise<boolean>} true=条件满足，false=超时
 */
export async function pollUntil(condition, options = {}) { ... }
```

### 3.2 dumpTree 默认预算

```js
// src/device/index.js
const DEFAULT_DUMP_BUDGET_MS = 5000; // 从 null 改为 5s

async function dumpTree({ fresh = false, timeoutMs = DEFAULT_DUMP_BUDGET_MS } = {}) {
  // 所有内部路径（ensure/source/legacy）都受此预算约束
}
```

### 3.3 LOCATE_MISS 降级链简化

```
旧：MISS → waitIdle(15s) → batchGround → VLM → agent
新：MISS → VLM（直接，不等） → agent（VLM 失败时）
```

理由：waitIdle 的目的是等树稳定让目标出现，但 VLM 看截图不需要树。如果目标在屏幕上可见，VLM 就能定位；如果不可见，等再久也没用。**去掉 waitIdle 这一步，预计节省 15-90s**。

## 四、实施计划

### Phase 1：基础设施 + A 级修复
1. 新增 `src/device/poll.js`
2. A1: app-init 改 pollUntil
3. A2: 视觉确认轮间 500ms
4. A3: dump-channels 退避改条件探测
5. A4: 删 uia2 restartServer 盲等

### Phase 2：B 级修复
6. B1: 删 waitIdle 降级步骤，MISS 直接 VLM
7. B2+B3: uia2 ensure/退避改预算感知 + 指数半开
8. B5: 超时常量收敛
9. B7: dumpTree 默认 5s 预算

### Phase 3：C 级 + 验证
10. C1: waitIdle 双信号优化
11. C2: scrollUntil 总预算
12. 全量测试 + 问卷用例验证耗时改善

## 五、预期效果

| 场景 | 改前 | 改后 |
|---|---|---|
| tap text=确认（弹窗场景） | 170s | **10-20s**（去掉 waitIdle + VLM 直接定位） |
| app-init 启动等待 | 固定 8s | **2-5s**（条件轮询，就绪即止） |
| aiWaitFor 视觉确认 | 5s×3=15s 额外睡眠 | **0.5s×3=1.5s** |
| uia2 退避恢复 | 10min 判死 | **5-60s 指数半开** |
| 单次 dumpTree | 4-155s 不可控 | **≤5s**（默认预算） |

## 六、不做的事

- 不改用例 YAML 的 timeout 语义（它已经是最大等待时间，合规）
- 不改 LLM 请求超时（网络超时属合理范畴）
- 不改 adb 传输层超时（spawn 兜底，合理）
- 不引入新的外部依赖
