// 执行记录器（§1.4 / §14.1）：run.json 的唯一写入口。
// - runId = run-YYYYMMDD-HHmmss-<4位随机>；目录 runs/<runId>/，记录 runs/<runId>.json
// - startStep/end 记 startedAt（相对 run 起点 ms）与 durationMs；locate 原样透传
// - attachScreenshot 落 runs/<runId>/step-<i>.png，回填 step.screenshot 相对路径
// - attachAssertionShot 落 runs/<runId>/assert-<i>.png（断言判定输入，不挂 step 索引）
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
// 导出供 report 侧复用：CLI 的 build 路径也要有同一份全文兜底保证
// （此前只有 recorder 路径有，CLI 生成的报告可能残留明文 secret）。
export function buildRedactor(secrets) {
  const usable = (secrets ?? []).filter((s) => s && s.value);
  if (!usable.length) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(usable.map((s) => esc(String(s.value))).join('|'), 'g');
  const byValue = new Map(usable.map((s) => [String(s.value), `[REDACTED:${s.provider}:${s.key}]`]));
  return (s) => s.replace(re, (m) => byValue.get(m) ?? m);
}

export function redactDeep(node, redact) {
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
  // reportDir：HTML 报告的落点（工作区布局下的 <instance>/report/）。
  // 缺省与 runsDir 同级（历史行为：报告落在 run 目录内）。传入时报告写到该目录——
  // 与 README/工作区布局承诺的 "report/ 生成 HTML 报告" 一致。
  constructor({ runsDir = 'runs', reportDir = null, caseName = null, device = null, model = null } = {}) {
    this.runId = `run-${stamp(new Date())}-${crypto.randomBytes(2).toString('hex')}`;
    this._runsDir = runsDir;
    this._reportDir = reportDir ?? runsDir;
    this._dir = path.join(runsDir, this.runId);
    this._jsonPath = path.join(runsDir, `${this.runId}.json`);
    fs.mkdirSync(this._dir, { recursive: true });
    fs.mkdirSync(this._reportDir, { recursive: true });
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
    this._engineLog = [];
    this._extracts = null;
    this._contextLayers = [];
    this._uiDumps = [];
    this._secrets = []; // { provider, key, value }
    this._pendingWrites = []; // attachScreenshot 的后台写盘 Promise，finish 前统一 await
    this._finished = false;
    // 崩溃安全（2026-11-24）：run.json 原先只在 finish() 落盘，SIGKILL/OOM/设备断连
    // 会让整条 run 的步骤、断言、网络时间线全部丢失（只剩孤儿截图）。改为记账后去抖
    // 增量落盘，崩溃后仍留下可解析的 partial JSON（_partial 标记），finish 时覆写为最终态。
    this._partialTimer = null;
    this._partialWriting = null;
    this._partialPending = false;
  }

  // 去抖触发一次增量快照落盘（崩溃安全）。timer 不可靠（进程可能随时被杀），
  // 故同时保证「至少已发起过一次写盘」，不追求严格去抖语义。
  _schedulePartial() {
    if (this._finished) return;
    this._partialPending = true;
    if (this._partialTimer) return;
    this._partialTimer = setTimeout(() => {
      this._partialTimer = null;
      this._flushPartial().catch(() => { /* 快照写失败不阻断 run */ });
    }, 500);
    // 不因快照挂住进程退出
    if (typeof this._partialTimer.unref === 'function') this._partialTimer.unref();
  }

  // 写增量快照：与 finish() 的最终写互斥（同一时刻只允许一个写盘在途）
  //
  // 关键：_partialWriting 必须在 await 之前赋值。若先 await _buildDoc()（内部有
  // snapshotDevice 的真实设备 IO，耗时可达数百 ms）再赋值，finish() 会看到
  // _partialWriting 仍是 null 而不等待——于是 finish 先写最终态，迟到的快照
  // 随后把已完成的 run 覆盖回 status:'running' + _partial:true（已复现）。
  async _flushPartial() {
    if (this._finished) return;
    if (this._partialWriting) {
      // 上一次还在写 → 标记待重试，等它结束再写
      this._partialPending = true;
      return;
    }
    this._partialPending = false;
    // 整个「构建 doc + 写盘」包进同一个 Promise，让 finish() 能正确等待
    this._partialWriting = (async () => {
      const doc = await this._buildDoc('running', 0, true);
      // 构建期间可能已被 finish() 收尾 → 放弃本次快照（最终态已由 finish 写好）
      if (this._finished) return;
      const redact = buildRedactor(this._secrets);
      if (redact) redactDeep(doc, redact);
      const tmp = `${this._jsonPath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      try {
        await fsp.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
        // rename 前二次确认：finish 可能恰好在 writeFile 期间完成收尾
        if (this._finished) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          return;
        }
        await fsp.rename(tmp, this._jsonPath);
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    })();
    try {
      await this._partialWriting;
    } finally {
      this._partialWriting = null;
    }
    if (this._partialPending && !this._finished) {
      this._schedulePartial();
    }
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
        this._schedulePartial();
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

  // 断言判定输入截图（Task 14）：与 step 索引无关，文件名 assert-<i>.png。
  // 判定输入可能是压缩 JPEG（mimeType=image/jpeg），但文件名统一 .png 简化消费方——
  // MIME 由报告端 dataURL 头按文件魔数表达（见 report/recorder.js toDataURL）。
  // 与 attachScreenshot 同走 _pendingWrites 后台写盘，finish() 前统一排空保证落盘完整。
  attachAssertionShot(assertIndex, buffer) {
    const file = `assert-${assertIndex}.png`;
    const abs = path.join(this._dir, file);
    const rel = toPosix(path.join(this._runsDir, this.runId, file));
    this._pendingWrites.push(fsp.writeFile(abs, buffer).catch(() => { /* 截图写失败不阻断 run */ }));
    return rel;
  }

  addUiDump(relPath) {
    this._uiDumps.push(relPath);
    this._schedulePartial();
  }

  // 扩展字段（评审 C-P2）：screenshotId=判定输入截图相对路径、evidenceSource=判定依据
  // （dataset/screen）、nudges=催答轮数。三者可选，缺省不落键——旧调用点与旧报告形状不变。
  addAssertion({ text, passed, reason = null, screenshotId = null, evidenceSource = null, nudges = 0 } = {}) {
    const a = { text, passed, reason };
    if (screenshotId != null) a.screenshotId = screenshotId;
    if (evidenceSource != null) a.evidenceSource = evidenceSource;
    if (nudges > 0) a.nudges = nudges;
    this._assertions.push(a);
    this._schedulePartial();
  }

  addNetworkEvent({ at, profile } = {}) {
    this._network.push({ at, profile });
    this._schedulePartial();
  }

  addRollback({ stepIndex, reason, recovered } = {}) {
    this._rollbacks.push({ stepIndex, reason, recovered });
    this._schedulePartial();
  }

  // 引擎直执行步骤的 run 内记录（ctx.engineLog）落 run.json：失败步（含降级后仍失败）
  // 是终态判定与排查的依据，不能只留在内存里
  setEngineLog(log) {
    this._engineLog = Array.isArray(log) ? log : [];
    this._schedulePartial();
  }

  setExtracts(obj) {
    this._extracts = obj ?? null;
    this._schedulePartial();
  }

  setContextLayers(layers) {
    if (!Array.isArray(layers)) throw new Error('setContextLayers 需要数组');
    this._contextLayers = layers;
    this._schedulePartial();
  }

  // 组装 §14.1 形状的 run 文档。partial=true 时为崩溃安全的增量快照。
  async _buildDoc(status, exitCode, partial = false) {
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
      engineLog: this._engineLog,
      artifacts: {
        // 与 steps[].screenshot 同一基准（相对 runsDir）——同一 artifacts 对象内
        // 混用绝对/相对路径会让跨机消费方无法用统一规则解析
        report: toPosix(path.join(this.runId, 'index.html')),
        uiDumps: this._uiDumps,
      },
    };
    // 增量快照标记：崩溃后据此判断 run 未正常收尾（最终态会覆写去掉该标记）
    if (partial) doc._partial = true;
    return doc;
  }

  async finish(status, { exitCode = 0 } = {}) {
    if (this._finished) throw new Error('finish 不能重复调用');
    if (!STATUSES.includes(status)) {
      throw new Error(`finish.status 必须是 ${STATUSES.join('|')}，收到 "${status}"`);
    }
    this._finished = true;
    // 取消待触发的增量快照，并等在途快照写完，避免与最终写竞争
    if (this._partialTimer) {
      clearTimeout(this._partialTimer);
      this._partialTimer = null;
    }
    if (this._partialWriting) {
      try { await this._partialWriting; } catch { /* 忽略 */ }
    }
    for (let i = 0; i < this._steps.length; i++) {
      if (this._steps[i].result === null) {
        this._steps[i].result = 'unfinished';
        this._steps[i].durationMs = Date.now() - this._stepStarts[i];
      }
    }
    const doc = await this._buildDoc(status, exitCode, false);
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
      // 报告写进 **report 目录**（工作区布局：<instance>/report/<runId>/index.html）。
      // writeReport 的 baseDir 取 dirname(outPath)，报告的截图副本会落到
      // <baseDir>/screenshots/ —— 若 outPath 在共享的 runs/ 根，全部 run 的截图副本都
      // 堆进同一个 runs/screenshots/，无上限增长且与 recorder 的原始 PNG 分离。
      // 放进 run 专属子目录后副本与原始截图同目录，随 run 一起归档。
      const htmlPath = path.join(this._reportDir, this.runId, 'index.html');
      await writeReport(structuredClone(doc), {
        outPath: htmlPath,
        mode: 'directory',
        groupName: this._caseName,
        runDir: this._runsDir,
        secrets: this._secrets,   // 全文兜底脱敏（与 CLI 路径同一份保证）
      });
      // 报告路径相对 runsDir（与 steps[].screenshot 同基准）
      doc.artifacts.report = toPosix(path.relative(this._runsDir, htmlPath));
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
