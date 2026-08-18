param(
    [switch]$ExplainOnly,
    [switch]$Reset
)

$ErrorActionPreference = "Stop"

$runtime = & (Join-Path $PSScriptRoot "prepare-dev-runtime.ps1") -Reset:$Reset
$projectRoot = $runtime.ProjectRoot
$packageJson = Join-Path $projectRoot "package.json"
$runtimeRoot = $runtime.RuntimeRoot
$appDataDir = $runtime.AppDataDir
$codexHome = $runtime.CodexHome

if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
    throw "package.json not found under $projectRoot"
}

Write-Host "Validation mode: isolated development desktop"
Write-Host "Meaning: build and launch only the current source-tree executable. No installer, upgrade, uninstall, or published release package is used."
Write-Host "Data boundary: $runtimeRoot"
Write-Host "The app receives credential-free Codex and product fixtures, including example providers, model catalogs, checks, and cost samples. It cannot read or write the user's real Codex config, auth, or stable app data."
Write-Host "Expected user-visible result: one Signalman AI · 开发版 window, no persistent CMD window, no external browser."
Write-Host "Build: npx tauri build --no-bundle"

if ($ExplainOnly) {
    Write-Host "ExplainOnly: not creating runtime files, building, or launching the app."
    exit 0
}

Push-Location $projectRoot
try {
    $desktopExecutable = Join-Path $projectRoot "src-tauri\target\release\codex-provider-switcher.exe"
    if (Test-Path -LiteralPath $desktopExecutable -PathType Leaf) {
        $runningDevelopmentProcesses = @(Get-CimInstance Win32_Process -Filter "Name='codex-provider-switcher.exe'" | Where-Object {
            $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -eq [System.IO.Path]::GetFullPath($desktopExecutable))
        })
        foreach ($runningDevelopmentProcess in $runningDevelopmentProcesses) {
            Stop-Process -Id $runningDevelopmentProcess.ProcessId -Force -ErrorAction Stop
            Wait-Process -Id $runningDevelopmentProcess.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        }
        if ($runningDevelopmentProcesses.Count -gt 0) {
            Write-Host "[PASS] Closed $($runningDevelopmentProcesses.Count) previous source-tree development desktop process(es)."
        }
    }

    $buildSha = (git rev-parse --short=8 HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($buildSha)) {
        throw "Unable to determine the source revision for the development window."
    }
    $environmentNames = @(
        "CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL",
        "CODEX_PROVIDER_SWITCHER_BUILD_SHA",
        "CODEX_PROVIDER_SWITCHER_APP_DATA_DIR",
        "CODEX_PROVIDER_SWITCHER_CODEX_HOME",
        "CARGO_BUILD_JOBS"
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
    $env:CARGO_BUILD_JOBS = "1"
    npx tauri build --no-bundle --config scripts/qa/tauri-candidate-build.json
    if ($LASTEXITCODE -ne 0) {
        throw "Current-source desktop candidate build failed."
    }

    if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
        throw "Current-source desktop executable is missing: $desktopExecutable"
    }
    $desktopProcess = Start-Process -FilePath $desktopExecutable -WorkingDirectory $projectRoot -PassThru
    Start-Sleep -Seconds 1
    $desktopProcess.Refresh()
    if ($desktopProcess.HasExited) {
        throw "Current-source desktop candidate exited during startup with code $($desktopProcess.ExitCode)."
    }
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SignalmanDailyWindowTitle {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetWindowText(IntPtr hWnd, string text);
}
'@
    $desktopProcess.Refresh()
    if ($desktopProcess.MainWindowHandle -ne [IntPtr]::Zero) {
        [SignalmanDailyWindowTitle]::SetWindowText($desktopProcess.MainWindowHandle, "Signalman AI - DEV - DAILY - $buildSha") | Out-Null
    }
    Write-Host "[PASS] Isolated development desktop started (PID $($desktopProcess.Id), revision $buildSha)."
}
finally {
    if ($null -ne $previousEnvironment) {
        foreach ($environmentName in $previousEnvironment.Keys) {
            if ($null -eq $previousEnvironment[$environmentName]) {
                Remove-Item -LiteralPath "Env:$environmentName" -ErrorAction SilentlyContinue
            } else {
                Set-Item -LiteralPath "Env:$environmentName" -Value $previousEnvironment[$environmentName]
            }
        }
    }
    Pop-Location
}
