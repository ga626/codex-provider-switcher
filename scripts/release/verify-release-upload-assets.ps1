param(
    [string]$Version = "",
    [string]$OutputRoot = "release-assets"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
if ([string]::IsNullOrWhiteSpace($Version)) {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = [string]$package.version
}

$outputRootPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputRoot))
$releaseName = "CodeXProviderSwitcher-windows-x64-$Version"
$setupName = "$releaseName-setup.exe"
$expectedNames = @(
    "$releaseName.zip",
    "$releaseName.zip.sha256",
    $setupName,
    "$setupName.sha256",
    "$setupName.sig",
    "latest.json"
)

function Get-Sha256Hex {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            return (($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "")
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Assert-Sha256Sidecar {
    param(
        [string]$AssetPath,
        [string]$SidecarPath
    )

    if (-not (Test-Path -LiteralPath $SidecarPath -PathType Leaf)) {
        throw "SHA256 sidecar is missing: $SidecarPath"
    }
    $expectedHash = Get-Sha256Hex -Path $AssetPath
    $sidecarText = (Get-Content -LiteralPath $SidecarPath -Raw -Encoding UTF8).Trim()
    if ($sidecarText -notlike "$expectedHash*") {
        throw "SHA256 sidecar does not match asset: $AssetPath"
    }
}

if (-not (Test-Path -LiteralPath $outputRootPath -PathType Container)) {
    throw "Release asset directory is missing: $outputRootPath"
}

foreach ($name in $expectedNames) {
    $path = Join-Path $outputRootPath $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Release upload asset is missing: $path"
    }
}

$actualNames = @(
    Get-ChildItem -LiteralPath $outputRootPath -File |
        Where-Object { $_.Name -eq "latest.json" -or $_.Name -like "$releaseName*" } |
        ForEach-Object { $_.Name }
)
$unexpectedNames = @($actualNames | Where-Object { $_ -notin $expectedNames })
if ($unexpectedNames.Count -gt 0) {
    throw "Release asset directory contains unexpected version-matching files: $($unexpectedNames -join '; ')"
}

$zipPath = Join-Path $outputRootPath "$releaseName.zip"
$setupPath = Join-Path $outputRootPath $setupName
$signaturePath = "$setupPath.sig"
Assert-Sha256Sidecar -AssetPath $zipPath -SidecarPath "$zipPath.sha256"
Assert-Sha256Sidecar -AssetPath $setupPath -SidecarPath "$setupPath.sha256"

$manifestPath = Join-Path $outputRootPath "latest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$manifest.version -ne $Version) {
    throw "Updater manifest version mismatch: $($manifest.version) != $Version"
}
if (-not $manifest.platforms -or -not $manifest.platforms.'windows-x86_64') {
    throw "Updater manifest is missing windows-x86_64 metadata."
}
$platform = $manifest.platforms.'windows-x86_64'
$expectedUrl = "https://github.com/ga626/codex-provider-switcher/releases/download/v$Version/$setupName"
if ([string]$platform.url -ne $expectedUrl) {
    throw "Updater manifest URL mismatch: $($platform.url)"
}
$signature = (Get-Content -LiteralPath $signaturePath -Raw -Encoding UTF8).Trim()
if ([string]$platform.signature -ne $signature) {
    throw "Updater manifest signature does not match $([System.IO.Path]::GetFileName($signaturePath))."
}

Write-Host "[PASS] Release upload asset set is complete for v$Version."
Write-Host "[PASS] SHA256 sidecars and updater manifest match local assets."
