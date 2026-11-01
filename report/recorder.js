// 报告生成端（CONTRACT §5.1）：run.json → dump（§19.5 映射）→ 标签注入壳 → 单文件/assets 双产物。
// 增量 append 期间直接追加写文件（任务跑一半可打开看，<script> 在 </body> 之后浏览器仍归入 body）；
// finalize 一次性把全部标签规范化到 </body> 前，按组去重保最新后 tmp+rename 原子发布（§19.8.6.5）。

import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DUMP_TAG_TYPE = 'ask-dump';
export const IMAGE_TAG_TYPE = 'ask-image';
export const REDACTED_PREFIX = '[REDACTED';

const SECRET_TASK_TYPES = new Set(['secret_get', 'sms_read']);

const DUMP_TAG_RE = /<script type="ask-dump"([^>]*)>([\s\S]*?)<\/script>/g;
const IMAGE_TAG_RE = /<script type="ask-image"([^>]*)>([\s\S]*?)<\/script>/g;

const FALLBACK_SHELL = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <meta name="viewport" content="width=device-width, initial-scale=1">',
  '  <title>ASK Report</title>',
  '</head>',
  '<body>',
  '  <div id="root">报告壳未构建，仅数据可解析</div>',
  '</body>',
  '</html>',
].join('\n');

// ---------- 标签工具 ----------

function attrVal(attrs, name) {
  const m = String(attrs ?? '').match(`${name}="([^"]*)"`);
  return m ? m[1] : null;
}

function attrEscape(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 所有标签统一插在 </body> 前（finalize 一次性规范化）；无 </body> 的壳则追加在末尾
function insertBeforeBody(html, tag) {
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return `${html}\n${tag}`;
  return `${html.slice(0, idx)}${tag}\n${html.slice(idx)}`;
}

// JSON 写入前转义 </ 防止提前闭合标签；\/ 是合法 JSON 转义，解析后还原
export function makeDumpTag(groupId, dump) {
  const json = JSON.stringify(dump ?? {}).replace(/<\//g, '<\\/');
  return `<script type="${DUMP_TAG_TYPE}" data-group-id="${attrEscape(groupId ?? 'default')}">${json}</script>`;
}

export function makeImageTag(id, src) {
  return `<script type="${IMAGE_TAG_TYPE}" data-id="${attrEscape(id)}">${src ?? ''}</script>`;
}

// ---------- 脱敏（§19.7 安全边界） ----------

export function redactValue(provider, key) {
  return `${REDACTED_PREFIX}:${provider}:${key}]`;
}

function redactStrings(node, token) {
  if (typeof node === 'string') return token;
  if (Array.isArray(node)) return node.map((v) => redactStrings(v, token));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = redactStrings(node[k], token);
    return out;
  }
  return node;
}

// 凡 secret_get/sms_read 任务：thought/param（含 result/errorMessage）字符串值整体替换；
// 存在秘密任务时 assertions.reason 同样替换（reason 是模型自由文本，无法模式匹配）
export function redactDump(dump) {
  if (!dump || !Array.isArray(dump.executions)) return dump;
  let firstToken = null;
  for (const exec of dump.executions) {
    for (const task of exec?.tasks ?? []) {
      if (!task || !SECRET_TASK_TYPES.has(task.type)) continue;
      const p = task.param ?? {};
      const token = redactValue(task.type, p.key ?? p.provider ?? 'secret');
      if (!firstToken) firstToken = token;
      if (typeof task.thought === 'string') task.thought = token;
      if (task.param !== undefined) task.param = redactStrings(task.param, token);
      if (typeof task.result === 'string') task.result = token;
      if (typeof task.errorMessage === 'string') task.errorMessage = token;
    }
  }
  if (firstToken && Array.isArray(dump.assertions)) {
    for (const a of dump.assertions) {
      if (a && typeof a.reason === 'string') a.reason = firstToken;
    }
  }
  return dump;
}

// ---------- buildDump（§19.5 映射表） ----------

// opts: { groupName?, runId?, screenshotIds? }；screenshotIds 为 stepIndex→uuid 预置表（测试/复现用）
export function buildDump(runJson, opts = {}) {
  const run = runJson ?? {};
  const groupName = opts.groupName ?? run.case ?? 'default';
  const preset = opts.screenshotIds ?? null;
  const screenshots = {};
  const tasks = (run.steps ?? []).map((step) => {
    const task = {
      taskId: String(step.index),
      type: step.type,
      status: step.result === 'ok' ? 'finished' : 'failed',
      thought: step.thought ?? '',
      errorMessage: step.error ?? null,
      timing: {
        start: step.startedAt ?? 0,
        end: (step.startedAt ?? 0) + (step.durationMs ?? 0),
        durationMs: step.durationMs ?? 0,
      },
    };
    if (step.target != null) {
      task.param = step.type === 'assert' ? { text: step.target } : { target: step.target };
    }
    if (step.locate) task.locate = { ...step.locate };
    if (step.screenshot) {
      const id = (preset && (preset[step.index] ?? preset[String(step.index)])) || crypto.randomUUID();
      task.screenshotId = id;
      if (task.locate) task.locate.screenshotId = id;
      screenshots[id] = ''; // single-html 占位，真实数据在 ask-image 标签
    }
    return task;
  });

  const dump = {
    sdkVersion: 'ask-0.1.0',
    groupName,
    groupDescription: '',
    deviceType: 'android',
    modelBriefs: run.model?.name ? [{ intent: 'planning', name: run.model.name }] : [],
    executions: [{
      id: opts.runId ?? run.runId ?? 'run-unknown',
      name: run.case ?? groupName,
      logTime: run.startedAt ?? null,
      tasks,
    }],
    screenshots,
  };
  if (run.device != null) dump.device = run.device;
  if (run.durationMs != null) dump.durationMs = run.durationMs;
  if (run.status != null) dump.status = run.status;
  if (Array.isArray(run.networkTimeline)) dump.networkTimeline = run.networkTimeline;
  if (Array.isArray(run.assertions)) dump.assertions = run.assertions;
  if (Array.isArray(run.rollbacks)) dump.rollbacks = run.rollbacks;
  return dump;
}

// ---------- ReportWriter ----------

function decodeDataURL(data) {
  const s = String(data);
  const comma = s.startsWith('data:') ? s.indexOf(',') : -1;
  return Buffer.from(comma >= 0 ? s.slice(comma + 1) : s, 'base64');
}

function toDataURL(data) {
  if (data instanceof Uint8Array) return `data:image/png;base64,${Buffer.from(data).toString('base64')}`;
  const s = String(data);
  return s.startsWith('data:') ? s : `data:image/png;base64,${s}`;
}

function ensureBaseTag(html) {
  if (/<base\s/i.test(html)) return html;
  const baseTag = '<base href="./">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${baseTag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n  ${baseTag}`);
  return `${baseTag}\n${html}`;
}

export class ReportWriter {
  constructor({ outPath, shell, mode = 'single-html', baseDir } = {}) {
    if (!outPath) throw new Error('ReportWriter 需要 outPath');
    this.outPath = path.resolve(outPath);
    this.mode = mode === 'directory' ? 'directory' : 'single-html';
    this.baseDir = path.resolve(baseDir ?? path.dirname(this.outPath));
    this._shell = typeof shell === 'string' ? shell : loadShell(null);
    // 批量路径（writeReport）置为数组：标签只攒内存、finalize 一次写盘；增量路径保持 null
    this._batch = null;
    // 增量路径首写标记：undefined=未定，true=壳已落/文件已存在，直接尾追加
    this._tailStarted = undefined;
    fsSync.mkdirSync(this.baseDir, { recursive: true });
    if (this.mode === 'directory') {
      fsSync.mkdirSync(path.join(this.baseDir, 'screenshots'), { recursive: true });
    }
  }

  // screenshots 值按模式规范化：directory → 相对路径；single-html → 空串占位。
  // 浅拷 + 只重建 screenshots 一个 map，其余字段共享引用（序列化即刻发生，无污染风险）
  _prepareDump(dump) {
    const d = { ...(dump ?? {}) };
    const shots = d.screenshots;
    if (shots && typeof shots === 'object' && !Array.isArray(shots)) {
      const normalized = {};
      for (const id of Object.keys(shots)) {
        normalized[id] = this.mode === 'directory' ? `./screenshots/${id}.png` : '';
      }
      d.screenshots = normalized;
    }
    return d;
  }

  // 批量路径攒内存；增量路径 O(1) 尾追加：首次落壳（或沿用已存在文件），之后纯 appendFile。
  // 标签暂落 </body> 之后（浏览器仍归入 body，querySelectorAll 不受影响），
  // "插在 </body> 前"的规范化由 finalize 一次性完成——避免每标签全量读改写（O(N²) IO）。
  async _appendTag(tag) {
    if (this._batch) {
      this._batch.push(tag);
      return;
    }
    if (this._tailStarted === undefined) {
      this._tailStarted = true;
      try {
        await fsp.access(this.outPath);
      } catch {
        await fsp.writeFile(this.outPath, `${this._shell}\n`);
      }
    }
    await fsp.appendFile(this.outPath, `${tag}\n`);
  }

  // 同 group 重复 append 允许，读侧/finalize 去重保最新
  async appendExecution(dump) {
    const d = this._prepareDump(dump);
    const extra = this.mode === 'directory' ? ' data-screenshot-mode="directory"' : '';
    const json = JSON.stringify(d).replace(/<\//g, '<\\/');
    const tag = `<script type="${DUMP_TAG_TYPE}" data-group-id="${attrEscape(d.groupName ?? 'default')}"${extra}>${json}</script>`;
    await this._appendTag(tag);
  }

  async appendScreenshot(id, data) {
    if (this.mode === 'directory') {
      const buf = data instanceof Uint8Array ? Buffer.from(data) : decodeDataURL(data);
      await fsp.writeFile(path.join(this.baseDir, 'screenshots', `${id}.png`), buf);
      return;
    }
    await this._appendTag(makeImageTag(id, toDataURL(data)));
  }

  // 原子发布：读现文件一次 → 按 group/data-id 去重保最新合并 → 规范化插回 </body> 前 → 全量写 <outPath>.tmp → rename。
  // dump 是刚 parse 出的私有对象：原地改 screenshots 后直接 stringify，免深拷贝；
  // 图片只存 [start,end) 偏移、拼 doc 时 slice，避免整段 base64 在 Map 里二次驻留。
  async finalize() {
    let content = '';
    if (this._batch != null) {
      content = this._batch.length ? this._batch.join('\n') : '';
    } else {
      try {
        content = await fsp.readFile(this.outPath, 'utf8');
      } catch {
        // 首次 finalize 且无增量写入：仅发布壳
      }
    }
    const dumps = new Map();
    for (const m of content.matchAll(DUMP_TAG_RE)) {
      const gid = attrVal(m[1], 'data-group-id') ?? 'default';
      try {
        dumps.set(gid, JSON.parse(m[2])); // 同 gid 覆盖 → 保最新
      } catch {
        // 损坏标签跳过
      }
    }
    const images = new Map();
    for (const m of content.matchAll(IMAGE_TAG_RE)) {
      const iid = attrVal(m[1], 'data-id');
      // 只记偏移：payload 即 m[2]，在全文中的区间 = [matchEnd - payload - 闭合长度, matchEnd - 闭合长度)
      if (iid != null) {
        const end = m.index + m[0].length - '</script>'.length;
        images.set(iid, [end - m[2].length, end]);
      }
    }
    const tags = [];
    for (const [gid, dump] of dumps) {
      // 原地规范化 screenshots（浅拷重建这一个 map），不动其余字段、不深拷贝
      const shots = dump.screenshots;
      if (shots && typeof shots === 'object' && !Array.isArray(shots)) {
        const normalized = {};
        for (const id of Object.keys(shots)) {
          normalized[id] = this.mode === 'directory' ? `./screenshots/${id}.png` : '';
        }
        dump.screenshots = normalized;
      }
      const extra = this.mode === 'directory' ? ' data-screenshot-mode="directory"' : '';
      const json = JSON.stringify(dump).replace(/<\//g, '<\\/');
      tags.push(`<script type="${DUMP_TAG_TYPE}" data-group-id="${attrEscape(gid)}"${extra}>${json}</script>`);
    }
    for (const [iid, [start, end]] of images) tags.push(makeImageTag(iid, content.slice(start, end)));
    let doc = insertBeforeBody(this._shell, tags.map((t) => `${t}\n`).join(''));
    if (this.mode === 'directory') doc = ensureBaseTag(doc);
    const tmp = `${this.outPath}.tmp`;
    await fsp.writeFile(tmp, doc);
    await fsp.rename(tmp, this.outPath);
    this._batch = null;
    this._tailStarted = undefined;
  }
}

// ---------- 壳加载 ----------

// 读 dist/index.html 并把本地 <script src>/<link rel=stylesheet> 内联（构建产物单文件化）；
// distDir 缺省 → 仓库自带 viewer/dist（CLI 开箱即用）；显式路径不存在 → 内置兜底壳
const DEFAULT_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewer', 'dist');
export function loadShell(distDir) {
  const dir = distDir == null || distDir === '' ? DEFAULT_DIST : distDir;
  let html;
  try {
    html = fsSync.readFileSync(path.join(dir, 'index.html'), 'utf8');
  } catch {
    return FALLBACK_SHELL;
  }
  const isExternal = (u) => /^(https?:)?\/\/|^data:/i.test(u);
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, pre, src, post) => {
    if (isExternal(src)) return tag;
    let code;
    try {
      code = fsSync.readFileSync(path.resolve(dir, decodeURIComponent(src)), 'utf8');
    } catch {
      return tag;
    }
    const attrs = `${pre} ${post}`.replace(/\s+\b(?:defer|async|crossorigin)\b/gi, '').trim();
    return `<script${attrs ? ` ${attrs}` : ''}>\n${code}\n</script>`;
  });
  html = html.replace(/<link\b([^>]*)>/gi, (tag, attrs) => {
    if (!/\brel=["']?stylesheet["']?/i.test(attrs)) return tag;
    const href = attrVal(attrs, 'href');
    if (!href || isExternal(href)) return tag;
    let css;
    try {
      css = fsSync.readFileSync(path.resolve(dir, decodeURIComponent(href)), 'utf8');
    } catch {
      return tag;
    }
    return `<style>\n${css}\n</style>`;
  });
  return html;
}

// ---------- 组合快捷入口 ----------

function resolveScreenshotFile(rel, outPath, { runDir } = {}) {
  const candidates = [
    path.resolve(rel),
    path.resolve(path.dirname(path.resolve(outPath)), rel),
  ];
  // run.json 所在目录（工作区模式下 runsDir 为绝对路径，相对截图路径以此为准）
  if (runDir) candidates.push(path.resolve(runDir, rel));
  for (const c of candidates) {
    try {
      if (fsSync.statSync(c).isFile()) return c;
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

export async function writeReport(runJson, { outPath, mode = 'single-html', shell, groupName, runDir } = {}) {
  if (!outPath) throw new Error('writeReport 需要 outPath');
  const writer = new ReportWriter({ outPath, shell, mode });
  writer._batch = []; // 一次性批量路径：标签攒内存，finalize 只写一次文件
  const run = runJson ?? {};
  const screenshotIds = {};
  for (const step of run.steps ?? []) {
    if (step?.screenshot) screenshotIds[step.index] = crypto.randomUUID();
  }
  const dump = redactDump(buildDump(run, { groupName, screenshotIds }));
  await writer.appendExecution(dump);
  const steps = run.steps ?? [];
  // taskId → step 索引表：免掉逐任务 steps.find 的 O(T²) 线性回查
  const stepByTaskId = new Map(steps.map((s) => [String(s?.index), s]));
  for (const task of dump.executions[0]?.tasks ?? []) {
    const sid = task.screenshotId ?? task.locate?.screenshotId;
    const step = stepByTaskId.get(task.taskId);
    if (!sid || !step?.screenshot) continue;
    const file = resolveScreenshotFile(step.screenshot, writer.outPath, { runDir });
    if (!file) {
      console.warn(`[report] 截图文件缺失，跳过: ${step.screenshot}`);
      continue;
    }
    const buf = await fsp.readFile(file);
    await writer.appendScreenshot(sid, mode === 'directory' ? buf : `data:image/png;base64,${buf.toString('base64')}`);
  }
  await writer.finalize();
  return writer.outPath;
}
