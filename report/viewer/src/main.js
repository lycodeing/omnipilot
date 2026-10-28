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
      '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px;background:#f2f4f7;box-sizing:border-box;">' +
      '<div style="max-width:420px;background:#fff;border:1px solid #e5e8ec;border-radius:12px;padding:28px 32px;font-family:-apple-system,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;">' +
      '<h2 style="margin:0 0 8px;font-size:16px;color:#1b2430;">报告数据缺失</h2>' +
      '<p style="margin:0;color:#86909c;font-size:13px;">未在本页面找到 ask-dump 数据标签，无法渲染报告。</p>' +
      '</div></div>'
  }
} else if (root) {
  createApp(App).mount('#root')
}
