# 报告系统三方开发契约（v1）

> 依据：`../docs/DESIGN.md` §18–20（尤其 §19.5 dump 数据、§19.8 帧播放器、§19.8.6.5 节奏常量）。
> 三方共同遵守：A=逻辑层（report-dev-logic）、B=Vue 壳（report-dev-viewer）、C=Node 生成端（report-dev-recorder）。
> **任何一方不得擅改本文件的签名与数据形状**；如实现中发现契约缺陷，在最终报告里记录偏差，不自行扩权。
> 约束：A 的纯逻辑文件禁止 `import 'vue'`（vue 未安装）；C 只用 Node 内置模块；B 只 import `vue` 与 A 的四个纯逻辑模块；三方都不 npm install、不启动服务。

---

## 0. 目录与文件归属

```
report/
├── CONTRACT.md                     # 本契约（主代理维护）
├── recorder.js                     # C：run.json → dump + 单文件/外链双产物 + 增量写 + 脱敏
├── tools.js                        # C：splitReport / reportToMarkdown
├── cli.js                          # C：node report/cli.js <build|split|to-md> ...
├── test/                           # C 测试：recorder.test.js / tools.test.js / cli.test.js（node:test）
│   └── fixtures/run.sample.json    # C 自己的 run.json 样例（§14.1 形状）
└── viewer/
    ├── package.json                # B：仅声明 vue^3.4 / vite^5 / @vitejs/plugin-vue（不安装）
    ├── vite.config.js              # B
    ├── index.html                  # B：含 <div id="root">
    ├── src/
    │   ├── main.js                 # B：createApp，import useDump 读数据标签
    │   ├── App.vue                 # B：三区布局 + 顶部摘要条
    │   ├── components/             # B 全部组件（见 §4）
    │   ├── composables/useDump.js  # B：解析 <script type="ask-dump"> / <script type="ask-image">
    │   └── composables/useFramePlayer.js   # A：rAF 播放引擎（vue-free）
    └── src/utils/                  # A 纯逻辑（禁止 import 'vue'）
        ├── playback-math.js
        ├── buildReplayScripts.js
        └── derive-frame-state.js
    └── test/                       # A 测试（node:test）：4 个 .test.js 对应 4 个模块
    └── fixtures/sample-dump.json   # A 的 dump 样例（§2 形状，含 4~5 个 task 覆盖各分支）
```

注意：`utils/` 与 `composables/` 同级（都在 `src/` 下）。B import A 的模块一律用相对路径
`../composables/useFramePlayer.js`、`../utils/buildReplayScripts.js` 等（组件在 `components/` 下则 `../composables/...`）。

---

## 1. HTML 产物结构（B 读、C 写，双方一致）

单文件（single-html，默认）：

```html
<!-- 壳：viewer 构建产物（B），或 C 的内置兜底壳（见 §5.4） -->
<script type="ask-dump" data-group-id="<groupId>">{...dump JSON...}</script>
<script type="ask-image" data-id="<uuid>">data:image/png;base64,...</script>  <!-- 每图一个 -->
```

- `ask-image` 的 dataURL MIME 按图片魔数判定：`FF D8` 开头为 `image/jpeg`（模型输入图常为压缩 JPEG），
  其余为 `image/png`（见 `report/recorder.js` 的 `toDataURL`）。硬编码 `image/png`
  会让浏览器拒绝解码 JPEG 输入图。
- dump JSON 内 **不含图片数据**：`screenshots` 值在 single-html 模式下一律为 `""`（占位），
  真实 dataURL 放 `ask-image` 标签的 textContent。B 侧 useDump 把 ask-image 收进 `screenshots` 映射。
- 外链（html-and-assets）模式：dump 标签追加属性 `data-screenshot-mode="directory"`，
  **不写 ask-image 标签**，`screenshots` 值为相对路径 `"./screenshots/<uuid>.png"`，图片由 C 落盘 PNG。
- JSON 写入前必须转义防提前闭合：**转义全部 `<` 为 `<`**（`<` 是合法 JSON 转义，解析后还原）。
  - 原写法 `json.replace(/<\//g, '<\\/')` 只转义 `</`，**不足以**达到"防提前闭合"的目的：
    HTML 解析器遇到 `<!--<script>` 会进入 "script data double escaped" 状态，此后
    `</script>` 不再闭合标签，后续内容全被吞进 script 元素——整份报告损坏
    （实测：一行模型 thought 即可触发）。`<` 全量转义不进入任何 HTML tokenizer 状态。
  - 该转义须施加于**全部** dump JSON 写入点（makeDumpTag / appendExecution / finalize）。
- 所有标签统一插在壳的 `</body>` 之前（C）；增量 append 时逐条追加。
- 同 group 重复 append 是允许的：**读取侧按 data-group-id 去重保最新**（§19.8.6.5）。
- groupId：默认 `default`（单任务报告）；多任务时为批次名。B 对 executions 数量零假设。

---

## 2. dump JSON 数据契约（三方核心接口，§19.5 形状）

```jsonc
{
  "sdkVersion": "ask-0.1.0",
  "groupName": "巡检-20261026",
  "groupDescription": "",
  "deviceType": "android",
  "device": { "serial": "...", "model": "redroid", "size": "720x1280" },   // 原样透传，可缺省
  "modelBriefs": [ { "intent": "planning", "name": "glm-4.6v" } ],
  "durationMs": 48213,                       // 整个 run 总耗时（顶部摘要条用）
  "status": "pass",                          // pass|fail|error|timeout|cancelled
  "executions": [{
    "id": "run-xxx",
    "name": "相册列表",
    "logTime": "2026-10-26T15:30:12+08:00",
    "tasks": [{
      "taskId": "3",                         // String(step.index)
      "type": "tap",                         // step.type 原样；词表单一来源 src/tools/vocab.js
                                             //（25 契约工具名 + point_tap + sleep|net|aiWaitFor|answer_row；MCP 工具名为动态名，端上原样回退）
      "status": "finished",                  // ok→finished，其余→failed
      "thought": "模型思考原文，可为空串",
      "param": { "target": "电子相册" },      // 动作参数；assert 步为 { "text": "..." }
      "errorMessage": null,                  // failed 时非空
      "timing": { "start": 4210, "end": 4522, "durationMs": 312 },
      "locate": {                            // 可整体缺省（无定位的步骤）
        "strategy": "exact_text",
        "bounds": [512, 760, 704, 880],      // [l,t,r,b] 像素，截图坐标系
        "treeCacheHit": true, "vlmCacheHit": false, "dumpMs": 0,
        "screenshotId": "<uuid>"             // 本步截图引用
      }
    }]
  }],
  "screenshots": { "<uuid>": "" },           // single-html 值空串（图在 ask-image 标签）；assets 模式为相对路径
  "networkTimeline": [ { "at": 4210, "profile": "3g" } ],
  "assertions": [ { "text": "列表按时间倒序", "passed": true, "reason": "模型判词原文",
                     "screenshotId": "<uuid>",        // 可选：判定输入截图引用（addAssertion 透传，buildDump 把路径替换为 uuid）
                     "evidenceSource": "screen",       // 可选：判定依据（dataset/screen）
                     "nudges": 1 } ],                 // 可选：催答轮数（>0 才落键）
  "rollbacks": [ { "stepIndex": 7, "reason": "locate_miss_x3", "recovered": true } ]
}
```

缺省规则（B 渲染端对一切可选字段做兜底，不得因缺失而抛错）：
`screenshots/networkTimeline/assertions/rollbacks/device/durationMs/status/groupDescription` 均可缺省；
task 的 `locate/thought/param/timing` 可缺省。
assertions 项的 `screenshotId/evidenceSource/nudges` 为**可选扩展字段**（`src/recorder/index.js`
的 `addAssertion` 仅在有值时落键），缺省即旧形状，消费方不得因缺失抛错。

---

## 3. A：纯逻辑层 API（utils/ 3 个 + composables/useFramePlayer.js，全部 vue-free、ESM）

### 3.1 `utils/playback-math.js`

```js
export const FPS = 30;
export const DUR = { stillAfterInsight: 300, locate: 800, spinningPointer: 300, action: 500, still: 900, lastFrame: 200 };
export const CROSS_FADE_FRAMES = 10;
export const CAMERA_ZOOM_MAX = 2.2;

export function framesFor(ms);            // Math.ceil(ms / 1000 * FPS)，ms<=0 → 0
export function layoutScripts(scripts);   // → { segments, totalFrames, lastEffectiveFrame }
// 顺序游标累加：segment = { index, script, startFrame, frameCount }
//   startFrame_{i+1} = startFrame_i + frameCount_i；0 帧脚本（frameCount=0）允许，占当前游标不推进。
// totalFrames = 最后一段 startFrame+frameCount（空脚本数组 → 0）。
// lastEffectiveFrame = 结尾 End 段（script.taskId===null 且 script.end===true）的 startFrame；
//   无 End 段 → totalFrames。进度条 100% = lastEffectiveFrame（End 帧不计入）。
```

### 3.2 `utils/buildReplayScripts.js`

```js
export const ACTION_TYPES = REPLAY_ACTION_TYPES;  // 从 @engine/vocab（src/tools/vocab.js）派生，不在 viewer 本地维护
export function typeLabel(type);          // 中文标签，源 = STEP_LABELS（@engine/vocab）
                                          // 未收录类型（MCP 动态工具名等）→ 原样回退
export function buildReplayScripts(execution);   // execution = dump.executions[i] → AnimationScript[]
```

AnimationScript 形状（kind ∈ `img | insight | spinning-pointer`；**不生成 0 帧 pointer 脚本**，
指针状态直接挂在动作后的 img 脚本上——对 Midscene 行为等价、实现更简，契约层面已定）：

```jsonc
{
  "taskId": "3",            // End 段为 null
  "end": false,             // End 段 true
  "kind": "img",            // img | insight | spinning-pointer
  "screenshotId": "<uuid>", // 可空；End 段复用最后一张
  "bounds": [l,t,r,b],      // 仅 insight / 带 pointer 的 img
  "pointer": { "x": 608, "y": 820 },  // bounds 中心，仅动作 img；无 bounds 的动作无此字段
  "title": "点击",          // typeLabel(task.type)；End 段 title="结束"
  "subTitle": "电子相册",    // param.target ?? param.text ?? param 值摘要；End 段为 run 名
  "errorMessage": null,     // failed 任务附加的 img 上非空，作副标题
  "durationMs": 800
}
```

每个 task 的编排（§19.8.1）：
- 有 `locate.bounds` 且 type ∈ ACTION_TYPES → `[img(DUR.stillAfterInsight), insight(DUR.locate), img(DUR.action, pointer)]`
- 有 `locate.bounds` 其余类型（如 screenshot）→ `[img(stillAfterInsight), insight(locate)]`
- type ∈ ACTION_TYPES 无 bounds → `[spinning-pointer(DUR.spinningPointer), img(DUR.action)]`
- 其余（assert/sleep/extract/…）→ `[img(DUR.still)]`
- `status==='failed' && errorMessage`：在上述序列**末尾追加**一张 `img(DUR.still, errorMessage)`（screenshotId 用该 task 最后一张）
- task 无任何 screenshotId：跳过 img/insight 里无图者；整组为空则产出单张 `[img(DUR.still)]`（screenshotId 为 null）
- 收尾：追加 End `{ taskId:null, end:true, kind:'img', durationMs:DUR.lastFrame, screenshotId:最后一张, title:'结束', subTitle:execution.name }`
- 空 executions/tasks：仅 End 段。

### 3.3 `utils/derive-frame-state.js`

```js
export function deriveFrameState(frame, layout);  // 帧号 → 纯状态，无副作用
// frame 越界钳到 [0, max(0,totalFrames-1)]；layout.totalFrames===0 → { empty:true, ...空状态 }
// 命中段 = startFrame <= frame 的最后一个段（含 0 帧段，同 startFrame 时取后者——即指针/瞬时状态生效）
```

返回形状：

```jsonc
{
  "empty": false,
  "frame": 42,
  "segmentIndex": 2,
  "taskId": "3",               // 侧边栏联动
  "kind": "insight",
  "playing": true,             // 供 UI 参考：非 End 段即 true
  "screenshotId": "<uuid>",    // 当前图
  "prevScreenshotId": null,    // 交叉淡入的旧图（换图段且与前段不同图时才有）
  "opacity": 1,                // 当前图不透明度：换图段前 min(CROSS_FADE_FRAMES, frameCount) 帧线性 0→1
  "camera": { "zoom": 1, "cx": 360, "cy": 640 },  // 图像像素坐标的缩放中心；zoom=1 即无运镜
  "highlight": { "x": 512, "y": 760, "w": 192, "h": 120 },  // bounds 展开；仅 insight 段
  "highlightOpacity": 1,       // insight 段前 1/4 线性淡入，其余 1；非 insight 段 0（无高亮）
  "pointer": { "x": 608, "y": 820, "spinning": false },  // spinning-pointer 段 → spinning:true 无坐标
  "subtitle": { "title": "点击", "subTitle": "电子相册", "errorMessage": null }
}
```

insight 段相位（p = 段内进度 0..1）：
- `highlightOpacity = clamp(p*4, 0, 1)`（前 1/4 淡入）
- `p < 0.5` → `zoom=1`；`p>=0.5` → `zoom = 1 + (CAMERA_ZOOM_MAX-1)*easeInOut((p-0.5)/0.5)`，
  cx/cy = bounds 中心（恒定）。easeInOut = t<.5?2t²:1-2(1-t)²。
- 非 insight 段 camera.zoom 恒 1。
- End 段：taskId=null、无高亮无指针、opacity=1、`playing:false`。

### 3.4 `composables/useFramePlayer.js`（vue-free 引擎，B 在组件里包一层 ref）

```js
export function createFramePlayer(options);
// options: { totalFrames, fps=FPS, initialFrame=0, rate=1,
//            onFrame(frame),                     // 帧变化回调（seek/播放都触发）
//            timing: { requestAnimationFrame, cancelAnimationFrame, now } }  // 可注入，缺省用全局（测试注入假时钟）
// 返回: {
//   play(), pause(), toggle(),                 // play 在末帧时回到 0 再播；到 totalFrames-1 自动 pause 停在末帧
//   seekTo(frame),                             // 钳到 [0, totalFrames-1]，未变化不触发 onFrame
//   setRate(r), getRate(), getFrame(), isPlaying(),
//   destroy()                                  // cancel rAF，之后调用任何方法为 no-op
// }
```

实现要求：`requestAnimationFrame` 固定步长累加器——`accumulated += delta * rate`，
每满 `1000/fps` 推进一帧（一次 delta 可推进多帧）；`onFrame` 每次实际帧变化调用一次。

### 3.5 A 的测试与夹具

- `fixtures/sample-dump.json`：§2 形状，覆盖：带 bounds 的 tap、无 bounds 的 key、assert、failed 任务、
  networkTimeline/assertions/rollbacks、screenshots 占位。
- 4 个测试文件：playback-math（framesFor/游标累加/lastEffectiveFrame）、buildReplayScripts（四类编排 +
  failed 附加帧 + End + 空输入）、derive-frame-state（相位/淡入/越界钳制/End/空）、use-frame-player
  （注入假 rAF：播放推进、seek 钳制、rate、末帧自停、destroy 后 no-op）。

---

## 4. B：Vue 壳组件契约（props / emits / expose）

布局：左侧 Sidebar（ executions → tasks 树）｜主区 Player（StepScene + seek/章节/字幕/倍速/全屏）
＋下方 ThoughtPanel｜AssertionCard｜NetworkLane｜LocateStats。顶部摘要条（groupName、status、durationMs、
modelBriefs、device.size、通过率）。多任务（executions>1）侧边栏按 execution 分组折叠；单任务自动展开、
隐藏折叠钮。样式手写 scoped CSS，深色播放器风格可自定，但**结构类名**须含：
`side-bar / executions-wrapper / step-item / player-stage / seek-bar / chapter-mark / subtitle / thought-panel /
assertion-card / network-lane / locate-stats`（联调与评审定位用）。

| 组件 | props | emits / expose | 职责一句话 |
|---|---|---|---|
| `App.vue` | 无（自取 useDump） | — | 装配三区；持有 currentExecutionIndex/currentTaskId；摘要条 |
| `Sidebar.vue` | `executions, currentExecutionIndex, currentTaskId, singleMode` | `select-task(executionIndex, taskId)` | 执行列表与步骤树、状态色、耗时 |
| `StepItem.vue` | `task, active` | `select(taskId)` | 单步行：图标/状态色/耗时/失败红点 |
| `Player.vue` | `execution, screenshots` | `emit('task-change', taskId)`；`expose: seekToTask(taskId)` | 内部调 buildReplayScripts+layoutScripts+createFramePlayer，逐帧 deriveFrameState 下发 |
| `StepScene.vue` | `state, screenshots` | — | 逐帧渲染：双图交叉淡入、camera transform、高亮矩形、指针/转圈、字幕、无图占位 |
| `ThoughtPanel.vue` | `task` | — | thought / param（JSON 折叠）/ timing 三块 |
| `AssertionCard.vue` | `assertions` | — | 断言 pass/fail + 模型判词 reason |
| `NetworkLane.vue` | `networkTimeline, durationMs` | — | 弱网时间轴：profile 分段泳道 + 切网时刻刻度 |
| `LocateStats.vue` | `tasks` | — | 汇总：策略命中分布、tree/vlm 缓存命中率、dumpMs 均值 + 逐行明细 |

关键联动（§19.8.5）：Player 每帧 `emit('task-change', state.taskId)`（taskId 为 null 不发）；
App 转给 Sidebar 高亮；Sidebar `select-task` → App 调 `playerRef.seekToTask(taskId)`。
`seekToTask(taskId)`：找该 task **第一个段**的 startFrame 并 seekTo。
倍速：0.5/1/1.5/2；空格播放/暂停（Player 获得焦点或全局监听，勿与输入框冲突）；全屏：stage 容器 requestFullscreen。
Screenshots 取图：`screenshots[screenshotId]` 缺失 → 深色占位块 + taskId 文本，不抛错。
`main.js`：`createApp(App).mount('#root')`；数据缺失（无 ask-dump 标签）时在 #root 显示简明错误文案，不白屏。

`vite.config.js`：`base:'./'`，普通 build（无需 singlefile 插件——C 的 loadShell 负责内联 JS/CSS）。
`package.json`：`{ name:"ask-report-viewer", type:"module", scripts:{ build:"vite build" }, dependencies:{vue:"^3.4"}, devDependencies:{vite:"^5", "@vitejs/plugin-vue":"^5"} }`。

### 4.1 useDump.js

```js
export function parseReportDocument(doc = document);
// → { meta: {sdkVersion,groupName,groupDescription,deviceType,device,modelBriefs,durationMs,status},
//     executions: [...], screenshots: {id: src} }
// 同 group 去重保最新；ask-image 标签的 textContent 直接入 screenshots 映射（assets 模式则为相对路径，
// 配合 C 写入的 <base> 由 <img src> 相对解析）；executions 按 dump 顺序拼接。
```

---

## 5. C：Node 生成端契约（全部 Node 内置模块）

### 5.1 `recorder.js`

```js
export const DUMP_TAG_TYPE = 'ask-dump';
export const IMAGE_TAG_TYPE = 'ask-image';
export const REDACTED_PREFIX = '[REDACTED';

export function buildDump(runJson, opts = {});
// run.json(§14.1) → dump(§2)。映射（§19.5 表）：steps→executions[0].tasks（taskId=String(index)、
// timing.end=startedAt+durationMs、locate 原样透传、type/target→type/param.target）；
// status 映射为四态：ok→finished、cancelled→cancelled、error→error、其余→failed；
//   另有 `[REDACTED:...]`（recorder 为防密钥落盘覆写的脱敏标记）→finished ——
//   否则一次**成功**的 secret_get 会被显示为 failed，状态信号被脱敏机制毁掉；
// model→modelBriefs=[{intent:'planning',name}]；
// device/status/durationMs/assertions/networkTimeline/rollbacks 透传；screenshots 键 = 各 step 的
// screenshotId（uuid 由 buildDump 生成并回填 locate.screenshotId），single-html 值 ""。
// opts: { groupName?, runId?, screenshotIds? }。steps 为空 → executions[0].tasks=[]。
export function redactValue(provider, key);   // → `[REDACTED:${provider}:${key}]`
export function redactDump(dump);
// 安全边界：遍历 tasks，凡 task.type ∈ {'secret_get','sms_read'}，其 thought/param/result 全部字符串值
// 替换为 redactValue(type, param.key ?? param.provider ?? 'secret')；assertions.reason 同样扫描。
export function makeDumpTag(groupId, dump);        // → '<script type="ask-dump" data-group-id="...">…</script>'（含转义）
export function makeImageTag(id, src);             // dataURL 或路径均可
export class ReportWriter {
  constructor({ outPath, shell, mode = 'single-html', baseDir });  // mode: 'single-html' | 'directory'
  appendExecution(dump);       // 追加 ask-dump 标签（重复 group 允许，读侧去重）
  appendScreenshot(id, data);  // single-html：追加 ask-image 标签；directory：base64 解码落盘 baseDir/screenshots/<id>.png
  finalize();                  // 原子发布：读现文件、按 group 去重保最新合并 → 全量写 <outPath>.tmp → rename
                               // directory 模式在 dump 标签补 data-screenshot-mode="directory"，并插入 <base href="./">
}
export function loadShell(distDir);
// 优先读 distDir/index.html，把本地 <script src> 与 <link rel=stylesheet> 内联为内联内容（构建产物单文件化）；
// 文件不存在 → 返回内置最小兜底壳（<!doctype html>… <div id="root">报告壳未构建，仅数据可解析</div></body>）。
// 内联只允许 dist 目录内的资源（越界路径保持原样不内联）——报告是会被分享的产物，
// dist 外的任意文件不得被读入。
export async function writeReport(runJson, { outPath, mode, shell, groupName, runDir, secrets });
// runDir：截图相对路径的解析基准（工作区模式下 runsDir 为绝对路径）；缺省用 cwd 推断。
// secrets：[{provider,key,value}] 列表，用于**全文兜底脱敏**——recorder 写 run.json 时
//   已做过全文扫描，但 CLI 的 `report/cli.js build` 路径没有：模型在**后续非 secret 任务**的
//   thought / assertion.reason 里回显密钥时会以明文进报告。传入则两条入口共享同一份保证。
```

### 5.2 `tools.js`

```js
export function extractDumps(html);            // → [{ groupId, dump }]（按 group 去重保最新，JSON.parse）
export function splitReport(html, outDir);     // 每 execution 一个 <executionId>.execution.json，返回写入路径数组
export function reportToMarkdown(dump);        // 标题=groupName；每 task 一节：状态/类型/耗时/thought/param/
                                               // locate 策略与缓存命中；断言、回滚、网络事件各一节
export function reportHtmlToMarkdown(html);    // extractDumps → 每 execution 一段 reportToMarkdown 拼接
```

### 5.3 `cli.js`（零依赖手写 argv，薄壳，逻辑全在 recorder/tools）

```
node report/cli.js build <run.json> [--out <file|dir>] [--assets] [--group-name <n>] [--shell <distDir>] [--secrets <secrets.json>]
// --secrets：[{provider,key,value}] 列表，用于全文兜底脱敏。run 含敏感步骤而未提供时，
//   CLI 会向 stderr 告警（模型在其它任务里回显的密钥将以明文进报告）。
node report/cli.js split <report.html> [--out <dir>]
node report/cli.js to-md <report.html|dump.json> [--out <file>]
```
- build：runJson → dump（redact）→ ReportWriter 产出单文件或 assets 版；缺省 out：`runs/report.html`。
- to-md：入参 `.json` 视为 dump 直接转换；`--out` 缺省打 stdout。
- 退出码：成功 0；用法错误/文件缺失 2（stderr 一行说明）。

### 5.4 C 的测试（node:test + os.mkdtemp 临时目录，禁污染项目目录）

recorder：buildDump 映射表逐项、redact（secret_get/sms_read 三处落点）、标签转义（含 `</script>` 与
中文）、增量 append×2 同 group → 文件含 2 个标签 → finalize 后 1 个且为最新、directory 模式落盘 PNG +
data-screenshot-mode + `<base>`、loadShell 兜底壳。
tools：extractDumps 去重保最新、split 产物可 JSON.parse、to-md 含关键小节。
cli：build/split/to-md 各一条 spawn 冒烟（node:child_process，走临时目录），错误用法退出码 2。
C 自建 `test/fixtures/run.sample.json`（§14.1 形状：≥5 步覆盖 tap+locate、key、assert、failed、secret_get）。

---

## 6. 验收口径（主代理评审用）

1. 三方签名/数据形状与本契约零偏差（偏差须在各自最终报告声明并说明理由）。
2. `node --check` 通过 A 的 4 个纯逻辑文件与 C 的 3 个 JS 文件；B 的 .vue/.js 静态自查（import 导出名、
   相对路径、props 对齐）通过。
3. `node --test` A、C 全绿。
4. 交叉缝合点：B 的 useDump 读 C 的标签格式；B 的 Player 调 A 的三模块；A 的 fixtures 与 C 的 buildDump
   产物形状一致（§2）。

---

## 7. 已批准偏差记录（§0 要求）

> §0 规定"任何一方不得擅改本文件的签名与数据形状；如实现中发现契约缺陷，在最终报告里记录偏差"。
> 本节即为该记录的落点——实现侧与契约侧的每一处已知差异都在此登记（日期 / 差异 / 理由）。

| 日期 | 偏差 | 理由 |
|---|---|---|
| 2026-11-24 | §4.1 `parseReportDocument` 实际返回 `{meta, executions, screenshots, assertions, networkTimeline, rollbacks}`，比契约多 3 个字段 | 断言与网络时间线是报告的**核心价值**（Midscene 风格回放），缺失则报告只剩截图流。多返字段为**超集**，不破坏契约消费方 |
| 2026-11-24 | §5.1 `writeReport` 新增 `runDir` 与 `secrets` 两个**可选**参数 | `runDir`：截图相对路径的解析基准（工作区模式下 runsDir 为绝对路径，按 cwd 推断会找错文件）；`secrets`：CLI 路径缺全文脱敏兜底，模型在后续任务回显密钥时会明文进报告。均为向后兼容的加法，原调用方式不受影响 |
| 2026-11-24 | §1 转义规定由 `</` 改为 `<` 全量转义；§2 status 映射由两态改为四态 + `[REDACTED]`→finished | 见 §1 / §2 正文的新说明——原规定**无法达成其声明的目标**（`<!--<script>` 仍会摧毁报告；成功的 secret_get 被显示为 failed） |

本计划（2026-11-25 评审修复）各 Task 对契约的**扩展**（均为向后兼容的加法，原形状消费方不受影响）：

| Task | 契约扩展 | 落点 |
|---|---|---|
| 14 | §2 assertions 项新增可选 `screenshotId`（判定输入截图，buildDump 把路径替换为 uuid）、`evidenceSource`、`nudges` | `src/recorder/index.js:addAssertion`、`report/recorder.js` |
| 14 | §1 `ask-image` dataURL MIME 按魔数判定 JPEG/PNG，不再硬编码 PNG | `report/recorder.js:toDataURL` |
| 20 | §2 type 词表登记 `test_account` 账号工具（26 契约工具） | `src/tools/vocab.js` |
| 17 | 动作后截图入档前按缓存树 password 节点遮罩（门面 `cachePeek`） | `src/device/index.js` |
| 11 | rollout 状态机删除，失败回退由 run-loop 降级链承担（CONTRACT-CORE §2.1 / DESIGN §5.0.6 同步） | `src/device/rollout.js` 删除 |
| 24 | 新增 `docs:drift` 守护：文档承诺（工具数/lint 规则数/底座版本/契约文件路径）对账代码消费者 | `scripts/check-doc-drift.mjs` |

> 登记原则：只登记**已实现且已验证**的偏差；登记项须给出可复核的理由。
