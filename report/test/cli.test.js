// cli.js 测试（CONTRACT §5.4）：build/split/to-md 子命令 spawn 冒烟、错误用法退出码 2。
// 全部走临时目录 cwd，不污染项目目录。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDump } from '../recorder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures/run.sample.json');
const CLI = path.join(__dirname, '..', 'cli.js');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

test('build：产出单文件报告（--out 子目录、--group-name 生效）', (t) => {
  const cwd = tmpDir(t);
  const r = runCli(['build', FIXTURE, '--out', 'out/report.html', '--group-name', 'CLI组'], cwd);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(cwd, 'out', 'report.html'), 'utf8');
  assert.ok(html.includes('type="ask-dump"'));
  assert.ok(html.includes('CLI组'));
  assert.ok(html.startsWith('<!doctype html>'));
});

test('build：缺省 --out 落 run.json 同级目录（工作区布局不污染 cwd）；--out 目录参数落 report.html', (t) => {
  const cwd = tmpDir(t);
  // 缺省输出写 run.json 同级目录：输入必须用临时副本，否则会覆盖仓库内 fixtures/report.html
  const sampleTmp = path.join(cwd, 'run.sample.json');
  fs.copyFileSync(FIXTURE, sampleTmp);
  let r = runCli(['build', sampleTmp], cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(cwd, 'report.html')), '缺省输出到 run.json 同级');

  r = runCli(['build', FIXTURE, '--out', 'assetsout/'], cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(cwd, 'assetsout', 'report.html')));
});

test('build --assets：directory 模式建 screenshots 目录、html 带 mode 属性与 <base>', (t) => {
  const cwd = tmpDir(t);
  const r = runCli(['build', FIXTURE, '--assets', '--out', 'd/'], cwd);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(cwd, 'd', 'report.html'), 'utf8');
  assert.ok(html.includes('data-screenshot-mode="directory"'));
  assert.ok(html.includes('<base href="./">'));
  assert.ok(fs.statSync(path.join(cwd, 'd', 'screenshots')).isDirectory());
});

test('build：真实 PNG 嵌入 dataURL', (t) => {
  const cwd = tmpDir(t);
  const pngPath = path.join(cwd, 'shot.png');
  fs.writeFileSync(pngPath, PNG);
  const run = path.join(cwd, 'run.json');
  fs.writeFileSync(run, JSON.stringify({
    runId: 'run-cli-1', case: 'c.yaml', status: 'pass', startedAt: '2026-10-27T10:00:00+08:00', durationMs: 9,
    steps: [{ index: 0, type: 'tap', target: 'x', startedAt: 0, durationMs: 9, result: 'ok', locate: null, screenshot: pngPath, error: null }],
  }));
  const r = runCli(['build', run, '--out', 'p.html'], cwd);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(cwd, 'p.html'), 'utf8');
  assert.ok(html.includes(`data:image/png;base64,${PNG.toString('base64')}`));
});

test('split：产物 execution.json 可解析', (t) => {
  const cwd = tmpDir(t);
  assert.equal(runCli(['build', FIXTURE, '--out', 'r.html'], cwd).status, 0);
  const r = runCli(['split', 'r.html', '--out', 'splitdir'], cwd);
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(cwd, 'splitdir', 'run-20261026-153012-ab12.execution.json');
  const exec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(exec.id, 'run-20261026-153012-ab12');
  assert.equal(exec.tasks.length, 6);
});

test('to-md：html 走 stdout，dump.json 走 --out 文件，且输出已脱敏', (t) => {
  const cwd = tmpDir(t);
  assert.equal(runCli(['build', FIXTURE, '--out', 'r.html', '--group-name', 'CLI组'], cwd).status, 0);

  const r1 = runCli(['to-md', 'r.html'], cwd);
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(r1.stdout.includes('# CLI组'));
  assert.ok(r1.stdout.includes('## 断言'));
  assert.ok(r1.stdout.includes('[REDACTED:secret_get:secret]')); // to-md 输出不泄密
  assert.ok(!r1.stdout.includes('654321'));

  const dumpFile = path.join(cwd, 'dump.json');
  fs.writeFileSync(dumpFile, JSON.stringify(buildDump(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), { groupName: '直转组' })));
  const r2 = runCli(['to-md', dumpFile, '--out', 'md.md'], cwd);
  assert.equal(r2.status, 0, r2.stderr);
  const md = fs.readFileSync(path.join(cwd, 'md.md'), 'utf8');
  assert.ok(md.startsWith('# 直转组'));
});

test('错误用法：退出码 2 且 stderr 一行说明', (t) => {
  const cwd = tmpDir(t);
  const cases = [
    [],
    ['nope'],
    ['build'],
    ['build', 'no-such-run.json'],
    ['build', FIXTURE, '--bogus'],
    ['build', FIXTURE, '--out'],
    ['to-md', 'no-such.html'],
    ['split'],
  ];
  for (const args of cases) {
    const r = runCli(args, cwd);
    assert.equal(r.status, 2, `args=${JSON.stringify(args)} status=${r.status}`);
    assert.ok(r.stderr.trim().length > 0, `args=${JSON.stringify(args)} 应有 stderr`);
  }
});
