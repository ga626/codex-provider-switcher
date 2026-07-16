param(
  [switch]$NoBuild,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $ProjectRoot "logs"
$StateFile = Join-Path $LogDir "preview-state.json"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not $NoBuild) {
  Push-Location $ProjectRoot
  try {
    $previousMockFlag = $env:VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK
    $env:VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK = "true"
    npm run build
  } finally {
    if ($null -eq $previousMockFlag) {
      Remove-Item Env:\VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK -ErrorAction SilentlyContinue
    } else {
      $env:VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK = $previousMockFlag
    }
    Pop-Location
  }
}

$existing = $null
if (Test-Path -LiteralPath $StateFile) {
  $state = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
  if ($state.pid) {
    $existing = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
  }
  if ($existing) {
    $url = "http://127.0.0.1:$($state.port)/"
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        if (-not $NoOpen) {
          Start-Process $url | Out-Null
        }
        Write-Host $url
        exit 0
      }
    } catch {
      Stop-Process -Id $state.pid -Force -ErrorAction SilentlyContinue
    }
  }
}

$port = 47832
$out = Join-Path $LogDir "preview-$port.out.log"
$err = Join-Path $LogDir "preview-$port.err.log"
Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  throw "Preview port $port is already in use by process $($listener.OwningProcess). Stop it or diagnose the listener before retrying."
}

$process = Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList @("/c", "npm run preview -- --host 127.0.0.1 --port $port --strictPort") `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err `
  -PassThru

Start-Sleep -Seconds 3
$url = "http://127.0.0.1:$port/"

try {
  $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
  if ($response.StatusCode -ne 200) {
    throw "Preview returned HTTP $($response.StatusCode)."
  }
} catch {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  throw "Could not start preview on $url. Check logs under $LogDir. $($_.Exception.Message)"
}

[pscustomobject]@{
  pid = $process.Id
  port = $port
  url = $url
  startedAt = (Get-Date).ToString("s")
} | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
if (-not $NoOpen) {
  Start-Process $url | Out-Null
}
Write-Host $url
