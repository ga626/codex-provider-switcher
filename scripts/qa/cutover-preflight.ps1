param(
    [string]$InstallRoot = "D:\Software\CodeX Provider Switcher",
    [string]$LegacyRoot = "D:\AI Studio\CodeX\Codex Switcher",
    [switch]$ExplainOnly
)

$ErrorActionPreference = "Stop"

function Test-ListeningPort([int]$Port) {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    return $connections.Count -gt 0
}

function Get-LegacyStartupEntries([string]$LegacyPath) {
    foreach ($registryPath in @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    )) {
        if (-not (Test-Path -LiteralPath $registryPath)) { continue }
        $properties = Get-ItemProperty -LiteralPath $registryPath
        foreach ($property in $properties.PSObject.Properties) {
            if ($property.Name -match '^PS' -or $null -eq $property.Value) { continue }
            if ([string]$property.Value -like "*$LegacyPath*") {
                Write-Output ("{0}::{1}" -f $registryPath, $property.Name)
            }
        }
    }
}

if ($ExplainOnly) {
    Write-Host "ExplainOnly: this read-only check does not stop applications, change Codex configuration, or read credentials."
    Write-Host "It reports installation readiness, the legacy process/port, and legacy startup locations for the post-release cutover session."
    exit 0
}

$legacyExe = Join-Path $LegacyRoot "CodeX-Switcher.exe"
$newExe = Join-Path $InstallRoot "codex-provider-switcher.exe"
$legacyProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'CodeX-Switcher.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $legacyExe })
$startupEntries = @(Get-LegacyStartupEntries -LegacyPath $LegacyRoot)
$startupFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$startupShortcuts = @()
if (Test-Path -LiteralPath $startupFolder) {
    $startupShortcuts = @(Get-ChildItem -LiteralPath $startupFolder -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*CodeX*Switcher*" } |
        ForEach-Object { $_.Name })
}
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.Actions | Where-Object { $_.Execute -like "*$LegacyRoot*" -or $_.Arguments -like "*$LegacyRoot*" }
} | ForEach-Object { $_.TaskName })
$services = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
    $_.PathName -like "*$LegacyRoot*"
} | ForEach-Object { $_.Name })

Write-Host "Cutover preflight (read-only)"
Write-Host "New installation: $(if (Test-Path -LiteralPath $newExe -PathType Leaf) { 'ready' } else { 'missing' })"
Write-Host "Legacy executable: $(if (Test-Path -LiteralPath $legacyExe -PathType Leaf) { 'present' } else { 'missing' })"
Write-Host "Legacy process: $(if ($legacyProcesses.Count -gt 0) { 'running' } else { 'not running' })"
Write-Host "Legacy port 47831: $(if (Test-ListeningPort 47831) { 'listening' } else { 'not listening' })"
Write-Host "Run/RunOnce entries: $($startupEntries.Count)"
if ($startupEntries.Count -gt 0) {
    Write-Host "Run/RunOnce locations: $($startupEntries -join ', ')"
}
Write-Host "Startup folder entries: $($startupShortcuts.Count)"
Write-Host "Scheduled task entries: $($tasks.Count)"
Write-Host "Windows service entries: $($services.Count)"
Write-Host "Next action: do not stop the legacy tool in this session. Use these facts in a new post-release Codex session after installed-app and provider acceptance pass."
