param(
    [switch]$ExplainOnly
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$packageJson = Join-Path $projectRoot "package.json"

if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
    throw "package.json not found under $projectRoot"
}

Write-Host "Validation mode: dev desktop"
Write-Host "Meaning: launch the current source-tree desktop app. No installer, upgrade, uninstall, or release package is used."
Write-Host "Expected user-visible result: one CodeX Provider Switcher desktop window, no persistent CMD window, no external browser."
Write-Host "Command: npm run tauri:dev"

if ($ExplainOnly) {
    Write-Host "ExplainOnly: not launching the app."
    exit 0
}

Push-Location $projectRoot
try {
    npm run tauri:dev
}
finally {
    Pop-Location
}
