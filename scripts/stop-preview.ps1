$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $ProjectRoot "logs"
$StateFile = Join-Path $LogDir "preview-state.json"

if (-not (Test-Path -LiteralPath $StateFile)) {
  Write-Host "No preview state file found."
  exit 0
}

$state = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
if ($state.pid) {
  Stop-Process -Id $state.pid -Force -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
Write-Host "Preview stopped."
