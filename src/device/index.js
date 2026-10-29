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
import { decodePng, pixelAt, isBlueish } from './png.js';

// exec 仅测试注入用；契约入口 createDevice 不暴露该参数
// waitReady 控制是否等待设备系统服务就绪（冷启动场景）；空 exec/测试注入时可传 false 跳过
// probeFile：模型家族坐标探测缓存路径（默认 cwd/.ask/family-probe.json；工作区模式下由 CLI 传全局路径）
export async function createDeviceWithExecutor({ serial, adbPath = process.env.ASK_ADB || 'adb', timeouts = {}, exec, waitReady = null, probeFile = null } = {}) {
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
  let dumpChannel = null; // 'execout' | 'shell' | null(未探测)
  async function dumpXmlRaw() {
    const tryExecOut = async () => {
      const buf = await adb.execOut(['exec-out', 'uiautomator', 'dump', '/dev/tty'], {
        timeoutMs: adb.timeouts.dump,
        binary: false,
      });
      const xml = buf.toString('utf8');
      if (!xml.includes('</hierarchy>')) throw new Error('exec-out 无 hierarchy');
      return xml;
    };
    const tryShell = async () => {
      const xml = await adb.shell('uiautomator dump /dev/tty', { timeoutMs: adb.timeouts.dump });
      if (!String(xml).includes('</hierarchy>')) throw new Error('shell 无 hierarchy');
      return xml;
    };
    // 粘性通道直走；失败则重置并用另一通道兜底一次（避免永久劣化）
    if (dumpChannel === 'shell') {
      try { return await tryShell(); } catch (e) { dumpChannel = null; }
    } else if (dumpChannel === 'execout') {
      try { return await tryExecOut(); } catch (e) { dumpChannel = null; }
    }
    try {
      const xml = await tryExecOut();
      dumpChannel = 'execout';
      return xml;
    } catch (e) { /* 回退 shell */ }
    const xml = await tryShell();
    dumpChannel = 'shell';
    return xml;
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
        const m = matchSelector(flattenNodes(tree.nodes), selector);
        if (!m) return { ok: false, value: null, error: `未匹配: ${selector}` };
        return { ok: true, value: m.value, error: null };
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
        const tree = await dumpTree({ fresh: true }); // 回读校验强制用新树（§5.4.5）
        const readBack = readTextAt(flattenNodes(tree.nodes), xy);
        const ok = readBack === want;
        return {
          ok,
          readBack,
          error: ok ? null : readBack == null ? '回读失败：未在输入位置找到节点' : `回读不一致: 期望「${text}」实际「${readBack}」`,
        };
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
      const [fromRegion, toRegion] = moves[String(direction ?? 'up').toLowerCase()] ?? moves.up;
      let prev = (await dumpTree()).hash;
      let scrolls = 0;
      let changed = false;
      while (scrolls < max) {
        if (useDist) {
          // scrollDistancePoints 吃手指方向：内容语义取反后传入
          const finger = { down: 'up', up: 'down', left: 'right', right: 'left' }[String(direction ?? 'down').toLowerCase()] ?? 'up';
          const [p1, p2] = action.scrollDistancePoints(finger, size, distancePct);
          await action.swipe(adb, p1, p2, 300);
        } else {
          await action.swipe(adb, action.regionPoint(fromRegion, size), action.regionPoint(toRegion, size), 300);
        }
        beforeAction();
        scrolls++;
        const h = (await dumpTree()).hash;
        if (h !== prev) {
          changed = true;
          prev = h;
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
    // 逐行作用域批量点击（引擎确定性，0 模型往返）：表单/问卷作答场景。
    // 关键事实（实测）：① WebView 选中态（蓝底）不进 a11y 树，adb tap 无回执；② 选中会触发
    // scroll-into-view，**tap 后整页滚动**，同轮内后续行的坐标立即失效（也是历史"点错行"根因）。
    // 因此每轮只 tap 一行：dump → 取文档序第一个未答行 → tap 其行内最左在屏选项 → 等渲染 →
    // 双信号验证（树 hash 变化=页面滚动/响应；或原坐标像素变蓝=未滚动但选中）→ 记 answered；
    // 双信号皆无 = 渲染器挂死计数（连续 2 次报错退出，不再空转记假已答）。
    // 转向：无在屏可答行时按第一个未答行几何：选项在屏下 → down 前进；行与选项都在屏上 → up 回退。
    // stopWhen 可见**且**全文档无未答行才 done。零面积节点（隐藏预渲染层）一律排除。
    async tapEachRow({ rows, tap, stopWhen = null, maxRounds = 60 } = {}) {
      const result = { rounds: 0, taps: 0, verified: 0, unverified: 0, done: false, bottom: false, error: null, skipped: [] };
      if (!rows || !tap) { result.error = 'tapEachRow 需要 rows 与 tap 参数'; return result; }
      const answered = new Set(); // 已作答行文本（跳过重 tap）
      const skipped = new Set(); // 选项集不匹配、无法作答的行（避免转向死循环）
      const tapSels = String(tap).split('|').map((s) => s.trim()).filter(Boolean);
      let prevKey = null;
      let noProgress = 0; // 连续"0 tap 且转向目标不变"轮数；WebView 过滚回弹只抖一帧，2 轮才判到底
      let hangRounds = 0; // 连续"tap 后双信号皆无"次数；2 次即判渲染器挂死退出
      for (let round = 0; round < maxRounds; round++) {
        result.rounds = round + 1;
        let flat = [];
        let hash0 = null;
        try {
          const t = await dumpTree({ fresh: true });
          flat = flattenNodes(t.nodes);
          hash0 = t.hash;
        } catch (e) {
          result.error = `dump 失败: ${e?.message ?? e}`;
          return result;
        }
        const size = await getSize().catch(() => null);
        const h = size?.h ?? 2400;
        // 零面积（隐藏预渲染层 bounds=[0,0,0,0]）先排除，再看中心点是否在屏
        const areaOk = (n) => Array.isArray(n.bounds) && n.bounds.length === 4 && n.bounds[2] - n.bounds[0] > 0 && n.bounds[3] - n.bounds[1] > 0;
        const vis = (n) => areaOk(n) && (!size || (n.center[0] >= 0 && n.center[0] <= size.w && n.center[1] >= 0 && n.center[1] <= h));
        // 行节点取 bounds 真实者（含滚出屏幕的行，保持文档序）
        const rowNodes = flat.filter((n) => matchNode(n, rows) && areaOk(n));
        const clusters = [];
        for (const n of rowNodes.sort((a, b) => a.center[1] - b.center[1])) {
          const last = clusters[clusters.length - 1];
          if (last && Math.abs(n.center[1] - last.cy) < Math.max(40, (n.bounds[3] - n.bounds[1]) / 2)) {
            last.nodes.push(n);
            last.cy = last.nodes.reduce((a, x) => a + x.center[1], 0) / last.nodes.length;
          } else {
            clusters.push({ cy: n.center[1], nodes: [n], text: String(n.text || '') });
          }
        }
        const optsFor = (cl) => flat
          .filter((n) => tapSels.some((s) => matchNode(n, s)) && n.center[1] > cl.cy && n.center[1] <= cl.cy + 400 && areaOk(n))
          .sort((a, b) => a.center[0] - b.center[0]);
        const pending = clusters.filter((c) => !(c.text && (answered.has(c.text) || skipped.has(c.text))));
        if (stopWhen) {
          const stop = matchSelector(flat, stopWhen);
          // 终止标记要求在屏（隐藏预渲染层的提交按钮不算），且全文档无未答行
          if (stop?.node && vis(stop.node) && pending.length === 0) { result.done = true; return result; }
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
            if (!opts.length && firstUn.cy >= 0 && firstUn.cy <= h) {
              skipped.add(firstUn.text); // 在屏但选项集不匹配：记跳过，避免死循环
              continue;
            }
            const lastOpt = opts[opts.length - 1];
            if (firstUn.cy < 0 && (!lastOpt || lastOpt.center[1] < 0)) dir = 'up'; // 行与选项都在屏上 → 回退
          }
          const key = `${firstUn?.text ?? ''}@${dir}`;
          if (key === prevKey && ++noProgress >= 2) { result.bottom = true; break; }
          prevKey = key;
          await this.scroll(dir, { max: 1, stopWhenNoChange: true });
          continue;
        }
        noProgress = 0; prevKey = null;
        try {
          await action.tap(adb, target.pick.center);
        } catch { /* 单行 tap 失败本轮重来 */ continue; }
        result.taps++;
        await new Promise((r) => setTimeout(r, 700)); // 选中渲染 + scroll-into-view 动画
        // 双信号验证：树 hash 变化（页面滚动/响应）或原坐标像素变蓝（未滚动但选中）
        let hash1 = null;
        try { hash1 = (await dumpTree({ fresh: true })).hash; } catch { hash1 = null; }
        let blue = false;
        if (hash1 === hash0) {
          try {
            const { buffer } = await this.screencap();
            const png = decodePng(buffer);
            let hits = 0;
            for (const dx of [-22, 0, 22]) for (const dy of [-22, 0, 22]) {
              const px = pixelAt(png, target.pick.center[0] + dx, target.pick.center[1] + dy);
              if (px && isBlueish(px)) hits++;
            }
            blue = hits >= 5;
          } catch { blue = true; } // 截图/解码失败不阻断，按通过放行
        }
        if (hash1 !== hash0 || blue) {
          result.verified++;
          hangRounds = 0;
          if (target.cl.text) answered.add(target.cl.text);
        } else {
          result.unverified++;
          if (++hangRounds >= 2) {
            result.error = 'renderer_unresponsive: 连续两次 tap 后页面无响应（树未变且选项未变蓝），WebView 渲染器疑似挂死';
            break;
          }
        }
      }
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
