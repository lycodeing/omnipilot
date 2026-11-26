// 设备锁（§13.2.1）：exclusive 锁 <lockDir>/<serial>.lock 存 {pid, ts, serial}；
// shared 读锁 <lockDir>/<serial>.shared-<pid>.lock 存 {pid, ts, serial, mode:'shared'}，
// 同设备多进程可共存，供 ask 只读问答并发使用。属主存活 → 拒绝；属主已退出但未过
// staleMs → 拒绝（防误清正在退出的进程）；超过 staleMs → 自动清理后接管。
// 从 bin/ask.js 抽出以便单测。

import fs from 'node:fs';
import path from 'node:path';

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function lockDir(root) { return path.join(root, '.ask', 'locks'); }
export function lockPath(root, serial) {
  return path.join(lockDir(root), `${String(serial).replace(/[^\w.-]/g, '_')}.lock`);
}
// shared 读锁按 pid 分文件：<serial>.shared-<pid>.lock，同设备多个读锁互不冲突。
export function sharedLockPath(root, serial, pid) {
  return path.join(lockDir(root), `${String(serial).replace(/[^\w.-]/g, '_')}.shared-${pid}.lock`);
}

export function acquireLock(root, serial, { staleMs = 10 * 60_000, now = Date.now, pid = process.pid, mode = 'exclusive' } = {}) {
  fs.mkdirSync(lockDir(root), { recursive: true });
  if (mode === 'shared') {
    // exclusive 存活 → 拒绝（读锁不得与独占锁并存）
    const exPath = lockPath(root, serial);
    try {
      const rec = JSON.parse(fs.readFileSync(exPath, 'utf8'));
      if (rec && Number.isFinite(rec.pid) && pidAlive(rec.pid)) {
        return { ok: false, reason: `设备 ${serial} 正被 PID ${rec.pid} 独占（exclusive 锁）` };
      }
    } catch { /* 无 exclusive 锁或属主已退出 */ }
    const p = sharedLockPath(root, serial, pid);
    let fd;
    try { fd = fs.openSync(p, 'wx'); }
    catch (e) {
      if (e.code === 'EEXIST') return { ok: true, path: p }; // 本进程已持有该读锁
      throw e;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid, ts: now(), serial, mode: 'shared' })); }
    finally { fs.closeSync(fd); }
    return { ok: true, path: p };
  }
  // exclusive：先扫存活 shared 锁（任一属主存活即拒绝）
  const prefix = `${String(serial).replace(/[^\w.-]/g, '_')}.shared-`;
  let files = [];
  try { files = fs.readdirSync(lockDir(root)); } catch { files = []; }
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const fp = path.join(lockDir(root), f);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { rec = null; }
    if (rec && Number.isFinite(rec.pid) && pidAlive(rec.pid)) {
      return { ok: false, reason: `设备 ${serial} 正被 PID ${rec.pid} 以 shared 读锁占用` };
    }
    // 死进程 shared 锁：超 staleMs 清理（损坏/新鲜文件保守保留，不误删活锁）
    let age;
    if (rec && Number.isFinite(rec.ts)) age = now() - rec.ts;
    else { try { age = now() - fs.statSync(fp).mtimeMs; } catch { age = 0; } }
    if (age >= staleMs) { try { fs.rmSync(fp); } catch { /* ignore */ } }
  }
  // exclusive 既有逻辑：O_EXCL（'wx'）原子创建 <serial>.lock → 写 {pid,ts,serial} → 返回 {ok:true,path}
  const p = lockPath(root, serial);
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

export function releaseLock(root, serial, { mode = 'exclusive', pid = process.pid } = {}) {
  if (mode === 'shared') {
    // 只删本进程的读锁文件，绝不动他人持有的 shared 锁
    try { fs.rmSync(sharedLockPath(root, serial, pid)); } catch { /* ignore */ }
    return;
  }
  const p = lockPath(root, serial);
  try {
    const { pid: owner } = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (owner === process.pid) fs.rmSync(p);
  } catch { /* ignore */ }
}
