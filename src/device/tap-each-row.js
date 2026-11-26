// 逐行作答状态机（§5.4.6）：问卷/表单一行一行作答。
//
// 从 device/index.js 抽出（原为 235 行的方法体，是该文件最大的单体）。
// 抽出的理由：它是**自包含的状态机**，只依赖 adb / dumpTree / getSize /
// screencap / scroll 五个能力，与门面的其余职责（树缓存、定位、动作分发）无关。
// 依赖以参数注入，避免与 index.js 形成循环依赖（index.js import 本模块，
// 本模块不得反向 import index.js）。
import { decodePng, parseHexColor, isBlueish, isColorish, pixelAt } from './png.js';
import { flattenNodes } from './uitree.js';
import * as action from './action.js';
import { matchNodeSelector as matchNode } from './locate.js';
import { resolveTiming } from './profiles/index.js';

export function createTapEachRow({ adb, dumpTree, getSize, screencap, scroll }) {
  return async function tapEachRow({ rows, tap, stopWhen = null, maxRounds = null, verify = true, verifyColor = null, profile = null, onQuestion = null } = {}) {
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
    // 就绪等待预算：调用方往往在"点进问卷"的同一步里紧接着调本工具，
    // 此时页面可能还在转场/首屏渲染，树里**一行都没有**。从未 tap 过且树中
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
          const { buffer } = await screencap();
          buf = buffer;
          const png = decodePng(buffer);
          const b = p.bounds;
          const cx = p.center[0]; const cy = p.center[1];
          // 无 bounds 兜底采样半径：屏宽 2%（1080 宽 ≈ 22px，比例化适配其它分辨率）
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
        if (p.rowText) answered.add(p.rowKey || p.rowText);
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
      // （uia2 下单次 1-6s，27 题省约一半作答时间）。
      await finishPending(hash0);
      if (hangRounds >= 2) {
        result.error = `renderer_unresponsive: 连续两次 tap 后页面无响应（树未变且选项未变为选中色 ${effVerifyColor ?? 'auto'}），渲染器疑似挂死`;
        result.skipped = [...skipped];
        return result;
      }
      const size = await getSize().catch(() => null);
      // size=null 时 vis 已短路跳过在屏检查——不需要"兜底屏高"假值
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
      // 行身份（key）：文本 + **同文本出现序号**。
      // 记账若只用文本，多题问卷里重复的行文本（多道"满意度"、多组"是/否"）会被
      // 误判为同一行——答完第一道，所有同文本行都被跳过，整组静默丢失
      // （result.skipped/done 无任何异常标记）。故按"第 N 个该文本的行"区分。
      const textSeen = new Map();
      for (const cl of clusters) {
        const n = (textSeen.get(cl.text) ?? 0) + 1;
        textSeen.set(cl.text, n);
        cl.key = n === 1 ? cl.text : `${cl.text}#${n}`;
      }
      // 选项带下界 = 下一行的 cy（下一行的选项必在其行 cy 之下，天然不含邻行选项）；
      // 末行/无下一行时回退屏高比例（标定 1080×2340 上为 400px，按比例适配其它分辨率）
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
      // 还没到位（转场/首屏渲染中）。此时**不能**按"无行可答"收尾，否则会 ok 退出、
      // 后续断言全灭。等一小段再重新观测，直到预算耗尽。
      if (clusters.length === 0 && result.taps === 0 && Date.now() < readyDeadline) {
        const nap = Math.min(1000, Math.max(200, Math.round((readyDeadline - Date.now()) / 10)));
        await new Promise((r) => setTimeout(r, nap));
        readyWaitedMs += nap;
        readyBumps++; // 归还本轮的 maxRounds 配额
        result.rounds--; // 就绪等待不计入"轮次"（调用方看到的轮次应只统计真实作答轮）
        continue;
      }
      const pending = clusters.filter((c) => !(c.text && (answered.has(c.key) || skipped.has(c.key))));
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
            skipped.add(firstUn.key ?? firstUn.text); // 在屏但选项集不匹配：记跳过，避免死循环
            continue;
          }
          const lastOpt = opts.reduce((a, b) => (!a || b.center[1] > a.center[1] ? b : a), null); // 最低选项（非最右）
          if (firstUn.cy < 0 && (!lastOpt || lastOpt.center[1] < 0)) dir = 'up'; // 行与选项都在屏上 → 回退
        }
        const key = `${firstUn?.text ?? ''}@${dir}`;
        if (key === prevKey && ++noProgress >= 2) { result.bottom = true; break; }
        prevKey = key;
        try { await scroll(dir, { max: 1, stopWhenNoChange: true }); } catch { /* 转向滚动失败（如冷启动尺寸未就绪）仅损失一轮，不炸穿工具层 */ }
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
        rowKey: target.cl.key ?? target.cl.text ?? '',   // 行身份（文本+同文本序号），记账用
        optionText: String(target.pick.text || target.pick.contentDesc || ''),
      };
    }
    // 收尾 drain：最后一题的 tap 没有"下一轮 dump"可用，这里补一次观测结案。
    // 只有在仍有挂起 tap 时才付这次代价（正常 done/bottom 退出路径会带上它）。
    if (pendingTap && !result.error) await finishPending();
    // maxRounds 自然耗尽且未终止：显式标记（done/bottom/error 均为假的第四态，调用方可区分）
    if (!result.done && !result.bottom && !result.error) result.exhausted = true;
    result.skipped = [...skipped];
    return result;  };
}
