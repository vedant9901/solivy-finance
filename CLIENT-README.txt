SOLIVY FINANCE - CLIENT INSTALLATION
====================================

LICENSE ACTIVATION
- Follow LICENSE-ACTIVATION-GUIDE-v2.5.27.md for owner key verification, token issuance, fresh client activation, additional company activation, renewal, and troubleshooting.
- Never share the owner private key or the client-config.json file. It contains secrets and the license token.

INSTALL
1. Extract the entire release ZIP to a normal folder (for example Downloads\SOLIVY-Finance).
2. Double-click CLIENT-INSTALL.bat.
3. If Node.js LTS is missing, the installer attempts to install it with Windows winget. Internet access may be required.
4. On first install, choose the database folder (or press Enter for the default). The installer checks that it can write to the folder.
5. Choose Y to start SOLIVY Finance or use the desktop shortcut later.

UPDATES
1. Close SOLIVY Finance before updating.
2. Extract the new version's release ZIP to a new folder.
3. Run CLIENT-INSTALL.bat from the new release.
4. The installer replaces application files but preserves data in %APPDATA%\SOLIVY-FINANCE\data and the client session secret.

DATA AND BACKUPS
- Default database folder: %APPDATA%\SOLIVY-FINANCE\data (unless another folder was selected during first setup)
- Configuration and logs: %APPDATA%\SOLIVY-FINANCE
- LIVE and TEST databases remain separate. Back up this data folder regularly and before updates.
- Do not delete the SOLIVY-FINANCE folder from AppData if you need to preserve client data.

IMPORTANT
- This is a local Windows application. Each client PC has its own local databases; it does not automatically synchronize data between PCs.
- On first run, create the first administrator at the application setup screen using the one-time setup key displayed by the installer. No shared default administrator password should be used.
- Local client activation reads the token saved in %APPDATA%\\SOLIVY-FINANCE\\client-config.json. After changing it, restart SOLIVY Finance and refresh License Management.
- The installer does not include your development project, Git metadata, .env files, license private key, or source folders. However, local Next.js server bundles contain JavaScript that a determined user may inspect; this is not complete code secrecy.
- Node.js installation may require internet access and Windows permissions.


BUILD STATUS
The source ZIP is not itself an installable client release. On a Windows developer PC with Node.js 20+ and npm registry access, run BUILD-CLIENT-RELEASE.bat; then distribute the generated ZIP from the releases folder. The release builder must finish the production build before it emits a client ZIP.
