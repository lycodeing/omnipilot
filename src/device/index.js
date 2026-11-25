// 设备门面（契约 §1.1）：工具层只认 createDevice，不直接 import device 内部模块
import { writeFile } from 'node:fs/promises';
import { Adb } from './adb.js';
import * as screen from './screen.js';
import { truncateAtHierarchyEnd, parseXmlDump, flattenNodes, treeHash } from './uitree.js';
import { TreeCache } from './cache.js';
import { createLocator, matchSelector, inScreen, matchNodeSelector as matchNode } from './locate.js';

import * as action from './action.js';
import { Yadb, readTextAt } from './input.js';
import { withLocateRetry, StepRollout } from './rollout.js';
import * as state from './state.js';
import * as net from './net-profile.js';
import { screenSignature } from './png.js';

// uia2 退避预算（评审 #5/#6：时序常量命名成组，不再散落字面量）
import { createUia2 } from './uia2.js';
import { createTapEachRow } from './tap-each-row.js';
import { createDumpChannels } from './dump-channels.js';
import { createSizeProbe } from './size-probe.js';
import { assertSafePackage, assertSafeActivity } from './package-guard.js';

// exec 仅测试注入用；契约入口 createDevice 不暴露该参数
// waitReady 控制是否等待设备系统服务就绪（冷启动场景）；空 exec/测试注入时可传 false 跳过
// probeFile：模型家族坐标探测缓存路径（默认 cwd/.ask/family-probe.json；工作区模式下由 CLI 传全局路径）
export async function createDeviceWithExecutor({ serial, adbPath = process.env.ASK_ADB || 'adb', timeouts = {}, exec, waitReady = null, probeFile = null, uia2: uia2Inject = null } = {}) {
  const adb = new Adb({ serial, adbPath, timeouts, exec });
  await adb.ensureConnected().catch(() => {}); // 首连失败不阻塞，命令期仍有重连机会

  // 设备就绪等待（冷启动窗口）：默认在真实设备上启用；测试注入 exec 时默认跳过（避免等 60s）
  const shouldWait = waitReady === null ? !exec : Boolean(waitReady);
  let bootSize = null;
  if (shouldWait) {
    try {
      const r = await adb.waitForBoot({ timeoutMs: Number(process.env.ASK_BOOT_TIMEOUT_MS) || 60_000 });
      if (!r.ready) console.warn(`[warn] ${r.reason}`);
      if (r?.size) bootSize = r.size; // waitForBoot 已解析 wm size，seed 进尺寸探测缓存免重复往返
    } catch (e) {
      console.warn(`[warn] 等待设备就绪失败：${e?.message ?? e}`);
    }
  }

  // waitFor* 专用：matchSelector + 在屏过滤 + WebView 标记。
  // uni-app/WebView 壳会把未打开的页面预渲染进 accessibility 树（bounds 在屏内但不可见），
  // 不过滤会让 aiWaitFor 对"尚未到达的页面"误报 appeared；但**可见元素也可能报零面积
  // bounds**（实测首页导航栏 [0,0][0,0]），一律按 inScreen 过滤会永远匹配不到。
  // 故：零面积 = 几何未知 → 放行并标记 inWebView 交视觉确认；非零面积才做在屏过滤。
  async function matchOnScreen(flat, sel) {
    const m = matchSelector(flat, sel);
    if (!m?.node) return null;
    // getSize 自带会话级缓存（size-probe.js），命中时零开销——
    // 与原先直接读 sizeCache 的快速路径等价
    let size;
    try { size = await getSize(); } catch { return { ...m, inWebView: false }; }
    const b = m.node.bounds;
    const wv = flat.find((x) => /WebView/i.test(x.cls || ''));
    const zeroArea = !Array.isArray(b) || b[2] <= b[0] || b[3] <= b[1];
    // 零面积放行仅限 WebView 壳 App（其可见元素常报 [0,0][0,0]，且由视觉确认把关）；
    // 纯原生树里零面积 = 隐藏节点，保持严格过滤，避免 aiWaitFor 对隐藏元素误报。
    if (zeroArea && !wv) return null;
    if (!zeroArea && !inScreen(b, size)) return null;
    const inWebView = !!(wv && Array.isArray(wv.bounds)
      && (zeroArea || (Array.isArray(b)
        && b[0] >= wv.bounds[0] && b[1] >= wv.bounds[1]
        && b[2] <= wv.bounds[2] && b[3] <= wv.bounds[3])));
    return { ...m, inWebView };
  }

  const cache = new TreeCache();
  const vlmCache = new Map();
  const yadb = new Yadb(adb);
  // 注：原 pendingPreHash / lastActionChanged（"动作后画面是否变化"的懒校验）已删除——
  // 全仓零消费者（device.lastActionChanged getter 无人读），是死代码。

  // 屏幕尺寸探测（见 size-probe.js）：会话级缓存 + 负缓存冷却，状态随模块内聚。
  const getSize = createSizeProbe({ adb, bootSize });

  // /dev/tty dump 在新版 platform-tools 上 shell 通道 stdout 只有提示行，XML 须走 exec-out 通道；
  // exec-out 失败或返回不含 </hierarchy>（同为 shell 通道的病征）时回退 legacy shell（旧镜像/redroid 兼容）。
  // 通道粘性（性能）：旧实现每次 dump 都先试 exec-out、失败再回退 shell——在 exec-out 不可用的
  // 设备上每次 dump 付双倍成本（2.2s→4.4s+）。首次探测成功后记住通道，后续直走；失败再重置重探。
  // 第三级回退：文件形式 dump + cat。实测（API 30 x86 + uni-app 模态弹窗） tty 两通道全部
  // 返回无 hierarchy（UI busy / pipe 限制），文件形式稳定可用——没有它，弹窗态整个引擎失明。
  // 测试注入 exec 时跳过 uia2（单测走 legacy 路径保持确定性；真机不受影响）
  // uia2 注入缝（2026-11-04 评审：dumpXmlRaw 通道决策层是唯一零覆盖的关键分支，根因是
  // 注入 exec 就硬性 uia2=null）。显式传 uia2 stub 即可测通道决策（槽守卫/瞬态分类/busy
  // 重试），与 exec 注入的 adb stub 组合使用。
  const uia2 = uia2Inject ?? (exec ? null : createUia2({ adb, serial, log: (m) => console.warn('[uia2] ' + m) }));

  // UI 树抓取（通道策略见 dump-channels.js）：uia2 退避状态、粘性通道与
  // timeout 可用性探测随模块内聚，index.js 不再持有。
  const dumpXmlRaw = createDumpChannels({ adb, uia2 });
  // 最近一次成功 dump 的树 hash：scroll 等只做**变化检测**的场景用它当对比基线，
  // 免掉一次 38-55s 的慢 dump（动画不改 a11y 树，跨时间复用安全；换 App 的动作清空）
  let lastTreeHash = null;
  // budgetMs：本次 dump 的总预算（毫秒）。waitFor* 传入剩余预算，避免单次 dump
  // 远超调用方的"最多等 N 毫秒"契约。

  // timeoutMs：本次 dump 的预算上限（毫秒）。waitFor* 用它把"剩余预算"传下来——
  // 一次 fresh dump 可能耗时 4-155s（uia2 退避/重试路径），不设上限会让
  // waitForElement({timeoutMs:10000}) 实际跑 165s，超出调用方契约。
  async function dumpTree({ fresh = false, timeoutMs = null } = {}) {
    if (!fresh) {
      const hit = cache.peek();
      if (hit) {
        cache.recordHit();
        // cachedAt：缓存条目生成时刻，供调用方做新鲜度判定（popup 前台派生用）
        return { nodes: hit.nodes, hash: hit.hash, dumpMs: 0, fromCache: true, cachedAt: hit.ts };
      }
    }
    cache.recordMiss();
    const t0 = Date.now();
    const xml = await dumpXmlRaw(timeoutMs != null ? { budgetMs: timeoutMs } : undefined);
    const dumpMs = Date.now() - t0;
    cache.recordDump();
    const text = truncateAtHierarchyEnd(xml);
    const nodes = parseXmlDump(text);
    if (!nodes.length) throw new Error(`uiautomator dump 失败: ${text.trim().slice(0, 120)}`);
    const hash = treeHash(nodes);
    lastTreeHash = hash;
    cache.set({ nodes, hash });
    return { nodes, hash, dumpMs, fromCache: false };
  }

  function beforeAction() {
    cache.markDirty();   // 动作后强制下次 dump 取新树（缓存失效）
  }

  const locate = createLocator({ getTree: dumpTree, getSize, screencap: () => screen.screencap(adb, { timeoutMs: adb.timeouts.screencap }), vlmCache, ...(probeFile ? { probeFile } : {}) });

  // 逐行作答状态机（从本文件抽出，见 tap-each-row.js）
  const tapEachRowImpl = createTapEachRow({
    adb,
    dumpTree,
    getSize,
    screencap: () => device.screencap(),
    scroll: (dir, o) => device.scroll(dir, o),
  });

  const device = {
    serial: serial ?? null, // RunRecorder 落 run.json 的 device.serial（§14.1）
    // —— 感知 ——
    async screencap() {
      const buffer = await screen.screencap(adb, { timeoutMs: adb.timeouts.screencap });
      // size 探测失败不阻断截图（冷启动期 wm size 可能未就绪）；size 为 null 时调用方自行降级
      let size = null;
      try { size = await getSize(); } catch { size = null; }
      return { buffer, size };
    },
    dumpTree,
    locate,
    vlmCache, // 暴露 VLM 接地缓存：批量预取接地写入此 Map（键 tree.hash::target）
    async readText(selector) {
      try {
        const tree = await dumpTree();
        const flat = flattenNodes(tree.nodes);
        const m = matchSelector(flat, selector);
        if (m) return { ok: true, value: m.value, error: null };
        // 兜底（与 locate 策略链对齐）：text= 严格等值 MISS 时按包含匹配。
        // WebView 树的文本节点粒度随版本/渲染波动（"热度"↔"热度榜"），只查等值会假报"未匹配"。
        // 注意不能把 'text*=xx' 再喂回 matchSelector——parseTarget 不认识该前缀，会搜字面量。
        const s0 = String(selector);
        const mm = /^text=(.+?)(?:#index=\d+)?$/.exec(s0);
        if (mm) {
          const needle = mm[1];
          const n = flat.find((x) => String(x.text || '').includes(needle) || String(x.contentDesc || '').includes(needle));
          if (n) return { ok: true, value: n.text || n.contentDesc || '', error: null, strategy: 'contains-fallback' };
        }
        return { ok: false, value: null, error: `未匹配: ${selector}` };
      } catch (e) {
        return { ok: false, value: null, error: String(e?.message ?? e) };
      }
    },
    async screenDiffHash() {
      return (await dumpTree()).hash;
    },

    // —— 操作 ——（动作成功后一律 markDirty，§5.0.6 R1）
    async tap(bounds) {
      const t0 = Date.now();
      try {
        const xy = action.resolvePoint(bounds, await getSize());
        await action.tap(adb, xy);
        beforeAction();
        return { ok: true, latencyMs: Date.now() - t0, error: null };
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) };
      }
    },
    async longPress(bounds, durationMs = 800) {
      const t0 = Date.now();
      try {
        const xy = action.resolvePoint(bounds, await getSize());
        await action.longPress(adb, xy, durationMs);
        beforeAction();
        return { ok: true, latencyMs: Date.now() - t0, error: null };
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) };
      }
    },
    async inputText(bounds, text, { clear = true } = {}) {
      try {
        const xy = action.resolvePoint(bounds, await getSize());
        const want = String(text ?? '');
        let doClear = clear;
        if (doClear) {
          // 条件清空（性能）：聚焦 tap **之前**读定位阶段的缓存树（fresh）取输入框当前文本；
          // 已为空则跳过 keyboardClear（省一次设备侧 app_process JVM 冷启动 ~300-600ms）。
          // tap 会置脏缓存，故必须在 tap 前读；缓存不可用时保守清空（语义与旧实现一致）。
          const preTree = cache.peek();
          if (preTree) {
            const cur = readTextAt(flattenNodes(preTree.nodes), xy);
            if (cur === '') doClear = false;
          }
        }
        await action.tap(adb, xy); // 点击聚焦
        // 清空+输入合并为一条 adb shell（省一次 spawn+队列等待）；回读校验保留
        // （input text 对中文静默失败的防线，§5.4.5）
        if (doClear) await yadb.clearAndType(want);
        else await yadb.type(want);
        beforeAction();
        let tree = await dumpTree({ fresh: true }); // 回读校验强制用新树（§5.4.5）
        let readBack = readTextAt(flattenNodes(tree.nodes), xy);
        // ASCII 降级（评审 #16）：yadb 依赖设备 ABI/app_process，vendor 二进制与设备 ABI
        // 不符时 inputText 全挂且无替代路径。纯 ASCII 可走原生 `input text` 重试一次
        //（空格 %s、shell 元字符转义）；非 ASCII 不降级（input text 对中文静默失败，§5.4.5）。
        let usedFallback = false;
        if (readBack !== want && /^[\x20-\x7E]+$/.test(want)) {
          // 转义集贴合 AOSP `input text` 的真实协议（Input.sendText 的 escapeFlag 机制）：
          //   - 空格 → `%s`（设备端 %s 解码为空格）
          //   - 字面 `%`：AOSP **不支持**转义它——% 后跟 's' 才被吞成空格，其它情况
          //     % 与后一字符都保留。故 "%%" 会解成两个 %（更糟），反斜杠转义则设备端
          //     原样送出（多出反斜杠）。正确做法是**原样保留**，让回读校验发现不符
          //     并如实报错——这是平台限制，不是可修的 bug。
          //     （主路径 yadb 无此限制，仅 vendor 二进制 ABI 不符时的降级路径受影响）
          //   - 其余 shell 元字符用单引号包裹（引号内 shell 不做展开）
          const arg = want.replace(/ /g, '%s');
          const quoted = `'${arg.replace(/'/g, `'\\''`)}'`;
          await adb.shell(`input text ${quoted}`).catch(() => {});
          usedFallback = true;
          beforeAction();
          tree = await dumpTree({ fresh: true });
          readBack = readTextAt(flattenNodes(tree.nodes), xy);
        }
        const ok = readBack === want;
        const res = {
          ok,
          readBack,
          error: ok ? null : readBack == null ? '回读失败：未在输入位置找到节点' : `回读不一致: 期望「${text}」实际「${readBack}」`,
          ...(usedFallback ? { strategy: 'input-text-fallback' } : {}),
        };
        return res;
      } catch (e) {
        return { ok: false, readBack: null, error: String(e?.message ?? e) };
      }
    },
    async swipe(from, to, { durationMs = 300 } = {}) {
      const t0 = Date.now();
      try {
        const size = await getSize();
        const p1 = action.resolvePoint(from, size);
        const p2 = action.resolvePoint(to, size);
        await action.swipe(adb, p1, p2, durationMs);
        beforeAction();
        return { ok: true, latencyMs: Date.now() - t0, error: null };
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) };
      }
    },
    // 无变化判定用树 hash（禁止截图 hash，§5.0.1）
    // 形状严守契约 §1.1 { scrolls, changed }；getSize 失败时抛出，由工具层转 ok:false
    // distancePct（§2.4）：按屏高百分比滚动（整屏≈100），替代固定的 0.6 屏
    // direction 为**内容语义**（与工具 schema/用例/模型直觉一致）：down=看更多下方内容（前进），
    // up=回看上方内容；映射到手指滑动时方向相反（前进=手指上滑 bottom→top）。
    async scroll(direction, { max = 5, stopWhenNoChange = true, distancePct = null } = {}) {
      const size = await getSize();
      const useDist = distancePct != null;
      const moves = { down: ['bottom', 'top'], up: ['top', 'bottom'], right: ['right', 'left'], left: ['left', 'right'] };
      // 非法 direction 统一兜底 down（内容语义），两条路径（regionPoint/distancePct）必须一致
      const dirKey = String(direction ?? 'down').toLowerCase();
      const dir = moves[dirKey] ? dirKey : 'down';
      const [fromRegion, toRegion] = moves[dir];
      // 变化检测：**像素签名快通道 + 树 hash 兜底**（2026-11-02 性能修复）。
      // 动机：整树 dump 在 busy WebView 上要 4-30s（uia2）/ 38-55s（legacy），实测 scroll
      // 因此 170s/次，把 uia2 省下的取树时间全吃掉；截图+解码+采样实测 0.5-1s（解码 116-141ms、
      // 采样 1-2ms），快 1-2 个数量级。
      // 但不能只用签名：实测该 App 的 WebView 会**停止出帧**（screencap 连续返回逐字节相同的
      // 陈旧画面）而 a11y 树仍在更新——此时签名恒等，单靠它会误判"到底"并提前中断。
      // 所以签名只作**单向判据**：签名变了 ⇒ 一定变了（不问树）；签名没变 ⇒ 必须树确认。
      //
      // 关键：树基线用 lastTreeHash（上一次 dumpTree 的结果，即 swipe **前**的状态）——
      // 不能用"降级后现取"（那时已经 swipe 过，本轮变化会被算到下一轮，max=1 的调用方
      // （scrollUntil / tapEachRow 转向）会因此误判"到底"）。lastTreeHash 缺失才补一次 dump。
      const sig = async () => {
        try {
          const { buffer } = await this.screencap();
          return screenSignature(buffer);
        } catch {
          return null; // 截图失败：走树 hash 判定
        }
      };
      const hashNow = async () => (await dumpTree({ fresh: true })).hash;
      let prevSig = await sig();
      // 树基线：优先复用跨调用基线 lastTreeHash（0 dump，调用方通常刚 dump 过）。
      // 没有基线时必须**在首次 swipe 之前**补一次——否则"签名没变"无法证明"没动"，
      // 会把真实滚动误报成到底（scrollUntil / tapEachRow 转向都用 max=1）。
      let prevHash = lastTreeHash ?? (await hashNow());
      let scrolls = 0;
      let changed = false;
      while (scrolls < max) {
        if (useDist) {
          // scrollDistancePoints 吃手指方向：内容语义取反后传入
          const finger = { down: 'up', up: 'down', left: 'right', right: 'left' }[dir] ?? 'up';
          const [p1, p2] = action.scrollDistancePoints(finger, size, distancePct);
          await action.swipe(adb, p1, p2, 300);
        } else {
          await action.swipe(adb, action.regionPoint(fromRegion, size), action.regionPoint(toRegion, size), 300);
        }
        beforeAction();
        scrolls++;
        const curSig = await sig();
        // ① 快通道：签名变了 ⇒ 有变化。树基线随之失效（当前树未取，置 null 等下次确认时重建）
        if (curSig && prevSig && curSig !== prevSig) {
          changed = true;
          prevSig = curSig;
          prevHash = null;
          continue;
        }
        // ② 签名不变/不可用（冻帧或截图失败）：树 hash 判定。
        // 基线可能已被快通道轮置 null（签名变化即清空）——此时无法证伪"没动"，保守按
        // moved=true 处理（2026-11-04 评审实证：判 false 会让冻帧切换点跳过树确认误判
        // "到底"，帧=[变,冻,冻]+树逐轮变 → 第 2 轮 break）。代价仅一轮多滚，下一轮起
        // 基线恢复，比较恢复正常。
        const curHash = await hashNow();
        const moved = prevHash == null ? true : curHash !== prevHash;
        prevHash = curHash; // 无论是否 moved 都推进基线（下轮与当前状态比）
        prevSig = curSig;
        if (moved) {
          changed = true;
        } else if (stopWhenNoChange) {
          break;
        }
      }
      return { scrolls, changed };
    },
    // 小步滚动直到 selector 在屏可见（内容语义 direction，默认 down 前进）。
    // WebView fling 惯性大：单次大距离 swipe 会过冲整段（实测 70% 屏 swipe 越过特征段），
    // 定量距离不可靠；小步（30% 屏）+ 每步树检可见才停，天然抗过冲。
    async scrollUntil(selector, { direction = 'down', max = 12, distancePct = 30 } = {}) {
      const result = { scrolls: 0, found: false, changed: false, error: null };
      if (!selector) { result.error = 'scrollUntil 需要 selector'; return result; }
      const size = await getSize().catch(() => null);
      const inScr = (n) => !size || (n.center[0] >= 0 && n.center[0] <= size.w && n.center[1] >= 0 && n.center[1] <= size.h);
      const areaOk = (n) => Array.isArray(n.bounds) && n.bounds.length === 4 && n.bounds[2] - n.bounds[0] > 0 && n.bounds[3] - n.bounds[1] > 0;
      for (let i = 0; i < max; i++) {
        let flat = [];
        try { flat = flattenNodes((await dumpTree({ fresh: true })).nodes); } catch (e) { result.error = `dump 失败: ${e?.message ?? e}`; return result; }
        // 任一匹配节点在屏即算可见（隐藏预渲染层零面积节点排除）
        if (flat.some((n) => matchNode(n, selector) && areaOk(n) && inScr(n))) { result.found = true; return result; }
        const sr = await this.scroll(direction, { max: 1, stopWhenNoChange: true, distancePct });
        result.scrolls++;
        result.changed = result.changed || sr.changed;
        if (!sr.changed) return result; // 到底仍未见 → found=false 由调用方判定
      }
      return result;
    },
    // 逐行作用域批量点击（引擎确定性，0 模型往返）：表单/问卷作答场景。App 无关：
    // 行/选项/终止标记全部由 selector 表达；选项带按邻行几何推导；选中色可配。
    // 关键事实（实测）：① WebView 选中态不进 a11y 树，adb tap 无回执；② 选中会触发
    // scroll-into-view，**tap 后整页滚动**，同轮内后续行的坐标立即失效（也是历史"点错行"根因）。
    // 因此每轮只 tap 一行：dump → 取文档序第一个未答行 → tap 其行内最左在屏选项 → 等渲染 →
    // 双信号验证（树 hash 变化=页面响应；或原坐标像素变为选中色）→ 记 answered；
    // 双信号皆无 = 渲染器挂死计数（连续 2 次报错退出，不再空转记假已答）。
    // verifyColor：'auto'（蓝色启发式）| '#RRGGBB' | [r,g,b]；verify=false 关闭像素校验。
    // 转向：无在屏可答行时按第一个未答行几何：选项在屏下 → down 前进；行与选项都在屏上 → up 回退。
    // stopWhen 可见**且**全文档无未答行才 done。零面积节点（隐藏预渲染层）一律排除。
    async tapEachRow(opts = {}) {
      return tapEachRowImpl(opts);
    },
    async key(name) {
      try {
        await action.key(adb, name);
        beforeAction();
        return { ok: true, error: null };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    async launch(appId) {
      try {
        const id = String(appId ?? '').trim();
        const [pkg, activity] = id.split('/');
        // 包名白名单：adb shell 走设备端 /bin/sh -c，未校验的包名可携带
        // "; rm -rf /sdcard" 之类的 shell 元字符。Android 包名只允许字母数字下划线点。
        assertSafePackage(pkg);
        if (activity) assertSafeActivity(activity);
        const out = await adb.shell(activity ? `am start -n ${pkg}/${activity}` : `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
        lastTreeHash = null; // 换 App/重启：旧树基线作废
        beforeAction();
        const bad = /error|exception|failure|no activities/i.test(out);
        return { ok: !bad, error: bad ? out.trim().slice(0, 200) : null };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    async terminate(packageName) {
      try {
        const pkg = String(packageName ?? '').trim();
        assertSafePackage(pkg);
        await adb.shell(`am force-stop ${pkg}`);
        lastTreeHash = null;
        beforeAction();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },

    // —— 环境 ——
    async foreground() {
      return state.foreground(adb);
    },
    async screenSize() {
      return getSize();
    },
    async processAlive(packageName) {
      return state.processAlive(adb, packageName);
    },
    // 等待画面稳定：连续 quiet 次 dump 的树 hash 相同即稳定。
    // quiet=2（默认，稳）＝ 需 2 次 dump（约 2.2s/dump → 4.6s）；quiet=1（快）＝ 1 次即返回（约 2.2s，但只是单次快照）。
    // intervalMs 默认 200ms（单次 dump 约 2.2s，间隔只占 8%，调小收益有限）。
    async waitIdle({ quiet = 2, intervalMs = 50, timeoutMs = 10000 } = {}) {
      const t0 = Date.now();
      let dumps = 0;
      let stableRun = 0;
      let prev = null;
      let stable = false;
      let failStreak = 0; // dump 连续失败退避（设备离线期避免每 intervalMs 白 spawn 一次 adb）
      while (Date.now() - t0 < timeoutMs) {
        // dump 失败（转场中/uiautomator idle 超时，§20.4 已知）当作"未稳定"继续等，
        // 不再让异常逃出（曾使整条用例在 aiWaitFor 步判 error 中断，VERIFICATION-OVERVIEW §7）
        let h = null;
        try {
          // 把剩余预算传给 dump：单次 fresh dump 可达 4-155s（uia2 退避/重试路径），
          // 不设上限会让 waitIdle({timeoutMs:10000}) 实测跑出 155s。
          const remain = timeoutMs - (Date.now() - t0);
          h = (await dumpTree({ fresh: true, timeoutMs: Math.max(1000, remain) })).hash; // 必须强制新树，缓存命中会使判定失真
        } catch { /* 未稳定，继续等 */ }
        dumps++;
        if (h !== null) {
          failStreak = 0;
          stableRun = prev !== null && h === prev ? stableRun + 1 : 1;
          prev = h;
          if (stableRun >= quiet) {
            stable = true;
            break;
          }
        } else {
          stableRun = 0;
          prev = null;
          failStreak++;
        }
        // 单次 dump 本身 ~2.2s，轮间 sleep 对静默判定无增益：默认 50ms；
        // dump 连续失败时退避 200→500ms，避免空转打设备
        const sleepMs = failStreak > 0 ? Math.min(500, 200 * failStreak) : intervalMs;
        await new Promise((r) => setTimeout(r, sleepMs));
      }
      return { stable, dumps };
    },
    // 等元素出现（§21）：比"等树不变"更语义、通常更快——每次 dump 后查目标是否已出现，出现即返回。
    // 返回 { appeared, dumps, matched: <文本> | null }。
    // selector 支持 'text=xx' | 'text*=xx' | 'resourceId=xx' | 'class=...#index=N'（同 readText 的匹配器）。
    async waitForElement(selector, { timeoutMs = 10000, intervalMs = 50 } = {}) {
      const sel = String(selector ?? '').trim();
      if (!sel) return { appeared: false, dumps: 0, matched: null, error: 'selector 为空' };
      // 首轮吃缓存（性能）：若调用前 4s 内刚 dump 过且无动作置脏，目标可能已在树上，
      // 白付一次 2.2s fresh dump 不值得；未命中再进入 fresh 轮询循环（语义不变）。
      let dumps = 0;
      const t0 = Date.now(); // 计时覆盖全程（含首轮 cacheable dump），守住 timeoutMs 契约
      try {
        const cachedTree = await dumpTree(); // cacheable
        dumps++;
        const m = await matchOnScreen(flattenNodes(cachedTree.nodes), sel);
        if (m?.node) return { appeared: true, dumps, matched: m.value || sel, inWebView: !!m.inWebView };
      } catch { /* 缓存不可用 → 进入 fresh 循环 */ }
      let failStreak = 0;
      while (Date.now() - t0 < timeoutMs) {
        let flat = [];
        try {
          // 剩余预算传给 dump：一次 fresh dump 可能耗时 4-155s（uia2 退避/重试路径），
          // 不设上限时 waitForElement({timeoutMs:10000}) 实际能跑 165s——超出调用方
          // 的"最多等 N 毫秒"契约，且会白耗 run 级超时预算。
          const remain = timeoutMs - (Date.now() - t0);
          const tree = await dumpTree({ fresh: true, timeoutMs: Math.max(1000, remain) }); // 强制新树（缓存命中会让"等待"失去意义）
          flat = flattenNodes(tree.nodes);
          failStreak = 0;
        } catch { failStreak++; /* dump 失败（转场中）→ 继续等 */ }
        dumps++;
        if (flat.length) {
          const m = await matchOnScreen(flat, sel);   // 返回 { node, value } | null
          if (m?.node) return { appeared: true, dumps, matched: m.value || sel, inWebView: !!m.inWebView };
        }
        // dump 之后重新检查 deadline：单次 dump 可能已超出预算，不该再睡一轮
        if (Date.now() - t0 >= timeoutMs) break;
        const sleepMs = failStreak > 0 ? Math.min(500, 200 * failStreak) : intervalMs;
        await new Promise((r) => setTimeout(r, sleepMs));
      }
      return { appeared: false, dumps, matched: null };
    },
    // 等任一元素出现（多 selector，命中其一即返回）
    async waitForAnyElement(selectors, { timeoutMs = 10000, intervalMs = 50 } = {}) {
      const sels = (Array.isArray(selectors) ? selectors : [selectors]).map((s) => String(s ?? '').trim()).filter(Boolean);
      if (!sels.length) return { appeared: false, dumps: 0, matched: null, error: 'selectors 为空' };
      // 首轮吃缓存（同 waitForElement）
      let dumps = 0;
      const t0 = Date.now(); // 计时覆盖全程（含首轮 cacheable dump）
      try {
        const cachedTree = await dumpTree();
        dumps++;
        const flat = flattenNodes(cachedTree.nodes);
        for (const sel of sels) {
          const m = await matchOnScreen(flat, sel);
          if (m?.node) return { appeared: true, dumps, matched: `${sel} → ${m.value || ''}`, inWebView: !!m.inWebView };
        }
      } catch { /* 缓存不可用 → fresh 循环 */ }
      let failStreak = 0;
      while (Date.now() - t0 < timeoutMs) {
        let flat = [];
        try {
          // 同 waitForElement：把剩余预算传给 dump —— 一次 fresh dump 可能耗时
          // 4-155s（uia2 退避/重试路径），不设上限会让"最多等 N 毫秒"被突破。
          const remain = timeoutMs - (Date.now() - t0);
          const tree = await dumpTree({ fresh: true, timeoutMs: Math.max(1000, remain) });
          flat = flattenNodes(tree.nodes);
          failStreak = 0;
        } catch { failStreak++; /* 继续等 */ }
        dumps++;
        if (flat.length) {
          for (const sel of sels) {
            const m = await matchOnScreen(flat, sel);   // { node, value } | null
            if (m?.node) return { appeared: true, dumps, matched: `${sel} → ${m.value || ''}`, inWebView: !!m.inWebView };
          }
        }
        // dump 之后重新检查 deadline：单次 dump 可能已超出预算，不该再睡一轮
        if (Date.now() - t0 >= timeoutMs) break;
        const sleepMs = failStreak > 0 ? Math.min(500, 200 * failStreak) : intervalMs;
        await new Promise((r) => setTimeout(r, sleepMs));
      }
      return { appeared: false, dumps, matched: null };
    },
    async assertNoCrash(expectedPackage) {
      return state.assertNoCrash(adb, expectedPackage);
    },
    async netSetProfile(name) {
      const r = await net.setNetProfile(adb, name);
      if (r.ok) beforeAction();
      return r;
    },
    async netStatus() {
      return net.netStatus(adb);
    },

    // —— 缓存与取证 ——
    markDirty() {
      cache.markDirty();
    },
    invalidateCache() {
      cache.invalidate();
      vlmCache.clear();
    },
    cacheStats() {
      return cache.stats();
    },
    async dumpToFile(path) {
      const xml = await dumpXmlRaw();
      const text = truncateAtHierarchyEnd(xml);
      if (!text.includes('</hierarchy>')) {
        // 取证文件不能静默落非 XML 内容（评审 Minor：失败 dump 落盘提示行会误导取证）
        throw new Error(`uiautomator dump 未返回 XML: ${text.trim().slice(0, 120)}`);
      }
      await writeFile(path, text, 'utf8');
      return path;
    },
    // 释放 uia2 资源：设备端会话（DELETE /wd/hub/session/:id）+ host 侧 adb forward。
    // 不释放会占住 Android 11 独占的 UiAutomation 注册槽，使 legacy dump 通道以
    // rc=137 死掉（本模块依赖的兜底路径）；adb forward 也会在 host 侧累积绑定。
    async close() {
      if (uia2 && typeof uia2.dispose === 'function') {
        await uia2.dispose().catch(() => {});
      }
    },

    // —— 附加（非契约方法，B 可选用；不影响 §1.1 既定签名） ——
    // preflight 用（§2.7）：读包信息 / 授予权限；失败返回 ''/ok:false，不抛错
    async dumpsysPackage(pkg) {
      try {
        return await adb.shell(`dumpsys package ${String(pkg).trim()}`, { timeoutMs: adb.timeouts.command });
      } catch { return ''; }
    },
    async pmGrant(permission, pkg) {
      try {
        const { stdout, stderr } = await adb.shell(`pm grant ${pkg} ${permission}`, { timeoutMs: adb.timeouts.command, withStderr: true });
        const bad = /error|exception|not found|unknown|inaccessible/i.test(`${stdout}\n${stderr}`);
        return { ok: !bad, error: bad ? `${stdout}\n${stderr}`.trim().slice(0, 200) : null };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    // getprop 读取（L2 设备事实采集用，bin/ask.js）：失败返回 '' 不抛错，调用方自行降级
    async getProp(name) {
      try {
        const out = await adb.shell(`getprop ${String(name).trim()}`, { timeoutMs: adb.timeouts.command });
        return String(out).trim();
      } catch {
        return '';
      }
    },
    // 一次 shell 读多个属性（性能）：旧实现每个属性各 spawn 一次 adb（设备事实采集
    // 曾 4 次串行 adb 调用）。失败返回空串不抛错。
    //
    // 必须用分隔符而非按行拆：getprop 对**不存在的属性**会输出空行，按行拆会让
    // 后续所有属性值整体前移一位（ro.product.model 丢失、被空行顶替）——
    // 这是数据静默损坏，且会污染整轮运行的提示词（设备事实每次 run 都读）。
    async getProps(names) {
      const list = (Array.isArray(names) ? names : [names]).map((n) => String(n).trim());
      if (!list.length) return [];
      const SEP = '__ASK_SEP__';
      try {
        const out = await adb.shell(list.map((n) => `getprop ${n}`).join(`; echo ${SEP}; `), { timeoutMs: adb.timeouts.command });
        // 末尾多一个分隔符，便于切分最后一段
        const parts = String(out).split(SEP);
        return list.map((_, i) => String(parts[i] ?? '').trim());
      } catch {
        return list.map(() => '');
      }
    },
    rollout: {
      withRetry: (opts) => withLocateRetry({ device, ...opts }),
      createStepRollout: (opts) => new StepRollout(device, opts),
    },
  };

  return device;
}

export async function createDevice({ serial, adbPath = process.env.ASK_ADB || 'adb', timeouts, probeFile = null } = {}) {
  // probeFile 必须转发：CLI 传入的是全局探测缓存路径（<ASK_HOME>/.ask/family-probe.json），
  // 而 locate 的默认是 cwd/.ask/…——不转发则工作区模式下探测结果永远读不到，
  // VLM 定位在未指定 family 时必然失败。
  return createDeviceWithExecutor({ serial, adbPath, timeouts, probeFile });
}
