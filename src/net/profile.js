// 网络档位（复用设备 /system/bin/net，§10）：off/2g/3g/4g/5g/airplane/cut/custom
export const NET_PROFILES = ['off', '2g', '3g', '4g', '5g', 'airplane', 'cut', 'custom'];

export async function setNetProfile(adb, name, { timeoutMs } = {}) {
  const p = String(name ?? '').toLowerCase().trim();
  if (!NET_PROFILES.includes(p)) {
    return { ok: false, profile: p, error: `未知档位: ${name}（可用: ${NET_PROFILES.join('/')}）` };
  }
  try {
    const { stdout, stderr } = await adb.shell(`net ${p}`, { timeoutMs, withStderr: true });
    // 判定必须含 stderr：shell 报错走 stderr（如 "net: inaccessible or not found"），
    // 只看 stdout 会把失败误判为成功（缺陷 #14）
    const out = `${stdout ?? ''}\n${stderr ?? ''}`;
    const bad = /error|failed|not found|no such|inaccessible/i.test(out);
    return { ok: !bad, profile: p, error: bad ? out.trim().slice(0, 200) : null };
  } catch (e) {
    return { ok: false, profile: p, error: String(e?.message ?? e) };
  }
}

export async function netStatus(adb, { timeoutMs } = {}) {
  try {
    const out = await adb.shell('net status', { timeoutMs }).catch(() => '');
    const m = /(?:current|profile|mode)\s*[:=]\s*(\S+)/i.exec(out) ?? /^(\S+)/.exec(String(out).trim());
    return { profile: m ? m[1].toLowerCase() : 'unknown' };
  } catch {
    return { profile: 'unknown' };
  }
}
