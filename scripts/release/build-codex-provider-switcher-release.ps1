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
$backendExe = Join-Path $projectRoot "src-tauri\target\release\local_backend.exe"
$distRoot = Join-Path $projectRoot "dist"

function Assert-UnderProject {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $projectFull = [System.IO.Path]::GetFullPath($projectRoot)
    $projectPrefix = $projectFull.TrimEnd("\") + "\"
    if (($full -ne $projectFull) -and (-not $full.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Refusing to operate outside project root: $full"
    }
}

function Test-BlockedPackagePath {
    param([string]$RelativePath)
    $normalized = $RelativePath -replace "/", "\"
    if ($normalized -like ".git\*") { return $true }
    if ($normalized -like ".github\*") { return $true }
    if ($normalized -like ".codex-provider-switcher\*") { return $true }
    if ($normalized -like "node_modules\*") { return $true }
    if ($normalized -like "src\*") { return $true }
    if ($normalized -like "src-tauri\*") { return $true }
    if ($normalized -like "scripts\*") { return $true }
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

function Copy-FileToPackage {
    param([string]$Source, [string]$DestinationRelativePath)
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Release input missing: $Source"
    }
    if (Test-BlockedPackagePath -RelativePath $DestinationRelativePath) {
        throw "Release package destination is blocked: $DestinationRelativePath"
    }
    $target = Join-Path $stagePath $DestinationRelativePath
    $targetParent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $target -Force
}

function Copy-DirectoryToPackage {
    param([string]$SourceRoot, [string]$DestinationRelativeRoot)
    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        throw "Release input directory missing: $SourceRoot"
    }
    Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force | ForEach-Object {
        $relative = $_.FullName.Substring($SourceRoot.Length).TrimStart("\")
        $destinationRelative = Join-Path $DestinationRelativeRoot $relative
        if (Test-BlockedPackagePath -RelativePath $destinationRelative) { return }
        Copy-FileToPackage -Source $_.FullName -DestinationRelativePath $destinationRelative
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

function Test-TextAsset {
    param([string]$Path)
    $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    return @(
        ".cmd",
        ".css",
        ".html",
        ".js",
        ".json",
        ".md",
        ".ps1",
        ".svg",
        ".txt",
        ".xml",
        ".yaml",
        ".yml"
    ) -contains $extension
}

function Get-Sha256Hex {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hashBytes = $sha256.ComputeHash($stream)
            return (($hashBytes | ForEach-Object { $_.ToString("x2") }) -join "")
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Assert-PublicReleaseTree {
    param([string]$Root)
    $blocked = New-Object System.Collections.Generic.List[string]
    $secretHits = New-Object System.Collections.Generic.List[string]
    $localPathHits = New-Object System.Collections.Generic.List[string]
    $secretPatterns = @(
        'ghp_[A-Za-z0-9_]{20,}'
        'github_pat_[A-Za-z0-9_]{20,}'
        'Authorization: Bearer [A-Za-z0-9._-]{20,}'
        'sk-(?!smoke-test)[A-Za-z0-9]{20,}'
    )

    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart("\")
        if (Test-BlockedPackagePath -RelativePath $relative) {
            $blocked.Add($relative)
        }
        if (Test-TextAsset -Path $_.FullName) {
            $text = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($text -match 'D:\\Projects\\|D:\\AI Studio\\|C:\\Users\\ga990\\') {
                $localPathHits.Add("$relative :: local path marker")
            }
            foreach ($pattern in $secretPatterns) {
                if ($text -match $pattern) {
                    $secretHits.Add("$relative :: secret-shaped text")
                }
            }
        }
    }

    foreach ($required in @(
        "CodeXProviderSwitcher.cmd",
        "CodeXProviderSwitcher.ps1",
        "bin\local_backend.exe",
        "dist\index.html",
        "README.md",
        "docs\user\installation.zh.md",
        "docs\release\release-notes-$Version.md"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)) {
            throw "Release package missing required file: $required"
        }
    }

    if ($blocked.Count -gt 0) {
        throw "Release package contains blocked paths: $($blocked -join '; ')"
    }
    if ($secretHits.Count -gt 0) {
        throw "Release package contains secret-shaped text: $($secretHits -join '; ')"
    }
    if ($localPathHits.Count -gt 0) {
        throw "Release package contains local path markers: $($localPathHits -join '; ')"
    }
}

Write-Host "CodeX Provider Switcher release package plan"
Write-Host "Version: $Version"
Write-Host "Stage:   $stagePath"
Write-Host "Zip:     $zipPath"
Write-Host "SHA256:  $sha256Path"
Write-Host "Mode:    $(if ($Apply) { 'apply' } else { 'dry-run' })"
Write-Host "Package: launcher + local_backend.exe + dist/ + public docs"

foreach ($item in @(
    "CodeXProviderSwitcher.cmd",
    "CodeXProviderSwitcher.ps1",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "docs\user\installation.zh.md",
    "docs\user\troubleshooting.zh.md",
    "docs\release\release-checklist.md",
    "docs\release\release-notes-$Version.md"
)) {
    $path = Join-Path $projectRoot $item
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required release input missing: $item"
    }
}

if (-not $Apply) {
    Write-Host ""
    Write-Host "Dry run only. Re-run with -Apply to create the runnable release zip."
    exit 0
}

Push-Location $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed."
    }
    cargo build --manifest-path src-tauri/Cargo.toml --release --bin local_backend
    if ($LASTEXITCODE -ne 0) {
        throw "release local_backend build failed."
    }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath (Join-Path $distRoot "index.html") -PathType Leaf)) {
    throw "Frontend dist/index.html missing after build."
}
if (-not (Test-Path -LiteralPath $backendExe -PathType Leaf)) {
    throw "local_backend.exe missing after build."
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
Copy-FileToPackage -Source (Join-Path $projectRoot "CodeXProviderSwitcher.cmd") -DestinationRelativePath "CodeXProviderSwitcher.cmd"
Copy-FileToPackage -Source (Join-Path $projectRoot "CodeXProviderSwitcher.ps1") -DestinationRelativePath "CodeXProviderSwitcher.ps1"
Copy-FileToPackage -Source $backendExe -DestinationRelativePath "bin\local_backend.exe"
Copy-DirectoryToPackage -SourceRoot $distRoot -DestinationRelativeRoot "dist"

foreach ($item in @("README.md", "LICENSE", "CHANGELOG.md")) {
    Copy-FileToPackage -Source (Join-Path $projectRoot $item) -DestinationRelativePath $item
}
foreach ($item in @(
    "docs\user\installation.zh.md",
    "docs\user\troubleshooting.zh.md",
    "docs\release\release-checklist.md",
    "docs\release\release-notes-$Version.md"
)) {
    Copy-FileToPackage -Source (Join-Path $projectRoot $item) -DestinationRelativePath $item
}

Assert-CmdFileUsesCrlf -Path (Join-Path $stagePath "CodeXProviderSwitcher.cmd") -Label "CodeXProviderSwitcher.cmd"
Assert-PublicReleaseTree -Root $stagePath

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagePath, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$hash = Get-Sha256Hex -Path $zipPath
"$hash  $releaseName.zip" | Set-Content -LiteralPath $sha256Path -Encoding UTF8

Write-Host "[PASS] Release zip created: $zipPath"
Write-Host "[PASS] SHA256: $hash"
