param(
    [int]$Port = 47832,
    [switch]$Apply,
    [switch]$NoOpen,
    [switch]$NoBuild,
    [switch]$Stop
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $scriptRoot "CodeXProviderSwitcher.ps1"

Write-Host ""
Write-Host "CodeX Provider Switcher alpha launcher" -ForegroundColor Cyan
Write-Host "This entry builds and starts the real local Web backend on 127.0.0.1:$Port." -ForegroundColor Gray
Write-Host ""

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Missing startup script: $launcher"
}

if ($Stop) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -Port $Port -Stop
    exit $LASTEXITCODE
}

if (-not $Apply) {
    Write-Host "Dry run: this will build frontend/backend if needed, then start the local Web backend."
    Write-Host "To start for real, run: .\setup.ps1 -Apply"
    exit 0
}

if (-not $NoBuild) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "Missing npm. Install Node.js before running the source launcher."
    }
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw "Missing cargo. Install Rust before running the source launcher."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $scriptRoot "node_modules") -PathType Container)) {
        Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
        & npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    }
    Write-Host "Building frontend..." -ForegroundColor Cyan
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
    Write-Host "Building local backend..." -ForegroundColor Cyan
    & npm run backend:build
    if ($LASTEXITCODE -ne 0) { throw "npm run backend:build failed." }
}

$argsList = @("-Port", "$Port")
if ($NoOpen) { $argsList += "-NoOpen" }

& powershell -NoProfile -ExecutionPolicy Bypass -File $launcher @argsList
if ($LASTEXITCODE -ne 0) {
    throw "Local Web backend startup failed."
}
