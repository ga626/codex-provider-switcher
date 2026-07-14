param(
    [string]$Version = "0.1.0-alpha",
    [string]$OutputRoot = ".codex-provider-switcher\releases",
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$outputRootPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputRoot))
$releaseName = "CodeXProviderSwitcher-windows-x64-$Version"
$stagePath = Join-Path $outputRootPath $releaseName
$zipPath = Join-Path $outputRootPath "$releaseName.zip"
$sha256Path = Join-Path $outputRootPath "$releaseName.zip.sha256"

function Assert-UnderProject {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $projectFull = [System.IO.Path]::GetFullPath($projectRoot)
    $projectPrefix = $projectFull.TrimEnd("\") + "\"
    if (($full -ne $projectFull) -and (-not $full.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Refusing to operate outside project root: $full"
    }
}

function Test-BlockedReleasePath {
    param([string]$RelativePath)
    $normalized = $RelativePath -replace "/", "\"
    if ($normalized -like ".git\*") { return $true }
    if ($normalized -like ".codex-provider-switcher\*") { return $true }
    if ($normalized -like "node_modules\*") { return $true }
    if ($normalized -like "dist\*") { return $true }
    if ($normalized -like "src-tauri\target\*") { return $true }
    if ($normalized -like "logs\*") { return $true }
    if ($normalized -like "release\*") { return $true }
    if ($normalized -like "archive\*") { return $true }
    if ($normalized -like "project_status\*") { return $true }
    if ($normalized -like ".env*") { return $true }
    if ($normalized -match "(?i)(auth|token|secret)") { return $true }
    if ($normalized -ieq "profiles.json") { return $true }
    if ($normalized -ieq "config.toml") { return $true }
    return $false
}

function Copy-ReleaseItem {
    param([string]$RelativePath)
    $source = Join-Path $projectRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Release item missing: $RelativePath"
    }
    if (Test-Path -LiteralPath $source -PathType Container) {
        Get-ChildItem -LiteralPath $source -Recurse -File -Force | ForEach-Object {
            $sourceRelative = $_.FullName.Substring($projectRoot.Length).TrimStart("\")
            if (Test-BlockedReleasePath -RelativePath $sourceRelative) { return }
            $target = Join-Path $stagePath $sourceRelative
            $targetParent = Split-Path -Parent $target
            New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force
        }
    } else {
        if (Test-BlockedReleasePath -RelativePath $RelativePath) { return }
        $target = Join-Path $stagePath $RelativePath
        $targetParent = Split-Path -Parent $target
        New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

function Assert-CmdFileUsesCrlf {
    param([string]$Path, [string]$Label)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $lfCount = 0
    $crlfCount = 0
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        if ($bytes[$i] -eq 10) {
            $lfCount += 1
            if ($i -gt 0 -and $bytes[$i - 1] -eq 13) {
                $crlfCount += 1
            }
        }
    }
    if ($lfCount -eq 0 -or $lfCount -ne $crlfCount) {
        throw "$Label must use CRLF line endings so cmd.exe can run it after download."
    }
}

function Assert-PublicReleaseTree {
    param([string]$Root)
    $blocked = New-Object System.Collections.Generic.List[string]
    $secretHits = New-Object System.Collections.Generic.List[string]
    $secretPatterns = @(
        'ghp_[A-Za-z0-9_]{20,}'
        'github_pat_[A-Za-z0-9_]{20,}'
        'Authorization: Bearer [A-Za-z0-9._-]{20,}'
        'sk-(?!smoke-test)[A-Za-z0-9]{20,}'
    )

    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart("\")
        if (Test-BlockedReleasePath -RelativePath $relative) {
            $blocked.Add($relative)
        }
        $text = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        foreach ($pattern in $secretPatterns) {
            if ($text -match $pattern) {
                $secretHits.Add("$relative :: secret-shaped text")
            }
        }
    }

    if ($blocked.Count -gt 0) {
        throw "Release package contains blocked paths: $($blocked -join '; ')"
    }
    if ($secretHits.Count -gt 0) {
        throw "Release package contains secret-shaped text: $($secretHits -join '; ')"
    }
}

$include = @(
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "AGENTS.md",
    "setup.cmd",
    "setup.ps1",
    "package.json",
    "package-lock.json",
    "index.html",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
    ".gitignore",
    ".gitattributes",
    ".github",
    "docs",
    "public",
    "scripts",
    "src",
    "src-tauri"
)

Write-Host "CodeX Provider Switcher release package plan"
Write-Host "Version: $Version"
Write-Host "Stage:   $stagePath"
Write-Host "Zip:     $zipPath"
Write-Host "SHA256:  $sha256Path"
Write-Host "Mode:    $(if ($Apply) { 'apply' } else { 'dry-run' })"

foreach ($item in $include) {
    $path = Join-Path $projectRoot $item
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required release input missing: $item"
    }
}

if (-not $Apply) {
    Write-Host ""
    Write-Host "Dry run only. Re-run with -Apply to create the release zip."
    exit 0
}

Push-Location $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed."
    }
} finally {
    Pop-Location
}

Assert-UnderProject -Path $outputRootPath
Assert-UnderProject -Path $stagePath
Assert-UnderProject -Path $zipPath

New-Item -ItemType Directory -Path $outputRootPath -Force | Out-Null
if (Test-Path -LiteralPath $stagePath) {
    Remove-Item -LiteralPath $stagePath -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
if (Test-Path -LiteralPath $sha256Path) {
    Remove-Item -LiteralPath $sha256Path -Force
}

New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
foreach ($item in $include) {
    Copy-ReleaseItem -RelativePath $item
}

Assert-CmdFileUsesCrlf -Path (Join-Path $stagePath "setup.cmd") -Label "setup.cmd"
Assert-PublicReleaseTree -Root $stagePath

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagePath, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $releaseName.zip" | Set-Content -LiteralPath $sha256Path -Encoding UTF8

Write-Host "[PASS] Release zip created: $zipPath"
Write-Host "[PASS] SHA256: $hash"
