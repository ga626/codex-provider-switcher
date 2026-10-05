param([Parameter(Mandatory = $true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
# Exact owned paths only; never stop stable installations by process name.
$ownedPaths = @(
    [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'src-tauri\target\release\codex-provider-switcher.exe')),
    [IO.Path]::GetFullPath((Join-Path $ProjectRoot '.codex\runtime\dev-desktop-empty\bin\codex-provider-switcher-empty.exe'))
)
$previousBoards = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $ownedPaths -contains [IO.Path]::GetFullPath($_.ExecutablePath)
})
foreach ($board in $previousBoards) {
    Stop-Process -Id $board.ProcessId -Force -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Id $board.ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $board.ProcessId -ErrorAction SilentlyContinue) {
        throw "Previous development board $($board.ProcessId) has not exited."
    }
    Write-Host "[PASS] Closed previous development board $($board.ProcessId): $($board.ExecutablePath)"
}
