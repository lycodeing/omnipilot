// 系统弹窗侦测与自适应关闭（§2.7）：权限授权 / 包安装器 / systemui 弹窗不能打断用例。
// 只做"恢复现场"：不计入 run 的 steps、不产生断言（§2.7.4）。
// 依赖：device 门面（foreground/dumpTree/locate/tap/key/waitIdle）。

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

export function isSystemDialogForeground(fg) {
  if (!fg || !fg.package) return false;
  return SYSTEM_DIALOG_PACKAGES.has(String(fg.package));
}

function hasAllowText(nodes) {
  for (const n of nodes || []) {
    const t = String(n.text || n.contentDesc || '').trim();
    if (t && ALLOW_TEXTS.some((a) => t === a || t.includes(a))) return true;
  }
  return false;
}

export async function detectDialog(device) {
  const fg = await device.foreground().catch(() => null);
  if (isSystemDialogForeground(fg)) {
    return { detected: true, reason: 'foreground-is-system-dialog', pkg: fg.package };
  }
  // 前台是目标 App，也要防"App 内弹权限框"（部分 ROM 在应用内呈现）——查授权按钮文本
  try {
    const tree = await device.dumpTree();
    if (hasAllowText(tree?.nodes)) {
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
