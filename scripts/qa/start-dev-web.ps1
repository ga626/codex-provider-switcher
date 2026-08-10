param(
    [switch]$NoBuild,
    [switch]$NoOpen,
    [switch]$Reset
)

$ErrorActionPreference = "Stop"

$runtime = & (Join-Path $PSScriptRoot "prepare-dev-runtime.ps1") -Reset:$Reset
$projectRoot = $runtime.ProjectRoot
$webRuntime = Join-Path $projectRoot ".codex\runtime\dev-web"
$stateFile = Join-Path $webRuntime "state.json"
$port = 47833
$backendExecutable = Join-Path $projectRoot "src-tauri\target\debug\local_backend.exe"
$distDir = Join-Path $projectRoot "dist"

New-Item -ItemType Directory -Force -Path $webRuntime | Out-Null

if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
    $previousState = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previousState.pid) {
        $previousProcess = Get-Process -Id $previousState.pid -ErrorAction SilentlyContinue
        if ($previousProcess) {
            Stop-Process -Id $previousState.pid -Force -ErrorAction Stop
            Write-Host "[PASS] Closed previous isolated web preview."
        }
    }
    Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    throw "Isolated web preview port $port is already in use by process $($listener.OwningProcess)."
}

Push-Location $projectRoot
try {
    if (-not $NoBuild) {
        $previousMockFlag = $env:VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK
        $env:VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK = "false"
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Web preview build failed." }
        if ($null -eq $previousMockFlag) {
            Remove-Item Env:\VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK -ErrorAction SilentlyContinue
        } else {
            Set-Item Env:\VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK -Value $previousMockFlag
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $distDir "index.html") -PathType Leaf)) {
        throw "Web preview assets are missing. Run without -NoBuild."
    }

    npm run backend:build
    if ($LASTEXITCODE -ne 0) { throw "Local web backend build failed." }
    if (-not (Test-Path -LiteralPath $backendExecutable -PathType Leaf)) {
        throw "Local web backend executable is missing: $backendExecutable"
    }

    $environmentNames = @(
        "CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL",
        "CODEX_PROVIDER_SWITCHER_BUILD_SHA",
        "CODEX_PROVIDER_SWITCHER_APP_DATA_DIR",
        "CODEX_PROVIDER_SWITCHER_CODEX_HOME",
        "CODEX_PROVIDER_SWITCHER_DIST_DIR"
    )
    $previousEnvironment = @{}
    foreach ($environmentName in $environmentNames) {
        $existing = Get-Item -LiteralPath "Env:$environmentName" -ErrorAction SilentlyContinue
        $previousEnvironment[$environmentName] = if ($null -eq $existing) { $null } else { $existing.Value }
    }
    $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "development"
    $env:CODEX_PROVIDER_SWITCHER_BUILD_SHA = (git rev-parse --short=8 HEAD).Trim()
    $env:CODEX_PROVIDER_SWITCHER_APP_DATA_DIR = $runtime.AppDataDir
    $env:CODEX_PROVIDER_SWITCHER_CODEX_HOME = $runtime.CodexHome
    $env:CODEX_PROVIDER_SWITCHER_DIST_DIR = $distDir

    $out = Join-Path $webRuntime "backend.out.log"
    $err = Join-Path $webRuntime "backend.err.log"
    Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $backendExecutable -ArgumentList @("--host", "127.0.0.1", "--port", "$port") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    Start-Sleep -Seconds 1
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 5
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 5
    if (-not $health.ok -or $state.runtimeMode -ne "local_web_backend") {
        throw "Isolated web preview did not return the expected shared backend state."
    }
    [pscustomobject]@{
        pid = $process.Id
        port = $port
        url = "http://127.0.0.1:$port/"
        sharedRuntime = $runtime.RuntimeRoot
        startedAt = (Get-Date).ToString("s")
    } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    if (-not $NoOpen) {
        Start-Process "http://127.0.0.1:$port/" | Out-Null
    }
    Write-Host "[PASS] Isolated web preview started at http://127.0.0.1:$port/ with the shared development fixture."
}
finally {
    foreach ($environmentName in $previousEnvironment.Keys) {
        if ($null -eq $previousEnvironment[$environmentName]) {
            Remove-Item -LiteralPath "Env:$environmentName" -ErrorAction SilentlyContinue
        } else {
            Set-Item Env:\$environmentName -Value $previousEnvironment[$environmentName]
        }
    }
    Pop-Location
}
