// uia2 通道终版（终评 P1×2 + P3 修复）：
// ① httpRaw 半途断连挂起修复（实证 P1）：res error/aborted 监听 + 客户端整体 deadline；
// ② hostPort 线性探测防碰撞（多设备并行哈希撞槽 → 串台读别的设备的树）；
// ③ started 死变量删除；模块级 usedPorts 进程内去重。
import http from 'node:http';

const DEVICE_PORT = 6790;
const usedPorts = new Set(); // 进程内已占用 host 端口（--parallel 多设备防哈希碰撞）

// serial → host 转发端口：哈希 + 线性探测（进程内去重；跨进程由 adb forward 表全局互斥兜底）
export function hostPort(serial) {
  let h = 0;
  for (const ch of String(serial)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  let p = 6790 + (h % 200);
  while (usedPorts.has(p)) p = p >= 6989 ? 6790 : p + 1;
  usedPorts.add(p);
  return p;
}

const noKeepAgent = new http.Agent({ keepAlive: false }); // 共享 agent：keep-alive 池化 socket 会吊住测试进程的 event loop

function httpRaw(hostP, p, { method = 'GET', body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    // 整体 deadline：响应头已到但 body 半途断连时 end/error 都不触发（实证挂起），
    // 客户端限时兜底 + req.destroy；socket 级 timeout 只管 idle，管不住这种场景
    let settled = false;
    const req = http.request(
      { host: '127.0.0.1', port: hostP, path: p, method, headers: body ? { 'content-type': 'application/json' } : {}, timeout: timeoutMs, agent: noKeepAgent },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('error', (e) => { if (!settled) { settled = true; clearTimeout(deadline); reject(e); } });
        res.on('aborted', () => { if (!settled) { settled = true; clearTimeout(deadline); reject(new Error(`uia2 连接中断: ${p}`)); } });
        res.on('end', () => { if (!settled) { settled = true; clearTimeout(deadline); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); } });
      },
    );
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      reject(new Error(`uia2 超时(${timeoutMs}ms): ${p}`));
    }, timeoutMs);
    req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(deadline); reject(e); } });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// readyPoll：冷启动轮询参数（{ tries, intervalMs }）。默认 15×1s=15s——实测 `-w` 启动到
// /status ready 需 5-9s（进程拉起 + a11y 注册 + netty 监听），原 6×800ms=4.8s 会在临界点误判
// 不可达并进入 10 分钟退避。测试注入小值以免空等真实时间。
export function createUia2({ adb, serial, port = null, log = () => {}, readyPoll = {} } = {}) {
  // port 显式注入（测试 DI）优先；缺省按 serial 哈希+线性探测派生 host 转发端口
  const hostP = port ?? hostPort(serial);
  const pollTries = Number.isFinite(readyPoll.tries) ? readyPoll.tries : 15;
  const pollIntervalMs = Number.isFinite(readyPoll.intervalMs) ? readyPoll.intervalMs : 1000;
  let sessionId = null;
  let deadUntil = 0; // 探测失败后的退避期（期间 ensure 直接 false，走 legacy 通道）

  async function forward() {
    if (port != null) return; // 显式端口=测试直连 stub，无需 adb forward
    // adb forward 是 **host 侧**子命令；走 adb.shell 会变成设备内执行 `forward` → exit 127，
    // 转发永远建不起来（此后所有 /wd/hub 请求连接被拒，uia2 全链退化为 legacy）。
    const args = ['forward', `tcp:${hostP}`, `tcp:${DEVICE_PORT}`];
    if (typeof adb.host === 'function') await adb.host(args, { timeoutMs: 8000 });
    else await adb.execOut(args, { timeoutMs: 8000, binary: false }); // 老注入执行器兜底
  }

  async function status() {
    // 连接被拒（服务未起/转发未建立）必须返回 false 走启动+轮询，不能抛异常跳过重试环
    try {
      const r = await httpRaw(hostP, '/wd/hub/status', { timeoutMs: 2500 });
      return r.status === 200 && r.body.includes('"ready":true');
    } catch {
      return false;
    }
  }

  async function startServer() {
    // `-w` 必须带（实证：2026-11-02 两台设备各 3/3 复现）。不带 `-w` 时 am 拿到结果是立刻
    // 返回、不等 instrumentation 就绪，随后 uia2 建会话必报
    // "Got null UiAutomation from instrumentation"——因为 `Registering UiTestAutomationService`
    // 根本没发生（logcat 无该行）；带 `-w` 时必然出现该注册行、会话创建 3/3 成功。
    // 设备侧 `( ... &)` 后台化让 adb shell 立即返回（实测 77ms），不会阻塞 timeoutMs 预算；
    // 服务进程独立于被测 App，只有设备重启才需要重启服务。
    const cmd = `(am instrument -w -e serverPort ${DEVICE_PORT} io.appium.uiautomator2.server.test/androidx.test.runner.AndroidJUnitRunner >/dev/null 2>&1 &)`;
    await adb.shell(cmd, { timeoutMs: 10000 }).catch(() => {});
  }

  // 服务进程"存活但已残废"的自愈（2026-11-02 实证）：旧代码（无 `-w`）启动的服务进程会一直
  // 活着、/status 恒 `"ready":true`，但内部 a11y 从未注册 → 每次 POST /session 都 500
  // `Got null UiAutomation`。只看 status 的 ensure() 永远不会重启它，整轮跑只能退化 legacy。
  // 因此建会话 500 时记录一次，达到阈值就 force-stop + 按当前命令重启一次服务。
  let sessionFailures = 0;
  const SESSION_FAIL_RESTART = 2;

  async function restartServer() {
    log('uia2 服务存活但建会话连续失败，force-stop 后重启服务');
    await adb.shell('am force-stop io.appium.uiautomator2.server', { timeoutMs: 8000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    sessionId = null;
    await startServer();
    for (let i = 0; i < pollTries; i++) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      if (await status()) return true;
    }
    return false;
  }

  // 设备侧进程存活探测：比 HTTP /status 更确定（status 会因服务正忙而超时，
  // 而 pidof 不受负载影响）。用于区分"服务没起"与"服务在忙"。
  async function serverPid() {
    try {
      const out = await adb.shell('pidof io.appium.uiautomator2.server', { timeoutMs: 5000 });
      return String(out ?? '').trim() || null;
    } catch {
      return null; // 探测失败按"未知"处理，由调用方保守决策
    }
  }

  async function ensure() {
    if (Date.now() < deadUntil) return false;
    await forward().catch(() => {});
    if (await status()) return true;
    // 关键（2026-11-02 实证）：`am instrument` 会**先杀掉**同名旧进程再启动——对"正忙但
    // 健康"的服务重复调用等于自杀。logcat 铁证：
    //   Killing <pid>:io.appium.uiautomator2.server (adj 0): stop ... due to start instr
    // 实测该路径让健康服务被反复杀 25 次，legacy 三通道全败时直接整轮崩盘。
    // 因此：进程还活着就**绝不**重启，只在"进程确实不存在"时才 startServer。
    const pid = await serverPid();
    if (pid) {
      // 进程在，但 /status 没在 2.5s 内就绪：是在忙，不是在死。给它更长的等待窗口。
      for (let i = 0; i < pollTries; i++) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        if (await status()) return true;
      }
      // 等到窗口结束仍不就绪：此时才允许杀掉重启（服务可能真的卡死）
      log(`uia2 服务进程存活(pid ${pid})但 ${pollTries}s 内未就绪，重启服务`);
      await restartServer();
      return await status();
    }
    await startServer();
    for (let i = 0; i < pollTries; i++) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      if (await status()) return true;
    }
    deadUntil = Date.now() + 10 * 60_000;
    log(`uia2 服务不可达，${Math.round((deadUntil - Date.now()) / 60000)} 分钟内回退 legacy dump 通道`);
    return false;
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    const r = await httpRaw(hostP, '/wd/hub/session', { method: 'POST', body: JSON.stringify({ capabilities: { alwaysMatch: {} } }), timeoutMs: 10000 });
    if (r.status !== 200) {
      // 500 = 服务活着但 UiAutomation 拿不到（典型：服务由旧命令启动，a11y 未注册）。
      // 连续失败到阈值即重启服务一次；重启后仍失败才认定该设备真的不可用。
      if (r.status === 500 && ++sessionFailures >= SESSION_FAIL_RESTART) {
        sessionFailures = 0;
        if (await restartServer()) {
          const r2 = await httpRaw(hostP, '/wd/hub/session', { method: 'POST', body: JSON.stringify({ capabilities: { alwaysMatch: {} } }), timeoutMs: 10000 });
          if (r2.status === 200) {
            const j2 = JSON.parse(r2.body);
            sessionId = j2.value?.sessionId ?? null;
            if (sessionId) return sessionId;
          }
        }
      }
      throw new Error(`uia2 建会话失败: ${r.status}`);
    }
    sessionFailures = 0;
    const j = JSON.parse(r.body);
    sessionId = j.value?.sessionId ?? null;
    if (!sessionId) throw new Error('uia2 会话 id 缺失');
    return sessionId;
  }

  // 页面源（uiautomator dump 兼容格式，包在 JSON value 字段里）
  //
  // 超时预算 12s → 30s（2026-11-02 实证）：uia2 服务端取 /source 时内部仍会等一次
  // accessibility idle，busy 弹窗页（问卷提交、自愈尾）可达 15-25s。旧 12s 预算在这些
  // 关键时刻先超时，随即降级到 legacy——而 legacy 三通道在同类 busy 页**全败**
  // （实测 run-20261102-125547：8 个断言全灭，失败步 #7/#17/#18/#49 全是
  //  "uiautomator dump 三通道均无 hierarchy"），uia2 的意义恰好被超时抵消。
  // 30s 仍短于 legacy 的 50s file 通道，busy 页能救回来；健康页仍在 0.2-0.6s。
  const SOURCE_TIMEOUT_MS = 30000;
  async function source({ timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
    if (!(await ensure())) throw new Error('uia2 不可用');
    const attempt = async (sid) => {
      const r = await httpRaw(hostP, `/wd/hub/session/${sid}/source`, { timeoutMs });
      if (r.status !== 200) {
        const e = new Error(`uia2 source 失败: ${r.status}`);
        e.status = r.status;
        throw e;
      }
      return String(JSON.parse(r.body).value ?? '');
    };
    let sid = await ensureSession();
    try {
      return await attempt(sid);
    } catch (e) {
      // 404 = 会话失效（可自愈）；超时/断连 = 传输层慢或断（重建会话通常无益，但**不该
      // 立刻把整个通道判死**——这是 busy 页最常见的瞬时抖动）。两类都重建一次再试。
      sessionId = null;
      sid = await ensureSession();
      try {
        return await attempt(sid);
      } catch (e2) {
        sessionId = null;
        throw e2;
      }
    }
  }

  return {
    port: hostP,
    ensure,
    ensureSession,
    resetSession: () => { sessionId = null; },
    source,
    serverPid, // 设备侧进程探测（dumpXmlRaw 用它判定 UiAutomation 槽是否被占用）
  };
}
