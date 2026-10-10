$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigRoot = Join-Path $env:APPDATA 'SOLIVY-FINANCE'
$ConfigFile = Join-Path $ConfigRoot 'client-config.json'
if (-not (Test-Path $ConfigFile)) { throw 'SOLIVY client configuration not found. Run CLIENT-INSTALL.bat first.' }
$config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
$env:NODE_ENV = 'production'
$env:SESSION_SECRET = [string]$config.sessionSecret
$env:SOLIVY_SETUP_SECRET = [string]$config.setupSecret
$env:SOLIVY_LICENSE_TOKEN = [string]$config.licenseToken
$env:SOLIVY_LICENSE_ENFORCEMENT = [string]$config.licenseEnforcement
$env:FINANCE_DATA_DIR = [string]$config.dataDir
$env:PORT = [string]$config.port
$env:HOSTNAME = '127.0.0.1'
$env:NEXT_TELEMETRY_DISABLED = '1'
$pidFile = Join-Path $ConfigRoot 'server.pid'
$logFile = Join-Path $ConfigRoot 'server.log'

$running = $false
if (Test-Path $pidFile) {
  $oldPid = 0
  [void][int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$oldPid)
  if ($oldPid -gt 0) {
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($proc) { $running = $true }
  }
}
if (-not $running) {
  $node = (Get-Command node -ErrorAction Stop).Source
  $proc = Start-Process -FilePath $node -ArgumentList @('server.js') -WorkingDirectory $AppDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError (Join-Path $ConfigRoot 'server-error.log')
  Set-Content -Path $pidFile -Value $proc.Id -Encoding ASCII
  Start-Sleep -Seconds 3
}
Start-Process ("http://127.0.0.1:{0}" -f [int]$config.port)
