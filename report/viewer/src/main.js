import { createApp } from 'vue'
import App from './App.vue'
import { parseReportDocument } from './composables/useDump.js'
import './styles/global.css'

const root = document.getElementById('root')
const data = parseReportDocument()

// 无 ask-dump 标签：在 #root 显示简明错误，不白屏（契约 §4）
if (!data || !Array.isArray(data.executions) || data.executions.length === 0) {
  if (root) {
    root.innerHTML =
      '<div class="boot-error">' +
      '<div class="boot-error-card">' +
      '<h2>报告数据缺失</h2>' +
      '<p>未在本页面找到 ask-dump 数据标签，无法渲染报告。</p>' +
      '</div></div>'
  }
} else if (root) {
  // 只解析一次（P1-2）：解析结果经 provide 注入 App，App 不再自行 parseReportDocument
  createApp(App).provide('reportData', data).mount('#root')
}
