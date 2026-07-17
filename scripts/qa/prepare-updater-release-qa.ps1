param(
    [string]$CurrentVersion = "",
    [string]$TargetVersion = "",
    [string]$InstallRoot = "D:\Software\CodeX Provider Switcher",
    [switch]$ExplainOnly,
    [switch]$Collect
)

$ErrorActionPreference = "Stop"

function Get-CoreVersion([string]$Value) {
    if ($Value -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$') { throw "Unsupported release version: $Value" }
    return [Version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if (-not $TargetVersion) {
    $packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
    $TargetVersion = [string]$packageJson.version
}
$installedExe = Join-Path $InstallRoot "codex-provider-switcher.exe"
if (-not $CurrentVersion -and (Test-Path -LiteralPath $installedExe -PathType Leaf)) { $CurrentVersion = [string](Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion }

Write-Host "Validation mode: cross-version updater"
Write-Host "Baseline: $(if ($CurrentVersion) { $CurrentVersion } else { '<install baseline first>' })"
Write-Host "Target: $TargetVersion"
if ($ExplainOnly) {
    Write-Host "ExplainOnly: no app, installer, GitHub download, or signing key is used."
    Write-Host "After publishing the target tag, start the baseline, use the in-app update button, then confirm download, restart, target version, and user-data retention."
    exit 0
}
if (-not $CurrentVersion -or -not (Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw "Install the baseline release first or pass -CurrentVersion." }
$installedVersion = [string](Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion
if ($installedVersion -ne $CurrentVersion) { throw "Installed executable version does not match the requested baseline: $installedVersion != $CurrentVersion" }
$baselineCore = Get-CoreVersion -Value $CurrentVersion
$targetCore = Get-CoreVersion -Value $TargetVersion
if ($targetCore -le $baselineCore) { throw "Target version must be higher than baseline: $TargetVersion <= $CurrentVersion" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "Required command is missing: gh" }

$tag = "v$TargetVersion"
$releaseRaw = & gh release view $tag --repo ga626/codex-provider-switcher --json tagName,isDraft,isPrerelease,assets 2>&1
if ($LASTEXITCODE -ne 0) { throw "Target GitHub Release is unavailable: $tag. Output: $releaseRaw" }
$release = $releaseRaw | ConvertFrom-Json
if ($release.isDraft -or $release.isPrerelease) { throw "Target Release must be Latest-compatible." }
$setup = "CodeXProviderSwitcher-windows-x64-$TargetVersion-setup.exe"
$requiredAssets = @($setup, "$setup.sig", "latest.json")
$assetNames = @($release.assets | ForEach-Object { $_.name })
$missing = @($requiredAssets | Where-Object { $_ -notin $assetNames })
if ($missing.Count -gt 0) { throw "Target Release is missing updater assets: $($missing -join '; ')" }
Write-Host "[PASS] Baseline is lower than target and target updater assets are complete."
if ($Collect) {
    $qaRoot = Join-Path $projectRoot ".codex-provider-switcher\qa\updater-$CurrentVersion-to-$TargetVersion"
    New-Item -ItemType Directory -Path $qaRoot -Force | Out-Null
    "Baseline: $CurrentVersion`r`nTarget: $TargetVersion`r`nAction: start baseline, click 检查更新, download, restart, and confirm user data remains." | Set-Content -LiteralPath (Join-Path $qaRoot "README-QA.md") -Encoding UTF8
    Write-Host "[PASS] Acceptance notes: $qaRoot"
}
