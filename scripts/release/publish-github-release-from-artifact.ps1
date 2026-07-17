param(
    [string]$Version = "",
    [string]$Tag = "",
    [string]$Repository = "ga626/codex-provider-switcher",
    [string]$OutputRoot = "release-assets"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
if ([string]::IsNullOrWhiteSpace($Version)) {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = [string]$package.version
}
if ([string]::IsNullOrWhiteSpace($Tag)) {
    $Tag = "v$Version"
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "Required command is missing: gh"
}

$outputRootPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputRoot))
$releaseName = "CodeXProviderSwitcher-windows-x64-$Version"
$setupName = "$releaseName-setup.exe"
$expectedNames = @(
    "$releaseName.zip",
    "$releaseName.zip.sha256",
    $setupName,
    "$setupName.sha256",
    "$setupName.sig",
    "latest.json"
)
$assetPaths = @($expectedNames | ForEach-Object { Join-Path $outputRootPath $_ })
$notesPath = Join-Path $projectRoot "docs\release\release-notes-$Version.md"

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "verify-release-upload-assets.ps1") -Version $Version -OutputRoot $OutputRoot
if ($LASTEXITCODE -ne 0) {
    throw "Release upload asset verification failed."
}
if (-not (Test-Path -LiteralPath $notesPath -PathType Leaf)) {
    throw "Release notes are missing: $notesPath"
}

$releaseRaw = & gh api "repos/$Repository/releases/tags/$Tag" 2>&1
if ($LASTEXITCODE -eq 0) {
    $release = $releaseRaw | ConvertFrom-Json
    if ($release.draft -or $release.prerelease) {
        throw "Existing GitHub Release $Tag is not eligible for the updater latest channel."
    }
    $assetNames = @($release.assets | ForEach-Object { $_.name })
    $missingNames = @($expectedNames | Where-Object { $_ -notin $assetNames })
    if ($missingNames.Count -gt 0) {
        throw "Existing GitHub Release $Tag is incomplete. Refusing to overwrite assets: $($missingNames -join '; ')"
    }
    Write-Host "[PASS] GitHub Release $Tag already contains the expected asset names. No overwrite was attempted."
    exit 0
}

if ($releaseRaw -notmatch "404|Not Found") {
    throw "Unable to determine GitHub Release state for $Tag. Output: $releaseRaw"
}

& gh release create $Tag @assetPaths --repo $Repository --title "CodeX Provider Switcher $Version" --notes-file $notesPath --verify-tag --latest
if ($LASTEXITCODE -ne 0) {
    throw "GitHub Release creation failed."
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "verify-github-release-asset.ps1") -Version $Version -Tag $Tag -Repository $Repository -OutputRoot $OutputRoot -SkipBuild
if ($LASTEXITCODE -ne 0) {
    throw "Remote GitHub Release verification failed after creation."
}

Write-Host "[PASS] GitHub Release $Tag was created from verified workflow artifacts."
