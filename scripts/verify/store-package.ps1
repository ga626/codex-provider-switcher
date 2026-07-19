param(
    [string]$Version = "",
    [string]$PackagePath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$manifest = Join-Path $projectRoot "src-tauri\store\Package.appxmanifest"
$requiredIdentity = @{
    Name = 'ga626.CodexProviderSwitcher'
    Publisher = 'CN=BEB8480D-C799-44F0-9DC1-533C67423D9E'
    PublisherDisplayName = 'ga626'
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = [string]$package.version
}

[xml]$xml = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace('f', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
$identity = $xml.SelectSingleNode('/f:Package/f:Identity', $ns)
$properties = $xml.SelectSingleNode('/f:Package/f:Properties', $ns)
if ($identity.Name -ne $requiredIdentity.Name) { throw "Store identity name is incorrect: $($identity.Name)" }
if ($identity.Publisher -ne $requiredIdentity.Publisher) { throw "Store publisher is incorrect: $($identity.Publisher)" }
if ($properties.PublisherDisplayName -ne $requiredIdentity.PublisherDisplayName) { throw "Store publisher display name is incorrect: $($properties.PublisherDisplayName)" }
if ($identity.Version -ne '__MSIX_VERSION__') { throw "Store manifest version must be supplied only by the build script." }

$dryRun = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'scripts\release\build-store-msix.ps1') -Version $Version 2>&1
if ($LASTEXITCODE -ne 0) { throw "Store version mapping failed: $($dryRun | Out-String)" }
$dryRunText = $dryRun | Out-String
if ($dryRunText -notmatch 'Store package MSIX version: \d+\.\d+\.\d+\.\d+') { throw 'Store version mapping did not report a four-part MSIX version.' }

if (-not [string]::IsNullOrWhiteSpace($PackagePath)) {
    $fullPackagePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $PackagePath))
    if (-not (Test-Path -LiteralPath $fullPackagePath -PathType Leaf)) { throw "MSIX package is missing: $fullPackagePath" }
    $expectedName = "CodeXProviderSwitcher-windows-x64-$Version.msix"
    if ((Split-Path -Leaf $fullPackagePath) -ne $expectedName) { throw "Unexpected MSIX package name: $(Split-Path -Leaf $fullPackagePath)" }
}

Write-Host "[PASS] Microsoft Store manifest identity matches Partner Center."
Write-Host "[PASS] Product version $Version maps to a four-part MSIX version."
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
    Write-Host "[INFO] No MSIX file was supplied; manifest and version mapping only were checked."
}
