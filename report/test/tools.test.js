// tools.js 测试（CONTRACT §5.4）：extractDumps 去重保最新、splitReport 产物可解析、
// reportToMarkdown 关键小节、reportHtmlToMarkdown 拼接

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDumps, splitReport, reportToMarkdown, reportHtmlToMarkdown } from '../tools.js';
import { makeDumpTag, buildDump } from '../recorder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/run.sample.json'), 'utf8'));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function exec(id, name) {
  return { id, name, tasks: [{ taskId: '0', type: 'tap', status: 'finished', param: { target: name } }] };
}

test('extractDumps：同 group 去重保最新，不同 group 各保留，坏标签跳过', () => {
  const dumpOld = { groupName: 'g1', rev: 1, executions: [exec('a-old', '旧')] };
  const dumpNew = { groupName: 'g1', rev: 2, executions: [exec('a-new', '新')] };
  const dumpG2 = { groupName: 'g2', rev: 1, executions: [exec('b', '乙')] };
  const html = [
    makeDumpTag('g1', dumpOld),
    '<script type="ask-dump" data-group-id="bad">not-json</script>',
    makeDumpTag('g1', dumpNew),
    makeDumpTag('g2', dumpG2),
  ].join('\n');
  const dumps = extractDumps(html);
  assert.deepEqual(dumps, [
    { groupId: 'g1', dump: dumpNew }, // 同 group 保最新
    { groupId: 'g2', dump: dumpG2 },
  ]);
  assert.equal(extractDumps('<html></html>').length, 0);
});

test('splitReport：每 execution 一个 <executionId>.execution.json 且可 JSON.parse', (t) => {
  const dir = tmpDir(t);
  const dump = {
    groupName: 'g', executions: [exec('run-a', '甲'), exec('run.b-2', '乙')],
  };
  const files = splitReport(makeDumpTag('g', dump), path.join(dir, 'out'));
  assert.deepEqual(files, [
    path.join(dir, 'out', 'run-a.execution.json'),
    path.join(dir, 'out', 'run.b-2.execution.json'),
  ]);
  const parsed = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(parsed, dump.executions);
  assert.equal(parsed[1].tasks[0].param.target, '乙');
});

test('reportToMarkdown：标题/meta/task 小节（状态/类型/耗时/thought/param/locate）/断言/回滚/网络', () => {
  const dump = buildDump(FIXTURE, { groupName: '相册报告', screenshotIds: { 0: 'u0', 1: 'u1', 3: 'u3' } });
  const md = reportToMarkdown(dump);

  assert.ok(md.startsWith('# 相册报告'));
  assert.ok(md.includes('- 状态：fail'));
  assert.ok(md.includes('- 总耗时：48213ms'));
  assert.ok(md.includes('- 设备：redroid 720x1280'));
  assert.ok(md.includes('- 模型：glm-4.6v'));
  assert.ok(md.includes('## cases/相册列表.yaml'));
  assert.ok(md.includes('executionId: run-20261026-153012-ab12'));

  assert.ok(md.includes('### 任务 0 · tap'));
  assert.ok(md.includes('- 状态：finished'));
  assert.ok(md.includes('- 耗时：312ms'));
  assert.ok(md.includes('- thought：首页点击电子相册入口'));
  assert.ok(md.includes('- param：`{"target":"电子相册"}`'));
  assert.ok(md.includes('- locate：strategy=exact_text, bounds=[512,760,704,880], treeCacheHit=true, vlmCacheHit=false, dumpMs=0'));
  assert.ok(md.includes('### 任务 3 · tap'));
  assert.ok(md.includes('- 状态：failed'));
  assert.ok(md.includes('- 错误：locate_miss_x3'));

  assert.ok(md.includes('## 断言'));
  assert.ok(md.includes('- [通过] 列表按时间倒序 —— 模型确认排序正确'));
  assert.ok(md.includes('- [失败] 点击后进入详情页 —— 页面未跳转'));
  assert.ok(md.includes('## 回滚'));
  assert.ok(md.includes('locate_miss_x3（未恢复）'));
  assert.ok(md.includes('## 网络事件'));
  assert.ok(md.includes('- 4210ms → 3g'));
});

test('reportToMarkdown 对缺省字段兜底不抛错', () => {
  const md = reportToMarkdown({});
  assert.ok(md.startsWith('# 未命名报告'));
  assert.ok(reportToMarkdown(null).startsWith('# 未命名报告'));
});

test('reportHtmlToMarkdown：extractDumps → 逐 reportToMarkdown 拼接', () => {
  const html = [
    makeDumpTag('g1', { groupName: '报告一', executions: [exec('a', '甲')] }),
    makeDumpTag('g2', { groupName: '报告二', executions: [exec('b', '乙')] }),
  ].join('\n');
  const md = reportHtmlToMarkdown(html);
  assert.ok(md.includes('# 报告一'));
  assert.ok(md.includes('# 报告二'));
  assert.ok(md.indexOf('# 报告一') < md.indexOf('# 报告二'));
  assert.ok(!md.includes('<script')); // 纯文本输出
});
