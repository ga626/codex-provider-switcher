$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "start-dev-desktop.ps1") -Reset
if ($LASTEXITCODE -ne 0) { throw "Isolated desktop development startup failed." }

& (Join-Path $PSScriptRoot "start-dev-web.ps1") -NoBuild -NoOpen
if ($LASTEXITCODE -ne 0) { throw "Shared web development preview startup failed." }

Write-Host "[PASS] Desktop and web development surfaces now share .codex\\runtime\\dev-desktop."
