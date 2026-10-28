// 设备门面（契约 §1.1）：工具层只认 createDevice，不直接 import device 内部模块
import { writeFile } from 'node:fs/promises';
import { Adb } from './adb.js';
import * as screen from './screen.js';
import { truncateAtHierarchyEnd, parseXmlDump, flattenNodes, treeHash } from './uitree.js';
import { TreeCache } from './cache.js';
import { createLocator, matchSelector } from './locate.js';
import * as action from './action.js';
import { Yadb, readTextAt } from './input.js';
import { withLocateRetry, StepRollout } from './rollout.js';
import * as state from './state.js';
import * as net from '../net/profile.js';

// exec 仅测试注入用；契约入口 createDevice 不暴露该参数
// waitReady 控制是否等待设备系统服务就绪（冷启动场景）；空 exec/测试注入时可传 false 跳过
// probeFile：模型家族坐标探测缓存路径（默认 cwd/.ask/family-probe.json；工作区模式下由 CLI 传全局路径）
export async function createDeviceWithExecutor({ serial, adbPath = process.env.ASK_ADB || 'adb', timeouts = {}, exec, waitReady = null, probeFile = null } = {}) {
  const adb = new Adb({ serial, adbPath, timeouts, exec });
  await adb.ensureConnected().catch(() => {}); // 首连失败不阻塞，命令期仍有重连机会

  // 设备就绪等待（冷启动窗口）：默认在真实设备上启用；测试注入 exec 时默认跳过（避免等 60s）
  const shouldWait = waitReady === null ? !exec : Boolean(waitReady);
  if (shouldWait) {
    try {
      const r = await adb.waitForBoot({ timeoutMs: Number(process.env.ASK_BOOT_TIMEOUT_MS) || 60_000 });
      if (!r.ready) console.warn(`[warn] ${r.reason}`);
    } catch (e) {
      console.warn(`[warn] 等待设备就绪失败：${e?.message ?? e}`);
    }
  }

  const cache = new TreeCache();
  const vlmCache = new Map();
  const yadb = new Yadb(adb);
  let sizeCache = null;
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
  // exec-out 失败或返回不含 </hierarchy>（同为 shell 通道的病征）时回退 legacy shell（旧镜像/redroid 兼容）
  async function dumpXmlRaw() {
    try {
      const buf = await adb.execOut(['exec-out', 'uiautomator', 'dump', '/dev/tty'], {
        timeoutMs: adb.timeouts.dump,
        binary: false,
      });
      const xml = buf.toString('utf8');
      if (xml.includes('</hierarchy>')) return xml;
    } catch (e) { /* 落入 legacy shell 回退 */ }
    return adb.shell('uiautomator dump /dev/tty', { timeoutMs: adb.timeouts.dump });
  }

  async function dumpTree({ fresh = false } = {}) {
    if (!fresh) {
      const hit = cache.peek();
      if (hit) {
        cache.recordHit();
        return { nodes: hit.nodes, hash: hit.hash, dumpMs: 0, fromCache: true };
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
    async inputText(bounds, text) {
      try {
        const xy = action.resolvePoint(bounds, await getSize());
        await action.tap(adb, xy); // 点击聚焦
        await yadb.clear();
        await yadb.type(String(text ?? ''));
        beforeAction();
        const tree = await dumpTree({ fresh: true }); // 回读校验强制用新树（§5.4.5）
        const readBack = readTextAt(flattenNodes(tree.nodes), xy);
        const ok = readBack === String(text ?? '');
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
        if (h !== prev) {
          changed = true;
          prev = h;
        } else if (stopWhenNoChange) {
          break;
        }
      }
      return { scrolls, changed };
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
    async waitIdle({ quiet = 2, intervalMs = 200, timeoutMs = 10000 } = {}) {
      const t0 = Date.now();
      let dumps = 0;
      let stableRun = 0;
      let prev = null;
      let stable = false;
      while (Date.now() - t0 < timeoutMs) {
        // dump 失败（转场中/uiautomator idle 超时，§20.4 已知）当作"未稳定"继续等，
        // 不再让异常逃出（曾使整条用例在 aiWaitFor 步判 error 中断，VERIFICATION-OVERVIEW §7）
        let h = null;
        try {
          h = (await dumpTree({ fresh: true })).hash; // 必须强制新树，缓存命中会使判定失真
        } catch { /* 未稳定，继续等 */ }
        dumps++;
        if (h !== null) {
          stableRun = prev !== null && h === prev ? stableRun + 1 : 1;
          prev = h;
          if (stableRun >= quiet) {
            stable = true;
            break;
          }
        } else {
          stableRun = 0;
          prev = null;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return { stable, dumps };
    },
    // 等元素出现（§21）：比"等树不变"更语义、通常更快——每次 dump 后查目标是否已出现，出现即返回。
    // 返回 { appeared, dumps, matched: <文本> | null }。
    // selector 支持 'text=xx' | 'text*=xx' | 'resourceId=xx' | 'class=...#index=N'（同 readText 的匹配器）。
    async waitForElement(selector, { timeoutMs = 10000, intervalMs = 200 } = {}) {
      const sel = String(selector ?? '').trim();
      if (!sel) return { appeared: false, dumps: 0, matched: null, error: 'selector 为空' };
      const t0 = Date.now();
      let dumps = 0;
      while (Date.now() - t0 < timeoutMs) {
        let flat = [];
        try {
          const tree = await dumpTree({ fresh: true }); // 强制新树（缓存命中会让"等待"失去意义）
          flat = flattenNodes(tree.nodes);
        } catch { /* dump 失败（转场中）→ 继续等 */ }
        dumps++;
        if (flat.length) {
          const m = matchSelector(flat, sel);   // 返回 { node, value } | null
          if (m?.node) return { appeared: true, dumps, matched: m.value || sel };
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return { appeared: false, dumps, matched: null };
    },
    // 等任一元素出现（多 selector，命中其一即返回）
    async waitForAnyElement(selectors, { timeoutMs = 10000, intervalMs = 200 } = {}) {
      const sels = (Array.isArray(selectors) ? selectors : [selectors]).map((s) => String(s ?? '').trim()).filter(Boolean);
      if (!sels.length) return { appeared: false, dumps: 0, matched: null, error: 'selectors 为空' };
      const t0 = Date.now();
      let dumps = 0;
      while (Date.now() - t0 < timeoutMs) {
        let flat = [];
        try {
          const tree = await dumpTree({ fresh: true });
          flat = flattenNodes(tree.nodes);
        } catch { /* 继续等 */ }
        dumps++;
        if (flat.length) {
          for (const sel of sels) {
            const m = matchSelector(flat, sel);   // { node, value } | null
            if (m?.node) return { appeared: true, dumps, matched: `${sel} → ${m.value || ''}` };
          }
        }
        await new Promise((r) => setTimeout(r, intervalMs));
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
