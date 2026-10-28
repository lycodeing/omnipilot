// adb 执行器：同设备命令串行队列 + 单命令超时 + 断连一次自动重连（§4）
// 支持 shell（文本）与 exec-out（二进制，screencap 用）双通道
import { spawn } from 'node:child_process';

const DISCONNECT_RE =
  /device\s+(offline|not found|unauthorized|detached|disconnected)|no devices|emulator not found|not connected|error:\s*closed|connection reset|cannot connect/i;

const DEFAULT_TIMEOUTS = { command: 15000, dump: 25000, screencap: 15000, connect: 10000 };

// 注入执行器（测试用）签名：async (args, { timeoutMs, binary }) => { code, stdout: string|Buffer, stderr }
export class Adb {
  constructor({ serial, adbPath = process.env.ASK_ADB || 'adb', timeouts = {}, exec = null } = {}) {
    this.serial = serial ?? '';
    this.adbPath = adbPath;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this._exec = exec;
    this._queue = Promise.resolve();
  }

  _withSerial(args) {
    return this.serial ? ['-s', this.serial, ...args] : [...args];
  }

  _runRaw(args, { binary = false, timeoutMs } = {}) {
    if (this._exec) return Promise.resolve().then(() => this._exec(args, { binary }));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.adbPath, args, { windowsHide: true });
      } catch (e) {
        return reject(e);
      }
      const out = [];
      const errOut = [];
      let done = false;
      // 单命令预算：调用方可传 timeoutMs（如 dump 25s），否则用全局 command 预算
      const budget = timeoutMs ?? this.timeouts.command;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill(); } catch {}
        const e = new Error(`adb 命令超时(${budget}ms): adb ${args.join(' ')}`);
        e.code = 'ETIMEDOUT';
        reject(e);
      }, budget);
      child.stdout?.on('data', (d) => out.push(d));
      child.stderr?.on('data', (d) => errOut.push(d));
      child.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const stdout = binary ? Buffer.concat(out) : Buffer.concat(out).toString('utf8');
        resolve({ code: code ?? -1, stdout, stderr: Buffer.concat(errOut).toString('utf8') });
      });
    });
  }

  _withTimeout(factory, timeoutMs, label) {
    if (!timeoutMs) return factory();
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`adb 命令超时(${timeoutMs}ms): adb ${label}`);
        e.code = 'ETIMEDOUT';
        reject(e);
      }, timeoutMs);
    });
    return Promise.race([factory(), guard]).finally(() => clearTimeout(timer));
  }

  _looksDisconnected(res) {
    if (!res || res.code === 0) return false;
    if (typeof res.stdout !== 'string') return DISCONNECT_RE.test(String(res.stderr ?? ''));
    return DISCONNECT_RE.test(`${res.stdout}\n${res.stderr}`);
  }

  // 串行队列：同设备命令排队执行；断连时重连一次后重试一次
  _enqueue(args, opts = {}) {
    const task = async () => {
      let res = await this._withTimeout(() => this._runRaw(args, opts), opts.timeoutMs, args.join(' '));
      if (this._looksDisconnected(res) && !opts.retried) {
        await this.reconnect().catch(() => {});
        res = await this._withTimeout(() => this._runRaw(args, opts), opts.timeoutMs, args.join(' '));
      }
      return res;
    };
    const p = this._queue.then(task, task);
    this._queue = p.then(() => {}, () => {});
    return p;
  }

  // TCP 序列号用 connect，USB 用 reconnect offline
  async reconnect() {
    const args = String(this.serial).includes(':') ? ['connect', this.serial] : ['reconnect', 'offline'];
    await this._withTimeout(() => this._runRaw(args, {}), this.timeouts.connect, args.join(' '));
  }

  async ensureConnected() {
    try {
      await this._enqueue(this._withSerial(['get-state']), { timeoutMs: this.timeouts.connect });
      return true;
    } catch (e) {
      if (!String(this.serial).includes(':')) throw e;
      await this.reconnect();
      await this._enqueue(this._withSerial(['get-state']), { timeoutMs: this.timeouts.connect });
      return true;
    }
  }

  // 等待设备系统服务就绪（冷启动窗口）。判定两项：sys.boot_completed=1 且 wm size 可读。
  // 满足即返回；超时返回 { ready:false, reason } 而不抛错（由调用方决定是否降级）。
  async waitForBoot({ timeoutMs = 60_000, intervalMs = 1000 } = {}) {
    const t0 = Date.now();
    let lastReason = '未探测';
    while (Date.now() - t0 < timeoutMs) {
      try {
        const boot = (await this.shell('getprop sys.boot_completed', { timeoutMs: this.timeouts.command })).trim();
        if (boot === '1') {
          const sizeOut = await this.shell('wm size', { timeoutMs: this.timeouts.command });
          if (/Override size:\s*\d+x\d+|Physical size:\s*\d+x\d+/.test(sizeOut)) {
            return { ready: true, waitedMs: Date.now() - t0, reason: null };
          }
          lastReason = 'boot_completed=1 但 wm size 尚无有效输出';
        } else {
          lastReason = `sys.boot_completed=${boot || '(空)'}`;
        }
      } catch (e) {
        lastReason = `探测异常: ${String(e?.message ?? e).slice(0, 80)}`;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ready: false, waitedMs: Date.now() - t0, reason: `等待设备就绪超时(${timeoutMs}ms)：${lastReason}` };
  }

  // 文本通道：不因远端命令退出码非 0 而抛错（如 pidof 无进程返回 1）
  // withStderr=true 时返回 { stdout, stderr }（判定成败需看 stderr 的场景，如 net 命令不存在）
  async shell(cmd, { timeoutMs, withStderr = false } = {}) {
    const res = await this._enqueue(this._withSerial(['shell', cmd]), { timeoutMs: timeoutMs ?? this.timeouts.command });
    const stdout = typeof res.stdout === 'string' ? res.stdout : Buffer.from(res.stdout ?? '').toString('utf8');
    if (withStderr) return { stdout, stderr: String(res.stderr ?? '') };
    return stdout;
  }

  // 二进制通道：返回原始 Buffer（screencap 用）
  async execOut(args, { timeoutMs, binary = true } = {}) {
    const res = await this._enqueue(this._withSerial(args), { timeoutMs: timeoutMs ?? this.timeouts.command, binary });
    if (res.code !== 0) throw new Error(`adb exec-out 失败(exit ${res.code}): ${String(res.stderr ?? '').trim()}`);
    return binary ? res.stdout : Buffer.from(res.stdout ?? '');
  }

  async push(local, remote, { timeoutMs } = {}) {
    const res = await this._enqueue(this._withSerial(['push', local, remote]), { timeoutMs: timeoutMs ?? this.timeouts.command });
    if (res.code !== 0) throw new Error(`adb push 失败: ${String(res.stderr ?? '').trim()}`);
    return true;
  }
}
