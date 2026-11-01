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

export function createUia2({ adb, serial, port = null, log = () => {} } = {}) {
  // port 显式注入（测试 DI）优先；缺省按 serial 哈希+线性探测派生 host 转发端口
  const hostP = port ?? hostPort(serial);
  let sessionId = null;
  let deadUntil = 0; // 探测失败后的退避期（期间 ensure 直接 false，走 legacy 通道）

  async function forward() {
    if (port != null) return; // 显式端口=测试直连 stub，无需 adb forward
    await adb.shell(`forward tcp:${hostP} tcp:${DEVICE_PORT}`, { timeoutMs: 8000 });
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
    // am instrument（不带 -w）异步启动常驻服务；进程独立于被测 App，设备重启才需要重启服务
    await adb.shell(`am instrument -e serverPort ${DEVICE_PORT} io.appium.uiautomator2.server.test/androidx.test.runner.AndroidJUnitRunner`, { timeoutMs: 10000 }).catch(() => {});
  }

  async function ensure() {
    if (Date.now() < deadUntil) return false;
    await forward().catch(() => {});
    if (await status()) return true;
    await startServer();
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 800));
      if (await status()) return true;
    }
    deadUntil = Date.now() + 10 * 60_000;
    log(`uia2 服务不可达，${Math.round((deadUntil - Date.now()) / 60000)} 分钟内回退 legacy dump 通道`);
    return false;
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    const r = await httpRaw(hostP, '/wd/hub/session', { method: 'POST', body: JSON.stringify({ capabilities: { alwaysMatch: {} } }), timeoutMs: 10000 });
    if (r.status !== 200) throw new Error(`uia2 建会话失败: ${r.status}`);
    const j = JSON.parse(r.body);
    sessionId = j.value?.sessionId ?? null;
    if (!sessionId) throw new Error('uia2 会话 id 缺失');
    return sessionId;
  }

  // 页面源（uiautomator dump 兼容格式，包在 JSON value 字段里）
  async function source() {
    if (!(await ensure())) throw new Error('uia2 不可用');
    const sid = await ensureSession();
    let r;
    try {
      r = await httpRaw(hostP, `/wd/hub/session/${sid}/source`, { timeoutMs: 12000 });
    } catch (e) {
      sessionId = null; // 网络/会话异常：下轮重建会话
      throw e;
    }
    if (r.status !== 200) {
      sessionId = null;
      throw new Error(`uia2 source 失败: ${r.status}`);
    }
    return String(JSON.parse(r.body).value ?? '');
  }

  return {
    port: hostP,
    ensure,
    ensureSession,
    resetSession: () => { sessionId = null; },
    source,
  };
}
