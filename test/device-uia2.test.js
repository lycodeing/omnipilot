// uia2 通道单测：本地 stub http 服务器（临时端口 + DI 注入，无端口哈希碰撞）
// 覆盖：ensure→session→source 全链；拒连→ensure false→尝试启动 server→退避；
//       source 404→抛错并清 sessionId（下次 ensureSession 重建）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createUia2 } from '../src/device/uia2.js';

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="root" bounds="[0,0][100,200]"/></hierarchy>`;

async function stubOn(handlers) {
  const server = http.createServer((req, res) => {
    const h = handlers[req.url + ' ' + req.method] ?? handlers[req.url] ?? (() => { res.writeHead(404); res.end(); });
    h(req, res);
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return {
    port,
    close: () => { server.close(); server.closeAllConnections?.(); },
  };
}

const fakeAdb = (calls) => ({
  shell: async (cmd) => { calls.push(cmd); return ''; },
});

test('uia2：ensure→session→source 全链走通（DI 端口），返回 XML；二连调用走缓存会话', async () => {
  const calls = [];
  let sourceCount = 0;
  const { port, close } = await stubOn({
    '/wd/hub/status GET': (req, res) => { res.writeHead(200); res.end('{"value":{"ready":true,"message":"ok"}}'); },
    '/wd/hub/session POST': (req, res) => { res.writeHead(200); res.end('{"value":{"sessionId":"stub-sid"}}'); },
    '/wd/hub/session/stub-sid/source GET': (req, res) => { sourceCount++; res.writeHead(200); res.end(JSON.stringify({ value: XML })); },
  });
  try {
    const uia2 = createUia2({ adb: fakeAdb(calls), serial: 't', port, log: () => {}, readyPoll: { tries: 2, intervalMs: 1 } });
    const xml = await uia2.source();
    assert.ok(xml.includes('</hierarchy>'), '应返回 XML');
    const again = await uia2.source();
    assert.ok(again.includes('</hierarchy>'), '二连调用应命中缓存会话');
    assert.equal(sourceCount, 2);
    assert.equal(calls.length, 0, '显式端口不需要 adb forward');
  } finally { close(); }
});

test('uia2：status 连接被拒 → ensure 返回 false 而非抛错，尝试启动 server 并进入退避', async () => {
  const calls = [];
  const { port, close } = await stubOn({});
  try {
    const uia2 = createUia2({ adb: fakeAdb(calls), serial: 't', port, log: () => {}, readyPoll: { tries: 2, intervalMs: 1 } });
    const ok = await uia2.ensure();
    assert.equal(ok, false, '服务不可达应返回 false');
    assert.ok(calls.some((c) => c.includes('am instrument')), '应尝试启动 server');
    const before = calls.length;
    const ok2 = await uia2.ensure();
    assert.equal(ok2, false);
    assert.equal(calls.length, before, '退避期内不应重试');
  } finally { close(); }
});

test('uia2：source 404 → 抛错并清空 sessionId 重建', async () => {
  let created = 0;
  const { port, close } = await stubOn({
    '/wd/hub/status GET': (req, res) => { res.writeHead(200); res.end('{"value":{"ready":true}}'); },
    '/wd/hub/session POST': (req, res) => { created++; res.writeHead(200); res.end('{"value":{"sessionId":"sid-re"}}'); },
  });
  try {
    const uia2 = createUia2({ adb: fakeAdb([]), serial: 't', port, log: () => {}, readyPoll: { tries: 2, intervalMs: 1 } });
    await assert.rejects(() => uia2.source(), /404/);
    const sid = await uia2.ensureSession(); // sessionId 已被清空 → 重建
    assert.equal(sid, 'sid-re');
    assert.ok(created >= 2, '清 id 后 ensureSession 重建（首建 + 至少一次重建）');
  } finally { close(); }
});

// 回归（2026-11-02 真机实证）：uia2 服务在 App 重装/设备重连/服务重启后会让旧 sessionId 作废，
// 但 /status 仍 ready。旧实现只在下一轮 dump 才重建，导致当前轮白白降级 legacy（38-55s）并
// 进入 60s 退避——整轮跑因此退回 legacy 通道。修复：404 时清 id + 立即重建再取一次。
test('uia2：source 404 时立即重建会话并重取（不把可自愈的会话失效升级成一轮降级）', async () => {
  let sourceCalls = 0;
  const { port, close } = await stubOn({
    '/wd/hub/status GET': (req, res) => { res.writeHead(200); res.end('{"value":{"ready":true}}'); },
    '/wd/hub/session POST': (req, res) => { res.writeHead(200); res.end('{"value":{"sessionId":"stale"}}'); },
    '/wd/hub/session/stale/source GET': (req, res) => { sourceCalls++; res.writeHead(404); res.end('{}'); },
  });
  try {
    const uia2 = createUia2({ adb: fakeAdb([]), serial: 't', port, log: () => {}, readyPoll: { tries: 2, intervalMs: 1 } });
    // 首次 404 → 立即重建（stub 仍返回同一 sid）→ 再 404 → 抛错
    await assert.rejects(() => uia2.source(), /404/);
    assert.equal(sourceCalls, 2, '首次 404 后应立即用新会话重取一次（共 2 次 source 调用）');
  } finally { close(); }
});

// 回归（2026-11-02 真机实证，两台设备各 3/3 复现）：
// `am instrument` 不带 `-w` 时 am 立刻返回、不等 instrumentation 就绪，随后建会话必报
//   "Got null UiAutomation from instrumentation"（logcat 无 `Registering UiTestAutomationService` 行）。
// 带 `-w` 时该注册行必现、会话 3/3 成功。启动命令因此必须带 `-w` 且设备侧后台化（不阻塞 10s 预算）。
test('uia2：启动命令必须带 -w 且设备侧后台化（否则 UiAutomation 永不注册）', async () => {
  const calls = [];
  const { port, close } = await stubOn({});
  try {
    const uia2 = createUia2({ adb: fakeAdb(calls), serial: 't', port, log: () => {}, readyPoll: { tries: 2, intervalMs: 1 } });
    await uia2.ensure();
    const start = calls.find((c) => c.includes('am instrument'));
    assert.ok(start, '应尝试启动 server');
    assert.match(start, /am instrument\s+-w\s/, '必须带 -w（缺 -w 则 a11y 不注册、建会话必报 null UiAutomation）');
    assert.match(start, /^\s*\(\s*am instrument/, '设备侧需后台化，避免 adb shell 阻塞 10s 预算');
    assert.match(start, /&\s*\)\s*$/, '后台化需以 &) 收尾');
  } finally { close(); }
});

// 回归（2026-11-02 真机实证）：`adb shell forward tcp:X tcp:Y` 是在**设备**上找 forward 命令，
// 恒 exit 127（/system/bin/sh: forward: inaccessible or not found）→ 转发表从未建立，
// 所有 /wd/hub 请求连接被拒，uia2 全链静默退化为 legacy。必须走 host 侧 adb 子命令。
test('uia2：adb forward 必须走 host 侧通道（走 shell 会 exit 127 使转发永不建立）', async () => {
  // 注意：不能预先调用 hostPort(serial) 算端口——它每次调用都会在进程内占一个槽位，
  // 与 createUia2 内部派生的端口不是同一个。这里内联同样的哈希公式（usedPorts 为空时等价）。
  const shellCalls = [];
  const hostCalls = [];
  const serial = 'fwd-' + Date.now();
  let h = 0;
  for (const ch of serial) h = (h * 31 + ch.charCodeAt(0)) % 997;
  const port = 6790 + (h % 200);
  const adb = {
    shell: async (cmd) => { shellCalls.push(cmd); return ''; },
    host: async (args) => { hostCalls.push(args.join(' ')); return ''; },
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('{"value":{"ready":true}}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const uia2 = createUia2({ adb, serial, port: null, log: () => {}, readyPoll: { tries: 2, intervalMs: 1 } });
    assert.equal(uia2.port, port, '派生端口应与内联公式一致（usedPorts 未被本用例污染）');
    assert.equal(await uia2.ensure(), true);
    assert.ok(
      hostCalls.some((c) => c === `forward tcp:${port} tcp:6790`),
      `forward 应走 host 通道，实际 host 调用: ${JSON.stringify(hostCalls)}`,
    );
    assert.ok(
      !shellCalls.some((c) => c.startsWith('forward ')),
      `forward 不得走设备 shell（会 exit 127），实际 shell 调用: ${JSON.stringify(shellCalls)}`,
    );
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

// 回归（2026-11-02 真机实证）：旧代码（无 `-w`）启动的服务进程会一直活着、/status 恒 ready，
// 但内部 a11y 从未注册 → 每次 POST /session 都 500 "Got null UiAutomation"。只看 status 的
// ensure() 永远不会重启它，整轮跑只能退化 legacy（实测 5556 因此白跑一轮）。修复：建会话
// 连续 500 达阈值 → force-stop + 按当前命令重启服务一次。
test('uia2：建会话连续 500 → force-stop 并重启服务一次（存活但残废的服务可自愈）', async () => {
  const shellCalls = [];
  let statusCalls = 0;
  let sessionCalls = 0;
  // 前 2 次建会话返回 500（模拟残废服务），重启后的第 3 次返回成功
  const { port, close } = await stubOn({
    '/wd/hub/status GET': (req, res) => { statusCalls++; res.writeHead(200); res.end('{"value":{"ready":true}}'); },
    '/wd/hub/session POST': (req, res) => {
      sessionCalls++;
      if (sessionCalls <= 2) { res.writeHead(500); res.end('{"value":{"error":"session not created"}}'); return; }
      res.writeHead(200); res.end('{"value":{"sessionId":"healed"}}');
    },
    '/wd/hub/session/healed/source GET': (req, res) => { res.writeHead(200); res.end(JSON.stringify({ value: XML })); },
  });
  const adb = { shell: async (cmd) => { shellCalls.push(cmd); return ''; }, host: async () => '' };
  try {
    const uia2 = createUia2({ adb, serial: 't', port, log: () => {}, readyPoll: { tries: 2, intervalMs: 1 } });
    // 首次 500：只是计数（阈值 2），本轮失败
    await assert.rejects(() => uia2.source(), /建会话失败: 500/);
    assert.ok(!shellCalls.some((c) => c.includes('force-stop')), '首次失败不应立即重启（可能是瞬时故障）');
    // 第二次 500 达阈值 → 重启 → 第三次成功
    const xml = await uia2.source();
    assert.ok(xml.includes('</hierarchy>'), '重启后应成功取到 XML');
    assert.ok(
      shellCalls.some((c) => c.includes('force-stop io.appium.uiautomator2.server')),
      `应 force-stop 残废服务，实际 shell: ${JSON.stringify(shellCalls)}`,
    );
    assert.equal(sessionCalls, 3, '两次 500 + 重启后一次成功');
  } finally { close(); }
});

// 回归（2026-11-02 真机实证，logcat 铁证）：`am instrument` 会**先杀掉同名旧进程**再启动——
//   Killing <pid>:io.appium.uiautomator2.server (adj 0): stop ... due to start instr
// 对"正忙但健康"的服务重复调用等于自杀：实测健康服务被反复杀 25 次，legacy 三通道全败时
// 整轮崩盘（2378s / 6-9）。修复：进程还活着就绝不重启，只在 pidof 确认不存在时才启动。
test('uia2：进程存活但 /status 不就绪 → 不重启（避免 am instrument 自杀），只延长等待', async () => {
  const shellCalls = [];
  const adb = {
    shell: async (cmd) => {
      shellCalls.push(cmd);
      if (cmd.includes('pidof io.appium.uiautomator2.server')) return '12345\n'; // 进程活着
      return '';
    },
    host: async () => '',
  };
  // 端口不可达（status 恒 false）
  const { port, close } = await stubOn({});
  try {
    const uia2 = createUia2({ adb, serial: 't', port, log: () => {}, readyPoll: { tries: 2, intervalMs: 1 } });
    await uia2.ensure();
    const instr = shellCalls.filter((c) => c.includes('am instrument'));
    const forced = shellCalls.filter((c) => c.includes('force-stop'));
    // 进程活着 + status 不就绪：等到窗口超时后允许重启一次（restartServer 内含 force-stop + instrument）
    assert.equal(instr.length, 1, `不应重复 startServer（每次都会杀掉活着的服务），实际 ${instr.length} 次`);
    assert.ok(forced.length <= 1, `最多一次兜底重启，实际 ${forced.length} 次`);
  } finally { close(); }
});

// 对照：进程真的不存在时才允许直接启动
test('uia2：pidof 确认进程不存在 → 正常 startServer', async () => {
  const shellCalls = [];
  const adb = {
    shell: async (cmd) => {
      shellCalls.push(cmd);
      if (cmd.includes('pidof io.appium.uiautomator2.server')) return ''; // 无进程
      return '';
    },
    host: async () => '',
  };
  const { port, close } = await stubOn({});
  try {
    const uia2 = createUia2({ adb, serial: 't', port, log: () => {}, readyPoll: { tries: 1, intervalMs: 1 } });
    await uia2.ensure();
    assert.equal(shellCalls.filter((c) => c.includes('am instrument')).length, 1, '进程不存在时应启动一次');
    assert.equal(shellCalls.filter((c) => c.includes('force-stop')).length, 0, '进程不存在时无需 force-stop');
  } finally { close(); }
});
