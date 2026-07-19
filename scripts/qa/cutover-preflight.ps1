param(
    [string]$InstallRoot = "D:\Software\CodeX Provider Switcher",
    [string]$LegacyRoot = "D:\AI Studio\CodeX\Codex Switcher",
    [string]$CodexRoot = (Join-Path $env:USERPROFILE ".codex"),
    [switch]$ExplainOnly
)

$ErrorActionPreference = "Stop"

function Test-ListeningPort([int]$Port) {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    return $connections.Count -gt 0
}

function Get-LegacyStartupEntries([string]$LegacyPath) {
    foreach ($registryPath in @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    )) {
        if (-not (Test-Path -LiteralPath $registryPath)) { continue }
        $properties = Get-ItemProperty -LiteralPath $registryPath
        foreach ($property in $properties.PSObject.Properties) {
            if ($property.Name -match '^PS' -or $null -eq $property.Value) { continue }
            if ([string]$property.Value -like "*$LegacyPath*") {
                Write-Output ("{0}::{1}" -f $registryPath, $property.Name)
            }
        }
    }
}

function Get-ExecutableSummary([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{
            Present = $false
            Version = ""
            Signature = "Missing"
        }
    }

    $item = Get-Item -LiteralPath $Path
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return [pscustomobject]@{
        Present = $true
        Version = [string]$item.VersionInfo.ProductVersion
        Signature = [string]$signature.Status
    }
}

function Test-CodexInvariant([string]$ConfigText, [string]$Pattern) {
    return $ConfigText -match $Pattern
}

if ($ExplainOnly) {
    Write-Host "ExplainOnly: this read-only check does not stop applications, change Codex configuration, open auth.json, or print credentials."
    Write-Host "It reports installation readiness, the legacy process/port, and legacy startup locations for the post-release cutover session."
    exit 0
}

$legacyExe = Join-Path $LegacyRoot "CodeX-Switcher.exe"
$newExe = Join-Path $InstallRoot "codex-provider-switcher.exe"
$newInstall = Get-ExecutableSummary -Path $newExe
$legacyInstall = Get-ExecutableSummary -Path $legacyExe
$legacyProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'CodeX-Switcher.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $legacyExe })
$startupEntries = @(Get-LegacyStartupEntries -LegacyPath $LegacyRoot)
$startupFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$startupShortcuts = @()
if (Test-Path -LiteralPath $startupFolder) {
    $startupShortcuts = @(Get-ChildItem -LiteralPath $startupFolder -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*CodeX*Switcher*" } |
        ForEach-Object { $_.Name })
}
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.Actions | Where-Object { $_.Execute -like "*$LegacyRoot*" -or $_.Arguments -like "*$LegacyRoot*" }
} | ForEach-Object { $_.TaskName })
$services = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
    $_.PathName -like "*$LegacyRoot*"
} | ForEach-Object { $_.Name })
$legacyProcessDetails = @($legacyProcesses | ForEach-Object {
    $started = if ($_.CreationDate -is [datetime]) {
        [datetime]$_.CreationDate
    } elseif ($_.CreationDate) {
        [Management.ManagementDateTimeConverter]::ToDateTime([string]$_.CreationDate)
    } else {
        $null
    }
    [pscustomobject]@{
        ProcessId = $_.ProcessId
        StartedAt = if ($started) { $started.ToString("s") } else { "unknown" }
        AgeHours = if ($started) { [Math]::Round(((Get-Date) - $started).TotalHours, 1) } else { $null }
    }
})
$listeningOwners = @(Get-NetTCPConnection -State Listen -LocalPort 47831 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
$configPath = Join-Path $CodexRoot "config.toml"
$configText = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
} else {
    ""
}
$appDataRoot = Join-Path $env:LOCALAPPDATA "CodeX Provider Switcher"
$backupRoot = Join-Path $appDataRoot "backups"

Write-Host "Cutover preflight (read-only)"
Write-Host "New installation: $(if ($newInstall.Present) { 'ready' } else { 'missing' })"
Write-Host "New installation version: $(if ($newInstall.Version) { $newInstall.Version } else { 'unknown' })"
Write-Host "New installation signature: $($newInstall.Signature)"
Write-Host "Legacy executable: $(if ($legacyInstall.Present) { 'present' } else { 'missing' })"
Write-Host "Legacy process: $(if ($legacyProcesses.Count -gt 0) { 'running' } else { 'not running' })"
if ($legacyProcessDetails.Count -gt 0) {
    Write-Host "Legacy process details: $((@($legacyProcessDetails | ForEach-Object { "PID $($_.ProcessId), started $($_.StartedAt), age $($_.AgeHours)h" }) -join '; '))"
}
Write-Host "Legacy port 47831: $(if (Test-ListeningPort 47831) { 'listening' } else { 'not listening' })"
Write-Host "Legacy port owners: $(if ($listeningOwners.Count -gt 0) { $listeningOwners -join ', ' } else { 'none' })"
Write-Host "Run/RunOnce entries: $($startupEntries.Count)"
if ($startupEntries.Count -gt 0) {
    Write-Host "Run/RunOnce locations: $($startupEntries -join ', ')"
}
Write-Host "Startup folder entries: $($startupShortcuts.Count)"
Write-Host "Scheduled task entries: $($tasks.Count)"
Write-Host "Windows service entries: $($services.Count)"
Write-Host "Codex config present: $(if ($configText) { 'yes' } else { 'no' })"
Write-Host "Codex invariant model_provider=custom: $(if (Test-CodexInvariant $configText '(?m)^model_provider\s*=\s*"custom"\s*$') { 'yes' } else { 'no' })"
Write-Host "Codex invariant Responses wire API: $(if (Test-CodexInvariant $configText '(?m)^wire_api\s*=\s*"responses"\s*$') { 'yes' } else { 'no' })"
Write-Host "Codex invariant response storage disabled: $(if (Test-CodexInvariant $configText '(?m)^disable_response_storage\s*=\s*true\s*$') { 'yes' } else { 'no' })"
Write-Host "New-tool data root: $(if (Test-Path -LiteralPath $appDataRoot -PathType Container) { 'present' } else { 'missing' })"
Write-Host "New-tool backup root: $(if (Test-Path -LiteralPath $backupRoot -PathType Container) { 'present' } else { 'missing' })"
Write-Host "Next action: do not stop the legacy tool in this session. Use these facts in a new post-release Codex session only after installed-app, update, backup, and provider acceptance pass."
