<script setup>
// 定位统计：策略命中分布、tree/vlm 缓存命中率、dumpMs 均值 + 逐行明细（契约 §4）
import { computed } from 'vue'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
})

const located = computed(() =>
  (Array.isArray(props.tasks) ? props.tasks : []).filter(
    (t) => t && t.locate && typeof t.locate === 'object'
  )
)

const strategyDist = computed(() => {
  const map = {}
  for (const t of located.value) {
    const s = (t.locate && t.locate.strategy) || 'unknown'
    map[s] = (map[s] || 0) + 1
  }
  return Object.entries(map).map(([strategy, count]) => ({ strategy, count }))
})

function rateOf(key) {
  const n = located.value.length
  if (!n) return '—'
  const hits = located.value.filter((t) => t.locate && t.locate[key]).length
  return `${Math.round((hits / n) * 100)}%`
}

const treeRate = computed(() => rateOf('treeCacheHit'))
const vlmRate = computed(() => rateOf('vlmCacheHit'))

const dumpAvg = computed(() => {
  const n = located.value.length
  if (!n) return '—'
  const sum = located.value.reduce((acc, t) => acc + (Number(t.locate && t.locate.dumpMs) || 0), 0)
  return `${Math.round(sum / n)}ms`
})
</script>

<template>
  <div class="locate-stats">
    <div class="panel-head">
      <span class="panel-title">定位统计</span>
      <span class="panel-count">{{ located.length }}</span>
    </div>
    <div class="panel-body">
      <p v-if="!located.length" class="panel-empty">（无定位记录）</p>
      <template v-else>
        <div class="stat-summary">
          <span v-for="s in strategyDist" :key="s.strategy" class="stat-chip"
            >{{ s.strategy }} ×{{ s.count }}</span
          >
          <span class="stat-chip">tree 缓存 {{ treeRate }}</span>
          <span class="stat-chip">vlm 缓存 {{ vlmRate }}</span>
          <span class="stat-chip">dump 均值 {{ dumpAvg }}</span>
        </div>
        <div class="stat-rows">
          <div v-for="(t, i) in located" :key="i" class="stat-row">
            <span class="stat-task mono">#{{ t.taskId }}</span>
            <span class="stat-strategy">{{ (t.locate && t.locate.strategy) || '—' }}</span>
            <span class="stat-flag" :class="{ hit: t.locate && t.locate.treeCacheHit }"
              >tree {{ t.locate && t.locate.treeCacheHit ? '命中' : '未中' }}</span
            >
            <span class="stat-flag" :class="{ hit: t.locate && t.locate.vlmCacheHit }"
              >vlm {{ t.locate && t.locate.vlmCacheHit ? '命中' : '未中' }}</span
            >
            <span class="stat-dump mono">{{ Number(t.locate && t.locate.dumpMs) || 0 }}ms</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.locate-stats {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: auto;
}
.panel-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stat-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.stat-chip {
  padding: 1px 8px;
  border-radius: var(--radius-chip);
  background: var(--neutral-weak);
  color: var(--text-2);
  font-size: 11px;
}
.stat-rows {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.stat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--bg-subtle);
  border: 1px solid var(--divider);
  font-size: 11px;
}
.stat-task {
  flex: none;
  min-width: 32px;
  color: var(--accent);
}
.stat-strategy {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-1);
}
.stat-flag {
  flex: none;
  color: var(--text-4);
}
.stat-flag.hit {
  color: var(--pass);
  font-weight: 600;
}
.stat-dump {
  flex: none;
  color: var(--text-3);
}
</style>
