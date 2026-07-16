param(
    [string]$Version,
    [string]$ReleaseRoot,
    [switch]$ExplainOnly,
    [switch]$Collect
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if (-not $ReleaseRoot) {
    $ReleaseRoot = Join-Path $projectRoot "release-assets"
}
else {
    if ([System.IO.Path]::IsPathRooted($ReleaseRoot)) {
        $ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
    }
    else {
        $ReleaseRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $ReleaseRoot))
    }
}

if (-not $Version) {
    $packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = [string]$packageJson.version
}

$setupName = "CodeXProviderSwitcher-windows-x64-$Version-setup.exe"
$setupPath = Join-Path $ReleaseRoot $setupName
$setupShaPath = "$setupPath.sha256"
$fallbackZipPath = Join-Path $ReleaseRoot "CodeXProviderSwitcher-windows-x64-$Version.zip"
$fallbackShaPath = "$fallbackZipPath.sha256"

Write-Host "Validation mode: install release"
Write-Host "Meaning: verify the installable release asset. Use this only for installer, release, upgrade, version, startup, or uninstall-path changes."
Write-Host "Expected user-visible result: run setup.exe, start CodeX Provider Switcher from desktop/start menu, see one app window."
Write-Host "Release root: $ReleaseRoot"

if ($ExplainOnly) {
    Write-Host "ExplainOnly: not checking release assets."
    exit 0
}

$required = @($setupPath, $setupShaPath)
$optional = @($fallbackZipPath, $fallbackShaPath)
$missingRequired = @($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })

if ($missingRequired.Count -gt 0) {
    Write-Host "Missing required release assets:"
    $missingRequired | ForEach-Object { Write-Host "  $_" }
    Write-Host "Build them with: npm run release:build -- -Apply"
    exit 2
}

Write-Host "Ready setup:"
Write-Host "  $setupPath"
Write-Host "  $setupShaPath"

$existingOptional = @($optional | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
if ($existingOptional.Count -gt 0) {
    Write-Host "Fallback assets:"
    $existingOptional | ForEach-Object { Write-Host "  $_" }
}

if ($Collect) {
    $qaRoot = Join-Path $projectRoot ".codex-provider-switcher\qa\latest"
    New-Item -ItemType Directory -Force -Path $qaRoot | Out-Null

    $assetsToCopy = @($required + $existingOptional)
    foreach ($asset in $assetsToCopy) {
        Copy-Item -LiteralPath $asset -Destination (Join-Path $qaRoot (Split-Path $asset -Leaf)) -Force
    }

    $readme = @"
# CodeX Provider Switcher install release QA

Version: $Version

Use this folder only for install/release validation.

1. Run $setupName.
2. Start CodeX Provider Switcher from the desktop icon or Start menu.
3. Confirm one desktop app window opens.
4. Confirm no persistent CMD window opens.
5. Confirm no external browser opens.

For normal feature/UI review, use:

````powershell
npm run qa:dev-desktop
````
"@
    Set-Content -LiteralPath (Join-Path $qaRoot "README-QA.md") -Value $readme -Encoding UTF8
    Write-Host "Collected QA assets:"
    Write-Host "  $qaRoot"
}
