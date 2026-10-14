$ErrorActionPreference = 'Stop'
# npm can emit non-fatal warnings on stderr; use exit codes to determine failure.
$PSNativeCommandUseErrorActionPreference = $false
Set-Location $PSScriptRoot
Write-Host 'SOLIVY Finance v2.5.27 release verification' -ForegroundColor Cyan
if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not installed.' }
if (!(Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is not installed.' }
Write-Host 'Installing exact dependencies from package.json (this project currently has no lockfile)...' -ForegroundColor Yellow
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
node scripts/check-source.cjs
if ($LASTEXITCODE -ne 0) { throw 'Source parse check failed.' }
node scripts/check-security.cjs
if ($LASTEXITCODE -ne 0) { throw 'Security static check failed.' }
node scripts/check-import-schema.mjs
if ($LASTEXITCODE -ne 0) { throw 'Import static check failed.' }
node scripts/license-tool.cjs self-test
if ($LASTEXITCODE -ne 0) { throw 'License self-test failed.' }
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Next.js production build failed.' }
Write-Host 'Static checks, TypeScript and production build passed. Run the manual regression checklist against a COPY of your database before live use.' -ForegroundColor Green
