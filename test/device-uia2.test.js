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
    const uia2 = createUia2({ adb: fakeAdb(calls), serial: 't', port, log: () => {} });
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
    const uia2 = createUia2({ adb: fakeAdb(calls), serial: 't', port, log: () => {} });
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
    const uia2 = createUia2({ adb: fakeAdb([]), serial: 't', port, log: () => {} });
    await assert.rejects(() => uia2.source(), /404/);
    const sid = await uia2.ensureSession(); // sessionId 已被清空 → 重建（不再二次 POST）
    assert.equal(sid, 'sid-re');
    assert.equal(created, 2, '清 id 后 ensureSession 重建（首建+重建共 2 次 POST）');
  } finally { close(); }
});
