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
// 性能：expectedPackage 已知时把 dumpsys 与 pidof 合并为**一条** shell（省一次 adb spawn+排队）；
// 缺省时仍需先取前台包，保留两段式。
export async function assertNoCrash(adb, expectedPackage, { timeoutMs } = {}) {
  let fg;
  let alive;
  if (expectedPackage) {
    const out = await adb
      .shell(`dumpsys activity activities | grep -iE "resumedactivity"; pidof ${expectedPackage}`, { timeoutMs })
      .catch(() => '');
    // 输出为两段拼接：dumpsys 的匹配行（可能为空）+ pidof 的 pid 行（可能为空）
    const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // 与 parseResumedActivity 同款行筛选：优先冒号形态（mResumedActivity:），
    // topResumedActivity= 是等号形态、parse 不认；旧实现传整段输出由 parse 内部跳行，
    // 合并后必须显式选对行，否则前台解析为 null（曾致 assert_no_crash 误报"前台已离开"）
    const resumedLine = lines.find((l) => /resumedactivity\s*:/i.test(l))
      ?? lines.find((l) => /resumedactivity/i.test(l))
      ?? '';
    const pidLine = lines.find((l) => /^\d+(\s+\d+)*$/.test(l)) ?? '';
    fg = parseResumedActivity(resumedLine) ?? { package: null, activity: null, resumedActivity: null };
    alive = /\d+/.test(pidLine);
  } else {
    fg = await foreground(adb, { timeoutMs });
    const pkg = fg.package;
    alive = pkg ? await processAlive(adb, pkg, { timeoutMs }) : false;
  }
  const pkg = expectedPackage ?? fg.package;
  const ok = alive && (expectedPackage ? fg.package === expectedPackage : true);
  let error = null;
  if (!alive) error = `进程不存在: ${pkg ?? 'unknown'}`;
  else if (expectedPackage && fg.package !== expectedPackage) error = `前台已离开 ${expectedPackage}（当前: ${fg.resumedActivity ?? 'unknown'}）`;
  return { ok, alive, foreground: fg.package, error };
}
