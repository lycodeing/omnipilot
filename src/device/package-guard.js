// 包名/Activity 白名单（设备层安全边界）
//
// 这些值会进 adb shell 命令串，而 adb shell 是**设备端 /bin/sh -c** 执行的——
// 未校验时可携带 "; rm -rf /sdcard" 之类 shell 元字符，把"启动 App"变成任意命令执行。
// 触发路径：模型产出的 appId/expectedPackage（提示词注入面）。
//
// Android 包名只允许字母数字下划线与点分隔；Activity 名额外允许 $InnerClass。
// 独立成模块（而非放 index.js）：state.js 与 index.js 都要用，index.js 会 import
// state.js —— 放 index.js 会造成循环依赖。

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;
const ACTIVITY_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*\$?[A-Za-z0-9_]*$/;

export function assertSafePackage(pkg) {
  const p = String(pkg ?? '').trim();
  if (!PACKAGE_RE.test(p)) {
    throw new Error(`包名非法: "${pkg}"（只允许字母/数字/下划线与点分隔，如 com.example.app）`);
  }
  return p;
}

export function assertSafeActivity(activity) {
  const a = String(activity ?? '').trim();
  if (!ACTIVITY_RE.test(a)) {
    throw new Error(`Activity 名非法: "${activity}"（只允许字母/数字/下划线与点分隔）`);
  }
  return a;
}
