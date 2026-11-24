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
import * as net from '../net/profile.js';
import { decodePng, pixelAt, isBlueish, isColorish, parseHexColor, screenSignature } from './png.js';
import { resolveTiming } from './profiles/index.js';
import { classifyTransportError } from './errors.js';

// uia2 退避预算（评审 #5/#6：时序常量命名成组，不再散落字面量）
const UIA2_BACKOFF = { transientMs: 5_000, fatalMs: 60_000 };
import { createUia2 } from './uia2.js';

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
      if (r?.size) bootSize = r.size; // waitForBoot 已解析 wm size，seed 进 sizeCache 免重复往返
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
    let size = sizeCache;
    if (!size) {
      try { size = await getSize(); } catch { return { ...m, inWebView: false }; }
    }
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
  let sizeCache = bootSize; // waitForBoot 已探测过 wm size 时直接复用（省一次往返）
  let sizeFailedAt = 0; // 上次探测失败的时刻（负缓存冷却，避免每个工具立刻重复撞墙）
  let pendingPreHash = null; // 懒校验（§5.4.3）：上次动作前的树 hash
  let lastActionChanged = null;

  const SIZE_RETRY = { attempts: 3, delayMs: 500, cooldownMs: 1500 };

  // 屏幕尺寸会话级缓存。冷启动期 wm size 可能未就绪：短退避重试；仍失败则记负缓存冷却，
  // 冷却期内的调用立刻失败（不再反复打设备），冷却过后允许重探（设备此时通常已就绪）。
  async function getSize() {
    if (sizeCache) return sizeCache;
    if (sizeFailedAt && Date.now() - sizeFailedAt < SIZE_RETRY.cooldownMs) {
      throw new screen.ScreenSizeError('设备未就绪：屏幕尺寸探测处于冷却期', { notReady: true });
    }
    let lastErr;
    for (let i = 0; i < SIZE_RETRY.attempts; i++) {
      try {
        sizeCache = await screen.readScreenSize(adb, { timeoutMs: adb.timeouts.command });
        sizeFailedAt = 0;
        return sizeCache;
      } catch (e) {
        lastErr = e;
        if (i < SIZE_RETRY.attempts - 1) await new Promise((r) => setTimeout(r, SIZE_RETRY.delayMs));
      }
    }
    sizeFailedAt = Date.now();
    throw lastErr;
  }

  // /dev/tty dump 在新版 platform-tools 上 shell 通道 stdout 只有提示行，XML 须走 exec-out 通道；
  // exec-out 失败或返回不含 </hierarchy>（同为 shell 通道的病征）时回退 legacy shell（旧镜像/redroid 兼容）。
  // 通道粘性（性能）：旧实现每次 dump 都先试 exec-out、失败再回退 shell——在 exec-out 不可用的
  // 设备上每次 dump 付双倍成本（2.2s→4.4s+）。首次探测成功后记住通道，后续直走；失败再重置重探。
  // 第三级回退：文件形式 dump + cat。实测（API 30 x86 + uni-app 模态弹窗） tty 两通道全部
  // 返回无 hierarchy（UI busy / pipe 限制），文件形式稳定可用——没有它，弹窗态整个引擎失明。
  let dumpChannel = null; // 'execout' | 'shell' | 'file' | null(未探测)
  // 测试注入 exec 时跳过 uia2（单测走 legacy 路径保持确定性；真机不受影响）
  // uia2 注入缝（2026-11-04 评审：dumpXmlRaw 通道决策层是唯一零覆盖的关键分支，根因是
  // 注入 exec 就硬性 uia2=null）。显式传 uia2 stub 即可测通道决策（槽守卫/瞬态分类/busy
  // 重试），与 exec 注入的 adb stub 组合使用。
  const uia2 = uia2Inject ?? (exec ? null : createUia2({ adb, serial, log: (m) => console.warn('[uia2] ' + m) }));
  let uia2DeadUntil = 0;
  let lastUia2Error = '';
  let lastUia2SlotFree = false; // 上次失败是否意味着"槽空闲、legacy 可走"（protocol/ensure 失败 → true）
  // 最近一次成功 dump 的树 hash：scroll 等只做**变化检测**的场景用它当对比基线，
  // 免掉一次 38-55s 的慢 dump（动画不改 a11y 树，跨时间复用安全；换 App 的动作清空）
  let lastTreeHash = null;
  let timeoutSupported = null; // 设备侧 timeout 可用性（null=未探测，false=降级无包裹）
  async function dumpXmlRaw() {
    // 两级策略（实测 busy 弹窗态成功 dump 需 38-39s——uiautomator idle 等待本身很长）：
    // ① tty 快通道：设备侧 timeout 10s 快速失败（健康屏 ~2s 出结果；busy 屏不留孤儿——
    //    客户端超时只杀 adb，设备侧 uiautomator 会变孤儿继续持有 a11y 锁，毒化后续尝试）；
    // ② file 耐久通道：设备侧 50s 等满 idle 等待，&& 串联 cat（dump 失败非零退出不会 cat
    //    陈旧文件）。粘性通道记住上次成功的形态，健康屏仍走快通道。
    // 通道 0：uia2 server（busy 态 157-958ms vs 38-55s，调研落地 2026-11-01）。
    // 失败退避后重试探测；期间走 legacy 三通道。lastTreeHash 基线在两通道间通用
    // （都是同一棵 a11y 树的 hash）。返回形状与 legacy 完全一致。
    //
    // 退避时长按错误类型区分（2026-11-02 实证）：uia2 source 超时是 busy 页的**瞬时抖动**
    // （服务端内部仍要等一次 a11y idle），而 legacy 三通道在同类 busy 页会全败。若超时也
    // 退避 60s，一次抖动就让整轮退化成"引擎全盲"，实测 run-20261102-125547 因此 8 断言全灭。
    // 传输类错误（超时/断连）只退避 5s（下一两次 dump 就回来），只有服务真的起不来才 60s。
    let uia2FailedTransiently = false; // （保留供退避分类）本轮 uia2 是否因超时/断连失败
    if (uia2 && Date.now() >= uia2DeadUntil) {
      try {
        const xml = await uia2.source();
        if (xml.includes('</hierarchy>')) return xml;
        throw new Error('uia2 无 hierarchy');
      } catch (e) {
        lastUia2Error = String(e?.message ?? e).slice(0, 100);
        // 传输类判定（评审 #6）：结构化 e.kind/e.code 优先（classifyTransportError），
        // message 正则仅兜底注入执行器/历史错误。e.status 非 undefined = HTTP 有应答
        // （服务活着），不是传输故障——与旧 `e?.status === undefined` 守卫语义一致。
        const kind = classifyTransportError(e);
        const transient = e?.status === undefined && (kind === 'timeout' || kind === 'connection');
        uia2FailedTransiently = transient;
        // 槽空闲判定：protocol（HTTP 有应答但非 200，如 500）= 服务活着但 UiAutomation 没注册上
        // → 槽空闲；ensure 失败（'uia2 不可用'）= 服务没起来 → 槽也空闲。其余（timeout/connection/
        // 无 hierarchy）= 服务活着持槽 → legacy 是死路。
        lastUia2SlotFree = kind === 'protocol' || /uia2 不可用/.test(lastUia2Error);
        const backoffMs = transient ? UIA2_BACKOFF.transientMs : UIA2_BACKOFF.fatalMs;
        uia2DeadUntil = Date.now() + backoffMs;
        console.warn(`[uia2] 不可用（${lastUia2Error}），${Math.round(backoffMs / 1000)}s 内走 legacy dump 通道`);
      }
    }
    // —— 关键平台约束（2026-11-03 双向实验证实）——
    // Android 11 的 UiAutomation 注册槽**排他**：uia2 服务健康持槽时，shell 的
    // `uiautomator dump` 去注册第二个 → AccessibilityManagerService 抛 RemoteException →
    // uiautomator 未捕获自爆（logcat: Sending signal PID SIG:9）→ rc=137。
    // 实验证据：停服务 → dump 立刻成功（106KB）；起服务 → dump 必 rc=137。
    // 槽被占的判定：服务进程存活 **且** 本次失败不是"建会话失败: 500"（500=服务活着但
    // UiAutomation 没注册上 → 槽空闲 → legacy 可用）。槽被占时 legacy 三通道是**注定的
    // 死路**（exec-out/shell 崩 + file 通道 50s 白等 + 二轮重试 ≈ 140s/次，实测
    // run-20261102-220327 被 37 次超时 × 140s 拖到 3323s）。此时唯一正路是**等退避结束
    // 再试 uia2**（60s 预算，对齐历史 busy 页 38-55s 的 worst-case）。
    // 槽被占的判定（2026-11-04 评审修正 P1-1）：**服务进程存活 且 失败不是"建会话失败: 500"**
    // （500=服务活着但 UiAutomation 没注册上 → 槽空闲 → legacy 可用）。旧实现把守卫收窄到
    // "瞬时报错"，导致"有应答但无树"（无 hierarchy/会话 id 缺失/JSON 解析失败——服务明显
    // 活着=槽被占）也掉进 140s 的注定 legacy 死路。注释判据与实现对齐到同一句话。
    // lastUia2Error 跨调用保留：跳过 uia2 尝试（退避期内）的调用也能凭上次的失败类型入守卫。
    // 槽判定（评审 #6）：结构化 e.kind === 'protocol'（uia2 建会话 HTTP 有应答但非 200）
    // 即"服务活着、槽空闲"；message 正则保留兜底注入/历史错误。
    const slotHeldError = lastUia2Error && !lastUia2SlotFree && !/uia2 不可用/.test(lastUia2Error);
    if (uia2 && slotHeldError) {
      const pid = await uia2.serverPid().catch(() => null);
      if (pid) {
        // 等过退避期，然后给一次 60s 的 uia2 重试（页面在退避期间继续渲染，往往能出树）
        const remain = Math.max(0, uia2DeadUntil - Date.now());
        if (remain > 0) await new Promise((r) => setTimeout(r, Math.min(remain, 10_000)));
        uia2DeadUntil = 0;
        try {
          const xml = await uia2.source({ timeoutMs: 60_000 });
          if (xml.includes('</hierarchy>')) return xml;
        } catch (e) {
          throw new Error(`uia2 busy（重试仍失败: ${String(e?.message ?? e).slice(0, 80)}）；legacy 因 UiAutomation 槽被 uia2 占用不可用（Android 11 排他注册）`);
        }
        throw new Error('uia2 busy 且重试无 hierarchy；legacy 因 UiAutomation 槽被 uia2 占用不可用（Android 11 排他注册）');
      }
    }
    // 设备侧 timeout 可用性探测（旧镜像/redroid 老底可能无 toybox timeout）：
    // 缺失时降级为无包裹命令——放弃"到点自杀不留孤儿"，但至少能工作（否则三通道同因失败＝引擎全盲）
    if (timeoutSupported === null) {
      try {
        const w = await adb.shell('which timeout 2>/dev/null || echo NO', { timeoutMs: 5000 });
        timeoutSupported = !/NO\s*$/.test(String(w).trim()) && String(w).trim().length > 0;
        if (!timeoutSupported) console.warn('[warn] 设备无 timeout 命令：dump 降级为无包裹（客户端超时后可能残留孤儿 uiautomator 进程）');
      } catch { timeoutSupported = true; } // 探测失败按有处理（多数设备有）
    }
    // timeout 前缀（含秒数）：`timeout 10 <cmd>`；降级时为空串 → 直接 <cmd>
    const tw = (sec) => (timeoutSupported ? `timeout ${sec} ` : '');
    const tryExecOut = async () => {
      const cmd = timeoutSupported
        ? ['exec-out', 'timeout', '10', 'uiautomator', 'dump', '/dev/tty']
        : ['exec-out', 'uiautomator', 'dump', '/dev/tty'];
      const buf = await adb.execOut(cmd, { timeoutMs: 15000, binary: false });
      const xml = buf.toString('utf8');
      if (!xml.includes('</hierarchy>')) throw new Error('exec-out 无 hierarchy');
      return xml;
    };
    const tryShell = async () => {
      const xml = await adb.shell(`${tw(10)}uiautomator dump /dev/tty`, { timeoutMs: 15000 });
      if (!String(xml).includes('</hierarchy>')) throw new Error('shell 无 hierarchy');
      return xml;
    };
    const tryFile = async () => {
      // 前置 rm -f：实测 `uiautomator dump <不可写路径>` 仍打印成功且 exit 0，
      // 此时 && 不生效、cat 会吐上一轮残留的合法 XML（被当当前树用）——必须清旧文件
      const xml = await adb.shell(`rm -f /sdcard/ask-uidump.xml; ${tw(50)}uiautomator dump /sdcard/ask-uidump.xml && cat /sdcard/ask-uidump.xml`, { timeoutMs: 55000 });
      if (!String(xml).includes('</hierarchy>')) throw new Error('file 无 hierarchy');
      return String(xml);
    };
    const tryChannel = {
      execout: tryExecOut,
      shell: tryShell,
      file: tryFile,
    };
    // 粘性通道直走；失败则按 execout → shell → file 顺序重探。
    // WebView 模态态下 uiautomator idle 等待是**间歇性**失败（同一通道时好时坏），
    // 单轮全败后隔 600ms 再补一轮（file 形式绕开 tty pipe 限制，实测弹窗态稳定可用）
    if (dumpChannel) {
      try { return await tryChannel[dumpChannel](); } catch { dumpChannel = null; }
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const ch of ['execout', 'shell', 'file']) {
        try {
          const xml = await tryChannel[ch]();
          dumpChannel = ch;
          return xml;
        } catch { /* 试下一通道 */ }
      }
      if (pass === 0) await new Promise((r) => setTimeout(r, 600));
    }
    // 全败：客户端超时只会杀 adb 进程，设备侧 uiautomator 可能已成孤儿并**持有 a11y 锁**，
    // 毒化后续所有 dump（实测：孤儿存在时 uia2 建会话报 "Got null UiAutomation"）。
    // 非 root 无法杀他人进程，但可杀**本 shell 用户**起的历史 uiautomator（同一 u0_aXXX uid 下
    // 新起的 dump 进程属同一 uid，pkill 只影响自己这一侧残留），尽力清理后交下一轮重试。
    try {
      await adb.shell('pkill -f "uiautomator dump" 2>/dev/null; true', { timeoutMs: 5000 });
    } catch { /* 清理失败不阻断错误上抛 */ }
    throw new Error('uiautomator dump 三通道（exec-out/shell/file）均无 hierarchy');
  }

  async function dumpTree({ fresh = false } = {}) {
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
    const xml = await dumpXmlRaw();
    const dumpMs = Date.now() - t0;
    cache.recordDump();
    const text = truncateAtHierarchyEnd(xml);
    const nodes = parseXmlDump(text);
    if (!nodes.length) throw new Error(`uiautomator dump 失败: ${text.trim().slice(0, 120)}`);
    const hash = treeHash(nodes);
    lastTreeHash = hash;
    cache.set({ nodes, hash });
    if (pendingPreHash != null) {
      lastActionChanged = hash !== pendingPreHash; // 懒校验：动作后画面是否变化
      pendingPreHash = null;
    }
    return { nodes, hash, dumpMs, fromCache: false };
  }

  function beforeAction() {
    pendingPreHash = cache.peek()?.hash ?? null;
    cache.markDirty();
  }

  const locate = createLocator({ getTree: dumpTree, getSize, screencap: () => screen.screencap(adb, { timeoutMs: adb.timeouts.screencap }), vlmCache, ...(probeFile ? { probeFile } : {}) });

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
          const escaped = want.replace(/([\\'"`$;&<>|()*?~[\]{}#%!])/g, '\\$1').replace(/ /g, '%s');
          await adb.shell(`input text ${escaped}`).catch(() => {});
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
    async tapEachRow({ rows, tap, stopWhen = null, maxRounds = null, verify = true, verifyColor = null, profile = null, onQuestion = null } = {}) {
      const result = { rounds: 0, taps: 0, verified: 0, unverified: 0, done: false, bottom: false, error: null, skipped: [] };
      if (!rows || !tap) { result.error = 'tapEachRow 需要 rows 与 tap 参数'; return result; }
      // 场景 profile（skills 式按需加载）：只在调用方显式指定时 import，未指定的场景
      // 零成本。profile 仅提供**调优参数**（settleMs / maxRounds / verifyColor），
      // 不含任何 App 专有选择器——题面/选项/终止仍全部由 rows/tap/stopWhen 表达。
      let prof = null;
      if (profile) {
        try {
          const { loadProfile } = await import('./profiles/index.js');
          prof = await loadProfile(profile);
        } catch (e) {
          result.error = `profile 加载失败: ${e?.message ?? e}`;
          return result;
        }
      }
      // 时序优先级统一走 profiles.resolveTiming（selector/视觉两形态同款）：显式参数 > profile > 内置缺省
      const { maxRounds: maxRoundsEff, verifyColor: effVerifyColor, settleMs } = resolveTiming({ maxRounds, verifyColor }, prof);
      const expectedColor = effVerifyColor === 'auto' || effVerifyColor == null ? null : (Array.isArray(effVerifyColor) ? effVerifyColor : parseHexColor(effVerifyColor));
      if (effVerifyColor !== 'auto' && effVerifyColor != null && !expectedColor) {
        result.error = `verifyColor 无法解析: ${effVerifyColor}（应为 '#RRGGBB' 或 [r,g,b] 或 'auto'）`;
        return result;
      }
      // 就绪等待预算（2026-11-02 实证）：调用方往往在"点进问卷"的同一步里紧接着调本工具，
      // 此时页面可能还在转场/首屏渲染，树里**一行都没有**。旧实现见到 0 行立刻按"无行可答"
      // 收尾返回 ok（实测 11s 就 ok 退出，整轮其余断言全灭）。改为：从未 tap 过且树中
      // 0 行时，在 readyWaitMs 内反复等，不当成"到底/无行"。
      const readyWaitMs = Math.max(0, Math.min(120_000, Number(prof?.readyTimeoutMs ?? 30_000) || 0));
      const readyDeadline = Date.now() + readyWaitMs;
      let readyWaitedMs = 0;
      const answered = new Set(); // 已作答行文本（跳过重 tap）
      const skipped = new Set(); // 选项集不匹配、无法作答的行（避免转向死循环）
      const tapSels = String(tap).split('|').map((s) => s.trim()).filter(Boolean);
      let prevKey = null;
      let noProgress = 0; // 连续"0 tap 且转向目标不变"轮数；WebView 过滚回弹只抖一帧，2 轮才判到底
      let hangRounds = 0; // 连续"tap 后双信号皆无"次数；2 次即判渲染器挂死退出
      let tapFailCount = 0; // 连续 tap 抛错次数（≥2 报错退出）
      // 待验证的上一轮 tap（延迟验证）：由下一次观测（下一轮 dump 或收尾 drain）结案。
      let pendingTap = null;
      // 结案一次待验证 tap。hashNow 可复用调用方刚取到的树 hash（省一次 dump）。
      // 双信号：树 hash 变化（滚动/换页都算响应）或原坐标像素变为选中色（只选中未滚动）。
      const finishPending = async (hashNow) => {
        if (!pendingTap) return true;
        const p = pendingTap;
        let h = hashNow;
        if (h === undefined) {
          try { h = (await dumpTree({ fresh: true })).hash; } catch { h = null; }
        }
        let ok = h != null && h !== p.preHash;
        let buf = null; // 验证截图（交给 onQuestion 作逐题取证，免二次截屏）
        if (!ok && verify) {
          try {
            const { buffer } = await this.screencap();
            buf = buffer;
            const png = decodePng(buffer);
            const b = p.bounds;
            const cx = p.center[0]; const cy = p.center[1];
            // 无 bounds 兜底采样半径：屏宽 2%（1080 宽 ≈ 22px，比例化适配其它分辨率，评审 #7）
            const sz = await getSize().catch(() => null);
            const fallbackR = Math.max(4, Math.round((sz?.w ?? 1080) * 0.02));
            const rx = b ? Math.max(4, Math.round((b[2] - b[0]) * 0.2)) : fallbackR;
            const ry = b ? Math.max(4, Math.round((b[3] - b[1]) * 0.2)) : fallbackR;
            let hits = 0; let total = 0;
            for (const fx of [-1, 0, 1]) for (const fy of [-1, 0, 1]) {
              const px = pixelAt(png, cx + fx * rx, cy + fy * ry);
              if (!px) continue;
              total++;
              if (expectedColor ? isColorish(px, expectedColor) : isBlueish(px)) hits++;
            }
            ok = total > 0 && hits >= Math.min(5, Math.max(3, Math.ceil(total * 0.6)));
          } catch { ok = true; result.screencapFailed = (result.screencapFailed ?? 0) + 1; } // 放行但计数暴露（screencap 故障可绕过挂死防线的观测口）
        }
        pendingTap = null;
        if (ok) {
          result.verified++;
          hangRounds = 0;
          if (p.rowText) answered.add(p.rowText);
        } else {
          result.unverified++;
          hangRounds++;
        }
        // 逐题进度回调（报告连续回放用）：每题一行子步骤 + 验证截图（无截图时由调用方补拍）
        if (onQuestion) {
          try {
            await onQuestion({ row: p.rowText, option: p.optionText, ok, buffer: buf });
          } catch { /* 进度回调失败不阻断作答 */ }
        }
        return ok;
      };
      // 注意：就绪等待轮次**不消耗 maxRounds 配额**（readyBumps 抵消）。否则 questionnaire
      // profile 的 45s 就绪预算会吃掉 45 轮，YAML 的 maxRounds: 60 只剩 15 轮给 27 题——
      // 表现为"答到一半 exhausted"，且与就绪快慢耦合，难以排查。
      let readyBumps = 0;
      for (let round = 0; round < maxRoundsEff + readyBumps; round++) {
        result.rounds = round + 1;
        let flat = [];
        let hash0 = null;
        try {
          const t = await dumpTree({ fresh: true });
          flat = flattenNodes(t.nodes);
          hash0 = t.hash;
        } catch (e) {
          result.error = `dump 失败: ${e?.message ?? e}`;
          result.skipped = [...skipped];
          return result;
        }
        // 本轮这次 dump 同时充当**上一轮 tap 的回执**（延迟验证）：tap 后没必要立刻再 dump
        // 一次——下一轮开头本来就要取同一棵树。单题成本因此从 2 次 dump 降到 1 次
        // （uia2 下单次 1-6s，27 题实测省约一半作答时间）。
        await finishPending(hash0);
        if (hangRounds >= 2) {
          result.error = `renderer_unresponsive: 连续两次 tap 后页面无响应（树未变且选项未变为选中色 ${effVerifyColor ?? 'auto'}），渲染器疑似挂死`;
          result.skipped = [...skipped];
          return result;
        }
        const size = await getSize().catch(() => null);
        // size=null 时 vis 已短路跳过在屏检查——不需要"兜底屏高"假值（评审 #7 移除 ?? 2400）
        // 零面积（隐藏预渲染层 bounds=[0,0,0,0]）先排除，再看中心点是否在屏
        const areaOk = (n) => Array.isArray(n.bounds) && n.bounds.length === 4 && n.bounds[2] - n.bounds[0] > 0 && n.bounds[3] - n.bounds[1] > 0;
        const vis = (n) => areaOk(n) && (!size || (n.center[0] >= 0 && n.center[0] <= size.w && n.center[1] >= 0 && n.center[1] <= size.h));
        // 行节点取 bounds 真实且带文本者（含滚出屏幕的行，保持文档序）：无文本行无法记账，
        // 进了集群会每轮重 tap 直到 maxRounds（漏答且无 error），故在入口排除。
        // rows 支持 | 交替（与 tap 同款方言）：多类行混排的表单一次表达
        const rowSels = String(rows).split('|').map((x) => x.trim()).filter(Boolean);
        const rowNodes = flat.filter((n) => rowSels.some((x) => matchNode(n, x)) && areaOk(n) && (n.text || n.contentDesc));
        const clusters = [];
        for (const n of rowNodes.sort((a, b) => a.center[1] - b.center[1])) {
          const last = clusters[clusters.length - 1];
          if (last && Math.abs(n.center[1] - last.cy) < Math.max(40, (n.bounds[3] - n.bounds[1]) / 2)) {
            last.nodes.push(n);
            last.cy = last.nodes.reduce((a, x) => a + x.center[1], 0) / last.nodes.length;
          } else {
            clusters.push({ cy: n.center[1], nodes: [n], text: String(n.text || n.contentDesc || '') });
          }
        }
        // 选项带下界 = 下一行的 cy（下一行的选项必在其行 cy 之下，天然不含邻行选项）；
        // 末行/无下一行时回退屏高比例（实测标定 1080×2340 上为 400px，按比例适配其它分辨率，评审 #7）
        const bandFallback = Math.round((size?.h ?? 2340) * (400 / 2340));
        const bandEndOf = (i) => {
          const cl = clusters[i];
          const next = clusters[i + 1];
          return next ? Math.max(next.cy - 8, cl.cy + 40) : cl.cy + bandFallback;
        };
        const optsFor = (cl) => {
          const i = clusters.indexOf(cl);
          const bandEnd = i >= 0 ? bandEndOf(i) : cl.cy + bandFallback;
          return flat
            .filter((n) => tapSels.some((s) => matchNode(n, s)) && n.center[1] > cl.cy && n.center[1] <= bandEnd && areaOk(n))
            .sort((a, b) => a.center[0] - b.center[0]);
        };
        // 就绪门（见上方 readyWaitMs 说明）：还没 tap 过任何行、且树上 0 个行节点 = 页面大概
        // 还没到位（转场/首屏渲染中）。此时**不能**按"无行可答"收尾，否则 11s 就 ok 退出、
        // 后续断言全灭（实测 run-20261102-213839）。等一小段再重新观测，直到预算耗尽。
        if (clusters.length === 0 && result.taps === 0 && Date.now() < readyDeadline) {
          const nap = Math.min(1000, Math.max(200, Math.round((readyDeadline - Date.now()) / 10)));
          await new Promise((r) => setTimeout(r, nap));
          readyWaitedMs += nap;
          readyBumps++; // 归还本轮的 maxRounds 配额
          result.rounds--; // 就绪等待不计入"轮次"（调用方看到的轮次应只统计真实作答轮）
          continue;
        }
        const pending = clusters.filter((c) => !(c.text && (answered.has(c.text) || skipped.has(c.text))));
        if (stopWhen) {
          // matchNode 与 rows/tap 同方言（支持 text*=）；find 已含在屏过滤（vis），返回的是节点本身
          const stop = flat.find((n) => matchNode(n, stopWhen) && vis(n));
          // 终止标记要求在屏（隐藏预渲染层的提交按钮不算），且全文档无未答行
          if (stop && pending.length === 0) { result.done = true; result.skipped = [...skipped]; return result; }
        }
        // 本轮只 tap 第一个在屏可答行（选中即触发滚动，同轮第二 tap 坐标必失效）
        let target = null;
        for (const cl of pending) {
          const pick = optsFor(cl).find((n) => vis(n));
          if (pick) { target = { cl, pick }; break; }
        }
        if (!target) {
          // 无在屏可答行：按第一个未答行几何转向（direction 内容语义：down=前进看下方，up=回退）
          const firstUn = pending[0];
          let dir = 'down';
          if (firstUn) {
            const opts = optsFor(firstUn);
            if (!opts.length && firstUn.cy >= 0 && (!size || firstUn.cy <= size.h)) {
              skipped.add(firstUn.text); // 在屏但选项集不匹配：记跳过，避免死循环
              continue;
            }
            const lastOpt = opts.reduce((a, b) => (!a || b.center[1] > a.center[1] ? b : a), null); // 最低选项（非最右）
            if (firstUn.cy < 0 && (!lastOpt || lastOpt.center[1] < 0)) dir = 'up'; // 行与选项都在屏上 → 回退
          }
          const key = `${firstUn?.text ?? ''}@${dir}`;
          if (key === prevKey && ++noProgress >= 2) { result.bottom = true; break; }
          prevKey = key;
          try { await this.scroll(dir, { max: 1, stopWhenNoChange: true }); } catch { /* 转向滚动失败（如冷启动尺寸未就绪）仅损失一轮，不炸穿工具层 */ }
          continue;
        }
        noProgress = 0; prevKey = null;
        try {
          await action.tap(adb, target.pick.center);
        } catch (e) {
          // 连续 tap 异常（设备离线等）≥2 直接报错，防 busy 页 40s/轮 × maxRounds 空转
          tapFailCount++;
          if (tapFailCount >= 2) { result.error = `连续 tap 失败: ${e?.message ?? e}`; result.skipped = [...skipped]; return result; }
          continue;
        }
        tapFailCount = 0;
        result.taps++;
        // 选中渲染 + scroll-into-view 动画的 settle。延迟验证下这是**唯一**的等待：
        // 下一轮 dump 落在 settle 之后，天然覆盖渲染；因此这里不必再为"立刻验证"多等一轮。
        await new Promise((r) => setTimeout(r, settleMs));
        // 挂起验证：本轮 tap 的回执由下一次观测（下一轮 dump / 收尾 drain）结案。
        pendingTap = {
          preHash: hash0,
          center: target.pick.center,
          bounds: Array.isArray(target.pick.bounds) ? target.pick.bounds : null,
          rowText: target.cl.text ?? '',
          optionText: String(target.pick.text || target.pick.contentDesc || ''),
        };
      }
      // 收尾 drain：最后一题的 tap 没有"下一轮 dump"可用，这里补一次观测结案。
      // 只有在仍有挂起 tap 时才付这次代价（正常 done/bottom 退出路径会带上它）。
      if (pendingTap && !result.error) await finishPending();
      // maxRounds 自然耗尽且未终止：显式标记（done/bottom/error 均为假的第四态，调用方可区分）
      if (!result.done && !result.bottom && !result.error) result.exhausted = true;
      result.skipped = [...skipped];
      return result;
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
        await adb.shell(`am force-stop ${packageName}`);
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
          h = (await dumpTree({ fresh: true })).hash; // 必须强制新树，缓存命中会使判定失真
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
          const tree = await dumpTree({ fresh: true }); // 强制新树（缓存命中会让"等待"失去意义）
          flat = flattenNodes(tree.nodes);
          failStreak = 0;
        } catch { failStreak++; /* dump 失败（转场中）→ 继续等 */ }
        dumps++;
        if (flat.length) {
          const m = await matchOnScreen(flat, sel);   // 返回 { node, value } | null
          if (m?.node) return { appeared: true, dumps, matched: m.value || sel, inWebView: !!m.inWebView };
        }
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
          const tree = await dumpTree({ fresh: true });
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
    async close() {},

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
    // 曾 4 次串行 adb 调用）。输出按行拆回，行序与入参一致；失败返回空串不抛错。
    async getProps(names) {
      const list = (Array.isArray(names) ? names : [names]).map((n) => String(n).trim());
      if (!list.length) return [];
      try {
        const out = await adb.shell(list.map((n) => `getprop ${n}`).join('; '), { timeoutMs: adb.timeouts.command });
        const lines = String(out).split(/\r?\n/);
        return list.map((_, i) => (lines[i] ?? '').trim());
      } catch {
        return list.map(() => '');
      }
    },
    // 懒校验结果：最近一次动作后画面是否变化（true/false，null=无基准可比）
    get lastActionChanged() {
      return lastActionChanged;
    },
    rollout: {
      withRetry: (opts) => withLocateRetry({ device, ...opts }),
      createStepRollout: (opts) => new StepRollout(device, opts),
    },
  };

  return device;
}

export async function createDevice({ serial, adbPath = process.env.ASK_ADB || 'adb', timeouts } = {}) {
  return createDeviceWithExecutor({ serial, adbPath, timeouts });
}
