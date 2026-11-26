import test from 'node:test'
import assert from 'node:assert/strict'
import { computePassRate } from '../src/utils/pass-rate.js'

test('computePassRate：断言通过率为主指标', () => {
  const r = computePassRate({
    executions: [{ tasks: [{ status: 'finished' }, { status: 'failed' }] }],
    assertions: [{ passed: true }, { passed: false }, { passed: true }],
  })
  assert.equal(r.assertionText, '断言 2/3 · 67%')
  assert.equal(r.stepText, '步骤 1/2 完成')
})

test('computePassRate：无断言 → 断言指标 —', () => {
  const r = computePassRate({ executions: [{ tasks: [{ status: 'finished' }] }], assertions: [] })
  assert.equal(r.assertionText, '—')
  assert.equal(r.stepText, '步骤 1/1 完成')
})

test('computePassRate：空输入不抛错', () => {
  const r = computePassRate({ executions: [], assertions: [] })
  assert.equal(r.assertionText, '—')
  assert.equal(r.stepText, '—')
})
