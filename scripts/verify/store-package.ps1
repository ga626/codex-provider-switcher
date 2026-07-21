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

function Get-PackageManifest {
    param([string]$PackagePath)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($PackagePath)
    try {
        $entry = $archive.GetEntry('AppxManifest.xml')
        if ($null -eq $entry) { throw "MSIX does not contain AppxManifest.xml: $PackagePath" }
        $reader = New-Object System.IO.StreamReader($entry.Open())
        try {
            [xml]$packageManifest = $reader.ReadToEnd()
            return $packageManifest
        } finally {
            $reader.Dispose()
        }
    } finally {
        $archive.Dispose()
    }
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
$versionMatch = [regex]::Match($dryRunText, 'Store package MSIX version: (?<version>\d+\.\d+\.\d+\.\d+)')
if (-not $versionMatch.Success) { throw 'Store version mapping did not report a four-part MSIX version.' }
$expectedMsixVersion = $versionMatch.Groups['version'].Value
if ($expectedMsixVersion -notmatch '\.0$') { throw "Microsoft Store requires an MSIX revision of zero: $expectedMsixVersion" }

if (-not [string]::IsNullOrWhiteSpace($PackagePath)) {
    $fullPackagePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $PackagePath))
    if (-not (Test-Path -LiteralPath $fullPackagePath -PathType Leaf)) { throw "MSIX package is missing: $fullPackagePath" }
    $expectedName = "SignalmanAI-windows-x64-$Version.msix"
    if ((Split-Path -Leaf $fullPackagePath) -ne $expectedName) { throw "Unexpected MSIX package name: $(Split-Path -Leaf $fullPackagePath)" }

    [xml]$packageManifest = Get-PackageManifest -PackagePath $fullPackagePath
    $packageNs = New-Object System.Xml.XmlNamespaceManager($packageManifest.NameTable)
    $packageNs.AddNamespace('f', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
    $packageNs.AddNamespace('rescap', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities')
    $packageIdentity = $packageManifest.SelectSingleNode('/f:Package/f:Identity', $packageNs)
    if ($packageIdentity.Name -ne $requiredIdentity.Name) { throw "Packaged MSIX identity name is incorrect: $($packageIdentity.Name)" }
    if ($packageIdentity.Publisher -ne $requiredIdentity.Publisher) { throw "Packaged MSIX publisher is incorrect: $($packageIdentity.Publisher)" }
    if ($packageIdentity.Version -ne $expectedMsixVersion) { throw "Packaged MSIX version is incorrect: $($packageIdentity.Version) != $expectedMsixVersion" }
    if ($packageIdentity.Version -notmatch '\.0$') { throw "Packaged MSIX revision must be zero for Microsoft Store: $($packageIdentity.Version)" }

    $application = $packageManifest.SelectSingleNode('/f:Package/f:Applications/f:Application', $packageNs)
    if ($application.EntryPoint -ne 'Windows.FullTrustApplication') { throw "Packaged MSIX must retain the desktop entry point: $($application.EntryPoint)" }
    $fullTrustCapability = $packageManifest.SelectSingleNode('/f:Package/f:Capabilities/rescap:Capability[@Name="runFullTrust"]', $packageNs)
    if ($null -eq $fullTrustCapability) { throw 'Packaged MSIX is missing the required runFullTrust capability for the desktop runtime.' }
}

Write-Host "[PASS] Microsoft Store manifest identity matches Partner Center."
Write-Host "[PASS] Product version $Version maps to Store MSIX version $expectedMsixVersion with a zero revision."
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
    Write-Host "[INFO] No MSIX file was supplied; manifest and version mapping only were checked."
} else {
    Write-Host '[PASS] Packaged MSIX identity, version, desktop entry point, and runFullTrust declaration match the Store requirements.'
}
