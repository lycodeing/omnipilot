// 系统弹窗侦测与自适应关闭（§2.7）：权限授权 / 包安装器 / systemui 弹窗不能打断用例。
// 只做"恢复现场"：不计入 run 的 steps、不产生断言（§2.7.4）。
// 依赖：device 门面（foreground/dumpTree/locate/tap/key/waitIdle/getProp）。
//
// 类型分类：「Android 系统弹窗」是一个设备类型，其知识
// 按两个正交维度收敛为数据，引擎逻辑只认接口——
//   ① 弹窗族（谁在弹）：SYSTEM_DIALOG_PACKAGES，权限控制器/安装器/systemui；
//   ② locale 文案包（按钮长什么样）：POPUP_WORD_PACKS，zh/en 两包。
// 新增 locale = 加一个词表键；新增弹窗族 = 包集合加一项；引擎逻辑零改。
// 自定义 locale 可用环境变量 ASK_POPUP_LOCALE 强制（CI/测试/多语言真机）。
import { flattenNodes } from './uitree.js';
import { resolvePlatform } from '../platform/index.js';

// 弹窗族包名表收敛到平台包（纯数据，device → platform 单向依赖，不构成循环）。
const platform = resolvePlatform('android');

// 已知会弹框的系统包（Android 通用）
export const SYSTEM_DIALOG_PACKAGES = new Set(platform.systemDialogPackages);

// 常驻系统窗口包：这些包**始终**有窗口在屏（状态栏/导航栏），App 前台时也会
// 作为 dump 的根出现。它们出现在根列表里**不能**判定"前台是系统弹窗"——
// 否则 App 正常前台时会被误判为弹窗 → dismissDialog 兜底盲按 back 键
// （popup.js 的 blind-back 分支）→ 把目标 App 顶出去，用例失败。
// 真正的权限/安装弹窗由 permissioncontroller / packageinstaller 承担。
export const RESIDENT_SYSTEM_PACKAGES = new Set(platform.residentSystemPackages);

// 该根是否代表"真正的系统弹窗"（排除常驻窗口包）
export function isDialogRootPkg(pkg) {
  return SYSTEM_DIALOG_PACKAGES.has(pkg) && !RESIDENT_SYSTEM_PACKAGES.has(pkg);
}

// —— locale 文案包 ——
// allowTexts：dismiss 点按候选，按优先级排列（同意类 > 确定类 > 不点"拒绝"）。
// detectTexts：内嵌权限框检测用严格子集——'确定/继续/好的'（OK/Continue）是普通 App 按钮
// 常见文案，用于"前台是目标 App 时的内嵌权限框"检测会误判（详见 treeScan 复合判据）。
// 真实权限框必然含 允许/同意（Allow/Agree）类短语之一，检测子集足够。
export const POPUP_WORD_PACKS = {
  zh: {
    allowTexts: ['始终允许', '仅在使用时允许', '允许', '同意', '确定', '知道了', '好的', '继续'],
    detectTexts: ['始终允许', '仅在使用时允许', '允许', '同意'],
  },
  en: {
    // 长语在前：'Allow only while using the app' 含 'Allow'，优先精确长词避免语义含混
    allowTexts: ['Allow only while using the app', 'While using the app', 'Allow', 'Agree', 'OK', 'Got it', 'Continue'],
    detectTexts: ['Allow only while using the app', 'While using the app', 'Allow', 'Agree'],
  },
};

function mergeAllPacks() {
  const uniq = (arrs) => [...new Set(arrs.flat())];
  return {
    allowTexts: uniq(Object.values(POPUP_WORD_PACKS).map((p) => p.allowTexts)),
    detectTexts: uniq(Object.values(POPUP_WORD_PACKS).map((p) => p.detectTexts)),
  };
}

// locale tag → 文案包。匹配链：完整 tag（zh-cn）→ 语言前缀（zh）→ 未识别 locale 取**全部包并集**
//（如 fr-FR：没有 fr 包时，并集保证至少 zh/en 弹窗仍可被关——宁可多候选，不可静默全盲）。
// 词表键为语言前缀小写（'zh'/'en'），按 tag 归一后匹配。
export function resolvePopupTexts(locale) {
  const tag = String(locale ?? '').trim().toLowerCase();
  if (!tag) return mergeAllPacks();
  const lang = tag.split(/[-_]/)[0];
  if (POPUP_WORD_PACKS[tag]) return POPUP_WORD_PACKS[tag];
  if (POPUP_WORD_PACKS[lang]) return POPUP_WORD_PACKS[lang];
  return mergeAllPacks();
}

// —— device locale 解析（带缓存）——
// 写动作路径上 detectDialog 高频调用：locale 一次 getprop ~0.3-0.5s，必须缓存。
// 三种结果（含失败 ''）都缓存——失败不缓存会让每次写动作多付一次 getprop。
// 按 device 分键（WeakMap）：--parallel 多设备并发互不串用。
const localeCacheByDevice = new WeakMap();
const LOCALE_TTL_MS = 60_000;

async function devicePopupTexts(device) {
  const forced = String(process.env.ASK_POPUP_LOCALE ?? '').trim();
  if (forced) return resolvePopupTexts(forced);
  const now = Date.now();
  const hit = localeCacheByDevice.get(device);
  if (hit && now - hit.at < LOCALE_TTL_MS) return hit.texts;
  let locale = '';
  try {
    if (typeof device.getProp === 'function') {
      locale = await device.getProp('persist.sys.locale');
    }
  } catch { /* 读不到按未知识别（并集兜底） */ }
  const texts = resolvePopupTexts(locale);
  localeCacheByDevice.set(device, { at: now, texts });
  return texts;
}

export function isSystemDialogForeground(fg) {
  if (!fg || !fg.package) return false;
  return SYSTEM_DIALOG_PACKAGES.has(String(fg.package));
}

// —— 内嵌权限框检测的复合判据 ——
// 文本命中（严格子集）**且**该节点自身或其祖先可点击——真实按钮在 a11y 树里叶子文本常
// clickable=false、可点的是父容器（两侧都要认）；而纯静态文案（"您需同意…才能继续"段落）
// 整条链都不可点，按 includes 误判会把用户协议页/支付确认等合法步骤在写动作前自动点掉。
// WebView 整屏容器 clickable=true 时判据退化回包含匹配。
function hasClickableAllowText(nodes, texts, ancestorClickable = false) {
  for (const n of nodes || []) {
    const t = String(n.text || n.contentDesc || '').trim();
    if (t && (ancestorClickable || n.clickable === true) && texts.some((a) => t === a || t.includes(a))) return true;
    if (hasClickableAllowText(n.children, texts, ancestorClickable || n.clickable === true)) return true;
  }
  return false;
}

// foreground() 负向 TTL 缓存（性能）：写动作前的弹窗预检每次付一次 dumpsys（~0.3-0.5s）。
// 只缓存"前台不是系统弹窗"的负向结果（1s）；正向（系统弹窗在前台）**永不缓存**——
// 否则弹窗刚被关掉后的下一次预检会用陈旧的正向结果误触发 dismissDialog（误按 back）。
// 负向陈旧的风险有界：真弹出权限框时树扫描分支（detectTexts）仍会命中。
// 按设备分键（WeakMap）：--parallel 多设备并发时互不串用。
const negCacheByDevice = new WeakMap();
const NEG_TTL_MS = 1000;
// 树派生前台的新鲜度上限：缓存树超过此龄不用来判前台，
// 回落 dumpsys，避免 4s 树 TTL 窗口内新弹系统弹窗被漏检一次。
const MAX_TREE_STALE_MS = 1000;

export async function detectDialog(device) {
  const now = Date.now();
  const cached = negCacheByDevice.get(device);
  if (cached && cached.fg && now - cached.at < NEG_TTL_MS) {
    // 负向 TTL 命中：前台非系统弹窗，直接走树扫描分支（不再付 dumpsys）
    return treeScan(device, cached.fg);
  }
  // 优先从 UI 树派生前台包（根节点 package= 即前台应用，uitree 已保留 pkg 字段）：
  // 写动作路径上 detectDialog 之后 locate 必然要 dump 同一棵树（缓存命中），
  // 故先 dump 不浪费；省掉每次写动作前的一次 dumpsys 往返（~0.3-0.5s）。
  // 新鲜度上限：缓存树超过 MAX_TREE_STALE_MS 时不用它派生前台
  // （否则 4s TTL 窗口内新弹的系统弹窗会被漏检一次）——回落实时 foreground()。
  let fg = null;
  let tree = null;
  try {
    tree = await device.dumpTree();
    // 必须看**所有**根节点：uiautomator dump 每窗口一个根，权限弹窗叠在应用窗口之上时
    // 会解析出两个根（应用 + permissioncontroller）。只取 nodes[0] 拿到的是底层窗口
    // （应用自己），于是"前台是系统弹窗"的判定永远不成立——恰恰是弹窗处理存在的场景。
    const rootPkgs = (tree?.nodes ?? []).map((n) => n?.pkg).filter(Boolean);
    const freshEnough = !tree?.fromCache || (Date.now() - (tree.cachedAt ?? 0)) <= MAX_TREE_STALE_MS;
    if (rootPkgs.length && freshEnough) {
      // 真正的系统弹窗根（排除 systemui 等常驻窗口）→ 前台即该弹窗（弹窗在顶层）
      const dialogPkg = rootPkgs.find((p) => isDialogRootPkg(p));
      // 否则取应用包（排除系统包，含常驻窗口包）
      const appPkg = rootPkgs.find((p) => !SYSTEM_DIALOG_PACKAGES.has(p)) ?? null;
      fg = { package: dialogPkg ?? appPkg, activity: null, resumedActivity: null };
    }
  } catch { /* 树不可用 → 回落 dumpsys */ }
  if (!fg) {
    fg = await device.foreground().catch(() => null);
    tree = null; // 前台来自 dumpsys：树与前台不同源，treeScan 需重新取树
  }
  if (isSystemDialogForeground(fg)) {
    return { detected: true, reason: 'foreground-is-system-dialog', pkg: fg.package };
  }
  negCacheByDevice.set(device, { at: now, fg });
  return treeScan(device, fg, tree);
}

// App 内嵌权限框检测：locale 文案包（严格子集）+ 复合判据（文本命中且可点链成立）。
// tree 可复用调用方已 dump 的树。
async function treeScan(device, fg, tree = null) {
  try {
    const t = tree ?? (await device.dumpTree());
    const { detectTexts } = await devicePopupTexts(device);
    if (hasClickableAllowText(t?.nodes, detectTexts)) {
      return { detected: true, reason: 'allow-button-visible', pkg: fg?.package ?? null };
    }
  } catch { /* dump 失败不阻断 */ }
  return { detected: false, reason: null, pkg: fg?.package ?? null };
}

// 按优先级点按钮（locale 文案包）；全不中 → back 键兜底。返回 { ok, clicked, error }
// 取舍说明：detectDialog 的 allow-button-visible 分支在前台是目标 App 时也会触发（防 App 内嵌权限框），
// 此时 locate(allowTexts) 扫的是整棵树，理论上可能点到目标 App 自己的同名按钮（如"确定/OK"）。
// 接受该风险：误点后仍有 waitIdle + 后续步骤的 locate 兜底，且弹窗打断用例的代价更高（§2.7）。
// 成本说明：弹窗上没有任何候选文本时最坏要试 allowTexts.length 次 locate（每次 dump ≈2.2s）。
export async function dismissDialog(device) {
  const { allowTexts } = await devicePopupTexts(device);
  for (const text of allowTexts) {
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
