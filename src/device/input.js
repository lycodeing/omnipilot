// 文本输入 yadb 路径（§5.4.5）：input text 对中文静默失败，统一走 yadb
// 首次推送 vendor/yadb → /data/local/tmp/ + chmod；-keyboardClear 清空 → -keyboard 输入 → 回读校验
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { isZeroAreaBounds } from './uitree.js';

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
    // 必须看退出码而非 stdout 子串：ls 对不存在的文件会把
    // "ls: /path: No such file or directory" 打到 stdout——其中含路径本身，
    // 子串匹配会误判为"已存在"→ 跳过 push → 后续输入命令对着不存在的二进制
    // 执行，文本输入静默失效（错误表象在回读校验，与真因无关）。
    const { code } = await this.adb.shell(`ls ${this.remote}`, { withCode: true }).catch(() => ({ code: 1 }));
    if (code !== 0) {
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

  // 清空+输入合并为一条 adb shell（性能）：省一次 spawn+队列等待。
  // 语义不变：先 keyboardClear 再 keyboard（同一 shell 内顺序执行）。
  async clearAndType(text) {
    await this.ensureReady();
    const cmd = `${yadbClearCommand(this.remote)}; ${yadbKeyboardCommand(this.remote, String(text ?? ''))}`;
    return this.adb.shell(cmd);
  }
}

// 回读：找包含该点的最小节点，取其 text（回读校验强制，§5.4.5）。
// 零面积节点跳过：bounds=[0,0,0,0] 只有点恰为 (0,0) 才命中，且 area=0 会赢过一切真实节点，
// 导致输入实际成功却判「回读失败」。WebView 零面积输入框由上游 locate 的 inWebView 标记处理。
export function findNodeAtPoint(flat, [x, y]) {
  let best = null;
  let bestArea = Infinity;
  for (const node of flat) {
    if (isZeroAreaBounds(node)) continue; // 零面积不参与点∈bounds 判定
    const [left, top, right, bottom] = node.bounds;
    if (x >= left && x <= right && y >= top && y <= bottom) {
      const nodeArea = (right - left) * (bottom - top);
      if (nodeArea < bestArea) {
        best = node;
        bestArea = nodeArea;
      }
    }
  }
  return best;
}

export function readTextAt(flat, point) {
  const n = findNodeAtPoint(flat, point);
  if (!n) return null;
  // 密码框：a11y text 常是掩码串或恒空，且可能含真实凭据（部分 ROM）。
  // 一律返回等长掩码串，不把节点 text 透出到回读结果/报错文案（凭据回读面脱敏）。
  if (n.password) return '\u2022'.repeat(String(n.text ?? '').length);
  return n.text ?? ''; // 只回读 text；content-desc 是提示语不是输入内容
}
