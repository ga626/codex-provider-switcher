param(
    [string]$OutputRoot = "release-assets\store-listing"
)

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$outputPath = Join-Path $projectRoot $OutputRoot
$package = Get-Content -Raw -LiteralPath (Join-Path $projectRoot "package.json") | ConvertFrom-Json

Push-Location $projectRoot
try {
    $previousMockFlag = $env:VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK
    $env:VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK = "true"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }

    npm run preview:start -- --NoOpen --NoBuild
    if ($LASTEXITCODE -ne 0) { throw "Preview did not start." }
    $env:STORE_LISTING_OUTPUT_DIR = $outputPath
    $env:STORE_LISTING_VERSION = [string]$package.version
    node scripts/release/capture-store-listing-assets.mjs
    if ($LASTEXITCODE -ne 0) { throw "Store listing screenshot capture failed." }
}
finally {
    npm run preview:stop
    if ($null -eq $previousMockFlag) {
        Remove-Item Env:\VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK -ErrorAction SilentlyContinue
    } else {
        $env:VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK = $previousMockFlag
    }
    Remove-Item Env:\STORE_LISTING_OUTPUT_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\STORE_LISTING_VERSION -ErrorAction SilentlyContinue
    Pop-Location
}
