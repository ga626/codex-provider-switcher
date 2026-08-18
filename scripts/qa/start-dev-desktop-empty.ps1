param(
    [switch]$Reset
)

$ErrorActionPreference = "Stop"

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
if ($Reset) {
    Get-ChildItem -LiteralPath $appDataDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $codexHome -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
}
Copy-Item -LiteralPath $desktopSource -Destination $desktopExecutable -Force

$buildSha = (git -C $projectRoot rev-parse --short=8 HEAD).Trim()
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $desktopExecutable
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $false
$startInfo.EnvironmentVariables["CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL"] = "development"
$startInfo.EnvironmentVariables["CODEX_PROVIDER_SWITCHER_BUILD_SHA"] = $buildSha
$startInfo.EnvironmentVariables["CODEX_PROVIDER_SWITCHER_APP_DATA_DIR"] = $appDataDir
$startInfo.EnvironmentVariables["CODEX_PROVIDER_SWITCHER_CODEX_HOME"] = $codexHome
$startInfo.EnvironmentVariables["CODEX_PROVIDER_SWITCHER_DEV_VARIANT"] = "first-run-empty"
$desktopProcess = [System.Diagnostics.Process]::Start($startInfo)
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
    pid = $desktopProcess.Id
    title = $desktopProcess.MainWindowTitle
    executable = $desktopExecutable
    runtime = $runtimeRoot
    appData = $appDataDir
    codexHome = $codexHome
    sourceRevision = $buildSha
    existingDemoPids = @($existingDemoProcesses | ForEach-Object { [int]$_.ProcessId })
    existingDemoStillRunning = $existingDemoProcesses.Count -gt 0
} | ConvertTo-Json -Depth 3
