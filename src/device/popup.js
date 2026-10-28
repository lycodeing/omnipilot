// 系统弹窗侦测与自适应关闭（§2.7）：权限授权 / 包安装器 / systemui 弹窗不能打断用例。
// 只做"恢复现场"：不计入 run 的 steps、不产生断言（§2.7.4）。
// 依赖：device 门面（foreground/dumpTree/locate/tap/key/waitIdle）。
import { flattenNodes } from './uitree.js';

// 已知会弹框的系统包（Android 通用）
export const SYSTEM_DIALOG_PACKAGES = new Set([
  'com.google.android.permissioncontroller',
  'com.android.permissioncontroller',
  'com.google.android.packageinstaller',
  'com.android.packageinstaller',
  'com.android.systemui',
]);

// 按钮文本按优先级：同意类 > 确定类 > （不点"拒绝"）
export const ALLOW_TEXTS = ['始终允许', '仅在使用时允许', '允许', '同意', '确定', '知道了', '好的', '继续'];

// 检测用严格子集（仅权限专用短语）：'确定/继续/好的' 等是普通 App 按钮常见文案，
// 若用于"前台是目标 App 时的内嵌权限框"检测会误判，导致误点/误按 back 退出页面。
// 真实权限框必然含 允许/始终允许/仅在使用时允许/同意 之一，故检测子集足够且安全。
const DETECT_TEXTS = ['始终允许', '仅在使用时允许', '允许', '同意'];

export function isSystemDialogForeground(fg) {
  if (!fg || !fg.package) return false;
  return SYSTEM_DIALOG_PACKAGES.has(String(fg.package));
}

// dumpTree 返回的是嵌套根数组（实测根节点 1 个、text 为空），只扫根层永远不命中——
// 必须先 flatten 成深度优先扁平数组再匹配授权按钮文本。
function hasAllowText(nodes, texts) {
  const flat = Array.isArray(nodes) ? flattenNodes(nodes) : [];
  for (const n of flat) {
    const t = String(n.text || n.contentDesc || '').trim();
    if (t && texts.some((a) => t === a || t.includes(a))) return true;
  }
  return false;
}

// foreground() 负向 TTL 缓存（性能）：写动作前的弹窗预检每次付一次 dumpsys（~0.3-0.5s）。
// 只缓存"前台不是系统弹窗"的负向结果（1s）；正向（系统弹窗在前台）**永不缓存**——
// 否则弹窗刚被关掉后的下一次预检会用陈旧的正向结果误触发 dismissDialog（误按 back）。
// 负向陈旧的风险有界：真弹出权限框时树扫描分支（DETECT_TEXTS）仍会命中。
// 按 device 分键（WeakMap）：--parallel 多设备并发时互不串用。
const negCacheByDevice = new WeakMap();
const NEG_TTL_MS = 1000;

export async function detectDialog(device) {
  const now = Date.now();
  const cached = negCacheByDevice.get(device);
  if (cached && cached.fg && now - cached.at < NEG_TTL_MS) {
    // 负向 TTL 命中：前台非系统弹窗，直接走树扫描分支（不再付 dumpsys）
    return treeScan(device, cached.fg);
  }
  // 优先从 UI 树派生前台包（根节点 package= 即前台应用，uitree 已保留 pkg 字段）：
  // 写动作路径上 detectDialog 之后 locate 必然要 dump 同一棵树（缓存命中），
  // 故先 dump 不浪费；省掉旧实现每次写动作前的一次 dumpsys 往返（~0.3-0.5s）。
  let fg = null;
  let tree = null;
  try {
    tree = await device.dumpTree();
    const rootPkg = tree?.nodes?.[0]?.pkg || null;
    if (rootPkg) fg = { package: rootPkg, activity: null, resumedActivity: null };
  } catch { /* 树不可用 → 回落 dumpsys */ }
  if (!fg) {
    fg = await device.foreground().catch(() => null);
  }
  if (isSystemDialogForeground(fg)) {
    return { detected: true, reason: 'foreground-is-system-dialog', pkg: fg.package };
  }
  negCacheByDevice.set(device, { at: now, fg });
  return treeScan(device, fg, tree);
}

// App 内嵌权限框检测：查授权按钮文本（严格子集防误判）。tree 可复用调用方已 dump 的树。
async function treeScan(device, fg, tree = null) {
  try {
    const t = tree ?? (await device.dumpTree());
    if (hasAllowText(t?.nodes, DETECT_TEXTS)) {
      return { detected: true, reason: 'allow-button-visible', pkg: fg?.package ?? null };
    }
  } catch { /* dump 失败不阻断 */ }
  return { detected: false, reason: null, pkg: fg?.package ?? null };
}

// 按优先级点按钮；全不中 → back 键兜底。返回 { ok, clicked, error }
// 取舍说明：detectDialog 的 allow-button-visible 分支在前台是目标 App 时也会触发（防 App 内嵌权限框），
// 此时 locate(ALLOW_TEXTS) 扫的是整棵树，理论上可能点到目标 App 自己的同名按钮（如"确定"）。
// 接受该风险：误点后仍有 waitIdle + 后续步骤的 locate 兜底，且弹窗打断用例的代价更高（§2.7）。
// 成本说明：弹窗上没有任何候选文本时最坏要试 ALLOW_TEXTS.length 次 locate（每次 dump ≈2.2s）。
export async function dismissDialog(device) {
  for (const text of ALLOW_TEXTS) {
    const loc = await device.locate(text).catch(() => ({ ok: false, bounds: null }));
    if (loc?.ok && loc.bounds) {
      const r = await device.tap(loc.bounds).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (r?.ok !== false) {
        await device.waitIdle({ quiet: 1, timeoutMs: 3000 }).catch(() => {});
        return { ok: true, clicked: text, error: null };
      }
      // tap 失败 → 继续试下一个候选（不落到 back，先给其他按钮机会）
    }
  }
  // 兜底：返回键（能关掉多数系统弹窗）
  try {
    await device.key('back');
    await device.waitIdle({ quiet: 1, timeoutMs: 3000 }).catch(() => {});
    return { ok: true, clicked: 'back', error: null };
  } catch (e) {
    return { ok: false, clicked: null, error: String(e?.message ?? e) };
  }
}
