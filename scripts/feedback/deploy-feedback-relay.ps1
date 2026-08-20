[CmdletBinding()]
param(
    [string]$Repository = "ga626/signalman-feedback-inbox",
    [string]$AllowedOrigins = "http://127.0.0.1:47833,http://localhost:47833",
    [switch]$BuildClient
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Wrangler {
    param([string[]]$Arguments)
    & npx --yes wrangler @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Cloudflare Wrangler command failed: wrangler $($Arguments -join ' ')"
    }
}

function Set-WranglerSecret {
    param(
        [string]$Name,
        [string]$Value,
        [switch]$Sensitive
    )

    if ($Sensitive) {
        $secureValue = Read-Host "Enter $Name (input is hidden)" -AsSecureString
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
            $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            $plainValue | & npx --yes wrangler secret put $Name
            if ($LASTEXITCODE -ne 0) { throw "Could not set Cloudflare secret $Name." }
        }
        finally {
            if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
            Remove-Variable plainValue -ErrorAction SilentlyContinue
        }
        return
    }

    $Value | & npx --yes wrangler secret put $Name
    if ($LASTEXITCODE -ne 0) { throw "Could not set Cloudflare secret $Name." }
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$relayRoot = Join-Path $projectRoot "feedback-relay"
$localConfig = Join-Path $relayRoot "wrangler.toml"
$configTemplate = Join-Path $relayRoot "wrangler.toml.example"
$receiptPath = Join-Path $relayRoot ".deployment.local.json"

Push-Location $relayRoot
try {
    Write-Host "Checking Cloudflare login..."
    Invoke-Wrangler @("whoami")

    if (-not (Test-Path -LiteralPath $localConfig -PathType Leaf)) {
        Write-Host "Creating the isolated KV namespace used only for five-minute submission throttling..."
        $created = & npx --yes wrangler kv namespace create RATE_LIMIT 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Could not create the Cloudflare KV namespace." }
        $createdText = [string]::Join("`n", @($created))
        $match = [regex]::Match($createdText, 'id\s*=\s*"(?<id>[^"]+)"')
        if (-not $match.Success) { throw "Wrangler did not return a KV namespace ID. Its output was not written to disk; rerun after checking Cloudflare permissions." }
        $namespaceId = $match.Groups["id"].Value
        $config = Get-Content -LiteralPath $configTemplate -Raw -Encoding UTF8
        $config.Replace("replace-with-your-kv-namespace-id", $namespaceId) | Set-Content -LiteralPath $localConfig -Encoding UTF8
        Write-Host "Created local Worker configuration. It is ignored by Git."
    }
    else {
        Write-Host "Reusing the existing local Worker configuration."
    }

    Write-Host "The next prompt is the GitHub fine-grained token. It is passed directly to Cloudflare and is never written to this project."
    Set-WranglerSecret -Name "GITHUB_TOKEN" -Sensitive
    Set-WranglerSecret -Name "GITHUB_FEEDBACK_REPOSITORY" -Value $Repository
    Set-WranglerSecret -Name "ALLOWED_ORIGINS" -Value $AllowedOrigins

    Write-Host "Deploying the anonymous feedback relay..."
    $deployOutput = & npx --yes wrangler deploy 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare Worker deployment failed." }
    $deployText = [string]::Join("`n", @($deployOutput))
    $urlMatch = [regex]::Match($deployText, 'https://[^\s]+\.workers\.dev')
    if (-not $urlMatch.Success) { throw "Deployment completed but Wrangler did not print a workers.dev URL. Check the Cloudflare dashboard before building the desktop client." }
    $relayUrl = $urlMatch.Value.TrimEnd('.', ',', ')')

    [pscustomobject]@{
        relayUrl = $relayUrl
        repository = $Repository
        deployedAt = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8

    Write-Host "[PASS] Relay deployed: $relayUrl"
    Write-Host "[PASS] Local deployment receipt: $receiptPath"
    if ($BuildClient) {
        Push-Location $projectRoot
        try {
            $env:VITE_FEEDBACK_RELAY_URL = $relayUrl
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "Desktop client build failed after relay deployment." }
            Write-Host "[PASS] Client build now contains the public relay URL."
        }
        finally {
            Remove-Item Env:\VITE_FEEDBACK_RELAY_URL -ErrorAction SilentlyContinue
            Pop-Location
        }
    }
    else {
        Write-Host "Run `npm run feedback:deploy -- -BuildClient` when you are ready to build a candidate containing this relay URL."
    }
}
finally {
    Pop-Location
}
