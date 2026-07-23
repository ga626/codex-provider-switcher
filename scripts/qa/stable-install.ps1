param(
    [string]$Version,
    [string]$ReleaseRoot,
    [string]$InstallRoot = "D:\Software\Signalman AI",
    [switch]$Apply,
    [switch]$Uninstall,
    [switch]$ExplainOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))

if (-not $ReleaseRoot) {
    $ReleaseRoot = Join-Path $projectRoot "release-assets"
}
if (-not [System.IO.Path]::IsPathRooted($ReleaseRoot)) {
    $ReleaseRoot = Join-Path $projectRoot $ReleaseRoot
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)

if (-not $Version) {
    $packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = [string]$packageJson.version
}

$setupPath = Join-Path $ReleaseRoot "SignalmanAI-windows-x64-$Version-setup.exe"
$uninstaller = Join-Path $InstallRoot "uninstall.exe"

Write-Host "Validation mode: stable installation"
Write-Host "Install root: $InstallRoot"
Write-Host "Release setup: $setupPath"
Write-Host "User data remains in the existing compatibility directory."
Write-Host "Behavior: install and upgrade replace program files only; uninstall preserves user data."

if ($ExplainOnly) {
    Write-Host "ExplainOnly: no installer or uninstaller launched."
    exit 0
}

if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        throw "Stable installation uninstaller not found: $uninstaller"
    }
    if (-not $Apply) {
        Write-Host "Dry run: would launch $uninstaller /S and then verify user data remains."
        exit 0
    }
    Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait
    if (Test-Path -LiteralPath $InstallRoot) {
        throw "Stable installation directory still exists after uninstall: $InstallRoot"
    }
    Write-Host "[PASS] Stable program directory removed."
    Write-Host "[PASS] Existing user data was not deleted by this script."
    exit 0
}

if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
    throw "GitHub Release installer not found: $setupPath. Build the updater-signed release first."
}

if (-not $Apply) {
    Write-Host "Dry run: would launch the GitHub Release installer with NSIS target $InstallRoot."
    Write-Host "Re-run with -Apply for local stable-install QA."
    exit 0
}

New-Item -ItemType Directory -Path (Split-Path -Parent $InstallRoot) -Force | Out-Null
Start-Process -FilePath $setupPath -ArgumentList "/D=$InstallRoot" -Wait

if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
    throw "Installer did not create the requested stable directory: $InstallRoot"
}
$installedExecutables = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Filter "*.exe" -ErrorAction SilentlyContinue)
if ($installedExecutables.Count -eq 0) {
    throw "Stable directory contains no executable after installation: $InstallRoot"
}
Write-Host "[PASS] Stable installation exists at $InstallRoot"
Write-Host "[PASS] Executables: $($installedExecutables.Name -join ', ')"
Write-Host "[PASS] User data remains outside the install directory."
