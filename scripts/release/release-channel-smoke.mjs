import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const [releaseBuild, storeBuild, candidateRefresh, adapter, releaseWorkflow, storeWorkflow, readinessSmoke] = await Promise.all([
  readFile(join(root, 'scripts/release/build-codex-provider-switcher-release.ps1'), 'utf8'),
  readFile(join(root, 'scripts/release/build-store-msix.ps1'), 'utf8'),
  readFile(join(root, 'scripts/qa/refresh-local-candidate.ps1'), 'utf8'),
  readFile(join(root, 'src/adapter.ts'), 'utf8'),
  readFile(join(root, '.github/workflows/release.yml'), 'utf8'),
  readFile(join(root, '.github/workflows/store-package.yml'), 'utf8'),
  readFile(join(root, 'scripts/verify/release-readiness-behavior-smoke.ps1'), 'utf8'),
])

assert(releaseBuild.includes('$env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "stable"'), 'GitHub release builds must compile the stable updater channel')
assert(storeBuild.includes('$env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "store"'), 'Store MSIX builds must compile the Store channel')
assert(candidateRefresh.includes('$env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "candidate"'), 'Candidate builds must not use the public stable updater channel')
assert(candidateRefresh.includes('D:\\Software\\Signalman AI Candidate'), 'Candidate builds must use their own installation root')
assert(adapter.includes("export const isStoreManagedBuild = __CODEX_RELEASE_CHANNEL__ === 'store'"), 'The frontend must identify Store-managed builds')
assert(adapter.includes('if (!isGitHubReleaseBuild)'), 'Only stable builds may load the GitHub updater')
assert(releaseWorkflow.includes('name: GitHub Release'), 'GitHub workflow must describe the public release path')
assert(releaseWorkflow.includes('tags:'), 'GitHub releases must be triggerable by an explicit version tag')
assert(releaseWorkflow.includes('CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL: stable'), 'GitHub workflow must pass the stable channel to the build')
assert(!releaseWorkflow.includes('WINDOWS_CERTIFICATE'), 'GitHub releases must not require a Windows certificate under the accepted policy')
assert(releaseWorkflow.includes('-Mode RunnerSafe'), 'GitHub Release workflow must use the runner-safe readiness mode')
assert(releaseWorkflow.includes('-SourceRef $env:RELEASE_TAG'), 'Runner-safe readiness must inspect the target tag, not controller files')
assert(releaseWorkflow.includes('Checkout release controller'), 'Manual recovery must load release control logic before checking out the artifact tag')
assert(releaseWorkflow.includes('fetch-depth: 0'), 'Release controller checkout must fetch the requested immutable tag')
assert(!releaseWorkflow.includes('-SkipRepositorySettings'), 'GitHub Release workflow must not rely on an ambiguous skip switch')
assert(readinessSmoke.includes('RunnerSafe readiness must pass'), 'Readiness behavior smoke must cover denied runner governance APIs')
assert(readinessSmoke.includes('Maintainer readiness must fail'), 'Readiness behavior smoke must cover maintainer governance enforcement')
assert(storeWorkflow.includes('name: Microsoft Store candidate package'), 'Store workflow must describe the low-frequency submission path')
assert(storeWorkflow.includes('workflow_dispatch:'), 'Store packaging must require an explicit maintainer action')
assert(!storeWorkflow.includes('pull_request:'), 'Ordinary PRs must not produce Partner Center upload artifacts')
assert(!storeWorkflow.includes('push:'), 'Ordinary GitHub release tags must not automatically create Store submissions')

console.log('[PASS] GitHub and Store release channels are separated.')
