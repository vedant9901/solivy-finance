$ErrorActionPreference = 'Stop'
$ReleaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\SOLIVY Finance'
$ConfigRoot = Join-Path $env:APPDATA 'SOLIVY-FINANCE'
$DefaultDataRoot = Join-Path $ConfigRoot 'data'
$DataRoot = $DefaultDataRoot
$ConfigFile = Join-Path $ConfigRoot 'client-config.json'
$Port = 3210

Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '       SOLIVY FINANCE - CLIENT INSTALL' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host 'Setup asks where to store databases on first install. Updates preserve that saved location.' -ForegroundColor DarkGray
Write-Host ''

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'Node.js is missing and winget is unavailable. Install Node.js LTS, then run this installer again.' }
  Write-Host 'Installing Node.js LTS. Internet access and Windows permission may be required...' -ForegroundColor Yellow
  winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed. Install Node.js LTS manually and rerun this installer.' }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js was installed but is not available in this terminal yet. Restart Windows or sign out/in, then rerun the installer.' }
}

$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) { throw 'SOLIVY Finance requires Node.js 20 or newer. Install the current Node.js LTS release.' }

New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
if (-not (Test-Path (Join-Path $ReleaseDir 'app\server.js'))) { throw 'Production app bundle is missing. This is not a compiled client-release ZIP. On the developer PC, run BUILD-CLIENT-RELEASE.bat and install the ZIP created under releases.' }

# Ask for the database directory on first setup. On upgrades, keep the saved path
# exactly as-is so existing LIVE/TEST databases are not silently moved or replaced.
$existingConfig = $null
$usingSavedDataRoot = $false
if (Test-Path $ConfigFile) {
  try { $existingConfig = Get-Content $ConfigFile -Raw | ConvertFrom-Json } catch { throw "Client configuration is unreadable. No data was changed. Config: $ConfigFile" }
  if (-not [string]::IsNullOrWhiteSpace([string]$existingConfig.dataDir)) {
    $DataRoot = [Environment]::ExpandEnvironmentVariables(([string]$existingConfig.dataDir).Trim())
    $usingSavedDataRoot = $true
  } else {
    Write-Host 'No database location is saved in the existing configuration.' -ForegroundColor Yellow
  }
}
if (-not $existingConfig -or [string]::IsNullOrWhiteSpace([string]$existingConfig.dataDir)) {
  Write-Host ''
  Write-Host 'DATABASE LOCATION SETUP' -ForegroundColor Cyan
  Write-Host 'Choose a folder for SOLIVY databases (admin.db, LIVE and TEST files).' -ForegroundColor White
  Write-Host 'Use a local drive folder with read/write permission. Do not choose the app installation folder or a cloud-synced folder.' -ForegroundColor DarkGray
  Write-Host ('Default: ' + $DefaultDataRoot) -ForegroundColor DarkGray
  $dataInput = Read-Host 'Database folder (press Enter for default)'
  if ([string]::IsNullOrWhiteSpace($dataInput)) { $dataInput = $DefaultDataRoot }
  $dataInput = [Environment]::ExpandEnvironmentVariables($dataInput.Trim().Trim('"'))
  if (-not [System.IO.Path]::IsPathRooted($dataInput)) { throw 'Database folder must be an absolute path, for example D:\SOLIVY-DATA.' }
  $DataRoot = [System.IO.Path]::GetFullPath($dataInput)
}
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot)
$installFull = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
if ($DataRoot.StartsWith($installFull, [System.StringComparison]::OrdinalIgnoreCase) -or $DataRoot.Equals([System.IO.Path]::GetFullPath($InstallRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Database folder cannot be inside the replaceable application installation folder. Choose a separate folder such as D:\SOLIVY-DATA.'
}
if ($usingSavedDataRoot -and -not (Test-Path -LiteralPath $DataRoot -PathType Container)) { throw "The previously configured database folder is unavailable: $DataRoot. Reconnect the drive or restore that folder before upgrading. The installer will not create an empty replacement folder." }
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
# Confirm the selected folder is writable before saving it to configuration.
$probe = Join-Path $DataRoot ('.solivy-setup-test-' + [guid]::NewGuid().ToString('N') + '.tmp')
try { [System.IO.File]::WriteAllText($probe, 'ok'); Remove-Item $probe -Force } catch { throw "Cannot write to the selected database folder '$DataRoot'. Choose another folder. Details: $($_.Exception.Message)" }
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

# Keep database and per-install session secret outside the replaceable app directory.
if (-not (Test-Path $ConfigFile)) {
  $secretBytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
  $secret = [Convert]::ToBase64String($secretBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  $setupBytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($setupBytes)
  $setupSecret = [Convert]::ToBase64String($setupBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  Write-Host ''
  Write-Host 'Unique one-time administrator setup key (save this):' -ForegroundColor Yellow
  Write-Host $setupSecret -ForegroundColor White
  $licenseToken = Read-Host 'Paste the customer-specific SOLIVY license token (required)'
  if ([string]::IsNullOrWhiteSpace($licenseToken)) { throw 'A license token is required. Ask SOLIVY Team to issue one.' }
  @{ sessionSecret = $secret; setupSecret = $setupSecret; licenseToken = $licenseToken.Trim(); licenseEnforcement = 'required'; dataDir = $DataRoot; port = $Port; version = '2.5.28' } | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
} else {
  $existing = Get-Content $ConfigFile -Raw | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$existing.sessionSecret)) {
    $secretBytes = New-Object byte[] 48; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
    $existing | Add-Member -NotePropertyName sessionSecret -NotePropertyValue ([Convert]::ToBase64String($secretBytes).TrimEnd('=').Replace('+','-').Replace('/','_')) -Force
  }
  if ([string]::IsNullOrWhiteSpace([string]$existing.setupSecret)) {
    $setupBytes = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($setupBytes)
    $existing | Add-Member -NotePropertyName setupSecret -NotePropertyValue ([Convert]::ToBase64String($setupBytes).TrimEnd('=').Replace('+','-').Replace('/','_')) -Force
    Write-Host ('One-time setup key (only needed if this installation has no active administrator): ' + $existing.setupSecret) -ForegroundColor Yellow
  }
  if ([string]::IsNullOrWhiteSpace([string]$existing.licenseToken)) {
    $licenseToken = Read-Host 'Paste the customer-specific SOLIVY license token (required)'
    if ([string]::IsNullOrWhiteSpace($licenseToken)) { throw 'A license token is required. Ask SOLIVY Team to issue one.' }
    $existing | Add-Member -NotePropertyName licenseToken -NotePropertyValue $licenseToken.Trim() -Force
  }
  $existing | Add-Member -NotePropertyName licenseEnforcement -NotePropertyValue 'required' -Force
  # Persist the selected/existing database location. Never reset this to a default during upgrades.
  $existing | Add-Member -NotePropertyName dataDir -NotePropertyValue $DataRoot -Force
  $existing | Add-Member -NotePropertyName port -NotePropertyValue $Port -Force
  $existing | Add-Member -NotePropertyName version -NotePropertyValue '2.5.28' -Force
  $existing | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
}

# Stop any running instance before replacing application files. Preserve the database/config folders.
$pidFile = Join-Path $ConfigRoot 'server.pid'
if (Test-Path $pidFile) {
  $oldPid = 0
  [void][int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$oldPid)
  if ($oldPid -gt 0 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
if (Test-Path $InstallRoot) { Get-ChildItem $InstallRoot -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force }
Copy-Item (Join-Path $ReleaseDir 'app\*') $InstallRoot -Recurse -Force

# Create shortcuts that point to the stable launcher; config/data remain in AppData.
$launcher = Join-Path $InstallRoot 'CLIENT-START.ps1'
Copy-Item (Join-Path $ReleaseDir 'CLIENT-START.ps1') $launcher -Force
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in @((Join-Path $desktop 'SOLIVY Finance.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'SOLIVY Finance.lnk'))) {
  $parent = Split-Path -Parent $shortcutPath
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $sc = $ws.CreateShortcut($shortcutPath)
  $sc.TargetPath = 'powershell.exe'
  $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"'
  $sc.WorkingDirectory = $InstallRoot
  $sc.Description = 'SOLIVY Finance - Local Client'
  $icon = Join-Path $InstallRoot 'public\solivy.ico'
  if (Test-Path $icon) { $sc.IconLocation = $icon }
  $sc.Save()
}

Write-Host ''
Write-Host 'INSTALLATION COMPLETE' -ForegroundColor Green
Write-Host "Application: $InstallRoot"
Write-Host "Persistent database folder: $DataRoot"
Write-Host 'LIVE and TEST databases remain separate.' -ForegroundColor Green
Write-Host ''
Write-Host 'First-install note: review and change the default administrator credentials immediately. Never reuse a shared admin password across clients.' -ForegroundColor Yellow
$run = Read-Host 'Start SOLIVY Finance now? (Y/N)'
if ($run -match '^[Yy]$') { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $launcher + '"')) }
