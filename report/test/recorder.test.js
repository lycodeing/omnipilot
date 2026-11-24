// recorder.js 测试（CONTRACT §5.4）：buildDump §19.5 映射逐项、redact 三处落点、标签转义、
// 增量 append + finalize 去重保最新、directory 模式、loadShell 兜底与内联、writeReport 端到端

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DUMP_TAG_TYPE, IMAGE_TAG_TYPE, REDACTED_PREFIX,
  buildDump, redactValue, redactDump, makeDumpTag, makeImageTag,
  ReportWriter, loadShell, writeReport,
} from '../recorder.js';
import { extractDumps } from '../tools.js';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/run.sample.json'), 'utf8'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const clone = (v) => JSON.parse(JSON.stringify(v));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const countTag = (html, type) => html.split(`type="${type}"`).length - 1;

// ---------- buildDump ----------

test('buildDump 按 §19.5 映射表逐字段转换', () => {
  const run = clone(FIXTURE);
  const dump = buildDump(run, {
    groupName: '巡检组',
    screenshotIds: { 0: 'uuid-0', 1: 'uuid-1', 3: 'uuid-3' },
  });

  assert.equal(dump.sdkVersion, 'ask-0.1.0');
  assert.equal(dump.groupName, '巡检组');
  assert.equal(dump.groupDescription, '');
  assert.equal(dump.deviceType, 'android');
  assert.deepEqual(dump.device, run.device);
  assert.deepEqual(dump.modelBriefs, [{ intent: 'planning', name: 'glm-4.6v' }]);
  assert.equal(dump.durationMs, 48213);
  assert.equal(dump.status, 'fail');
  assert.deepEqual(dump.networkTimeline, run.networkTimeline);
  assert.deepEqual(dump.assertions, run.assertions);
  assert.deepEqual(dump.rollbacks, run.rollbacks);
  assert.ok(!('extracts' in dump) && !('contextLayers' in dump)); // 派生视图，非超集

  const [exec] = dump.executions;
  assert.equal(dump.executions.length, 1);
  assert.equal(exec.id, 'run-20261026-153012-ab12');
  assert.equal(exec.name, 'cases/相册列表.yaml');
  assert.equal(exec.logTime, '2026-10-26T15:30:12+08:00');
  assert.equal(exec.tasks.length, 6);

  const t0 = exec.tasks[0];
  assert.equal(t0.taskId, '0'); // taskId=String(index)
  assert.equal(t0.type, 'tap');
  assert.equal(t0.status, 'finished'); // ok→finished
  assert.equal(t0.thought, '首页点击电子相册入口');
  assert.deepEqual(t0.param, { target: '电子相册' }); // target→param.target
  assert.equal(t0.errorMessage, null);
  assert.deepEqual(t0.timing, { start: 4210, end: 4522, durationMs: 312 }); // end=startedAt+durationMs
  const { screenshotId, ...locateRest } = t0.locate;
  assert.equal(screenshotId, 'uuid-0'); // 回填 locate.screenshotId
  assert.deepEqual(locateRest, run.steps[0].locate); // locate 原样透传（含缓存字段）

  const t1 = exec.tasks[1];
  assert.equal(t1.type, 'key');
  assert.deepEqual(t1.param, { target: 'back' });
  assert.equal(t1.locate, undefined); // 无定位步骤 locate 整体缺省
  assert.equal(t1.screenshotId, 'uuid-1'); // 无 locate 的步骤仍持有截图引用

  const t2 = exec.tasks[2];
  assert.equal(t2.type, 'assert');
  assert.deepEqual(t2.param, { text: '列表按时间倒序' }); // assert 步 param 为 { text }

  const t3 = exec.tasks[3];
  assert.equal(t3.status, 'failed'); // 非 ok→failed
  assert.equal(t3.errorMessage, 'locate_miss_x3');
  assert.deepEqual(t3.locate, { ...run.steps[3].locate, screenshotId: 'uuid-3' });

  assert.equal(exec.tasks[4].status, 'failed'); // run.json 里 secret 步 result 是 token，非 ok
  assert.deepEqual(Object.keys(dump.screenshots).sort(), ['uuid-0', 'uuid-1', 'uuid-3']);
  assert.deepEqual(Object.values(dump.screenshots), ['', '', '']); // single-html 值一律空串
});

test('buildDump 缺省与空 steps、runId 覆盖、随机 uuid', () => {
  const empty = buildDump({});
  assert.equal(empty.groupName, 'default');
  assert.deepEqual(empty.executions, [{ id: 'run-unknown', name: 'default', logTime: null, tasks: [] }]);
  assert.deepEqual(empty.screenshots, {});
  assert.deepEqual(empty.modelBriefs, []);
  assert.ok(!('device' in empty) && !('status' in empty) && !('durationMs' in empty));

  const named = buildDump({ steps: [] }, { groupName: '批次A', runId: 'run-x' });
  assert.equal(named.groupName, '批次A');
  assert.equal(named.executions[0].id, 'run-x');

  const noName = buildDump({ model: { family: 'glm' } });
  assert.deepEqual(noName.modelBriefs, []);

  const rand = buildDump({ steps: [{ index: 0, type: 'tap', target: 'x', startedAt: 1, durationMs: 2, screenshot: 'p.png' }] });
  const task = rand.executions[0].tasks[0];
  assert.match(task.screenshotId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(rand.screenshots, { [task.screenshotId]: '' });
  assert.deepEqual(task.timing, { start: 1, end: 3, durationMs: 2 });
  assert.equal(task.status, 'failed'); // result 缺失→failed
});

// ---------- 脱敏 ----------

test('redactValue 输出 [REDACTED:provider:key]', () => {
  assert.equal(redactValue('mcp-sms', 'code'), '[REDACTED:mcp-sms:code]');
  assert.ok(REDACTED_PREFIX === '[REDACTED');
});

test('redactDump：secret_get/sms_read 的 thought/param/result/errorMessage 与 assertions.reason 全部替换', () => {
  const dump = {
    groupName: 'g',
    executions: [{
      id: 'r', name: 'n',
      tasks: [
        { taskId: '0', type: 'tap', status: 'finished', thought: '普通思考', param: { target: '按钮' } },
        { taskId: '1', type: 'secret_get', status: 'failed', thought: '验证码 654321', param: { target: 'sms_code' } },
        {
          taskId: '2', type: 'sms_read', status: 'failed', thought: '短信原文',
          param: { key: 'code', provider: 'mcp-sms', note: '原始值 654321' },
          result: '654321', errorMessage: '读取失败: 654321',
        },
      ],
    }],
    assertions: [{ text: '登录成功', passed: true, reason: '验证码 654321 已提交' }],
  };
  redactDump(dump);
  const tasks = dump.executions[0].tasks;

  assert.equal(tasks[0].thought, '普通思考'); // 非 secret 任务不动
  assert.deepEqual(tasks[0].param, { target: '按钮' });

  assert.equal(tasks[1].thought, '[REDACTED:secret_get:secret]'); // param 无 key/provider → 'secret'
  assert.deepEqual(tasks[1].param, { target: '[REDACTED:secret_get:secret]' });

  assert.equal(tasks[2].thought, '[REDACTED:sms_read:code]'); // param.key 优先
  assert.deepEqual(tasks[2].param, {
    key: '[REDACTED:sms_read:code]', provider: '[REDACTED:sms_read:code]', note: '[REDACTED:sms_read:code]',
  });
  assert.equal(tasks[2].result, '[REDACTED:sms_read:code]');
  assert.equal(tasks[2].errorMessage, '[REDACTED:sms_read:code]');

  assert.equal(dump.assertions[0].reason, '[REDACTED:secret_get:secret]'); // reason 同样扫描
  assert.ok(JSON.stringify(dump).includes('654321') === false);
});

test('redactDump 对无秘密/畸形输入安全', () => {
  const clean = { groupName: 'g', executions: [{ id: 'r', name: 'n', tasks: [{ taskId: '0', type: 'tap' }] }] };
  redactDump(clean);
  assert.equal(clean.executions[0].tasks[0].thought, undefined);
  assert.deepEqual(redactDump({ executions: [{ tasks: [{ type: 'secret_get' }] }] }),
    { executions: [{ tasks: [{ type: 'secret_get' }] }] });
  assert.equal(redactDump(null), null);
  assert.deepEqual(redactDump({}), {}); // 无 executions 直接返回
});

// ---------- 标签 ----------

test('makeDumpTag 转义 </script>、保留中文、可 round-trip', () => {
  const dump = { groupName: 'g1', note: '</script><script>alert(1)</script> 中文「电子相册」' };
  const tag = makeDumpTag('g1', dump);
  assert.ok(tag.startsWith('<script type="ask-dump" data-group-id="g1">'));
  assert.ok(tag.endsWith('</script>'));
  assert.equal(tag.split('</script>').length - 1, 1); // 体内无裸闭合
  assert.ok(tag.includes('\\u003c/script>'), '小于号被转义为 JSON 合法转义');
  assert.ok(tag.includes('电子相册'));
  const payload = tag.slice(tag.indexOf('>') + 1, -'</script>'.length);
  assert.deepEqual(JSON.parse(payload), dump); // < 是合法 JSON 转义，解析还原
});

test('makeDumpTag：HTML 解析器状态安全（jsdom 实测）', () => {
  // 回归用例：只转义 </ 不够——`<!--<script>` 会让 HTML 解析器进入
  // "script data double escaped" 状态，此后 </script> 不再闭合标签，
  // 后续全部内容被吞进 script 元素，整份报告损坏（实测报"报告数据缺失"）。
  const payloads = [
    '<!--<script>',
    '<!--<script>x',
    '<script>',
    '</script>',
    '<!--<script>-->',
    'a<!--<script>b',
  ];
  for (const note of payloads) {
    const tag = makeDumpTag('g1', { note });
    const html = `<!doctype html><html><body>${tag}<div id="root">DATA</div></body></html>`;
    const dom = new JSDOM(html);
    const el = dom.window.document.querySelector('script[type="ask-dump"]');
    assert.ok(el, `payload ${JSON.stringify(note)} 应产出完整闭合的 dump 元素`);
    assert.equal(el.textContent.includes('DATA'), false, '后续内容不应被吞进 script 元素');
    assert.ok(dom.window.document.querySelector('#root'), '报告后续内容应完好');
    const payload = el.textContent;
    assert.deepEqual(JSON.parse(payload), { note }, '内容应可完整 round-trip');
  }
});

test('loadShell 不内联 dist 目录外的文件（路径穿越防护）', () => {
  // 回归用例：path.resolve 会让 ../ 逃出 dist，导致 dist 外任意文件被读进
  // 报告（报告是会被分享的产物）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-shell-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, 'secret.js'), 'globalThis.__leaked = true;');
  fs.writeFileSync(path.join(root, 'secret.css'), 'body { --leaked: 1 }');
  fs.writeFileSync(path.join(dist, 'index.html'), [
    '<!doctype html><html><head>',
    '  <link rel="stylesheet" href="../secret.css">',
    '</head><body>',
    '  <div id="root"></div>',
    '  <script src="../secret.js"></script>',
    '  <script src="./ok.js"></script>',
    '</body></html>',
  ].join('\n'));
  fs.writeFileSync(path.join(dist, 'ok.js'), 'console.log("inlined-ok");');
  const shell = loadShell(dist);
  assert.ok(!shell.includes('__leaked'), 'dist 外 JS 不应被内联');
  assert.ok(!shell.includes('--leaked'), 'dist 外样式不应被内联');
  assert.ok(shell.includes('inlined-ok'), 'dist 内文件应正常内联');
  fs.rmSync(root, { recursive: true, force: true });
});

test('makeDumpTag 转义 groupId 属性，makeImageTag 原样输出', () => {
  assert.ok(makeDumpTag('a"b', {}).startsWith('<script type="ask-dump" data-group-id="a&quot;b">'));
  assert.equal(
    makeImageTag('id-1', 'data:image/png;base64,AAA'),
    '<script type="ask-image" data-id="id-1">data:image/png;base64,AAA</script>',
  );
  assert.equal(DUMP_TAG_TYPE, 'ask-dump');
  assert.equal(IMAGE_TAG_TYPE, 'ask-image');
});

// ---------- ReportWriter：single-html 增量 + finalize ----------

test('single-html：同 group append×2 → 文件 2 标签 → finalize 后 1 个且保最新，tmp 清理', async (t) => {
  const dir = tmpDir(t);
  const out = path.join(dir, 'r.html');
  const w = new ReportWriter({ outPath: out, shell: loadShell(null) });
  const dumpA = { groupName: 'g', executions: [{ id: 'exec-old', name: '旧', tasks: [] }] };
  const dumpB = { groupName: 'g', executions: [{ id: 'exec-new', name: '新', tasks: [] }] };
  await w.appendExecution(dumpA);
  await w.appendExecution(dumpB);
  let html = fs.readFileSync(out, 'utf8');
  assert.equal(countTag(html, DUMP_TAG_TYPE), 2); // 重复 append 允许
  await w.appendScreenshot('img-1', 'data:image/png;base64,QUFB');
  await w.appendScreenshot('img-2', PNG); // Buffer 亦可
  html = fs.readFileSync(out, 'utf8');
  assert.equal(countTag(html, IMAGE_TAG_TYPE), 2);
  assert.ok(html.startsWith('<!doctype html>')); // 壳在前

  await w.finalize();
  html = fs.readFileSync(out, 'utf8');
  assert.equal(countTag(html, DUMP_TAG_TYPE), 1); // 去重保最新
  assert.equal(countTag(html, IMAGE_TAG_TYPE), 2);
  const [entry] = extractDumps(html);
  assert.equal(entry.groupId, 'g');
  assert.equal(entry.dump.executions[0].id, 'exec-new');
  assert.ok(html.includes('data:image/png;base64,QUFB'));
  assert.ok(html.includes(PNG.toString('base64')));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []); // tmp+rename 无残留
});

test('finalize 原子发布：仅 finalize（无 append）发布纯壳；壳含 </body>', async (t) => {
  const dir = tmpDir(t);
  const out = path.join(dir, 'r.html');
  const w = new ReportWriter({ outPath: out });
  await w.finalize();
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes('<div id="root">'));
  assert.ok(html.includes('</body>'));
  assert.equal(countTag(html, DUMP_TAG_TYPE), 0);
});

// ---------- ReportWriter：directory 模式 ----------

test('directory：PNG 落盘 baseDir/screenshots、dump 标签带 mode 属性与相对路径、插入 <base>', async (t) => {
  const dir = tmpDir(t);
  const out = path.join(dir, 'index.html');
  const w = new ReportWriter({ outPath: out, mode: 'directory' });
  const dump = { groupName: 'g', executions: [{ id: 'e1', name: 'n', tasks: [] }], screenshots: { 'shot-1': '' } };
  await w.appendExecution(dump);
  await w.appendScreenshot('shot-1', PNG.toString('base64'));
  await w.finalize();

  const png = fs.readFileSync(path.join(dir, 'screenshots', 'shot-1.png'));
  assert.equal(png.subarray(0, 4).toString('latin1'), '\x89PNG');
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes('data-screenshot-mode="directory"'));
  assert.ok(html.includes('<base href="./">'));
  assert.equal(countTag(html, IMAGE_TAG_TYPE), 0); // 不写 ask-image 标签
  const [entry] = extractDumps(html);
  assert.deepEqual(entry.dump.screenshots, { 'shot-1': './screenshots/shot-1.png' });
});

test('directory：dataURL 字符串与 Buffer 均可落盘，重复 id 覆盖', async (t) => {
  const dir = tmpDir(t);
  const w = new ReportWriter({ outPath: path.join(dir, 'i.html'), mode: 'directory', baseDir: dir });
  await w.appendScreenshot('s1', `data:image/png;base64,${PNG.toString('base64')}`);
  await w.appendScreenshot('s2', PNG);
  await w.appendScreenshot('s2', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02])); // 5 字节
  for (const id of ['s1', 's2']) {
    const f = fs.readFileSync(path.join(dir, 'screenshots', `${id}.png`));
    assert.equal(f.subarray(0, 4).toString('latin1'), '\x89PNG');
  }
  assert.equal(fs.readFileSync(path.join(dir, 'screenshots', 's2.png')).length, 5); // 覆盖为最新
});

// ---------- loadShell ----------

// 仓库自带的 viewer 构建产物（report/viewer/dist）不在版本库内（.gitignore 忽略 dist/），
// 需先 `npm --prefix report/viewer ci && npm --prefix report/viewer run build`。
// 未构建时下面的"真实壳"断言跳过，但纯逻辑断言（兜底 / 内联）始终执行——
// 否则新克隆或 CI 环境下该用例必然失败。
const VIEWER_DIST = path.join(__dirname, '..', 'viewer', 'dist', 'index.html');
const HAS_VIEWER_DIST = fs.existsSync(VIEWER_DIST);

test('loadShell：缺省用仓库自带 viewer/dist；显式坏路径才兜底', (t) => {
  // 缺省 = 开箱即用（真实构建壳内联），兜底壳只在显式路径不存在时出现
  const def = loadShell(null);
  if (HAS_VIEWER_DIST) {
    assert.ok(def.includes('ASK 测试报告'), '应内联仓库自带构建壳');
    assert.ok(!def.includes('报告壳未构建'));
  } else {
    t.skip('viewer/dist 未构建（先跑 npm --prefix report/viewer run build）');
  }
  for (const shell of [loadShell(path.join(os.tmpdir(), 'no-such-dist-xyz'))]) {
    assert.ok(shell.includes('<div id="root">报告壳未构建，仅数据可解析</div>'));
    assert.ok(shell.includes('</body>'));
  }
});

test('loadShell：未构建 viewer 时缺省走兜底壳（构建产物缺失时的确定行为）', () => {
  // dist 不存在时必须稳定落到兜底壳——报告仍可解析数据，只缺可视化
  const missing = loadShell(path.join(os.tmpdir(), 'no-such-dist-xyz'));
  assert.ok(missing.includes('报告壳未构建'));
  assert.ok(missing.includes('<title>ASK Report</title>'));
  // 兜底壳必须能被后续标签插入（writeReport 依赖 </body> 锚点）
  assert.ok(missing.includes('</body>'));
});

test('loadShell 内联本地 <script src> 与 <link rel=stylesheet>，外链保留', (t) => {
  const dist = tmpDir(t);
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 's.css'), 'body{color:red}');
  fs.writeFileSync(path.join(dist, 'assets', 'm.js'), "console.log('inlined-module');");
  fs.writeFileSync(path.join(dist, 'index.html'), [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <link rel="stylesheet" href="./assets/s.css">',
    '</head>',
    '<body>',
    '  <div id="root"></div>',
    '  <script type="module" crossorigin src="./assets/m.js"><\/script>',
    '  <script src="https://cdn.example.com/x.js"><\/script>',
    '</body>',
    '</html>',
  ].join('\n'));
  const shell = loadShell(dist);
  assert.ok(shell.includes('<style>\nbody{color:red}\n</style>'));
  assert.ok(shell.includes('<script type="module">')); // 保留 type，去 crossorigin
  assert.ok(shell.includes("console.log('inlined-module');"));
  assert.ok(shell.includes('src="https://cdn.example.com/x.js"')); // 外链不动
  assert.ok(!shell.includes('href="./assets/s.css"'));
  assert.ok(!shell.includes('crossorigin'));
});

// ---------- writeReport 端到端 ----------

function runWithRealShots(run, dir) {
  const r = clone(run);
  for (const i of [0, 1, 3]) {
    const p = path.join(dir, `step-${i}.png`);
    fs.writeFileSync(p, PNG);
    r.steps[i].screenshot = p; // 绝对路径，测试内直接可读
  }
  return r;
}

test('writeReport single-html：嵌图 dataURL、脱敏生效、缺失截图跳过', async (t) => {
  const dir = tmpDir(t);
  const run = runWithRealShots(FIXTURE, dir);
  run.steps[5].screenshot = 'no/such/file.png'; // 缺失文件
  const out = await writeReport(run, { outPath: path.join(dir, 'r.html'), groupName: 'E2E组' });
  const html = fs.readFileSync(out, 'utf8');
  assert.equal(countTag(html, IMAGE_TAG_TYPE), 3); // 缺失文件被跳过
  assert.equal(html.split('data:image/png;base64,').length - 1, 3);

  const [{ groupId, dump }] = extractDumps(html);
  assert.equal(groupId, 'E2E组');
  assert.equal(dump.executions[0].tasks[4].thought, '[REDACTED:secret_get:secret]'); // 构建即脱敏
  assert.ok(dump.assertions.every((a) => a.reason === '[REDACTED:secret_get:secret]'));
  assert.ok(!html.includes('654321'));
  assert.deepEqual(Object.keys(dump.screenshots).length, 4); // 含缺失文件的占位
});

test('writeReport directory：PNG 落盘与 screenshots 相对路径一一对应', async (t) => {
  const dir = tmpDir(t);
  const run = runWithRealShots(FIXTURE, dir);
  const out = await writeReport(run, { outPath: path.join(dir, 'rep', 'index.html'), mode: 'directory' });
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes('data-screenshot-mode="directory"'));
  assert.ok(html.includes('<base href="./">'));
  const [{ dump }] = extractDumps(html);
  for (const id of Object.keys(dump.screenshots)) {
    assert.equal(dump.screenshots[id], `./screenshots/${id}.png`);
    assert.ok(fs.existsSync(path.join(dir, 'rep', 'screenshots', `${id}.png`)));
  }
});
