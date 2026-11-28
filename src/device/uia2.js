// uia2 通道：httpRaw 监听 res error/aborted + 客户端整体 deadline 防半途断连挂起；
// hostPort 线性探测 + 模块级 usedPorts 防多设备并行哈希碰撞串台。
import http from 'node:http';
import { withKind } from './errors.js';

const DEVICE_PORT = 6790;
const usedPorts = new Set(); // 进程内已占用 host 端口（--parallel 多设备防哈希碰撞）

// serial → host 转发端口：哈希 + 线性探测（进程内去重；跨进程由 adb forward 表全局互斥兜底）
export function hostPort(serial) {
  let h = 0;
  for (const ch of String(serial)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  let p = 6790 + (h % 200);
  // 槽位耗尽必须有守卫：200 个槽全占时线性探测会绕圈死循环——
  // 这是同步函数里的无限循环，会卡死 event loop 且无法中断（无超时无报错）。
  // 与 rebindPort 的守卫保持一致。
  let probes = 0;
  while (usedPorts.has(p) && ++probes <= 200) p = p >= 6989 ? 6790 : p + 1;
  if (probes > 200) throw new Error('hostPort 端口耗尽（200 槽全占用）');
  usedPorts.add(p);
  return p;
}

const noKeepAgent = new http.Agent({ keepAlive: false }); // 共享 agent：keep-alive 池化 socket 会吊住测试进程的 event loop

function httpRaw(hostP, p, { method = 'GET', body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    // 整体 deadline：响应头已到但 body 半途断连时 end/error 都不触发，
    // 客户端限时兜底 + req.destroy；socket 级 timeout 只管 idle，管不住这种场景
    let settled = false;
    const req = http.request(
      { host: '127.0.0.1', port: hostP, path: p, method, headers: body ? { 'content-type': 'application/json' } : {}, timeout: timeoutMs, agent: noKeepAgent },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('error', (e) => { if (!settled) { settled = true; clearTimeout(deadline); reject(e); } });
        res.on('aborted', () => { if (!settled) { settled = true; clearTimeout(deadline); reject(withKind(new Error(`uia2 连接中断: ${p}`), 'connection')); } });
        res.on('end', () => { if (!settled) { settled = true; clearTimeout(deadline); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); } });
      },
    );
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      reject(withKind(new Error(`uia2 超时(${timeoutMs}ms): ${p}`), 'timeout'));
    }, timeoutMs);
    req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(deadline); reject(withKind(e, typeof e?.code === 'string' && e.code === 'ETIMEDOUT' ? 'timeout' : 'connection')); } });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// readyPoll：冷启动轮询参数（{ tries, intervalMs }）。默认 15×1s=15s——`-w` 启动到
// /status ready 需 5-9s（进程拉起 + a11y 注册 + netty 监听），预算过短会在临界点误判
// 不可达并进入退避。测试注入小值以免空等真实时间。
export function createUia2({ adb, serial, port = null, log = () => {}, readyPoll = {} } = {}) {
  // port 显式注入（测试 DI）优先；缺省按 serial 哈希+线性探测派生 host 转发端口
  let hostP = port ?? hostPort(serial);
  const pollTries = Number.isFinite(readyPoll.tries) ? readyPoll.tries : 15;
  const pollIntervalMs = Number.isFinite(readyPoll.intervalMs) ? readyPoll.intervalMs : 1000;
  let sessionId = null;
  let deadUntil = 0; // 探测失败后的退避期（期间 ensure 直接 false，走 legacy 通道）
  let bound = false;  // forward 已成功建立（粘性：健康后每个 dump 不再重跑 adb forward，
                      // Windows 上省一次 spawn 开销；status 拒连时重置重探）

  // 换下一个空闲 host 端口（bind 冲突时线性探测重试；旧槽释放）
  function rebindPort() {
    usedPorts.delete(hostP);
    let p = hostP >= 6989 ? 6790 : hostP + 1;
    let probes = 0;
    while (usedPorts.has(p) && ++probes <= 200) p = p >= 6989 ? 6790 : p + 1;
    if (probes > 200) throw new Error('hostPort 端口耗尽（200 槽全占用）');
    usedPorts.add(p);
    hostP = p;
  }

  async function forward() {
    if (port != null) return; // 显式端口=测试直连 stub，无需 adb forward
    // adb forward 是 **host 侧**子命令；走 adb.shell 会变成设备内执行 `forward` → exit 127，
    // 转发永远建不起来（此后所有 /wd/hub 请求连接被拒，uia2 全链退化为 legacy）。
    const args = ['forward', `tcp:${hostP}`, `tcp:${DEVICE_PORT}`];
    if (typeof adb.host === 'function') await adb.host(args, { timeoutMs: 8000 });
    else await adb.execOut(args, { timeoutMs: 8000, binary: false }); // 老注入执行器兜底
  }

  // forward + 串台防护：bind 失败**不得**吞掉——adb 的 forward
  // 监听按本地端口全局唯一，跨进程哈希撞端口时 status() 会命中**别台设备**的隧道，
  // 静默读错树。bind 失败 → 换端口重试一次 → 仍失败则 ensure 返回 false（不信任 status）。
  async function ensureForward() {
    if (port != null || bound) return true;
    try {
      await forward();
      bound = true;
      return true;
    } catch {
      try {
        rebindPort();
        await forward();
        bound = true;
        return true;
      } catch {
        return false; // 换端口也失败：本设备 uia2 不可用（绝不能去探测不明归属的端口）
      }
    }
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
    // `-w` 必须带：不带 `-w` 时 am 拿到结果立刻返回、不等 instrumentation 就绪，随后 uia2
    // 建会话必报 "Got null UiAutomation from instrumentation"——`Registering UiTestAutomationService`
    // 根本没发生（logcat 无该行）；带 `-w` 时必然出现该注册行、会话创建成功。
    // 设备侧 `( ... &)` 后台化让 adb shell 立即返回（77ms），不会阻塞 timeoutMs 预算；
    // 服务进程独立于被测 App，只有设备重启才需要重启服务。
    const cmd = `(am instrument -w -e serverPort ${DEVICE_PORT} io.appium.uiautomator2.server.test/androidx.test.runner.AndroidJUnitRunner >/dev/null 2>&1 &)`;
    await adb.shell(cmd, { timeoutMs: 10000 }).catch(() => {});
  }

  // 服务进程"存活但已残废"的自愈：无 `-w` 启动的服务进程会一直
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
    if (!(await ensureForward())) {
      deadUntil = Date.now() + 60_000;
      return false; // forward 建不起来（换端口也不行）：不可用，绝不探测不明归属的端口
    }
    if (await status()) return true;
    // status 拒连：转发可能失效（设备重连等），下次重建
    bound = false;
    // `am instrument` 会**先杀掉**同名旧进程再启动——对"正忙但健康"的服务重复调用等于自杀：
    //   Killing <pid>:io.appium.uiautomator2.server (adj 0): stop ... due to start instr
    // 因此：进程还活着就**绝不**重启，只在"进程确实不存在"时才 startServer。
    const pid = await serverPid();
    if (pid) {
      // 进程在，但 /status 没就绪：是在忙，不是在死（15s 窗口短于 busy 页
      // worst-case 38-55s，会在长 busy 期把正在出活的健康服务杀掉）。给 60s 墙钟预算，
      // 到点才允许按"卡死"重启。
      const busyDeadline = Date.now() + 60_000;
      let guard = 0;
      while (Date.now() < busyDeadline && guard++ < 300) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        if (await status()) return true;
      }
      // 等到窗口结束仍不就绪：此时才允许杀掉重启（服务可能真的卡死）
      log('uia2 服务进程存活但 60s 未就绪，按卡死重启服务');
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
      throw withKind(new Error(`uia2 建会话失败: ${r.status}`), 'protocol'); // 500=服务活但 UiAutomation 未注册（槽空闲），非传输故障
    }
    sessionFailures = 0;
    const j = JSON.parse(r.body);
    sessionId = j.value?.sessionId ?? null;
    if (!sessionId) throw new Error('uia2 会话 id 缺失');
    // 会话级 settings（Appium Settings API，server 10.6.6，settings 按**会话**生效）：
    // waitForIdleTimeout=0 跳过 a11y idle 盲等——busy WebView 页 source 从 4-30s 降到
    // 0.3-0.4s（openatx 出厂默认即 0）。失败不阻断：老 server 无此
    // 端点时仅退回旧行为。
    try {
      await httpRaw(hostP, `/wd/hub/session/${sessionId}/appium/settings`, {
        method: 'POST',
        body: JSON.stringify({ settings: { waitForIdleTimeout: 0 } }),
        timeoutMs: 5000,
      });
    } catch (e) {
      log(`settings 注入失败（不阻断）: ${String(e?.message ?? e).slice(0, 60)}`);
    }
    return sessionId;
  }

  // 页面源（uiautomator dump 兼容格式，包在 JSON value 字段里）
  //
  // 超时预算 30s：uia2 服务端取 /source 时内部仍会等一次
  // accessibility idle，busy 弹窗页（问卷提交、自愈尾）可达 15-25s，预算过短会先超时降级到
  // legacy——而 legacy 三通道在同类 busy 页**全败**，uia2 的意义恰好被超时抵消。
  // 30s 仍短于 legacy 的 50s file 通道，busy 页能救回来；健康页仍在 0.2-0.6s。
  const SOURCE_TIMEOUT_MS = 30000;
  async function source({ timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
    if (!(await ensure())) throw withKind(new Error('uia2 不可用'), 'unavailable'); // 服务没起来 = 槽空闲，legacy 可走
    const attempt = async (sid) => {
      const r = await httpRaw(hostP, `/wd/hub/session/${sid}/source`, { timeoutMs });
      if (r.status !== 200) {
        const e = new Error(`uia2 source 失败: ${r.status}`);
        e.status = r.status;
        throw withKind(e, 'protocol'); // HTTP 有应答但非 200：服务活着、槽空闲（与建会话 500 同语义）
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
    get port() { return hostP; }, // getter：rebind 换端口后外部读到的总是当前端口（值快照会读到旧端口）
    ensure,
    ensureSession,
    resetSession: () => { sessionId = null; },
    /** 重置退避状态并重新探测服务（APP 初始化 force-stop 后 uia2 进程被杀，需清除 deadUntil 才能重启） */
    async resetAndEnsure() {
      deadUntil = 0;
      bound = false;
      sessionId = null;
      return ensure();
    },
    source,
    serverPid, // 设备侧进程探测（dumpXmlRaw 用它判定 UiAutomation 槽是否被占用）
    // 释放资源：设备端会话（DELETE /wd/hub/session/:id）+ host 侧 adb forward。
    // 必须释放——Android 11 的 UiAutomation 注册槽是**独占**的，泄漏的会话会占住槽位，
    // 使 legacy `uiautomator dump` 通道以 rc=137 死掉（本模块依赖的兜底路径）；
    // adb forward 也会在 host 侧累积端口绑定。
    async dispose() {
      if (sessionId) {
        const sid = sessionId;
        sessionId = null;
        await httpRaw(hostP, `/wd/hub/session/${sid}`, { method: 'DELETE', timeoutMs: 3000 }).catch(() => {});
      }
      if (port == null && bound && typeof adb.host === 'function') {
        await adb.host(['forward', '--remove', `tcp:${hostP}`], { timeoutMs: 5000 }).catch(() => {});
        bound = false;
      }
      usedPorts.delete(hostP);   // 归还进程内端口槽
    },
  };
}
