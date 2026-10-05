param(
    [switch]$NoBuild,
    [switch]$NoOpen,
    [switch]$Reset
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "start-scheduled-process.ps1")

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
    $launch = Start-SignalmanScheduledProcess -FilePath $backendExecutable -ArgumentList @("--host", "127.0.0.1", "--port", "$port") -WorkingDirectory $projectRoot -Environment @{
        CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "development"
        CODEX_PROVIDER_SWITCHER_BUILD_SHA = (git rev-parse --short=8 HEAD).Trim()
        CODEX_PROVIDER_SWITCHER_APP_DATA_DIR = $runtime.AppDataDir
        CODEX_PROVIDER_SWITCHER_CODEX_HOME = $runtime.CodexHome
        CODEX_PROVIDER_SWITCHER_DIST_DIR = $distDir
    } -StdoutPath $out -StderrPath $err
    $processId = $null
    $process = $null
    $processDeadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $process = @(Get-CimInstance Win32_Process -Filter "Name='local_backend.exe'" | Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -eq [System.IO.Path]::GetFullPath($backendExecutable)) } | Select-Object -First 1)
        if ($process.Count -gt 0) { $processId = [int]$process[0].ProcessId }
    } while ($null -eq $processId -and (Get-Date) -lt $processDeadline)
    if ($null -eq $processId) { throw "Scheduled isolated web preview backend did not start." }
    $health = $null
    $state = $null
    $ready = $false
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 250
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            $backendError = if (Test-Path -LiteralPath $err) { Get-Content -LiteralPath $err -Raw -Encoding UTF8 } else { "(no backend stderr log)" }
            throw "Isolated web preview backend exited during startup: $backendError"
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
            $state = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 2
            if ($health.ok -and $state.runtimeMode -eq "local_web_backend") {
                $ready = $true
            }
        } catch {
            # The backend may still be binding its socket; keep polling until the deadline.
        }
    } while (-not $ready -and (Get-Date) -lt $deadline)
    if (-not $ready) {
        $backendError = if (Test-Path -LiteralPath $err) { Get-Content -LiteralPath $err -Raw -Encoding UTF8 } else { "(no backend stderr log)" }
        throw "Isolated web preview did not become healthy within 20 seconds: $backendError"
    }
    if (-not $health.ok -or $state.runtimeMode -ne "local_web_backend") {
        throw "Isolated web preview did not return the expected shared backend state."
    }
    [pscustomobject]@{
        pid = $processId
        port = $port
        url = "http://127.0.0.1:$port/"
        sharedRuntime = $runtime.RuntimeRoot
        backendExecutable = [System.IO.Path]::GetFullPath($backendExecutable)
        buildSha = (git rev-parse --short=8 HEAD).Trim()
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
