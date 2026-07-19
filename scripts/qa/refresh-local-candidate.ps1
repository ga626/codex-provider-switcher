param(
    [string]$InstallRoot = "D:\Software\CodeX Provider Switcher",
    [string]$LegacyProfilesPath = "",
    [switch]$Apply,
    [switch]$ExplainOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))

function Assert-MainCandidateSource {
    $branch = (& git -C $projectRoot branch --show-current).Trim()
    if ($branch -ne "main") {
        throw "Local candidate refresh must run from main after merge. Current branch: $branch"
    }
    $changes = @(& git -C $projectRoot status --short)
    if ($changes.Count -gt 0) {
        throw "Local candidate refresh requires a clean main worktree."
    }
}

function Get-SetupPath {
    $bundleRoot = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"
    $matches = @(Get-ChildItem -LiteralPath $bundleRoot -Filter "*.exe" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($matches.Count -eq 0) {
        throw "No NSIS setup was produced: $bundleRoot"
    }
    return $matches[0].FullName
}

$package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$head = (& git -C $projectRoot rev-parse HEAD).Trim()
$currentBranch = (& git -C $projectRoot branch --show-current).Trim()

Write-Host "Local candidate refresh"
Write-Host "Current source: $currentBranch @ $head"
Write-Host "Version: $($package.version)"
Write-Host "Install root: $InstallRoot"
Write-Host "User data remains: $env:LOCALAPPDATA\CodeX Provider Switcher"
Write-Host "This is a private acceptance channel, not a GitHub Release or Microsoft Store publication."

if ($ExplainOnly) {
    Write-Host "ExplainOnly: after merge, this command would require clean main, build that desktop package, replace program files, optionally recover legacy profiles, and record candidate-install-state.json."
    exit 0
}

Assert-MainCandidateSource

if (-not $Apply) {
    Write-Host "Dry run: re-run with -Apply after main CI succeeds."
    exit 0
}

Push-Location $projectRoot
try {
    npm run release:assets
    if ($LASTEXITCODE -ne 0) { throw "Installer asset generation failed." }

    $candidateConfigPath = Join-Path $projectRoot "scripts\qa\tauri-candidate-build.json"
    if (-not (Test-Path -LiteralPath $candidateConfigPath -PathType Leaf)) {
        throw "Candidate build config is missing: $candidateConfigPath"
    }
    npx tauri build --bundles nsis --config $candidateConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Desktop candidate build failed." }

    $setupPath = Get-SetupPath
    $running = @(Get-Process -Name "codex-provider-switcher" -ErrorAction SilentlyContinue)
    foreach ($processItem in $running) {
        Stop-Process -Id $processItem.Id -Force
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $InstallRoot) -Force | Out-Null
    $installer = Start-Process -FilePath $setupPath -ArgumentList @("/S", "/D=$InstallRoot") -Wait -PassThru
    if ($installer.ExitCode -ne 0) {
        throw "Candidate installer failed with exit code $($installer.ExitCode)."
    }
    $installedExe = Join-Path $InstallRoot "codex-provider-switcher.exe"
    if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
        throw "Candidate installer did not create the expected executable: $installedExe"
    }

    if ($LegacyProfilesPath) {
        $legacyFullPath = [System.IO.Path]::GetFullPath($LegacyProfilesPath)
        if (-not (Test-Path -LiteralPath $legacyFullPath -PathType Leaf)) {
            throw "Legacy profile file not found: $legacyFullPath"
        }
        cargo run --manifest-path src-tauri\Cargo.toml --bin profile_recovery -- $legacyFullPath
        if ($LASTEXITCODE -ne 0) { throw "Legacy profile recovery failed." }
    }

    $state = [ordered]@{
        channel = "local-candidate"
        version = [string]$package.version
        commit = $head
        installed_at = (Get-Date).ToString("o")
        legacy_profile_recovery = [bool]$LegacyProfilesPath
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot "candidate-install-state.json") -Encoding UTF8
    Write-Host "[PASS] Local candidate refreshed at $InstallRoot"
} finally {
    Pop-Location
}
