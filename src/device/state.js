// 前台判定用 dumpsys activity 的 ResumedActivity；mCurrentFocus 不可信，禁用（§5.0.1）
export function parseResumedActivity(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((l) => /resumedactivity\s*:/i.test(l));
  if (!line) return null;
  let m = /\{[^{}]*\s([\w.$]+)\/([\w.$]+)/.exec(line);
  if (!m) m = /([\w.]+)\/([\w.$]+)/.exec(line);
  if (!m) return null;
  return { package: m[1], activity: m[2], resumedActivity: `${m[1]}/${m[2]}` };
}

export async function foreground(adb, { timeoutMs } = {}) {
  const out = await adb
    .shell('dumpsys activity activities | grep -iE "resumedactivity"', { timeoutMs })
    .catch(() => '');
  return parseResumedActivity(out) ?? { package: null, activity: null, resumedActivity: null };
}

export async function processAlive(adb, packageName, { timeoutMs } = {}) {
  const out = await adb.shell(`pidof ${packageName}`, { timeoutMs }).catch(() => '');
  return /\d+/.test(String(out).trim());
}

// 崩溃/被杀检测：进程存活 + 前台仍是预期包
// expectedPackage 缺省时退化为"当前前台应用存活"——不能拿 null 去 pidof（真机复现：agent 无参调用
// assert_no_crash 会被记成 "进程不存在: null" 的失败断言，污染 run 状态）
export async function assertNoCrash(adb, expectedPackage, { timeoutMs } = {}) {
  const fg = await foreground(adb, { timeoutMs });
  const pkg = expectedPackage ?? fg.package;
  const alive = pkg ? await processAlive(adb, pkg, { timeoutMs }) : false;
  const ok = alive && (expectedPackage ? fg.package === expectedPackage : true);
  let error = null;
  if (!alive) error = `进程不存在: ${pkg ?? 'unknown'}`;
  else if (expectedPackage && fg.package !== expectedPackage) error = `前台已离开 ${expectedPackage}（当前: ${fg.resumedActivity ?? 'unknown'}）`;
  return { ok, alive, foreground: fg.package, error };
}
