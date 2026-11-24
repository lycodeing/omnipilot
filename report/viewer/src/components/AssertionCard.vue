<script setup>
// 断言卡：pass/fail 徽章 + 模型判词 reason（契约 §4）
import { computed } from 'vue'

const props = defineProps({
  assertions: { type: Array, default: () => [] },
})

const list = computed(() =>
  (Array.isArray(props.assertions) ? props.assertions : []).filter(
    (a) => a && typeof a === 'object'
  )
)
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
        </div>
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
</style>
