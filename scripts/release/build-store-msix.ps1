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
    # Microsoft Store requires the MSIX revision field to be zero. A prerelease
    # label remains in the product/tag version, while Store uniqueness comes from
    # incrementing major, minor, or patch before each new Store upload.
    foreach ($part in @($major, $minor, $patch, 0)) {
        if ($part -lt 0 -or $part -gt 65535) { throw "MSIX version part is outside 0..65535: $SemVer" }
    }
    return "$major.$minor.$patch.0"
}

function Get-PackageTool {
    $command = Get-Command winapp -ErrorAction SilentlyContinue
    if ($command) { return [pscustomobject]@{ Kind = 'winapp'; Path = $command.Source } }
    $managedTool = 'D:\Software\DeveloperTools\WinAppCLI\winapp.exe'
    if (Test-Path -LiteralPath $managedTool -PathType Leaf) { return [pscustomobject]@{ Kind = 'winapp'; Path = $managedTool } }

    $sdkRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
    if (Test-Path -LiteralPath $sdkRoot -PathType Container) {
        $makeAppx = Get-ChildItem -LiteralPath $sdkRoot -Recurse -File -Filter 'makeappx.exe' |
            Where-Object { $_.FullName -match '\\x64\\makeappx\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($makeAppx) { return [pscustomobject]@{ Kind = 'makeappx'; Path = $makeAppx.FullName } }
    }

    throw "A Store packager is required. Install WinApp CLI at $managedTool or install the Windows SDK MakeAppx tool."
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

$packager = Get-PackageTool
New-Item -ItemType Directory -Path $outputRootPath -Force | Out-Null
if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
if (Test-Path -LiteralPath $msixPath) { Remove-Item -LiteralPath $msixPath -Force }
New-Item -ItemType Directory -Path $stagePath -Force | Out-Null

$previousChannel = $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL
$previousCargoBuildJobs = $env:CARGO_BUILD_JOBS
try {
    $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = "store"
    if ([string]::IsNullOrWhiteSpace($env:CARGO_BUILD_JOBS)) {
        # Tauri release linking can exceed the memory available on a local Windows host.
        # Keep the default deterministic; callers can explicitly override this value.
        $env:CARGO_BUILD_JOBS = "1"
    }
    & npx tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Tauri Store-channel build failed with exit code $LASTEXITCODE." }
} finally {
    $env:CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL = $previousChannel
    $env:CARGO_BUILD_JOBS = $previousCargoBuildJobs
}

$desktopExe = Join-Path $projectRoot "src-tauri\target\release\codex-provider-switcher.exe"
if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) { throw "Tauri desktop executable is missing: $desktopExe" }
Copy-Item -LiteralPath $desktopExe -Destination (Join-Path $stagePath "codex-provider-switcher.exe") -Force

$manifestText = Get-Content -LiteralPath $manifestTemplate -Raw -Encoding UTF8
if ($manifestText -notmatch '__MSIX_VERSION__') { throw "Store manifest does not contain the MSIX version placeholder." }
$manifestFileName = if ($packager.Kind -eq 'makeappx') { 'AppxManifest.xml' } else { 'Package.appxmanifest' }
$manifestText.Replace('__MSIX_VERSION__', $msixVersion) | Set-Content -LiteralPath (Join-Path $stagePath $manifestFileName) -Encoding UTF8

$assetsPath = Join-Path $stagePath "Assets"
New-Item -ItemType Directory -Path $assetsPath -Force | Out-Null
Write-StoreAsset -Source $iconSource -Destination (Join-Path $assetsPath "StoreLogo.png") -Width 50 -Height 50
Write-StoreAsset -Source $iconSource -Destination (Join-Path $assetsPath "Square44x44Logo.png") -Width 44 -Height 44
Write-StoreAsset -Source $iconSource -Destination (Join-Path $assetsPath "Square150x150Logo.png") -Width 150 -Height 150
Write-StoreAsset -Source $iconSource -Destination (Join-Path $assetsPath "Wide310x150Logo.png") -Width 310 -Height 150

if ($packager.Kind -eq 'winapp') {
    Push-Location $stagePath
    try {
        & $packager.Path pack .
        if ($LASTEXITCODE -ne 0) { throw "WinApp CLI packaging failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
} elseif ($packager.Kind -eq 'makeappx') {
    $temporaryPackage = Join-Path $outputRootPath ".CodeXProviderSwitcher-windows-x64-$Version.packaging.msix"
    if (Test-Path -LiteralPath $temporaryPackage) { Remove-Item -LiteralPath $temporaryPackage -Force }
    & $packager.Path pack /d $stagePath /p $temporaryPackage /o
    if ($LASTEXITCODE -ne 0) { throw "Windows SDK MakeAppx packaging failed with exit code $LASTEXITCODE." }
    Copy-Item -LiteralPath $temporaryPackage -Destination $msixPath -Force
    Remove-Item -LiteralPath $temporaryPackage -Force
    Write-Host "[PASS] Used Windows SDK MakeAppx fallback: $($packager.Path)"
    Write-Host "[PASS] Unsigned MSIX is ready for Partner Center upload: $msixPath"
    exit 0
} else {
    throw "Unsupported Store packager: $($packager.Kind)"
}

$packages = @(Get-ChildItem -LiteralPath $stagePath -Recurse -File -Filter "*.msix")
if ($packages.Count -ne 1) { throw "Expected exactly one MSIX in the staging directory, found $($packages.Count)." }
Copy-Item -LiteralPath $packages[0].FullName -Destination $msixPath -Force
Write-Host "[PASS] Unsigned MSIX is ready for Partner Center upload: $msixPath"
