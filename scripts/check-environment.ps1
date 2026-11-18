param([switch]$Repair)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$portableNode = Join-Path $projectRoot "runtime\node.exe"
$nodePath = $null

# Prefer the verified runtime shipped in the portable release, without changing system PATH.
if (Test-Path -LiteralPath $portableNode) {
    $nodePath = $portableNode
} else {
    $installedNode = Get-Command node -ErrorAction SilentlyContinue
    if ($installedNode) { $nodePath = $installedNode.Source }
}

$nodeVersion = $null
if ($nodePath) {
    try { $nodeVersion = [version]((& $nodePath --version).Trim().TrimStart("v")) } catch { }
}
if ($nodeVersion -and $nodeVersion.Major -ge 20) {
    Write-Host "[OK] Node.js $nodeVersion ($nodePath)" -ForegroundColor Green
} else {
    $nodePath = $null
    Write-Host "[MISSING] Node.js 20+" -ForegroundColor Yellow
}

# Edge is required for Web Serial; the USB adapter driver cannot be identified by this app.
$edgeCandidates = @((Get-Command msedge.exe -ErrorAction SilentlyContinue).Source)
foreach ($basePath in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LocalAppData)) {
    if ($basePath) { $edgeCandidates += Join-Path $basePath "Microsoft\Edge\Application\msedge.exe" }
}
$edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($edgePath) { Write-Host "[OK] Microsoft Edge ($edgePath)" -ForegroundColor Green }
else { Write-Host "[MISSING] Microsoft Edge" -ForegroundColor Yellow }

$wingetCommand = Get-Command winget -ErrorAction SilentlyContinue
if ($nodePath -and $edgePath) {
    Write-Host "Environment check passed." -ForegroundColor Green
    exit 0
}

# Repair is opt-in: winget installs official packages and may require Windows consent.
if ($Repair -and $wingetCommand) {
    if (-not $nodePath) {
        & winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (-not $edgePath) {
        & winget install --id Microsoft.Edge --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    Write-Host "Installation completed. Restart this launcher to refresh system paths." -ForegroundColor Cyan
    exit 2
}

if (-not $wingetCommand) { Write-Host "winget is unavailable on this PC." -ForegroundColor Yellow }
Write-Host "Download the portable release with bundled Node.js, or install missing software:" -ForegroundColor Yellow
Write-Host "Node.js: https://nodejs.org/en/download" -ForegroundColor White
Write-Host "Edge: https://www.microsoft.com/edge" -ForegroundColor White
exit 1
