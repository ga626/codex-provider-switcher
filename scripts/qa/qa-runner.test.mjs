import test from 'node:test'
import assert from 'node:assert/strict'
import { runChecks, matchesPath, changeSet } from './qa-runner.mjs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
test('失败覆盖旧成功，后续未运行，运行都有身份', async () => {
  const receipts = []
  const r = await runChecks(['a','b','c'], async name => { if (name === 'b') throw Error('private detail') }, async r => receipts.push(structuredClone(r)))
  assert.equal(receipts[0].result, 'running'); assert.equal(r.result, 'failed')
  assert.deepEqual(r.checks.map(c => c.result), ['passed','failed','not-run']); assert.ok(r.runId)
  assert.equal(JSON.stringify(r).includes('private detail'), false)
})
test('路径和已提交干净分支使用指定基线', async () => {
  assert.ok(matchesPath('src/features/qa/thing.ts', 'src/features/**'))
  assert.ok(!matchesPath('src/features/qa/thing.ts', 'src/*.ts'))
  const root = await mkdtemp(join(tmpdir(), 'signalman-qa-git-'))
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim()
  try {
    git(['init','--quiet']); git(['config','user.email','qa@example.invalid']); git(['config','user.name','QA'])
    await mkdir(join(root, 'src')); await writeFile(join(root,'src/a.ts'), 'one')
    git(['add','.']); git(['commit','--quiet','-m','base']); const base = git(['rev-parse','HEAD'])
    await writeFile(join(root,'src/a.ts'), 'two'); git(['add','.']); git(['commit','--quiet','-m','change'])
    assert.deepEqual(await changeSet(base,root), ['src/a.ts']); assert.deepEqual(await changeSet(undefined,root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
