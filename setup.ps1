param(
    [switch]$Apply,
    [switch]$NoOpen,
    [switch]$NoBuild
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
$startScript = Join-Path $scriptRoot "scripts\start-preview.ps1"

Write-Host ""
Write-Host "CodeX Provider Switcher alpha launcher" -ForegroundColor Cyan
Write-Host "This entry starts the local Web console preview. The quiet backend and updater will be completed later." -ForegroundColor Gray
Write-Host ""

if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "Missing startup script: $startScript"
}

if (-not $Apply) {
    Write-Host "Dry run: this will call scripts\start-preview.ps1."
    Write-Host "To start for real, run: .\setup.ps1 -Apply"
    exit 0
}

$argsList = @()
if ($NoOpen) { $argsList += "-NoOpen" }
if ($NoBuild) { $argsList += "-NoBuild" }

& powershell -NoProfile -ExecutionPolicy Bypass -File $startScript @argsList
if ($LASTEXITCODE -ne 0) {
    throw "Local preview startup failed."
}
