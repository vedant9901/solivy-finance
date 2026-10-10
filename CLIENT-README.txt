SOLIVY FINANCE - CLIENT INSTALLATION
====================================

INSTALL
1. Extract the entire release ZIP to a normal folder (for example Downloads\SOLIVY-Finance).
2. Double-click CLIENT-INSTALL.bat.
3. If Node.js LTS is missing, the installer attempts to install it with Windows winget. Internet access may be required.
4. Choose Y to start SOLIVY Finance or use the desktop shortcut later.

UPDATES
1. Close SOLIVY Finance before updating.
2. Extract the new version's release ZIP to a new folder.
3. Run CLIENT-INSTALL.bat from the new release.
4. The installer replaces application files but preserves data in %APPDATA%\SOLIVY-FINANCE\data and the client session secret.

DATA AND BACKUPS
- Persistent data folder: %APPDATA%\SOLIVY-FINANCE\data
- Configuration and logs: %APPDATA%\SOLIVY-FINANCE
- LIVE and TEST databases remain separate. Back up this data folder regularly and before updates.
- Do not delete the SOLIVY-FINANCE folder from AppData if you need to preserve client data.

IMPORTANT
- This is a local Windows application. Each client PC has its own local databases; it does not automatically synchronize data between PCs.
- The first-install administrator credentials follow the application's existing initialization logic. Change default credentials immediately and never reuse shared credentials between clients.
- The installer does not include your development project, Git metadata, .env files, license private key, or source folders. However, local Next.js server bundles contain JavaScript that a determined user may inspect; this is not complete code secrecy.
- Node.js installation may require internet access and Windows permissions.
