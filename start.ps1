# Repair 显式请求环境修复；NoBrowser 供便携包自动验收时使用，正常双击仍打开 Edge。
param([switch]$Repair, [switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentScript = Join-Path $projectRoot "scripts\check-environment.ps1"

# Run the ASCII-only environment checker so Windows PowerShell 5.1 parses it reliably.
$checkerArguments = @()
if ($Repair) { $checkerArguments += "-Repair" }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $environmentScript @checkerArguments
if ($LASTEXITCODE -eq 2) { exit 0 }
if ($LASTEXITCODE -ne 0) {
    $answer = Read-Host "Environment is not ready. Try winget repair now? (Y/N)"
    if ($answer -notmatch "^(Y|y)$") { exit 1 }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $environmentScript -Repair
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$portableNode = Join-Path $projectRoot "runtime\node.exe"
$nodePath = if (Test-Path -LiteralPath $portableNode) { $portableNode } else { (Get-Command node -ErrorAction Stop).Source }

# Pick an unused localhost port so another application on 5173 is never mistaken for this tool.
$port = $null
foreach ($candidate in 5173..5193) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
    try {
        $listener.Start()
        $port = $candidate
        break
    } catch [System.Net.Sockets.SocketException] {
    } finally {
        $listener.Stop()
    }
}
if (-not $port) { throw "No free localhost port found between 5173 and 5193." }
$healthUrl = "http://127.0.0.1:$port/health"

# Start one local server and keep its process id for clean shutdown.
$serverProcess = $null
try {
    # PowerShell 会把 ArgumentList 拼为字符串，因此必须给含空格或中文目录中的脚本路径保留引号。
    $serverArguments = @(('"{0}"' -f (Join-Path $projectRoot "server.mjs")), "--port", "$port")
    # 只启动并记录本次便携包的服务进程，避免影响其他控制台实例。
    $serverProcess = Start-Process -FilePath $nodePath -ArgumentList $serverArguments -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 100
        try {
            $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1
            if ($health.StatusCode -eq 200 -and $health.Content -match 'ydlidar-x3pro-teaching-aid') { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) {
        throw "Local server did not start."
    }

# Locate Edge in common Windows installation directories and open the localhost page.
$edgeCandidates = @((Get-Command msedge.exe -ErrorAction SilentlyContinue).Source)
foreach ($basePath in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LocalAppData)) {
    if ($basePath) { $edgeCandidates += Join-Path $basePath "Microsoft\Edge\Application\msedge.exe" }
}
$edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
$pageUrl = "http://127.0.0.1:$port/"
# 自动验收可跳过打开浏览器，其他启动步骤与普通用户完全一致。
if (-not $NoBrowser) {
    if ($edgePath) { Start-Process -FilePath $edgePath -ArgumentList $pageUrl | Out-Null } # 有 Edge 时优先使用支持串口的浏览器。
    else { Start-Process $pageUrl | Out-Null } # 环境发生变化时仍提供本地页面入口。
} # 浏览器启动选择结束。

Write-Host "YDLIDAR teaching tool opened: $pageUrl"
Write-Host "Press Enter to stop the server started by this script."
[void](Read-Host)
} finally {
    # Never stop a process that existed before this launcher started.
    if ($serverProcess -and -not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue }
}
