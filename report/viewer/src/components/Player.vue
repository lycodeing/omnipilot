<script setup>
// 播放器：buildReplayScripts → layoutScripts → createFramePlayer，逐帧 deriveFrameState 下发；
// 控制条：seek（100% = lastEffectiveFrame）/ 章节标记 / 倍速 / 空格 / 全屏（契约 §4 / §19.8.5）
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createFramePlayer } from '../composables/useFramePlayer.js'
import { buildReplayScripts } from '../utils/buildReplayScripts.js'
import { layoutScripts } from '../utils/playback-math.js'
import { deriveFrameState } from '../utils/derive-frame-state.js'
import StepScene from './StepScene.vue'

const props = defineProps({
  execution: { type: Object, default: null },
  screenshots: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['task-change'])

const RATES = [0.5, 1, 1.5, 2]
const EMPTY_LAYOUT = { segments: [], totalFrames: 0, lastEffectiveFrame: 0 }

const stageRef = ref(null)
const seekBarRef = ref(null)
const layoutRef = ref(EMPTY_LAYOUT)
const state = ref(deriveFrameState(0, EMPTY_LAYOUT))
const currentFrame = ref(0)
const playing = ref(false)
const rate = ref(1)

let engine = null

const totalFrames = computed(() => layoutRef.value.totalFrames)
const lastEffective = computed(() => layoutRef.value.lastEffectiveFrame)

function handleFrame(frame) {
  currentFrame.value = frame
  const st = deriveFrameState(frame, layoutRef.value)
  state.value = st
  playing.value = engine ? engine.isPlaying() : false
  if (st.taskId != null) emit('task-change', st.taskId) // End 段 taskId=null 不发
}

function rebuild() {
  if (engine) {
    engine.destroy()
    engine = null
  }
  const exec = props.execution || { id: '', name: '', tasks: [] }
  layoutRef.value = layoutScripts(buildReplayScripts(exec))
  currentFrame.value = 0
  playing.value = false
  state.value = deriveFrameState(0, layoutRef.value)
  engine = createFramePlayer({ totalFrames: layoutRef.value.totalFrames, onFrame: handleFrame })
}

watch(() => props.execution, rebuild)
rebuild()

// 章节标记：每个有截图的步骤一个（同 task 取第一段），点击直达
const chapters = computed(() => {
  const span = lastEffective.value
  const seen = new Set()
  const marks = []
  for (const seg of layoutRef.value.segments) {
    const s = seg && seg.script
    if (!s || s.kind !== 'img' || !s.screenshotId || s.taskId == null || seen.has(s.taskId)) continue
    seen.add(s.taskId)
    marks.push({
      frame: seg.startFrame,
      pct: span > 0 ? Math.min(100, (seg.startFrame / span) * 100) : 0,
      title: `#${s.taskId} ${s.title || ''}${s.subTitle ? ' · ' + s.subTitle : ''}`,
    })
  }
  return marks
})

// End 帧不计入进度条：100% = lastEffectiveFrame
const progressPct = computed(() => {
  const span = lastEffective.value
  if (span <= 0) return '0%'
  const p = Math.min(1, Math.max(0, currentFrame.value / span))
  return `${(p * 100).toFixed(2)}%`
})

function togglePlay() {
  if (!engine || totalFrames.value === 0) return
  engine.toggle()
  playing.value = engine.isPlaying()
}

function setRate(r) {
  rate.value = r
  if (engine) engine.setRate(r)
}

// 章节标记直达（原模板引用了 seekToFrame 但脚本未定义，此处补齐）
function seekToFrame(frame) {
  if (!engine || !Number.isFinite(Number(frame))) return
  engine.seekTo(Number(frame))
}

function applySeekEvent(e) {
  const bar = seekBarRef.value
  if (!engine || !bar) return
  const rect = bar.getBoundingClientRect()
  if (rect.width <= 0) return
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  engine.seekTo(Math.round(ratio * lastEffective.value))
}

function onSeekDown(e) {
  const bar = seekBarRef.value
  if (!engine || !bar || lastEffective.value <= 0) return
  applySeekEvent(e)
  try {
    bar.setPointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
  const move = (ev) => applySeekEvent(ev)
  const up = () => {
    bar.removeEventListener('pointermove', move)
    bar.removeEventListener('pointerup', up)
    bar.removeEventListener('pointercancel', up)
  }
  bar.addEventListener('pointermove', move)
  bar.addEventListener('pointerup', up)
  bar.addEventListener('pointercancel', up)
}

// 找该 task 第一个段的 startFrame 并 seekTo（契约 §4）
function seekToTask(taskId) {
  if (!engine || taskId == null) return
  const seg = layoutRef.value.segments.find((s) => s && s.script && s.script.taskId === taskId)
  if (seg) engine.seekTo(seg.startFrame)
}
defineExpose({ seekToTask })

function enterFullscreen() {
  const el = stageRef.value
  if (!el || !el.requestFullscreen) return
  const p = el.requestFullscreen()
  if (p && typeof p.catch === 'function') p.catch(() => {})
}

// 空格播放/暂停（全局监听，避开输入控件）
function onKeydown(e) {
  if (e.code !== 'Space' && e.key !== ' ') return
  const t = e.target
  const tag = t && t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return
  e.preventDefault()
  togglePlay()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (engine) {
    engine.destroy()
    engine = null
  }
})
</script>

<template>
  <section class="player">
    <div ref="stageRef" class="player-stage">
      <StepScene :state="state" :screenshots="screenshots" />
    </div>
    <div class="player-controls">
      <button class="play-btn" :disabled="totalFrames === 0" :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">
        <svg v-if="!playing" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M5 3.2v9.6c0 .5.55.8.97.53l7.2-4.8a.63.63 0 000-1.06l-7.2-4.8A.63.63 0 005 3.2z" fill="currentColor" />
        </svg>
        <svg v-else viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4.5 3.5h2.2v9H4.5zM9.3 3.5h2.2v9H9.3z" fill="currentColor" />
        </svg>
      </button>
      <div ref="seekBarRef" class="seek-bar" @pointerdown="onSeekDown">
        <div class="seek-track">
          <div class="seek-fill" :style="{ width: progressPct }"></div>
          <button
            v-for="(c, i) in chapters"
            :key="i"
            class="chapter-mark"
            :style="{ left: c.pct + '%' }"
            :title="c.title"
            @pointerdown.stop
            @click="seekToFrame(c.frame)"
          ></button>
        </div>
      </div>
      <span class="frame-label mono">{{ currentFrame }}/{{ lastEffective }}f</span>
      <span class="rate-group">
        <button
          v-for="r in RATES"
          :key="r"
          class="rate-btn"
          :class="{ on: r === rate }"
          @click="setRate(r)"
        >
          {{ r }}x
        </button>
      </span>
      <button class="ghost-btn" aria-label="全屏" title="全屏" @click="enterFullscreen">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
  </section>
</template>

<style scoped>
.player {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.player-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--stage);
}
/* 桌面外（页面滚动档）：舞台给固定可视高度 */
@media (max-width: 1279px) {
  .player-stage {
    flex: none;
    height: clamp(320px, 56vh, 560px);
  }
}
@media (max-width: 767px) {
  .player-stage {
    height: clamp(240px, 46vh, 420px);
  }
}
.player-controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-card);
  user-select: none;
}
.play-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease;
}
.play-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}
.play-btn:active:not(:disabled) {
  transform: scale(0.94);
}
.play-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.seek-bar {
  flex: 1;
  min-width: 100px;
  padding: 12px 0;
  cursor: pointer;
  touch-action: none;
}
.seek-track {
  position: relative;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-track);
}
.seek-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 2px;
  background: var(--accent);
}
.chapter-mark {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  margin: -4.5px 0 0 -4.5px;
  padding: 0;
  border: 1.5px solid var(--accent);
  border-radius: 50%;
  background: var(--bg-card);
  cursor: pointer;
  transition: transform 0.12s ease, background 0.12s ease;
}
.chapter-mark:hover {
  transform: scale(1.35);
  background: var(--accent);
}
.frame-label {
  flex: none;
  min-width: 72px;
  text-align: center;
  color: var(--text-3);
  font-size: 11px;
}
.rate-group {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-ctl);
  background: var(--bg-subtle);
  border: 1px solid var(--divider);
}
.rate-btn {
  padding: 2px 7px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.rate-btn.on {
  background: var(--bg-card);
  color: var(--accent);
  box-shadow: var(--shadow-card);
}
.ghost-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-ctl);
  background: var(--bg-card);
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.ghost-btn:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}
@media (max-width: 480px) {
  .frame-label {
    display: none;
  }
  .player-controls {
    gap: 8px;
    padding: 8px 10px;
  }
}
</style>
