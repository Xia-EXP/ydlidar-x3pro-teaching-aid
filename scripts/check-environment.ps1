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

# Edge provides the browser's Web Serial permission dialog.
$edgeCandidates = @((Get-Command msedge.exe -ErrorAction SilentlyContinue).Source)
foreach ($basePath in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LocalAppData)) {
    if ($basePath) { $edgeCandidates += Join-Path $basePath "Microsoft\Edge\Application\msedge.exe" }
}
$edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($edgePath) { Write-Host "[OK] Microsoft Edge ($edgePath)" -ForegroundColor Green }
else { Write-Host "[MISSING] Microsoft Edge" -ForegroundColor Yellow }

# Read Windows' current COM mappings, including USB virtual ports omitted by some WMI providers.
try {
    $ports = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique) # Capture only COM ports currently exposed by Windows.
    $presentDevices = @(Get-PnpDevice -PresentOnly -Class Ports -ErrorAction SilentlyContinue) # Enrich COM numbers with device names and IDs when available.
    $usbPorts = @($presentDevices | Where-Object { $_.InstanceId -match '^(USB|FTDIBUS)\\' -and $_.Status -eq 'OK' -and $_.FriendlyName -match '\((COM\d+)\)' -and $ports -contains $Matches[1] }) # Require a live USB device and an actual COM mapping.
    if ($ports.Count) { Write-Host "[INFO] Windows serial ports: $($ports -join ', ')" } # Show the actual numbers used in the browser picker.
    if ($usbPorts.Count) {
        foreach ($device in $usbPorts) { Write-Host "[INFO] USB serial candidate: $($device.FriendlyName)" } # Label devices as candidates because chipset identity cannot prove this is the lidar.
    } else {
        Write-Host "[CHECK] No USB serial candidate confirmed. Connect the lidar and check Device Manager for its USB serial adapter." -ForegroundColor Yellow # Keep demo mode available while hardware is unplugged.
    }
} catch {
    Write-Host "[CHECK] Windows serial inventory unavailable. Check Device Manager for the adapter COM number." -ForegroundColor Yellow # Hardware inventory failure must not stop the application.
}

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
