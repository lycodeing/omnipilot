<script setup>
// 布局装配：顶部导航 + 侧栏（桌面静态 / 平板抽屉 / 手机 Tab 切换）+ 主区卡片（播放器 + 详情卡）；
// 持有 currentExecutionIndex / currentTaskId（契约 §4）。视觉参考 Midscene 报告：#f2f4f7 页面底、
// 白色圆角主卡、#1677ff 交互色、状态语义色 pass/fail。
import { computed, inject, nextTick, ref } from 'vue'
import { parseReportDocument } from './composables/useDump.js'
import { computePassRate } from './utils/pass-rate.js'
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

// 截图宽高比（桌面回放舱按此比例定宽）：优先 meta.device.size（"1080x2340"），
// 解析不出时按竖屏手机 9:19.5 兜底。播放器据此把满宽舞台收成一根手机宽度的窄柱，
// 横向空间让给详情区（2026-11-05 布局再平衡）。
const stageAspect = computed(() => {
  const s = meta.device && isStr(meta.device.size) ? meta.device.size.trim() : ''
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(s)
  if (!m) return 9 / 19.5
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 ? w / h : 9 / 19.5
})

// 通过率口径（§19.6 / 评审 M5）：断言通过率为主指标，步骤完成率为辅助指标。
// 纯函数 computePassRate 负责统计与文案，组件只负责展示。
const passRate = computed(() => computePassRate({ executions, assertions: data.assertions }))

// 全部步骤数（侧栏标题计数）
const totalSteps = computed(() =>
  executions.reduce(
    (n, exec) => n + (exec && Array.isArray(exec.tasks) ? exec.tasks.length : 0),
    0
  )
)

// 无数据组件隐藏（2026-11-05 布局优化）：空卡片只占版面不承载信息，直接不渲染。
// 网格随之自适应（auto rows），不再为隐藏卡留空槽。
const hasNetwork = computed(() => Array.isArray(data.networkTimeline) && data.networkTimeline.length > 0)
const hasLocate = computed(() =>
  currentExecutionTasks.value.some((t) => t && t.locate && typeof t.locate === 'object')
)
const hasAssertions = computed(() => Array.isArray(data.assertions) && data.assertions.length > 0)

const statusText = computed(() => {
  const s = meta.status || 'unknown'
  // cancelled：recorder 侧 STATUSES 含该值（中断收尾），此前缺映射裸显英文
  return { pass: '通过', fail: '失败', error: '错误', timeout: '超时', cancelled: '已取消' }[s] || s
})

// 桌面回放舱宽度：按截图宽高比算出的"手机柱"宽度上限（CSS 里再与 46vw 取小）
const stageAspectStyle = computed(() => ({
  '--stage-aspect': String(stageAspect.value),
}))

// 主题：默认浅色；深色 HUD 为可选模式，选择持久化（index.html 的内联脚本在挂载前
// 应用 data-theme 防白闪）。切换即改 <html data-theme>，令牌层整体换肤。
const theme = ref(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  if (theme.value === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
  else document.documentElement.removeAttribute('data-theme')
  try {
    localStorage.setItem('ask-report-theme', theme.value)
  } catch {
    /* 存储不可用：本次会话内切换仍有效 */
  }
}

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
        <div class="nav-id">
          <div class="nav-title-row">
            <h1 class="nav-name">{{ meta.groupName || '未命名报告' }}</h1>
            <span class="status-badge" :class="'status-' + (meta.status || 'unknown')">
              <i class="badge-dot"></i>{{ statusText }}
            </span>
          </div>
          <span class="nav-sub">{{ meta.sdkVersion || '—' }} · {{ meta.deviceType || '—' }} · {{ deviceSize }}</span>
        </div>
        <div class="nav-actions">
          <div class="nav-stats">
            <span class="nav-stat">
              <span class="nav-stat-label">断言通过率</span>
              <span class="nav-stat-value">{{ passRate.assertionText }}</span>
              <span class="nav-stat-sub">{{ passRate.stepText }}</span>
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
          <button
            class="theme-toggle"
            type="button"
            :title="theme === 'dark' ? '切换到浅色主题' : '切换到深色 HUD 主题'"
            :aria-label="theme === 'dark' ? '切换到浅色主题' : '切换到深色 HUD 主题'"
            @click="toggleTheme"
          >
            <svg v-if="theme === 'dark'" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle cx="8" cy="8" r="3.2" fill="currentColor" />
              <path
                d="M8 1.2v1.8M8 13v1.8M1.2 8H3M13 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
            <svg v-else viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M13.4 9.6A5.6 5.6 0 0 1 6.4 2.6a5.6 5.6 0 1 0 7 7Z" fill="currentColor" />
            </svg>
          </button>
        </div>
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
        <section class="player-card" :style="stageAspectStyle">
          <Player
            ref="playerRef"
            :execution="currentExecution"
            :screenshots="screenshots"
            @task-change="onTaskChange"
          />
        </section>
        <div class="detail-grid" :class="{ 'has-assert': hasAssertions }">
          <div v-if="currentTask || hasNetwork || hasLocate" class="detail-col">
            <section v-if="currentTask" class="detail-card card-thought">
              <ThoughtPanel :task="currentTask" />
            </section>
            <section v-if="hasNetwork" class="detail-card card-network">
              <NetworkLane :network-timeline="data.networkTimeline" :duration-ms="meta.durationMs" />
            </section>
            <section v-if="hasLocate" class="detail-card card-locate">
              <LocateStats :tasks="currentExecutionTasks" />
            </section>
          </div>
          <section v-if="hasAssertions" class="detail-card card-assert">
            <AssertionCard :assertions="data.assertions" :screenshots="data.screenshots" />
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
  background: var(--nav-bg);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
  padding: 0 16px;
}
/* 深色 HUD：顶栏底部一条青色渐变光线（浅色为 none） */
.top-nav::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  background: var(--nav-line);
  pointer-events: none;
}
.nav-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  min-height: var(--nav-h);
  padding: 8px 0;
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
/* 标识区：主标题 + 状态徽章一行，版本/设备一行（层级：名称 > 徽章 > 元信息） */
.nav-id {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.nav-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.nav-name {
  margin: 0;
  min-width: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-sub {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: 0.01em;
}
.status-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 10px;
  border-radius: var(--radius-chip);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  background: var(--neutral-weak);
  color: var(--neutral);
  border: 1px solid var(--border);
}
.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: var(--dot-glow);
  animation: badge-pulse 2s ease-in-out infinite;
}
@keyframes badge-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
.status-badge.status-pass {
  background: var(--pass-weak);
  color: var(--pass);
  border-color: transparent;
}
.status-badge.status-fail,
.status-badge.status-error {
  background: var(--fail-weak);
  color: var(--fail);
  border-color: transparent;
}
.status-badge.status-timeout {
  background: var(--warn-weak);
  color: var(--warn);
  border-color: transparent;
}

/* 右侧动作区：指标簇 + 分隔线 + 主题开关 */
.nav-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
}
.nav-stats {
  display: flex;
  align-items: center;
  gap: 18px;
  padding-right: 14px;
  border-right: 1px solid var(--divider);
}
.nav-stat {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  white-space: nowrap;
}
.nav-stat-label {
  color: var(--text-3);
  font-size: 10px;
  letter-spacing: 0.08em;
}
.nav-stat-value {
  color: var(--text-1);
  font-weight: 650;
  font-size: 13px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}
/* 辅指标（步骤完成率）：小字弱色，不与主指标（断言通过率）争层级 */
.nav-stat-sub {
  color: var(--text-3);
  font-size: 10px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}
.model-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--radius-chip);
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 17px;
}

.theme-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-ctl);
  background: var(--bg-card);
  color: var(--text-2);
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.theme-toggle:hover {
  color: var(--accent);
  border-color: var(--accent-border);
  box-shadow: var(--glow-accent);
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

/* ---------- 主体 ---------- */
.app-body {
  flex: 1;
  /* min-height:0 是视口内滚动的关键：flex 项默认 min-height:auto 会被内容最小高度
     （侧栏+详情卡 ≈1980px）撑破 .app 的 height:100vh，导致 detail-grid 的百分比
     限高算在 1957px 上而失效（2026-11-05 布局修复）。 */
  min-height: 0;
  display: flex;
  align-items: stretch;
  min-width: 0;
  padding: 12px;
  gap: 12px;
}

/* 侧栏：与主卡同级的白色圆角面板（桌面静态 / 平板抽屉 / 手机 Tab 内容） */
.side-pane {
  flex: none;
  width: var(--sidebar-w);
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.side-pane-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--divider);
}
.side-pane-title {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--text-2);
}
.side-pane-count {
  padding: 0 8px;
  border-radius: var(--radius-chip);
  background: var(--neutral-weak);
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-mono);
  line-height: 18px;
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
  padding: 8px;
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
  background: var(--bg-subtle);
}
/* 左列容器：窄屏下摊平为普通流（卡片直接进单/双列网格） */
.detail-col {
  display: contents;
}
.detail-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  transition: border-color 0.2s ease;
}
.detail-card:hover {
  border-color: var(--card-hover-border);
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
    border-radius: 0;
    border-top: none;
    border-bottom: none;
    border-left: none;
    transform: translateX(-102%);
    transition: transform 0.22s ease;
    box-shadow: none;
  }
  .side-pane.open {
    transform: none;
    box-shadow: var(--shadow-pop);
  }
  .side-pane-close {
    display: inline-flex;
  }
  .detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }
  .detail-col {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
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

/* 桌面（≥1280）：视口内滚动；左为按截图比例定宽的回放柱，右为详情区 */
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
  .app-body {
    align-items: stretch;
  }
  /* 主区横向两栏：回放柱（窄）+ 详情区（吃满剩余宽度） */
  .main-area {
    flex-direction: row;
    gap: 10px;
    background: transparent;
    border: none;
    box-shadow: none;
    overflow: hidden;
  }
  /* 回放柱：宽度由截图宽高比决定（min: 260px，max: 46vw），高度撑满；
     手机截图不再被塞进满宽横条，两侧空场归还给详情区 */
  .player-card {
    flex: none;
    width: clamp(260px, calc((100vh - var(--nav-h) - 56px) * var(--stage-aspect, 0.46)), 46vw);
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  /* 详情区：占满右侧；两列各自独立滚动，长卡不把网格撑破 */
  .detail-grid {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: stretch;
    padding: 12px;
    border: none;
    border-radius: var(--radius-card);
    background: var(--bg-card);
    box-shadow: var(--shadow-card);
  }
  .detail-col {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }
  /* 左列末卡撑满剩余高度，列内不留死区 */
  .detail-col > .detail-card:last-child {
    flex: 1;
  }
  .detail-grid:not(.has-assert) {
    grid-template-columns: 1fr;
  }
  /* 右列断言卡自身滚动，卡片高度跟随容器而非内容 */
  .card-assert {
    min-height: 0;
    overflow: hidden;
  }
  /* 右列只有断言卡时让它撑满整列高度，避免卡下方留白 */
  .detail-grid > .card-assert {
    height: 100%;
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
    gap: 6px 10px;
    padding: 8px 0;
  }
  .nav-id {
    order: 1;
    flex: 1 1 auto;
  }
  .nav-actions {
    display: contents;
  }
  .theme-toggle {
    order: 2;
  }
  .nav-tabs {
    order: 3;
    display: inline-flex;
  }
  .nav-stats {
    order: 4;
    flex: 1 1 100%;
    gap: 16px;
    padding: 2px 0 4px;
    border-right: none;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .nav-stats::-webkit-scrollbar {
    display: none;
  }
  .nav-stat {
    flex-direction: row;
    align-items: baseline;
    gap: 6px;
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
    border: none;
    border-radius: 0;
    background: transparent;
  }
  .side-pane-head {
    padding: 2px 4px 8px;
    border-bottom: none;
  }
  .side-pane-body {
    padding: 0;
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
  .detail-grid {
    grid-template-columns: 1fr;
    padding: 10px;
    gap: 8px;
  }
}
</style>
