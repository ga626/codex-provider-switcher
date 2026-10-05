param(
    [switch]$Reset
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "start-scheduled-process.ps1")

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$runtimeRoot = Join-Path $projectRoot ".codex\runtime\dev-desktop-empty"
$appDataDir = Join-Path $runtimeRoot "app-data"
$codexHome = Join-Path $runtimeRoot "codex-home"
$binDir = Join-Path $runtimeRoot "bin"
$desktopSource = Join-Path $projectRoot "src-tauri\target\release\codex-provider-switcher.exe"
$desktopExecutable = Join-Path $binDir "codex-provider-switcher-empty.exe"

if (-not (Test-Path -LiteralPath $desktopSource -PathType Leaf)) {
    throw "Current-source desktop executable is missing: $desktopSource. Run npm run dev:desktop once first."
}

New-Item -ItemType Directory -Force -Path $appDataDir, $codexHome, $binDir | Out-Null
& (Join-Path $PSScriptRoot 'close-dev-desktop.ps1') -ProjectRoot $projectRoot
if ($Reset) {
    Get-ChildItem -LiteralPath $appDataDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $codexHome -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
}
Copy-Item -LiteralPath $desktopSource -Destination $desktopExecutable -Force

$buildSha = (git -C $projectRoot rev-parse --short=8 HEAD).Trim()
$environmentNames = @(
    "CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL",
    "CODEX_PROVIDER_SWITCHER_BUILD_SHA",
    "CODEX_PROVIDER_SWITCHER_APP_DATA_DIR",
    "CODEX_PROVIDER_SWITCHER_CODEX_HOME",
    "CODEX_PROVIDER_SWITCHER_DEV_VARIANT"
)
$previousEnvironment = @{}
foreach ($environmentName in $environmentNames) {
    $existing = Get-Item -LiteralPath "Env:$environmentName" -ErrorAction SilentlyContinue
    $previousEnvironment[$environmentName] = if ($null -eq $existing) { $null } else { $existing.Value }
}
$env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "development"
$env:CODEX_PROVIDER_SWITCHER_BUILD_SHA = $buildSha
$env:CODEX_PROVIDER_SWITCHER_APP_DATA_DIR = $appDataDir
$env:CODEX_PROVIDER_SWITCHER_CODEX_HOME = $codexHome
$env:CODEX_PROVIDER_SWITCHER_DEV_VARIANT = "first-run-empty"
try {
    $launch = Start-SignalmanScheduledProcess -FilePath $desktopExecutable -WorkingDirectory $projectRoot -Environment @{
        CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "development"
        CODEX_PROVIDER_SWITCHER_BUILD_SHA = $buildSha
        CODEX_PROVIDER_SWITCHER_APP_DATA_DIR = $appDataDir
        CODEX_PROVIDER_SWITCHER_CODEX_HOME = $codexHome
        CODEX_PROVIDER_SWITCHER_DEV_VARIANT = "first-run-empty"
    }
    $desktopProcessId = $null
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $desktopProcessId = @(Get-CimInstance Win32_Process -Filter "Name='codex-provider-switcher-empty.exe'" | Select-Object -First 1 -ExpandProperty ProcessId)
    } while ($null -eq $desktopProcessId -and (Get-Date) -lt $deadline)
    if ($null -eq $desktopProcessId) { throw "Scheduled empty development desktop did not start." }
} finally {
    foreach ($environmentName in $previousEnvironment.Keys) {
        if ($null -eq $previousEnvironment[$environmentName]) {
            Remove-Item -LiteralPath "Env:$environmentName" -ErrorAction SilentlyContinue
        } else {
            Set-Item -LiteralPath "Env:$environmentName" -Value $previousEnvironment[$environmentName]
        }
    }
}
$desktopProcess = Get-Process -Id $desktopProcessId -ErrorAction Stop
Start-Sleep -Seconds 2
$desktopProcess.Refresh()
if ($desktopProcess.HasExited) {
    throw "Empty development desktop exited during startup with code $($desktopProcess.ExitCode)."
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SignalmanEmptyWindowTitle {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetWindowText(IntPtr hWnd, string text);
}
'@
$desktopProcess.Refresh()
if ($desktopProcess.MainWindowHandle -ne [IntPtr]::Zero) {
    [SignalmanEmptyWindowTitle]::SetWindowText($desktopProcess.MainWindowHandle, "Signalman AI - DEV - FIRST RUN - $buildSha") | Out-Null
}

$existingDemoProcesses = @(Get-CimInstance Win32_Process -Filter "Name='codex-provider-switcher.exe'" | Where-Object {
    $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -eq [System.IO.Path]::GetFullPath($desktopSource))
})

[pscustomobject]@{
    pid = $desktopProcessId
    title = $desktopProcess.MainWindowTitle
    executable = $desktopExecutable
    runtime = $runtimeRoot
    appData = $appDataDir
    codexHome = $codexHome
    sourceRevision = $buildSha
    existingDemoPids = @($existingDemoProcesses | ForEach-Object { [int]$_.ProcessId })
    existingDemoStillRunning = $existingDemoProcesses.Count -gt 0
} | ConvertTo-Json -Depth 3
