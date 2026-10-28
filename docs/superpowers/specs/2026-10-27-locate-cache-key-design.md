# 工具能力增强 + 状态回滚 + 缓存键修复（设计文档 · 待复核）

> 日期：2026-10-27 · 状态：**决策已按建议固化（§7），待用户复核**
> 关联：VERIFICATION-REPORT §12（缓存命中率 3%）、CONTRACT-CORE §1.5、DESIGN §5.0.5 / §14.2.1
>
> 本文覆盖三件事（按实施顺序）：
> 1. **状态回滚**（§2.6）——中途失败必须还原设备状态（用户提出）+ 连带发现的缺陷 #14
> 2. **工具能力增强**（§2.4）——让 agent 理解"滚一屏/到底/滚到元素可见"等自然语言（用户提出）
> 3. **缓存键修复**（§2.5）——命中率 3% → 用「用例步骤身份」做键（用户提出）

## 0. 设计前提（本方案的定位，先看这节）

**用户只写自然语言；YAML 是 AI 生成的中间产物；具体调用哪个工具由 agent 自适应。**

这决定了本方案的性质：

| 层 | 谁产出 | 谁消费 | 本方案是否要动 |
|---|---|---|---|
| **自然语言任务** | **人**（用户手写） | agent（`ask do` / `ask run`） | 不动（用户视角不变） |
| **YAML 用例** | **AI 生成**（把 NL 固化为可复现用例） | `ask run` | 语法可简化，但**不是给人写的** |
| **工具调用** | **agent 自适应** | device 层 | **本方案的核心——增强工具能力，让 agent 能理解 NL** |

**含义（重要）**：
- 用户写「往下滚一屏」「滚到最后」这类**自然语言**，agent 要能自己翻译成正确的工具调用。
- 因此**重点不是发明新 YAML 语法**，而是**让工具能力足够表达这些语义** + **工具描述写清楚**（工具描述就是 agent 的知识来源）。
- YAML 语法只需**能忠实记录** agent 实际做了什么（供复现/报告），**不需要给人类提供完整 DSL**。

**修订说明**：本文档初稿在 §2.4 设计了一套给人类书写的 `aiScroll: {scrollType, distancePct}` DSL——
这与"用户只写 NL"的定位**不符**，已按此节重写为「工具能力增强 + 描述优化」角度。见 §2.4 修订版。

## 1. 问题

真机实测：175 次定位里 `strategy='cache'` 仅 **5 次（3%）**，缓存形同虚设。

初修（已实施）解决了**动作工具绕过缓存层**的问题（`tap`/`long_press`/`input`/`swipe` 原先直连 `device.locate`），
但**键方案本身仍有两个缺陷**：

### 缺陷 A：`pageId` 无区分度（实测坐实）

现有键 = `${pageId}:${target}`，`pageId` = 「前台 Activity + 包名」。但掘金是**单 Activity 架构**
（首页 / 热榜 / 发现 / 我 / 文章详情全叫 `MainActivity`）。实测 13 条缓存记录里 **12 条 pageId 完全相同**：

```json
{ "com.daimajia.gold/im.juejin.android.ui.MainActivity": 12,
  "com.daimajia.gold/im.juejin.android.modules.home.impl.ui.ArticleHistoryActivity": 1 }
```

→ 键前缀形同虚设，跨页面无法区分。

### 缺陷 B：键不含「步骤身份」，任务内重复定位无复用

同一个 target 在**同一用例内**出现多次时（实测 S2 里「我」被定位 14 次），
键是相同的、**理论上应命中**——但因为缺陷 A 导致同一 target 在不同页面的 bounds 混写进同一行，
R2 校验（`nodeAtBounds` 要求节点精确落在缓存 bounds + identity 全字段一致）经常对不上，于是回退 exact_text。

### 缺陷 C：无「任务（task）」维度

Midscene 的 `tasks: [{name, flow}]` 结构引入后，同名步骤在不同 task 里语义不同。
现键方案没有 task 维度，无法区分。

## 2. 方案：改用「用例步骤身份」做唯一键

**核心思路**（用户提出）：缓存键取**该次定位在用例里的身份**，而非运行时页面身份。

### 2.1 键的构造（修订版 · 评审 C1 修正）

**⚠️ 修订说明**：初稿的键含 `command`/`taskName` 段（`aiTap`/`tasks[].name`），但评审核实——
**当前解析器只产出 `do`/`ask`/`assert`/`net`/`sleep`，没有 `aiTap` 这类结构化命令**；
且一个 `do` 步骤是**整句自然语言**，内部可能调用多次定位。初稿的键**无法实现**，已重设计。

```
key = <caseId>::<stepIndex>::<locateOrdinal>::<target>
```

| 段 | 来源 | 运行时可得？ | 例 |
|---|---|---|---|
| `caseId` | 用例文件名（不含扩展名） | ✅ 装载时已知 | `s2-profile` |
| `stepIndex` | 步骤序号（0 基） | ✅ `ctx.currentStepIndex` 已有 | `3` |
| `locateOrdinal` | **该步骤内第几次调用定位**（0 基） | ⚠️ 需新增计数器（见 §3.4） | `0` |
| `target` | 该次 `locate` 的目标文本 | ✅ 调用参数 | `热榜` |

示例键：
```
s2-profile::3::0::热榜          # 第 3 步内的第 0 次定位，目标"热榜"
s2-profile::7::1::阅读记录      # 第 7 步内的第 1 次定位
```

**为什么用 `locateOrdinal` 而不是 `command`**：
- 一个 `do: 点击热榜然后滚动到底部` 步骤内可能有多次定位，`stepIndex` 单独无法区分；
- 当前没有结构化 command 可依赖（评审 C1），`locateOrdinal` 是**运行时天然可得**的序号；
- 配合 `stepIndex`，二者**唯一定位一次定位调用**。

**局限（诚实记录）**：若模型重跑时步骤内的定位**顺序变化**，`locateOrdinal` 会错位。
缓解：由 **R2 校验兜底**（§2.5）——identity 不符即回退正常定位链，**不会误点**，只是退回一次 miss。
对确定性用例（`steps` 固定、模型决策稳定）该风险很小。

**未来增强**：若后续解析器支持结构化步骤（`aiTap:` 等），可在键中**追加** `command` 段
（`caseId::stepIndex::locateOrdinal::command::target`）——**不破坏现有键**（老行仍可读）。

### 2.2 哪些定位可缓存（修订版 · 评审 I3 修正）

**只有真正经过 `locate`/`locateWithCache` 的调用才能缓存**。评审核实实际经过缓存层的工具：

| 工具 | 可缓存 | 说明 |
|---|---|---|
| `tap` / `long_press` / `input` | ✅ 读+写 | 有 target，经 `locateWithCache` → **主收益场景** |
| `swipe` | ⚠️ 部分 | 仅当 from/to 是**元素描述**（区域名不走 locate） |
| `locate` | ✅ 读+写 | 定位工具本体 |
| `scroll` | 📊 只写不读 | 见 §2.3（不经 locate） |
| `data_extract`（ui/collection） | ❌ **不缓存** | 用 `findBySelector` **直接找节点**，不走 `locate`（评审 I3 核实），无 bounds+identity 可缓存 |
| `key` / `launch` / `terminate` / `screen` / `uitree` / `read` 等 | ❌ | 非定位类 |

> **初稿错误更正**：初稿列了 `aiQuery`/`aiKeyboardPress` 可缓存——前者实为 `data_extract`（不走 locate），
> 后者在当前工具集**不存在**（`key` 无 target）。已移除。

### 2.3 `scroll` 的缓存用途（专项说明）

**结论：只写不读**（记录，不复用为 hint）。

原因：`scroll` 是**纯方位式**操作——`device.scroll(direction)` 内部用 `regionPoint('bottom')/('top')` 把方位名
换算成屏幕坐标（依赖 `screenSize`），**不经过 `locate`**，因此没有"元素 target"可缓存，也就没有 hint 可复用。

**那为什么还要记录？** 三个明确用途：

1. **排查取证**：报告里能看到某步骤在那一刻的屏幕分辨率与滚动方位，复现问题时知道当时设备几何。
2. **采集边界分析**：`collection` 模式（边滚边抽）的采样质量与滚动次数相关——记录 `max`/`stopWhenNoChange` 的实际生效值，便于诊断"每屏只采 1 条"这类欠采样问题（VERIFICATION-REPORT §六 遇到过）。
3. **未来扩展锚点**：若后续实现**元素维度滚动**（如 `scroll: {target: "列表", direction: down}`），届时该行直接升级为可读缓存，键结构无需变。

**写入字段**：`direction` / `max` / `stopWhenNoChange` / `scrolls`（实际次数）/ `changed`（是否滚动生效）/ `screenSize`。
读取侧显式跳过（该行没有 `bounds`/`identity`，天然不会被 hint 逻辑命中）。

### 2.4 滚动能力：从「工具能力」角度增强（修订版）

**用户提出**：页面是否支持**上下滚动 / 回到顶部 / 去到底部**，以及**"滚动 1 个屏幕 / 0.75 个屏幕 / 滚动到某元素可见（显示在屏幕顶部）"**这类**自然语言**描述。

**按 §0 的定位**：用户不会写上面的 YAML，他会写这样的**自然语言**：

> - "把热榜往下滚一屏"
> - "翻到页面最底部"
> - "回到页面顶部"
> - "向下滚动，直到看到「加载完毕」"
> - "把第三条热榜滚动到屏幕最上面"

**所以本节的正确问题是**：agent 拿到这些自然语言时，**现有工具够不够它表达**？不够的话补什么？

#### 2.4.1 现状（代码核实）：工具能力不足，agent 无法忠实表达

`device.scroll(direction, {max, stopWhenNoChange})` 当前**只有四方位、固定距离**：

| 现状能力 | 实现 | 缺口 |
|---|---|---|
| `up`/`down`/`left`/`right` | `regionPoint()` 方位名 → 屏幕坐标 | 无元素维度 |
| 固定滚动距离 | `top`=20%、`bottom`=80% 屏高 → 实际滚 **0.6 屏** | **距离不可调** |
| 停止条件 | 树 hash 无变化即停 | 只能"滚到没变化"，不能"滚到元素可见" |

**用户的 5 句自然语言，agent 现在只能做到`模糊近似`：**
- "往下滚一屏" → 只能调 `scroll('down')`，**实际滚 0.6 屏**（差距 40%）
- "翻到最底部" → 只能 `scroll('down', {max: N})` **凭猜 N**，没有"到底即停"
- "回到顶部" → 同样靠猜 N
- "滚到「加载完毕」出现" → **做不到**（scroll 不感知元素）
- "把第三条滚到屏幕最上面" → **做不到**（无位置对齐概念）

→ **结论：不是语法问题，是工具能力问题。** agent 再聪明，工具表达不了就只能近似。

#### 2.4.2 方案：补工具能力（不设计人类 DSL）

只做两件事：**① 给 `scroll` 工具补参数**；**② 把工具描述写清楚**（描述就是 agent 的知识来源）。

**① 工具参数扩展**（`src/tools/action.js` 的 `scroll` 工具）

| 新增参数 | 取值 | 支持的自然语言 | 谁填 |
|---|---|---|---|
| `distancePct` | 数字（如 `75` = 0.75 屏） | "滚一屏 / 滚半屏 / 滚 0.75 屏" | agent 自适应 |
| `until` | `'edge'`（到底） / `'top'`（到顶） | "翻到最底部 / 回到顶部" | agent 自适应 |
| `target` + `position` | 元素描述 + `top`/`center`/`bottom` | "把某元素滚到屏幕最上面" | agent 自适应 |
| `maxScrolls` | 数字（默认 10） | 安全上限（防死循环） | agent 自适应 |

**关键**：这些参数**不是给人写的 DSL**，而是 agent 把自然语言翻译过来的**目标参数**。
用户永远只写 NL；YAML 里记录的是 agent 的翻译结果（供复现）。

**② 工具描述重写**（这是让 agent 能正确翻译的核心）

现在：
```
description: '按方向滚动，画面无变化（树 hash 判定）即停。'
```

改为（把能力"教"给 agent）：
```
description: '滚动页面。direction=up/down 方向；distancePct 指定滚动距离（整屏=100，
  半屏=50）；until=edge 滚到边界即停（到底/到顶）；给 target 时滚动到该元素可见，
  position 指定元素最终停在屏幕的 top/center/bottom。配合 aiWaitFor 可实现"滚到某条件出现"。'
```

→ **agent 读到这个描述，就知道怎么把"滚到最后"翻译成 `until: 'edge'`。**

#### 2.4.3 自然语言 → 工具参数的翻译示例

| 用户自然语言 | agent 翻译为 |
|---|---|
| 往下滚一屏 | `scroll(direction='down', distancePct=100)` |
| 往下滚 0.75 屏 | `scroll(direction='down', distancePct=75)` |
| 回到页面顶部 | `scroll(until='top')` |
| 翻到最底部 | `scroll(until='edge')` |
| 把第三条热榜滚到屏幕最上面 | `scroll(target='热榜第三条', position='top', maxScrolls=10)` |
| 向下滚直到看到「加载完毕」 | `scroll(until='edge')` + `aiWaitFor('页面显示"加载完毕"')` |
| 滚动加载更多（不确定几屏） | `scroll(direction='down', maxScrolls=10)`（hash 不变即停） |

#### 2.4.4 实现映射（工具层）

| 参数 | 底层实现 | 改动量 |
|---|---|---|
| `distancePct` | 像素 = `screenSize.h × pct/100`；**边界钳制**在 `[0.05h, 0.95h]`（见下注） | 小 |
| `until: 'edge'` | 循环 `swipe` 直到树 hash 不变（复用现有 `stopWhenNoChange`） | 小：等价现有逻辑，只是语义命名 |
| `until: 'top'` | 反向同理 | 小 |
| `target` + `position` | 每滚一屏 → `locate(target)` → 命中且 `inScreen` → 按 `position` 补一次微调 swipe → 停 | **中**：`scroll` 内部接 `locate` |

> **`distancePct` 的边界问题**（评审核实）：`regionPoint` 的 `top`=0.2h / `bottom`=0.8h，
> 而 `swipe` 的起止点**必须落在屏幕内**。所以 `distancePct:100`（整屏）**不能**用 `y=h → y=0`；
> 需钳制到可用区间（如 `0.95h → 0.05h`，实际约 0.9 屏）。**文档与文档的用户预期需对齐**：
> "整屏"是**近似**（≈0.9 屏），或改用多次小步累积。建议**采用钳制**并在工具描述里说明是近似值。

**契约影响（修订 · 评审 I1 更正）**：⚠️ **初稿说"返回形状只增不改、向后兼容"是错的**——
`test/device-facade.test.js:166-169` 用 `assert.deepEqual(r1, { scrolls: 2, changed: true })`，
而 Node 的 `deepEqual` **对多余字段会失败**。所以：

- **`device.scroll` 的返回形状必须保持 `{scrolls, changed}` 不变**（不加字段）；
- 新增信息（如 `until` 命中、`finalBounds`）放在**工具层**返回，不进 `device.scroll` 的返回；
- 或若确需扩展，须**同步改该测试 + 在 CONTRACT-CORE §1.1 登记偏差**。

#### 2.4.5 与 lint 规则的关系

现有 `unreachable-scroll` 规则（`src/lint/rules.js:25-30`，level=**error**）拦自然语言
"直到最后/让所有…都显示"（理由：目标不可达 → 无限重试 → 烧 token）。

**引入工具能力后**，NL 的"滚到最后"**可达成**（agent 翻成 `until='edge'`）。规则调整取**较窄的豁免**方案（评审建议，比降级更安全）：

- **有显式停止条件时豁免**：`until` / `maxScrolls` 存在 → 该行不拦；
- 仍拦**真正不可达**的表述（如"让所有条目**同时**可见"——物理不可能）；
- 即：**从"一律拦"改为"有边界则放行"**，而非整条规则降级。

#### 2.4.6 YAML 里怎么记录（供复现，非给人写）

agent 执行后，YAML/报告里记录它实际用的参数：

```yaml
# 用户在对话里说："把热榜往下滚一屏，然后翻到底部"
# AI 生成的用例（供复现）：
steps:
  - ai: 把热榜往下滚一屏，然后翻到底部        # ← 保留原始 NL（可读、可再审）
  # ↓ 或固化为等价的结构化步骤（agent 翻译结果）
  - aiScroll: down
    distancePct: 100
  - aiScroll:
      until: edge
```

**两种形态都合法**：保留 `ai: <原始 NL>`（推荐，人可读）或固化成结构化步骤（更确定）。
由生成用例的 AI 决定用哪种——**用户不关心**。

### 2.5 缓存行形状（对齐 §14.2.1，修订版）

```jsonc
{
  "key": "s2-profile::3::0::热榜",   // 主键（§1.5）：caseId::stepIndex::locateOrdinal::target
  "caseId": "s2-profile",           // 便于按用例查询/清理
  "stepIndex": 3,
  "locateOrdinal": 0,               // 该步骤内第几次定位（评审 C1 修正：替代不存在的 command）
  "target": "热榜",
  "bounds": [148, 245, 296, 350],
  "identity": { "text": "热榜", "resourceId": "", "contentDesc": "", "cls": "android.widget.TextView", "clickable": false },
  "screenSize": { "w": 1080, "h": 2400 },   // ★ 用于失效判定，见下
  "hits": 3,
  "lastHitAt": 1793050000000
}
```

**去掉的字段**（与 DESIGN §14.2.1 旧约定对比，评审 Minor）：`strategy` / `pageId` / `invalidAt`。
- `pageId` 是旧键的组成，不再需要（键已含用例身份）
- `strategy` 可从 run.json 的 step 里查，缓存行不必重复存
- `invalidAt` 未实现过，本次也不引入

**`screenSize` 格式**：实际代码存的是 `{w,h}` 对象（`src/tools/locate-cache.js:47`），
而 DESIGN §14.2.1 旧文档写的是字符串 `"720x1280"`——**以代码为准**，更新文档对齐。

**不做 `appVersion`**：多数 App 热更新，版本号不能代表 UI 真实形态（用户指出）。改用**已有的 `screenSize` 作失效判据**——
分辨率变了（换设备/改 DPI/旋转）则坐标必然失效，此时缓存行直接判 miss。这是此前**存了却没用**的字段，正好补上校验。

**三重安全网**（键 → 尺寸 → identity）：
1. **键命中**：步骤身份匹配，找到候选行（快）
2. **尺寸一致**：`screenSize` 与当前设备相同，否则 miss（防跨设备误用）
3. **R2 校验**：`nodeAtBounds` + `sameIdentity` 全字段比对通过才复用（`locate.js:174-181`，不符即"弃用 hint 走正常链"）

第 3 层是既有机制，即使前两层都被绕过也不会误点——identity 不符时自动回退 `exact_text` 正常定位。

### 2.6 状态回滚：中途失败必须还原设备状态（用户提出）

**用户提出**：某个 case 执行到中间步骤把网络切成了 2g，此时**下一步骤报错导致 case 失败**——这一失败，
**网络就没法还原了**。

#### 2.6.1 核实：问题存在，且有**三条**泄漏路径（比用户描述的多两条）

核实 `bin/ask.js` 的 `runOne()`，当前网络恢复只有一处（步骤循环之后的 `await device.netSetProfile('off')`），
它**位于 try 体内、不在 finally 里**：

| # | 泄漏场景 | 当前行为 | 后果 |
|---|---|---|---|
| 1 | **步骤报错 → break** | catch 里 `status='error'; break`（`bin/ask.js:304-307`），**跳出循环后仍会执行**到 `netSetProfile('off')`（`:319`） | ✅ 这种**能**恢复（用户担心的这条实际是好的） |
| 2 | **`netSetProfile('off')` 之前抛错**（如 `recorder` 相关异常） | 直接跳出 try；finally（`:325-328`）里**只关 bridge/device，不恢复网络** | ❌ **网络留在 2g** |
| 3 | **进程被杀 / Ctrl+C / 超时强杀** | 信号处理缺失，finally 不执行 | ❌ **网络留在 2g** |
| 4 | **`netSetProfile('off')` 本身失败** | `.catch(() => {})` 静默吞掉 | ❌ 网络留在 2g，且**无任何提示** |

**用户描述的是路径 1（实际已覆盖），但路径 2/3/4 是真实漏洞**——尤其路径 3，
一次 Ctrl+C 就能把设备网络留在 2g，下个 case 在弱网下跑，产生难以排查的连锁失败。

#### 2.6.2 修复方案：把状态还原提升为「会话级资源管理」

核心思路：**凡是被改动过的"全局设备状态"，在 run 结束（无论成功/失败/中断）时一律还原**。

**① 网络还原移入 `finally`**

```js
// 现在（try 体内，路径2会跳过）
await device.netSetProfile('off').catch(() => {});

// 改为（finally 保证执行）
} finally {
  await restoreNetwork(device, ctx);   // ← 无条件还原
  try { await bridge?.close?.(); } catch { /* ignore */ }
  try { await device.close(); } catch { /* ignore */ }
}
```

**② 记录「已改动的状态」，按记录还原（修订 · 评审 I2 补充 `from` 来源与 `unknown` 处理）**

`ctx` 增加 `stateMutations` 数组。**`from` 的取值**（评审指出的漏洞）：

```js
// 切网前先读当前档位作为 from（一次读）
async function recordNetMutation(ctx, device, to) {
  const st = await device.netStatus().catch(() => ({ profile: null }));
  const rawFrom = st?.profile ?? null;
  // ★ 归一化：'unknown'/null（设备无 net 命令，实测本机如此）→ 视为 'off'
  const from = (rawFrom && rawFrom !== 'unknown') ? rawFrom : 'off';
  ctx.stateMutations.push({ kind: 'net', from, to, rawFrom, at: Date.now() });
}
```

`stateMutations` 条目形状（**明确约定**）：

```jsonc
{ "kind": "net", "from": "off", "to": "2g", "rawFrom": "unknown", "at": 1793050000000 }
```

- `from`：**归一化后的还原目标**（`unknown`→`off`，避免"还原到 unknown"这种无意义操作）
- `rawFrom`：原始读数（留证，便于诊断"设备到底支不支持 net"）
- **设备不支持 net 时**（`netSupported=false`）：`restoreNetwork` 直接跳过（无需还原，也避免假成功），只 warn 一次

**③ 还原失败要**报**，不能静默**

```js
// 现在：静默吞错
await device.netSetProfile('off').catch(() => {});

// 改为：失败则 warn + 记入报告的 rollbacks
try {
  const r = await restoreNetwork(device, ctx);
  if (r && r.ok === false) throw new Error(r.error || 'netSetProfile 返回失败');
}
catch (e) {
  console.error(`[warn] 网络还原失败：设备可能仍处于异常档位，需人工恢复（${e.message}）`);
  recorder.addRollback({ stepIndex: null, reason: '网络还原失败', recovered: false });
}
```

> 注：修复缺陷 #14 后，`netSetProfile` 的 `ok` 才可信，上述判定才有意义（**#14 必须先落地**）。

**④ 信号处理（修订 · 评审 I5：必须处理锁与资源清理）**

初稿的 `onSignal` 直接 `process.exit(130)`，会**绕过 `runOne` 的 finally 和 `cmdRun` 的锁释放**
（`bin/ask.js:162-164`），导致设备锁残留 10 分钟（`src/cli/lock.js:17` 的 `staleMs`）。
修订为：**注册在进程作用域**（非 `runOne` 内，避免多次累积）+ **完整清理后再退出**：

```js
// 在 bin/ask.js 进程级注册一次；ctx 指向当前活跃 run（运行期赋值）
let activeRunCtx = null;   // runOne 开始时赋值，结束时置 null
let cleaningUp = false;

async function onSignal(sig) {
  if (cleaningUp) return;          // 防重入（信号 + finally 双触发）
  cleaningUp = true;
  console.error(`\n收到 ${sig}，正在还原设备状态…`);
  try {
    if (activeRunCtx) await restoreNetwork(activeRunCtx.device, activeRunCtx).catch(() => {});
    await activeRunCtx?.bridge?.close?.().catch?.(() => {});
    await activeRunCtx?.device?.close?.().catch?.(() => {});
    if (activeRunCtx?.serial) releaseLock(WORKSPACE.lockRoot, activeRunCtx.serial);  // ★ 释放锁
  } finally {
    process.exit(130);
  }
}
process.once('SIGINT', () => onSignal('SIGINT'));
process.once('SIGTERM', () => onSignal('SIGTERM'));
```

> ⚠️ `SIGKILL`/`adb reboot` 无法拦截，这类情况靠 **⑤ 启动自检** 兜底。
> `cleaningUp` 标志同时防止"信号还原"与"finally 还原"重复执行。

**⑤ 启动自检（修订 · 评审 I6：需 gate 在 netSupported，且位置在 CLI）**

初稿的"`createDevice` 后检查档位"**在本机行不通**——`netStatus` 返回 `unknown`，
自动 `netSetProfile('off')` 又是假成功。修订为：

- **位置**：CLI 层（`runOne` 开始前 / `doctor`），不在 `createDevice`（设备层不该做业务决策）
- **前置条件**：仅当 `netSupported === true` 时才自检（复用 `src/cli/device-facts.js:10` 已有的探测）
- **行为**：档位非 `off` → warn + 自动恢复

```
[warn] 设备网络档位为 2g（上次 run 未还原？），已自动恢复为 off
```

设备不支持 net（本机情况）→ **完全跳过**，不产生噪音。

这条是"最后一道防线"——即使进程被 SIGKILL，下次启动也能纠正。

#### 2.6.3 哪些状态需要纳入回滚

不止网络。核实现有可改动全局设备状态的工具：

| 状态 | 改动工具 | 当前还原 | 应纳入 |
|---|---|---|---|
| 网络档位 | `net_profile` / `net:` 步骤 | ⚠️ 部分（见 §2.6.1） | ✅ P1 |
| 前台 App | `launch` / `terminate` | ❌ 无 | ⚠️ 可选（见下） |
| 输入框内容 | `input` | ❌ 无 | ❌ 不做（用例语义依赖） |
| 会话/登录态 | 用例操作 | ❌ 无 | ❌ 不做（App 数据，非设备状态） |

**关于前台 App**：切 App 后失败是否要"回到原 App"？我的判断是**不做自动还原**——
因为用例的意图就是"操作这个 App"，把它切回去反而破坏语义。**仅记录**当前前台包到报告即可。

**结论：本期只做「网络档位」的完整回滚**。其余状态按需评估。

#### 2.6.4 与「步骤级回滚」（§5.0.6 / rollout.js）的区别

工程里已有一个 `rollout.js`（步骤级回滚：定位失败 → 丢缓存重试）。**两者不是一回事**：

| | 步骤级回滚（已有） | 状态回滚（本节新增） |
|---|---|---|
| 作用域 | 单个步骤内 | 整个 run |
| 目标 | 让这一步能成功 | 让设备回到干净状态 |
| 触发 | 定位失败/动作无响应 | run 结束（成功/失败/中断） |
| 恢复什么 | 缓存、重试 | 设备全局状态（网络） |

→ 两者**互补**，不冲突。

#### 2.6.5 验证方式

- **单测**：mock device 让某步骤抛错 → 断言 `netSetProfile('off')` 仍被调用；让 `netSetProfile('off')` 失败 → 断言 warn + rollback 记录
- **真机**：`--timeout` 设小 → 中途超时 → 检查设备网络档位是否已恢复
- **真机 Ctrl+C**：跑一个先切 2g 的用例，中途 Ctrl+C → `net_status` 应为 off

#### 2.6.6 连带发现的真 bug（缺陷 #14）：`netSetProfile` 假成功

**在核实回滚逻辑时实测发现**：本机模拟器**没有 `net` 命令**，但 `netSetProfile('2g')` 却返回 `{ok: true}`。

```
$ adb shell "net 2g"
/system/bin/sh: net: inaccessible or not found     ← 错误在 stderr，exit 127
$ adb shell "net status"                           → stdout 为空
```

**根因**：`src/device/adb.js:142` 的 `shell()` **只返回 stdout**，而 shell 报错走 **stderr**：

```js
async shell(cmd, { timeoutMs } = {}) {
  const res = await this._enqueue(...);
  return typeof res.stdout === 'string' ? res.stdout : ...;   // ← stderr 被丢弃
}
```

于是 `net/profile.js` 里的判定失效：

```js
const out = await adb.shell(`net ${p}`);            // out = ''（错误在 stderr）
const bad = /error|failed|not found|no such/i.test(out);   // '' 匹配不到 → bad=false
return { ok: !bad, ... };                            // → ok:true ❌ 假成功
```

**影响**：
- `net_profile` 工具 / `net:` 步骤在这类设备上**假报成功**，用例会以为切网生效了
- 与本节回滚直接相关：假成功 → 回滚逻辑认为"已还原"，**掩盖问题**

**修复**：`setNetProfile` 判定改用**包含 stderr 的输出**（或让 `shell()` 支持返回 stderr）。
倾向**后者**——`shell()` 增加可选 `{ withStderr: true }` 返回 `{ stdout, stderr }`，
`net/profile.js` 用合并文本判定；不改变其他调用点的既有行为（向后兼容）。

**同类隐患**：`src/device/input.js:36` 的 `ls ${remote}`（判断 yadb 是否已推送）也依赖输出，
同样可能受 stderr 影响——修复时一并核查。

### 2.7 弹窗自适应：授权/定位等系统对话框不能打断用例（用户提出）

**用户提出**：执行过程中遇到**弹出框**（如"存储授权"、"定位授权"），希望**自适应处理，不能影响 case**。

#### 2.7.1 核实：当前零处理机制，且弹窗会直接打断用例

| 核实项 | 结果 |
|---|---|
| 代码里的弹窗/权限处理 | ❌ **完全没有**（grep `dialog`/`permission`/`授权` 无任何命中） |
| L1/L2 提示词里的指导 | ❌ **无**——L1 六条要点、失败处理均未提"意外弹窗" |
| 弹窗会不会打断用例 | ✅ **会**——设备上有 `com.google.android.permissioncontroller`（含 `GrantPermissionsActivity`）与 `com.google.android.packageinstaller` |

**实证**：真实 run 报告里已有弹窗/前台被抢占导致的失败记录：

```
run-20261027-040443 | 前台已离开 com.daimajia.gold（当前: com.google.android.apps.nexuslauncher/.NexusLauncherActivity）
```

`assert_no_crash` 的判定是 `fg.package === expectedPackage`（`src/device/state.js`），
**弹窗抢占前台 → 包名变了 → 断言直接判失败**。这就是"弹窗影响 case"的确切机制。

#### 2.7.2 方案：两层防御（预授权 + 运行时侦测）

**核心原则**：**能提前消除的弹窗就消除；不能消除的（运行时才弹）则侦测+自适应关闭**。

**第一层：预授权（preflight，根治）**

`pm grant` 在设备上**实测可用**（掘金已有多个权限是 `granted=true`）。在 run 开始前，
对目标包**预授予常见运行时权限**，把"会弹的框"提前消灭：

```bash
# run 前的 preflight（可选，默认开启；--no-pregrant 关闭）
adb shell pm grant com.daimajia.gold android.permission.CAMERA
adb shell pm grant com.daimajia.gold android.permission.READ_EXTERNAL_STORAGE
adb shell pm grant com.daimajia.gold android.permission.WRITE_EXTERNAL_STORAGE
adb shell pm grant com.daimajia.gold android.permission.POST_NOTIFICATIONS
# ...（按 dumpsys package 读到的 requested permissions 动态生成）
```

**关键设计**：
- **动态获取权限清单**：`dumpsys package <pkg>` 读 `requested permissions` → 逐一 `pm grant`
- **失败不阻断**：某些权限不可 grant（如特殊权限）→ warn 后继续
- **可关闭**：`--no-pregrant`（有些用例**故意测试授权流程**，预授权会破坏它）
- **记录到报告**：preflight 授予了哪些权限，写进 run.json（便于复现环境）

**第二层：运行时弹窗侦测 + 自适应（兜底）**

预授权不能覆盖所有弹窗（如"定位精度"选择、"更新提示"、"评分引导"、第三方 SDK 弹窗）。运行时侦测方案：

**侦测判据**（复用现有能力）：
1. `foreground()` 的包名**不属于**目标包，且**属于已知系统弹窗包**（`permissioncontroller` / `packageinstaller` / `systemui`）
2. 或 UI 树里出现弹窗特征文本（"允许"/"拒绝"/"同意"/"始终允许"/"仅在使用时允许"）

**处理动作**（自适应关闭）：
- 弹窗按钮按**优先级**匹配：`允许`/`同意`/`始终允许`/`仅在使用时允许` > `确定`/`知道了` > `拒绝`（尽量避免）
- 点击后 `wait_idle` → 确认回到目标包前台 → 继续原步骤
- **在哪个环节做**：**每次动作前**（`tap`/`input` 等写操作执行前）插入一次轻量检查

**第三层（可选，最轻）：把判据教给 agent**

L2 提示词加一段，让 agent 自己也会处理已知弹窗：

```
## 意外弹窗
操作中若前台包名变为 permissioncontroller/packageinstaller/systemui，
或屏幕出现"允许/同意/始终允许"等授权按钮：这是系统弹窗，**不是用例失败**。
优先点击"允许/同意/始终允许"，然后 wait_idle 继续原步骤；
无法判断时截图 + 报告，不要盲目点"拒绝"。
```

#### 2.7.3 分层职责（与 §0 定位一致）

| 层 | 做什么 | 为什么 |
|---|---|---|
| **引擎 preflight** | 预授权常见权限 | 根治，零模型开销 |
| **工具层侦测** | 动作前检查系统弹窗包 + 自动点"允许" | 兜底预授权覆盖不到的 |
| **agent（L2 提示词）** | 处理语义不明的自定义弹窗 | 系统弹窗之外的、需要判断的 |

三层从"确定性"到"智能"递进——**能用确定性解决的绝不用模型**（省 token、可复现）。

#### 2.7.4 与"不影响 case"的关系（设计约束）

用户强调"**不能影响 case**"，故：
- **弹窗处理不算一步**：不计入 run 的 steps、不产生断言（否则报告被弹窗噪音污染）
- **处理失败要可见**：若弹窗关不掉，记入 `rollbacks`（`recovered: false`）并 warn，**不要静默**
- **不改变用例语义**：弹窗处理只"恢复现场"，不代替用例本身的步骤
- **可观测**：run.json 的 `rollbacks` 里记录"第 N 步前遇到弹窗，已关闭"

#### 2.7.5 待确认问题

1. **预授权默认开还是关**？建议**默认开**（多数用例不想被弹窗打断），`--no-pregrant` 关闭。
2. **弹窗按钮的"拒绝"兜底**：全都不匹配时，选择"返回键关闭"还是"报告失败"？
   建议**按 back 键一次**（返回键能关掉多数系统弹窗），仍不行则报告。
3. **侦测频率**：每个动作前都查（开销小但频繁）还是仅在 `LOCATE_MISS`/前台异常时查（省开销但可能漏）？
   建议**动作前轻量查**（读一次 `foreground()`，约 100ms）——比 dump 树便宜。
4. **本项目场景是否需要**？若被测 App 无运行时权限弹窗（如纯 WebView 页面），可只做第二层。

### 2.8 实施顺序（已按建议固化）

1. **状态回滚**（§2.6）+ **缺陷 #14 修复**——可靠性刚需，防设备被污染/假成功
2. **弹窗自适应**（§2.7）——防用例被系统弹窗打断（用户提出）
3. **工具能力增强**（§2.4）——让 agent 理解滚动类自然语言
4. **缓存键切换**（§2.5）——提升复现速度
5. （可选）Midscene 命名对齐

---

## 3. 改动清单

**排序原则**（按 §0 定位）：先修**可靠性**（缺陷 #14 + 状态回滚），再补**工具能力**，最后改**缓存键**。

### 3.0 缺陷 #14 修复（P0 · 必须先落地，评审 C2 补充）

| 文件 | 改动 |
|---|---|
| `src/device/adb.js` | `shell()` 增加可选 `{ withStderr: true }` → 返回 `{ stdout, stderr }`（向后兼容：默认行为不变） |
| `src/net/profile.js` | `setNetProfile` 判定改用 **stdout+stderr 合并文本**（修复假成功） |
| `src/device/input.js` | 同类隐患核查：`ls ${remote}` 判断 yadb 是否推送，是否也受 stderr 影响 |
| 调用方影响 | `device.netSetProfile` 的 `ok` 语义变严谨；调用点 `src/tools/env.js:26`、`bin/ask.js:285`（`net:` 步骤，**当前忽略 `r.ok`，需一并处理**）、`bin/ask.js:319` |
| 测试 | 新增：shell 无 net 命令时 `netSetProfile` 应返回 `ok:false`（当前错误返回 true） |

### 3.1 状态回滚（P1，用户提出：中途失败必须还原）

| 文件 | 改动 |
|---|---|
| `bin/ask.js` | 网络还原移入 `finally`；新增 `restoreNetwork()`（按 `ctx.stateMutations` 回滚，`unknown`→`off`）；**进程级**注册 SIGINT/SIGTERM（含锁释放+资源清理，`cleaningUp` 防重入） |
| `bin/ask.js`（`net:` 步骤） | 切网前读 `netStatus` 记 `from`；push `stateMutations`；**检查 `r.ok`**（当前忽略） |
| `src/tools/env.js` | `net_profile` 同样 push `stateMutations` |
| `src/session/create.js` | `ctx` 增加 `stateMutations: []`、`currentStepKey`、`activeRunCtx` 相关字段 |
| `bin/ask.js`（run 开始 / `doctor`） | 启动自检：**仅当 `netSupported`** 时检查档位，非 off → warn + 恢复 |
| 测试 | 步骤抛错后仍还原；还原失败要 warn+记 rollback；信号触发还原并释放锁；启动自检（netSupported gate） |

### 3.2 弹窗自适应（P2，用户提出：不能影响 case）

| 文件 | 改动 |
|---|---|
| `src/device/popup.js`（**新增**） | 弹窗侦测与处理：`detectSystemDialog(device)`（查前台包是否系统弹窗包 + 弹窗特征文本）、`dismissDialog(device)`（按优先级点"允许/同意/确定"→ 兜底 back） |
| `src/device/index.js` | 门面暴露 `detectDialog()` / `dismissDialog()`（非契约附加方法，参照 `getProp` 先例） |
| `bin/ask.js` | **preflight**：run 前 `pm grant` 预授权（动态读 `dumpsys package` 的 requested permissions；`--no-pregrant` 关闭）；记入 run.json |
| `src/tools/action.js` | 写操作（tap/input/long_press/swipe）执行前插入轻量弹窗检查 |
| `prompts/system.android.md` | L2 增加"意外弹窗"段（教 agent 处理语义不明的自定义弹窗） |
| `src/report/recorder.js` | 弹窗处理记录进 `rollbacks`（`recovered` 标记）；**不计入 steps** |
| 测试 | 侦测判据（mock 前台包/树）、按钮优先级、preflight 授权清单解析、弹窗不计入 steps |

### 3.3 工具能力（P2，让 agent 理解自然语言）

| 文件 | 改动 |
|---|---|
| `src/tools/action.js` | `scroll` 工具参数扩 `distancePct` / `until` / `target` / `position` / `maxScrolls`；**重写 description**（把能力"教"给 agent） |
| `src/device/index.js` | `scroll()` 支持距离换算（**边界钳制**）+ `until` 边界语义 + `target` 元素对齐；⚠️ **返回形状必须保持 `{scrolls, changed}`**（评审 I1：`device-facade.test.js` 用 `deepEqual` 严格断言）；新信息放工具层 |
| `src/device/action.js` | 补距离换算辅助（`regionPoint` 已有，需加钳制） |
| `src/lint/rules.js` | `unreachable-scroll` 放宽：**有显式停止条件（`until`/`maxScrolls`）时豁免**（评审建议的较窄方案） |

### 3.4 缓存键（P3，让复现更快 · 评审 C1 已重设计）

| 文件 | 改动 |
|---|---|
| `src/tools/locate-cache.js` | 键从 `${pageId}:${target}` 改为 **`caseId::stepIndex::locateOrdinal::target`**；新增 `screenSize` 失效校验；`scroll` 行只写不读 |
| `bin/ask.js` | 运行期维护 **`locateOrdinal` 计数器**（每步骤重置）；传 `caseId`/`stepIndex` 给定位层；执行前查缓存、执行后回写 |
| `src/session/create.js` | `ctx` 增加 `currentStepKey`（含 caseId/stepIndex/locateOrdinal 的组装） |
| `src/tools/perception.js` · `action.js` | 从 `ctx` 取键（替代 `pageIdOf`） |
| 测试 | 键构造 + 尺寸失效 + 跨用例隔离 + **locateOrdinal 顺序变化时 R2 兜底不误点** |
| 文档 | CONTRACT-CORE §1.5、DESIGN §5.0.5/§14.2.1 |

> ⚠️ **P2 的前置条件**：键方案依赖 `locateOrdinal` 计数器（运行时可新增），**不依赖**结构化 command——
> 这一点已按评审 C1 修正。**若未来支持结构化步骤，可追加 `command` 段而不破坏现有键**。

### 3.5 不需要做的（初稿的过度设计，已砍）

| 砍掉的设计 | 原因 |
|---|---|
| 给人写的 DSL 完整文档 | 用户不写 YAML（§0），文档只需覆盖工具参数 |
| `tasks/flow` 嵌套作为**强制**结构 | 可支持（AI 生成时用），但不作为主要方向；`steps` 扁平结构够用 |
| `appVersion` 字段 | 热更新使其不可靠（用户指出） |
| 前台 App 自动还原 | 破坏用例语义（§2.6.3） |
| `data_extract` 纳入坐标缓存 | 评审 I3：它用 `findBySelector` 直接找节点，**不走 locate**，无 bounds/identity |

## 4. 与其他改动的关系（评审 C1 更正）

| 相关改动 | 关系 |
|---|---|
| Midscene 命名对齐（`aiTap`/`aiAssert` 等） | **弱耦合**：命名可改，但**新键方案不依赖它**（用 `locateOrdinal` 而非 `command`） |
| 缓存键切换 | 依赖 `stepIndex` + `locateOrdinal`——均可运行时提供，与解析器改造无关 |
| **缺陷 #14** | **强依赖前置**：不修则"还原成功"是假象（§2.6.6） |
| 工具描述优化 | **独立且优先**：改 description 即可让 agent 理解 NL，无破坏、收益直接 |

**实施顺序（已固化）**：
**P0 缺陷 #14 → P1 状态回滚 + 工具能力 → P2 缓存键 →（可选）命名对齐**

> 评审建议**拆成独立计划**：可靠性（P0+P1）与能力（工具）与缓存键（P2）是三个子系统，各自独立验收。
> 本文档作为**总设计**，实施时每阶段单独出计划。

## 5. 兼容与迁移

- **旧缓存作废**：键格式变了，旧 `locate_cache.jsonl` 的行不会被新代码命中。
  处理：启动时检测行形状，无 `caseId` 字段的旧行**忽略**（或提供 `ask data clear locate_cache` 清理提示）。
- **不破坏契约**：`store.upsert('locate_cache', 'key', ...)` 的主键仍是 `key` 字段，只是值换了构造方式。
- **失效判据用 `screenSize` 而非 `appVersion`**：App 多热更新，版本号不代表 UI 形态（用户指出）；
  分辨率变化（换设备/改 DPI/旋转）才是坐标失效的可靠信号。该字段此前已存但未校验，本次补上。

## 6. 预期收益

| 指标 | 现状 | 预期 |
|---|---|---|
| 缓存命中率 | 3% | 同用例重跑应大幅提升（步骤身份稳定 → 键稳定 → R2 易通过） |
| 跨页面误命中 | 有风险（pageId 无区分） | 消除（键含用例+step，语义唯一） |
| 跨设备误用 | 无防护 | 消除（screenSize 不一致即 miss） |
| 报告可读性 | 缓存行难溯源 | 行含 caseId/stepIndex/locateOrdinal，可定位到具体定位 |
| 滚动类步骤诊断 | 无记录 | 记录方向/次数/是否生效/当时分辨率（供欠采样排查） |
| **网络状态污染** | Ctrl+C/异常后可能留 2g | 消除（finally + 信号 + 启动自检） |
| **切网假成功** | `netSetProfile` 误报 ok | 消除（缺陷 #14 修复） |

## 7. 决策记录（已按建议固化，待你复核）

> 用户指示"先按你的建议来"。以下为固化决策，**复核时若有异议逐条改**。

### 7.1 定位与范围

| # | 决策 | 依据 |
|---|---|---|
| D1 | **重点是补工具能力 + 写清工具描述，不设计人类 DSL** | §0：用户只写 NL，YAML 由 AI 生成 |
| D2 | **实施顺序：P0 缺陷#14 → 状态回滚 → 工具能力 → 缓存键 →（可选）命名对齐** | §3：评审建议按子系统拆阶段 |
| D3 | **本期不含"NL→YAML 固化"能力**（单独评估） | 当前仓库无此能力，属新增功能，工作量独立 |

### 7.2 缺陷 #14（评审 C2 新增）

| # | 决策 | 说明 |
|---|---|---|
| D0 | **#14 必须先落地**（`adb.js` 出 stderr + `profile.js` 合并判定） | 不修则"还原成功"是假象 |

### 7.3 状态回滚（§2.6）

| # | 决策 | 说明 |
|---|---|---|
| D4 | **回滚范围只做网络档位** | 唯一影响后续 run 的全局设备状态；前台 App 不还原（破坏用例语义） |
| D5 | **启动自检自动恢复 + warn**，**gate 在 `netSupported`** | 评审 I6：本机无 net 命令，不 gate 会产生噪音+假成功 |
| D6 | **接受 SIGINT/SIGTERM 处理**（还原后退出） | 防 Ctrl+C 留下弱网态污染后续 run |
| D7 | 还原失败 **warn + 记入报告 rollbacks**（不静默） | 路径 4：可见即可排查 |
| D8 | 修复 **缺陷 #14**（`netSetProfile` 假成功） | §2.6.6：不修则回滚是"假还原" |
| **D8b** | **信号处理器必须释放设备锁 + 关资源**（评审 I5） | 否则锁残留 10 分钟 |
| **D8c** | `stateMutations.from` **归一化**（`unknown`→`off`） | 评审 I2：本机 netStatus 恒为 unknown |

### 7.4 弹窗自适应（§2.7，评审后新增）

| # | 决策 | 说明 |
|---|---|---|
| D17 | **两层防御**：preflight 预授权（根治）+ 运行时侦测（兜底） | 能用确定性解决就不惊动模型 |
| D18 | **修订（真机实测反转）**：预授权**默认关闭**，`--pregrant` 显式开启 | ⚠️ 真机发现：对掘金批量 `pm grant` 后 **App 启动即崩溃**（logcat `Application Error` / `Process has died`）；且 `pm grant` 会杀掉运行中的 App。默认启用会破坏用例，故改为 opt-in |
| D19 | 弹窗处理**不计入 run 的 steps** | 用户要求"不影响 case"，避免报告被噪音污染 |
| D20 | 处理失败记入 `rollbacks`（`recovered:false`）+ warn | 可见即可排查，不静默 |
| D21 | 弹窗按钮优先级：允许/同意 > 确定 > **兜底 back 键**（不点"拒绝"） | 避免误拒导致 App 功能缺失 |
| D22 | 侦测时机：**动作前轻量查**（读 `foreground()`，约 100ms） | 比 dump 树便宜，覆盖主要时机 |

### 7.5 工具能力（§2.4）

| # | 决策 | 说明 |
|---|---|---|
| D9 | **本期实现"滚动到元素可见"**（`target` + `position`） | 用户明确提出的真实需求 |
| D10 | `distancePct: 100` = **整屏高度**，**钳制到可用区间**（≈0.9 屏） | 评审 Minor：屏幕边缘不可点 |
| D11 | `scroll` 工具 **description 重写**（把能力教给 agent） | 工具描述是 agent 唯一知识来源 |
| D12 | `unreachable-scroll` **有停止条件时豁免**（非整条降级） | 评审建议的较窄方案更安全 |
| **D12b** | `device.scroll` 返回形状**保持 `{scrolls, changed}` 不变**（评审 I1） | 现有测试用 `deepEqual` 严格断言 |

### 7.6 缓存键（§2.5）

| # | 决策 | 说明 |
|---|---|---|
| D13 | `caseId` 用**用例文件名** | 稳定、与路径对应 |
| **D14** | 键 = `caseId::stepIndex::locateOrdinal::target`（**评审 C1 重设计**） | 用运行时可得的 `locateOrdinal` 替代不存在的 `command` |
| D15 | 旧缓存**自动忽略 + 首次提示一次** | 无破坏、可感知 |
| D16 | 失效判据用 **`screenSize`**（非 appVersion） | 热更新使版本号不可靠（用户指出） |

### 7.7 文档评审记录（2026-10-27）

本文档经独立评审子代理**逐条核对 14 组代码断言**，结论 **"With fixes"**：

- **断言核实**：14 组全部 ✅ 属实（含 `adb.js:142`、`locate.js:174-181`、`rules.js:25-30` 等行号级核对，
  以及 `netSetProfile` 假成功的独立复现）
- **2 个 Critical 已修**：
  - C1 缓存键依赖不存在的 `command`/`taskName` → **重设计为 `locateOrdinal`**（§2.1）
  - C2 改动清单漏了 #14 的落点文件 → **补 §3.0**（`adb.js` / `profile.js`）
- **7 个 Important 已修**：I1 返回形状非兼容 / I2 `from` 来源 / I3 `aiQuery` 不可缓存 / I4 交叉引用错误 /
  I5 信号泄漏锁 / I6 自检未 gate / I7 taskName 假设
- **评审建议**：拆成独立计划（可靠性 / 能力 / 缓存键各自验收）——已采纳（§3 分 P0–P2）

---

## 8. 实施计划（待你确认后执行）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | 缺陷 #14（§3.0） | 单测：无 net 命令时 `netSetProfile` 返回 `ok:false`（当前错返 true） |
| **P1** | 状态回滚（§3.1） | 单测：抛错后仍还原、还原失败有 warn、信号释放锁；真机：Ctrl+C 后档位为 off（本机无 net → 用 mock 断言） |
| **P2** | 弹窗自适应（§3.2） | 单测：侦测判据/按钮优先级/preflight 清单/不计入 steps；真机：触发权限弹窗 → 用例继续不中断 |
| **P3** | 工具能力（§3.3）：scroll 参数 + description | 真机：能"滚一屏/到底/滚到元素可见"；单测覆盖参数换算与钳制 |
| **P4** | 缓存键（§3.4） | 真机：同用例重跑命中率显著提升；单测覆盖键构造/尺寸失效/顺序变化的 R2 兜底 |

每阶段结束后：`node --test` 全绿 + lint strict 0 error + 相关真机验证。
**评审建议**：可靠性（P0+P1）/ 弹窗（P2）/ 能力（P3）/ 缓存（P4）分成独立计划，各自独立验收。
