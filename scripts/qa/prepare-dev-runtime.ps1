param(
    [switch]$Reset
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$runtimeRoot = Join-Path $projectRoot ".codex\runtime\dev-desktop"
$appDataDir = Join-Path $runtimeRoot "app-data"
$codexHome = Join-Path $runtimeRoot "codex-home"
$fixtureRoot = Join-Path $projectRoot "scripts\qa\fixtures\dev-desktop"
$fixtureCatalog = Join-Path $fixtureRoot "profiles.json"
$fixtureActivity = Join-Path $fixtureRoot "activity.json"
$runtimeCatalog = Join-Path $appDataDir "profiles.json"
$runtimeActivity = Join-Path $appDataDir "activity.json"
$fixtureConfig = Join-Path $codexHome "config.toml"
$fixtureAuth = Join-Path $codexHome "auth.json"

foreach ($fixturePath in @($fixtureCatalog, $fixtureActivity)) {
    if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) {
        throw "Development fixture is missing: $fixturePath"
    }
}

$resolvedRuntimeRoot = [System.IO.Path]::GetFullPath($runtimeRoot)
$expectedRuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot ".codex\runtime\dev-desktop"))
if ($resolvedRuntimeRoot -ne $expectedRuntimeRoot) {
    throw "Refusing to use an unexpected development runtime path: $resolvedRuntimeRoot"
}

if ($Reset -and (Test-Path -LiteralPath $resolvedRuntimeRoot -PathType Container)) {
    Remove-Item -LiteralPath $resolvedRuntimeRoot -Recurse -Force
    Write-Host "[PASS] Reset shared isolated development data."
}

New-Item -ItemType Directory -Force -Path $appDataDir, $codexHome | Out-Null
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
if (-not (Test-Path -LiteralPath $fixtureConfig -PathType Leaf)) {
    $developmentConfig = @'
model = "gpt-5.6-terra"
model_provider = "custom"
disable_response_storage = true

[model_providers.custom]
name = "示例服务商 A"
base_url = "https://provider-a.example/v1"
wire_api = "responses"
requires_openai_auth = false

[projects]
[features]
[desktop]
[memories]
[mcp_servers]
[plugins]
[hooks]
[hooks.state]
[marketplaces]
'@
    [System.IO.File]::WriteAllText($fixtureConfig, $developmentConfig, $utf8WithoutBom)
}
if (-not (Test-Path -LiteralPath $fixtureAuth -PathType Leaf)) {
    [System.IO.File]::WriteAllText($fixtureAuth, "{}", $utf8WithoutBom)
}
if (-not (Test-Path -LiteralPath $runtimeCatalog -PathType Leaf)) {
    Copy-Item -LiteralPath $fixtureCatalog -Destination $runtimeCatalog
}
if (-not (Test-Path -LiteralPath $runtimeActivity -PathType Leaf)) {
    Copy-Item -LiteralPath $fixtureActivity -Destination $runtimeActivity
}

[pscustomobject]@{
    ProjectRoot = $projectRoot
    RuntimeRoot = $runtimeRoot
    AppDataDir = $appDataDir
    CodexHome = $codexHome
}
