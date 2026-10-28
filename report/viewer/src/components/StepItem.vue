<script setup>
// 时间线单步：状态圆点（纵轨连线）+ 类型标签 + 参数摘要 + 耗时 + 回滚黄标/失败红（契约 §4）
import { computed } from 'vue'
import { typeLabel } from '../utils/buildReplayScripts.js'

const props = defineProps({
  task: { type: Object, default: null },
  active: { type: Boolean, default: false },
  rolledBack: { type: Boolean, default: false },
})
const emit = defineEmits(['select'])

const failed = computed(() => !!props.task && props.task.status === 'failed')

const label = computed(() => typeLabel((props.task && props.task.type) || ''))

const target = computed(() => {
  const p = props.task && props.task.param
  if (!p || typeof p !== 'object') return ''
  if (typeof p.target === 'string' && p.target) return p.target
  if (typeof p.text === 'string' && p.text) return p.text
  const vals = Object.values(p).filter((v) => typeof v === 'string' && v)
  return vals.length ? String(vals[0]).slice(0, 24) : ''
})

const durationText = computed(() => {
  const d = props.task && props.task.timing && Number(props.task.timing.durationMs)
  return Number.isFinite(d) && d >= 0 ? `${d}ms` : ''
})

function onSelect() {
  if (props.task) emit('select', props.task.taskId)
}
</script>

<template>
  <div
    v-if="task"
    class="step-item"
    :class="{ active, failed, rolled: rolledBack }"
    @click="onSelect"
  >
    <span class="step-node">
      <i class="step-dot"></i>
      <i v-if="rolledBack" class="step-rollback-ring" title="此步骤发生过回滚"></i>
    </span>
    <span class="step-type">{{ label }}</span>
    <span class="step-target" :title="target">{{ target || '—' }}</span>
    <span class="step-duration mono">{{ durationText }}</span>
    <span v-if="failed" class="step-fail-dot" title="failed"></span>
  </div>
</template>

<style scoped>
.step-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 6px;
  margin: 0 0 0 4px;
  border-radius: var(--radius-ctl);
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease, color 0.15s ease;
}
/* 纵向轨道：过状态点的一条浅色细线 */
.step-item::before {
  content: '';
  position: absolute;
  left: 9px;
  top: -6px;
  bottom: 50%;
  width: 1px;
  background: var(--border-strong);
}
.step-item:first-child::before {
  display: none;
}
.step-item:hover {
  background: var(--bg-hover);
}
.step-item.active {
  background: var(--bg-active);
  color: var(--text-1);
}
.step-node {
  position: relative;
  z-index: 1;
  flex: none;
  width: 12px;
  height: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.step-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bg-card);
  border: 1.5px solid var(--border-strong);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.step-item:hover .step-dot {
  border-color: var(--text-3);
}
.step-item.active .step-dot {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
.step-item.failed .step-dot {
  border-color: var(--fail);
  background: var(--fail);
}
/* 回滚标记（§19.2）：状态点外套琥珀色圆环 */
.step-rollback-ring {
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  border: 1.5px solid var(--warn);
}
.step-item.rolled:not(.active) .step-dot {
  border-color: var(--warn);
}
.step-type {
  flex: none;
  min-width: 30px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--neutral-weak);
  color: var(--text-2);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.step-item.failed .step-type {
  background: var(--fail-weak);
  color: var(--fail);
}
.step-item.active .step-type {
  background: var(--accent-weak);
  color: var(--accent);
}
.step-target {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: inherit;
}
.step-item.active .step-target {
  color: var(--text-1);
  font-weight: 500;
}
.step-duration {
  flex: none;
  color: var(--text-3);
  font-size: 11px;
}
.step-fail-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fail);
}
</style>
