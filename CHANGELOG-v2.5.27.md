# SOLIVY Finance v2.5.27 — Setup database location

Based on v2.5.26 Tally / bank / access / backup candidate.

## Setup changes
- First client installation prompts for the folder where SOLIVY SQLite databases will live.
- Blank input uses `%APPDATA%\SOLIVY-FINANCE\data`.
- The installer creates the chosen folder and tests write permission before saving it.
- Database folder must be an absolute path and cannot be inside the replaceable application installation directory.
- On upgrade, the installer reuses the saved `dataDir` and does not silently reset it or move databases.
- Existing `admin.db`, LIVE and TEST databases are not copied, deleted, or reset by the setup-location feature.
- Installer now rejects a source ZIP that is not a compiled standalone client release, with a clearer message.

## Build status
This package contains source and the Windows release builder, not a precompiled client release. The production build was not verified in this environment because dependency installation timed out. Use `BUILD-CLIENT-RELEASE.bat` on a Windows developer PC with npm registry access. Distribute only the ZIP generated under `releases` after the script completes successfully.
