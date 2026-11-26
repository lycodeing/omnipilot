// content://sms/inbox 读取（需 READ_SMS 权限，pregrant 白名单已加）。
// 命令是固定串，contains 过滤在结果侧做——绝不把用户输入拼进 shell。

// 解析 `adb shell content query --uri ...` 的输出：
//   Row: 0 address=10690000, body=..., date=1750000000000
// key=value 以逗号分隔，但 body 可能自带逗号——用"下一个 key="边界切分，避免误截正文。
export function parseSmsContent(out) {
  const msgs = [];
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const m = /^Row:\s*\d+\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const fields = {};
    const re = /(address|body|date)=([\s\S]*?)(?=,\s*(?:address|body|date)=|$)/g;
    let f;
    while ((f = re.exec(m[1]))) fields[f[1]] = f[2].trim();
    if (fields.body != null) msgs.push({ address: fields.address ?? '', body: fields.body, date: Number(fields.date) || 0 });
  }
  return msgs;
}

export async function readSms(adb, { contains = null, limit = 5 } = {}) {
  try {
    const { stdout, stderr } = await adb.shell(
      'content query --uri content://sms/inbox --projection address,body,date --sort "date DESC"',
      { timeoutMs: 10000, withStderr: true },
    );
    const out = `${stdout ?? ''}\n${stderr ?? ''}`;
    if (/SecurityException|Permission Denial/i.test(out)) {
      return { ok: false, messages: [], error: '无 READ_SMS 权限（用 --pregrant 预授权或手动授予）' };
    }
    let msgs = parseSmsContent(stdout);
    if (contains) msgs = msgs.filter((m) => m.body.includes(contains));
    return { ok: true, messages: msgs.slice(0, limit), error: null };
  } catch (e) {
    return { ok: false, messages: [], error: String(e?.message ?? e) };
  }
}
