param(
    [string]$GitHubStableRoot = "D:\Software\Signalman AI",
    [string]$CandidateRoot = "D:\Software\Signalman AI Candidate",
    [string]$LegacyCandidateRoot = "D:\Software\CodeX Provider Switcher",
    [switch]$ExplainOnly
)

$ErrorActionPreference = "Stop"

function Get-InstallSummary([string]$Root) {
    $exe = Join-Path $Root "codex-provider-switcher.exe"
    $state = Join-Path $Root "candidate-install-state.json"
    return [pscustomobject]@{
        Root = $Root
        ExecutablePresent = Test-Path -LiteralPath $exe -PathType Leaf
        CandidateStatePresent = Test-Path -LiteralPath $state -PathType Leaf
    }
}

Write-Host "Local installation migration preflight (read-only)"
Write-Host "GitHub stable root: $GitHubStableRoot"
Write-Host "Candidate root: $CandidateRoot"
Write-Host "Legacy candidate root: $LegacyCandidateRoot"
Write-Host "User data is intentionally outside these roots and is never inspected by this script."

if ($ExplainOnly) {
    Write-Host "ExplainOnly: no installers, shortcuts, registry entries, processes, Codex configuration, or user data are changed."
    exit 0
}

$summary = @(
    Get-InstallSummary -Root $GitHubStableRoot
    Get-InstallSummary -Root $CandidateRoot
    Get-InstallSummary -Root $LegacyCandidateRoot
)
$summary | Format-Table -AutoSize

if ((Get-InstallSummary -Root $GitHubStableRoot).ExecutablePresent) {
    Write-Host "[READY] A GitHub stable installation is present. A later post-release session may clean old candidate-only entries after runtime smoke."
} else {
    Write-Host "[HOLD] No GitHub stable installation is present. Do not clean legacy candidate entries yet."
}
