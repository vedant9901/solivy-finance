# SOLIVY Finance v2.5.28 — License guidance, backup polling and safe promotion

Based on the v2.5.27 database-location source/build package.

## Changes
- Local client launcher explicitly clears inherited `SOLIVY_LICENSES_JSON` so the signed token in `%APPDATA%\SOLIVY-FINANCE\client-config.json` is used.
- License Management now includes step-by-step Windows client activation and renewal guidance, alongside developer and Vercel configuration notes.
- Secondary-backup status polling is consolidated to one five-minute poll; opening the Secondary Backup page no longer creates a second 60-second poll.
- Secondary-backup retry interval after a failed scheduled attempt is reduced from ten to five minutes while SOLIVY is running.
- Login lockout after repeated failures is reduced to two minutes (five failed attempts within a ten-minute window), balancing recovery with brute-force protection.
- TEST → LIVE (SAFE) now requires selecting a company explicitly and reports the selected company. The API accepts the selected company ID from the request body and continues to refuse promotion if that company’s LIVE database contains financial data.

## Safety notes
- No database files are migrated, deleted or reset by these changes.
- TEST → LIVE is per company and only allowed when that company’s LIVE tables are empty. Back up first and test against copied databases.
- Secondary backup status checks still run every five minutes because the current local scheduled-backup design uses those checks to trigger a due backup.
- This package is source plus build tools, not a precompiled client installer. Build and verify the release on Windows before distribution.
