<script setup>
// 布局装配：顶部导航 + 侧栏（桌面静态 / 平板抽屉 / 手机 Tab 切换）+ 主区卡片（播放器 + 详情卡）；
// 持有 currentExecutionIndex / currentTaskId（契约 §4）。视觉参考 Midscene 报告：#f2f4f7 页面底、
// 白色圆角主卡、#1677ff 交互色、状态语义色 pass/fail。
import { computed, inject, nextTick, ref } from 'vue'
import { parseReportDocument } from './composables/useDump.js'
import Sidebar from './components/Sidebar.vue'
import Player from './components/Player.vue'
import ThoughtPanel from './components/ThoughtPanel.vue'
import AssertionCard from './components/AssertionCard.vue'
import NetworkLane from './components/NetworkLane.vue'
import LocateStats from './components/LocateStats.vue'

// P1-2：数据由 main.js 解析一次并 provide('reportData')；这里 inject 复用，避免二次全量解析
// （inject 缺失时才回退自行解析，保证组件在独立挂载场景仍可用）
const data = inject('reportData', null) || parseReportDocument()
const meta = data.meta || {}
const executions = Array.isArray(data.executions) ? data.executions : []
const screenshots = data.screenshots || {}
// 回滚标记（§19.2）：rollbacks[].stepIndex → 发生回滚的步骤在侧边栏打黄标
const rolledBackIds = new Set(
  (Array.isArray(data.rollbacks) ? data.rollbacks : [])
    .map((r) => (r && r.stepIndex != null ? String(r.stepIndex) : null))
    .filter(Boolean)
)

const currentExecutionIndex = ref(0)
const currentTaskId = ref(firstTaskId(0))
const playerRef = ref(null)

// 响应式状态：平板抽屉开关 / 手机 Tab（replay=播放器+详情，steps=步骤时间线）
const sidebarOpen = ref(false)
const viewTab = ref('replay')

const singleMode = computed(() => executions.length <= 1)
const currentExecution = computed(() => executions[currentExecutionIndex.value] || null)
const currentExecutionTasks = computed(() => {
  const exec = currentExecution.value
  return exec && Array.isArray(exec.tasks) ? exec.tasks : []
})
const currentTask = computed(
  () => currentExecutionTasks.value.find((t) => t && t.taskId === currentTaskId.value) || null
)

const modelBriefs = computed(() =>
  Array.isArray(meta.modelBriefs) ? meta.modelBriefs.filter((b) => b && typeof b === 'object') : []
)
const deviceSize = computed(() => (meta.device && isStr(meta.device.size) && meta.device.size) || '—')

// 总通过率（单任务即该 case 自身统计，§19.6）
const passRate = computed(() => {
  let total = 0
  let finished = 0
  for (const exec of executions) {
    const tasks = exec && Array.isArray(exec.tasks) ? exec.tasks : []
    for (const t of tasks) {
      if (!t) continue
      total++
      if (t.status === 'finished') finished++
    }
  }
  return total ? `${finished}/${total} · ${Math.round((finished / total) * 100)}%` : '—'
})

// 全部步骤数（侧栏标题计数）
const totalSteps = computed(() =>
  executions.reduce(
    (n, exec) => n + (exec && Array.isArray(exec.tasks) ? exec.tasks.length : 0),
    0
  )
)

const statusText = computed(() => {
  const s = meta.status || 'unknown'
  return { pass: '通过', fail: '失败', error: '错误', timeout: '超时' }[s] || s
})

function isStr(v) {
  return typeof v === 'string'
}

function firstTaskId(index) {
  const exec = executions[index]
  const tasks = exec && Array.isArray(exec.tasks) ? exec.tasks : []
  const first = tasks.find((t) => t && t.taskId != null)
  return first ? first.taskId : null
}

function formatDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 60000) return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`
  return `${(n / 1000).toFixed(1)}s`
}

// Player 逐帧回报当前 taskId（End 段不发）→ 侧边栏高亮
function onTaskChange(taskId) {
  if (taskId == null) return
  currentTaskId.value = taskId
}

// 侧边栏选步 → 切 execution（如需）→ 等 Player 重建完成 → seekToTask
// 窄屏下选步后收起抽屉 / 切回回放 Tab
function onSelectTask(executionIndex, taskId) {
  currentExecutionIndex.value = executionIndex
  currentTaskId.value = taskId
  sidebarOpen.value = false
  viewTab.value = 'replay'
  nextTick(() => {
    if (playerRef.value) playerRef.value.seekToTask(taskId)
  })
}
</script>

<template>
  <div class="app">
    <header class="top-nav">
      <div class="nav-main">
        <button
          class="nav-burger"
          type="button"
          aria-label="打开步骤栏"
          @click="sidebarOpen = !sidebarOpen"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M2 3.5h12M2 8h12M2 12.5h12"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <div class="nav-title">
          <h1 class="nav-name">{{ meta.groupName || '未命名报告' }}</h1>
          <span class="nav-sub">{{ meta.sdkVersion || '—' }} · {{ meta.deviceType || '—' }} · {{ deviceSize }}</span>
        </div>
        <span class="status-badge" :class="'status-' + (meta.status || 'unknown')">
          <i class="badge-dot"></i>{{ statusText }}
        </span>
        <div class="nav-tabs" role="tablist">
          <button
            type="button"
            class="nav-tab"
            :class="{ on: viewTab === 'replay' }"
            @click="viewTab = 'replay'"
          >
            回放
          </button>
          <button
            type="button"
            class="nav-tab"
            :class="{ on: viewTab === 'steps' }"
            @click="viewTab = 'steps'"
          >
            步骤
          </button>
        </div>
        <div class="nav-meta">
          <span class="nav-stat">
            <span class="nav-stat-label">通过率</span>
            <span class="nav-stat-value">{{ passRate }}</span>
          </span>
          <span class="nav-stat">
            <span class="nav-stat-label">总耗时</span>
            <span class="nav-stat-value mono">{{ formatDuration(meta.durationMs) }}</span>
          </span>
          <span v-if="modelBriefs.length" class="nav-stat">
            <span class="nav-stat-label">模型</span>
            <span v-for="(b, i) in modelBriefs" :key="i" class="model-chip">{{ b.name }}</span>
          </span>
        </div>
      </div>
    </header>

    <div class="app-body" :class="viewTab === 'steps' ? 'at-steps' : 'at-replay'">
      <button
        v-if="sidebarOpen"
        class="drawer-backdrop"
        type="button"
        aria-label="关闭步骤栏"
        @click="sidebarOpen = false"
      ></button>
      <aside class="side-pane" :class="{ open: sidebarOpen }">
        <div class="side-pane-head">
          <span class="side-pane-title">执行步骤</span>
          <span class="side-pane-count">{{ totalSteps }}</span>
          <button
            class="side-pane-close"
            type="button"
            aria-label="关闭"
            @click="sidebarOpen = false"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
        <div class="side-pane-body">
          <Sidebar
            :executions="executions"
            :current-execution-index="currentExecutionIndex"
            :current-task-id="currentTaskId"
            :single-mode="singleMode"
            :rolled-back-ids="rolledBackIds"
            @select-task="onSelectTask"
          />
        </div>
      </aside>

      <main class="main-area">
        <section class="player-card">
          <Player
            ref="playerRef"
            :execution="currentExecution"
            :screenshots="screenshots"
            @task-change="onTaskChange"
          />
        </section>
        <div class="detail-grid">
          <section class="detail-card">
            <ThoughtPanel :task="currentTask" />
          </section>
          <section class="detail-card">
            <AssertionCard :assertions="data.assertions" />
          </section>
          <section class="detail-card">
            <NetworkLane :network-timeline="data.networkTimeline" :duration-ms="meta.durationMs" />
          </section>
          <section class="detail-card">
            <LocateStats :tasks="currentExecutionTasks" />
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
  color: var(--text-1);
}

/* ---------- 顶部导航 ---------- */
.top-nav {
  flex: none;
  position: sticky;
  top: 0;
  z-index: 40;
  background: rgba(242, 244, 247, 0.88);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
  padding: 0 16px;
}
.nav-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  min-height: var(--nav-h);
  padding: 6px 0;
}
.nav-burger {
  flex: none;
  display: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-ctl);
  background: var(--bg-card);
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.nav-burger:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}
.nav-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.nav-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-sub {
  flex: none;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}
.status-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: var(--radius-chip);
  font-size: 12px;
  font-weight: 600;
  background: var(--neutral-weak);
  color: var(--neutral);
}
.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.status-badge.status-pass {
  background: var(--pass-weak);
  color: var(--pass);
}
.status-badge.status-fail,
.status-badge.status-error {
  background: var(--fail-weak);
  color: var(--fail);
}
.status-badge.status-timeout {
  background: var(--warn-weak);
  color: var(--warn);
}

/* 手机 Tab（≤767 显示） */
.nav-tabs {
  flex: none;
  display: none;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-chip);
  background: var(--bg-track);
}
.nav-tab {
  border: none;
  padding: 4px 14px;
  border-radius: var(--radius-chip);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.nav-tab.on {
  background: var(--bg-card);
  color: var(--text-1);
  box-shadow: var(--shadow-card);
}

/* 元信息条 */
.nav-meta {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.nav-stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;
}
.nav-stat-label {
  color: var(--text-3);
}
.nav-stat-value {
  color: var(--text-1);
  font-weight: 600;
}
.model-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--radius-chip);
  background: var(--neutral-weak);
  color: var(--text-2);
  font-size: 11px;
}

/* ---------- 主体 ---------- */
.app-body {
  flex: 1;
  display: flex;
  align-items: stretch;
  min-width: 0;
  padding: 12px;
  gap: 12px;
}

/* 侧栏 */
.side-pane {
  flex: none;
  width: var(--sidebar-w);
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.side-pane-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 10px;
}
.side-pane-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.side-pane-count {
  padding: 0 8px;
  border-radius: var(--radius-chip);
  background: var(--neutral-weak);
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-mono);
}
.side-pane-close {
  display: none;
  margin-left: auto;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-ctl);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.side-pane-close:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}
.side-pane-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 4px 8px 0;
}

/* 主区：白色圆角大卡 */
.main-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.player-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.detail-grid {
  flex: none;
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid var(--divider);
  background: #fafbfd;
}
.detail-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-ctl);
  padding: 12px 14px;
}
.detail-card > * {
  min-width: 0;
}

/* 平板（768–1279）：侧栏折叠为抽屉 */
@media (min-width: 768px) and (max-width: 1279px) {
  .nav-burger {
    display: inline-flex;
  }
  .side-pane {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 60;
    width: min(320px, 86vw);
    background: var(--bg-card);
    transform: translateX(-102%);
    transition: transform 0.22s ease;
    box-shadow: none;
  }
  .side-pane.open {
    transform: none;
    box-shadow: var(--shadow-pop);
  }
  .side-pane-head {
    padding: 12px 12px 8px;
    border-bottom: 1px solid var(--divider);
  }
  .side-pane-close {
    display: inline-flex;
  }
  .side-pane-body {
    padding: 8px 10px 12px;
  }
  .detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 768px) and (max-width: 899px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
.drawer-backdrop {
  display: none;
}

/* 桌面（≥1280）：双栏静态，视口内滚动 */
@media (min-width: 1280px) {
  .app {
    height: 100vh;
    overflow: hidden;
  }
  .top-nav {
    position: static;
    background: var(--bg-page);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .side-pane {
    width: var(--sidebar-w);
    background: transparent;
  }
  .player-card {
    flex: 1;
  }
  .detail-grid {
    height: 302px;
    grid-template-columns: 1.25fr 1fr;
    grid-template-rows: repeat(2, minmax(0, 1fr));
  }
  .detail-card {
    overflow: hidden;
  }
}

/* 手机（≤767）：单列 + Tab 切换 */
@media (max-width: 767px) {
  .app {
    min-height: 100dvh;
  }
  .top-nav {
    padding: 0 12px;
  }
  .nav-main {
    gap: 8px 10px;
    padding: 8px 0;
  }
  .nav-title {
    flex: 1 1 100%;
    order: 1;
  }
  .nav-name {
    font-size: 15px;
    white-space: normal;
    line-height: 1.35;
  }
  .nav-sub {
    white-space: normal;
  }
  .status-badge {
    order: 2;
  }
  .nav-tabs {
    order: 3;
    display: inline-flex;
    margin-left: auto;
  }
  .nav-meta {
    order: 4;
    flex: 1 1 100%;
    overflow-x: auto;
    flex-wrap: nowrap;
    padding-bottom: 2px;
    scrollbar-width: none;
  }
  .nav-meta::-webkit-scrollbar {
    display: none;
  }
  .nav-sub {
    display: none;
  }
  .app-body {
    padding: 10px;
    gap: 0;
  }
  .side-pane,
  .side-pane.open {
    position: static;
    width: 100%;
    transform: none;
    box-shadow: none;
  }
  .side-pane-head {
    padding: 2px 4px 8px;
  }
  .side-pane-close {
    display: none;
  }
  .app-body.at-replay .side-pane {
    display: none;
  }
  .app-body.at-steps .main-area {
    display: none;
  }
  .main-area {
    background: var(--bg-card);
  }
  .detail-grid {
    grid-template-columns: 1fr;
    padding: 10px;
    gap: 8px;
  }
}
</style>
