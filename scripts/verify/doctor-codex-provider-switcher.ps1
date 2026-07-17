param(
    [switch]$RequireHead,
    [switch]$PublicRelease
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message)
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Add-Failure "Missing command: $Name"
    }
}

function Assert-Path {
    param([string]$RelativePath)
    $path = Join-Path $projectRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path)) {
        Add-Failure "Missing required path: $RelativePath"
    }
}

Push-Location $projectRoot
try {
    Assert-Command git
    Assert-Command node
    Assert-Command npm

    if ($RequireHead) {
        & git rev-parse --verify HEAD *> $null
        if ($LASTEXITCODE -ne 0) {
            Add-Failure "No verifiable HEAD commit yet."
        }
    }

    $required = @(
        "README.md",
        "LICENSE",
        "CHANGELOG.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        ".gitignore",
        ".gitattributes",
        ".github\pull_request_template.md",
        ".github\workflows\ci.yml",
        "docs\README.md",
        "docs\product-spec.md",
        "docs\release\github-publish-runbook.md",
        "docs\release\release-checklist.md",
        "docs\user\installation.zh.md",
        "docs\user\troubleshooting.zh.md",
        "CodeXProviderSwitcher.cmd",
        "CodeXProviderSwitcher.ps1",
        "scripts\release\build-codex-provider-switcher-release.ps1",
        "scripts\release\verify-local-release-package.ps1",
        "scripts\release\verify-release-upload-assets.ps1",
        "scripts\release\verify-github-release-asset.ps1",
        "scripts\release\publish-github-release-asset.ps1",
        "scripts\release\publish-github-release-from-artifact.ps1",
        "scripts\verify\doctor-codex-provider-switcher.ps1",
        "setup.cmd",
        "setup.ps1",
        "package.json",
        "src-tauri\tauri.conf.json"
    )
    foreach ($item in $required) {
        Assert-Path $item
    }

    $tauriConfigPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
    if (Test-Path -LiteralPath $tauriConfigPath -PathType Leaf) {
        $tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($tauriConfig.productName -ne "CodeX Provider Switcher") {
            Add-Failure "tauri.conf.json productName mismatch."
        }
        if ($tauriConfig.bundle.publisher -ne "CodeX Provider Switcher") {
            Add-Failure "tauri.conf.json bundle.publisher mismatch."
        }
    }

    $packageJsonPath = Join-Path $projectRoot "package.json"
    if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
        $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($packageJson.version)) {
            Add-Failure "package.json version must not be empty."
        }
        if ($tauriConfig -and $tauriConfig.version -ne $packageJson.version) {
            Add-Failure "package.json and tauri.conf.json versions must match."
        }
        $cargoPath = Join-Path $projectRoot "src-tauri\Cargo.toml"
        if (Test-Path -LiteralPath $cargoPath -PathType Leaf) {
            $cargoText = Get-Content -LiteralPath $cargoPath -Raw -Encoding UTF8
            if ($cargoText -notmatch ('(?m)^version\s*=\s*"' + [regex]::Escape($packageJson.version) + '"')) {
                Add-Failure "package.json and Cargo.toml versions must match."
            }
        }
    }

    $setupText = Get-Content -LiteralPath (Join-Path $projectRoot "setup.ps1") -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($setupText -match "start-preview\.ps1") {
        Add-Failure "setup.ps1 must not start the UI-only preview path."
    }
    if ($setupText -notmatch "CodeXProviderSwitcher\.ps1") {
        Add-Failure "setup.ps1 must call the real local Web backend launcher."
    }

    $gitignore = Get-Content -LiteralPath (Join-Path $projectRoot ".gitignore") -Raw -Encoding UTF8
    foreach ($ignored in @("AGENTS.md", ".agents/", ".codex/", ".codex-praetor/", "node_modules", "dist", "src-tauri/target", "logs/", "release/", "release-assets/", "archive/", "project_status/", ".codex-provider-switcher/", "auth.json", "profiles.json")) {
        if ($gitignore -notlike "*$ignored*") {
            Add-Failure ".gitignore missing: $ignored"
        }
    }

    if ($PublicRelease) {
        $trackedCandidates = & git ls-files --others --cached --exclude-standard
        $blocked = @($trackedCandidates | Where-Object {
            $_ -like "project_status/*" -or
            $_ -ieq "AGENTS.md" -or
            $_ -like ".agents/*" -or
            $_ -like ".codex/*" -or
            $_ -like ".codex-praetor/*" -or
            $_ -like "logs/*" -or
            $_ -like "release/*" -or
            $_ -like "archive/*" -or
            $_ -like "src-tauri/target/*" -or
            $_ -like "node_modules/*" -or
            $_ -like ".codex-provider-switcher/*"
        })
        if ($blocked.Count -gt 0) {
            Add-Failure "Public release candidates contain blocked paths: $($blocked -join '; ')"
        }

        $secretPatterns = @(
            'ghp_[A-Za-z0-9_]{20,}'
            'github_pat_[A-Za-z0-9_]{20,}'
            'Authorization: Bearer [A-Za-z0-9._-]{20,}'
            'sk-(?!smoke-test)[A-Za-z0-9]{20,}'
        )
        $files = @(& git ls-files --others --cached --exclude-standard)
        foreach ($file in $files) {
            $path = Join-Path $projectRoot $file
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
            $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            foreach ($pattern in $secretPatterns) {
                if ($text -match $pattern) {
                    Add-Failure "Secret-shaped text found: $file"
                }
            }
        }
    }
} finally {
    Pop-Location
}

if ($failures.Count -gt 0) {
    Write-Host "CodeX Provider Switcher doctor failed:" -ForegroundColor Red
    foreach ($failure in $failures) {
        Write-Host " - $failure" -ForegroundColor Red
    }
    exit 1
}

Write-Host "[PASS] CodeX Provider Switcher doctor checks passed." -ForegroundColor Green
