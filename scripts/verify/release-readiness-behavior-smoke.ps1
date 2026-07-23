$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$readinessScript = Join-Path $PSScriptRoot "release-readiness.ps1"
$fakeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("signalman-release-readiness-" + [guid]::NewGuid().ToString("N"))
$fakeGh = Join-Path $fakeRoot "gh.cmd"
$originalPath = $env:PATH

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

try {
    New-Item -ItemType Directory -Path $fakeRoot -Force | Out-Null
    @'
@echo off
set args=%*
echo %args% | findstr /C:"secret list" >nul && (echo HTTP 403: Resource not accessible by integration& exit /b 1)
echo %args% | findstr /C:"dependabot/alerts" >nul && (echo HTTP 403: Resource not accessible by integration& exit /b 1)
echo %args% | findstr /C:"releases/tags/" >nul && (echo Not Found& exit /b 1)
echo %args% | findstr /C:"immutable-releases" >nul && (echo {"enabled":true}& exit /b 0)
echo %args% | findstr /C:"api repos/" >nul && (echo {"archived":false}& exit /b 0)
echo Unsupported gh command: %args%
exit /b 1
'@ | Set-Content -LiteralPath $fakeGh -Encoding ASCII

    $env:PATH = "$fakeRoot;$originalPath"

    $runnerOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $readinessScript -Mode RunnerSafe -Channel github -Tag v0.9.0-alpha -SourceRef v0.9.0-alpha 2>&1 | Out-String
    $runnerExitCode = $LASTEXITCODE
    Assert-Condition ($runnerExitCode -eq 0) "RunnerSafe readiness must pass when Secret and Dependabot APIs are denied. Output: $runnerOutput"
    Assert-Condition ($runnerOutput -match "\[PASS\] Release readiness checks passed") "RunnerSafe readiness did not report success. Output: $runnerOutput"

    $maintainerOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $readinessScript -Mode Maintainer -Channel github -Tag v0.9.0-alpha 2>&1 | Out-String
    $maintainerExitCode = $LASTEXITCODE
    Assert-Condition ($maintainerExitCode -ne 0) "Maintainer readiness must fail when required governance APIs are denied. Output: $maintainerOutput"
    Assert-Condition ($maintainerOutput -match "Unable to list GitHub Secret names") "Maintainer readiness did not check Secret metadata. Output: $maintainerOutput"
    Assert-Condition ($maintainerOutput -match "Unable to read open Dependabot alerts") "Maintainer readiness did not check Dependabot alerts. Output: $maintainerOutput"

    Write-Host "[PASS] Release readiness permission-boundary behavior verified."
} finally {
    $env:PATH = $originalPath
    if (Test-Path -LiteralPath $fakeRoot) { Remove-Item -LiteralPath $fakeRoot -Recurse -Force }
}
