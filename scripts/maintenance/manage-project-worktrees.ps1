[CmdletBinding()]
param(
    [ValidateSet("Audit", "Create", "Retire")]
    [string]$Action = "Audit",
    [string]$Repo = ".",
    [string]$Name,
    [string]$WorktreePath,
    [string]$Branch,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

function Get-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    [System.IO.Path]::GetFullPath($Path)
}

function Test-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $absolutePath = Get-AbsolutePath -Path $Path
    $absoluteRoot = (Get-AbsolutePath -Path $Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $prefix = $absoluteRoot + [System.IO.Path]::DirectorySeparatorChar
    $absolutePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-WorktreeRecords {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $records = @()
    $current = $null
    $lines = & git -C $ProjectRoot worktree list --porcelain
    if ($LASTEXITCODE -ne 0) { throw "Cannot list worktrees for $ProjectRoot" }
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            if ($null -ne $current) { $records += [pscustomobject]$current; $current = $null }
            continue
        }
        $separator = $line.IndexOf(" ")
        $key = if ($separator -lt 0) { $line } else { $line.Substring(0, $separator) }
        $value = if ($separator -lt 0) { "" } else { $line.Substring($separator + 1) }
        if ($key -eq "worktree") {
            $current = [ordered]@{ Path = Get-AbsolutePath -Path $value; Head = ""; Branch = ""; Detached = $false; Locked = $false }
            continue
        }
        if ($null -eq $current) { continue }
        if ($key -eq "HEAD") { $current.Head = $value }
        if ($key -eq "branch") { $current.Branch = $value }
        if ($key -eq "detached") { $current.Detached = $true }
        if ($key -eq "locked") { $current.Locked = $true }
    }
    if ($null -ne $current) { $records += [pscustomobject]$current }
    $records
}

$invocationRoot = (& git -C $Repo rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($invocationRoot)) { throw "Repo is not a Git worktree: $Repo" }
$records = @(Get-WorktreeRecords -ProjectRoot $invocationRoot)
if ($records.Count -eq 0) { throw "No worktree records found for $invocationRoot" }
$projectRoot = $records[0].Path
$managedRoot = Join-Path $projectRoot ".codex\worktrees"
$praetorRoot = Join-Path $projectRoot ".codex-praetor\worktrees"

if ($Action -eq "Audit") {
    $result = foreach ($record in $records) {
        $kind = if ($record.Path -eq $projectRoot) { "main" } elseif (Test-ChildPath -Path $record.Path -Root $managedRoot) { "managed" } elseif (Test-ChildPath -Path $record.Path -Root $praetorRoot) { "praetor" } else { "outside_allowed_roots" }
        [pscustomobject]@{ path = $record.Path; head = $record.Head; branch = $record.Branch; detached = $record.Detached; locked = $record.Locked; kind = $kind }
    }
    $result | ConvertTo-Json -Depth 3
    $outsideRecords = @()
    foreach ($record in $result) { if ($record.kind -eq "outside_allowed_roots") { $outsideRecords += $record } }
    if ($outsideRecords.Count -gt 0) { throw "Found worktrees outside allowed roots." }
    exit 0
}

if ($Action -eq "Create") {
    if ([string]::IsNullOrWhiteSpace($Name) -or $Name -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') { throw "Name must match ^[a-z0-9][a-z0-9-]{0,63}$" }
    $target = Join-Path $managedRoot $Name
    if (-not (Test-ChildPath -Path $target -Root $managedRoot)) { throw "Refusing worktree path outside managed root: $target" }
    if (Test-Path -LiteralPath $target) { throw "Worktree path already exists: $target" }
    $branchName = if ([string]::IsNullOrWhiteSpace($Branch)) { "codex/$Name" } else { $Branch }
    if ($branchName -notmatch '^codex/[a-z0-9][a-z0-9-]{0,63}$') { throw "Branch must match codex/<safe-name>." }
    if (git -C $projectRoot show-ref --verify --quiet "refs/heads/$branchName") { throw "Branch already exists: $branchName" }
    $plan = [pscustomobject]@{ action = "create"; path = $target; branch = $branchName; base = "origin/main"; apply = [bool]$Apply }
    $plan | ConvertTo-Json -Depth 3
    if (-not $Apply) { exit 0 }
    New-Item -ItemType Directory -Path $managedRoot -Force | Out-Null
    & git -C $projectRoot worktree add -b $branchName $target origin/main
    if ($LASTEXITCODE -ne 0) { throw "git worktree add failed: $target" }
    exit 0
}

if ([string]::IsNullOrWhiteSpace($WorktreePath)) { throw "WorktreePath is required for Retire." }
$targetPath = Get-AbsolutePath -Path $WorktreePath
if (-not (Test-ChildPath -Path $targetPath -Root $managedRoot)) { throw "Only managed project worktrees can be retired: $targetPath" }
$targetRecord = @($records | Where-Object { $_.Path -eq $targetPath })
if ($targetRecord.Count -ne 1) { throw "Worktree is not registered: $targetPath" }
if ($targetRecord[0].Locked) { throw "Worktree is locked: $targetPath" }
$status = & git -C $targetPath status --porcelain
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect worktree: $targetPath" }
if (-not [string]::IsNullOrWhiteSpace(($status | Out-String).Trim())) { throw "Worktree is dirty: $targetPath" }
& git -C $projectRoot merge-base --is-ancestor $targetRecord[0].Head origin/main
$merged = $LASTEXITCODE -eq 0
$archived = [bool](& git -C $projectRoot branch --contains $targetRecord[0].Head --list "archive/*")
if (-not $merged -and -not $archived) { throw "Worktree HEAD is neither merged nor archived: $targetPath" }
$retirePlan = [pscustomobject]@{ action = "retire"; path = $targetPath; head = $targetRecord[0].Head; merged = $merged; archived = $archived; apply = [bool]$Apply }
$retirePlan | ConvertTo-Json -Depth 3
if (-not $Apply) { exit 0 }
& git -C $projectRoot worktree remove $targetPath
if ($LASTEXITCODE -ne 0) { throw "git worktree remove failed: $targetPath" }
& git -C $projectRoot worktree prune
if ($LASTEXITCODE -ne 0) { throw "git worktree prune failed." }
