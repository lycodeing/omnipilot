// 执行记录器（§1.4 / §14.1）：run.json 的唯一写入口。
// - runId = run-YYYYMMDD-HHmmss-<4位随机>；目录 runs/<runId>/，记录 runs/<runId>.json
// - startStep/end 记 startedAt（相对 run 起点 ms）与 durationMs；locate 原样透传
// - attachScreenshot 落 runs/<runId>/step-<i>.png，回填 step.screenshot 相对路径
// - finish(status,{exitCode}) 组装 §14.1 完整形状，tmp+rename 原子写
// - 脱敏（§19.7）：secret 步结果字段强制替换 [REDACTED:<provider>:<key>]；
//   全文兜底扫描依赖已登记的 secret 值（end 的 secret.value 或 registerSecret）

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const STATUSES = ['pass', 'fail', 'error', 'timeout', 'cancelled'];

const pad2 = (n) => String(n).padStart(2, '0');

function stamp(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function localIso(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// device 可为 §1.1 门面（duck-type 调用）或 { serial, model, size } 描述对象
async function snapshotDevice(device) {
  if (!device) return null;
  const out = { serial: null, model: null, size: null };
  if (typeof device.serial === 'string') out.serial = device.serial;
  if (typeof device.model === 'string') out.model = device.model;
  try {
    if (typeof device.screenSize === 'function') {
      const s = await device.screenSize();
      if (s) out.size = `${s.w}x${s.h}`;
    } else if (typeof device.size === 'string') {
      out.size = device.size;
    } else if (device.size && typeof device.size === 'object') {
      out.size = `${device.size.w}x${device.size.h}`;
    }
  } catch {
    // 设备快照失败不阻塞收尾
  }
  return out;
}

function pickModel(model) {
  if (!model) return null;
  // 只挑白名单字段，密钥类内容（如 apiKey）结构性不落盘
  return {
    family: model.family ?? null,
    name: model.name ?? null,
    baseUrlHash: model.baseUrlHash ?? null,
  };
}

// 全文兜底：深遍历所有字符串，替换已登记 secret 值。
// 性能：secrets 为空直接短路（绝大多数 run 无 secret）；非空时把 K 个值合成单个交替
// 正则一次扫描，避免 O(字符串数 × secret 数) 的重复 replaceAll。
function buildRedactor(secrets) {
  const usable = secrets.filter((s) => s && s.value);
  if (!usable.length) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(usable.map((s) => esc(String(s.value))).join('|'), 'g');
  const byValue = new Map(usable.map((s) => [String(s.value), `[REDACTED:${s.provider}:${s.key}]`]));
  return (s) => s.replace(re, (m) => byValue.get(m) ?? m);
}

function redactDeep(node, redact) {
  if (typeof node === 'string') return redact(node);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = redactDeep(node[i], redact);
    return node;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = redactDeep(node[k], redact);
    return node;
  }
  return node;
}

export class RunRecorder {
  constructor({ runsDir = 'runs', caseName = null, device = null, model = null } = {}) {
    this.runId = `run-${stamp(new Date())}-${crypto.randomBytes(2).toString('hex')}`;
    this._runsDir = runsDir;
    this._dir = path.join(runsDir, this.runId);
    this._jsonPath = path.join(runsDir, `${this.runId}.json`);
    fs.mkdirSync(this._dir, { recursive: true });
    this._startMs = Date.now();
    this._startedAt = localIso(this._startMs);
    this._caseName = caseName ?? null;
    this._device = device;
    this._model = pickModel(model);
    this._steps = [];
    this._stepStarts = [];
    this._assertions = [];
    this._network = [];
    this._rollbacks = [];
    this._extracts = null;
    this._contextLayers = [];
    this._uiDumps = [];
    this._secrets = []; // { provider, key, value }
    this._pendingWrites = []; // attachScreenshot 的后台写盘 Promise，finish 前统一 await
    this._finished = false;
  }

  get dir() {
    return this._dir;
  }

  // 已记账的步骤数（run 循环用于检测"空轮"：prompt 后无工具调用且无文本）
  get stepCount() {
    return this._steps.length;
  }

  // 返回 index >= fromIndex 的已记账步骤（run 循环检测本轮是否调过动作类工具）
  stepsSince(fromIndex) {
    return this._steps.filter((s) => s.index >= fromIndex);
  }

  get jsonPath() {
    return this._jsonPath;
  }

  // B 的 secret_get/sms_read 拿到值后登记，供 finish 全文兜底扫描
  registerSecret({ provider, key, value }) {
    if (!provider || !key) throw new Error('registerSecret 需要 provider 与 key');
    this._secrets.push({ provider, key, value: value ?? null });
  }

  // 登记后台任务（取证截图链/写盘），finish 前循环排空。
  // 用循环而非单次 Promise.all：链 Promise resolve 时可能又挂入新的写盘 Promise。
  trackPending(promise) {
    if (promise && typeof promise.then === 'function') this._pendingWrites.push(promise);
  }

  // 公开排空入口：信号退出路径（gracefulExit）也需等齐在途截图写盘
  flushPending() {
    return this._drainPending();
  }

  async _drainPending() {
    while (this._pendingWrites.length) {
      const batch = this._pendingWrites.splice(0, this._pendingWrites.length);
      await Promise.all(batch);
    }
  }

  startStep(type, target = null) {
    if (this._finished) throw new Error('run 已收尾，不能再 startStep');
    const absStart = Date.now();
    const index = this._steps.length;
    const step = {
      index,
      type,
      target,
      startedAt: absStart - this._startMs,
      durationMs: null,
      result: null,
      locate: null,
      screenshot: null,
      error: null,
    };
    this._steps.push(step);
    this._stepStarts.push(absStart);
    return {
      index,
      end: (opts = {}) => {
        if (this._finished) throw new Error('run 已收尾，不能再 end');
        if (step.result !== null) throw new Error(`step ${index} 已 end，不能重复收口`);
        const { result = 'ok', locate = null, secret = null, error = null, thought = null } = opts ?? {};
        step.durationMs = Date.now() - absStart;
        step.result = result;
        step.locate = locate; // 原样透传（§1.4）
        step.error = error;
        if (thought != null) step.thought = thought;
        if (secret) {
          if (!secret.provider || !secret.key) throw new Error('secret 需要 provider 与 key');
          // 结果字段强制脱敏（§14.1 / §19.7）
          step.result = `[REDACTED:${secret.provider}:${secret.key}]`;
          if (secret.value != null) this.registerSecret(secret);
        }
      },
    };
  }

  // 落 PNG（契约签名同步返回 string 路径）。写盘改异步后台：旧实现 writeFileSync
  // 会在每个动作步阻塞事件循环（PNG 可达 MB 级，--parallel 时冻结其它设备 IO）。
  // 路径先同步算好返回，写盘挂入 _pendingWrites，finish() 前统一 await 保证收尾完整。
  attachScreenshot(stepIndex, pngBuffer) {
    const file = `step-${stepIndex}.png`;
    const abs = path.join(this._dir, file);
    const rel = toPosix(path.join(this._runsDir, this.runId, file));
    const step = this._steps[stepIndex];
    if (step) step.screenshot = rel;
    this._pendingWrites.push(fsp.writeFile(abs, pngBuffer).catch(() => { /* 截图写失败不阻断 run */ }));
    return rel;
  }

  addUiDump(relPath) {
    this._uiDumps.push(relPath);
  }

  addAssertion({ text, passed, reason = null } = {}) {
    this._assertions.push({ text, passed, reason });
  }

  addNetworkEvent({ at, profile } = {}) {
    this._network.push({ at, profile });
  }

  addRollback({ stepIndex, reason, recovered } = {}) {
    this._rollbacks.push({ stepIndex, reason, recovered });
  }

  setExtracts(obj) {
    this._extracts = obj ?? null;
  }

  setContextLayers(layers) {
    if (!Array.isArray(layers)) throw new Error('setContextLayers 需要数组');
    this._contextLayers = layers;
  }

  async finish(status, { exitCode = 0 } = {}) {
    if (this._finished) throw new Error('finish 不能重复调用');
    if (!STATUSES.includes(status)) {
      throw new Error(`finish.status 必须是 ${STATUSES.join('|')}，收到 "${status}"`);
    }
    this._finished = true;
    for (let i = 0; i < this._steps.length; i++) {
      if (this._steps[i].result === null) {
        this._steps[i].result = 'unfinished';
        this._steps[i].durationMs = Date.now() - this._stepStarts[i];
      }
    }
    const doc = {
      runId: this.runId,
      case: this._caseName,
      status,
      exitCode,
      startedAt: this._startedAt,
      durationMs: Date.now() - this._startMs,
      device: await snapshotDevice(this._device),
      model: this._model,
      contextLayers: this._contextLayers,
      steps: this._steps,
      assertions: this._assertions,
      extracts: this._extracts,
      networkTimeline: this._network,
      rollbacks: this._rollbacks,
      artifacts: {
        report: toPosix(path.join(this._runsDir, this.runId, 'index.html')), // 预留
        uiDumps: this._uiDumps,
      },
    };
    const redact = buildRedactor(this._secrets);
    if (redact) redactDeep(doc, redact); // 无 secret 时短路，省一次全树遍历
    // 收尾前排空后台取证截图与写盘，保证 run.json 落盘时截图已在目录中
    await this._drainPending();
    const tmp = `${this._jsonPath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
    await fsp.rename(tmp, this._jsonPath);
    // 默认产出 HTML 报告（与 JSON 同目录 report.html）：失败不阻断 run，只告警。
    // 截图以 assets 目录形态落盘（run 目录已有 png，无需再内联成 MB 级 base64）。
    // 传深拷贝：report 侧 redactDump 会原地改写 assertions.reason，不能污染返回给调用方的 doc。
    try {
      const { writeReport } = await import('../../report/recorder.js');
      const htmlPath = path.join(this._runsDir, `${this.runId}.html`);
      await writeReport(structuredClone(doc), {
        outPath: htmlPath,
        mode: 'directory',
        groupName: this._caseName,
      });
      doc.artifacts.report = toPosix(htmlPath);
      this._htmlPath = htmlPath;
      // 报告已生成：把 artifacts.report 同步回 JSON（二次写盘，代价可忽略）
      await fsp.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
      await fsp.rename(tmp, this._jsonPath);
    } catch (e) {
      console.warn(`[report] HTML 报告生成失败（run.json 已保存）：${e?.message ?? e}`);
    }
    return doc;
  }

  get htmlPath() {
    return this._htmlPath ?? null;
  }
}
