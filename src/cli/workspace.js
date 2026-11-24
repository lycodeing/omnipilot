// 运行时工作区解析：把"运行状态产物"与"项目源码"分离。
//
// 布局（默认）：
//   <ASK_HOME>/<日期>/<instance>/
//     ├── case/      用例文件（YAML / 自然语言）
//     ├── run/       运行记录 runs/<runId>.json + <runId>/step-*.png
//     ├── report/    生成的 HTML 报告
//     ├── dataset/   data_extract 落库（jsonl + schema）
//     └── .ask/      per-instance 私有状态（ui-dump 取证等）
//   <ASK_HOME>/.ask/
//     ├── locks/     设备独占锁（★ 必须全局：跨 instance 共享，否则锁失效）
//     └── family-probe.json  模型家族坐标探测缓存（设备属性，全局复用）
//
// ASK_HOME 默认：win32 → C:/opt/omni-pilot（Git Bash 下等价的 /c/opt/omni-pilot）；
// 其他平台 → 优先 /opt/omni-pilot（存在且可写时），否则回退 ~/.local/share/omni-pilot
// （非 root 在 Linux/macOS 上通常无 /opt 写权限，硬编码会导致工作区创建静默失败）
//
// ASK_WORKSPACE 可直接钉死整个 instance 目录（测试 / CI 用）；ASK_DATE / ASK_INSTANCE 分别覆盖日期与实例名。

import path from 'node:path';
import fs from 'node:fs';

export const DEFAULT_HOME = pickDefaultHome();
export const DEFAULT_INSTANCE = 'instance';

function pickDefaultHome() {
  // 平台缺省（2026-11-10 评审 #13）：环境路径不再无条件写死——
  //   win32：沿用历史 C:/opt/omni-pilot **仅当已存在**（兼容既有工作区与历史 run），
  //          否则回退用户目录 ~/.local/share/omni-pilot；全新机器不再往 C:/opt 落盘
  //   unix：优先 /opt/omni-pilot（存在且可写），否则 ~/.local/share/omni-pilot
  // ASK_HOME / ASK_WORKSPACE 仍可完全覆盖。
  const fallbackHome = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.local', 'share', 'omni-pilot');
  if (process.platform === 'win32') {
    const legacy = 'C:/opt/omni-pilot';
    try {
      if (fs.existsSync(legacy)) return legacy;
    } catch { /* 探测失败走回退 */ }
    return fallbackHome;
  }
  const preferred = '/opt/omni-pilot';
  try {
    // 父目录可写（或目标已存在且可写）才采用 /opt
    const target = fs.existsSync(preferred) ? preferred : path.dirname(preferred);
    fs.accessSync(target, fs.constants.W_OK);
    return preferred;
  } catch {
    return fallbackHome;
  }
}

export function formatDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 解析工作区路径（纯函数：只有显式传入 ASK_WORKSPACE 时才 resolve 绝对化）
export function resolveWorkspace({ home, date, instance, env = process.env, now = new Date() } = {}) {
  const base = home || env.ASK_HOME || DEFAULT_HOME;
  const d = date || env.ASK_DATE || formatDate(now);
  const inst = instance || env.ASK_INSTANCE || DEFAULT_INSTANCE;
  const root = env.ASK_WORKSPACE ? path.resolve(env.ASK_WORKSPACE) : path.join(base, d, inst);
  return {
    base,
    date: d,
    instance: inst,
    root,
    caseDir: path.join(root, 'case'),
    runDir: path.join(root, 'run'),
    reportDir: path.join(root, 'report'),
    datasetDir: path.join(root, 'dataset'),
    stateDir: path.join(root, '.ask'),
    // 全局（跨 instance）：
    lockRoot: base,                            // acquireLock(lockRoot, serial) → <base>/.ask/locks/<serial>.lock
    probeFile: path.join(base, '.ask', 'family-probe.json'),
  };
}

// 创建目录（幂等）。includeGlobal 控制是否连全局锁目录一起建。
export function ensureWorkspace(ws, { includeGlobal = true } = {}) {
  const dirs = [ws.caseDir, ws.runDir, ws.reportDir, ws.datasetDir, ws.stateDir];
  if (includeGlobal) dirs.push(path.join(ws.lockRoot, '.ask', 'locks'));
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  return ws;
}
