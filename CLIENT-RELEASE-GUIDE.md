# SOLIVY Finance Client Release Guide

## Developer release process (Windows)
1. Keep this project/source ZIP private.
2. Open the project on your Windows development PC with Node.js 20+ installed.
3. Run `BUILD-CLIENT-RELEASE.bat`.
4. The script installs dependencies, runs source/security checks, builds Next.js standalone output, and creates `releases/SOLIVY-Finance-Client-v<version>.zip`.
5. Send **only the generated release ZIP** to the client. Never send the source project ZIP.

## Client installation
The client extracts the release ZIP and runs `CLIENT-INSTALL.bat`. It installs Node.js LTS via winget if missing, copies the standalone app to `%LOCALAPPDATA%\Programs\SOLIVY Finance`, creates shortcuts, and keeps database/configuration files in `%APPDATA%\SOLIVY-FINANCE`.

## Updates and data preservation
Use the same client install process for each new release. The installer replaces only application files and preserves `%APPDATA%\SOLIVY-FINANCE\data` and `client-config.json`. Back up the data folder before upgrades.

## Important technical notes
- Build the release on Windows. `better-sqlite3` is a native dependency; building on another OS and sending it to Windows may produce incompatible binaries.
- This package uses Next.js standalone output and excludes development source folders, `.env` files, and `.git`. Bundled JavaScript is still inspectable; a local app cannot guarantee complete secrecy of server-side code.
- The Vercel deployment remains separate; `output: 'standalone'` is intended for packaging and should be smoke-tested against your existing Vercel deployment before release.
- A successful script run is not a substitute for testing on a clean Windows PC. Verify login, create/read/update flows, company switching, LIVE/TEST isolation, backups, and upgrade data preservation before sending to clients.
