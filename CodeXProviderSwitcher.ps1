param(
    [int]$Port = 47832,
    [switch]$NoOpen,
    [switch]$Stop
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "bin\local_backend.exe"
$distIndex = Join-Path $root "dist\index.html"
$logs = Join-Path $root "logs"
$healthUrl = "http://127.0.0.1:$Port/api/health"
$appUrl = "http://127.0.0.1:$Port/"

New-Item -ItemType Directory -Path $logs -Force | Out-Null

function Get-BackendProcess {
    $escaped = [Regex]::Escape($backend)
    Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -eq $backend -or $_.CommandLine -match $escaped
    }
}

function Test-Backend {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return ($health.ok -eq $true -and $health.runtimeMode -eq "local_web_backend")
    } catch {
        return $false
    }
}

if ($Stop) {
    Get-BackendProcess | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "CodeX Provider Switcher backend stopped."
    exit 0
}

if (-not (Test-Path -LiteralPath $backend -PathType Leaf)) {
    throw "Missing backend executable: $backend"
}
if (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
    throw "Missing frontend asset: $distIndex"
}

if (-not (Test-Backend)) {
    $stdout = Join-Path $logs "local-backend-$Port.out.log"
    $stderr = Join-Path $logs "local-backend-$Port.err.log"
    $env:CODEX_PROVIDER_SWITCHER_DIST_DIR = Join-Path $root "dist"
    Start-Process -FilePath $backend `
        -ArgumentList @("--port", "$Port") `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr | Out-Null

    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        if (Test-Backend) { break }
        Start-Sleep -Milliseconds 250
    }
}

if (-not (Test-Backend)) {
    throw "Local backend did not become ready. Check logs under $logs"
}

if (-not $NoOpen) {
    Start-Process $appUrl
}

Write-Host "CodeX Provider Switcher is running: $appUrl"
