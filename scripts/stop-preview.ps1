$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $ProjectRoot "logs"
$StateFile = Join-Path $LogDir "preview-state.json"
$PreviewPort = 47832
$processIds = @()

if (Test-Path -LiteralPath $StateFile) {
  $state = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
  if ($state.pid) {
    $processIds += [int]$state.pid
  }
}

$listeners = @(Get-NetTCPConnection -LocalPort $PreviewPort -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($candidate -and $candidate.CommandLine -like "*$ProjectRoot*" -and $candidate.CommandLine -match "vite.*preview") {
    $processIds += [int]$listener.OwningProcess
  }
}

$uniqueProcessIds = @($processIds | Sort-Object -Unique)
foreach ($procId in $uniqueProcessIds) {
  $process = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($process) {
    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$procId", "/T", "/F") -WindowStyle Hidden -Wait | Out-Null
  }
}

Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
Write-Host "Preview stopped."
