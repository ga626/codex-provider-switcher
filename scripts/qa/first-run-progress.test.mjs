import test from 'node:test'
import assert from 'node:assert/strict'
import { advancePreparation, missingPreparationResults, PREPARATION_TASKS, PREPARATION_INTERVAL_MS } from '../../src/features/first-run/progress.ts'

const steps = PREPARATION_TASKS.map(([id, label], index) => ({ index, id, label, status: 'success', detail: '', action: '' }))
test('后端慢时停在当前项，不被前端计时器带走', () => {
  assert.equal(advancePreparation(0, 0, 60000, []), 0)
  assert.equal(advancePreparation(0, 0, 60000, [{ ...steps[0], status: 'running' }]), 0)
  assert.equal(advancePreparation(0, 0, 60000, steps), 1)
  assert.equal(advancePreparation(1, 60000, 120000, [steps[0]]), 1)
})
test('后端快时仍逐项展示，失败与降级也必须展示后才能前进', () => {
  for (const status of ['success', 'warning', 'failure', 'blocked']) {
    const result = [{ ...steps[0], status }]
    assert.equal(advancePreparation(0, 0, PREPARATION_INTERVAL_MS - 1, result), 0)
    assert.equal(advancePreparation(0, 0, PREPARATION_INTERVAL_MS, result), 1)
  }
  assert.equal(advancePreparation(steps.length - 1, 0, PREPARATION_INTERVAL_MS, steps), steps.length)
})
test('连接中断后，已回执项保留，未知结果不能被标成通过', () => {
  const results = missingPreparationResults([steps[0], { ...steps[1], status: 'running' }])
  assert.equal(results.length, PREPARATION_TASKS.length)
  assert.equal(results[0].status, 'success')
  assert.ok(results.slice(1).every(step => step.status === 'failure'))
})
