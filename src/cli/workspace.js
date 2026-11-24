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
// 更名兼容（2026-11-24）：项目更名为 OmniPilot，历史工作区仍叫 scene-kit。
// 探测顺序为「新名 → 旧名」，旧目录存在则继续沿用——否则老用户的既有 run、
// 设备锁与 family 探测缓存会失联（锁目录跨进程全局互斥，迁移即失效）。
//
// ASK_WORKSPACE 可直接钉死整个 instance 目录（测试 / CI 用）；ASK_DATE / ASK_INSTANCE 覆盖日期与实例名。

import path from 'node:path';
import fs from 'node:fs';

// 历史工作区目录名（更名前）：仅用于兼容探测，新装机器不存在
const LEGACY_DIR_NAME = 'scene-kit';
// 当前工作区目录名
const CURRENT_DIR_NAME = 'omni-pilot';

export const DEFAULT_HOME = pickDefaultHome();
export const DEFAULT_INSTANCE = 'instance';

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// 探测历史工作区（更名前的目录名），存在则返回；不存在返回 null。
// 只在当前目录名不存在时调用——当前名优先。
function findLegacyHome(candidates, existsSync) {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function pickDefaultHome({
  platform = process.platform,
  env = process.env,
  existsSync = exists,
} = {}) {
  // 平台缺省（2026-11-10 评审 #13）：环境路径不再无条件写死——
  //   win32：沿用既有工作区 **仅当已存在**（兼容历史 run），
  //          探测顺序 C:/opt/omni-pilot → C:/opt/scene-kit（更名前）；
  //          都没有则回退用户目录 ~/.local/share/omni-pilot；全新机器不再往 C:/opt 落盘
  //   unix：优先 /opt/omni-pilot（存在且可写），其次历史 /opt/scene-kit，
  //          否则 ~/.local/share/omni-pilot
  // ASK_HOME / ASK_WORKSPACE 仍可完全覆盖。
  const home = env.HOME || env.USERPROFILE || '.';
  const fallbackHome = path.join(home, '.local', 'share', CURRENT_DIR_NAME);
  if (platform === 'win32') {
    const preferred = `C:/opt/${CURRENT_DIR_NAME}`;
    if (existsSync(preferred)) return preferred;
    // 更名前的历史工作区：存在则继续沿用，保持历史 run / 设备锁 / probe 缓存连续
    const legacy = findLegacyHome([`C:/opt/${LEGACY_DIR_NAME}`], existsSync);
    if (legacy) return legacy;
    return fallbackHome;
  }
  const preferred = `/opt/${CURRENT_DIR_NAME}`;
  try {
    // 父目录可写（或目标已存在且可写）才采用 /opt
    const target = existsSync(preferred) ? preferred : path.dirname(preferred);
    fs.accessSync(target, fs.constants.W_OK);
    return preferred;
  } catch {
    // 当前名不可用时回落历史目录（存在即可用），保持老用户数据连续
    const legacy = findLegacyHome([`/opt/${LEGACY_DIR_NAME}`], existsSync);
    if (legacy) return legacy;
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
