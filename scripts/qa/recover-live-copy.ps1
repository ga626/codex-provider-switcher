param([switch]$ConfirmRestore)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runtime = Join-Path $project '.codex/runtime/live-validation-v2'
$pointer = Join-Path $runtime 'active.txt'
if (-not (Test-Path -LiteralPath $pointer)) { throw 'No active QA copy. Original data is not changed.' }
$copyId = (Get-Content -LiteralPath $pointer -Raw -Encoding UTF8).Trim()
if ($copyId -notmatch '^[A-Za-z0-9-]{1,160}$') { throw 'Invalid QA copy identity.' }
$copyRoot = [IO.Path]::GetFullPath((Join-Path $runtime "copies/$copyId"))
$exe = Join-Path $project 'src-tauri/target/release/codex-provider-switcher.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Build the development executable first.' }
Write-Host 'This restores ONLY the latest managed provider settings in the active QA copy.'
Write-Host 'Close the live QA window and its Codex terminal first. Original Codex is never restored or overwritten.'
if (-not $ConfirmRestore) { Write-Host 'Preview only. Run again with -ConfirmRestore to proceed.'; exit 0 }
$env:CODEX_PROVIDER_SWITCHER_QA_LIVE_VALIDATION = '1'
$env:CODEX_PROVIDER_SWITCHER_APP_DATA_DIR = Join-Path $copyRoot 'app-data'
$env:CODEX_PROVIDER_SWITCHER_CODEX_HOME = Join-Path $copyRoot 'codex-home'
$process = Start-Process -FilePath $exe -ArgumentList '--qa-emergency-restore' -WorkingDirectory $project -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Recovery stopped (exit $($process.ExitCode)); no success claimed. Use the protected snapshot to rebuild the copy." }
Write-Host 'QA copy recovery completed. Open the QA console to inspect it.'
