import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const viewerRoot = path.dirname(fileURLToPath(import.meta.url))
// runs 目录解析优先顺序：
//   1. ASK_WORKSPACE（显式指定 instance 目录）→ <ws>/run
//   2. ASK_HOME（默认 C:/opt/scene-kit）→ 取日期最新、实例最新的 <home>/<date>/<inst>/run
//   3. 旧布局回退：项目根 runs/（迁移期兼容）
function latestRunDir() {
  const candidates = []
  if (process.env.ASK_WORKSPACE) candidates.push(path.join(path.resolve(process.env.ASK_WORKSPACE), 'run'))
  const home = process.env.ASK_HOME || (process.platform === 'win32' ? 'C:/opt/scene-kit' : '/opt/scene-kit')
  try {
    const dates = fs.readdirSync(home).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    for (const d of dates) {
      const insts = fs.readdirSync(path.join(home, d)).filter((i) => fs.existsSync(path.join(home, d, i, 'run')))
      for (const i of insts) candidates.push(path.join(home, d, i, 'run'))
    }
  } catch {
    // home 不存在则跳过
  }
  // 旧布局
  for (const dir of [path.resolve(process.cwd(), '..', '..'), path.resolve(viewerRoot, '..', '..')]) {
    candidates.push(path.join(dir, 'runs'))
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.readdirSync(c).some((f) => f.endsWith('.json'))) return c
    } catch {
      // 忽略
    }
  }
  return candidates[0]
}
const runsRoot = latestRunDir()
const projectRoot = path.dirname(path.dirname(runsRoot))

// ---- dev-only 数据管线：把 runs/*.json 按报告契约（§19.5 映射，同 report/recorder.js buildDump）
// 转成 ask-dump 注入 dev 页面，并把 /runs/** 映射到项目 runs 目录供截图外链。
// 仅 apply: 'serve'，构建产物（dist/）完全不受影响。

function runToDump(run, runId) {
  const screenshots = {}
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
    }
    if (step.target != null) {
      task.param = step.type === 'assert' ? { text: step.target } : { target: step.target }
    }
    if (step.locate) task.locate = { ...step.locate }
    if (step.screenshot) {
      const id = `${runId}-step-${step.index}`
      task.screenshotId = id
      if (task.locate) task.locate.screenshotId = id
      screenshots[id] = `/${step.screenshot.replace(/\\/g, '/')}` // run.json 内为项目根相对路径
    }
    return task
  })

  const dump = {
    sdkVersion: run.sdkVersion ?? 'ask-0.1.0',
    groupName: run.case ?? runId,
    groupDescription: '',
    deviceType: 'android',
    modelBriefs: run.model?.name ? [{ intent: 'planning', name: run.model.name }] : [],
    executions: [
      {
        id: runId,
        name: run.case ?? runId,
        logTime: run.startedAt ?? null,
        tasks,
      },
    ],
    screenshots,
  }
  if (run.device != null) dump.device = run.device
  if (run.durationMs != null) dump.durationMs = run.durationMs
  if (run.status != null) dump.status = run.status
  if (Array.isArray(run.networkTimeline)) dump.networkTimeline = run.networkTimeline
  if (Array.isArray(run.assertions)) dump.assertions = run.assertions
  if (Array.isArray(run.rollbacks)) dump.rollbacks = run.rollbacks
  return dump
}

function latestRunDumps(count) {
  const runsDir = runsRoot
  let files = []
  try {
    files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort().reverse()
  } catch {
    return []
  }
  const dumps = []
  for (const file of files.slice(0, count)) {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8'))
      dumps.push(runToDump(run, file.replace(/\.json$/, '')))
    } catch {
      // 坏文件跳过
    }
  }
  return dumps
}

function makeDumpTag(dump) {
  const json = JSON.stringify(dump).replace(/<\//g, '<\\/')
  const gid = dump.groupName || 'default'
  return `<script type="ask-dump" data-group-id="${gid}">${json}</script>`
}

function devDataPlugin() {
  return {
    name: 'ask-dev-data',
    apply: 'serve',
    configureServer(server) {
      const runsDir = runsRoot
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/runs/')) return next()
        const rel = decodeURIComponent(url.slice('/runs/'.length).split('?')[0])
        const file = path.resolve(runsDir, rel)
        if (!file.startsWith(runsDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404
          return res.end('not found')
        }
        res.setHeader('Content-Type', file.endsWith('.png') ? 'image/png' : 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        fs.createReadStream(file).pipe(res)
      })
    },
    transformIndexHtml(html, ctx) {
      const url = (ctx && ctx.originalUrl) || '/'
      const count = Math.max(1, Math.min(15, Number(new URL(url, 'http://localhost').searchParams.get('runs')) || 1))
      const dumps = latestRunDumps(count)
      if (!dumps.length) return html
      return html.replace('</body>', dumps.map(makeDumpTag).join('\n') + '\n</body>')
    },
  }
}

// base './' 便于 C 端 loadShell 单文件内联（契约 §4）
export default defineConfig({
  base: './',
  plugins: [vue(), devDataPlugin()],
})
