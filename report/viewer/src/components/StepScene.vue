<script setup>
// 逐帧渲染：双图交叉淡入 + camera 运镜 + 高亮矩形 + 指针/转圈 + 字幕；无图深色占位（契约 §4 / §19.8.4）
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

const props = defineProps({
  state: { type: Object, default: null },
  screenshots: { type: Object, default: () => ({}) },
})

// 截图自然尺寸缓存：bounds/pointer 等像素坐标 → 显示坐标换算依赖它
const sizes = reactive({})
function onImgLoad(id, e) {
  const el = e && e.target
  if (!id || !el || !el.naturalWidth) return
  sizes[id] = { w: el.naturalWidth, h: el.naturalHeight }
}

function srcOf(id) {
  if (!id) return ''
  const src = props.screenshots ? props.screenshots[id] : ''
  return typeof src === 'string' && src ? src : ''
}

// displayId：当前应显示的图。spinning-pointer 段可能无 screenshotId，沿用上一张（转圈盖在当前画面上）
const displayId = ref('')
watch(
  () => props.state,
  (st) => {
    const id = st && st.screenshotId
    if (srcOf(id)) {
      displayId.value = id
    } else if (!st || st.kind !== 'spinning-pointer') {
      displayId.value = ''
    }
  },
  { immediate: true }
)

const displaySrc = computed(() => srcOf(displayId.value))
const prevId = computed(() => (props.state && props.state.prevScreenshotId) || '')
const prevSrc = computed(() => {
  const op = props.state && Number.isFinite(props.state.opacity) ? props.state.opacity : 1
  return op < 1 ? srcOf(prevId.value) : ''
})
const displayOpacity = computed(() => {
  const st = props.state
  if (!st || displayId.value !== st.screenshotId) return 1
  return Number.isFinite(st.opacity) ? st.opacity : 1
})

// 舞台尺寸（窗口/全屏变化跟随）
const stageRef = ref(null)
const box = ref({ w: 0, h: 0 })
let ro = null
onMounted(() => {
  const el = stageRef.value
  if (!el || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver((entries) => {
    const r = entries && entries[0] && entries[0].contentRect
    if (r) box.value = { w: r.width, h: r.height }
  })
  ro.observe(el)
})
onBeforeUnmount(() => {
  if (ro) ro.disconnect()
  ro = null
})

// 图像内容在舞台内的实际矩形（object-fit: contain 的等效计算）
const fit = computed(() => {
  const size = sizes[displayId.value]
  const { w, h } = box.value
  if (!size || !w || !h) return null
  const scale = Math.min(w / size.w, h / size.h)
  return { scale, dx: (w - size.w * scale) / 2, dy: (h - size.h * scale) / 2 }
})

// camera：zoom 中心 cx/cy 为图像像素坐标
const cameraStyle = computed(() => {
  const cam = props.state && props.state.camera
  const f = fit.value
  if (!cam || !f || !cam.zoom || cam.zoom === 1) return { transform: 'none' }
  return {
    transform: `scale(${cam.zoom})`,
    transformOrigin: `${f.dx + cam.cx * f.scale}px ${f.dy + cam.cy * f.scale}px`,
  }
})

const highlightStyle = computed(() => {
  const hl = props.state && props.state.highlight
  const f = fit.value
  const op =
    props.state && Number.isFinite(props.state.highlightOpacity) ? props.state.highlightOpacity : 0
  if (!hl || !f || op <= 0) return null
  return {
    left: `${f.dx + hl.x * f.scale}px`,
    top: `${f.dy + hl.y * f.scale}px`,
    width: `${hl.w * f.scale}px`,
    height: `${hl.h * f.scale}px`,
    opacity: op,
  }
})

const pointerSpinning = computed(
  () => !!(props.state && props.state.pointer && props.state.pointer.spinning)
)
const pointerStyle = computed(() => {
  const p = props.state && props.state.pointer
  const f = fit.value
  if (!p || p.spinning || !f) return null
  return { left: `${f.dx + p.x * f.scale}px`, top: `${f.dy + p.y * f.scale}px` }
})

const subtitle = computed(() => {
  const s = (props.state && props.state.subtitle) || {}
  return { title: s.title || '', subTitle: s.subTitle || '', errorMessage: s.errorMessage || '' }
})

const placeholderText = computed(() => {
  const id = props.state && props.state.taskId
  return id != null ? `无截图 · 步骤 ${id}` : '无截图'
})
</script>

<template>
  <div class="scene">
    <div ref="stageRef" class="scene-stage">
      <div v-if="displaySrc" class="scene-layer" :style="cameraStyle">
        <img
          v-if="prevSrc"
          class="scene-img"
          :src="prevSrc"
          alt=""
          draggable="false"
          @load="onImgLoad(prevId, $event)"
        />
        <img
          class="scene-img"
          :src="displaySrc"
          alt=""
          draggable="false"
          :style="{ opacity: displayOpacity }"
          @load="onImgLoad(displayId, $event)"
        />
        <div v-if="highlightStyle" class="scene-highlight" :style="highlightStyle"></div>
        <div v-if="pointerStyle" class="scene-pointer" :style="pointerStyle"></div>
        <div v-if="pointerSpinning" class="scene-pointer-spin"><i class="scene-spinner"></i></div>
      </div>
      <div v-else class="scene-placeholder">
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <rect
            x="3.5"
            y="5"
            width="17"
            height="14"
            rx="2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path
            d="M3.5 15.5l4.6-4.2 3.6 3.3 3.4-3 5.4 4.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="9" cy="9.4" r="1.5" fill="currentColor" />
        </svg>
        <span>{{ placeholderText }}</span>
      </div>
      <div class="subtitle">
        <span class="subtitle-title">{{ subtitle.title }}</span>
        <span v-if="subtitle.subTitle" class="subtitle-sub">{{ subtitle.subTitle }}</span>
        <span v-if="subtitle.errorMessage" class="subtitle-error">{{ subtitle.errorMessage }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scene {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--stage, #f7f8fa);
  overflow: hidden;
}
.scene-stage {
  position: absolute;
  inset: 0;
}
.scene-layer {
  position: absolute;
  inset: 0;
  will-change: transform;
}
.scene-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
}
.scene-highlight {
  position: absolute;
  border: 2px solid #ff9f43;
  border-radius: 2px;
  background: rgba(255, 159, 67, 0.16);
  box-shadow: 0 0 14px rgba(255, 159, 67, 0.35);
  pointer-events: none;
}
.scene-pointer {
  position: absolute;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 50%;
  background: #ff9f43;
  box-shadow: 0 0 0 3px rgba(255, 159, 67, 0.3);
  pointer-events: none;
}
.scene-pointer-spin {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.scene-spinner {
  display: block;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.22);
  border-top-color: #ff9f43;
  animation: scene-spin 0.8s linear infinite;
}
@keyframes scene-spin {
  to {
    transform: rotate(360deg);
  }
}
.scene-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-4);
  font-size: 12px;
  letter-spacing: 0.08em;
}
.subtitle {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 30px 18px 12px;
  background: linear-gradient(rgba(10, 12, 16, 0), rgba(10, 12, 16, 0.85));
  color: #f2f5f9;
  font-size: 14px;
  pointer-events: none;
}
.subtitle-title {
  flex: none;
  font-weight: 600;
}
.subtitle-sub {
  color: #a9b3c0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subtitle-error {
  color: #ff7a80;
  font-weight: 500;
}
@media (max-width: 767px) {
  .subtitle {
    padding: 24px 12px 10px;
    font-size: 13px;
    gap: 8px;
  }
}
/* 桌面窄柱档：字幕改为两行（类型 + 目标），避免长文本被截成一行省略号 */
@media (min-width: 1280px) {
  .subtitle {
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 30px 12px 10px;
    font-size: 12px;
    background: linear-gradient(rgba(10, 12, 16, 0), rgba(10, 12, 16, 0.93) 42%);
  }
  .subtitle-sub {
    width: 100%;
    font-size: 11.5px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: normal;
    line-height: 1.45;
  }
}
</style>
