param(
    [string]$Version = "0.3.1-alpha",
    [string]$Tag = "",
    [string]$Repository = "ga626/codex-provider-switcher",
    [string]$OutputRoot = "release-assets",
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
if ([string]::IsNullOrWhiteSpace($Tag)) {
    $Tag = "v$Version"
}

$releaseName = "CodeXProviderSwitcher-windows-x64-$Version"
$outputRootPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputRoot))
$zipPath = Join-Path $outputRootPath "$releaseName.zip"
$shaPath = Join-Path $outputRootPath "$releaseName.zip.sha256"
$setupPath = Join-Path $outputRootPath "CodeXProviderSwitcher-windows-x64-$Version-setup.exe"
$setupShaPath = "$setupPath.sha256"
$notesPath = Join-Path $projectRoot "docs\release\release-notes-$Version.md"

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command is missing: $Name"
    }
}

Assert-Command git
Assert-Command gh

$branch = (& git -C $projectRoot branch --show-current).Trim()
$status = (& git -C $projectRoot status --short)
Write-Host "CodeX Provider Switcher GitHub Release publish plan"
Write-Host "Repository: $Repository"
Write-Host "Tag:        $Tag"
Write-Host "Branch:     $branch"
Write-Host "Zip:        $zipPath"
Write-Host "SHA256:     $shaPath"
Write-Host "Setup:      $setupPath"
Write-Host "Notes:      $notesPath"
Write-Host "Mode:       $(if ($Apply) { 'apply' } else { 'dry-run' })"

if ($branch -ne "main") {
    throw "Release assets must be published from main. Current branch: $branch"
}
if (-not [string]::IsNullOrWhiteSpace(($status -join "`n"))) {
    throw "Working tree must be clean before publishing release assets."
}

& git -C $projectRoot fetch origin
$head = (& git -C $projectRoot rev-parse HEAD).Trim()
$originMain = (& git -C $projectRoot rev-parse origin/main).Trim()
if ($head -ne $originMain) {
    throw "Local main is not equal to origin/main. HEAD=$head origin/main=$originMain"
}

if (-not $Apply) {
    Write-Host ""
    Write-Host "Dry run only. Re-run with -Apply after the user confirms publishing a new immutable Release."
    exit 0
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "build-codex-provider-switcher-release.ps1") -Version $Version -OutputRoot $OutputRoot -Apply
if ($LASTEXITCODE -ne 0) { throw "Release package build failed." }
if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { throw "Release zip missing after build: $zipPath" }
if (-not (Test-Path -LiteralPath $shaPath -PathType Leaf)) { throw "Release SHA256 file missing after build: $shaPath" }
if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw "Desktop setup missing after build: $setupPath" }
if (-not (Test-Path -LiteralPath $setupShaPath -PathType Leaf)) { throw "Desktop setup SHA256 missing after build: $setupShaPath" }
if (-not (Test-Path -LiteralPath $notesPath -PathType Leaf)) { throw "Release notes missing: $notesPath" }

& gh release view $Tag --repo $Repository *> $null
if ($LASTEXITCODE -ne 0) {
    throw "GitHub Release $Tag does not exist. Create the new Release first; this script never creates or overwrites tags."
}
$releaseAssets = @($setupPath, $setupShaPath, $zipPath, $shaPath)
$releaseAssets += @(Get-ChildItem -LiteralPath $outputRootPath -File -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq "latest.json" -or $_.Name -like "*-setup.exe.sig"
} | ForEach-Object { $_.FullName })
& gh release upload $Tag @releaseAssets --repo $Repository
if ($LASTEXITCODE -ne 0) { throw "Failed to upload GitHub Release assets." }
& gh release edit $Tag --repo $Repository --notes-file $notesPath
if ($LASTEXITCODE -ne 0) { throw "Failed to update GitHub Release notes." }

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "verify-github-release-asset.ps1") -Version $Version -Tag $Tag -Repository $Repository -OutputRoot $OutputRoot -SkipBuild
if ($LASTEXITCODE -ne 0) { throw "Remote GitHub Release verification failed after upload." }
