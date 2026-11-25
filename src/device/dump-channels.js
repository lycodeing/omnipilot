// UI 树抓取的通道策略：uia2（快）/ legacy 三通道 execout→shell→file（耐久）。
//
// 从 device/index.js 抽出——原函数混合了通道顺序、uia2 退避状态机与预算裁剪
// 三类关注点，是该文件第二大单体（155 行）。退避状态（uia2DeadUntil /
// lastUia2Error / lastUia2SlotFree）与粘性通道（dumpChannel）、timeout 可用性
// （timeoutSupported）**随之一并搬入**——它们只服务于通道决策，index.js 的其余
// 逻辑不读写。lastTreeHash 基线由 index.js 持有（dumpTree 也写它），经
// onLastTreeHash 回调同步。
import { classifyTransportError } from './errors.js';

const UIA2_BACKOFF = { transientMs: 5_000, fatalMs: 60_000 };

export function createDumpChannels({ adb, uia2 }) {
  let dumpChannel = null; // 'execout' | 'shell' | 'file' | null(未探测)
  let uia2DeadUntil = 0;
  let lastUia2Error = '';
  let lastUia2SlotFree = false; // 上次失败是否意味着"槽空闲、legacy 可走"（protocol/ensure 失败 → true）
  let timeoutSupported = null; // 设备侧 timeout 可用性（null=未探测，false=降级无包裹）

  async function dumpXmlRaw({ budgetMs = null } = {}) {
    // 预算起点必须在 uia2 尝试之前：uia2 source/退避重试同样消耗本次预算，
    // 若从 legacy 段才起算，重试与 cap() 的"剩余量"会漏掉前段耗时（C-A2）。
    const dumpT0 = Date.now();
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
    if (uia2 && Date.now() >= uia2DeadUntil) {
      try {
        // uia2 的 source 超时同样受本次 dump 预算约束（默认走 SDK 内部超时）
        const xml = await uia2.source(budgetMs != null ? { timeoutMs: budgetMs } : undefined);
        if (xml.includes('</hierarchy>')) return xml;
        throw new Error('uia2 无 hierarchy');
      } catch (e) {
        lastUia2Error = String(e?.message ?? e).slice(0, 100);
        // 传输类判定（评审 #6）：结构化 e.kind/e.code 优先（classifyTransportError），
        // message 正则仅兜底注入执行器/历史错误。e.status 非 undefined = HTTP 有应答
        // （服务活着），不是传输故障——与旧 `e?.status === undefined` 守卫语义一致。
        const kind = classifyTransportError(e);
        const transient = e?.status === undefined && (kind === 'timeout' || kind === 'connection');
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
        // 重试前不清零退避：清零后若重试仍失败，uia2DeadUntil 会停在 0，
        // 下次 dumpTree 直接跳过退避（Date.now() >= 0 恒真）→ 立刻再付
        // 10s 等待 + 60s source 超时，正是这段退避本要避免的 ≈140s/次成本。
        try {
          // 重试预算同样受本次 dump 预算约束——此前硬编码 60s，完全无视 budgetMs，
          // 使 waitForElement({timeoutMs:10000}) 仍可能被拖成 60s+。用剩余量而非全量：
          // uia2 首次尝试与退避等待已消耗部分预算，重试再取满额会击穿总预算（C-A2）。
          const retryBudget = budgetMs != null ? Math.max(500, budgetMs - (Date.now() - dumpT0)) : 60_000;
          const xml = await uia2.source({ timeoutMs: retryBudget });
          if (xml.includes('</hierarchy>')) {
            uia2DeadUntil = 0;   // 成功才解除退避
            return xml;
          }
          throw new Error('重试无 hierarchy');
        } catch (e) {
          // 重试失败：恢复退避期并记录错误类型，下一轮据 lastUia2Error 继续守卫
          uia2DeadUntil = Date.now() + UIA2_BACKOFF.fatalMs;
          lastUia2Error = `uia2 busy 重试失败: ${String(e?.message ?? e).slice(0, 120)}`;
          lastUia2SlotFree = false;
          throw new Error(`uia2 busy（重试仍失败: ${String(e?.message ?? e).slice(0, 80)}）；legacy 因 UiAutomation 槽被 uia2 占用不可用（Android 11 排他注册）`);
        }
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
    // 预算裁剪：预算必须**跨通道共享递减**，否则 3 通道 × 2 轮各取满预算
    // → budgetMs=10000 时最坏 61s（6 倍超支），"最多等 N 毫秒"的契约被击穿。
    // cap() 取当前**剩余**预算与通道固有上限的较小者；剩余耗尽则直接失败。
    const remain = () => (budgetMs != null ? budgetMs - (Date.now() - dumpT0) : Infinity);
    const cap = (ms) => {
      if (budgetMs == null) return ms;
      const r = remain();
      if (r <= 0) throw new Error(`dump 预算耗尽（${budgetMs}ms 内未取到树）`);
      return Math.max(500, Math.min(ms, r));
    };
    const tryExecOut = async () => {
      const cmd = timeoutSupported
        ? ['exec-out', 'timeout', '10', 'uiautomator', 'dump', '/dev/tty']
        : ['exec-out', 'uiautomator', 'dump', '/dev/tty'];
      const buf = await adb.execOut(cmd, { timeoutMs: cap(15000), binary: false });
      const xml = buf.toString('utf8');
      if (!xml.includes('</hierarchy>')) throw new Error('exec-out 无 hierarchy');
      return xml;
    };
    const tryShell = async () => {
      const xml = await adb.shell(`${tw(10)}uiautomator dump /dev/tty`, { timeoutMs: cap(15000) });
      if (!String(xml).includes('</hierarchy>')) throw new Error('shell 无 hierarchy');
      return xml;
    };
    const tryFile = async () => {
      // 前置 rm -f：实测 `uiautomator dump <不可写路径>` 仍打印成功且 exit 0，
      // 此时 && 不生效、cat 会吐上一轮残留的合法 XML（被当当前树用）——必须清旧文件
      const xml = await adb.shell(`rm -f /sdcard/ask-uidump.xml; ${tw(50)}uiautomator dump /sdcard/ask-uidump.xml && cat /sdcard/ask-uidump.xml`, { timeoutMs: cap(55000) });
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
  return dumpXmlRaw;
}
