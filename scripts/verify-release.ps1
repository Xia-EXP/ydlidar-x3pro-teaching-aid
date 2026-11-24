$ErrorActionPreference = "Stop"

# Run project checks before publishing so missing files or regressions are caught locally.
Write-Host "Running Node.js syntax checks..." -ForegroundColor Cyan
npm run check
if ($LASTEXITCODE -ne 0) { throw "Syntax checks failed." } # 原生命令失败必须阻止继续发布。

Write-Host "Running automated tests..." -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { throw "Automated tests failed." } # PowerShell 的 Stop 不会自动捕获 npm 退出码。

# Start a temporary service and stop only the process created by this script.
$port = 5199
$package = Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json
$server = Start-Process -FilePath "node" -ArgumentList @("server.mjs", "--port", "$port") -WorkingDirectory (Get-Location) -PassThru -WindowStyle Hidden
try {
    $healthUrl = "http://127.0.0.1:$port/health"
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 100
        try {
            $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1
            if ($health.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) { throw "Temporary service did not start." }
    $runningPackage = $health.Content | ConvertFrom-Json
    if ($runningPackage.version -ne $package.version) { throw "Running version does not match package.json." }
    # 同时检查控制台样式和展示模块，避免发布包遗漏新界面依赖而导致初始化失败。
    $resourcePaths = @("/", "/health", "/styles.css", "/console.css", "/js/console-layout.js", "/js/app.js", "/js/protocol.js", "/js/render.js", "/js/device-profile.js", "/js/video-lesson.js", "/js/g1-sim.js", "/vendor/three/three.module.js", "/vendor/three/three.core.js", "/vendor/three/addons/loaders/STLLoader.js", "/vendor/three/addons/controls/OrbitControls.js", "/models/g1/g1_29dof.urdf", "/models/g1/meshes/pelvis.STL")
    foreach ($resourcePath in $resourcePaths) {
        # Every release-critical resource must be reachable from the static server.
        $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:$port" + $resourcePath)
        if ($response.StatusCode -ne 200) { throw "Resource check failed: $resourcePath" }
    }
    # 案例视频必须存在且支持分段请求，否则浏览器无法拖动进度条；PowerShell 5.1 不允许直接设置 Range 头，改用 curl。
    foreach ($videoPath in @("/media/g1-avoidance.mp4", "/media/g1-slalom.mp4", "/media/gap-following.mp4", "/media/tf-frames.mp4")) {
        $status = & curl.exe --silent --output NUL --write-out "%{http_code}" --range 0-99 ("http://127.0.0.1:$port" + $videoPath)
        if ($status -ne "206") { throw "Video range check failed: $videoPath ($status)" }
    }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host "Release checks passed." -ForegroundColor Green
