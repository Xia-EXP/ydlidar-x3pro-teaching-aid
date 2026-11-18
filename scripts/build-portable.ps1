param([string]$NodeVersion = "v24.19.0")

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$releaseRoot = Join-Path $projectRoot "release"
$archiveName = "YDLIDAR-X3PRO-portable-v$($package.version)-win-x64.zip"
$archivePath = Join-Path $releaseRoot $archiveName
$stagingRoot = Join-Path $releaseRoot ("portable-stage-" + [guid]::NewGuid().ToString("N"))
$downloadRoot = Join-Path $releaseRoot ("node-download-" + [guid]::NewGuid().ToString("N"))

# Use .NET hashing so verification works even when PowerShell utility modules are unavailable.
function Get-Sha256Hex {
    param([string]$FilePath)
    $stream = [System.IO.File]::OpenRead($FilePath)
    try {
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        try { return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "") }
        finally { $hasher.Dispose() }
    } finally { $stream.Dispose() }
}

# Fail before downloading when a release artifact already exists; never overwrite user data.
if (Test-Path -LiteralPath $archivePath) { throw "Release archive already exists: $archivePath" }
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stagingRoot | Out-Null
New-Item -ItemType Directory -Path $downloadRoot | Out-Null

try {
    # Download the official Windows x64 distribution and checksum manifest over HTTPS.
    $nodeArchiveName = "node-$NodeVersion-win-x64.zip"
    $baseUrl = "https://nodejs.org/dist/$NodeVersion"
    $nodeArchivePath = Join-Path $downloadRoot $nodeArchiveName
    $checksumsPath = Join-Path $downloadRoot "SHASUMS256.txt"
    # curl uses bounded retries/timeouts; PowerShell 5.1 WebRequest can hang before writing bytes.
    & curl.exe --fail --location --retry 2 --connect-timeout 15 --max-time 180 --output $nodeArchivePath "$baseUrl/$nodeArchiveName"
    if ($LASTEXITCODE -ne 0) { throw "Node.js archive download failed." }
    & curl.exe --fail --location --retry 2 --connect-timeout 15 --max-time 30 --output $checksumsPath "$baseUrl/SHASUMS256.txt"
    if ($LASTEXITCODE -ne 0) { throw "Node.js checksum download failed." }
    $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+$([regex]::Escape($nodeArchiveName))$" } | Select-Object -First 1
    if (-not $checksumLine) { throw "Official checksum entry not found for $nodeArchiveName" }
    $expectedHash = ($checksumLine -split '\s+')[0].ToUpperInvariant()
    $actualHash = Get-Sha256Hex $nodeArchivePath
    if ($actualHash -ne $expectedHash) { throw "Node.js SHA-256 mismatch; archive rejected." }

    # Extract only node.exe; the browser app has no npm runtime dependencies.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($nodeArchivePath)
    try {
        $nodeEntry = $zip.Entries | Where-Object { $_.FullName -eq "node-$NodeVersion-win-x64/node.exe" } | Select-Object -First 1
        if (-not $nodeEntry) { throw "node.exe not found in official archive." }
        $runtimePath = Join-Path $stagingRoot "runtime"
        New-Item -ItemType Directory -Path $runtimePath | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($nodeEntry, (Join-Path $runtimePath "node.exe"))
        # 随运行时分发 Node 官方许可证及包含的第三方声明。
        $licenseEntry = $zip.Entries | Where-Object { $_.FullName -eq "node-$NodeVersion-win-x64/LICENSE" } | Select-Object -First 1
        if (-not $licenseEntry) { throw "Node.js LICENSE not found in official archive." } # 声明缺失时不生成发布包。
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($licenseEntry, (Join-Path $runtimePath "LICENSE.txt")) # 保留官方声明原文。
    } finally {
        $zip.Dispose()
    }

    # Copy an explicit allowlist so local documents, logs and device data cannot leak into the release.
    # 将中文入口、普通用户说明和版本记录列入明确的发布白名单。
    foreach ($file in @("server.mjs", "start.ps1", "README.md", "MODULES.md", "package.json", "one-click-start.cmd", "一键启动.cmd", "使用说明.txt", "RELEASE-NOTES.md")) {
        $source = Join-Path $projectRoot $file
        if (-not (Test-Path -LiteralPath $source)) { throw "Required release file missing: $file" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $stagingRoot $file)
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot "public") -Destination (Join-Path $stagingRoot "public") -Recurse
    # 同时包含维护脚本和自动化测试，使便携包中的源码与 package.json 命令一致。
    foreach ($directory in @("scripts", "test")) { Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination (Join-Path $stagingRoot $directory) -Recurse } # 仅复制已审阅的源码目录。

    # Record the exact verified Node version and archive checksum for downstream auditing.
    $runtimeManifest = "Node.js $NodeVersion (win-x64)`r`nOfficial archive SHA-256: $actualHash`r`nSource: $baseUrl/$nodeArchiveName`r`n"
    [System.IO.File]::WriteAllText((Join-Path $stagingRoot "runtime\SOURCE.txt"), $runtimeManifest, [System.Text.Encoding]::ASCII)
    # 对压缩前的每个实际交付文件计算 SHA-256，便于解压后逐文件复核。
    $fileHashes = Get-ChildItem -LiteralPath $stagingRoot -Recurse -File | Sort-Object FullName | ForEach-Object { "$(Get-Sha256Hex $_.FullName)  $($_.FullName.Substring($stagingRoot.Length + 1).Replace('\', '/'))" }
    [System.IO.File]::WriteAllLines((Join-Path $stagingRoot "FILES.sha256"), $fileHashes, [System.Text.UTF8Encoding]::new($false)) # 清单使用 UTF-8，支持中文文件名。
    Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $archivePath -CompressionLevel Optimal
    $releaseHash = Get-Sha256Hex $archivePath
    [System.IO.File]::WriteAllText("$archivePath.sha256", "$releaseHash  $archiveName`r`n", [System.Text.Encoding]::ASCII)
    Write-Host "Portable release created: $archivePath" -ForegroundColor Green
    Write-Host "SHA-256: $releaseHash" -ForegroundColor Green
} finally {
    # These GUID-named directories were created by this invocation only.
    # 清理前验证绝对目录边界，仅删除本次创建的两个 GUID 临时目录。
    $releaseBoundary = [System.IO.Path]::GetFullPath($releaseRoot).TrimEnd('\') + '\'
    foreach ($temporaryPath in @($stagingRoot, $downloadRoot)) { # 不枚举或清理历史发布文件。
        $resolvedTemporaryPath = [System.IO.Path]::GetFullPath($temporaryPath) # 获取待删除目录的绝对路径。
        if (-not $resolvedTemporaryPath.StartsWith($releaseBoundary, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe temporary cleanup path." } # 阻止越界删除。
        if (Test-Path -LiteralPath $resolvedTemporaryPath) { Remove-Item -LiteralPath $resolvedTemporaryPath -Recurse -Force } # 使用原生 LiteralPath 删除明确目标。
    } # 本次临时文件清理结束。
}
