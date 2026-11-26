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

// HTML 实体解码：属性值写入前经 attrEscape 转义，读取时需还原。
// 浏览器的 getAttribute 会自动解码，而正则提取（tools.js 的 extractDumps）不会——
// 不解码则两侧算出的 group id 不一致，破坏契约「按 data-group-id 去重保最新」。
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');   // 必须最后解码（&amp;amp; → &amp; → &）
}

function attrVal(attrs, name) {
  const m = String(attrs ?? '').match(`${name}="([^"]*)"`);
  return m ? decodeEntities(m[1]) : null;
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

// JSON 写入前转义 < 防止进入 HTML 的 script-data 状态机。
// 只转义 </ 不够：`<!--<script>` 会让 HTML 解析器进入 "script data double escaped"，
// 此后的 </script> 不再闭合标签，后续全部内容被吞进 script 元素——整份报告损坏。
// 转义 < 为 < 是合法 JSON 转义（JSON.parse 后原样还原），且不进入任何 tokenizer 状态。
export function escapeJsonForScript(json) {
  return json.replace(/</g, '\\u003c');
}

export function makeDumpTag(groupId, dump) {
  const json = escapeJsonForScript(JSON.stringify(dump ?? {}));
  return `<script type="${DUMP_TAG_TYPE}" data-group-id="${attrEscape(groupId ?? 'default')}">${json}</script>`;
}

// 图片标签的 src 也要防注入：data: URL 里若含 "</script>" 会提前闭合 script 元素。
// writeReport 走 Buffer→base64 路径（天然安全），但 appendScreenshot 是公开 API，
// 调用方可能直接传字符串——必须校验格式。
const DATA_URL_RE = /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]*$/i;
export function makeImageTag(id, src) {
  const raw = String(src ?? '');
  // 非 data: URL（如相对路径，directory 模式）直接原样；data: URL 必须匹配
  // base64 形态——否则 "</script>" 之类能注入。
  if (/^data:/i.test(raw) && !DATA_URL_RE.test(raw)) {
    throw new Error('makeImageTag：data URL 格式非法（须为 data:image/<type>;base64,<payload>）');
  }
  if (/<\/script/i.test(raw)) {
    throw new Error('makeImageTag：src 含 </script，会提前闭合标签');
  }
  return `<script type="${IMAGE_TAG_TYPE}" data-id="${attrEscape(id)}">${raw}</script>`;
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
    // result 词表收敛：写侧有 'ok'|'failed'|'cancelled'|'error' 四种
    // （withRecording），fixture/旧数据还有 'fail' 拼写；cancelled 与 error 需各自成态，
    // 报告语义才无损。映射为四态 + 未知拼写兜底 failed。
    //
    // 脱敏标记 [REDACTED:provider:key] 也必须识别为成功：recorder 对 secret 类步骤
    // 会把 result 覆写成脱敏标记（防密钥落盘），若按"未知值→failed"处理，
    // 一次**成功**的 secret_get 会在报告里显示为 failed——状态信号被脱敏机制毁掉。
    const rawResult = String(step.result ?? '');
    const redactedOk = rawResult.startsWith('[REDACTED');
    const status = rawResult === 'ok' || redactedOk ? 'finished'
      : rawResult === 'cancelled' ? 'cancelled'
      : rawResult === 'error' ? 'error'
      : 'failed'; // failed / 旧拼写 fail / 未知值一律按失败显示
    const task = {
      taskId: String(step.index),
      type: step.type,
      status,
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
      // secret_get/sms_read 的 provider/key 必须保留：redactDump 按
      // param.key ?? param.provider ?? 'secret' 生成脱敏 token，缺了就退化成
      // 通用 'secret'，报告里丢失"脱敏的是哪个凭据"这一信息（CONTRACT §5.1）。
      const m = /^\[REDACTED:([^:\]]+):([^\]]*)\]$/.exec(rawResult);
      if (m) {
        task.param.key = m[2] || undefined;
        task.param.provider = m[1] || undefined;
      }
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
  if (data instanceof Uint8Array) {
    // 判定输入图可能是压缩 JPEG（FFD8 魔数），硬编码 image/png 会让浏览器拒绝解码
    const mime = data[0] === 0xFF && data[1] === 0xD8 ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${Buffer.from(data).toString('base64')}`;
  }
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
    const json = escapeJsonForScript(JSON.stringify(d));
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
      const json = escapeJsonForScript(JSON.stringify(dump));
      tags.push(`<script type="${DUMP_TAG_TYPE}" data-group-id="${attrEscape(gid)}"${extra}>${json}</script>`);
    }
    for (const [iid, [start, end]] of images) tags.push(makeImageTag(iid, content.slice(start, end)));
    let doc = insertBeforeBody(this._shell, tags.map((t) => `${t}\n`).join(''));
    if (this.mode === 'directory') doc = ensureBaseTag(doc);
    // tmp 名带 pid+随机后缀：固定名会让两个并发 writer 写同一 outPath 时互相踩
    // （一方 rename 后另一方再 rename → ENOENT，或读到对方的半截内容）。
    const tmp = `${this.outPath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
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
  // 目录约束：只允许内联 dist 内的资源。path.resolve 会让 ../ 逃出 dist，
  // 导致 dist 外的任意文件被读进报告（报告是会被分享的产物）。
  const distRoot = path.resolve(dir) + path.sep;
  const resolveInDist = (rel) => {
    const abs = path.resolve(dir, decodeURIComponent(rel));
    return abs.startsWith(distRoot) ? abs : null;
  };
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, pre, src, post) => {
    if (isExternal(src)) return tag;
    const abs = resolveInDist(src);
    if (!abs) return tag;   // 越界 → 保持原样（与外链同样处理）
    let code;
    try {
      code = fsSync.readFileSync(abs, 'utf8');
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
    const abs = resolveInDist(href);
    if (!abs) return tag;   // 越界 → 保持原样
    let css;
    try {
      css = fsSync.readFileSync(abs, 'utf8');
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

// secrets：可选的 { provider, key, value } 列表——用于**全文兜底脱敏**。
// recorder 路径在写 run.json 时已做过全文扫描（buildRedactor），但 CLI 的
// `report/cli.js build` 路径没有：模型在**后续非 secret 任务**的 thought 里
// 回显密钥时会以明文进报告。传入 secrets 让两条入口共享同一份保证。
export async function writeReport(runJson, { outPath, mode = 'single-html', shell, groupName, runDir, secrets = null } = {}) {
  if (!outPath) throw new Error('writeReport 需要 outPath');
  const writer = new ReportWriter({ outPath, shell, mode });
  writer._batch = []; // 一次性批量路径：标签攒内存，finalize 只写一次文件
  const run = runJson ?? {};
  const screenshotIds = {};
  for (const step of run.steps ?? []) {
    if (step?.screenshot) screenshotIds[step.index] = crypto.randomUUID();
  }
  const dump = redactDump(buildDump(run, { groupName, screenshotIds }));
  // 断言判定输入截图（Task 14）：有 screenshotId 的断言生成独立 uuid、读原文件嵌进报告，
  // screenshots map 加该 uuid，assertion.screenshotId 由文件路径替换为 uuid（与 step 截图同口径）。
  // 传 Buffer 让 toDataURL 按文件魔数判 MIME——判定输入可能是 JPEG，硬编码 png 会让浏览器拒绝解码。
  // 读 + 嵌图全程用 try/catch 兜底：uuid/占位/回填只在两者都成功后才落，避免读文件失败
  // （权限/竞态删除）或 appendScreenshot 异常时整份报告中断，或留下"screenshotId 已是 uuid
  // 但 map 空串/无图标签"的不一致 dump。
  if (Array.isArray(dump.assertions)) {
    for (const a of dump.assertions) {
      const rel = a?.screenshotId;
      if (!rel) continue;
      const file = resolveScreenshotFile(rel, writer.outPath, { runDir });
      if (!file) {
        console.warn(`[report] 断言截图文件缺失，跳过: ${rel}`);
        delete a.screenshotId; // 清掉原始路径：既不随报告外泄，也不与 uuid 口径混用
        continue;
      }
      let id;
      try {
        const buf = await fsp.readFile(file);
        id = crypto.randomUUID();
        await writer.appendScreenshot(id, buf);
      } catch (e) {
        console.warn(`[report] 断言截图读取/嵌入失败，跳过: ${rel}（${e.message}）`);
        continue; // 不抛、不改 dump
      }
      // 读 + 写均成功后才改 dump
      dump.screenshots[id] = '';
      a.screenshotId = id;
    }
  }
  // 全文兜底：secret 值出现在任何字符串里都替换（不止本任务自己的 thought/param）
  if (Array.isArray(secrets) && secrets.length) {
    const { buildRedactor, redactDeep } = await import('../src/recorder/index.js');
    const redact = buildRedactor(secrets);
    if (redact) redactDeep(dump, redact);
  }
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
