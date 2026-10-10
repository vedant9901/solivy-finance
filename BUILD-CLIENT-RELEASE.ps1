$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AppDir
$Package = Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$ReleaseName = "SOLIVY-Finance-Client-v$Version"
$ReleaseRoot = Join-Path $AppDir 'releases'
$Stage = Join-Path $ReleaseRoot $ReleaseName
$AppBundle = Join-Path $Stage 'app'
$ZipPath = Join-Path $ReleaseRoot "$ReleaseName.zip"

Write-Host ''
Write-Host 'SOLIVY FINANCE - CLIENT RELEASE BUILDER' -ForegroundColor Cyan
Write-Host "Version: $Version"
Write-Host 'This builds on your development PC. The release ZIP excludes source folders, Git data, .env files and development scripts.' -ForegroundColor DarkGray
Write-Host ''

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) { throw 'Node.js LTS (including npm) is required on the developer PC to build a release.' }
$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) { throw 'Use Node.js 20 or newer on the developer PC.' }

# Avoid accidentally bundling developer-specific environment secrets.
$forbidden = @('.env', '.env.local', '.env.production', '.env.production.local')
foreach ($name in $forbidden) {
  if (Test-Path (Join-Path $AppDir $name)) {
    Write-Host "Found developer environment file $name. It will not be packaged." -ForegroundColor Yellow
  }
}

Write-Host '[1/5] Installing locked dependencies...' -ForegroundColor Cyan
if (Test-Path (Join-Path $AppDir 'package-lock.json')) {
  npm ci
} else {
  npm install
}
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

Write-Host '[2/5] Running source and security checks...' -ForegroundColor Cyan
npm run check:source
if ($LASTEXITCODE -ne 0) { throw 'Source check failed.' }
npm run check:security
if ($LASTEXITCODE -ne 0) { throw 'Security check failed.' }

Write-Host '[3/5] Building standalone production app...' -ForegroundColor Cyan
$env:NODE_ENV = 'production'
$NextConfigPath = Join-Path $AppDir 'next.config.mjs'
$OriginalNextConfig = Get-Content $NextConfigPath -Raw
try {
  # Enable standalone output only for this local packaging build, then restore the exact project config.
  Set-Content -Path $NextConfigPath -Value @'
/** @type {import('next').NextConfig} */
const nextConfig = { poweredByHeader: false, output: 'standalone', productionBrowserSourceMaps: false };
export default nextConfig;
'@ -Encoding UTF8
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
} finally {
  Set-Content -Path $NextConfigPath -Value $OriginalNextConfig -Encoding UTF8
}
$Standalone = Join-Path $AppDir '.next\standalone'
if (-not (Test-Path (Join-Path $Standalone 'server.js'))) { throw 'Next.js standalone server.js was not generated. Check the build output.' }

Write-Host '[4/5] Staging client package...' -ForegroundColor Cyan
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $AppBundle | Out-Null
Copy-Item (Join-Path $Standalone '*') $AppBundle -Recurse -Force
$StaticTarget = Join-Path $AppBundle '.next\static'
New-Item -ItemType Directory -Force -Path $StaticTarget | Out-Null
Copy-Item (Join-Path $AppDir '.next\static\*') $StaticTarget -Recurse -Force
$PublicTarget = Join-Path $AppBundle 'public'
if (Test-Path $PublicTarget) { Remove-Item $PublicTarget -Recurse -Force }
Copy-Item (Join-Path $AppDir 'public') $PublicTarget -Recurse -Force

# Runtime installer/launcher are the only scripts shipped alongside the production bundle.
Copy-Item (Join-Path $AppDir 'CLIENT-INSTALL.bat') $Stage
Copy-Item (Join-Path $AppDir 'CLIENT-INSTALL.ps1') $Stage
Copy-Item (Join-Path $AppDir 'CLIENT-START.ps1') $Stage
Copy-Item (Join-Path $AppDir 'CLIENT-STOP.bat') $Stage
Copy-Item (Join-Path $AppDir 'CLIENT-README.txt') $Stage
# Owner/developer licensing instructions must not be included in the client package.

# Never package environment files, source trees, node_modules from the developer checkout, or Git metadata.
Get-ChildItem $Stage -Force -Recurse -File | Where-Object {
  $_.Name -in @('.env', '.env.local', '.env.production', '.env.production.local') -or $_.FullName -match '[\\/]\.git[\\/]'
} | Remove-Item -Force

Write-Host '[5/5] Creating shareable release ZIP...' -ForegroundColor Cyan
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $ZipPath -CompressionLevel Optimal
$sizeMB = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
Write-Host ''
Write-Host 'CLIENT RELEASE READY' -ForegroundColor Green
Write-Host "ZIP: $ZipPath" -ForegroundColor Green
Write-Host "Size: $sizeMB MB"
Write-Host 'Send this release ZIP to the client. Do not send the source project ZIP.' -ForegroundColor Yellow
Write-Host 'Reminder: bundled server-side JavaScript is not cryptographically secret; this package reduces source exposure but cannot guarantee complete code secrecy.' -ForegroundColor Yellow
