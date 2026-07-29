param(
    [switch]$Apply,
    [switch]$ExplainOnly
)

$ErrorActionPreference = "Stop"

$candidateRoot = "D:\Software\CodeX Provider Switcher"
$stableRoot = "D:\Software\Signalman AI"
$legacyRoot = "D:\AI Studio\CodeX\Codex Switcher"
$candidateExe = Join-Path $candidateRoot "codex-provider-switcher.exe"
$stableExe = Join-Path $stableRoot "codex-provider-switcher.exe"
$legacyExe = Join-Path $legacyRoot "CodeX-Switcher.exe"
$stableDesktopShortcut = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)) "Signalman AI.lnk"

function Get-NormalizedPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ShortcutRoots {
    return @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::StartMenu),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonStartMenu)
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique
}

function Get-ShortcutRecordsForTarget([string]$ExpectedTarget) {
    $shell = New-Object -ComObject WScript.Shell
    $expected = Get-NormalizedPath $ExpectedTarget
    $records = @()

    foreach ($root in Get-ShortcutRoots) {
        foreach ($shortcut in @(Get-ChildItem -LiteralPath $root -Filter "*.lnk" -File -Recurse -ErrorAction Stop)) {
            $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
            if ($target -and (Get-NormalizedPath $target) -eq $expected) {
                $records += [pscustomobject]@{
                    Path = $shortcut.FullName
                    Target = $target
                }
            }
        }
    }

    return @($records)
}

function Get-ShortcutTarget([string]$ShortcutPath) {
    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
        return ""
    }

    $shell = New-Object -ComObject WScript.Shell
    return [string]$shell.CreateShortcut($ShortcutPath).TargetPath
}

function Get-RunEntriesForRoot([string]$ExpectedRoot) {
    $entries = @()
    foreach ($registryPath in @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    )) {
        if (-not (Test-Path -LiteralPath $registryPath)) { continue }
        foreach ($registryProperty in (Get-ItemProperty -LiteralPath $registryPath).PSObject.Properties) {
            if ($registryProperty.Name -match "^PS" -or $null -eq $registryProperty.Value) { continue }
            if ([string]$registryProperty.Value -like "*$ExpectedRoot*") {
                $entries += [pscustomobject]@{
                    Location = $registryPath
                    Name = $registryProperty.Name
                }
            }
        }
    }

    return @($entries)
}

function Get-ScheduledTasksForRoot([string]$ExpectedRoot) {
    return @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
        $_.Actions | Where-Object {
            $_.Execute -like "*$ExpectedRoot*" -or $_.Arguments -like "*$ExpectedRoot*"
        }
    } | ForEach-Object { $_.TaskName })
}

function Get-ServicesForRoot([string]$ExpectedRoot) {
    return @(Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object {
        $_.PathName -like "*$ExpectedRoot*"
    } | ForEach-Object { $_.Name })
}

function Get-ProcessCountForExecutable([string]$ExpectedExe) {
    $expected = Get-NormalizedPath $ExpectedExe
    return @(Get-CimInstance Win32_Process -Filter "Name = 'codex-provider-switcher.exe'" -ErrorAction Stop | Where-Object {
        $_.ExecutablePath -and (Get-NormalizedPath $_.ExecutablePath) -eq $expected
    }).Count
}

function Get-LegacyState {
    $startupFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    $legacyProcessCount = @(Get-CimInstance Win32_Process -Filter "Name = 'CodeX-Switcher.exe'" -ErrorAction Stop | Where-Object {
        $_.ExecutablePath -and (Get-NormalizedPath $_.ExecutablePath) -eq (Get-NormalizedPath $legacyExe)
    }).Count
    $legacyPortListeners = @(Get-NetTCPConnection -State Listen -LocalPort 47831 -ErrorAction SilentlyContinue).Count
    $legacyStartupShortcuts = if (Test-Path -LiteralPath $startupFolder -PathType Container) {
        @(Get-ChildItem -LiteralPath $startupFolder -File -ErrorAction Stop | Where-Object {
            $_.Name -like "*CodeX*Switcher*"
        }).Count
    } else {
        0
    }

    return [pscustomobject]@{
        ExecutablePresent = Test-Path -LiteralPath $legacyExe -PathType Leaf
        ProcessCount = $legacyProcessCount
        Port47831Listeners = $legacyPortListeners
        RunEntryCount = (Get-RunEntriesForRoot -ExpectedRoot $legacyRoot).Count
        StartupShortcutCount = $legacyStartupShortcuts
        ScheduledTaskCount = (Get-ScheduledTasksForRoot -ExpectedRoot $legacyRoot).Count
        ServiceCount = (Get-ServicesForRoot -ExpectedRoot $legacyRoot).Count
    }
}

function Assert-CandidateDirectoryIsSafe {
    if (-not (Test-Path -LiteralPath $candidateRoot -PathType Container)) { return }

    $item = Get-Item -LiteralPath $candidateRoot -Force
    if ((Get-NormalizedPath $item.FullName) -ne (Get-NormalizedPath $candidateRoot)) {
        throw "Candidate path resolution mismatch: $($item.FullName)"
    }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Candidate directory is a reparse point. Refusing recursive removal."
    }
}

function Get-CandidateState {
    return [pscustomobject]@{
        DirectoryPresent = Test-Path -LiteralPath $candidateRoot -PathType Container
        ExecutablePresent = Test-Path -LiteralPath $candidateExe -PathType Leaf
        ProcessCount = Get-ProcessCountForExecutable -ExpectedExe $candidateExe
        ShortcutRecords = @(Get-ShortcutRecordsForTarget -ExpectedTarget $candidateExe)
        RunEntries = @(Get-RunEntriesForRoot -ExpectedRoot $candidateRoot)
        ScheduledTasks = @(Get-ScheduledTasksForRoot -ExpectedRoot $candidateRoot)
        Services = @(Get-ServicesForRoot -ExpectedRoot $candidateRoot)
    }
}

function Assert-StableEntryPoint {
    if (-not (Test-Path -LiteralPath $stableExe -PathType Leaf)) {
        throw "Stable Signalman AI executable is missing: $stableExe"
    }

    $desktopTarget = Get-ShortcutTarget -ShortcutPath $stableDesktopShortcut
    if (-not $desktopTarget -or (Get-NormalizedPath $desktopTarget) -ne (Get-NormalizedPath $stableExe)) {
        throw "Stable desktop shortcut does not point to the GitHub stable executable: $stableDesktopShortcut"
    }
}

function Assert-CandidateStateIsSafe([object]$State) {
    Assert-CandidateDirectoryIsSafe
    if ($State.ProcessCount -gt 0) {
        throw "Candidate executable is running. Close it before cleanup; this script will not stop processes."
    }
    if ($State.RunEntries.Count -gt 0 -or $State.ScheduledTasks.Count -gt 0 -or $State.Services.Count -gt 0) {
        throw "Unexpected candidate startup sources were found. Refusing to modify registry, scheduled tasks, or services automatically."
    }
}

function Write-State([string]$Label, [object]$CandidateState, [object]$LegacyState) {
    Write-Host $Label
    Write-Host "Stable executable: $stableExe"
    Write-Host "Stable desktop target: $(Get-ShortcutTarget -ShortcutPath $stableDesktopShortcut)"
    Write-Host "Candidate directory present: $($CandidateState.DirectoryPresent)"
    Write-Host "Candidate executable present: $($CandidateState.ExecutablePresent)"
    Write-Host "Candidate process count: $($CandidateState.ProcessCount)"
    Write-Host "Candidate shortcut count: $($CandidateState.ShortcutRecords.Count)"
    Write-Host "Candidate Run/RunOnce count: $($CandidateState.RunEntries.Count)"
    Write-Host "Candidate scheduled task count: $($CandidateState.ScheduledTasks.Count)"
    Write-Host "Candidate service count: $($CandidateState.Services.Count)"
    Write-Host "Legacy executable present: $($LegacyState.ExecutablePresent)"
    Write-Host "Legacy process count: $($LegacyState.ProcessCount)"
    Write-Host "Legacy port 47831 listeners: $($LegacyState.Port47831Listeners)"
    Write-Host "Legacy Run/RunOnce count: $($LegacyState.RunEntryCount)"
    Write-Host "Legacy Startup folder count: $($LegacyState.StartupShortcutCount)"
    Write-Host "Legacy scheduled task count: $($LegacyState.ScheduledTaskCount)"
    Write-Host "Legacy service count: $($LegacyState.ServiceCount)"
}

Write-Host "Retire local CodeX Provider Switcher candidate"
Write-Host "Scope: remove only the old candidate directory and shortcuts that target its executable."
Write-Host "Out of scope: Codex configuration, auth.json, user data, Microsoft Store, GitHub stable, and the legacy rollback directory."

if ($ExplainOnly) {
    Write-Host "ExplainOnly: this command only describes the bounded cleanup. It does not inspect or change local state."
    exit 0
}

Assert-StableEntryPoint
$beforeCandidateState = Get-CandidateState
Assert-CandidateStateIsSafe -State $beforeCandidateState
$beforeLegacyState = Get-LegacyState
Write-State -Label "Before cleanup" -CandidateState $beforeCandidateState -LegacyState $beforeLegacyState

if (-not $Apply) {
    Write-Host "Dry run: no changes were made. Re-run from an elevated PowerShell window with -Apply to remove the candidate directory and its matching shortcuts."
    exit 0
}

if (-not (Test-IsAdministrator)) {
    throw "Run this script from an elevated PowerShell window."
}

foreach ($shortcutRecord in $beforeCandidateState.ShortcutRecords) {
    $currentTarget = Get-ShortcutTarget -ShortcutPath $shortcutRecord.Path
    if (-not $currentTarget -or (Get-NormalizedPath $currentTarget) -ne (Get-NormalizedPath $candidateExe)) {
        throw "Shortcut target changed during cleanup. Refusing removal: $($shortcutRecord.Path)"
    }
    Remove-Item -LiteralPath $shortcutRecord.Path -Force -ErrorAction Stop
}

if (Test-Path -LiteralPath $candidateRoot -PathType Container) {
    Assert-CandidateDirectoryIsSafe
    Remove-Item -LiteralPath $candidateRoot -Recurse -Force -ErrorAction Stop
}

Assert-StableEntryPoint
$afterCandidateState = Get-CandidateState
$afterLegacyState = Get-LegacyState
Write-State -Label "After cleanup" -CandidateState $afterCandidateState -LegacyState $afterLegacyState

if ($afterCandidateState.DirectoryPresent -or $afterCandidateState.ShortcutRecords.Count -gt 0) {
    throw "Candidate cleanup verification failed. The candidate directory or a matching shortcut remains."
}
if ($afterCandidateState.RunEntries.Count -gt 0 -or $afterCandidateState.ScheduledTasks.Count -gt 0 -or $afterCandidateState.Services.Count -gt 0) {
    throw "Candidate cleanup verification failed. A candidate startup source remains."
}

Write-Host "[PASS] Old local candidate and its matching shortcuts were removed."
Write-Host "[PASS] Signalman AI stable desktop entry remains intact."
Write-Host "[PASS] Legacy rollback directory was not modified."
