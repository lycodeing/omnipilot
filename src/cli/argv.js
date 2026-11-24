// CLI 参数解析（§13.3）：无外部依赖，从 bin/ask.js 抽出以便单测。
// 规则：--flag value / --flag=value / 布尔 flag 表内不带值；非 -- 开头为位置参数。
// device/model 是"可选值"flag：`--device <serial>` 取值；裸 `--device`（doctor 检查默认设备）为 true。

export const BOOL_FLAGS = [
  'yes', 'json', 'quiet', 'vlm-locate', 'fresh-locate', 'fresh', 'keep', 'continue',
  'keep-data', 'strict', 'pregrant', 'help', 'version',
  // allow-coords：坐标步逃生口（DESIGN.md:449）。默认禁止把坐标写进用例（2026-09-24 裁定）
  'allow-coords',
];

// 可选值 flag：后面紧跟非 -- 参数则取其值，否则为 true（供 doctor 的"检查默认设备/模型"用法）
export const OPTIONAL_VALUE_FLAGS = ['device', 'model'];

export function parseArgv(argv) {
  const cmd = argv[0] || 'help';
  const positional = [];
  const flags = {};
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf('=');
    const isBool = BOOL_FLAGS.includes(name);
    const isOptional = OPTIONAL_VALUE_FLAGS.includes(name);
    const nextIsValue = i + 1 < rest.length && !rest[i + 1].startsWith('--');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if ((isOptional || !isBool) && nextIsValue) {
      value = rest[++i];
    } else {
      value = true;
    }
    flags[name] = value;
  }
  return { cmd, positional, flags };
}
