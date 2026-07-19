param(
    [switch]$ExplainOnly
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$packageJson = Join-Path $projectRoot "package.json"

if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
    throw "package.json not found under $projectRoot"
}

Write-Host "Validation mode: dev desktop"
Write-Host "Meaning: build and launch the current source-tree desktop candidate. No installer, upgrade, uninstall, or published release package is used."
Write-Host "Expected user-visible result: one CodeX Provider Switcher desktop window, no persistent CMD window, no external browser."
Write-Host "Build: npx tauri build --no-bundle"

if ($ExplainOnly) {
    Write-Host "ExplainOnly: not launching the app."
    exit 0
}

Push-Location $projectRoot
try {
    $env:CARGO_BUILD_JOBS = "1"
    npx tauri build --no-bundle --config scripts/qa/tauri-candidate-build.json
    if ($LASTEXITCODE -ne 0) {
        throw "Current-source desktop candidate build failed."
    }

    $desktopExecutable = Join-Path $projectRoot "src-tauri\target\release\codex-provider-switcher.exe"
    if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
        throw "Current-source desktop executable is missing: $desktopExecutable"
    }
    $desktopProcess = Start-Process -FilePath $desktopExecutable -PassThru
    Start-Sleep -Seconds 1
    $desktopProcess.Refresh()
    if ($desktopProcess.HasExited) {
        throw "Current-source desktop candidate exited during startup with code $($desktopProcess.ExitCode)."
    }
    Write-Host "[PASS] Current-source desktop candidate started (PID $($desktopProcess.Id))."
}
finally {
    Pop-Location
}
