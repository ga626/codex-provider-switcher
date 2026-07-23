param(
    [string]$Repository = "ga626/codex-provider-switcher",
    [string]$Tag = "",
    [ValidateSet("store", "github", "all")]
    [string]$Channel = "github",
    [switch]$ReportOnly,
    [switch]$SkipRepositorySettings
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$blockers = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Add-Blocker {
    param([string]$Message)
    $blockers.Add($Message)
}

function Add-Warning {
    param([string]$Message)
    $warnings.Add($Message)
}

function Invoke-GhJson {
    param([string[]]$Arguments, [string]$FailureMessage, [switch]$AllowNotFound)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $result = & gh @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        $text = ($result | Out-String).Trim()
        if ($AllowNotFound -and $text -match "404|Not Found") {
            return $null
        }
        Add-Blocker "$FailureMessage $text"
        return $null
    }
    try {
        return (($result | Out-String) | ConvertFrom-Json)
    } catch {
        Add-Blocker "$FailureMessage Returned invalid JSON."
        return $null
    }
}

Push-Location $projectRoot
try {
    foreach ($command in @("git", "gh")) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            Add-Blocker "Required command is missing: $command"
        }
    }
    if ($blockers.Count -gt 0) { throw "Required commands are unavailable." }

    $packagePath = Join-Path $projectRoot "package.json"
    $tauriPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
    $cargoPath = Join-Path $projectRoot "src-tauri\Cargo.toml"
    $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $tauri = Get-Content -LiteralPath $tauriPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $cargoText = Get-Content -LiteralPath $cargoPath -Raw -Encoding UTF8
    $version = [string]$package.version
    if ([string]::IsNullOrWhiteSpace($version)) {
        Add-Blocker "package.json version is empty."
    }
    if ($tauri.version -ne $version) {
        Add-Blocker "package.json and tauri.conf.json versions do not match."
    }
    if ($cargoText -notmatch ('(?m)^version\s*=\s*"' + [regex]::Escape($version) + '"')) {
        Add-Blocker "package.json and Cargo.toml versions do not match."
    }
    if ([string]::IsNullOrWhiteSpace($Tag)) {
        $Tag = "v$version"
    }
    if ($Tag -ne "v$version") {
        Add-Blocker "Requested tag $Tag does not match version $version."
    }

    $status = @(& git status --short)
    if (-not $ReportOnly -and $status.Count -gt 0) {
        Add-Blocker "Working tree is not clean for a formal release."
    }

    $repo = Invoke-GhJson -Arguments @("api", "repos/$Repository") -FailureMessage "Unable to read GitHub repository state."
    if ($repo -and $repo.archived) {
        Add-Blocker "GitHub repository is archived."
    }

    if ($Channel -in @("github", "all")) {
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $secretLines = & gh secret list --repo $Repository 2>&1
            $secretExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($secretExitCode -ne 0) {
            Add-Blocker "Unable to list GitHub Secret names. $(($secretLines | Out-String).Trim())"
        } else {
            $secretNames = @()
            foreach ($line in $secretLines) {
                $parts = ([string]$line -split "\s+")
                if ($parts.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($parts[0])) {
                    $secretNames += $parts[0]
                }
            }
            foreach ($requiredName in @(
                "TAURI_SIGNING_PRIVATE_KEY",
                "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
            )) {
                if ($requiredName -notin $secretNames) {
                    Add-Blocker "Required GitHub updater-signing Secret name is missing: $requiredName"
                }
            }
        }
    }

    $riskRegisterPath = Join-Path $projectRoot ".github\security-risk-register.json"
    $riskEntries = @()
    if (Test-Path -LiteralPath $riskRegisterPath -PathType Leaf) {
        try {
            $riskEntries = @((Get-Content -LiteralPath $riskRegisterPath -Raw -Encoding UTF8 | ConvertFrom-Json).entries)
        } catch {
            Add-Blocker "Security risk register is not valid JSON."
        }
    }

    $alerts = Invoke-GhJson -Arguments @("api", "repos/$Repository/dependabot/alerts?state=open&per_page=100") -FailureMessage "Unable to read open Dependabot alerts."
    if ($alerts) {
        foreach ($alert in $alerts) {
            $severity = [string]$alert.security_advisory.severity
            $name = [string]$alert.dependency.package.name
            $matchingEntry = @($riskEntries | Where-Object { $_.alert_number -eq $alert.number -and $_.severity -eq $severity } | Select-Object -First 1)
            $hasCurrentException = $false
            if ($matchingEntry.Count -gt 0) {
                $reviewBy = [datetime]$matchingEntry[0].review_by
                if ($reviewBy.Date -ge (Get-Date).Date) {
                    $hasCurrentException = $true
                }
            }
            if ($severity -in @("critical", "high")) {
                Add-Blocker "Open $severity Dependabot alert #$($alert.number): $name."
            } elseif ($severity -eq "medium" -and $hasCurrentException) {
                Add-Warning "Open medium Dependabot alert #$($alert.number): $name is recorded for the Windows release target and must be reviewed by $($matchingEntry[0].review_by)."
            } elseif ($severity -eq "medium") {
                Add-Blocker "Open medium Dependabot alert #$($alert.number): $name has no current release-risk record."
            } else {
                Add-Warning "Open $severity Dependabot alert #$($alert.number) remains for triage."
            }
        }
    }

    if ($Channel -in @("github", "all")) {
        $existingRelease = Invoke-GhJson -Arguments @("api", "repos/$Repository/releases/tags/$Tag") -FailureMessage "Unable to inspect the requested release tag." -AllowNotFound
        if ($existingRelease) {
            Add-Blocker "Release $Tag already exists. Immutable releases must not be overwritten."
        }

        if (-not $SkipRepositorySettings) {
            $immutableSettings = Invoke-GhJson -Arguments @("api", "repos/$Repository/immutable-releases") -FailureMessage "Unable to inspect immutable Release settings."
            if ($immutableSettings -and -not $immutableSettings.enabled) {
                Add-Blocker "GitHub immutable Releases are disabled."
            }
        }
    }

    Write-Host "Signalman AI release readiness"
    Write-Host "Repository: $Repository"
    Write-Host "Version:    $version"
    Write-Host "Tag:        $Tag"
    Write-Host "Channel:    $Channel"
    Write-Host "Mode:       $(if ($ReportOnly) { 'report-only' } else { 'enforced' })"
    if ($warnings.Count -gt 0) {
        Write-Host "Warnings:"
        foreach ($warning in $warnings) { Write-Host " - $warning" -ForegroundColor Yellow }
    }
    if ($blockers.Count -gt 0) {
        Write-Host "Product delivery is blocked:" -ForegroundColor Yellow
        foreach ($blocker in $blockers) { Write-Host " - $blocker" -ForegroundColor Yellow }
        if ($ReportOnly) {
            Write-Host "[REPORT] Code may be merged, but this version is not ready for product delivery." -ForegroundColor Yellow
            exit 0
        }
        exit 1
    }
    Write-Host "[PASS] Release readiness checks passed." -ForegroundColor Green
} finally {
    Pop-Location
}
