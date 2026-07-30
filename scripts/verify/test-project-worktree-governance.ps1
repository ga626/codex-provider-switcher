[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "maintenance\manage-project-worktrees.ps1"
$testRoot = Join-Path $env:TEMP ("signalman-worktree-test-" + [guid]::NewGuid().ToString("N"))
$resolvedTempRoot = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\\')
$tempPrefix = $resolvedTempRoot + [System.IO.Path]::DirectorySeparatorChar

foreach ($staleTestRoot in Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter "signalman-worktree-test-*") {
    $resolvedStaleRoot = (Resolve-Path -LiteralPath $staleTestRoot.FullName).Path
    if (-not $resolvedStaleRoot.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Refusing cleanup outside temp root: $resolvedStaleRoot" }
    Remove-Item -LiteralPath $resolvedStaleRoot -Recurse -Force
}

try {
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    & git -C $testRoot init --initial-branch=main | Out-Null
    & git -C $testRoot -c user.name=SignalmanTest -c user.email=signalman-test@example.invalid commit --allow-empty -m initial | Out-Null
    & git -C $testRoot remote add origin $testRoot
    & git -C $testRoot fetch origin main:refs/remotes/origin/main | Out-Null
    & $scriptPath -Action Audit -Repo $testRoot | Out-Null
    & $scriptPath -Action Create -Repo $testRoot -Name governance-test | Out-Null
    $target = Join-Path $testRoot ".codex\worktrees\governance-test"
    if (Test-Path -LiteralPath $target) { throw "Dry run unexpectedly created $target" }
    & $scriptPath -Action Create -Repo $testRoot -Name governance-test -Apply | Out-Null
    if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "Create did not create $target" }
    & $scriptPath -Action Retire -Repo $testRoot -WorktreePath $target -Apply | Out-Null
    if (Test-Path -LiteralPath $target) { throw "Retire did not remove $target" }
    & $scriptPath -Action Audit -Repo $testRoot | Out-Null
    Write-Output "worktree-governance smoke passed"
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).Path
        if (-not $resolvedTestRoot.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Refusing cleanup outside temp root: $resolvedTestRoot" }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
