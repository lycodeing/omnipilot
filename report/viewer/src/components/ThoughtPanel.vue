<script setup>
// 当前步骤的 thought / param（JSON 折叠）/ timing 三块（契约 §4）
import { computed } from 'vue'

const props = defineProps({
  task: { type: Object, default: null },
})

const thought = computed(
  () => (props.task && typeof props.task.thought === 'string' && props.task.thought) || ''
)

const paramText = computed(() => {
  const p = props.task && props.task.param
  if (p == null) return ''
  try {
    return JSON.stringify(p, null, 2)
  } catch {
    return String(p)
  }
})

// 参数块可见性：param 缺失/空对象/空串都视为无参数（隐藏整块，不占版面）
const hasParam = computed(() => {
  const p = props.task && props.task.param
  if (p == null) return false
  if (typeof p === 'string') return p.trim().length > 0
  if (typeof p === 'object') return Object.keys(p).length > 0
  return true
})

const timingText = computed(() => {
  const t = props.task && props.task.timing
  if (!t || typeof t !== 'object') return '—'
  const parts = []
  if (Number.isFinite(Number(t.start))) parts.push(`start ${t.start}ms`)
  if (Number.isFinite(Number(t.end))) parts.push(`end ${t.end}ms`)
  if (Number.isFinite(Number(t.durationMs))) parts.push(`耗时 ${t.durationMs}ms`)
  return parts.length ? parts.join(' · ') : '—'
})
</script>

<template>
  <div class="thought-panel">
    <div class="panel-head">
      <span class="panel-title">当前步骤</span>
      <span v-if="task" class="panel-task mono">#{{ task.taskId }}</span>
    </div>
    <div class="panel-body">
      <div v-if="thought" class="panel-block">
        <span class="panel-label">思考</span>
        <p class="panel-thought">{{ thought }}</p>
      </div>
      <div v-if="hasParam" class="panel-block">
        <span class="panel-label">参数</span>
        <details class="panel-param">
          <summary>param JSON</summary>
          <pre>{{ paramText }}</pre>
        </details>
      </div>
      <div class="panel-block">
        <span class="panel-label">耗时</span>
        <p class="panel-timing mono">{{ timingText }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.thought-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: auto;
}
.panel-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.panel-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}
.panel-task {
  padding: 0 7px;
  border-radius: var(--radius-chip);
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 11px;
  line-height: 18px;
}
.panel-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.panel-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.panel-label {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text-3);
}
.panel-thought {
  margin: 0;
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.panel-param summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 12px;
  user-select: none;
}
.panel-param pre {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-subtle);
  border: 1px solid var(--divider);
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-mono);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.panel-timing {
  margin: 0;
  color: var(--text-2);
  font-size: 12px;
}
</style>
