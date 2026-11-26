<script setup>
// 断言卡：pass/fail 徽章 + 模型判词 reason（契约 §4）+ 判定输入截图缩略图 +
// evidenceSource（判定依据）/nudges（催答轮数）标签，供结果复核。
import { computed } from 'vue'

const props = defineProps({
  assertions: { type: Array, default: () => [] },
  screenshots: { type: Object, default: () => ({}) },
})

const list = computed(() =>
  (Array.isArray(props.assertions) ? props.assertions : []).filter(
    (a) => a && typeof a === 'object'
  )
)

// 判定输入截图（assert-<i>.png）：screenshots map 以 uuid 为键，single-html 下值是
// dataURL/blob URL、directory 下是相对路径。点击放大交给浏览器新标签打开原图。
function shotSrc(a) {
  const id = a && a.screenshotId
  if (!id) return ''
  const src = props.screenshots ? props.screenshots[id] : ''
  return typeof src === 'string' && src ? src : ''
}

function openShot(a) {
  const src = shotSrc(a)
  if (src && typeof window !== 'undefined') window.open(src, '_blank', 'noopener')
}

function evidenceLabel(a) {
  return a && a.evidenceSource === 'dataset' ? '数据集' : '屏幕'
}
</script>

<template>
  <div class="assertion-card">
    <div class="panel-head">
      <span class="panel-title">断言</span>
      <span class="panel-count">{{ list.length }}</span>
      <span v-if="list.length" class="panel-summary">
        <i class="sum-dot pass"></i>{{ list.filter((a) => a.passed).length }}
        <i class="sum-dot fail"></i>{{ list.filter((a) => !a.passed).length }}
      </span>
    </div>
    <div class="panel-body">
      <p v-if="!list.length" class="panel-empty">（无断言记录）</p>
      <div
        v-for="(a, i) in list"
        :key="i"
        class="assertion-row"
        :class="a.passed ? 'pass' : 'fail'"
      >
        <span class="assertion-icon" aria-hidden="true">
          <svg v-if="a.passed" viewBox="0 0 16 16" width="12" height="12">
            <path
              d="M3.6 8.4l2.9 2.9 5.9-6.4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <svg v-else viewBox="0 0 16 16" width="12" height="12">
            <path
              d="M4.5 4.5l7 7M11.5 4.5l-7 7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
        </span>
        <div class="assertion-body">
          <p class="assertion-text">{{ a.text || '（未命名断言）' }}</p>
          <p v-if="a.reason" class="assertion-reason">{{ a.reason }}</p>
          <div v-if="a.evidenceSource || a.nudges > 0" class="assertion-meta">
            <span v-if="a.evidenceSource" class="assertion-tag" title="判定依据">依据 · {{ evidenceLabel(a) }}</span>
            <span v-if="a.nudges > 0" class="assertion-tag warn" title="断言催答轮数">催答 {{ a.nudges }} 轮</span>
          </div>
        </div>
        <img
          v-if="shotSrc(a)"
          :src="shotSrc(a)"
          class="assertion-shot"
          alt="断言判定输入截图"
          title="点击查看判定输入截图"
          @click="openShot(a)"
        />
        <span class="assertion-flag">{{ a.passed ? '通过' : '失败' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.assertion-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: auto;
}
.panel-summary {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.sum-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.sum-dot.pass {
  background: var(--pass);
}
.sum-dot.fail {
  background: var(--fail);
}
.panel-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.assertion-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px 10px;
  border-radius: var(--radius-ctl);
  background: var(--bg-subtle);
  border: 1px solid var(--divider);
}
.assertion-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--pass-weak);
  color: var(--pass);
}
.assertion-row.fail .assertion-icon {
  background: var(--fail-weak);
  color: var(--fail);
}
.assertion-row.fail {
  background: var(--fail-weak);
  border-color: transparent;
}
.assertion-flag {
  flex: none;
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--radius-chip);
  background: var(--pass-weak);
  color: var(--pass);
}
.assertion-row.fail .assertion-flag {
  background: var(--fail);
  color: #fff;
}
.assertion-body {
  min-width: 0;
  flex: 1;
}
.assertion-text {
  margin: 0;
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.55;
  word-break: break-word;
}
.assertion-reason {
  margin: 4px 0 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.55;
  word-break: break-word;
}
.assertion-reason::before {
  content: '模型判词 · ';
  color: var(--text-4);
}
.assertion-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}
.assertion-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: var(--radius-chip);
  background: var(--neutral-weak);
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 17px;
  white-space: nowrap;
}
.assertion-tag.warn {
  background: var(--warn-weak);
  color: var(--warn);
}
.assertion-shot {
  flex: none;
  width: 52px;
  max-height: 76px;
  object-fit: cover;
  border: 1px solid var(--border);
  border-radius: var(--radius-ctl);
  background: var(--bg-subtle);
  cursor: zoom-in;
}
.assertion-shot:hover {
  border-color: var(--accent-border);
}
</style>
