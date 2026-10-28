// run 前预授权（§2.7.2 第一层）：把"会弹的权限框"提前消灭。
// 只处理 android.permission.* 运行时权限（第三方 launcher 的自定义权限不碰）。

// 从 `dumpsys package <pkg>` 输出里提取请求的运行时权限
export function parseRequestedPermissions(dumpsysText) {
  const out = new Set();
  for (const line of String(dumpsysText ?? '').split(/\r?\n/)) {
    const m = /^\s*(android\.permission\.[A-Z0-9_]+)\s*$/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

// 常见可 grant 的运行时权限白名单（避免对不可 grant 的反复尝试）
export const GRANTABLE = new Set([
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_CONTACTS',
  'android.permission.CALL_PHONE',
]);

// 对目标包预授权；返回 { granted: string[], failed: [{perm, error}] }
export async function pregrantPackage(device, pkg) {
  const text = await device.dumpsysPackage(pkg).catch(() => '');
  const wanted = parseRequestedPermissions(text).filter((p) => GRANTABLE.has(p));
  const granted = [];
  const failed = [];
  for (const perm of wanted) {
    const r = await device.pmGrant(perm, pkg).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (r.ok) granted.push(perm); else failed.push({ perm, error: r.error });
  }
  return { granted, failed };
}
