param(
    [string]$Version = "",
    [string]$OutputRoot = "store-assets",
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\.."))
$manifestTemplate = Join-Path $projectRoot "src-tauri\store\Package.appxmanifest"
$iconSource = Join-Path $projectRoot "src-tauri\icons\icon.png"

function ConvertTo-MsixVersion {
    param([string]$SemVer)

    if ($SemVer -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<stage>alpha|beta|rc)(?:\.(?<ordinal>\d+))?)?$') {
        throw "Cannot map product version '$SemVer' to an MSIX version. Use MAJOR.MINOR.PATCH, alpha, beta, or rc."
    }
    $major = [int]$Matches.major
    $minor = [int]$Matches.minor
    $patch = [int]$Matches.patch
    $stage = [string]$Matches.stage
    $ordinal = if ($Matches.ordinal) { [int]$Matches.ordinal } else { 0 }
    if ($ordinal -gt 99) { throw "MSIX prerelease ordinal must be between 0 and 99: $SemVer" }
    $base = switch ($stage) {
        "alpha" { 100 }
        "beta" { 200 }
        "rc" { 300 }
        "" { 500 }
        default { throw "Unsupported MSIX prerelease stage: $stage" }
    }
    foreach ($part in @($major, $minor, $patch, ($base + $ordinal))) {
        if ($part -lt 0 -or $part -gt 65535) { throw "MSIX version part is outside 0..65535: $SemVer" }
    }
    return "$major.$minor.$patch.$($base + $ordinal)"
}

function Get-WinAppCommand {
    $command = Get-Command winapp -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $managedTool = 'D:\Software\DeveloperTools\WinAppCLI\winapp.exe'
    if (Test-Path -LiteralPath $managedTool -PathType Leaf) { return $managedTool }
    throw "WinApp CLI is required. Install it with 'winget install Microsoft.WinAppCLI --source winget' or place winapp.exe at $managedTool."
}

function Assert-VersionSources {
    param([string]$ExpectedVersion)

    $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $tauri = Get-Content -LiteralPath (Join-Path $projectRoot "src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $cargo = Get-Content -LiteralPath (Join-Path $projectRoot "src-tauri\Cargo.toml") -Raw -Encoding UTF8
    if ($package.version -ne $ExpectedVersion -or $tauri.version -ne $ExpectedVersion -or $cargo -notmatch ('(?m)^version\s*=\s*"' + [regex]::Escape($ExpectedVersion) + '"')) {
        throw "package.json, tauri.conf.json, and Cargo.toml must all use version $ExpectedVersion before building the Store package."
    }
}

function Write-StoreAsset {
    param([string]$Source, [string]$Destination, [int]$Width, [int]$Height)

    Add-Type -AssemblyName System.Drawing
    $image = [System.Drawing.Image]::FromFile($Source)
    try {
        $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.DrawImage($image, 0, 0, $Width, $Height)
                $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
            } finally {
                $graphics.Dispose()
            }
        } finally {
            $bitmap.Dispose()
        }
    } finally {
        $image.Dispose()
    }
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = [string]$package.version
}

$msixVersion = ConvertTo-MsixVersion -SemVer $Version
Assert-VersionSources -ExpectedVersion $Version
if (-not (Test-Path -LiteralPath $manifestTemplate -PathType Leaf)) { throw "Store manifest is missing: $manifestTemplate" }
if (-not (Test-Path -LiteralPath $iconSource -PathType Leaf)) { throw "Store icon source is missing: $iconSource" }

$outputRootPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputRoot))
$stagePath = Join-Path $projectRoot ".codex-provider-switcher\store-package\$Version"
$msixPath = Join-Path $outputRootPath "CodeXProviderSwitcher-windows-x64-$Version.msix"

Write-Host "Store package product version: $Version"
Write-Host "Store package MSIX version: $msixVersion"
Write-Host "Store package output: $msixPath"

if (-not $Apply) {
    Write-Host "Dry run: would build the Store-channel desktop executable, stage the manifest and assets, and invoke WinApp CLI."
    exit 0
}

$winapp = Get-WinAppCommand
New-Item -ItemType Directory -Path $outputRootPath -Force | Out-Null
if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
if (Test-Path -LiteralPath $msixPath) { Remove-Item -LiteralPath $msixPath -Force }
New-Item -ItemType Directory -Path $stagePath -Force | Out-Null

$previousChannel = $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL
try {
    $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "store"
    & npx tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Tauri Store-channel build failed with exit code $LASTEXITCODE." }
} finally {
    $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = $previousChannel
}

$desktopExe = Join-Path $projectRoot "src-tauri\target\release\codex-provider-switcher.exe"
if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) { throw "Tauri desktop executable is missing: $desktopExe" }
Copy-Item -LiteralPath $desktopExe -Destination (Join-Path $stagePath "codex-provider-switcher.exe") -Force

$manifestText = Get-Content -LiteralPath $manifestTemplate -Raw -Encoding UTF8
if ($manifestText -notmatch '__MSIX_VERSION__') { throw "Store manifest does not contain the MSIX version placeholder." }
$manifestText.Replace('__MSIX_VERSION__', $msixVersion) | Set-Content -LiteralPath (Join-Path $stagePath "Package.appxmanifest") -Encoding UTF8

$assetsPath = Join-Path $stagePath "Assets"
New-Item -ItemType Directory -Path $assetsPath -Force | Out-Null
Write-StoreAsset -Source $iconSource -Destination (Join-Path $assetsPath "StoreLogo.png") -Width 50 -Height 50
Write-StoreAsset -Source $iconSource -Destination (Join-Path $assetsPath "Square44x44Logo.png") -Width 44 -Height 44
Write-StoreAsset -Source $iconSource -Destination (Join-Path $assetsPath "Square150x150Logo.png") -Width 150 -Height 150
Write-StoreAsset -Source $iconSource -Destination (Join-Path $assetsPath "Wide310x150Logo.png") -Width 310 -Height 150

Push-Location $stagePath
try {
    & $winapp pack .
    if ($LASTEXITCODE -ne 0) { throw "WinApp CLI packaging failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

$packages = @(Get-ChildItem -LiteralPath $stagePath -Recurse -File -Filter "*.msix")
if ($packages.Count -ne 1) { throw "Expected exactly one MSIX in the staging directory, found $($packages.Count)." }
Copy-Item -LiteralPath $packages[0].FullName -Destination $msixPath -Force
Write-Host "[PASS] Unsigned MSIX is ready for Partner Center upload: $msixPath"
