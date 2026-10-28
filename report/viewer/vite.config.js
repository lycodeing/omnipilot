import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// P2-9：dev 数据管线复用生成端单一实现（recorder.buildDump/makeDumpTag），消除双胞胎代码
import { buildDump, makeDumpTag } from '../recorder.js'

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

// ---- dev-only 数据管线：把 runs/*.json 按报告契约（§19.5 映射）转成 ask-dump 注入 dev 页面，
// 并把 /runs/** 映射到项目 runs 目录供截图外链。
// 仅 apply: 'serve'，构建产物（dist/）完全不受影响。
// P2-9：§19.5 映射单一实现源 = report/recorder.js buildDump（本文件不再维护双胞胎 runToDump）；
// 解析结果按 mtime 做内存缓存，dev 请求未变更的 run.json 不重复读盘+JSON.parse。

// run.json → dump：复用 recorder.buildDump，再做 dev 专属适配
// （确定性 screenshotId + 截图 src 指向 /runs/ 中间件；产物模式里 src 是占位/相对文件路径）
function runToDump(run, runId) {
  const screenshotIds = {}
  for (const step of run.steps ?? []) {
    if (step?.screenshot != null && step?.index != null) {
      screenshotIds[step.index] = `${runId}-step-${step.index}`
    }
  }
  const dump = buildDump(run, { groupName: run.case ?? runId, runId, screenshotIds })
  // buildDump 固定 sdkVersion 'ask-0.1.0'；dev 下优先展示 run.json 自带版本
  if (run.sdkVersion != null) dump.sdkVersion = run.sdkVersion
  for (const step of run.steps ?? []) {
    if (!step?.screenshot || step?.index == null) continue
    const id = screenshotIds[step.index]
    // run.json 内为项目根相对路径；dev 经 /runs/ 中间件读文件
    dump.screenshots[id] = `/${String(step.screenshot).replace(/\\/g, '/')}`
  }
  return dump
}

// mtime 缓存：Map<绝对路径, { mtimeMs, size, dump }>；未变更直接复用（P2-9）
const dumpCache = new Map()

function cachedRunDump(file) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  const hit = dumpCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.dump
  let dump = null
  try {
    const run = JSON.parse(fs.readFileSync(file, 'utf8'))
    dump = runToDump(run, path.basename(file).replace(/\.json$/, ''))
  } catch {
    return null // 坏文件跳过（不缓存，下次重试）
  }
  dumpCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, dump })
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
    const dump = cachedRunDump(path.join(runsDir, file))
    if (dump) dumps.push(dump)
  }
  return dumps
}

function dumpTag(dump) {
  return makeDumpTag(dump.groupName || 'default', dump)
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
      return html.replace('</body>', dumps.map(dumpTag).join('\n') + '\n</body>')
    },
  }
}

// base './' 便于 C 端 loadShell 单文件内联（契约 §4）
export default defineConfig({
  base: './',
  plugins: [vue(), devDataPlugin()],
})
