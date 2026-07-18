param()

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

Push-Location $projectRoot
try {
    & npm run preview:start -- --NoOpen
    if ($LASTEXITCODE -ne 0) { throw "Preview startup failed with exit code $LASTEXITCODE." }
    & npm run qa:smoke
    if ($LASTEXITCODE -ne 0) { throw "Preview smoke failed with exit code $LASTEXITCODE." }
} finally {
    & npm run preview:stop
    if ($LASTEXITCODE -ne 0) { throw "Preview shutdown failed with exit code $LASTEXITCODE." }
    Pop-Location
}
