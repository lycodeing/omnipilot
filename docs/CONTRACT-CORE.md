# 核心开发契约（第一波：设备层 / 会话层 / 数据层）

> 依据 `DESIGN.md`（下称 §N）。三个并行代理共同遵守本文件；**签名与数据形状不得擅改**，
> 发现契约缺陷在最终报告里声明偏差，不自行扩权。
> 依赖方向（§2.2，严格单向）：`bin/ask.js → session → tools → {device, net, store, mcp}`。
> 下层不认识上层。环境：Node 24，ESM（`"type":"module"`），只可 import 这些已安装依赖：
> `@earendil-works/pi-coding-agent`、`@modelcontextprotocol/sdk`、`typebox`（TypeBox 的 `Type` 就从这里 import）
> 以及 Node 内置模块。**禁止 npm install。**
> Pi 的 API 以包内文档为准：`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` 与
> `examples/sdk/*.ts`（02-custom-model / 03-custom-prompt / 05-tools / 11-sessions 必读）。

## 0. 文件归属

| 代理 | 文件 | 测试（顶层 test/，`node --test` 直跑） |
|---|---|---|
| **A 设备层** | `src/device/adb.js` `screen.js` `uitree.js` `cache.js` `locate.js` `action.js` `input.js` `rollout.js` `state.js`、`src/device/coord/{strategy,registry,probe}.js`、`src/net/profile.js` | `test/device-*.test.js`（单元，无设备）+ `test/integration-*.test.js`（真机门控：`ASK_TEST_DEVICE=1` 才跑，否则 `t.skip`）+ `test/fixtures/ui-dump.xml`（真实样本） |
| **B 会话/工具层** | `bin/ask.js`、`src/session/{create,prompt,persist,model,case}.js`、`src/tools/{index,perception,action,env,data,mcp}.js`、`src/mcp/{client,config,bridge}.js`、`src/lint/rules.js`、`prompts/{system,system.android}.md`、`skills/android-login.md`、`mcp.json` | `test/session-*.test.js` `test/tools-*.test.js` `test/mcp-*.test.js` `test/lint-*.test.js` |
| **C 数据/报告层** | `src/store/{dataset,query}.js`、`src/recorder/index.js` | `test/store-*.test.js` `test/recorder-*.test.js` |

测试一律 `node:test + node:assert`，临时目录用 `fs.mkdtemp(os.tmpdir())`，不得污染项目目录。

---

## 1. 跨层接口（三方缝合点，逐字遵守）

### 1.1 设备门面 `src/device/index.js`（A 提供，B 的工具层消费）

A 额外交付 `src/device/index.js`，导出唯一工厂（工具层只认它，不直接 import device 内部模块）：

```js
export async function createDevice({ serial, adbPath = process.env.ASK_ADB || 'adb', timeouts } = {});
// 返回 Device 实例（关闭用 device.close()）：
// —— 感知 ——
screencap(): Promise<{ buffer: Buffer(png), size: {w,h} }>
dumpTree({ fresh = false } = {}): Promise<{ nodes: UiNode[], hash: string, dumpMs: number,
  fromCache: boolean }>            // 走三态缓存；fresh 强制重 dump 并刷新缓存
locate(target, { vlm = null, hintBounds = null, hintIdentity = null } = {}):
  Promise<{ ok: boolean, bounds: [l,t,r,b] | null, center: [x,y] | null, strategy: string,
    treeCacheHit: boolean, vlmCacheHit: boolean, dumpMs: number, identity: object | null,
    error: string | null }>
  // 策略链 §5.1：精确文本→正则/包含→resource-id→class+index→VLM（vlm 注入函数才启用）
  // hintBounds：跨执行坐标缓存提示（§5.0.5），命中前先按 hintIdentity 校验（§14.2.1 identity 快照）；
  //   校验失败即弃用 hint 走正常链。strategy 取值含 'exact_text'|'regex'|'resource_id'|'class_index'|'vlm'|'cache'
readText(selector): Promise<{ ok, value, error }>   // selector 形如 'text=xx' | 'index=0' | 'class=...#index=1'（§7.1）
screenDiffHash(): Promise<string>                   // 当前树 hash（变化判定一律用它，禁止截图 hash）
// —— 操作 ——（动作成功后一律 markDirty()）
tap(bounds): Promise<{ ok, latencyMs, error }>      // bounds 中心点；含响应判定（§5.4.3）
longPress(bounds, durationMs): 同上
inputText(bounds, text): Promise<{ ok, readBack, error }>  // yadb 路径 §5.4.5，回读校验
swipe(from, to, { durationMs = 300 } = {})          // from/to 为 bounds 或 [x,y] 或区域名 'bottom'|'top'|'left'|'right'
scroll(direction, { max = 5, stopWhenNoChange = true } = {}): Promise<{ scrolls: number, changed: boolean }>
key(name): Promise<{ ok }>                          // back|home|enter|recent
launch(appId): Promise<{ ok, error }>               // 包名或 包名/activity
terminate(packageName): Promise<{ ok }>
// —— 环境 ——
foreground(): Promise<{ package, activity, resumedActivity }>   // 用 ResumedActivity，禁用 mCurrentFocus（§5.0.1）
screenSize(): Promise<{ w, h }>                     // 会话级缓存（wm size）
processAlive(packageName): Promise<boolean>
waitIdle({ quiet = 2, intervalMs = 600, timeoutMs = 10000 } = {}): Promise<{ stable: boolean, dumps: number }>
assertNoCrash(expectedPackage): Promise<{ ok, alive, foreground, error }>
netSetProfile(name): Promise<{ ok, profile, error }>   // 委托 src/net/profile.js
netStatus(): Promise<{ profile }>
// —— 缓存与取证 ——
markDirty(): void                                   // 每次动作后置脏（§5.0.6）
invalidateCache(): void                             // 定位失败回退用（丢缓存重识别）
cacheStats(): { dumps, hits, misses, dirtyResets }
dumpToFile(path): Promise<string>                   // ui_dump 落盘取证
close(): Promise<void>
```

**UiNode 形状**（uitree.js 解析产物，A/B 双方一致）：

```jsonc
{ "index": 3, "text": "电子相册", "cls": "android.widget.TextView",
  "resourceId": "com.lgdg:id/album", "contentDesc": "", "clickable": false,
  "bounds": [512, 760, 704, 880], "center": [608, 820], "children": [ ... ] }
```
- 解析规则：`bounds="[l,t][r,b]"` → 数组；`/dev/tty` 输出按 `</hierarchy>` 截断去杂质（§5.0.1）
- `hash`：对扁平化后的 (text, resourceId, cls, clickable, bounds) 序列做稳定 sha1（前 16 位）；
  同页面重复 dump 必须同 hash（§16.2 回归点）
- uitree.js 同时导出 `flattenNodes(nodes)`（深度优先扁平数组）与 `parseXmlDump(xmlText)`

### 1.2 运行上下文 `src/session/create.js`（B 内部约定，工具闭包共享）

```js
export function createRunContext({ device, recorder, store, opts }) {
  // ctx = {
  //   device,            // §1.1 门面
  //   recorder,          // §1.4 RunRecorder 实例（C）
  //   store,             // §1.3 dataset API（C）
  //   vars: Map,         // 运行时变量表：data_extract 写入，${var} 执行期插值（§7.5）
  //   opts: { yes, timeoutMs=60_000, vlmLocate=false, freshLocate=false, rollback='on' },
  //   secretCalls: [],   // 每次 secret_get/sms_read 调用 push {tool, provider, key, stepIndex}
  //                      //   → run 收尾据此强制 --fresh（§9.1）+ 通知 recorder 脱敏
  // }
}
```
工具实现里通过闭包拿 ctx（`defineTool` 的 execute 第 5 参 `ExtensionContext` 不用于设备，业务上下文由
`src/tools/index.js` 的 `buildTools(ctx)` 工厂闭包注入，返回 `ToolDefinition[]`）。

### 1.3 数据集 API `src/store/dataset.js`（C 提供，B 的 data 工具消费）

```js
export function openDataset({ dataDir = 'datasets' }) → {
  append(name, rows, meta = { run, step }): { written }     // 每行补 _id/_ts/_run/_step（§14.2）
  upsert(name, key, rows, meta): { written, merged }        // 按主键去重（滚动采集 §7.1 collection）
  read(name): rows[]
  clear(name): void
  query(name, { where, select, limit, orderBy }): rows[]    // 委托 query.js；where 支持 'field>lit' 等（§13.2）
}
// _id = sha1(内容 JSON).slice(0,8)；schema 校验：datasets/<name>.schema.json 存在则
// { field: 'string'|'number'|'boolean'|'string?'... } 不符即抛错（§7.2）
```

### 1.4 执行记录器 `src/recorder/index.js`（C 提供，B 的 run 流程消费）

```js
export class RunRecorder {
  constructor({ runsDir = 'runs', caseName, device, model })
  //   model = { family, name, baseUrlHash }（不落密钥明文 §14.1）
  //   生成 runId = `run-YYYYMMDD-HHmmss-<4位随机>`；mkdir runs/<runId>/
  get runId / get dir / get jsonPath        // jsonPath = runs/<runId>.json
  startStep(type, target): stepHandle       // 记 startedAt（相对 run 起点的 ms）
  //   handle.end({ result = 'ok', locate = null, secret = null, error = null })
  //     locate 形状 = device.locate() 返回值（§1.1，落 §14.1 steps[].locate）
  //     secret = { provider, key } → 该步结果字段落盘前强制替换
  //       `[REDACTED:<provider>:<key>]`（§14.1/§19.7 安全边界）
  attachScreenshot(stepIndex, pngBuffer): string   // 落 runs/<runId>/step-<i>.png，回填 step.screenshot 相对路径
  addAssertion({ text, passed, reason })
  addNetworkEvent({ at, profile })          // at = 相对 ms
  addRollback({ stepIndex, reason, recovered })
  setExtracts(obj)
  setContextLayers([{ name, chars }])       // §14.1 contextLayers（B 装配提示词时量得）
  finish(status, { exitCode = 0 } = {})     // status: pass|fail|error|timeout|cancelled
  //   tmp + rename 原子写 runs/<runId>.json（§14.1 完整形状，含 artifacts.report 预留
  //   runs/<runId>/index.html）；写前执行脱敏扫描（secret 步 + 全文兜底替换）
}
```

### 1.5 跨执行坐标缓存（§5.0.5 / §14.2.1，三方分工）

- 存储 = 系统数据集 `datasets/locate_cache.jsonl`，**由 C 的 openDataset 承载**（同 §14.2.1 行形状）。
- **B 的 locate 工具**：定位成功后 upsert（键 `pageId:target`，pageId 用前台 Activity+包名退化值；
  写 bounds/identity/screenSize/hits/lastHitAt）；本次 locate 前 `--fresh-locate` 未开启时读出
  `hintBounds/hintIdentity` 传给 `device.locate`。
- **A 的 locate**：只消费 hint 参数并做 identity 校验（R2），不读写文件。

---

## 2. 分代理交付要点（细节以 DESIGN.md 对应章节为准，代理须通读）

### 2.1 代理 A —— 设备层（通读 §5 全部、§2.3、§3.3、§10、§16）

- `adb.js`：串行队列（同设备命令排队）、单命令超时、断连检测与一次自动重连（§4 目录注释；
  `adb -s <serial> shell/exec-out`）；`execOut` 返回 Buffer（screencap 用）。
- `screen.js`：`screencap -p` → PNG Buffer + 解析 `wm size` 得 size。
- `uitree.js`/`cache.js`：按 §1.1；缓存三态 fresh/dirty/void + TTL **4000ms**（§17 已拍板）+
  动作置脏（§5.0.6）；**文本匹配不缓存**（§5.0.2.1 实测）；统计 dumps/hits/misses。
- `locate.js`：策略链 §5.1；`clickable=false` 节点兜底（向上找可点祖先/父容器，§5.4.2）；
  失败回退接 `rollout.js`（定位失败→丢缓存重识别→重试上限→步骤回滚 §5.0.5/5.0.6）。
- `coord/`：策略接口 + 4 实现 + registry + probe（§5.5：GLM/Qwen/Gemini/GPT 各家坐标约定不同，
  0-1 归一化 / yx 序 / 绝对像素……以 §5.5.2 表格为准）；probe.js 按 §5.5.3 探测式推断；
  `.ask/family-probe.json` 读写。
- `input.js`：yadb 路径（§5.4.5）：首次推送 `vendor/yadb` → `/data/local/tmp/` + chmod 执行，
  `yadb -keyboardClear` 清空 → `yadb -keyboard <text>` 输入（支持中文/空格/混合）→ **回读校验**。
- `state.js`：前台用 `dumpsys activity` 的 ResumedActivity（mCurrentFocus 不可信 §5.0.1）；
  进程存活 `pidof`；崩溃检测。
- `action.js`：tap/longPress/swipe/key 基于 bounds 中心点（§5.4）；响应判定 §5.4.3。
- `src/net/profile.js`：`adb shell net <profile>`；档位 off/2g/3g/4g/5g/airplane/cut/custom（§10）。
- **单元测试必须全绿且无设备依赖**：coord 三家换算正确、XML 解析（真实样本 fixture）、缓存三态、
  rollout 状态机、uiautomator 杂质截断、hash 稳定性。集成测试放 `test/integration-*.test.js`，
  无 `ASK_TEST_DEVICE=1` 时整体 skip。

### 2.2 代理 B —— 会话/工具/MCP/CLI（通读 §2、§3、§6、§7、§8、§9、§10、§11、§13、§16）

- `src/session/model.js`：解析 `ASK_MODEL_URL/KEY/NAME/FAMILY`（`--model-*` 可覆盖）→ 用
  `ModelRuntime.create()` + `ModelRegistry.registerProvider(family, { baseUrl, apiKey, models:[…] })`
  派生 Model（照 examples/sdk/02-custom-model.ts、12-full-control.ts 的路子）；`baseUrlHash = sha1(url).slice(0,8)`。
- `src/session/prompt.js`：三层装配 §6.1/6.2（append/replace/none；L2 永远保留；用户段末尾追加；
  12k 字符预算裁剪并 warn）；输出最终 systemPrompt 传 `DefaultResourceLoader` 的
  `systemPromptOverride`（照 examples/sdk/03-custom-prompt.ts）。
- `src/session/persist.js`：keep(默认 SessionManager.create)/fresh(inMemory)/continue(continueRecent)/
  session(open) 四策略（§9.1）；**含 secret_get/sms_read 调用的 run 强制 inMemory**（§9.1 例外）。
- `src/session/create.js`：`createRunContext`（§1.2）+ `createAskSession(ctx)`：`createAgentSession`
  配 `noTools:'builtin'`（关 Pi 自带 read/bash/edit/write，§11）+ `customTools: buildTools(ctx)`。
- `src/tools/index.js`：`buildTools(ctx) → ToolDefinition[]`（用 `defineTool`，参数 schema 用
  `import { Type } from 'typebox'`）。20+ 工具按 §10 归四文件：perception(action) / env(action) /
  data(data) / mcp(动态)；工具内**只调 ctx.device / ctx.store / ctx.recorder / ctx.mcp，禁止直接跑 adb**（§2.3）。
  - `tap/long_press/input/swipe/scroll/key/launch/terminate`：走 §1.1；input 需先 locate。
  - `screen`：截图 + 前台 + 分辨率；`uitree`：可过滤 clickable；`locate`；`screen_diff`（树 hash）。
  - `wait_idle`（quiet=2/600ms）、`assert_no_crash`、`net_profile/net_status`、`ui_dump`。
  - `data_extract`（ui/ai/collection 三模式 §7.1/7.3；ai 模式调模型 → 写 `src/tools/ai.js` 小助手：
    OpenAI 兼容 chat/completions + jsonrepair 容错，失败重试 1 次标 partial）、`data_query`、`data_store`。
  - `secret_get`/`sms_read`：§10 末二行 + §19.7；结果仅入上下文；ctx.secretCalls 记账。
  - 每个写操作工具（tap/input/…/net_profile/terminate）：`--yes` 未开且交互模式时需确认
    （SDK/SDK 外可简化为 opts.yes 直通 + 注释预留 confirm 钩子）。
- `src/mcp/{config,client,bridge}.js` + `src/tools/mcp.js`：§8 全流程（读 mcp.json → stdio/http 连接
  超时 10s 失败只 warn → listTools → allowTools glob 白名单**默认拒绝** → 命名冲突加 `server__` 前缀 →
  注册成 Pi 工具，描述前缀 `[MCP:server]`；调用超时 30s、结果 >8KB 截断标注）。用顶层已装的
  `@modelcontextprotocol/sdk`。`mcp.json` 交付默认内容：`{"servers":{},"toolPrefix":true,"allowTools":[]}`。
- `src/lint/rules.js`：§13.4 八条规则，**行级正则实现**（输入是 YAML 原文文本，不做完整 YAML 解析）：
  `lintCaseText(text) → [{ level:'error'|'warn', rule, message, line }]`；行内豁免
  `# ask-lint: allow <rule-id> 理由`（须有理由，否则豁免无效）。
- `src/session/case.js`：最小用例装载器——YAML 子集手写解析（`name:`、`steps:` 列表、每步
  `do: <文本>` / `ask: <问题>` / `assert: <文本>` / `net: <档位>` / `sleep: 秒`，注释与空行容忍），
  `${var}` 执行期插值（§7.5）；`run/do/ask` 统一为同一 Case 对象（§13.2）。
- `bin/ask.js`：§13 全部子命令（run/do/ask/data/lint/doctor/mcp）+ 全局参数 §13.3 + 退出码语义
  §13.1 表 + `--json/--quiet`；设备独占锁 `.ask/locks/<serial>.lock`（PID+时间戳，存活拒绝、
  死进程 10min 自动清，§13.2.1）；`--parallel N` 校验设备数不足即退出码 2（§13.2.1）。
  run 流程：锁 → createDevice → RunRecorder(C) → createAskSession(B) → 逐步 prompt → recorder.finish。
- `prompts/system.md`（L1 要点表 §6.2 全部六条）+ `prompts/system.android.md`（L2 模板：
  设备事实占位符 `{{SCREEN_SIZE}}`/`{{DEVICE_MODEL}}`/`{{ANDROID_VERSION}}`/`{{NET_PROFILE_SECTION}}`
  由 `assemblePrompt({ facts })` 运行期填充——设备分辨率、型号、系统版本、net 命令支持与否一律**运行时读取**，
  不得写死；net 不支持时 L2 说明 `net_profile` 返回 ok=false 属预期）+ `skills/android-login.md`（§19.7 登录节奏）
  + `skills/android-navigation.md`（底栏定位陷阱/转场/断言纪律）。
  注：技能实际生效位置为 `.pi/skills/<name>/SKILL.md`（Pi SDK 不扫描项目根 `skills/`），`skills/` 为源版本。
- 单元测试：prompt 装配三模式与裁剪、lint 八规则+豁免、case 解析+变量插值、mcp 配置解析+glob
  白名单+命名前缀、tools 工厂注册表完整性（对 §10 清单逐一断言存在）。模型相关全部 mock/注入，不真连。

### 2.3 代理 C —— 数据与报告（通读 §7.2、§14 全部、§5.0.5、§19.7）

- `src/store/dataset.js` + `query.js`：§1.3 全部签名；where 支持 `field>lit`/`field<lit`/`field=lit`/
  `field!=lit` 与 `&&`；orderBy `field`|`-field`；schema 校验含可选类型 `string?` 等。
- `src/recorder/index.js`：§1.4 全部签名 + §14.1 完整 run.json 形状（steps[] 的 locate 原样透传、
  contextLayers、networkTimeline、rollbacks、extracts、artifacts、model.baseUrlHash）；
  脱敏（§14.1 脚注 + §19.7）：`secret_get`/`sms_read` 步骤结果字段强制
  `[REDACTED:<provider>:<key>]`，并对全文做兜底扫描；tmp+rename 原子写。
- 测试：§14.1 映射逐字段断言、脱敏三处落点、原子写（进程中断不产生半截 json——用 finalize 前后
  文件状态断言）、dataset append/upsert/query/schema 全覆盖、`locate_cache.jsonl` 行形状 §14.2.1。

---

## 3. 验收口径（主代理评审用）

1. 三方签名/形状与本契约零偏差（偏差须在最终报告声明）。
2. `node --check` 全部 JS 通过；`node --test test/`（三方测试合并）全绿——设备/模型相关测试
   未设 `ASK_TEST_DEVICE=1` / 未配模型时一律 skip 而非 fail。
3. 交叉缝合点核对：B 的工具只经 `createDevice` 门面；B 的 run 流程只经 `RunRecorder`/`openDataset`；
   A 不 import store/session；C 不 import device/session。
4. 交付物覆盖 §4 目录结构中：bin/ask.js、src/{session,device,tools,net,store,recorder,lint,mcp}、
   prompts/、skills/、mcp.json（vendor/yadb 与 scripts/ 已存在，不动）。
