# Start an isolated QA process through Windows Task Scheduler. A process started
# by the scheduler is not attached to the Codex app's Windows Job Object.

function Start-SignalmanScheduledProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [hashtable]$Environment = @{},
        [string]$StdoutPath,
        [string]$StderrPath
    )

    $runtimeDir = Join-Path $WorkingDirectory ".codex\runtime\scheduled-launchers"
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    $id = [Guid]::NewGuid().ToString("N")
    $launcher = Join-Path $runtimeDir "$id.cmd"
    $task = "Signalman-QA-$id"
    $quote = '"'
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('@echo off')
    $lines.Add('setlocal')
    $lines.Add("cd /d $quote$WorkingDirectory$quote")
    foreach ($item in $Environment.GetEnumerator()) {
        $value = ([string]$item.Value).Replace('%', '%%').Replace('"', '\"')
        $lines.Add("set $quote$($item.Key)=$value$quote")
    }
    $quotedFile = "$quote$FilePath$quote"
    $arguments = @($ArgumentList | ForEach-Object {
        $value = [string]$_
        if ($value -match '[\s"]') { "$quote$($value.Replace('"', '\"'))$quote" } else { $value }
    })
    $command = if ($arguments.Count -eq 0) { $quotedFile } else { "$quotedFile $($arguments -join ' ')" }
    $stdoutRedirect = if ($StdoutPath) { " 1>$quote$StdoutPath$quote" } else { "" }
    $stderrRedirect = if ($StderrPath) { " 2>$quote$StderrPath$quote" } else { "" }
    $lines.Add("start $quote$quote /b $command$stdoutRedirect$stderrRedirect")
    $lines.Add('exit /b 0')
    [System.IO.File]::WriteAllLines($launcher, $lines, (New-Object System.Text.UTF8Encoding($false)))

    $startTime = (Get-Date).AddMinutes(1).ToString('HH:mm')
    try {
        & schtasks.exe /Create /TN $task /TR "$quote$launcher$quote" /SC ONCE /ST $startTime /F /RL LIMITED /RU $env:USERNAME | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Unable to register the isolated QA scheduled launch." }
        & schtasks.exe /Run /TN $task | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Unable to run the isolated QA scheduled launch." }
        return [pscustomobject]@{ Task = $task; Launcher = $launcher }
    } finally {
        Start-Sleep -Seconds 2
        & schtasks.exe /Delete /TN $task /F | Out-Null
        Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
    }
}
