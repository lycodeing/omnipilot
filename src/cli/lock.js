// 设备独占锁（§13.2.1）：<lockDir>/<serial>.lock 存 {pid, ts, serial}。
// 属主存活 → 拒绝；属主已退出但未过 staleMs → 拒绝（防误清正在退出的进程）；
// 超过 staleMs → 自动清理后接管。从 bin/ask.js 抽出以便单测。

import fs from 'node:fs';
import path from 'node:path';

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function lockDir(root) { return path.join(root, '.ask', 'locks'); }
export function lockPath(root, serial) {
  return path.join(lockDir(root), `${String(serial).replace(/[^\w.-]/g, '_')}.lock`);
}

export function acquireLock(root, serial, { staleMs = 10 * 60_000, now = Date.now, pid = process.pid } = {}) {
  const p = lockPath(root, serial);
  fs.mkdirSync(lockDir(root), { recursive: true });
  // 互斥由 O_EXCL（'wx'）原子创建保证——旧实现"existsSync 检查 → writeFileSync 写入"
  // 两步之间无原子性，两个进程同时启动会双双拿到锁（评审 Important 修复）
  let fd;
  try {
    fd = fs.openSync(p, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // 锁已存在：区分 属主存活 / 未到清理期（含文件损坏——属主可能刚创建还没写入，
    // 用 mtime 做保守判断）/ 死进程已过期（清掉后重试一次）
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { rec = null; }
    if (rec && Number.isFinite(rec.pid) && pidAlive(rec.pid)) {
      return { ok: false, reason: `设备 ${serial} 正被 PID ${rec.pid} 占用（lock: ${p}）` };
    }
    let age;
    if (rec && Number.isFinite(rec.ts)) {
      age = now() - rec.ts;
    } else {
      // 文件损坏或尚未写全：以 mtime 为准，未到清理期不得接管（防偷走活进程的新锁）
      try { age = now() - fs.statSync(p).mtimeMs; } catch { age = 0; }
    }
    if (Number.isFinite(age) && age < staleMs) {
      return { ok: false, reason: `设备 ${serial} 的锁属主已退出但未到清理期（${Math.ceil((staleMs - age) / 1000)}s 后可自动清理）` };
    }
    try { fs.rmSync(p); } catch { /* 删不掉 → 下面的 wx 会再失败并拒绝 */ }
    try {
      fd = fs.openSync(p, 'wx');
    } catch (e2) {
      if (e2.code === 'EEXIST') {
        return { ok: false, reason: `设备 ${serial} 的锁正被其它进程接管（lock: ${p}）` };
      }
      throw e2;
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid, ts: now(), serial }));
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true, path: p };
}

export function releaseLock(root, serial) {
  const p = lockPath(root, serial);
  try {
    const { pid } = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (pid === process.pid) fs.rmSync(p);
  } catch { /* ignore */ }
}
