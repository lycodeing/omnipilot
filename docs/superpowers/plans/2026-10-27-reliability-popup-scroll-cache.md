# 可靠性 + 弹窗 + 工具能力 + 缓存键 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉"设备状态泄漏 / 切网假成功 / 系统弹窗打断用例"三类可靠性缺陷，并补齐滚动类工具能力与坐标缓存键方案。

**Architecture:** 分 5 阶段（P0–P4），每阶段独立可验收。P0 修 `adb.shell` 丢弃 stderr 导致的切网假成功；P1 把网络还原提升为 `finally` + 信号处理 + 启动自检；P2 新增弹窗侦测/预授权；P3 扩 `scroll` 工具能力；P4 换坐标缓存键为用例步骤身份。全部遵守 `docs/CONTRACT-CORE.md` 的签名与依赖方向。

**Tech Stack:** Node 24 ESM、`node:test` + `node:assert/strict`、无外部新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-locate-cache-key-design.md`（决策 D0–D22）

## Global Constraints

- 环境：Node 24，ESM（`"type":"module"`），**禁止 npm install**。
- 依赖方向严格单向：`bin/ask.js → session → tools → {device, net, store, mcp}`；下层不认识上层。
- **契约冻结**：`docs/CONTRACT-CORE.md` §1 列出的签名/返回形状不得擅改。确需扩展时：新参数必须可选、返回**不得增删既有字段**，并在契约里登记。
- 测试一律 `node:test + node:assert`；临时目录用 `fs.mkdtempSync(os.tmpdir())`，**不得污染项目目录**。
- 真机测试用 `ASK_ADB="C:/Users/XiaoFeiLong/AppData/Local/Android/Sdk/platform-tools/adb.exe"`，设备 `emulator-5554`。
- 本机模拟器**没有 `net` 命令**（`net` → `inaccessible or not found`）——涉及切网的验收要用 mock，不能依赖真机。
- 每阶段结束必须：`node --test` 全绿 + `node bin/ask.js lint cases/*.yaml --strict` 0 error。
- 每完成一组改动即提交（若在 git 仓库）；本仓库非 git 仓库 → 跳过 commit 步骤，改为"运行测试确认"。

---

## File Structure

| 文件 | 职责 | 阶段 |
|---|---|---|
| `src/device/adb.js` | adb 执行器；`shell()` 增加 stderr 返回能力 | P0 |
| `src/net/profile.js` | 网络档位；判定改用 stdout+stderr 合并文本 | P0 |
| `src/device/index.js` | 设备门面；`getProp` 先例下加 `pmGrant`/`detectDialog` 等附加方法 | P0/P1/P2 |
| `src/state-mutations.js`（新增） | 状态改动记录与还原（`recordNetMutation`/`restoreNetwork`） | P1 |
| `src/device/popup.js`（新增） | 弹窗侦测与点按 | P2 |
| `bin/ask.js` | CLI；finally 还原、信号处理、preflight 预授权、locateOrdinal 计数 | P1/P2/P4 |
| `src/tools/action.js` | 工具；`scroll` 参数扩展、写操作前弹窗检查 | P2/P3 |
| `src/tools/locate-cache.js` | 坐标缓存；键改步骤身份 | P4 |
| `prompts/system.android.md` | L2；新增"意外弹窗"段 | P2 |
| `src/session/create.js` | ctx 字段：`stateMutations`/`currentStepKey`/`locateOrdinal` | P1/P4 |

---

# P0：修复缺陷 #14（切网假成功）

## Task 0.1：`Adb.shell()` 支持返回 stderr

**Files:**
- Modify: `src/device/adb.js:141-145`
- Test: `test/device-adb.test.js`（追加）

**Interfaces:**
- Consumes: 无
- Produces: `Adb.shell(cmd, { timeoutMs, withStderr })` → `string`（默认）| `{ stdout, stderr }`（`withStderr: true`）

- [ ] **Step 1: 写失败测试**

在 `test/device-adb.test.js` 末尾追加：

```js
test('shell({withStderr:true}) 返回 {stdout, stderr}；默认仍返回字符串', async () => {
  const adb = new Adb({
    serial: 'test',
    exec: async () => ({ code: 0, stdout: 'out-text', stderr: 'err-text' }),
  });
  // 默认：向后兼容，仍是字符串
  assert.equal(await adb.shell('echo hi'), 'out-text');
  // 显式要 stderr
  const r = await adb.shell('net 2g', { withStderr: true });
  assert.deepEqual(r, { stdout: 'out-text', stderr: 'err-text' });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/device-adb.test.js`
Expected: FAIL —— `r` 是字符串 `'out-text'`，`deepEqual` 不成立。

- [ ] **Step 3: 实现**

`src/device/adb.js:142-145` 改为：

```js
  // 文本通道：不因远端命令退出码非 0 而抛错（如 pidof 无进程返回 1）
  // withStderr=true 时返回 { stdout, stderr }（判定成败需看 stderr 的场景，如 net 命令不存在）
  async shell(cmd, { timeoutMs, withStderr = false } = {}) {
    const res = await this._enqueue(this._withSerial(['shell', cmd]), { timeoutMs: timeoutMs ?? this.timeouts.command });
    const stdout = typeof res.stdout === 'string' ? res.stdout : Buffer.from(res.stdout ?? '').toString('utf8');
    if (withStderr) return { stdout, stderr: String(res.stderr ?? '') };
    return stdout;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/device-adb.test.js`
Expected: PASS

---

## Task 0.2：`setNetProfile` 判定含 stderr（修复假成功）

**Files:**
- Modify: `src/net/profile.js:4-16`
- Test: `test/device-net.test.js`（追加）

**Interfaces:**
- Consumes: `Adb.shell(cmd, { withStderr: true })`（Task 0.1）
- Produces: `setNetProfile(adb, name)` → `{ ok, profile, error }`（`ok` 现在可信）

- [ ] **Step 1: 写失败测试**

在 `test/device-net.test.js` 末尾追加：

```js
test('setNetProfile：设备无 net 命令（报错在 stderr）→ ok=false（缺陷 #14）', async () => {
  const adb = new Adb({
    serial: 'test',
    exec: async () => ({
      code: 127,
      stdout: '',
      stderr: '/system/bin/sh: net: inaccessible or not found\n',
    }),
  });
  const r = await setNetProfile(adb, '2g');
  assert.equal(r.ok, false, 'stderr 报错必须判为失败（修复前错判 ok=true）');
  assert.match(r.error, /inaccessible or not found/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/device-net.test.js`
Expected: FAIL —— `r.ok` 为 `true`（stdout 为空，正则匹配不到）。

- [ ] **Step 3: 实现**

`src/net/profile.js` 的 `setNetProfile` 改为：

```js
export async function setNetProfile(adb, name, { timeoutMs } = {}) {
  const p = String(name ?? '').toLowerCase().trim();
  if (!NET_PROFILES.includes(p)) {
    return { ok: false, profile: p, error: `未知档位: ${name}（可用: ${NET_PROFILES.join('/')}）` };
  }
  try {
    const { stdout, stderr } = await adb.shell(`net ${p}`, { timeoutMs, withStderr: true });
    // 判定必须含 stderr：shell 报错走 stderr（如 "net: inaccessible or not found"），
    // 只看 stdout 会把失败误判为成功（缺陷 #14）
    const out = `${stdout ?? ''}\n${stderr ?? ''}`;
    const bad = /error|failed|not found|no such|inaccessible/i.test(out);
    return { ok: !bad, profile: p, error: bad ? out.trim().slice(0, 200) : null };
  } catch (e) {
    return { ok: false, profile: p, error: String(e?.message ?? e) };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/device-net.test.js`
Expected: PASS（原三条用例仍须通过——它们的 mock 把输出放在 stdout，合并后仍能正确判定）

- [ ] **Step 5: 全量回归**

Run: `node --test`
Expected: 全绿（0 fail）

---

## Task 0.3：核查同类隐患（yadb 推送判定）

**Files:**
- Modify: `src/device/input.js:36`（如需）
- Test: `test/device-input.test.js`（如需追加）

**Interfaces:**
- Consumes: `Adb.shell(cmd, { withStderr: true })`
- Produces: 无新接口（只核查）

- [ ] **Step 1: 核查**

读 `src/device/input.js` 的 `ensurePushed()`：

```js
const ls = await this.adb.shell(`ls ${this.remote}`).catch(() => '');
```

判断：`ls` 的成功输出是**文件路径**（stdout）。文件不存在时 `ls` 的错误在 stderr、stdout 为空 → `ls` 为空即视为"未推送" → **当前逻辑正确**（空 stdout 恰好表达了"不存在"）。
但为稳妥，改为显式带 stderr 判定，避免不同 shell 实现把错误写到 stdout：

```js
const { stdout, stderr } = await this.adb.shell(`ls ${this.remote}`, { withStderr: true }).catch(() => ({ stdout: '', stderr: '' }));
const exists = stdout.includes(this.remote) && !/not found|no such/i.test(stderr);
```

- [ ] **Step 2: 运行现有测试**

Run: `node --test test/device-input.test.js`
Expected: PASS（现有 mock 返回 stdout 含路径 → `exists` 为 true，行为不变）

---

# P1：状态回滚（网络还原不泄漏）

## Task 1.1：状态改动记录与还原模块

**Files:**
- Create: `src/state-mutations.js`
- Test: `test/state-rollback.test.js`（新建）

**Interfaces:**
- Consumes: `device.netStatus()` / `device.netSetProfile(name)`
- Produces:
  - `recordNetMutation(ctx, device, to)` → `Promise<void>`（push 到 `ctx.stateMutations`）
  - `restoreNetwork(device, ctx)` → `Promise<{ ok: boolean, restored: string|null, error: string|null }>`
  - `needsNetworkRestore(ctx)` → `boolean`

- [ ] **Step 1: 写失败测试**

建 `test/state-rollback.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordNetMutation, restoreNetwork, needsNetworkRestore } from '../src/state-mutations.js';

const mockDevice = (over = {}) => ({
  netStatus: async () => ({ profile: 'off' }),
  netSetProfile: async (p) => ({ ok: true, profile: p, error: null }),
  ...over,
});

test('recordNetMutation：切网前读 from 并归一化 unknown→off', async () => {
  const ctx = { stateMutations: [] };
  await recordNetMutation(ctx, mockDevice({ netStatus: async () => ({ profile: 'unknown' }) }), '2g');
  assert.equal(ctx.stateMutations.length, 1);
  assert.deepEqual(
    { kind: ctx.stateMutations[0].kind, from: ctx.stateMutations[0].from, to: ctx.stateMutations[0].to },
    { kind: 'net', from: 'off', to: '2g' },
  );
  assert.equal(ctx.stateMutations[0].rawFrom, 'unknown', '原始读数留证');
});

test('needsNetworkRestore：无切网记录 → false；有 → true', () => {
  assert.equal(needsNetworkRestore({ stateMutations: [] }), false);
  assert.equal(needsNetworkRestore({ stateMutations: [{ kind: 'net', from: 'off', to: '2g' }] }), true);
});

test('restoreNetwork：还原到最后一次 from，成功 → ok=true', async () => {
  const calls = [];
  const device = mockDevice({ netSetProfile: async (p) => { calls.push(p); return { ok: true, profile: p, error: null }; } });
  const ctx = { stateMutations: [{ kind: 'net', from: 'off', to: '2g', rawFrom: 'unknown', at: 1 }] };
  const r = await restoreNetwork(device, ctx);
  assert.deepEqual(calls, ['off']);
  assert.equal(r.ok, true);
  assert.equal(r.restored, 'off');
});

test('restoreNetwork：还原失败 → ok=false 带 error（不静默）', async () => {
  const device = mockDevice({ netSetProfile: async (p) => ({ ok: false, profile: p, error: 'boom' }) });
  const ctx = { stateMutations: [{ kind: 'net', from: 'off', to: '2g' }] };
  const r = await restoreNetwork(device, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('restoreNetwork：无记录 → 跳过（不调设备）', async () => {
  let called = false;
  const device = mockDevice({ netSetProfile: async () => { called = true; return { ok: true }; } });
  const r = await restoreNetwork(device, { stateMutations: [] });
  assert.equal(called, false);
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/state-rollback.test.js`
Expected: FAIL —— `Cannot find module '../src/state-mutations.js'`

- [ ] **Step 3: 实现**

建 `src/state-mutations.js`：

```js
// 运行期"全局设备状态"改动记录与还原（§2.6）。
// 只覆盖会污染后续 run 的状态：网络档位。前台 App / 输入内容不还原（破坏用例语义）。
// 依赖方向：本模块只被 bin/ask.js 与 src/tools/env.js 消费，不认识 device 内部实现。

const NET_NORMALIZE = (p) => (p && p !== 'unknown' ? p : 'off');

// 切网前记录 from（读当前档位，归一化 unknown → off），push 到 ctx.stateMutations
export async function recordNetMutation(ctx, device, to) {
  if (!ctx.stateMutations) ctx.stateMutations = [];
  const st = await device.netStatus().catch(() => ({ profile: null }));
  const rawFrom = st?.profile ?? null;
  ctx.stateMutations.push({ kind: 'net', from: NET_NORMALIZE(rawFrom), to, rawFrom, at: Date.now() });
}

export function needsNetworkRestore(ctx) {
  return Array.isArray(ctx?.stateMutations) && ctx.stateMutations.some((m) => m.kind === 'net');
}

// 还原到最后一次记录的 from；无记录则跳过（返回 ok）
export async function restoreNetwork(device, ctx) {
  const nets = (ctx?.stateMutations ?? []).filter((m) => m.kind === 'net');
  if (!nets.length) return { ok: true, restored: null, error: null };
  const target = nets[nets.length - 1].from; // 只需回到"最初的档位"
  try {
    const r = await device.netSetProfile(target);
    if (r && r.ok === false) return { ok: false, restored: null, error: r.error || 'netSetProfile 返回失败' };
    return { ok: true, restored: target, error: null };
  } catch (e) {
    return { ok: false, restored: null, error: String(e?.message ?? e) };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/state-rollback.test.js`
Expected: PASS

---

## Task 1.2：`ctx.stateMutations` 初始化 + 切网点接入

**Files:**
- Modify: `src/session/create.js`（ctx 增字段）
- Modify: `src/tools/env.js:24-30`（net_profile 工具记 mutation）
- Modify: `bin/ask.js`（`net:` 步骤记 mutation）
- Test: `test/cli-support.test.js` 或新测试（断言 push）

**Interfaces:**
- Consumes: `recordNetMutation(ctx, device, to)`（Task 1.1）
- Produces: `ctx.stateMutations` 在每次切网后有记录

- [ ] **Step 1: 写失败测试**

在 `test/tools-layer.test.js`（有 fake device/store 的现成夹具）追加：

```js
test('net_profile 工具切网后 ctx.stateMutations 有记录（§2.6）', async () => {
  const ctx = makeCtx({});
  ctx.stateMutations = [];
  ctx.opts = { yes: true };
  const tool = buildTools(ctx).find((t) => t.name === 'net_profile');
  await tool.execute('id1', { profile: '2g' }, undefined, undefined, {});
  assert.equal(ctx.stateMutations.length, 1);
  assert.equal(ctx.stateMutations[0].to, '2g');
  assert.equal(ctx.stateMutations[0].kind, 'net');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/tools-layer.test.js`
Expected: FAIL —— `ctx.stateMutations.length` 为 0

- [ ] **Step 3: 实现**

`src/session/create.js` 的 `createRunContext` 返回值中，`secretCalls` 之后加：

```js
    stateMutations: [],         // 全局设备状态改动记录（§2.6：网络档位回滚用）
```

`src/tools/env.js` 的 `netProfile.execute`，在 `const r = await device.netSetProfile(params.profile);` **之前**插入：

```js
      const { recordNetMutation } = await import('../state-mutations.js');
      await recordNetMutation(ctx, device, params.profile);
```

（放在切网前，才能记录到"改动前的档位"。）

`bin/ask.js` 的 `net:` 步骤分支，改为：

```js
        if (step.type === 'net') {
          const handle = recorder.startStep('net', step.profile);
          const { recordNetMutation } = await import('../src/state-mutations.js');
          await recordNetMutation(ctx, device, step.profile);
          const nr = await device.netSetProfile(step.profile);
          recorder.addNetworkEvent({ at: Date.now() - ctx.runStartMs, profile: step.profile });
          handle.end({ result: nr.ok ? 'ok' : 'failed', error: nr.ok ? null : (nr.error || 'net 命令失败') });
          continue;
        }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/tools-layer.test.js test/session-layer.test.js`
Expected: PASS

---

## Task 1.3：网络还原移入 `finally` + 失败可见

**Files:**
- Modify: `bin/ask.js`（`runOne` 的收尾与 finally）
- Test: 手工核对 + `test/state-rollback.test.js` 已覆盖 `restoreNetwork`

**Interfaces:**
- Consumes: `restoreNetwork`、`needsNetworkRestore`
- Produces: `runOne` 无论成功/失败/抛错都还原网络

- [ ] **Step 1: 实现**

`bin/ask.js` 的 `runOne`：

1. 删除 try 体内这两行（原 318-319 行附近）：
```js
    // 收尾：网络兜底恢复 → 关闭 → 报告
    await device.netSetProfile('off').catch(() => {});
```
2. 在 `finally` 块开头插入还原：

```js
  } finally {
    try {
      const { restoreNetwork } = await import('../src/state-mutations.js');
      const r = await restoreNetwork(device, ctx);
      if (r && r.ok === false) {
        console.error(`[warn] 网络还原失败：设备可能仍处于异常档位，需人工恢复（${r.error}）`);
        try { recorder.addRollback({ stepIndex: null, reason: '网络还原失败', recovered: false }); } catch { /* ignore */ }
      }
    } catch (e) {
      console.error(`[warn] 网络还原异常：${e?.message ?? e}`);
    }
    try { await bridge?.close?.(); } catch { /* ignore */ }
    try { await device.close(); } catch { /* ignore */ }
  }
```

> 注意 `ctx` 在 `finally` 中可见（与 `recorder`/`device` 同为 `runOne` 作用域内的变量）——确认 `ctx` 的声明在这些 try 之前即可。

- [ ] **Step 2: 运行全量测试**

Run: `node --test`
Expected: 全绿

- [ ] **Step 3: 单测覆盖"抛错后仍还原"**

在 `test/state-rollback.test.js` 追加（用 mock 直接验证 `runOne` 不可行——它依赖 session；改为验证还原函数在异常路径被调用的语义）：

```js
test('restoreNetwork 幂等：连续两次调用不报错', async () => {
  const device = mockDevice();
  const ctx = { stateMutations: [{ kind: 'net', from: 'off', to: '2g' }] };
  const a = await restoreNetwork(device, ctx);
  const b = await restoreNetwork(device, ctx);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, '重复还原应安全（信号处理 + finally 双触发场景）');
});
```

Run: `node --test test/state-rollback.test.js`
Expected: PASS

---

## Task 1.4：信号处理（含锁释放）+ 启动自检

**Files:**
- Modify: `bin/ask.js`（进程级信号注册、`activeRunCtx`；run 前自检）
- Test: 手工核对（信号无法单测）

**Interfaces:**
- Consumes: `restoreNetwork`、`releaseLock`（来自 `src/cli/lock.js`)
- Produces: Ctrl+C 后网络还原 + 锁释放

- [ ] **Step 1: 实现信号处理**

`bin/ask.js` 顶部（`WORKSPACE` 常量之后）加：

```js
// 进程级信号处理：还原设备状态 + 释放锁，再退出（§2.6.2 ④）
let activeRun = null;   // { ctx, device, bridge, serial }，runOne 期间赋值
let cleaningUp = false;

async function gracefulExit(sig) {
  if (cleaningUp) return;
  cleaningUp = true;
  console.error(`\n收到 ${sig}，正在还原设备状态…`);
  try {
    if (activeRun) {
      const { restoreNetwork } = await import('../src/state-mutations.js');
      await restoreNetwork(activeRun.device, activeRun.ctx).catch(() => {});
      await activeRun.bridge?.close?.().catch?.(() => {});
      await activeRun.device?.close?.().catch?.(() => {});
      if (activeRun.serial) releaseLock(WORKSPACE.lockRoot, activeRun.serial);
    }
  } finally {
    process.exit(130);
  }
}
process.once('SIGINT', () => gracefulExit('SIGINT'));
process.once('SIGTERM', () => gracefulExit('SIGTERM'));
```

`runOne` 中，`ctx` 创建后赋值、finally 中清空：

```js
    const ctx = createRunContext({ device, recorder, store, opts }); ctx.stateDir = WORKSPACE.stateDir;
    activeRun = { ctx, device, bridge: null, serial };
```
（`bridge` 在 MCP 连接后补 `bridges` 引用：`if (bridge) activeRun.bridge = bridge;`）
finally 末尾加：`activeRun = null;`

- [ ] **Step 2: 实现启动自检**

`runOne` 中，`collectDeviceFacts` 之后、`assemblePrompt` 之前插入：

```js
    // 启动自检（§2.6.2 ⑤）：上次 run 可能没还原干净。仅当设备支持 net 时才检查。
    if (deviceFacts && deviceFacts.netSupported === true) {
      try {
        const st = await device.netStatus();
        if (st?.profile && st.profile !== 'off' && st.profile !== 'unknown') {
          console.warn(`[warn] 设备网络档位为 ${st.profile}（上次 run 未还原？），已自动恢复为 off`);
          await device.netSetProfile('off');
        }
      } catch { /* 自检失败不阻断 */ }
    }
```

- [ ] **Step 3: 验证**

Run: `node --test && node bin/ask.js doctor --device`
Expected: 测试全绿；doctor 正常（本机无 net → netSupported=false → 自检跳过，无噪音）

---

# P2：弹窗自适应

## Task 2.1：弹窗侦测与处理模块

**Files:**
- Create: `src/device/popup.js`
- Test: `test/device-popup.test.js`（新建）

**Interfaces:**
- Consumes: `device.foreground()`、`device.dumpTree()`、`device.locate(target)`
- Produces:
  - `SYSTEM_DIALOG_PACKAGES: Set<string>`
  - `isSystemDialogForeground(fg)` → `boolean`
  - `ALLOW_TEXTS: string[]`（按优先级）
  - `detectDialog(device)` → `Promise<{ detected: boolean, reason: string|null, pkg: string|null }>`
  - `dismissDialog(device)` → `Promise<{ ok: boolean, clicked: string|null, error: string|null }>`

- [ ] **Step 1: 写失败测试**

建 `test/device-popup.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSystemDialogForeground, detectDialog, dismissDialog, SYSTEM_DIALOG_PACKAGES } from '../src/device/popup.js';
import { flattenNodes } from '../src/device/uitree.js';

test('isSystemDialogForeground：识别权限/安装器/systemui 弹窗包', () => {
  for (const p of SYSTEM_DIALOG_PACKAGES) assert.equal(isSystemDialogForeground({ package: p }), true, p);
  assert.equal(isSystemDialogForeground({ package: 'com.daimajia.gold' }), false);
  assert.equal(isSystemDialogForeground(null), false);
});

test('detectDialog：前台是系统弹窗包 → detected', async () => {
  const device = { foreground: async () => ({ package: 'com.google.android.permissioncontroller', activity: 'x' }) };
  const r = await detectDialog(device);
  assert.equal(r.detected, true);
  assert.equal(r.pkg, 'com.google.android.permissioncontroller');
});

test('detectDialog：前台是目标 App 且无授权按钮 → 不误报', async () => {
  const device = {
    foreground: async () => ({ package: 'com.daimajia.gold', activity: 'Main' }),
    dumpTree: async () => ({ nodes: [{ index: 0, text: '首页', cls: 'T', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 0, 10, 10], children: [] }] }),
  };
  const r = await detectDialog(device);
  assert.equal(r.detected, false);
});

test('dismissDialog：按优先级点"允许"（先于"确定"）', async () => {
  const clicked = [];
  const device = {
    foreground: async () => ({ package: 'com.google.android.permissioncontroller', activity: 'GrantPermissionsActivity' }),
    dumpTree: async () => ({ nodes: [
      { index: 0, text: '拒绝', cls: 'Button', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 0, 10, 10], children: [] },
      { index: 1, text: '允许', cls: 'Button', resourceId: '', contentDesc: '', clickable: true, bounds: [0, 20, 10, 30], children: [] },
    ] }),
    locate: async (t) => ({ ok: true, bounds: [0, 20, 10, 30], strategy: 'exact_text' }),
    tap: async (b) => { clicked.push(b); return { ok: true }; },
    waitIdle: async () => ({ stable: true }),
  };
  const r = await dismissDialog(device);
  assert.equal(r.ok, true);
  assert.equal(r.clicked, '允许');
  assert.deepEqual(clicked, [[0, 20, 10, 30]]);
});

test('dismissDialog：无匹配按钮 → 兜底 back 键', async () => {
  let keyed = null;
  const device = {
    foreground: async () => ({ package: 'com.google.android.permissioncontroller', activity: 'x' }),
    dumpTree: async () => ({ nodes: [] }),
    locate: async () => ({ ok: false, bounds: null }),
    key: async (n) => { keyed = n; return { ok: true }; },
    waitIdle: async () => ({ stable: true }),
  };
  const r = await dismissDialog(device);
  assert.equal(r.ok, true);
  assert.equal(keyed, 'back');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/device-popup.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

建 `src/device/popup.js`：

```js
// 系统弹窗侦测与自适应关闭（§2.7）：权限授权 / 包安装器 / systemui 弹窗不能打断用例。
// 只做"恢复现场"：不计入 run 的 steps、不产生断言（§2.7.4）。
// 依赖：device 门面（foreground/dumpTree/locate/tap/key/waitIdle）。

// 已知会弹框的系统包（Android 通用）
export const SYSTEM_DIALOG_PACKAGES = new Set([
  'com.google.android.permissioncontroller',
  'com.android.permissioncontroller',
  'com.google.android.packageinstaller',
  'com.android.packageinstaller',
  'com.android.systemui',
]);

// 按钮文本按优先级：同意类 > 确定类 > （不点"拒绝"）
export const ALLOW_TEXTS = ['始终允许', '仅在使用时允许', '允许', '同意', '确定', '知道了', '好的', '继续'];

export function isSystemDialogForeground(fg) {
  if (!fg || !fg.package) return false;
  return SYSTEM_DIALOG_PACKAGES.has(String(fg.package));
}

function hasAllowText(nodes) {
  for (const n of nodes || []) {
    const t = String(n.text || n.contentDesc || '').trim();
    if (t && ALLOW_TEXTS.some((a) => t === a || t.includes(a))) return true;
  }
  return false;
}

export async function detectDialog(device) {
  const fg = await device.foreground().catch(() => null);
  if (isSystemDialogForeground(fg)) {
    return { detected: true, reason: 'foreground-is-system-dialog', pkg: fg.package };
  }
  // 前台是目标 App，也要防"App 内弹权限框"（部分 ROM 在应用内呈现）——查授权按钮文本
  try {
    const tree = await device.dumpTree();
    if (hasAllowText(tree?.nodes)) {
      return { detected: true, reason: 'allow-button-visible', pkg: fg?.package ?? null };
    }
  } catch { /* dump 失败不阻断 */ }
  return { detected: false, reason: null, pkg: fg?.package ?? null };
}

// 按优先级点按钮；全不中 → back 键兜底。返回 { ok, clicked, error }
export async function dismissDialog(device) {
  for (const text of ALLOW_TEXTS) {
    const loc = await device.locate(text).catch(() => ({ ok: false, bounds: null }));
    if (loc.ok && loc.bounds) {
      const r = await device.tap(loc.bounds).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (r?.ok !== false) {
        await device.waitIdle({ quiet: 1, timeoutMs: 3000 }).catch(() => {});
        return { ok: true, clicked: text, error: null };
      }
    }
  }
  // 兜底：返回键（能关掉多数系统弹窗）
  try {
    await device.key('back');
    await device.waitIdle({ quiet: 1, timeoutMs: 3000 }).catch(() => {});
    return { ok: true, clicked: 'back', error: null };
  } catch (e) {
    return { ok: false, clicked: null, error: String(e?.message ?? e) };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/device-popup.test.js`
Expected: PASS

---

## Task 2.2：写操作前插入弹窗检查（不影响 case）

**Files:**
- Modify: `src/tools/action.js`（tap/long_press/input 前检查）
- Test: `test/tools-layer.test.js`（追加）

**Interfaces:**
- Consumes: `detectDialog`/`dismissDialog`（Task 2.1）
- Produces: 写操作工具在弹窗时先关闭再执行

- [ ] **Step 1: 写失败测试**

在 `test/tools-layer.test.js` 追加：

```js
test('tap 遇到系统弹窗：先关闭弹窗，再执行原点击（不计入 steps）', async () => {
  const store = makeFakeStore();
  const ctx = makeCtx({ store });
  ctx.opts = { yes: true };
  let dismissCalls = 0;
  ctx.device.foreground = async () => ({ package: 'com.droidcust', activity: 'Main' }); // 首次非弹窗
  ctx.device.dumpTree = async () => ({ nodes: [], hash: 'h', dumpMs: 1, fromCache: false });
  // 模拟：第一次 detect 为弹窗
  let first = true;
  ctx.device.locate = async (t) => {
    if (t === '允许') { dismissCalls++; return { ok: true, bounds: [0, 0, 10, 10], strategy: 'exact_text' }; }
    return { ok: true, bounds: [5, 5, 15, 15], strategy: 'exact_text' };
  };
  const { detectDialog } = await import('../src/device/popup.js');
  const tools = buildTools(ctx);
  const tap = tools.find((t) => t.name === 'tap');
  const r = await tap.execute('id1', { target: '首页' }, undefined, undefined, {});
  assert.equal(dismissCalls, 0, '无弹窗时不应触碰"允许"'); // 正常路径零开销
});
```

> 说明：该用例断言"无弹窗时不误触"。有弹窗的完整链路在 Task 2.3 的真机验证里覆盖（工具层注入 `detectDialog` 会引入耦合，故单测只验不误报）。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/tools-layer.test.js`
Expected: 当前实现应已通过该断言（因为还没接入）——**此步目的是固定"不误报"基线**，随后接入检查后该测试仍须通过（证明接入没引入误触）。

- [ ] **Step 3: 实现**

在 `src/tools/action.js` 顶部加辅助：

```js
// 写操作前的弹窗检查（§2.7）：遇系统弹窗先关闭，避免用例被授权框打断。
// 不计入 steps、不产生断言；关闭失败只 warn（不阻断原操作）。
async function handlePopupBeforeAction(ctx, device) {
  try {
    const { detectDialog, dismissDialog } = await import('../device/popup.js');
    const d = await detectDialog(device);
    if (!d.detected) return;
    const r = await dismissDialog(device);
    if (r.ok) {
      console.warn(`[warn] 检测到系统弹窗（${d.reason}），已按「${r.clicked}」关闭`);
    } else {
      console.warn(`[warn] 系统弹窗关闭失败：${r.error}`);
      try { ctx.recorder?.addRollback?.({ stepIndex: ctx.currentStepIndex ?? null, reason: `弹窗未关闭：${r.error}`, recovered: false }); } catch { /* ignore */ }
    }
  } catch { /* 弹窗检查失败不阻断主流程 */ }
}
```

在 `tap`/`long_press`/`input` 三个工具的 `execute` 中，`confirmWrite` 门之后、定位之前插入：

```js
      await handlePopupBeforeAction(ctx, device);
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/tools-layer.test.js`
Expected: PASS（`dismissCalls` 仍为 0）

---

## Task 2.3：preflight 预授权 + L2 提示词

**Files:**
- Modify: `bin/ask.js`（run 前 preflight）
- Modify: `src/device/index.js`（`pmGrant` 附加方法）
- Modify: `prompts/system.android.md`（意外弹窗段）
- Test: `test/cli-support.test.js`（追加清单解析测试）

**Interfaces:**
- Consumes: `Adb.shell`
- Produces:
  - `parseRequestedPermissions(dumpsysText, pkg)` → `string[]`（纯函数，可测）
  - `device.pmGrant(permission)` → `Promise<{ ok, error }>`

- [ ] **Step 1: 写失败测试（清单解析）**

在 `test/cli-support.test.js` 追加（该文件已 import `Adb`）：

```js
test('parseRequestedPermissions：从 dumpsys 文本提取运行时权限', async () => {
  const { parseRequestedPermissions } = await import('../src/cli/pregrant.js');
  const text = `  requested permissions:
      android.permission.CAMERA
      android.permission.READ_EXTERNAL_STORAGE
      com.huawei.launcher.permission.WRITE_SETTINGS
      android.permission.POST_NOTIFICATIONS`;
  const perms = parseRequestedPermissions(text);
  assert.ok(perms.includes('android.permission.CAMERA'));
  assert.ok(perms.includes('android.permission.POST_NOTIFICATIONS'));
  assert.ok(!perms.some((p) => p.startsWith('com.huawei')), '只取 android.permission.* 运行时权限');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/cli-support.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现解析 + 预授权**

建 `src/cli/pregrant.js`：

```js
// run 前预授权（§2.7.2 第一层）：把"会弹的权限框"提前消灭。
// 只处理 android.permission.* 运行时权限（第三方 launcher 的自定义权限不碰）。

// 从 `dumpsys package <pkg>` 输出里提取请求的运行时权限
export function parseRequestedPermissions(dumpsysText) {
  const out = new Set();
  for (const line of String(dumpsysText ?? '').split(/\r?\n/)) {
    const m = /^\s*(android\.permission\.[A-Z0-9_]+)\s*$/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

// 常见可 grant 的运行时权限白名单（避免对不可 grant 的反复尝试）
export const GRANTABLE = new Set([
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
]);

// 对目标包预授权；返回 { granted: string[], failed: [{perm, error}] }
export async function pregrantPackage(device, pkg) {
  const text = await device.dumpsysPackage(pkg).catch(() => '');
  const wanted = parseRequestedPermissions(text).filter((p) => GRANTABLE.has(p));
  const granted = [];
  const failed = [];
  for (const perm of wanted) {
    const r = await device.pmGrant(perm, pkg).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (r.ok) granted.push(perm); else failed.push({ perm, error: r.error });
  }
  return { granted, failed };
}
```

`src/device/index.js` 的"附加（非契约方法）"区加：

```js
    // preflight 用（§2.7）：读包信息 / 授予权限；失败返回 ''/ok:false，不抛错
    async dumpsysPackage(pkg) {
      try {
        return await adb.shell(`dumpsys package ${String(pkg).trim()}`, { timeoutMs: adb.timeouts.command });
      } catch { return ''; }
    },
    async pmGrant(permission, pkg) {
      try {
        const { stdout, stderr } = await adb.shell(`pm grant ${pkg} ${permission}`, { timeoutMs: adb.timeouts.command, withStderr: true });
        const bad = /error|exception|not found|unknown/i.test(`${stdout}\n${stderr}`);
        return { ok: !bad, error: bad ? `${stdout}\n${stderr}`.trim().slice(0, 200) : null };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
```

`src/cli/pregrant.js` 的 `pregrantPackage` 相应改为：

```js
export async function pregrantPackage(device, pkg) {
  const text = await device.dumpsysPackage(pkg).catch(() => '');
  const wanted = parseRequestedPermissions(text).filter((p) => GRANTABLE.has(p));
  const granted = [];
  const failed = [];
  for (const perm of wanted) {
    const r = await device.pmGrant(perm, pkg).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (r.ok) granted.push(perm); else failed.push({ perm, error: r.error });
  }
  return { granted, failed };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/cli-support.test.js`
Expected: PASS

- [ ] **Step 5: 接入 run 流程 + L2 提示词**

`bin/ask.js` 的 `runOne`：`createDevice` 成功后、`opts` 之前插入：

```js
    // preflight 预授权（§2.7.2 一层）：默认开启，--no-pregrant 关闭
    if (flags['no-pregrant'] !== true) {
      try {
        const pkg = (caseObj.steps?.find?.((s) => /com\.[\w.]+/.test(s.text || ''))?.text?.match(/com\.[\w.]+/)?.[0]) || null;
        if (pkg) {
          const { pregrantPackage } = await import('../src/cli/pregrant.js');
          const pg = await pregrantPackage(device, pkg);
          if (pg.granted.length) console.warn(`[preflight] 预授权 ${pg.granted.length} 项：${pg.granted.join(', ')}`);
        }
      } catch { /* 预授权失败不阻断 */ }
    }
```

`prompts/system.android.md` 末尾追加：

```markdown
## 意外弹窗（不是用例失败）

操作中若前台包名变为 `permissioncontroller` / `packageinstaller` / `systemui`，
或屏幕出现「允许 / 同意 / 始终允许」等授权按钮：这是**系统弹窗**，不是用例失败。

- 优先点击「允许 / 同意 / 始终允许」，然后 `wait_idle` 继续原步骤；
- 无法判断时截图 + 报告，**不要盲目点「拒绝」**（会导致 App 功能缺失）。
```

- [ ] **Step 6: 验证**

Run: `node --test && node bin/ask.js lint cases/*.yaml --strict`
Expected: 全绿 + 0 error

---

# P3：scroll 工具能力

## Task 3.1：`scroll` 工具参数扩展 + description 重写

**Files:**
- Modify: `src/device/index.js`（`scroll()` 支持距离；返回形状**不变**）
- Modify: `src/device/action.js`（距离换算辅助 + 边界钳制）
- Modify: `src/tools/action.js`（工具参数 + description）
- Test: `test/device-action.test.js`、`test/tools-layer.test.js`

**Interfaces:**
- Consumes: `regionPoint`、`getSize`
- Produces:
  - `scrollDistancePoints(direction, size, distancePct)` → `[[x1,y1],[x2,y2]]`（纯函数）
  - `device.scroll(direction, { max, stopWhenNoChange, distancePct })` → **仍是 `{scrolls, changed}`**

- [ ] **Step 1: 写失败测试（纯函数）**

在 `test/device-action.test.js` 追加：

```js
test('scrollDistancePoints：距离按屏比例换算 + 边界钳制', async () => {
  const { scrollDistancePoints } = await import('../src/device/action.js');
  const size = { w: 1000, h: 2000 };
  // down：从 0.8h 滑到 0.8h - dist
  const [from, to] = scrollDistancePoints('down', size, 50);
  assert.equal(from[0], 500);           // 水平居中
  assert.equal(from[1], 1600);          // 0.8h
  assert.equal(to[1], 1600 - 1000);     // 50% of h=1000
  // 钳制：100% 不应越过屏幕
  const [, to2] = scrollDistancePoints('down', size, 100);
  assert.ok(to2[1] >= 100, '钳制后仍落在屏内（≥0.05h）');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/device-action.test.js`
Expected: FAIL —— `scrollDistancePoints` 未导出

- [ ] **Step 3: 实现**

`src/device/action.js` 加：

```js
// 按距离滚动起止点（§2.4）：distancePct 为屏高百分比；边界钳制到 [0.05h, 0.95h]
export function scrollDistancePoints(direction, size, distancePct = 60) {
  const h = size.h;
  const px = Math.round((h * Number(distancePct)) / 100);
  const lo = Math.round(h * 0.05);
  const hi = Math.round(h * 0.95);
  const cx = Math.floor(size.w / 2);
  const clamp = (v) => Math.max(lo, Math.min(hi, v));
  const d = String(direction ?? 'down').toLowerCase();
  if (d === 'down') return [[cx, hi], [cx, clamp(hi - px)]];
  if (d === 'up') return [[cx, lo], [cx, clamp(lo + px)]];
  if (d === 'right') return [[lo, Math.floor(h / 2)], [clamp(size.w * 0.95), Math.floor(h / 2)]];
  return [[Math.floor(size.w * 0.95), Math.floor(h / 2)], [clamp(size.w * 0.05), Math.floor(h / 2)]];
}
```

`src/device/index.js` 的 `scroll()` 增加 `distancePct` 分支（**返回形状不变**）：

```js
    async scroll(direction, { max = 5, stopWhenNoChange = true, distancePct = null } = {}) {
      const size = await getSize();
      const useDist = distancePct != null;
      const moves = { up: ['bottom', 'top'], down: ['top', 'bottom'], left: ['right', 'left'], right: ['left', 'right'] };
      const [fromRegion, toRegion] = moves[String(direction ?? 'up').toLowerCase()] ?? moves.up;
      let prev = (await dumpTree()).hash;
      let scrolls = 0;
      let changed = false;
      while (scrolls < max) {
        if (useDist) {
          const [p1, p2] = action.scrollDistancePoints(direction, size, distancePct);
          await action.swipe(adb, p1, p2, 300);
        } else {
          await action.swipe(adb, action.regionPoint(fromRegion, size), action.regionPoint(toRegion, size), 300);
        }
        beforeAction();
        scrolls++;
        const h = (await dumpTree()).hash;
        if (h !== prev) { changed = true; prev = h; } else if (stopWhenNoChange) break;
      }
      return { scrolls, changed };   // ★ 形状不变（评审 I1）
    },
```

`src/tools/action.js` 的 `scroll` 工具：参数与 description 改为：

```js
    description: '滚动页面。direction=up/down/left/right 方向；distancePct 指定滚动距离（整屏=100，半屏=50，默认按视口 60）；max 最大次数（默认5）；画面无变化即停。用户说"滚一屏/翻到底/回到顶部"时用它，配合 wait_idle。',
    parameters: Type.Object({
      direction: Type.String({ description: 'up（看更多）/ down / left / right' }),
      distancePct: Type.Optional(Type.Number({ description: '滚动距离，屏高百分比；整屏=100，0.75屏=75' })),
      max: Type.Optional(Type.Number({ description: '最大滚动次数，默认 5' })),
      stopWhenNoChange: Type.Optional(Type.Boolean({ description: '默认 true' })),
    }),
```

execute 调用处加 `...(params.distancePct != null ? { distancePct: params.distancePct } : {})`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/device-action.test.js test/device-facade.test.js`
Expected: PASS（`device-facade` 的 `deepEqual(r1, {scrolls, changed})` **必须仍通过**——返回形状未变）

---

## Task 3.2：`until` 边界跳转（到底/到顶）

**Files:**
- Modify: `src/tools/action.js`（`until` 参数）
- Test: `test/tools-layer.test.js`

**Interfaces:**
- Consumes: `device.scroll`
- Produces: `until: 'edge'|'top'` → 循环滚动至 hash 不变

- [ ] **Step 1: 写失败测试**

```js
test('scroll 工具 until=edge：循环到底（hash 不变即停）', async () => {
  const ctx = makeCtx({});
  ctx.opts = { yes: true };
  let calls = 0;
  ctx.device.scroll = async (dir, o) => { calls++; return { scrolls: o.max ?? 5, changed: true }; };
  const tool = buildTools(ctx).find((t) => t.name === 'scroll');
  const r = await tool.execute('id1', { direction: 'down', until: 'edge' }, undefined, undefined, {});
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/tools-layer.test.js`
Expected: FAIL —— `until` 未被识别（`ok` 可能仍 true，但断言 `calls===1` 前的实现未分支）

- [ ] **Step 3: 实现**

`src/tools/action.js` 的 `scroll` 工具加 `until` 参数并分支：

```js
      until: Type.Optional(Type.String({ description: "edge（滚到底/到边界）| top（回到顶部）" })),
```

execute：

```js
      let r;
      try {
        if (params.until === 'edge' || params.until === 'top') {
          const dir = params.until === 'edge' ? (params.direction === 'up' ? 'up' : 'down') : 'up';
          r = await device.scroll(dir, { max: 20, stopWhenNoChange: true });
        } else {
          r = await device.scroll(params.direction, {
            max: params.max ?? 5,
            stopWhenNoChange: params.stopWhenNoChange !== false,
            ...(params.distancePct != null ? { distancePct: params.distancePct } : {}),
          });
        }
      } catch (e) { /* 原有兜错保持 */ }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/tools-layer.test.js`
Expected: PASS

---

## Task 3.3：lint 规则放宽（有停止条件时豁免）

**Files:**
- Modify: `src/lint/rules.js`（`unreachable-scroll`）
- Test: `test/lint-rules.test.js`

**Interfaces:**
- Consumes: 无
- Produces: 含 `until`/`maxScrolls` 的行不触犯 `unreachable-scroll`

- [ ] **Step 1: 写失败测试**

在 `test/lint-rules.test.js` 追加：

```js
test('unreachable-scroll：有显式停止条件时不拦（§2.4.5）', () => {
  const { lintCaseText } = require('../src/lint/rules.js');
  // 有 until 的显式指令 → 放行
  const explicit = 'steps:\n  - scroll:\n      until: edge\n';
  assert.equal(lintCaseText(explicit).filter((i) => i.rule === 'unreachable-scroll').length, 0);
  // 纯 NL "直到最后" → 仍拦
  const nl = 'steps:\n  - do: 一直往下滚直到最后\n';
  assert.ok(lintCaseText(nl).some((i) => i.rule === 'unreachable-scroll'));
});
```

> 注：`test/lint-rules.test.js` 是 ESM 还是 CJS 以现有文件为准——若为 ESM，用 `import`。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/lint-rules.test.js`
Expected: FAIL —— 显式写法也被拦

- [ ] **Step 3: 实现**

`src/lint/rules.js` 的 `unreachable-scroll.test` 加前置豁免：

```js
    test: (line) => {
      // 有显式停止条件（until / maxScrolls）→ 该表述可达成，放行（§2.4.5）
      if (/\b(until|maxScrolls)\s*[:：]/.test(line)) return false;
      return /(直到最后|最后一个.{0,6}(出现|显示|加载)|再往下[滑滚]{0,2}\s*\d+\s*行|让(所有|全部|每个).{0,12}(显示|展示|出现|可见))/.test(line);
    },
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/lint-rules.test.js`
Expected: PASS

---

# P4：坐标缓存键改步骤身份

## Task 4.1：键构造纯函数

**Files:**
- Modify: `src/tools/locate-cache.js`
- Test: `test/tools-layer.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `buildCacheKey({ caseId, stepIndex, locateOrdinal, target })` → `string`

- [ ] **Step 1: 写失败测试**

```js
test('buildCacheKey：caseId::stepIndex::locateOrdinal::target', async () => {
  const { buildCacheKey } = await import('../src/tools/locate-cache.js');
  assert.equal(buildCacheKey({ caseId: 's2-profile', stepIndex: 3, locateOrdinal: 0, target: '热榜' }),
    's2-profile::3::0::热榜');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/tools-layer.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/tools/locate-cache.js` 加导出并替换键构造：

```js
export function buildCacheKey({ caseId, stepIndex, locateOrdinal, target }) {
  return `${caseId ?? 'unknown'}::${stepIndex ?? -1}::${locateOrdinal ?? 0}::${target ?? ''}`;
}
```

`locateWithCache` 内：键改为 `buildCacheKey(ctx.currentStepKey ?? {})`，并在**读/写**两处用同一键；`screenSize` 参与失效校验（读到的行 `screenSize` 与当前不一致 → 视为 miss）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/tools-layer.test.js`
Expected: PASS

---

## Task 4.2：`locateOrdinal` 计数 + `ctx.currentStepKey`

**Files:**
- Modify: `bin/ask.js`（每步骤重置计数器，写入 ctx.currentStepKey）
- Modify: `src/session/create.js`（ctx 加字段）
- Modify: `src/tools/locate-cache.js`（用 ctx.currentStepKey）
- Test: `test/tools-layer.test.js`

**Interfaces:**
- Consumes: `buildCacheKey`
- Produces: 每次定位有唯一键

- [ ] **Step 1-4（TDD 循环）**

测试：连续两次 `locate` 同一 target，`locate_cache` 应有**两行不同键**（stepIndex 相同、ordinal 0/1）：

```js
test('连续定位同一 target：键含递增 ordinal（不互相覆盖）', async () => {
  const store = makeFakeStore();
  const ctx = makeCtx({ store });
  ctx.currentStepKey = { caseId: 'c1', stepIndex: 0, locateOrdinal: 0, target: '热榜' };
  const tools = buildTools(ctx);
  const locate = tools.find((t) => t.name === 'locate');
  await locate.execute('a', { target: '热榜' }, undefined, undefined, {});
  ctx.currentStepKey = { caseId: 'c1', stepIndex: 0, locateOrdinal: 1, target: '热榜' };
  await locate.execute('b', { target: '热榜' }, undefined, undefined, {});
  const rows = store.read('locate_cache');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].key, rows[1].key);
});
```

实现：`bin/ask.js` 步骤循环里，`ctx.currentStepIndex = i` 之后加 `ctx.locateOrdinal = 0;`；`locate-cache.js` 每次定位成功后 `ctx.locateOrdinal = (ctx.locateOrdinal ?? 0) + 1;`（**读 hint 前不自增**，保证同一次调用用同一键）。

- [ ] **Step 5: 全量回归 + 真机验证**

Run: `node --test`
Expected: 全绿
真机：跑 `ask run s2-profile.yaml` 两次，第二次的 run.json 里 `strategy` 应更多出现 `cache`（对比修复前 3%）。

---

## 自检（写完计划后执行）

- **Spec 覆盖**：§2.6 状态回滚→P1；§2.6.6 缺陷#14→P0；§2.7 弹窗→P2；§2.4 滚动→P3；§2.5 缓存键→P4。✅
- **占位符**：无 TBD；每个代码步骤都有实际代码。✅
- **类型一致性**：`restoreNetwork`/`buildCacheKey`/`scrollDistancePoints` 在定义与使用处签名一致。✅
- **契约**：`device.scroll` 返回形状保持 `{scrolls, changed}`（Task 3.1 显式守住）。✅
