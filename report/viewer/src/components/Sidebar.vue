<script setup>
// 步骤时间线：多任务分组折叠，单任务常开无折叠钮（契约 §4 / §19.6）
// 视觉：分组头 + 纵向轨道时间线（状态圆点连线），参考 Midscene 侧栏步骤列表
import { computed, reactive } from 'vue'
import StepItem from './StepItem.vue'

const props = defineProps({
  executions: { type: Array, default: () => [] },
  currentExecutionIndex: { type: Number, default: 0 },
  currentTaskId: { type: [String, Number], default: null },
  singleMode: { type: Boolean, default: false },
  rolledBackIds: { type: Set, default: () => new Set() },
})
const emit = defineEmits(['select-task'])

// 多任务时默认只展开第一组
const expanded = reactive({ 0: true })

const groups = computed(() =>
  props.executions.map((exec, index) => {
    const tasks = exec && Array.isArray(exec.tasks) ? exec.tasks : []
    let finished = 0
    let durationMs = 0
    for (const t of tasks) {
      if (!t) continue
      if (t.status === 'finished') finished++
      const d = Number(t.timing && t.timing.durationMs)
      if (Number.isFinite(d) && d > 0) durationMs += d
    }
    return { index, exec, tasks, finished, failed: tasks.length - finished, durationMs }
  })
)

function toggle(index) {
  if (props.singleMode) return
  expanded[index] = !expanded[index]
}

function fmtDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 60000) return `${Math.floor(n / 60000)}m${Math.round((n % 60000) / 1000)}s`
  return `${(n / 1000).toFixed(1)}s`
}

function onSelect(execIndex, taskId) {
  emit('select-task', execIndex, taskId)
}
</script>

<template>
  <div class="side-bar">
    <p v-if="!groups.length" class="side-empty">（无执行记录）</p>
    <section v-for="g in groups" :key="g.index" class="execution-group">
      <header class="execution-header" @click="toggle(g.index)">
        <svg
          v-if="!singleMode"
          class="group-caret"
          :class="{ open: expanded[g.index] }"
          viewBox="0 0 12 12"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path d="M4 2.5L8.5 6 4 9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="group-name" :title="(g.exec && g.exec.name) || ''">{{
          (g.exec && g.exec.name) || '未命名执行'
        }}</span>
        <span class="group-stat" :class="{ 'stat-bad': g.failed > 0 }"
          >{{ g.finished }}/{{ g.tasks.length }}</span
        >
        <span class="group-duration mono">{{ fmtDuration(g.durationMs) }}</span>
      </header>
      <div v-if="singleMode || expanded[g.index]" class="task-list">
        <StepItem
          v-for="(task, ti) in g.tasks"
          :key="ti"
          :task="task"
          :active="g.index === currentExecutionIndex && !!task && task.taskId === currentTaskId"
          :rolled-back="!!task && props.rolledBackIds.has(String(task.taskId))"
          @select="onSelect(g.index, $event)"
        />
        <p v-if="!g.tasks.length" class="side-empty">（无步骤）</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.side-bar {
  min-width: 0;
}
.execution-group {
  margin-bottom: 10px;
}
.execution-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--radius-ctl);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}
.execution-header:hover {
  background: rgba(255, 255, 255, 0.85);
}
.group-caret {
  flex: none;
  color: var(--text-3);
  transition: transform 0.18s ease;
}
.group-caret.open {
  transform: rotate(90deg);
}
.group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.group-stat {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--pass);
  background: var(--pass-weak);
  padding: 0 7px;
  border-radius: var(--radius-chip);
  line-height: 18px;
}
.group-stat.stat-bad {
  color: var(--fail);
  background: var(--fail-weak);
}
.group-duration {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
}
.task-list {
  margin-top: 2px;
  padding: 2px 0;
  display: flex;
  flex-direction: column;
}
.side-empty {
  margin: 0;
  padding: 20px 0;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}
</style>
