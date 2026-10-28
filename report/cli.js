// CLI 薄壳（CONTRACT §5.3）：零依赖手写 argv，逻辑全在 recorder/tools。
// 退出码：成功 0；用法错误/文件缺失等失败一律 2（stderr 一行说明）。

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { loadShell, writeReport } from './recorder.js';
import { splitReport, reportToMarkdown, reportHtmlToMarkdown } from './tools.js';

const USAGE = [
  '用法:',
  '  node report/cli.js build <run.json> [--out <file|dir>] [--assets] [--group-name <n>] [--shell <distDir>]',
  '  node report/cli.js split <report.html> [--out <dir>]',
  '  node report/cli.js to-md <report.html|dump.json> [--out <file>]',
].join('\n');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--assets') {
      args.assets = true;
    } else if (a === '--out' || a === '--group-name' || a === '--shell') {
      const v = argv[++i];
      if (v == null) return null;
      args[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      return null;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

async function cmdBuild(args) {
  const runFile = args._[0];
  if (!runFile) fail('build 需要 <run.json>');
  let runJson;
  try {
    runJson = JSON.parse(await fsp.readFile(runFile, 'utf8'));
  } catch {
    fail(`无法读取 run.json: ${runFile}`);
  }
  // 默认输出到 run.json 同级目录（工作区布局下即 <instance>/report/），不落 cwd
  const runDir = path.dirname(path.resolve(runFile));
  let outPath = args.out ?? path.join(runDir, 'report.html');
  const isDirArg = args.out && (args.out.endsWith('/') || args.out.endsWith('\\') ||
    (fs.existsSync(args.out) && fs.statSync(args.out).isDirectory()));
  if (isDirArg) outPath = path.join(args.out, 'report.html');
  const shell = loadShell(args.shell ?? null);
  const written = await writeReport(runJson, {
    outPath,
    mode: args.assets ? 'directory' : 'single-html',
    shell,
    groupName: args['group-name'],
    runDir,
  });
  process.stdout.write(`已生成报告: ${written}\n`);
}

async function cmdSplit(args) {
  const htmlFile = args._[0];
  if (!htmlFile) fail('split 需要 <report.html>');
  let html;
  try {
    html = await fsp.readFile(htmlFile, 'utf8');
  } catch {
    fail(`无法读取报告: ${htmlFile}`);
  }
  const outDir = args.out ?? path.join(path.dirname(path.resolve(htmlFile)), 'split');
  const files = splitReport(html, outDir);
  process.stdout.write(files.map((f) => `已拆分: ${f}`).join('\n') + '\n');
}

async function cmdToMd(args) {
  const inFile = args._[0];
  if (!inFile) fail('to-md 需要 <report.html|dump.json>');
  let raw;
  try {
    raw = await fsp.readFile(inFile, 'utf8');
  } catch {
    fail(`无法读取输入: ${inFile}`);
  }
  const md = /\.json$/i.test(inFile)
    ? reportToMarkdown(JSON.parse(raw))
    : reportHtmlToMarkdown(raw);
  if (args.out) {
    await fsp.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await fsp.writeFile(args.out, md, 'utf8');
    process.stdout.write(`已生成 Markdown: ${args.out}\n`);
  } else {
    process.stdout.write(md);
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args || args._.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
const cmd = args._.shift();
const handlers = { build: cmdBuild, split: cmdSplit, 'to-md': cmdToMd };
const handler = handlers[cmd];
if (!handler) {
  console.error(`未知命令: ${cmd}\n${USAGE}`);
  process.exit(2);
}
handler(args).catch((e) => {
  console.error(`错误: ${e?.message ?? e}`);
  process.exit(2);
});
