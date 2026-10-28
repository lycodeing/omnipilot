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
        <span class="assertion-flag">{{ a.passed ? '通过' : '失败' }}</span>
        <div class="assertion-body">
          <p class="assertion-text">{{ a.text || '（未命名断言）' }}</p>
          <p v-if="a.reason" class="assertion-reason">{{ a.reason }}</p>
        </div>
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
.panel-count {
  padding: 0 7px;
  border-radius: var(--radius-chip);
  background: var(--neutral-weak);
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-mono);
  line-height: 18px;
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
.panel-empty {
  margin: 0;
  padding: 14px 0;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}
.assertion-row {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-ctl);
  background: var(--bg-subtle);
  border: 1px solid var(--divider);
  border-left: 3px solid var(--neutral);
}
.assertion-row.pass {
  border-left-color: var(--pass);
}
.assertion-row.fail {
  border-left-color: var(--fail);
  background: var(--fail-weak);
  border-color: var(--fail-weak);
}
.assertion-flag {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  height: fit-content;
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
