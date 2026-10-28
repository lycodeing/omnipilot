// 文本输入 yadb 路径（§5.4.5）：input text 对中文静默失败，统一走 yadb
// 首次推送 vendor/yadb → /data/local/tmp/ + chmod；-keyboardClear 清空 → -keyboard 输入 → 回读校验
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export const YADB_REMOTE = '/data/local/tmp/yadb';

function defaultLocalPath() {
  return fileURLToPath(new URL('../../vendor/yadb', import.meta.url));
}

// 单引号包裹；文本含单引号时按 '\'' 转义（§5.4.5 要点 5）
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function yadbKeyboardCommand(remote, text) {
  return `app_process -Djava.class.path=${remote} ${dirname(remote)} com.ysbing.yadb.Main -keyboard ${shellQuote(text)}`;
}

export function yadbClearCommand(remote) {
  return `app_process -Djava.class.path=${remote} ${dirname(remote)} com.ysbing.yadb.Main -keyboardClear`;
}

export class Yadb {
  constructor(adb, { localPath = defaultLocalPath(), remote = YADB_REMOTE } = {}) {
    this.adb = adb;
    this.localPath = localPath;
    this.remote = remote;
    this._ready = false;
  }

  // 首次推送 + chmod；成功后用 ready 标志复用
  async ensureReady() {
    if (this._ready) return;
    const ls = await this.adb.shell(`ls ${this.remote}`).catch(() => '');
    if (!String(ls).includes(this.remote)) {
      await this.adb.push(this.localPath, this.remote);
      await this.adb.shell(`chmod 755 ${this.remote}`);
    }
    this._ready = true;
  }

  async type(text) {
    await this.ensureReady();
    return this.adb.shell(yadbKeyboardCommand(this.remote, String(text ?? '')));
  }

  async clear() {
    await this.ensureReady();
    return this.adb.shell(yadbClearCommand(this.remote));
  }
}

// 回读：找包含该点的最小节点，取其 text（回读校验强制，§5.4.5）
export function findNodeAtPoint(flat, [x, y]) {
  let best = null;
  let bestArea = Infinity;
  for (const n of flat) {
    const [l, t, r, b] = n.bounds;
    if (x >= l && x <= r && y >= t && y <= b) {
      const a = (r - l) * (b - t);
      if (a < bestArea) {
        best = n;
        bestArea = a;
      }
    }
  }
  return best;
}

export function readTextAt(flat, point) {
  const n = findNodeAtPoint(flat, point);
  if (!n) return null;
  return n.text ?? ''; // 只回读 text；content-desc 是提示语不是输入内容
}
