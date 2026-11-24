<script setup>
// 弱网时间轴：profile 分段泳道 + 切网时刻刻度（契约 §4）
import { computed } from 'vue'

const props = defineProps({
  networkTimeline: { type: Array, default: () => [] },
  durationMs: { type: Number, default: null },
})

const events = computed(() =>
  (Array.isArray(props.networkTimeline) ? props.networkTimeline : [])
    .filter((e) => e && typeof e === 'object')
    .slice()
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
)

const span = computed(() => {
  const d = Number(props.durationMs)
  if (Number.isFinite(d) && d > 0) return d
  const maxAt = events.value.reduce((m, e) => Math.max(m, Number(e.at) || 0), 0)
  return maxAt > 0 ? maxAt : 1
})

// 相邻切网时刻之间的泳道分段
const segments = computed(() => {
  const es = events.value
  return es.map((e, i) => {
    const start = Math.max(0, Math.min(1, (Number(e.at) || 0) / span.value))
    const nextAt = i + 1 < es.length ? Number(es[i + 1].at) || 0 : span.value
    const end = Math.max(start, Math.min(1, nextAt / span.value))
    return { profile: String(e.profile == null ? '?' : e.profile), start, width: end - start, at: e.at }
  })
})

function pct(v) {
  return `${(v * 100).toFixed(2)}%`
}
</script>

<template>
  <div class="network-lane">
    <div class="panel-head">
      <span class="panel-title">弱网时间线</span>
      <span class="panel-count">{{ segments.length }}</span>
    </div>
    <div class="panel-body">
      <p v-if="!segments.length" class="panel-empty">（无网络事件）</p>
      <div v-else class="lane">
        <div class="lane-track">
          <div
            v-for="(s, i) in segments"
            :key="i"
            class="lane-segment"
            :class="'profile-' + s.profile"
            :style="{ left: pct(s.start), width: pct(s.width) }"
          >
            <span class="lane-profile">{{ s.profile }}</span>
          </div>
          <span
            v-for="(s, i) in segments"
            :key="'t' + i"
            class="lane-tick"
            :style="{ left: pct(s.start) }"
            :title="`切网 ${s.at}ms → ${s.profile}`"
          ></span>
        </div>
        <div class="lane-axis mono">
          <span>0</span>
          <span>{{ Math.round(span) }}ms</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.network-lane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: auto;
}
.panel-body {
  display: flex;
  flex-direction: column;
}
.lane {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.lane-track {
  position: relative;
  height: 32px;
  border-radius: 6px;
  background: var(--bg-subtle);
  border: 1px solid var(--divider);
  overflow: hidden;
}
.lane-segment {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--neutral-weak);
  border-right: 1px solid var(--bg-card);
  overflow: hidden;
}
.lane-profile {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.profile-wifi {
  background: rgba(22, 163, 74, 0.18);
}
.profile-4g {
  background: rgba(22, 119, 255, 0.16);
}
.profile-3g {
  background: rgba(217, 119, 6, 0.18);
}
.profile-2g {
  background: rgba(229, 72, 77, 0.18);
}
.profile-off {
  background: rgba(100, 116, 139, 0.22);
}
.lane-tick {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  border-radius: 1px;
  background: var(--text-1);
  opacity: 0.55;
}
.lane-axis {
  display: flex;
  justify-content: space-between;
  color: var(--text-3);
  font-size: 10px;
}
</style>
