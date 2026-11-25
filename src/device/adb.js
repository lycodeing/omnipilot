// adb 执行器：同设备命令串行队列 + 单命令超时 + 断连一次自动重连（§4）
// 支持 shell（文本）与 exec-out（二进制，screencap 用）双通道
import { spawn } from 'node:child_process';

const DISCONNECT_RE =
  /device\s+(offline|not found|unauthorized|detached|disconnected)|no devices|emulator not found|not connected|error:\s*closed|connection reset|cannot connect/i;

const DEFAULT_TIMEOUTS = { command: 15000, dump: 25000, screencap: 15000, connect: 10000 };

// adb 可执行名按平台派生：Windows 优先 adb.exe（原生 cmd/PowerShell 不认无扩展名的 adb；
// Git Bash 下 PATH 里的 adb 也通常指向 adb.exe，故 .exe 在两处都可用）
export function defaultAdbPath() {
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

// 注入执行器（测试用）签名：async (args, { timeoutMs, binary }) => { code, stdout: string|Buffer, stderr }
export class Adb {
  constructor({ serial, adbPath = process.env.ASK_ADB || defaultAdbPath(), timeouts = {}, exec = null } = {}) {
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
    // 注入执行器路径（测试/自定义）：exec 本身无超时能力，这里用 race 强制预算
    // （真实 spawn 路径由下方内部定时器负责——它持有 child 句柄能 kill）
    if (this._exec) {
      const budget = timeoutMs ?? this.timeouts.command;
      return new Promise((resolve, reject) => {
        let timer = null;
        if (budget) {
          timer = setTimeout(() => {
            const e = new Error(`adb 命令超时(${budget}ms): adb ${args.join(' ')}`);
            e.code = 'ETIMEDOUT';
            reject(e);
          }, budget);
        }
        Promise.resolve()
          .then(() => this._exec(args, { binary, timeoutMs: budget }))
          .then((r) => { if (timer) clearTimeout(timer); resolve(r); }, (e) => { if (timer) clearTimeout(timer); reject(e); });
      });
    }
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

  _looksDisconnected(res) {
    if (!res || res.code === 0) return false;
    if (typeof res.stdout !== 'string') return DISCONNECT_RE.test(String(res.stderr ?? ''));
    return DISCONNECT_RE.test(`${res.stdout}\n${res.stderr}`);
  }

  // 串行队列：同设备命令排队执行；断连时重连一次后重试一次。
  // 超时统一由 _runRaw 内部定时器负责（它持有 child 句柄能 kill）；旧实现外层再包
  // _withTimeout 的 race：到点只 reject 不 kill，泄漏的 adb.exe 子进程会在设备侧与
  // 下一条命令交错（低概率高危害）。
  _enqueue(args, opts = {}) {
    const task = async () => {
      let res = await this._runRaw(args, opts);
      if (this._looksDisconnected(res) && !opts.retried) {
        await this.reconnect().catch(() => {});
        res = await this._runRaw(args, opts);
      }
      return res;
    };
    const p = this._queue.then(task, task);
    this._queue = p.then(() => {}, () => {});
    return p;
  }

  // TCP 序列号用 connect，USB 用 reconnect offline。
  // in-flight 去重：队列中多条命令相继判定断连时共享同一次 reconnect（旧实现会并发多次）。
  async reconnect() {
    if (this._reconnecting) return this._reconnecting;
    const args = String(this.serial).includes(':') ? ['connect', this.serial] : ['reconnect', 'offline'];
    this._reconnecting = this._runRaw(args, { timeoutMs: this.timeouts.connect })
      .finally(() => { this._reconnecting = null; });
    return this._reconnecting;
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
          const m = /(?:Override|Physical) size:\s*(\d+)x(\d+)/.exec(sizeOut);
          if (m) {
            // 回传解析好的尺寸：createDevice 用它 seed sizeCache，免首次 getSize 再打一次 wm size
            return { ready: true, waitedMs: Date.now() - t0, reason: null, size: { w: Number(m[1]), h: Number(m[2]) } };
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
  // withCode=true 时额外返回 { code }——判定写操作是否真的生效需要退出码：
  // input tap 失败（如缺 INJECT_EVENTS 权限）时 stdout 为空、错误在 stderr，
  // 不看退出码就会把失败当成功，报出误导性的诊断。
  async shell(cmd, { timeoutMs, withStderr = false, withCode = false } = {}) {
    const res = await this._enqueue(this._withSerial(['shell', cmd]), { timeoutMs: timeoutMs ?? this.timeouts.command });
    const stdout = typeof res.stdout === 'string' ? res.stdout : Buffer.from(res.stdout ?? '').toString('utf8');
    if (withCode) {
      const stderr = String(res.stderr ?? '');
      return withStderr
        ? { stdout, stderr, code: res.code ?? 0 }
        : { stdout, code: res.code ?? 0 };
    }
    if (withStderr) return { stdout, stderr: String(res.stderr ?? '') };
    return stdout;
  }

  // host 侧子命令（forward / reverse / devices …）：不加 `shell` 前缀。
  // 必须与 shell() 区分——`adb shell forward …` 是在**设备**上找 forward 命令，恒失败(127)。
  async host(args, { timeoutMs, binary = false } = {}) {
    const res = await this._enqueue(this._withSerial(args), { timeoutMs: timeoutMs ?? this.timeouts.command, binary });
    if (res.code !== 0) {
      throw new Error(`adb ${args[0]} 失败(exit ${res.code}): ${String(res.stderr ?? '').trim()}`);
    }
    return binary ? res.stdout : Buffer.from(res.stdout ?? '').toString('utf8');
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
