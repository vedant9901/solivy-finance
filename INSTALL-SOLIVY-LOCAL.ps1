$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AppDir

Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '       SOLIVY FINANCE - LOCAL INSTALL' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''

# Check / install Node.js. SQLite is bundled through better-sqlite3; no separate SQLite install is required.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'Node.js was not found.' -ForegroundColor Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host 'Installing Node.js LTS with Windows Package Manager...' -ForegroundColor Yellow
        winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed.' }
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
        $node = Get-Command node -ErrorAction SilentlyContinue
    }
    if (-not $node) {
        throw 'Node.js is required. Install the current Node.js LTS release and run this installer again.'
    }
}

Write-Host ('Node.js: ' + (& node --version)) -ForegroundColor Green
Write-Host ''

$defaultData = Join-Path $env:APPDATA 'SOLIVY-FINANCE\data'
Write-Host 'Choose where SOLIVY financial databases will be stored.' -ForegroundColor Cyan
Write-Host 'Leave blank for:' $defaultData
Write-Host 'This folder is independent of the application folder.' -ForegroundColor DarkGray
$dataInput = Read-Host 'Database/data folder'
if ([string]::IsNullOrWhiteSpace($dataInput)) { $dataInput = $defaultData }
$dataInput = [Environment]::ExpandEnvironmentVariables($dataInput.Trim())
if (-not [System.IO.Path]::IsPathRooted($dataInput)) { $dataInput = Join-Path $AppDir $dataInput }
New-Item -ItemType Directory -Force -Path $dataInput | Out-Null

# Generate per-install secrets using the OS cryptographic RNG. Keep these out of Git and client release ZIPs.
$sessionBytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($sessionBytes)
$sessionSecret = [Convert]::ToBase64String($sessionBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
$setupBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($setupBytes)
$setupSecret = [Convert]::ToBase64String($setupBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
Write-Host ''
Write-Host 'Unique one-time administrator setup key (save this):' -ForegroundColor Yellow
Write-Host $setupSecret -ForegroundColor White
$licenseToken = Read-Host 'Paste the customer-specific SOLIVY license token (required)'
if ([string]::IsNullOrWhiteSpace($licenseToken)) { throw 'A license token is required. Ask SOLIVY Team to issue one.' }
# Keep user configuration in .env.local, never in source defaults.
$envPath = Join-Path $AppDir '.env.local'
@"
FINANCE_DATA_DIR="$dataInput"
NODE_ENV=production
SESSION_SECRET=$sessionSecret
SOLIVY_SETUP_SECRET=$setupSecret
SOLIVY_LICENSE_ENFORCEMENT=required
SOLIVY_LICENSE_TOKEN=$($licenseToken.Trim())
"@ | Set-Content -Path $envPath -Encoding UTF8

Write-Host ''
Write-Host 'Installing application dependencies...' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }

Write-Host 'Building SOLIVY Finance...' -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Next.js production build failed. See the output above.' }

$launcher = Join-Path $AppDir 'START-SOLIVY-LOCAL.bat'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'SOLIVY Finance.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcutPath)
$sc.TargetPath = $launcher
$sc.WorkingDirectory = $AppDir
$sc.Description = 'SOLIVY Finance - Local'
$iconPath = Join-Path $AppDir 'public\solivy.ico'
if (Test-Path $iconPath) { $sc.IconLocation = $iconPath }
$sc.Save()

Write-Host ''
Write-Host 'INSTALLATION COMPLETE' -ForegroundColor Green
Write-Host ('Database: ' + $dataInput) -ForegroundColor Green
Write-Host ('Desktop shortcut: ' + $shortcutPath) -ForegroundColor Green
Write-Host ''
Write-Host 'Default company: SOLIVY' -ForegroundColor Cyan
Write-Host 'First run: open /setup and enter the one-time setup key shown above.' -ForegroundColor Yellow
Write-Host 'Create a unique administrator account. No default password is shipped.' -ForegroundColor Yellow
Write-Host ''
$run = Read-Host 'Start SOLIVY Finance now? (Y/N)'
if ($run -match '^[Yy]$') { Start-Process -FilePath $launcher }
