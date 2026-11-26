// 通过率口径（评审 M5 修复）：断言通过率为主指标（测试产品的本体），
// 步骤完成率降级为辅助指标——sleep/截图等无关步骤不再稀释"通过率"语义。
export function computePassRate({ executions = [], assertions = [] } = {}) {
  let total = 0
  let finished = 0
  for (const exec of executions) {
    const tasks = exec && Array.isArray(exec.tasks) ? exec.tasks : []
    for (const t of tasks) {
      if (!t) continue
      total++
      if (t.status === 'finished') finished++
    }
  }
  const stepText = total ? `步骤 ${finished}/${total} 完成` : '—'
  const a = Array.isArray(assertions) ? assertions.filter(Boolean) : []
  if (!a.length) return { assertionText: '—', stepText }
  const passed = a.filter((x) => x.passed).length
  const pct = Math.round((passed / a.length) * 100)
  return { assertionText: `断言 ${passed}/${a.length} · ${pct}%`, stepText }
}
