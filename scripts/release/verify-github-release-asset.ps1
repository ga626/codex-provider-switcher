param(
    [string]$Version = "0.3.0-alpha",
    [string]$Tag = "",
    [string]$Repository = "ga626/codex-provider-switcher",
    [string]$OutputRoot = "release-assets",
    [switch]$SkipBuild,
    [switch]$RemoteStructureOnly
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
if ([string]::IsNullOrWhiteSpace($Tag)) {
    $Tag = "v$Version"
}

$releaseName = "CodeXProviderSwitcher-windows-x64-$Version"
$outputRootPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputRoot))
$localZip = Join-Path $outputRootPath "$releaseName.zip"
$localSha = Join-Path $outputRootPath "$releaseName.zip.sha256"
$localSetup = Join-Path $outputRootPath "CodeXProviderSwitcher-windows-x64-$Version-setup.exe"
$localSetupSha = "$localSetup.sha256"
$localNotes = Join-Path $projectRoot "docs\release\release-notes-$Version.md"

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command is missing: $Name"
    }
}

function Get-FileSha256Lower {
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

function Read-TextNormalized {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    return ((Get-Content -LiteralPath $Path -Raw -Encoding UTF8) -replace "`r`n", "`n").Trim()
}

Assert-Command gh

if ($RemoteStructureOnly) {
    $SkipBuild = $true
}

if (-not $SkipBuild) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "build-codex-provider-switcher-release.ps1") -Version $Version -OutputRoot $OutputRoot -Apply
    if ($LASTEXITCODE -ne 0) {
        throw "Local release package build failed."
    }
}

if (-not $RemoteStructureOnly) {
    if (-not (Test-Path -LiteralPath $localZip -PathType Leaf)) {
        throw "Local release zip missing: $localZip"
    }
    if (-not (Test-Path -LiteralPath $localSha -PathType Leaf)) {
        throw "Local release SHA256 file missing: $localSha"
    }
    if (-not (Test-Path -LiteralPath $localNotes -PathType Leaf)) {
        throw "Local release notes missing: $localNotes"
    }
    foreach ($localAsset in @($localSetup, $localSetupSha)) {
        if (-not (Test-Path -LiteralPath $localAsset -PathType Leaf)) {
            throw "Local desktop release asset missing: $localAsset"
        }
    }
}

$releaseJson = & gh release view $Tag --repo $Repository --json tagName,isDraft,isPrerelease,assets,body 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Unable to read GitHub Release $Repository@$Tag. Output: $releaseJson"
}
$release = $releaseJson | ConvertFrom-Json
$assetNames = @($release.assets | ForEach-Object { $_.name })
if ($assetNames -notcontains "$releaseName.zip") {
    throw "GitHub Release is missing asset: $releaseName.zip"
}
if ($assetNames -notcontains "$releaseName.zip.sha256") {
    throw "GitHub Release is missing asset: $releaseName.zip.sha256"
}

$desktopAssetNames = @(
    "CodeXProviderSwitcher-windows-x64-$Version-setup.exe",
    "CodeXProviderSwitcher-windows-x64-$Version-setup.exe.sha256"
)
foreach ($assetName in $desktopAssetNames) {
    if ($assetNames -notcontains $assetName) {
        throw "GitHub Release is missing desktop asset: $assetName"
    }
}
$updaterAssetNames = @($assetNames | Where-Object {
    $_ -eq "latest.json" -or $_ -like "*-setup.exe.sig"
})
if ($updaterAssetNames -notcontains "latest.json") {
    throw "GitHub Release is missing signed updater manifest: latest.json"
}
if (-not ($updaterAssetNames | Where-Object { $_ -like "*-setup.exe.sig" })) {
    throw "GitHub Release is missing Windows updater signature (*-setup.exe.sig)."
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-provider-switcher-release-verify-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    & gh release download $Tag --repo $Repository --pattern "$releaseName.zip" --dir $tmp
    if ($LASTEXITCODE -ne 0) { throw "Failed to download remote release zip." }
    & gh release download $Tag --repo $Repository --pattern "$releaseName.zip.sha256" --dir $tmp
    if ($LASTEXITCODE -ne 0) { throw "Failed to download remote release SHA256 file." }

    $remoteZip = Join-Path $tmp "$releaseName.zip"
    $remoteSha = Join-Path $tmp "$releaseName.zip.sha256"
    $remoteZipHash = Get-FileSha256Lower -Path $remoteZip
    if (-not $RemoteStructureOnly) {
        $localZipHash = Get-FileSha256Lower -Path $localZip
        if ($localZipHash -ne $remoteZipHash) {
            throw "Remote release zip is stale or different. Local=$localZipHash Remote=$remoteZipHash"
        }
    }

    $remoteShaText = Read-TextNormalized -Path $remoteSha
    if ($remoteShaText -notlike "$remoteZipHash*") {
        throw "Remote SHA256 file does not match the remote zip hash."
    }

    foreach ($assetName in ($desktopAssetNames | Where-Object { $_ -notlike "*.sha256" })) {
        & gh release download $Tag --repo $Repository --pattern $assetName --dir $tmp
        if ($LASTEXITCODE -ne 0) { throw "Failed to download remote desktop asset: $assetName" }
        & gh release download $Tag --repo $Repository --pattern "$assetName.sha256" --dir $tmp
        if ($LASTEXITCODE -ne 0) { throw "Failed to download remote desktop SHA256: $assetName.sha256" }
        $remoteAsset = Join-Path $tmp $assetName
        $remoteAssetSha = Join-Path $tmp "$assetName.sha256"
        $remoteAssetHash = Get-FileSha256Lower -Path $remoteAsset
        $remoteAssetShaText = Read-TextNormalized -Path $remoteAssetSha
        if ($remoteAssetShaText -notlike "$remoteAssetHash*") {
            throw "Remote desktop SHA256 file does not match asset hash: $assetName"
        }
        if (-not $RemoteStructureOnly) {
            $localAsset = switch -Wildcard ($assetName) {
                "*setup.exe" { $localSetup; break }
            }
            $localAssetHash = Get-FileSha256Lower -Path $localAsset
            if ($localAssetHash -ne $remoteAssetHash) {
                throw "Remote desktop asset is stale or different. Asset=$assetName Local=$localAssetHash Remote=$remoteAssetHash"
            }
        }
    }

    if (-not $RemoteStructureOnly) {
        $localNotesText = Read-TextNormalized -Path $localNotes
        $remoteNotesText = ([string]$release.body -replace "`r`n", "`n").Trim()
        if ($localNotesText -ne $remoteNotesText) {
            throw "GitHub Release notes differ from local release notes: $localNotes"
        }
    }

    $unzip = Join-Path $tmp "unzip"
    Expand-Archive -LiteralPath $remoteZip -DestinationPath $unzip -Force

    $packageRoot = Get-ChildItem -LiteralPath $unzip -Directory | Where-Object { $_.Name -eq $releaseName } | Select-Object -First 1
    if (-not $packageRoot) {
        throw "Remote release zip did not contain expected package directory: $releaseName"
    }

    foreach ($required in @("CodeXProviderSwitcher.cmd", "CodeXProviderSwitcher.ps1", "bin\local_backend.exe", "dist\index.html", "README.md", "docs\user\installation.zh.md")) {
        if (-not (Test-Path -LiteralPath (Join-Path $packageRoot.FullName $required) -PathType Leaf)) {
            throw "Remote release zip is missing: $required"
        }
    }

    if ($RemoteStructureOnly) {
        Write-Host "[PASS] GitHub Release zip was downloaded and unpacked: $remoteZipHash"
    } else {
        Write-Host "[PASS] GitHub Release zip matches the local build: $remoteZipHash"
    }
    Write-Host "[PASS] GitHub Release SHA256 file matches."
    Write-Host "[PASS] Desktop release assets and SHA256 files are present."
    if (-not $RemoteStructureOnly) {
        Write-Host "[PASS] GitHub Release notes match local release notes."
    }
    Write-Host "[PASS] Downloaded remote zip contains the expected startup and user docs."
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
