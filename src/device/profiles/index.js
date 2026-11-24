// 场景 profile（skills 式按需加载）：把"某类页面的调优参数"从引擎里挪出来。
//
// 设计边界（重要）：profile 只提供**调优参数**（settleMs / maxRounds / verifyColor /
// 未来的其它时序参数），**不含任何 App 专有选择器**——题面、选项集、终止标记仍全部由
// 用例的 rows / tap / stopWhen 表达。这样 profile 不会变成"硬编码某 App"的后门，
// 而只是"同类页面共性时序"的可复用预设。
//
// 加载方式：调用方显式传 profile 名（tap_each_row 的 profile 参数 / 用例 aiTapEach 的
// profile: 行）。未传则不 import 任何东西，零成本。
//
// 内置 profile：
//   questionnaire  —— 长表单/问卷（WebView 渲染，选中即 scroll-into-view）：
//                      settleMs 更长（选中高亮 + 自动滚动动画），maxRounds 放宽。
//
// 自定义：环境变量语义同 `--profile-dir` 或 $ASK_PROFILE_DIR 指向目录，目录内同名 .js
// 模块 export default { settleMs, maxRounds, verifyColor }。用于团队沉淀自有场景。
//
// 校验：所有数值做硬边界钳制，避免 profile 把引擎推进病态参数（如 settleMs=0 导致
// 选中态未渲染就判定失败）。

const BUILTIN = {
  // 长问卷：WebView 里选中会触发 scroll-into-view，动画比普通点击长；题量常 20-50。
  // readyTimeoutMs 给大一些：从列表页点进问卷的转场 + 首屏渲染在 WebView 上可达数秒。
  questionnaire: { settleMs: 700, maxRounds: 80, verifyColor: 'auto', readyTimeoutMs: 45_000 },
  // 普通表单（原生控件，选中即生效，无自动滚动）：settle 可更短，就绪也更快。
  form: { settleMs: 400, maxRounds: 60, verifyColor: 'auto', readyTimeoutMs: 15_000 },
};

const LIMITS = {
  settleMs: [100, 5000],
  maxRounds: [1, 300],
  readyTimeoutMs: [0, 120_000],
};

function clamp(name, v) {
  const range = LIMITS[name];
  if (!range || !Number.isFinite(v)) return v;
  return Math.min(range[1], Math.max(range[0], Math.trunc(v)));
}

function normalize(raw, source) {
  if (!raw || typeof raw !== 'object') throw new Error(`profile ${source} 必须是对象`);
  const out = {};
  if (raw.settleMs != null) out.settleMs = clamp('settleMs', Number(raw.settleMs));
  if (raw.maxRounds != null) out.maxRounds = clamp('maxRounds', Number(raw.maxRounds));
  if (raw.verifyColor != null) out.verifyColor = String(raw.verifyColor);
  if (raw.readyTimeoutMs != null) out.readyTimeoutMs = clamp('readyTimeoutMs', Number(raw.readyTimeoutMs));
  // doneTexts：视觉作答"已完成"判定的参考按钮词（喂给 VLM 的提示，非选择器）。
  // 缺省（内置 profile 未设）用 visual-answer 内置中文缺省；英文/其它形态问卷经自定义 profile 注入。
  if (raw.doneTexts != null) {
    out.doneTexts = (Array.isArray(raw.doneTexts) ? raw.doneTexts : [raw.doneTexts]).map((s) => String(s)).filter(Boolean).slice(0, 8);
  }
  return out;
}

// 加载 profile：内置优先；名字含路径分隔符或指定 dir 时读自定义模块。
// 返回 {} 表示"无此 profile"由调用方决定是否报错（当前实现：报错，避免静默忽略拼写错误）。
export async function loadProfile(name, { dir = process.env.ASK_PROFILE_DIR || null } = {}) {
  const key = String(name ?? '').trim();
  if (!key) throw new Error('profile 名为空');
  if (BUILTIN[key]) return normalize(BUILTIN[key], `builtin:${key}`);
  if (!dir) throw new Error(`未知 profile: ${key}（内置: ${Object.keys(BUILTIN).join(', ')}；自定义需设 ASK_PROFILE_DIR）`);
  const path = await import('node:path');
  const url = await import('node:url');
  const file = path.join(dir, `${key}.js`);
  let mod;
  try {
    mod = await import(url.pathToFileURL(file).href);
  } catch (e) {
    throw new Error(`profile 加载失败 ${file}: ${e?.message ?? e}`);
  }
  return normalize(mod.default ?? mod.profile, `file:${file}`);
}

export const PROFILE_NAMES = Object.keys(BUILTIN);

// tap_each_row 两形态（selector / 视觉）共用的时序优先级：显式参数 > profile > 内置缺省。
// 此前视觉形态没接 profile，settle/maxRounds/verifyColor 在 visual-answer.js 另写一份缺省，
// 与本文件 questionnaire 预设数值分叉——分类点已建、知识未下沉的典型。收敛到这一个函数。
// settleMs 不暴露为工具参数（点击后停留时长属场景预设职责，用例作者不该逐用例调），
// 只认 profile 与缺省；maxRounds / verifyColor 允许用例显式覆盖。
export function resolveTiming({ maxRounds = null, verifyColor = null } = {}, prof = null) {
  return {
    maxRounds: Math.max(1, Math.trunc(Number(maxRounds ?? prof?.maxRounds ?? 60)) || 60),
    verifyColor: verifyColor ?? prof?.verifyColor ?? 'auto',
    settleMs: Number.isFinite(prof?.settleMs) ? prof.settleMs : 700,
  };
}
