<script setup>
// 时间线单步：现代事件流行结构——圆角方块图标（按动作类别）+ 淡类型标签 + 主文本 + 右对齐耗时；
// active 左侧强调条 + 蓝图标，failed 红图标 + 红点，rolled 图标角上琥珀点（契约 §4）
// 图标按动作类别归组，同一 stroke 1.4 / round cap 手绘。
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

// 类型 → 图标类别（键集对齐 src/tools/vocab.js 的真实类型宇宙；未收录类型落 default 圆点，不猜形状。
// 历史遗留名 screenshot/extract/query/waitFor/back/home 实测 0 次出现，不再收录；assert 出现过 1 次保留）
const ICON_CATEGORY = {
  // 写动作
  tap: 'tap',
  point_tap: 'tap',
  long_press: 'tap',
  input: 'input',
  swipe: 'swipe',
  scroll: 'swipe',
  tap_each_row: 'pen',
  answer_row: 'pen',
  key: 'nav',
  launch: 'nav',
  terminate: 'nav',
  // 感知/等待
  screen: 'camera',
  screen_diff: 'crosshair',
  locate: 'crosshair',
  uitree: 'crosshair',
  ui_dump: 'crosshair',
  sleep: 'clock',
  aiWaitFor: 'clock',
  wait_idle: 'clock',
  wait_element: 'clock',
  // 数据/状态
  read: 'extract',
  data_extract: 'extract',
  data_query: 'extract',
  data_store: 'extract',
  secret_get: 'extract',
  sms_read: 'extract',
  net: 'extract',
  net_profile: 'extract',
  net_status: 'extract',
  // 历史兼容
  assert: 'assert',
}
const ICONS = {
  tap: 'M8 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Z M11.4 4.6a4.8 4.8 0 0 1 0 6.8 M4.6 11.4a4.8 4.8 0 0 1 0-6.8',
  input: 'M4 5h8 M4 8h8 M4 11h5',
  swipe: 'M3.5 8h9 M9.6 5.1 12.5 8l-2.9 2.9',
  assert: 'M8 2.9a5.1 5.1 0 1 0 0 10.2A5.1 5.1 0 0 0 8 2.9Z M5.9 8.1l1.5 1.5 2.8-3',
  camera: 'M3.2 5.4h2.1l1-1.4h3.4l1 1.4h2.1v6.2H3.2Z M8 6.9a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  clock: 'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Z M8 5.6V8l1.7 1.2',
  extract: 'M8 3v5.6 M5.9 6.5 8 8.6l2.1-2.1 M4 12.4h8',
  pen: 'M10.8 3.7l1.5 1.5-6.9 6.9-1.9.4.4-1.9Z',
  nav: 'M6 4 3.6 6.4 6 8.8 M3.6 6.4h6.2a2.6 2.6 0 0 1 0 5.2H7',
  crosshair: 'M8 3v2.1 M8 10.9V13 M3 8h2.1 M10.9 8H13 M8 5.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z',
  default: 'M8 6.9a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z',
}
const iconPath = computed(() => {
  const type = (props.task && props.task.type) || ''
  return ICONS[ICON_CATEGORY[type] || 'default'] || ICONS.default
})

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
    role="button"
    tabindex="0"
    @click="onSelect"
    @keydown.enter="onSelect"
    @keydown.space.prevent="onSelect"
  >
    <span class="step-icon" :title="label + (rolledBack ? ' · 发生回滚' : '')">
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          :d="iconPath"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <i v-if="rolledBack" class="step-rollback-dot"></i>
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
  gap: 9px;
  padding: 6px 9px;
  margin-bottom: 1px;
  border-radius: 9px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease, color 0.15s ease;
}
/* active 左侧强调条（现代列表的选中指示） */
.step-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 7px;
  bottom: 7px;
  width: 2.5px;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.step-item.active::before {
  opacity: 1;
}
.step-item:hover {
  background: var(--bg-hover);
}
.step-item.active {
  background: var(--bg-active);
  color: var(--text-1);
}
/* 图标：圆角方块容器，随状态换色 */
.step-icon {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  color: var(--text-3);
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.step-item:hover .step-icon {
  border-color: var(--border-strong);
  color: var(--text-2);
}
.step-item.active .step-icon {
  border-color: transparent;
  background: var(--accent-weak);
  color: var(--accent);
}
.step-item.failed .step-icon {
  border-color: transparent;
  background: var(--fail-weak);
  color: var(--fail);
}
/* 回滚标记：图标右上角琥珀点（徽章式，替代整圈黄环） */
.step-rollback-dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
  border: 1.5px solid var(--bg-card);
}
/* 类型标签：无底色小字（去掉胶囊底的盒子噪感） */
.step-type {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.step-item.failed .step-type {
  color: var(--fail);
  font-weight: 600;
}
.step-item.active .step-type {
  color: var(--accent);
  font-weight: 600;
}
.step-target {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text-1);
}
.step-item.active .step-target {
  font-weight: 550;
}
.step-duration {
  flex: none;
  color: var(--text-4);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.step-item.active .step-duration {
  color: var(--text-3);
}
.step-fail-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fail);
}
</style>
