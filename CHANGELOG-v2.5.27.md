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


## Client licensing and runtime noise hardening (source package update)

- Added `LICENSE-ACTIVATION-GUIDE-v2.5.27.md` covering key verification, license issuance, first client activation, new company activation, renewal, and online configuration caveats.
- Local launcher now clears inherited `SOLIVY_LICENSES_JSON` so a machine-level online token map cannot override the saved local `licenseToken`.
- Login lockout after five failed attempts reduced from 15 minutes to 2 minutes; rate limiting remains enabled.
- Secondary backup status polling reduced from once per minute to once every five minutes to reduce repetitive `GET /api/secondary-backup 200` logs. Scheduled backups may run up to about five minutes after their configured time while the admin app is open.
- Failed scheduled secondary backups can be retried after two minutes, subject to the app's polling interval.
