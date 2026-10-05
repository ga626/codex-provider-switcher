import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
const exec = promisify(execFile)
export function matchesPath(file, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`).test(file.replaceAll('\\', '/'))
}
export async function git(args, cwd = process.cwd()) { return (await exec('git', args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout.trim() }
export async function changeSet(base, cwd = process.cwd()) {
  const committed = base && /^0+$/.test(base) ? await git(['ls-files'], cwd) : await git(['diff', '--name-only', base ? `${base}...HEAD` : 'HEAD'], cwd)
  const working = await git(['diff', '--name-only', 'HEAD'], cwd)
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], cwd)
  return [...new Set([committed, working, untracked].flatMap(s => s.split(/\r?\n/)).filter(Boolean))]
}
export async function identity(cwd = process.cwd()) {
  const files = (await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd)).split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const file of [...new Set(files)]) {
    hash.update(file).update('\0')
    try { hash.update(await readFile(join(cwd, file))) } catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('[deleted]') }
  }
  return { sourceRevision: await git(['rev-parse', 'HEAD'], cwd), sourceFingerprint: hash.digest('hex'), fixtureFingerprint: createHash('sha256').update(await readFile(join(cwd, 'src/features/qa/boundary-fixture.json'))).digest('hex') }
}
export async function runChecks(checks, execute, persist, fields = {}) {
  const receipt = { kind: 'qa-quick/v2', runId: randomUUID(), startedAt: new Date().toISOString(), result: 'running', ...fields, checks: checks.map(name => ({ name, result: 'not-run' })) }
  await persist(receipt)
  try {
    for (const check of receipt.checks) {
      check.result = 'running'; check.startedAt = new Date().toISOString(); await persist(receipt)
      try { await execute(check.name); check.result = 'passed' }
      catch { check.result = 'failed'; throw new Error(`检查失败：${check.name}`) }
      finally { check.finishedAt = new Date().toISOString(); await persist(receipt) }
    }
    receipt.result = 'passed'
  } catch (error) { receipt.result = 'failed'; receipt.failure = error.message }
  finally { receipt.finishedAt = new Date().toISOString(); await persist(receipt) }
  return receipt
}
export async function saveReceipt(root, receipt) {
  await mkdir(root, { recursive: true })
  const data = JSON.stringify(receipt, null, 2) + '\n'
  for (const name of [`${receipt.runId}.json`, 'latest-qa-quick.json']) {
    const temporary = join(root, `${name}.${process.pid}.tmp`)
    await writeFile(temporary, data)
    await rename(temporary, join(root, name))
  }
}
