param(
    [string]$InstallRoot = "D:\Software\Signalman AI Candidate",
    [string]$LegacyProfilesPath = "",
    [switch]$Apply,
    [switch]$ExplainOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))

function Assert-MainCandidateSource {
    $branch = (& git -C $projectRoot branch --show-current).Trim()
    if ($branch -ne "main") {
        throw "Local candidate refresh must run from main after merge. Current branch: $branch"
    }
    $changes = @(& git -C $projectRoot status --short)
    if ($changes.Count -gt 0) {
        throw "Local candidate refresh requires a clean main worktree."
    }
}

function Get-SetupPath {
    $bundleRoot = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"
    $matches = @(Get-ChildItem -LiteralPath $bundleRoot -Filter "*.exe" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($matches.Count -eq 0) {
        throw "No NSIS setup was produced: $bundleRoot"
    }
    return $matches[0].FullName
}

function Get-NormalizedPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd("\\")
}

function Stop-CandidateDesktopProcess([string]$ExpectedExe) {
    $expected = Get-NormalizedPath $ExpectedExe
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'codex-provider-switcher.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ExecutablePath -and (Get-NormalizedPath $_.ExecutablePath) -eq $expected
        })
    foreach ($processItem in $processes) {
        Stop-Process -Id $processItem.ProcessId -Force
    }
}

function Remove-CandidateShortcuts([string]$ExpectedExe) {
    $shell = New-Object -ComObject WScript.Shell
    $roots = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop),
        (Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs")
    )
    $expected = Get-NormalizedPath $ExpectedExe
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($shortcut in @(Get-ChildItem -LiteralPath $root -Recurse -Filter "*.lnk" -File -ErrorAction SilentlyContinue)) {
            $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
            if ($target -and (Get-NormalizedPath $target) -eq $expected) {
                Remove-Item -LiteralPath $shortcut.FullName -Force
            }
        }
    }
}

function Remove-CandidateUninstallEntries([string]$ExpectedRoot) {
    $expected = Get-NormalizedPath $ExpectedRoot
    foreach ($registryRoot in @(
        "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
    )) {
        if (-not (Test-Path -LiteralPath $registryRoot -PathType Container)) { continue }
        foreach ($entry in @(Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue)) {
            $properties = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue
            $installLocation = [string]$properties.InstallLocation
            if ($installLocation -and (Get-NormalizedPath $installLocation) -eq $expected) {
                Remove-Item -LiteralPath $entry.PSPath -Recurse -Force
            }
        }
    }
}

$package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$head = (& git -C $projectRoot rev-parse HEAD).Trim()
$currentBranch = (& git -C $projectRoot branch --show-current).Trim()

Write-Host "Local candidate refresh"
Write-Host "Current source: $currentBranch @ $head"
Write-Host "Version: $($package.version)"
Write-Host "Install root: $InstallRoot"
Write-Host "User data remains in the existing compatibility directory."
Write-Host "This is a private acceptance channel, not a GitHub Release or Microsoft Store publication."

if ($ExplainOnly) {
    Write-Host "ExplainOnly: after merge, this command would require clean main, build that desktop package, replace program files, optionally recover legacy profiles, and record candidate-install-state.json."
    exit 0
}

Assert-MainCandidateSource

if (-not $Apply) {
    Write-Host "Dry run: re-run with -Apply after main CI succeeds."
    exit 0
}

Push-Location $projectRoot
$previousReleaseChannel = $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL
try {
    # Only stop the prior candidate executable. Store and GitHub installations must not be touched.
    $candidateExe = Join-Path $InstallRoot "codex-provider-switcher.exe"
    Stop-CandidateDesktopProcess -ExpectedExe $candidateExe

    npm run release:assets
    if ($LASTEXITCODE -ne 0) { throw "Installer asset generation failed." }

    $candidateConfigPath = Join-Path $projectRoot "scripts\qa\tauri-candidate-build.json"
    if (-not (Test-Path -LiteralPath $candidateConfigPath -PathType Leaf)) {
        throw "Candidate build config is missing: $candidateConfigPath"
    }
    $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "candidate"
    npx tauri build --bundles nsis --config $candidateConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Desktop candidate build failed." }

    $setupPath = Get-SetupPath
    New-Item -ItemType Directory -Path (Split-Path -Parent $InstallRoot) -Force | Out-Null
    $installer = Start-Process -FilePath $setupPath -ArgumentList @("/S", "/D=$InstallRoot") -Wait -PassThru
    if ($installer.ExitCode -ne 0) {
        throw "Candidate installer failed with exit code $($installer.ExitCode)."
    }
    $installedExe = Join-Path $InstallRoot "codex-provider-switcher.exe"
    if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
        throw "Candidate installer did not create the expected executable: $installedExe"
    }
    Remove-CandidateShortcuts -ExpectedExe $installedExe
    Remove-CandidateUninstallEntries -ExpectedRoot $InstallRoot

    if ($LegacyProfilesPath) {
        $legacyFullPath = [System.IO.Path]::GetFullPath($LegacyProfilesPath)
        if (-not (Test-Path -LiteralPath $legacyFullPath -PathType Leaf)) {
            throw "Legacy profile file not found: $legacyFullPath"
        }
        cargo run --manifest-path src-tauri\Cargo.toml --bin profile_recovery -- $legacyFullPath
        if ($LASTEXITCODE -ne 0) { throw "Legacy profile recovery failed." }
    }

    $state = [ordered]@{
        channel = "local-candidate"
        version = [string]$package.version
        commit = $head
        installed_at = (Get-Date).ToString("o")
        legacy_profile_recovery = [bool]$LegacyProfilesPath
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot "candidate-install-state.json") -Encoding UTF8
    Write-Host "[PASS] Local candidate refreshed at $InstallRoot"
    Write-Host "[PASS] Candidate-only shortcuts and uninstall entries were removed."
} finally {
    Pop-Location
    $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = $previousReleaseChannel
}
