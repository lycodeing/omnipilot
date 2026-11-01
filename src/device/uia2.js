// Appium uiautomator2 server 独立通道（调研落地，2026-11-01）：
// 设备内常驻 netty HTTP 服务（Am instrument 启动，与被测 App 生命周期无关），
// GET /source 直取 AccessibilityNodeInfo 树——不做 legacy uiautomator 的 idle 等待。
// 实测（API 30 x86 + busy uni-app 页）：157-958ms vs uiautomator dump 38-55s（快 40-250 倍）。
// 依赖：设备安装 appium-uiautomator2-server（server+test 两个 APK，v10.6.6 实测可用）；
// 未安装/服务死 → ensure() 返回 false，调用方回退 legacy 三通道（优雅降级）。
// 参考：https://github.com/appium/appium-uiautomator2-server
//       https://github.com/openatx/uiautomator2（无 Appium 单独使用的参考实现）

import http from 'node:http';

const DEVICE_PORT = 6790;

// serial → host 转发端口（多设备并行：每台一个 host 端口，6790 起按 serial 哈希偏移）
export function hostPort(serial) {
  let h = 0;
  for (const ch of String(serial)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return 6790 + (h % 200);
}

const noKeepAgent = new http.Agent({ keepAlive: false }); // 共享 agent：keep-alive 池化 socket 会吊住测试进程的 event loop

function httpRaw(hostP, p, { method = 'GET', body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: hostP, path: p, method, headers: body ? { 'content-type': 'application/json' } : {}, timeout: timeoutMs, agent: noKeepAgent },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`uia2 超时(${timeoutMs}ms): ${p}`)));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

export function createUia2({ adb, serial, port = null, log = () => {} } = {}) {
  // port 显式注入（测试 DI）优先；缺省按 serial 哈希派生 host 转发端口
  const hostP = port ?? hostPort(serial);
  let sessionId = null;
  let deadUntil = 0; // 探测失败后的退避期（期间 ensure 直接 false，走 legacy 通道）
  let started = false;

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
    started = false; // 允许下次重试真正的 startServer
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
    invalidate: () => { deadUntil = 0; started = false; },
  };
}
