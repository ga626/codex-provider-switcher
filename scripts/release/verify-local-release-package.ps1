param(
    [string]$ZipPath = "",
    [string]$WorkRoot = ".codex-provider-switcher\release-verification",
    [int]$Port = 47841
)

$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
if ([string]::IsNullOrWhiteSpace($ZipPath)) {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $ZipPath = "release-assets\CodeXProviderSwitcher-windows-x64-$($package.version).zip"
}
$zipFull = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $ZipPath))
$workFull = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $WorkRoot))

if (-not (Test-Path -LiteralPath $zipFull -PathType Leaf)) {
    throw "Release zip not found: $zipFull"
}

if (Test-Path -LiteralPath $workFull) {
    Remove-Item -LiteralPath $workFull -Recurse -Force
}
New-Item -ItemType Directory -Path $workFull -Force | Out-Null

function Invoke-RequestStatus {
    param(
        [string]$Uri,
        [hashtable]$Headers = @{}
    )

    try {
        $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing -TimeoutSec 5
        return [int]$response.StatusCode
    } catch {
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            return [int]$_.Exception.Response.StatusCode
        }
        throw
    }
}

function Test-ListeningPort {
    param([int]$CandidatePort)
    return @(Get-NetTCPConnection -State Listen -LocalPort $CandidatePort -ErrorAction SilentlyContinue).Count -gt 0
}

Expand-Archive -LiteralPath $zipFull -DestinationPath $workFull -Force

$packageRoot = Get-ChildItem -LiteralPath $workFull -Directory | Select-Object -First 1
if (-not $packageRoot) {
    throw "Release zip did not contain a package directory."
}

if (Test-ListeningPort -CandidatePort $Port) {
    $requestedPort = $Port
    $availablePorts = @(47841..47860 | Where-Object { -not (Test-ListeningPort -CandidatePort $_) })
    if ($availablePorts.Count -eq 0) {
        throw "No temporary local port is available for Release verification."
    }
    $Port = [int]$availablePorts[0]
    Write-Host "Release verification port $requestedPort is in use; using temporary port $Port."
}

$launcher = Join-Path $packageRoot.FullName "CodeXProviderSwitcher.ps1"
$cmd = Join-Path $packageRoot.FullName "CodeXProviderSwitcher.cmd"
$backend = Join-Path $packageRoot.FullName "bin\local_backend.exe"
$distIndex = Join-Path $packageRoot.FullName "dist\index.html"

foreach ($required in @($launcher, $cmd, $backend, $distIndex)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Release package missing required file: $required"
    }
}

try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -Port $Port -NoOpen
    if ($LASTEXITCODE -ne 0) {
        throw "Release launcher failed with exit code $LASTEXITCODE."
    }

    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
    if ($health.ok -ne $true -or $health.runtimeMode -ne "local_web_backend") {
        throw "Unexpected health response from release package."
    }

    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 5
    if ($state.runtimeMode -ne "local_web_backend") {
        throw "Unexpected state runtimeMode from release package."
    }

    $page = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
    if ($page.StatusCode -ne 200 -or -not $page.Content.Contains('<div id="root"></div>')) {
        throw "Release package frontend did not serve index.html correctly."
    }

    $crossOriginStatus = Invoke-RequestStatus -Uri "http://127.0.0.1:$Port/api/state" -Headers @{ Origin = "https://example.com" }
    if ($crossOriginStatus -ne 403) {
        throw "Release package API accepted a non-local Origin. Status: $crossOriginStatus"
    }

    Write-Host "[PASS] Release package can start and serve the local Web app."
    Write-Host "[PASS] Release package API rejects non-local Origin."
    Write-Host "[PASS] URL: http://127.0.0.1:$Port/"
    Write-Host "[PASS] Profiles: $($state.profiles.Count)"
} finally {
    if (Test-Path -LiteralPath $launcher -PathType Leaf) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -Port $Port -Stop | Out-Null
    }
}
